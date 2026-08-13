import assert from 'node:assert/strict';
import test from 'node:test';

import { PREDICTION_CORE_MODEL_VERSION } from '../src/core/prediction_core.js';
import { HEURISTIC_V1_IMPL_VERSION } from '../src/core/model_ids.js';

test('public heuristic implementation identity matches canonical core', () => {
  assert.equal(HEURISTIC_V1_IMPL_VERSION, PREDICTION_CORE_MODEL_VERSION);
});
