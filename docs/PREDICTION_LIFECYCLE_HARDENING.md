# Prediction Lifecycle Hardening — P0

2026-08-28. Correctness hardening only: no model changes, no new features, no
promotions. `heuristic_v1`, winner selection, BET/NO BET thresholds, Kelly
sizing, Telegram behavior, snapshots, and shadow isolation are unchanged.

## Bugs found, root cause, fix

### 1. CI dependency installation failure

**Root cause.** A user-level `~/.npmrc` pointed at
`http://mirrors.tencentyun.com/npm`, so both `package-lock.json` files carried
`resolved` URLs on that mirror (46 root, 30 dashboard). `npm ci` on GitHub
Actions installs from the lockfile's resolved URLs; the mirror is unreachable
from CI (and plain-HTTP), so installation failed. Secondary: `actions/*@v4/v5`
run on a deprecated Actions Node runtime, producing runtime warnings.

**Fix.**
- Added a project `.npmrc` pinning `registry=https://registry.npmjs.org/` so a
  developer-machine mirror can never leak into the lockfiles again.
- Regenerated both lockfiles in a clean environment; every `resolved` URL is
  now `https://registry.npmjs.org` (root 46/46, dashboard 225/225 with
  integrity hashes). Verified `npm ci` from scratch directories for both.
- Dependency versions moved within their declared semver ranges during
  regeneration (root: 7 packages, e.g. fast-xml-parser 5.10.1→5.11.1;
  dashboard: 76 packages, mostly @babel patch bumps). No package.json ranges
  changed.
- CI workflow bumped to `actions/checkout@v6`, `actions/setup-node@v6`,
  `actions/setup-python@v6` (current majors; clears the Node-runtime
  deprecation warnings). Node 20 / Python 3.12 targets unchanged.

### 2. Metric row misalignment (`src/eval/metrics.py`)

**Root cause.** `_to_arrays` filtered `probs` and `outcomes` for `None`
*independently*, then truncated to the shorter length. One `None` in either
list shifted every later value against the other list, silently pairing
probabilities with the wrong outcomes for Brier, log loss, accuracy, ROC AUC,
ECE, and reliability bins (all funnel through `_to_arrays`).

**Fix.** Rows are zipped FIRST, then pairs with a missing side are dropped —
`(p, y)` pairing is preserved by construction. Length mismatch now raises
`ValueError` (a caller bug must fail loudly, never silently truncate). All
callers audited: every production call site passes same-length pre-paired
lists, so behavior only changes where the old code was wrong.

### 3. Eligibility leakage into the clean dataset (`src/dataset/build_game_dataset.py`)

**Root cause.** When no promotion-eligible run existed for a game,
`select_main_cohort_row` fell back to the full run pool. If that fallback row
was temporally valid and had an outcome, `quarantine_row` returned no reason
and the row entered the CLEAN evaluation dataset with
`promotion_eligible == False`.

**Fix.** The clean invariant is now explicit and enforced twice:

```
clean = valid temporal row AND valid outcome AND promotion_eligible AND no quarantine reason
```

- `select_main_cohort_row` quarantines an ineligible selection with the stable
  reason code `not_promotion_eligible`.
- `build_game_dataset`'s clean-append checks `row.promotion_eligible` directly
  (belt-and-braces for future selection paths).

Quarantined rows are retained in the quarantine output (auditable), never
dropped. `promotion_eligible` naming is broad (it gates *evaluation* rows, not
just promotions) — documented here as a follow-up; no schema rename in P0.

### 4. Promotion gates open on UNKNOWN (`src/eval/recommend.py`)

**Root cause.** Gates used `is not False` / `is not True`, so `None`
(check never run) satisfied `fold_stability_ok`, `subgroup_failure`, and
`replay_verified`. A market-derived challenger with an entirely ABSENT market
holdout also passed `market_incremental` (default `True`).

**Fix.** Fail-closed tri-state semantics:
- PASS requires the affirmative value (`is True` / `is False` as appropriate).
- FAIL (explicit) → `KEEP V1`.
- UNKNOWN (`None`) → blocks promotion with a `*_unknown` reason; if the metric
  comparison itself is complete and favorable, the verdict is
  `RUN V2 IN SHADOW` (gather the missing evidence), never `PROMOTE` and never
  a false `KEEP V1`.
- `market_residual_v2` with missing market comparison evidence (no
  `market_holdout`, or missing brier on either side) is blocked with
  `market_comparison_evidence_missing`.

No statistical thresholds changed. The production P7 report path
(`generate_p7_reports.py`) already passes `challenger_holdout=None` and
`replay_verified=False`, so its verdict (`INSUFFICIENT DATA — NOT PROMOTION
ELIGIBLE`) is unchanged; both challengers remain shadow-only.

