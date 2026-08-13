# Current Model Formula

Exact specification of the canonical moneyline production core
(`src/core/prediction_core.js` → `predictGameMoneylineCore`). This document is
generated from code; if code and doc disagree, code is authoritative.

**Control identity**

| Field | Value |
|---|---|
| `modelId` | `heuristic_v1` |
| `modelImplVersion` | `moneyline-core-v1.0` (`PREDICTION_CORE_MODEL_VERSION`) |
| `featureSchemaVersion` | `mlb-control-features-v1.0` (`CONTROL_FEATURE_SCHEMA_VERSION`) |

## 1. Probability stages

The core exposes named stages so no downstream surface can evaluate a
display-blended or market-overwritten value as pure model output.

| Stage | Field | Meaning |
|---|---|---|
| raw baseball | `raw.homeProbability` / `rawAwayProbability` | sigmoid(dampenedEdge), pre-calibration, clamped [35,65] |
| control-calibrated | `calibrated.homeProbability` / `awayProbabilityPrecise` | isotonic-map calibration applied to favored side; complement derived |
| model breakdown | `modelBreakdown.*` | every edge component + intermediate |
| market-informed display | (attached in `mlb.js`, not core) | blend of control + no-vig market; display only |
| VALUE grading | (attached in `mlb.js`, not core) | edge/fair-probability for bet selection |

Calibration is the FINAL probability transform inside the core. Downstream
market/edge/stake logic consumes only the calibrated value.

## 2. Edge assembly

```
edge = matchupEdge
     + (recordDominated ? recordContextEdge * 0.45 : recordContextEdge)
     + homeFieldComponent
     + weatherComponent
     + confirmationEdge
```

### 2.1 matchupEdge

```
matchupEdge = offenseComponent
            + preventionComponent
            + starterComponent
            + lineupEdge * (bothConfirmed ? 0.95 : 0.85)
            + bullpenComponent
            + fatigueEdge * 0.7
```

### 2.2 Component definitions and weights

| Component | Formula (clamped) | Base weight |
|---|---|---|
| offenseComponent | `clamp(offenseEdge + offenseFatigueEdge, -1.5, 1.5) * 0.32 * offenseWeightMultiplier * sitWeights.offense` | 0.32 |
| preventionComponent | `clamp(preventionEdge, -1.35, 1.35) * 0.26` | 0.26 |
| starterComponent | `clamp(spEdge, -1.35, 1.35) * 0.42 * starterWeightMultiplier * sitWeights.starting_pitcher` | 0.42 |
| bullpenComponent | `bullpenEdge * 0.35 * bullpenWeightMultiplier * sitWeights.bullpen` | 0.35 |
| formComponent | `clamp(formEdge, -0.3, 0.3) * 0.32 * recentFormWeightMultiplier * sitWeights.recent_form` | 0.32 |
| homeFieldComponent | `0.1 * homeAdvantageWeightMultiplier * sitWeights.home_advantage` | 0.10 |
| weatherComponent | `clamp(weatherAdj * -0.08, -0.06, 0.06)` | −0.08 |

### 2.3 recordContextEdge

```
recordContextEdge = log5Edge * 0.34
                  + formComponent
                  + h2hEdge * 0.025
                  + memoryEdge
                  + platoonEdge
```

`recordDominated = abs(recordContextEdge) > abs(matchupEdge) * 1.25
                  AND abs(matchupEdge) < 0.18`

When record-dominated, recordContextEdge is down-weighted to 0.45 to prevent
standings from overwhelming matchup signal.

### 2.4 confirmationEdge

```
confirmationEdge = bothConfirmed
  ? clamp(sign(matchupEdge) * min(abs(matchupEdge) * 0.08, 0.04), -0.04, 0.04)
  : 0
```

## 3. Edge sub-components

### 3.1 Offense blend (`blendedTeamOffenseEdge`)

```
seasonEdge = (rpg_home - rpg_away) / 2.2
           + (ops_home - ops_away) / 0.14
           + (iso_home - iso_away) / 0.1
           + (kRate_away - kRate_home) / 0.16
           + (bbRate_home - bbRate_away) / 0.12
```

Rolling form (last N games) replaces seasonEdge with a weighted blend when both
sides have ≥8 games:

```
rollingWeight = clamp((min(homeGames, awayGames) - 7) / 12, 0, 0.45)
edge = seasonEdge * (1 - rollingWeight) + rollingEdge * rollingWeight
```

### 3.2 Prevention blend (`blendedTeamPreventionEdge`)

```
seasonEdge = (era_away - era_home) / 1.8
           + (whip_away - whip_home) / 0.55
           + (kbb_home - kbb_away) / 0.16
           + (hr9_away - hr9_home) / 1.2
```

Rolling blend: `rollingWeight = clamp((min(games) - 7) / 12, 0, 0.4)`.

### 3.3 Starter edge (`starterEdge`)

