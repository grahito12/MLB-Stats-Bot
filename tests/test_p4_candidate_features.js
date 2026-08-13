import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Storage } from '../src/storage.js';
import {
  buildStatcastTeamPayload,
  buildPitchArsenalPayload,
  buildExpectedInningsPayload,
  buildBullpenQualityPayload,
  buildLineupBatterPayload,
  buildBvpPayload,
  buildStarterXeraPayload,
  writeCandidateSnapshots,
  isPromotionSafe,
  CANDIDATE_GROUPS,
  CANDIDATE_FEATURE_SCHEMA_VERSION,
  MIN_BVP_PA
} from '../src/core/candidate_features.js';

function freshStorage() {
  const tempDir = resolve(process.cwd(), `.tmp-p4-tests-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, 'state-p4.json');
  return { storage: new Storage(statePath), tempDir };
}

const FIRST_PITCH = '2026-07-21T23:05:00Z';
const AS_OF = '2026-07-21T17:00:00Z'; // pre-pitch
const POST_PITCH = '2026-07-21T23:30:00Z'; // post-pitch

// ---------- Payload builders ----------

test('buildStatcastTeamPayload carries values + sample, nulls absent side', () => {
  const p = buildStatcastTeamPayload({
    away: { xwoba: 0.310, xslg: 0.390, barrelRate: 0.07, hardHitRate: 0.38, samplePa: 120 },
    home: { xwoba: 0.330, xslg: 0.420, barrelRate: 0.09, hardHitRate: 0.41, samplePa: 118 }
  });
  assert.equal(p.away.xwoba, 0.31);
  assert.equal(p.home.barrel_rate, 0.09);
  assert.equal(p.away.sample_pa, 120);
  // absent side -> null
  const p2 = buildStatcastTeamPayload({ away: { xwoba: 0.31, xslg: 0.39, barrelRate: 0.07, hardHitRate: 0.38, samplePa: 5 } });
  assert.equal(p2.home, null);
});

test('buildBullpenQualityPayload computes available innings = 9 - expected starter innings (clamped)', () => {
  const p = buildBullpenQualityPayload({
    away: { qualityScore: 0.6, sampleRelievers: 4, expectedStarterInnings: 6.0 },
    home: { qualityScore: 0.5, sampleRelievers: 3, expectedStarterInnings: 3.0 }
  });
  assert.equal(p.away.available_innings, 3.0); // 9 - 6
  assert.equal(p.home.available_innings, 6.0); // 9 - 3
  // clamp: starter going 0 -> 9 bullpen innings; starter going 12 -> 0
  const clamped = buildBullpenQualityPayload({
    away: { qualityScore: 0.5, sampleRelievers: 3, expectedStarterInnings: 12.0 },
    home: { qualityScore: 0.5, sampleRelievers: 3, expectedStarterInnings: 0.0 }
  });
  assert.equal(clamped.away.available_innings, 0);
  assert.equal(clamped.home.available_innings, 9);
  // missing expected innings -> null available
  const noinn = buildBullpenQualityPayload({
    away: { qualityScore: 0.5, sampleRelievers: 3 }
  });
  assert.equal(noinn.away.available_innings, null);
});

test('buildBvpPayload returns null below MIN_BVP_PA (no guess)', () => {
  const low = buildBvpPayload({ away: { ops: 0.75, plateAppearances: MIN_BVP_PA - 1 } });
  assert.equal(low.away, null);
  const ok = buildBvpPayload({ away: { ops: 0.75, plateAppearances: MIN_BVP_PA } });
  assert.equal(ok.away.ops, 0.75);
  assert.equal(ok.away.plate_appearances, MIN_BVP_PA);
});

test('buildLineupBatterPayload encodes confirmation as 0/1/null', () => {
  const p = buildLineupBatterPayload({
    away: { weightedOps: 0.71, battersCaptured: 9, confirmed: true },
    home: { weightedOps: 0.69, battersCaptured: 9, confirmed: false }
  });
  assert.equal(p.away.confirmed, 1);
  assert.equal(p.home.confirmed, 0);
  const unknown = buildLineupBatterPayload({ away: { weightedOps: 0.71, battersCaptured: 9, confirmed: null } });
  assert.equal(unknown.away.confirmed, null);
});

test('all builders stamp no schema/provenance (orchestrator does that)', () => {
  // builders are pure value mappers; provenance attached at write time.
  const p = buildPitchArsenalPayload({ away: { overallStuffPlus: 105, stuffVsLhh: 103, stuffVsRhh: 107, samplePitches: 60 } });
  assert.equal('as_of_utc' in p, false);
  assert.equal(p.away.overall_stuff_plus, 105);
});

// ---------- Promotion-safety gate ----------

test('isPromotionSafe passes when as_of strictly before first pitch', () => {
  assert.equal(isPromotionSafe(AS_OF, FIRST_PITCH).ok, true);
});

test('isPromotionSafe fails post-pitch, missing, and unparseable', () => {
  assert.equal(isPromotionSafe(POST_PITCH, FIRST_PITCH).ok, false);
  assert.ok(isPromotionSafe(POST_PITCH, FIRST_PITCH).reason.includes('post_pitch'));
  assert.equal(isPromotionSafe(null, FIRST_PITCH).ok, false);
  assert.equal(isPromotionSafe(AS_OF, null).ok, false);
  assert.equal(isPromotionSafe('not-a-date', FIRST_PITCH).ok, false);
});

// ---------- Orchestrator: write-once + temporal rejection ----------

test('writeCandidateSnapshots writes all families when pre-pitch + skips empty', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const payloads = {
      statcast_team: buildStatcastTeamPayload({ away: { xwoba: 0.31, xslg: 0.39, barrelRate: 0.07, hardHitRate: 0.38, samplePa: 5 } }),
      pitch_arsenal: buildPitchArsenalPayload({ away: { overallStuffPlus: 105, stuffVsLhh: 103, stuffVsRhh: 107, samplePitches: 60 } }),
      bvp: buildBvpPayload({ away: { ops: 0.75, plateAppearances: 60 } }),
      // expected_innings + bullpen_quality + lineup_batter + starter_xera omitted -> no_payload
    };
    const results = writeCandidateSnapshots(storage, { gamePk: '7001', dateYmd: '2026-07-21', asOfUtc: AS_OF, firstPitchUtc: FIRST_PITCH }, payloads);
    const byGroup = Object.fromEntries(results.map((r) => [r.group, r]));
    assert.equal(byGroup.statcast_team.written, true);
    assert.equal(byGroup.pitch_arsenal.written, true);
    assert.equal(byGroup.bvp.written, true);
    assert.equal(byGroup.expected_innings.written, false);
    assert.equal(byGroup.expected_innings.reason, 'no_payload');
    // written payloads carry provenance
    const row = storage.getFeatureSnapshot('7001', 'statcast_team');
    assert.equal(row.payload.as_of_utc, AS_OF);
    assert.equal(row.payload.schema_version, CANDIDATE_FEATURE_SCHEMA_VERSION);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('writeCandidateSnapshots is write-once (second call does not overwrite)', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const payloads = {
      statcast_team: buildStatcastTeamPayload({ away: { xwoba: 0.31, xslg: 0.39, barrelRate: 0.07, hardHitRate: 0.38, samplePa: 5 } })
    };
    const ctx = { gamePk: '7002', dateYmd: '2026-07-21', asOfUtc: AS_OF, firstPitchUtc: FIRST_PITCH };
    const r1 = writeCandidateSnapshots(storage, ctx, payloads);
    assert.equal(r1.find((r) => r.group === 'statcast_team').written, true);
    // mutate payload, write again -> should NOT overwrite (write-once).
    const payloads2 = {
      statcast_team: buildStatcastTeamPayload({ away: { xwoba: 0.99, xslg: 0.99, barrelRate: 0.99, hardHitRate: 0.99, samplePa: 99 } })
    };
    const r2 = writeCandidateSnapshots(storage, ctx, payloads2);
    assert.equal(r2.find((r) => r.group === 'statcast_team').written, false);
    assert.equal(r2.find((r) => r.group === 'statcast_team').reason, 'already_captured');
    const row = storage.getFeatureSnapshot('7002', 'statcast_team');
    assert.equal(row.payload.away.xwoba, 0.31); // original preserved
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('writeCandidateSnapshots rejects all families when post-pitch (temporal ineligible)', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const payloads = {
      statcast_team: buildStatcastTeamPayload({ away: { xwoba: 0.31, xslg: 0.39, barrelRate: 0.07, hardHitRate: 0.38, samplePa: 5 } })
    };
    const results = writeCandidateSnapshots(storage, { gamePk: '7003', dateYmd: '2026-07-21', asOfUtc: POST_PITCH, firstPitchUtc: FIRST_PITCH }, payloads);
    for (const r of results) {
      assert.equal(r.written, false);
      assert.ok(r.reason.includes('temporal_ineligible'), `group ${r.group}: ${r.reason}`);
    }
    // nothing written
    assert.equal(storage.getFeatureSnapshot('7003', 'statcast_team'), null);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('writeCandidateSnapshots skips all-empty payload (no information)', () => {
  const { storage, tempDir } = freshStorage();
  try {
    // both sides absent -> empty payload
    const payloads = {
      statcast_team: buildStatcastTeamPayload({})
    };
    const results = writeCandidateSnapshots(storage, { gamePk: '7004', dateYmd: '2026-07-21', asOfUtc: AS_OF, firstPitchUtc: FIRST_PITCH }, payloads);
    assert.equal(results.find((r) => r.group === 'statcast_team').reason, 'empty_payload');
    assert.equal(storage.getFeatureSnapshot('7004', 'statcast_team'), null);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CANDIDATE_GROUPS lists all seven families', () => {
  assert.deepEqual([...CANDIDATE_GROUPS].sort(), [
    'bullpen_quality', 'bvp', 'expected_innings', 'lineup_batter',
    'pitch_arsenal', 'statcast_team', 'starter_xera'
  ].sort());
});
