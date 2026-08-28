You are working on this repository:

https://github.com/0x-zeze/MLB-Stats-Bot

I want you to act as a senior ML systems engineer, quantitative model engineer, and backend/frontend architect.

Your task is NOT simply to add more prediction features.

The main goal is to evolve the project from:

data → heuristic → pick

into:

immutable data
→ candidate models
→ chronological evaluation
→ calibration
→ shadow deployment
→ holdout proof
→ promotion
→ continuously monitored production

At the same time, I want to build a proper Prediction Audit Card so every prediction can be inspected, explained, reproduced, and evaluated.

Before changing code, read and understand the full repository architecture, especially:

* prediction engine
* model formulas
* data collection
* feature generation
* odds / market handling
* calibration
* backtesting
* model registry
* prediction history
* immutable snapshots
* replay system
* dashboard backend
* dashboard frontend
* Telegram integration
* tests
* model documentation
* architecture documentation

Pay particular attention to files/docs related to:

* CURRENT_MODEL_FORMULA
* MODEL_CARD
* PREDICTION_ENGINE_AUDIT
* REMAINING_RISKS
* model_predictions
* market quote snapshots
* feature vectors
* chronological evaluation
* calibration
* learned_v2_logistic
* heuristic_v1
* pure prediction core

Do not assume the documentation is perfectly synchronized with the implementation. Verify the actual code.

==================================================
PRIMARY OBJECTIVE
=================

Build the foundations of a model lifecycle where MLB-Stats-Bot can objectively determine whether a prediction model or feature is actually useful.

Every production prediction should eventually be traceable through:

1. immutable source data
2. immutable feature vector
3. model version
4. model artifact/version
5. calibration version
6. generated probability
7. contemporaneous market probability
8. decision/pick
9. settlement
10. closing-line comparison
11. model evaluation

The project should make it difficult to accidentally introduce:

* temporal leakage
* look-ahead bias
* mutable historical predictions
* feature drift
* model/version ambiguity
* backtest-only logic
* cherry-picked model evaluation

==================================================
PART 1 — PREDICTION AUDIT CARD
==============================

Implement a Prediction Audit Card in the dashboard.

The card should allow a user to inspect one specific prediction.

A conceptual example:

NYY @ BOS

Model
heuristic_v1
moneyline-core-v1.0

Prediction
NYY 57.2%

Market No-Vig
53.1%

Model Edge
+4.1%

Calibrated Probability
55.8%

Data Quality
✅ Starting Pitcher confirmed
✅ Lineup confirmed
✅ Bullpen data fresh
✅ Odds fresh
⚠ Weather estimated

Feature Contributions
Starting Pitcher     +3.1%
Bullpen              +1.8%
Offense              +1.2%
Home Field           -1.0%
Weather              +0.2%

Decision
NO BET

Reason
Edge below minimum threshold

Prediction metadata
prediction_id
run_id
game_id
model_name
model_version
feature_schema_version
calibration_version
as_of timestamp
created_at

Market metadata
sportsbook/source
market timestamp
moneyline
raw implied probability
no-vig probability
market age

Result
final score
prediction correct/incorrect
closing odds
closing no-vig probability
CLV if available

The exact UI does not have to match this layout.

Design the UI appropriately for the existing dashboard.

Requirements:

* reuse existing components/styles where possible
* do not create an entirely separate design system
* make the card readable for both technical and non-technical users
* distinguish prediction probability from calibrated probability
* distinguish model probability from market probability
* clearly indicate stale/missing/degraded data
* clearly indicate BET / NO BET
* clearly display why the decision was made

If data does not exist yet for a field, do NOT fake it.

Show:

Unavailable

or:

Not recorded for this prediction

instead.

==================================================
PART 2 — IMMUTABLE PREDICTION SNAPSHOT
======================================

Every prediction must be reconstructable.

Create or improve the immutable prediction snapshot so it records enough information to reproduce the decision later.