```
season = starterSeasonEdge(effHome, effAway)   // era/whip/kbb/k-bb%/hr9
recent = starterRecentEdge(homeRecent, awayRecent) // needs >=6 IP each side
spEdge = clamp(season * 0.55 + recent * 0.45, -1.6, 1.6)
```

Opener/bulk situations: `effectivePitcherStats` returns null for openers, so
the season component is zeroed and bullpen weight shifts up.

### 3.4 Other edges

| Edge | Source | Range |
|---|---|---|
| lineupWinEdge | homeQuality − awayQuality + availability adjustment | [-0.18, 0.18] |
| bullpenAvailabilityEdge | (awayFatigue − homeFatigue)*0.075 + b2b + highPitch | [-0.18, 0.18] |
| scheduleFatigueEdge | awayPenalty − homePenalty | [-0.08, 0.08] |
| h2hEdge | (headToHead.homeProbability − 50) / 50 when games > 0 | — |
| memoryEdge | (homeBias − awayBias)*0.06 + matchupMemory.edge*0.12 | [-0.08, 0.08] |
| platoonEdge | (homeVsHand − awayVsHand)*0.6 when both known | — |
| weatherRunAdjustment | temp + wind, roof-multiplied | [-0.55, 0.55] |

## 4. Dampening

The model is systematically overconfident at higher edges (analysis of 773
moneyline outcomes + 59 staked bets). Edge is dampened before sigmoid:

| absEdge | dampeningFactor |
|---|---|
| < 0.25 | 0.65 (DAMPEN_LOW) |
| 0.25 – 0.50 | 0.50 (DAMPEN_MID) |
| >= 0.50 | 0.38 (DAMPEN_HIGH) |

```
dampenedEdge = edge * dampeningFactor
```

## 5. Sigmoid + raw probability

```
rawHomeProbability = clamp(sigmoid(dampenedEdge) * 100, 35, 65)
rawAwayProbability = 100 - rawHomeProbability
```

Raw probabilities are hard-clamped to [35, 65] — the model never expresses
certainty beyond ±15 from even.

## 6. Calibration (final transform)

Calibration is applied to the **favored side only**; the other side is its
complement so probabilities always sum to 100.

```
if rawHome >= 50:
    homeProbability = clamp(calibratePercent(rawHome, 'moneyline'), 30, 70)
    awayProbability = 100 - homeProbability
else:
    awayProbability = clamp(calibratePercent(rawAway, 'moneyline'), 30, 70)
    homeProbability = 100 - awayProbability
```

Calibrated probabilities are clamped to [30, 70].

Calibration modes (`src/calibration.js`): `map` (isotonic interpolation),
`map_low_sample_shrink` (map + shrink toward 0.5), `shrink_toward_50`,
`identity`. See `docs/CALIBRATION_GOVERNANCE.md`.

## 7. Defaults (missing data)

When a feature value is missing, the core substitutes league-average defaults
rather than failing:

| Field | Default |
|---|---|
| rpg | 4.4 |
| ops | 0.72 |
| era | 4.2 |
| whip | 1.3 |
| winPct | 0.5 |
| iso | 0.15 |
| kRate | 0.22 |
| bbRate | 0.085 |
| kMinusBb | 0.12 |
| hr9 | 1.1 |

Control may retain these defaults; research vectors and reports must not
present them as observed evidence (see `docs/DATA_PROVENANCE_SCHEMA.md`).

## 8. Situational weight adjustment

`parkFactorBaselines` (venue id → runFactor) and game month shift component
weights by up to `MAX_WEIGHT_SHIFT = 0.15`:

| Condition | offense | starting_pitcher | bullpen | recent_form |
|---|---|---|---|---|
| hitter_park (runFactor >= 1.05) | +0.08 | -0.05 | — | — |
| pitcher_park (runFactor <= 0.95) | -0.05 | +0.08 | — | — |
| opener detected | — | -0.12 | +0.15 | — |
| early season (month <= 4) | — | +0.03 | — | -0.10 |
| late season (month >= 8) | — | — | +0.05 | +0.08 |

## 9. Purity contract

`predictGameMoneylineCore` MUST NOT perform HTTP, filesystem, database access,
read `Date.now()`/`new Date()`, read environment variables, mutate inputs, or
depend on global mutable state. Every externally-sourced input (evolution
controls, calibration function, wall-clock `nowMs` for tiering, park factors)
is injected as a plain argument. Given identical inputs, output is deterministic.

## 10. Inactive / unused feature families

The following are collected or declared but do not affect the moneyline
probability in the current core (see `src/core/feature_roles.js`):

- Statcast / xStats (no live collection)
- Batter-vs-pitcher raw averages (no live collection)
- Travel/rest beyond schedule fatigue
- Umpire (no pre-game data source)
- Pitch arsenal interaction (no live collection)
- Sharp-money context (display only)

These may become timestamp-safe candidate features in P4 (shadow research
only); they never enter `heuristic_v1` coefficients without chronological
evidence and human approval.