### 5. Market temporal-provenance loophole (`src/prediction_audit.py`, `src/auditCard.js`)

**Root cause.** The paired-quote guard accepted a quote when `as_of` was NULL
OR the quote's `fetched_at_utc` was NULL — unknown provenance was treated as
valid prediction-time evidence.

**Fix (both the Python audit backend and the JS Telegram port).** A paired
quote is prediction-time evidence only when BOTH timestamps are known AND
`fetched_at_utc <= as_of_utc`. NULL on either side → not evidence; the reader
falls back to the nearest provenance-proven pre-`as_of` quote, and when none
exists the card/API exposes the existing safe "not recorded" state. The
fallback query already required `fetched_at_utc IS NOT NULL AND
fetched_at_utc <= as_of` (and needs `as_of` to run), so it was already safe.
Closing quotes remain separate and are never substituted.

## Lifecycle invariants (now tested)

- Probabilities stay paired with their original outcomes; missing values drop
  the pair, never shift rows; length mismatch raises.
- Clean evaluation rows = temporal validity + outcome + promotion eligibility
  + no quarantine reason. Ineligible fallback rows are quarantined as
  `not_promotion_eligible`, auditable, never clean.
- UNKNOWN evidence can never satisfy a promotion gate; a market-derived
  challenger is unpromotable without market comparison evidence; missing
  challenger holdout → `INSUFFICIENT DATA`.
- Market-at-prediction requires proven provenance (both timestamps known,
  quote ≤ as_of); future quotes, NULL-timestamp quotes, and closing quotes are
  never prediction-time evidence; the audit reader never fetches current
  market state to fill history.
- Shadow scoring cannot alter production picks (pre-existing tests unchanged).

## New tests

- `tests/test_p0_lifecycle_hardening.py` (27): metric alignment cases A/B/C +
  paired semantics across all metrics; dataset eligibility invariant (6
  scenarios incl. deterministic multi-run cohort selection); fail-closed
  promotion (replay/fold/subgroup/market UNKNOWN, missing holdout, explicit
  FAILs, all-PASS sanity, production-call regression); Python market temporal
  provenance (valid / future / NULL quote ts / NULL as_of / closing
  separation / fallback filtering).
- `tests/test_audit_card.js` (+2): NULL quote timestamp rejected as
  prediction-time evidence (falls back to provenance-proven quote); NULL
  `as_of` claims no temporal validity and renders the safe state.

## Behavior changes

Production prediction behavior (heuristic_v1 formula, winner selection,
BET/NO BET, Kelly, Telegram) is unchanged. Changes are limited to:
- evaluation metrics computed over rows with missing values (previously
  silently misaligned — old numbers near such rows were wrong);
- clean-dataset membership for non-promotion-eligible fallback rows
  (previously leaked, now quarantined);
- `recommend()` verdicts when evidence is UNKNOWN (previously could reach
  PROMOTE with `human_approved=True`; now shadow/blocked);
- audit card market-at-prediction for NULL-timestamp quotes (previously shown
  as paired evidence; now falls back or shows "not recorded");
- historical stored predictions are NOT rewritten; snapshots untouched.

## Shadow scoring observability (P1 prep — documented only)

Current behavior: `Storage.capturePredictionSnapshot` (src/storage.js) wraps
`scoreShadowChallengers` in a bare `try/catch {}` — any shadow failure is
swallowed with no record. Inside `src/core/model_registry.js`,
`scoreShadowChallengers` already returns one `{ modelId, entry, reason }` per
challenger where `reason` is a stable string (`shadow_mode_disabled`,
`feature_vector_build_failed: …`, `no_compatible_artifact`, feature-hash
mismatch, etc.) — but a `null` entry's reason is dropped by the caller.

Recommended P1 implementation point: in the `capturePredictionSnapshot`
shadow block, persist one event per challenger per run:
`{ run_id, model_id, status: SCORED|SKIPPED|FAILED, reason, created_at }`
(SCORED = entry written; SKIPPED = registry returned a no-op reason;
FAILED = the catch path, with the exception message as reason). A small
append-only `shadow_scoring_events` table (or reuse of `reason_codes` in
model_predictions for SCORED) is sufficient; no orchestration changes needed.

## Unresolved / follow-ups

- `promotion_eligible` is semantically broad (evaluation eligibility, not just
  promotion) — rename deferred to avoid migration risk.
- Root `npm ci` in CI compiles better-sqlite3 via install script; allow-scripts
  warnings are informational locally but worth pinning policy eventually.
- Shadow coverage monitoring (SCORED/SKIPPED/FAILED persistence) is P1.