A prediction snapshot should include, where applicable:

* prediction_id
* prediction_run_id
* game_id
* game start time
* prediction timestamp / as_of timestamp

MODEL

* model_name
* model_version
* model artifact identifier/hash if applicable
* feature schema version
* calibration model/version

INPUT STATE

* starting pitchers
* lineup status
* team/offensive stats used
* starter stats used
* bullpen stats used
* injuries if used
* weather if used
* park factor if used
* rest/travel data if used
* market odds if used
* market timestamp

FEATURE VECTOR

Store the exact feature vector used for inference.

Do not regenerate historical feature vectors from current data.

Store them immutably.

OUTPUT

* raw probability
* calibrated probability
* market probability
* no-vig probability
* edge
* confidence
* decision
* bet/no-bet reason
* Kelly sizing if applicable
* risk adjustment if applicable

DATA QUALITY

Record whether each important input was:

* confirmed
* estimated
* stale
* missing
* fallback

Historical prediction records must not silently mutate when upstream stats change.

==================================================
PART 3 — FEATURE SYSTEM
=======================

I want to continue improving prediction features, but feature engineering must become controlled and measurable.

Do NOT blindly add many features.

First inspect which features already exist.

Create a structured feature definition/registry.

Each feature should ideally have:

* name
* description
* category
* data source
* timestamp/as_of rules
* missing-value behavior
* transformation
* version
* whether it is safe for historical replay
* whether it is currently production-enabled

Suggested categories:

* offense
* starting pitcher
* bullpen
* defense
* lineup
* handedness/splits
* park
* weather
* rest
* travel
* schedule
* recent form
* market-derived
* contextual

The feature pipeline must guarantee:

feature_timestamp <= prediction_as_of

No feature is allowed to contain information that became known after the prediction timestamp.

Implement tests for this.

==================================================
PART 4 — FEATURE CONTRIBUTIONS / EXPLAINABILITY
===============================================

Prediction Audit Card should expose why a probability moved.

For heuristic_v1:

Compute contribution by model component based on the actual formula.

Examples:

Offense
Starting Pitcher
Bullpen
Home Field
Weather
Lineup
Park
Rest

Do not invent fake percentages.

Use contributions derived from the actual scoring/probability calculation.

For learned models:

Design the interface so explanations can later come from:

* logistic coefficients
* SHAP values
* permutation contribution
* another appropriate method

The Audit Card should consume a normalized explanation format independent of model type.

Example conceptual structure:

{
"feature_contributions": [
{
"feature": "starter_advantage",
"category": "starting_pitcher",
"value": 1.34,
"contribution": 0.031
}
]
}

Do not overengineer SHAP now unless the learned model already makes it straightforward.

The important part is creating a clean interface.

==================================================
PART 5 — CANDIDATE MODEL FRAMEWORK
==================================

Production should no longer conceptually mean:

one model = truth

Instead support:

control model
challenger models
shadow models

For example:

heuristic_v1
role: control

learned_v2_logistic
role: challenger/shadow

future_model
role: candidate

Each prediction run should be capable of recording predictions from multiple candidate models for the same immutable game snapshot.

IMPORTANT:

Candidate models must receive the SAME underlying snapshot when being compared.

Do not allow each model to fetch different live data independently.

Desired flow:

collect immutable game snapshot

then

feature extraction

then

Model A inference
Model B inference
Model C inference

then persist all predictions.

This is necessary for apples-to-apples evaluation.

==================================================
PART 6 — CHRONOLOGICAL EVALUATION
=================================

Do not use random train/test splitting for primary model evaluation.

Base evaluation on chronological splits.

Example:

TRAIN
older dates

VALIDATION
later dates

HOLDOUT
newest untouched dates

Support rolling / expanding windows where practical.

Evaluation should compare models on the SAME games.

At minimum report:

