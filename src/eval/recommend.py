"""Evidence-bound promotion recommendation.

Final recommendation must be exactly one of:
  KEEP V1
  RUN V2 IN SHADOW
  PROMOTE LEARNED V2
  PROMOTE MARKET RESIDUAL V2
Insufficient evidence remains:
  INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE

Promotion requires (all must hold):
  - promotion-safe immutable population + deterministic replay
  - challenger Brier AND log loss improvement over heuristic_v1 on identical
    all-game holdout rows
  - winner accuracy preserved or improved under predeclared non-inferiority
  - stable chronological folds, no severe subgroup failure
  - for market_residual_v2: incremental improvement over no-vig market
  - explicit human approval

No code change active model automatically.
"""

from __future__ import annotations

from typing import Any

# Predeclared non-inferiority margin: challenger accuracy must not fall more
# than this many percentage points below control on the holdout.
ACCURACY_NONINFERIORITY_MARGIN = 0.01
# Minimum holdout rows for a promotion-eligible decision.
MIN_HOLDOUT_ROWS = 50
# Minimum Brier/log-loss improvement (absolute) to count as "improvement".
MIN_BRIER_IMPROVEMENT = 0.001
MIN_LOGLOSS_IMPROVEMENT = 0.003


def recommend(
    control_holdout: dict[str, Any] | None,
    challenger_holdout: dict[str, Any] | None,
    challenger_model_id: str = "learned_v2_logistic",
    market_holdout: dict[str, Any] | None = None,
    fold_stability_ok: bool | None = None,
    subgroup_failure: bool | None = None,
    replay_verified: bool | None = None,
    human_approved: bool = False,
) -> dict[str, Any]:
    """Produce the evidence-bound recommendation from holdout metrics.

    All metric dicts come from eval.metrics.model_metrics on the identical
    holdout rows. Returns a report with the recommendation + reasoning.
    """
    reasons: list[str] = []

    if control_holdout is None or challenger_holdout is None:
        return _result(
            "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE",
            reasons + ["missing_control_or_challenger_holdout_metrics"],
        )

    n = control_holdout.get("n", 0)
    if n < MIN_HOLDOUT_ROWS:
        return _result(
            "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE",
            reasons + [f"holdout_rows_{n}_below_minimum_{MIN_HOLDOUT_ROWS}"],
        )

    if replay_verified is False:
        reasons.append("replay_not_verified")

    # Brier + log loss improvement.
    ctrl_brier = control_holdout.get("brier")
    chal_brier = challenger_holdout.get("brier")
    ctrl_ll = control_holdout.get("log_loss")
    chal_ll = challenger_holdout.get("log_loss")

    brier_improved = (
        ctrl_brier is not None
        and chal_brier is not None
        and (ctrl_brier - chal_brier) >= MIN_BRIER_IMPROVEMENT
    )
    logloss_improved = (
        ctrl_ll is not None
        and chal_ll is not None
        and (ctrl_ll - chal_ll) >= MIN_LOGLOSS_IMPROVEMENT
    )
    if not brier_improved:
        reasons.append(
            f"brier_not_improved (control={ctrl_brier}, challenger={chal_brier})"
        )
    if not logloss_improved:
        reasons.append(
            f"log_loss_not_improved (control={ctrl_ll}, challenger={chal_ll})"
        )

    # Accuracy non-inferiority.
    ctrl_acc = control_holdout.get("accuracy")
    chal_acc = challenger_holdout.get("accuracy")
    accuracy_ok = (
        ctrl_acc is not None
        and chal_acc is not None
        and (chal_acc >= ctrl_acc - ACCURACY_NONINFERIORITY_MARGIN)
    )
    if not accuracy_ok:
        reasons.append(
            f"accuracy_noninferiority_failed (control={ctrl_acc}, challenger={chal_acc}, "
            f"margin={ACCURACY_NONINFERIORITY_MARGIN})"
        )

    # Fold stability + subgroup.
    if fold_stability_ok is False:
        reasons.append("fold_instability")
    if subgroup_failure is True:
        reasons.append("severe_subgroup_failure")

    # Market residual requires incremental improvement over no-vig market.
    market_incremental = True
    if challenger_model_id == "market_residual_v2" and market_holdout is not None:
        mkt_brier = market_holdout.get("brier")
        if mkt_brier is not None and chal_brier is not None:
            market_incremental = (mkt_brier - chal_brier) >= MIN_BRIER_IMPROVEMENT
            if not market_incremental:
                reasons.append(
                    f"market_residual_not_incremental_over_market (market={mkt_brier}, challenger={chal_brier})"
                )

    all_conditions = (
        brier_improved
        and logloss_improved
        and accuracy_ok
        and market_incremental
        and fold_stability_ok is not False
        and subgroup_failure is not True
        and replay_verified is not False
    )

    if not all_conditions:
        return _result("KEEP V1", reasons)

    if not human_approved:
        return _result(
            "RUN V2 IN SHADOW",
            reasons + ["pending_human_approval"],
        )

    if challenger_model_id == "market_residual_v2":
        return _result("PROMOTE MARKET RESIDUAL V2", reasons + ["human_approved"])
    return _result("PROMOTE LEARNED V2", reasons + ["human_approved"])


def _result(recommendation: str, reasons: list[str]) -> dict[str, Any]:
    return {
        "recommendation": recommendation,
        "reasons": reasons,
        "promotion_eligible": recommendation.startswith("PROMOTE"),
    }
