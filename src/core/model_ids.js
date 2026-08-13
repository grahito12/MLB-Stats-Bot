import { PREDICTION_CORE_MODEL_VERSION } from './prediction_core.js';

export const HEURISTIC_V1_MODEL_ID = 'heuristic_v1';
export const HEURISTIC_V1_IMPL_VERSION = PREDICTION_CORE_MODEL_VERSION;
export const CONTROL_FEATURE_SCHEMA_VERSION = 'mlb-control-features-v1.0';

export const LEARNED_V2_LOGISTIC_MODEL_ID = 'learned_v2_logistic';
export const LEARNED_V2_LOGISTIC_IMPL_VERSION = 'learned-v2-logistic-v1.0';
export const MARKET_RESIDUAL_V2_MODEL_ID = 'market_residual_v2';
export const MARKET_RESIDUAL_V2_IMPL_VERSION = 'market-residual-v2-v1.0';

// Shadow model orchestration. Defaults preserve control behavior.
export const DEFAULT_MODEL_VERSION = HEURISTIC_V1_MODEL_ID;
export const DEFAULT_SHADOW_MODE = false;

// Directory for versioned challenger proposal artifacts.
export const MODEL_ARTIFACTS_DIR = 'data/models';