* games evaluated
* accuracy
* Brier score
* log loss
* ROC AUC where applicable
* calibration error / ECE
* average predicted probability
* market no-vig Brier
* market no-vig log loss
* model vs market Brier delta
* model vs market log-loss delta

For betting subsets also report:

* number of bets
* win rate
* ROI
* average edge
* average closing-line value
* CLV positive %
* maximum drawdown if bankroll simulation exists

Do not allow ROI alone to determine whether a model is better.

Prediction quality must primarily be assessed through proper probabilistic scoring.

==================================================
PART 7 — CALIBRATION
====================

Separate:

raw model probability

from:

calibrated probability

Calibration must be versioned.

A prediction must record which calibration model transformed it.

Examples:

identity
platt
isotonic
beta calibration

Do not automatically assume isotonic is best.

Compare calibration approaches chronologically.

Guard against calibration with insufficient samples.

Create metrics/reporting for:

* reliability bins
* expected calibration error
* Brier before calibration
* Brier after calibration
* log loss before
* log loss after
* number of samples

If calibration makes holdout performance worse, it should not be promoted.

==================================================
PART 8 — SHADOW DEPLOYMENT
==========================

Add or formalize a shadow mode.

A shadow model:

* receives production snapshots
* generates predictions
* stores them
* DOES NOT influence the betting decision
* DOES NOT change Telegram picks
* DOES NOT affect bankroll sizing

This is extremely important.

For each game, we should eventually have something like:

production/control:
heuristic_v1

shadow:
learned_v2_logistic

Both predictions should be stored before the game starts.

After settlement, both can be evaluated.

==================================================
PART 9 — HOLDOUT PROOF
======================

Build the system around the principle:

A model is not production-worthy because its backtest looks good.

A candidate must demonstrate performance on data that was not used to:

* train it
* calibrate it
* select its thresholds
* discover its betting segment
* tune its hyperparameters

Do not automatically promote models.

Holdout evaluation must be explicit.

Where possible create artifacts/reports that state:

Candidate:
learned_v2_logistic

Control:
heuristic_v1

Period:
YYYY-MM-DD → YYYY-MM-DD

Games:
N

Candidate Brier:
...

Control Brier:
...

Market Brier:
...

Candidate log loss:
...

Calibration:
...

CLV:
...

Decision:
PROMOTE / KEEP SHADOW / REJECT

Reason:
...

==================================================
PART 10 — MODEL PROMOTION FRAMEWORK
===================================

Create a model lifecycle.

Suggested statuses:

experimental
candidate
shadow
validated
production
retired

Promotion must not be based on a developer manually changing one string without evidence.

Build a promotion report/checklist.

A candidate should only become production after satisfying clearly defined checks.

Do not invent statistically unrealistic thresholds.

If the repository does not currently contain enough evidence to establish sensible thresholds, implement the framework and document that thresholds require future evidence.

Possible gates:

* sufficient sample size
* no temporal leakage detected
* immutable predictions available
* calibration acceptable
* Brier competitive with control
* log loss competitive with control
* performance stable across chronological windows
* no severe subgroup instability
* shadow predictions complete
* replay parity passed

==================================================
PART 11 — CONTINUOUS MONITORING
===============================

After a model becomes production, monitoring must continue.

Create the foundations for model monitoring.

Track rolling metrics such as:

* prediction count
* data completeness
* Brier score
* log loss
* ECE
* accuracy
* mean confidence
* calibration drift
* average model-market edge
* CLV
* percentage of stale inputs
* DEGRADED predictions
* NO_BET reasons

Useful windows:

7 days
30 days
60 days
90 days
season-to-date

Do not assume a model remains good forever.

==================================================
PART 12 — DATA QUALITY
======================

Create a normalized prediction data-quality representation.

Possible states:

GOOD
DEGRADED
INSUFFICIENT

For important inputs record:

starting_pitcher:
confirmed

lineup:
confirmed

bullpen:
fresh

odds:
fresh

weather:
estimated

The prediction system should know the difference between:

missing information

and:

real neutral value

Never silently convert missing data into a legitimate zero unless the feature definition explicitly requires that behavior.

==================================================
PART 13 — MARKET DATA
=====================

Market comparison must respect time.

The model must be compared to odds that were available at or before prediction time.

Never use closing odds as an inference feature unless explicitly building a historical closing-market model.

Store:

quote timestamp
sportsbook/source
home odds
away odds
raw implied probability
no-vig probability

Closing odds should be stored separately and used only for later evaluation / CLV.

Avoid temporal leakage at all costs.

==================================================
PART 14 — DATABASE / STORAGE
============================

Inspect the current schema before modifying anything.

Reuse existing tables when appropriate.

Do NOT unnecessarily duplicate concepts that already exist.

Prefer additive migrations.

Possible entities may include:

prediction_runs
model_predictions
prediction_snapshots
feature_vectors
market_quotes
model_registry
model_evaluations
calibration_models
model_promotions

But DO NOT create all of these blindly.

First determine what already exists.

Normalize only where it improves correctness.

Keep immutable historical data immutable.

==================================================
PART 15 — API
=============

Expose enough data to power the Prediction Audit Card.

Prefer a dedicated endpoint or clean existing endpoint such as conceptually:

GET /api/predictions/:predictionId/audit

Possible response shape:

{
"prediction": {...},
"model": {...},
"probabilities": {...},
"decision": {...},
"market": {...},
"dataQuality": {...},
"features": {...},
"contributions": [...],
"result": {...},
"evaluation": {...}
}

Do not force the frontend to reconstruct prediction logic.

The backend should provide normalized audit information.

==================================================
PART 16 — TESTING
=================

Add tests for all important new behavior.

At minimum include tests for:

1. immutable prediction snapshot

2. prediction replay produces identical result when given identical:

* snapshot
* model version
* calibration version

3. historical features cannot use future timestamps

4. market quote timestamp cannot exceed prediction as_of

5. multiple candidate models receive the same underlying snapshot

6. shadow model cannot alter production decision

7. calibration version is persisted

8. missing data is represented explicitly

9. heuristic contribution totals correctly map to actual calculation

10. Prediction Audit API returns correct data

11. database migration compatibility

12. existing production prediction behavior does not unintentionally change

Do not delete existing tests just to make the suite pass.

==================================================
PART 17 — DOCUMENTATION
=======================

Update the documentation.

Create or update documents explaining:

MODEL_LIFECYCLE.md

Describe:

experimental
→ candidate
→ shadow
→ validated
→ production
→ retired

PREDICTION_AUDIT.md

Explain how a prediction can be reproduced and audited.

FEATURE_REGISTRY.md

Explain feature definitions, timestamps, missing values, and versions.

MODEL_EVALUATION.md

Explain chronological evaluation and probabilistic metrics.

CALIBRATION.md

Explain calibration versions and promotion criteria.

Update ARCHITECTURE.md if architecture changes materially.

==================================================
IMPORTANT ENGINEERING RULES
===========================

1. Do not rewrite the entire application.

Make incremental changes that fit the existing architecture.

2. Do not break current Telegram behavior.

3. Do not silently change production betting decisions unless required for correctness.

If behavior must change, document exactly why.

4. Preserve heuristic_v1 as the production control unless there is already sufficient evidence and explicit infrastructure to promote another model.

5. learned_v2_logistic should remain challenger/shadow unless validated.

6. Do not claim a model has an edge without proper holdout evidence.

7. Never use future information during historical prediction reconstruction.

8. Avoid random train/test split as the main validation method.

9. All important model artifacts should be versioned.

10. Make prediction outputs reproducible.

11. Prefer deterministic pure functions for prediction logic.

12. Keep data collection separate from model inference.

13. Keep inference separate from betting/risk decision logic.

14. Keep model probability separate from market probability.

15. Keep model probability separate from calibrated probability.

16. Keep prediction performance separate from betting ROI.

17. Do not optimize solely for win rate.

18. Do not introduce fake precision.

19. Do not add features unless their timestamps can be historically reconstructed safely.

20. Avoid overengineering infrastructure that the repository does not yet need.

==================================================
IMPLEMENTATION STRATEGY
=======================

Work incrementally.

PHASE 1

Audit the repository.

Before modifying code, produce:

* current prediction flow
* current data flow
* existing relevant tables
* existing model registry
* existing replay system
* current calibration implementation
* existing evaluation scripts
* existing frontend/dashboard structure
* gaps relative to the target architecture

Then give a concrete implementation plan.

PHASE 2

Implement the Prediction Audit data model/backend.

Prioritize:

* immutable prediction metadata
* normalized audit response
* feature snapshot
* model metadata
* market metadata
* data quality
* decision reason
* feature contributions

PHASE 3

Implement Prediction Audit Card frontend.

PHASE 4

Formalize candidate/control/shadow model execution.

PHASE 5

Improve chronological evaluation + calibration lifecycle.

PHASE 6

Add holdout/promotion reporting.

PHASE 7

Add production monitoring.

Do not attempt a giant rewrite in one step.

==================================================
PREDICTION AUDIT CARD UX
========================

The card should answer these questions immediately:

1. What did the model predict?

2. Which model/version generated it?

3. What did the market think at that moment?

4. How large was the model-market disagreement?

5. Was the displayed probability calibrated?

6. Which factors drove the prediction?

7. Was the underlying data complete and fresh?

8. Why was it BET or NO BET?

9. Can this prediction be replayed?

10. What happened after the game?

11. Did the prediction beat the closing market?

The UI should make these concepts visually distinct.

==================================================
FEATURE ENGINEERING DIRECTION
=============================

After the audit/lifecycle foundation exists, inspect the current feature set and identify high-value missing features.

Do NOT automatically implement everything.

First rank candidate features by:

predictive hypothesis
data availability
timestamp safety
historical availability
sample size
implementation complexity
expected redundancy with existing features

Potential areas to investigate include:

* starting pitcher quality beyond basic ERA
* pitcher handedness splits
* platoon advantage
* expected lineup strength
* bullpen workload/fatigue
* bullpen quality
* park-adjusted offense
* recent offensive form with proper shrinkage
* defense
* catcher effects if reliable
* rest days
* travel distance
* consecutive games
* day/night splits
* weather
* wind
* temperature
* park factors
* team handedness splits
* starter pitch-type matchup
* injuries
* lineup changes
* market information as benchmark/context

But again:

DO NOT add features just because they exist.

Every feature should be considered a hypothesis.

A new feature must eventually demonstrate incremental out-of-sample value.

==================================================
ABLATION FRAMEWORK
==================

Create or prepare an ablation evaluation system.

Example:

Base model

vs

Base + Bullpen Fatigue

vs

Base + Bullpen Fatigue + Platoon

Compare:

Brier
Log Loss
ECE
AUC

on chronological validation/holdout data.

This should help answer:

“Did this new feature actually improve the model?”

rather than:

“Does this feature sound useful?”

==================================================
FINAL DELIVERABLE
=================

At the end of the implementation, provide:

1. Summary of architecture changes.

2. Files created.

3. Files modified.

4. Database migrations.

5. New tests.

6. How to run tests.

7. How to open/use Prediction Audit Card.

8. How to run chronological evaluation.

9. How to run shadow predictions.

10. How candidate model promotion now works.

11. Known limitations.

12. What remains before we can make any credible claim of model edge.

13. Recommended next 5 tasks ranked by expected impact.

Most importantly:

Do not optimize this repository to LOOK sophisticated.

Optimize it so that a skeptical ML engineer can inspect a prediction from months ago and answer:

“What exactly did the system know at that moment, what model generated this probability, why did it make this decision, and did the model subsequently prove that it was better than the alternatives?”

That is the standard this implementation should aim for.
