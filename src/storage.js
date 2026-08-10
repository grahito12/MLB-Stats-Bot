import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

import { applyMigrations } from './storage/migrations.js';
import { getCalibrationArtifact, freezeCalibrationArtifact } from './calibration.js';
import { buildPredictionSnapshot } from './prediction_snapshot.js';
import { writeSnapshotFile } from './prediction_serializer.js';

const DEFAULT_STATE = {
  lastUpdateId: 0,
  lastAutoAlertDate: '',
  subscribers: {},
  predictions: {},
  memory: {
    version: 2,
    totalPicks: 0,
    correctPicks: 0,
    wrongPicks: 0,
    byConfidence: {},
    firstInning: {
      totalPicks: 0,
      correctPicks: 0,
      wrongPicks: 0,
      byPick: {
        YES: { total: 0, correct: 0 },
        NO: { total: 0, correct: 0 }
      }
    },
    teamBias: {},
    matchupMemory: {},
    learningLog: []
  }
};

const DEFAULT_AUTO_UPDATE = {
  enabled: false,
  dailyTime: '',
  lastSentDate: ''
};
const DEFAULT_LINE_MOVEMENT_ALERTS = {
  enabled: true
};
const TEAM_BIAS_LIMIT = 0.08;

const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sortTeamIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right));
}

function matchupMemoryKey(teamAId, teamBId) {
  return [String(teamAId), String(teamBId)].sort(sortTeamIds).join(':');
}

function teamSnapshot(team) {
  return {
    id: team?.id,
    name: team?.name,
    abbreviation: team?.abbreviation
  };
}

function currentWinnerStreak(games) {
  if (!games.length) return null;

  const firstWinner = games[0]?.winner;
  if (!firstWinner || firstWinner.id == null) return null;

  const winnerId = String(firstWinner.id);
  let length = 0;
  for (const game of games) {
    if (!game.winner || String(game.winner.id) !== winnerId) break;
    length += 1;
  }

  return {
    winner: firstWinner,
    length
  };
}

function hasAlternatingWinners(games) {
  if (games.length < 3) return false;

  const recent = games.slice(0, 4).map((game) => String(game.winner.id));
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index] === recent[index - 1]) return false;
  }

  return true;
}

function matchupPatternNote(entry) {
  const recent = entry.recentGames || [];
  if (!recent.length) return 'Belum ada matchup memory.';

  const streak = entry.currentStreak;
  const averageMargin = Number(entry.averageMargin || 0).toFixed(1);
  const accuracy =
    entry.pickStats?.total > 0
      ? Math.round((entry.pickStats.correct / entry.pickStats.total) * 100)
      : 0;

  if (entry.alternating) {
    return `Matchup recent bergantian; memory dibuat hati-hati. Avg margin ${averageMargin}, akurasi pick ${accuracy}%.`;
  }

  if (streak?.length >= 2) {
    return `${streak.winner.abbreviation || streak.winner.name} menang ${streak.length} pertemuan terakhir; tetap diperlakukan sebagai sinyal kecil. Avg margin ${averageMargin}.`;
  }

  return `${entry.totalGames} pertemuan tersimpan, avg margin ${averageMargin}, akurasi pick matchup ${accuracy}%.`;
}

function updateMatchupMemory(memory, prediction, result, correct, firstInningCorrect) {
  const key = matchupMemoryKey(prediction.away.id, prediction.home.id);
  const existing = memory.matchupMemory[key] || {};
  const margin = Math.abs(Number(result.home.score) - Number(result.away.score));
  const gameRecord = {
    gamePk: prediction.gamePk,
    dateYmd: prediction.dateYmd || result.dateYmd || '',
    matchup: prediction.matchup,
    away: teamSnapshot(result.away),
    home: teamSnapshot(result.home),
    winner: teamSnapshot(result.winner),
    loser: teamSnapshot(result.loser),
    score: {
      away: result.away.score,
      home: result.home.score
    },
    margin,
    pick: teamSnapshot(prediction.pick),
    pickProbability: prediction.pick.winProbability,
    pickConfidence: prediction.pick.confidence || 'unknown',
    correct,
    firstInningCorrect
  };

  const existingGames = existing.recentGames || [];
  const hadExistingGame = existingGames.some(
    (game) => String(game.gamePk) === String(prediction.gamePk)
  );
  const previousGames = existingGames.filter(
    (game) => String(game.gamePk) !== String(prediction.gamePk)
  );
  const recentGames = [gameRecord, ...previousGames].slice(0, 12);
  const teamIds = [String(prediction.away.id), String(prediction.home.id)];
  const teamRecords = Object.fromEntries(
    teamIds.map((teamId) => {
      const wins = recentGames.filter((game) => String(game.winner.id) === teamId).length;
      const losses = recentGames.filter((game) => String(game.loser.id) === teamId).length;
      return [teamId, { wins, losses }];
    })
  );
  const pickStats = {
    total: recentGames.length,
    correct: recentGames.filter((game) => game.correct).length
  };
  const averageMargin =
    recentGames.reduce((sum, game) => sum + Number(game.margin || 0), 0) /
    Math.max(1, recentGames.length);

  const entry = {
    key,
    teams: {
      ...(existing.teams || {}),
      [String(prediction.away.id)]: teamSnapshot(prediction.away),
      [String(prediction.home.id)]: teamSnapshot(prediction.home)
    },
    totalGames: Math.max(
      Number(existing.totalGames || 0) + (hadExistingGame ? 0 : 1),
      recentGames.length
    ),
    teamRecords,
    pickStats,
    averageMargin,
    currentStreak: currentWinnerStreak(recentGames),
    alternating: hasAlternatingWinners(recentGames),
    recentGames,
    updatedAt: new Date().toISOString()
  };
  entry.note = matchupPatternNote(entry);

  memory.matchupMemory[key] = entry;
  return entry;
}

function normalizeSubscriber(subscriber) {
  return {
    ...(subscriber || {}),
    autoUpdate: {
      ...DEFAULT_AUTO_UPDATE,
      ...(subscriber?.autoUpdate || {})
    },
    lineMovementAlerts: {
      ...DEFAULT_LINE_MOVEMENT_ALERTS,
      ...(subscriber?.lineMovementAlerts || {})
    }
  };
}

function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...state,
    subscribers: Object.fromEntries(
      Object.entries(state?.subscribers || {}).map(([chatId, subscriber]) => [
        chatId,
        normalizeSubscriber(subscriber)
      ])
    ),
    predictions: state?.predictions || {},
    memory: {
      ...DEFAULT_STATE.memory,
      ...(state?.memory || {}),
      firstInning: {
        ...DEFAULT_STATE.memory.firstInning,
        ...(state?.memory?.firstInning || {}),
        byPick: {
          ...DEFAULT_STATE.memory.firstInning.byPick,
          ...(state?.memory?.firstInning?.byPick || {})
        }
      },
      byConfidence: state?.memory?.byConfidence || {},
      teamBias: state?.memory?.teamBias || {},
      matchupMemory: state?.memory?.matchupMemory || {},
      learningLog: state?.memory?.learningLog || []
    }
  };
}

function compactPrediction(prediction, dateYmd) {
  const agent = prediction.agentAnalysis;
  // Deterministic probabilities only. LLM/agent may not rewrite win probabilities.
  const awayProbability = Math.round(
    prediction.away.winProbability ?? prediction.away.pureModelProbability ?? 50
  );
  const homeProbability = Math.round(
    prediction.home.winProbability ?? prediction.home.pureModelProbability ?? 50
  );
  // Authoritative pick is model/value side — never analyst-only identity.
  // Prefer pure model winner, then displayed winner; valuePick is separate in valuePick field.
  const modelPick =
    prediction.winner ||
    (homeProbability >= awayProbability ? prediction.home : prediction.away);
  const pickProbability =
    modelPick.id === prediction.away.id
      ? awayProbability
      : modelPick.id === prediction.home.id
        ? homeProbability
        : Math.round(prediction.winner?.winProbability ?? Math.max(awayProbability, homeProbability));

  return {
    gamePk: prediction.gamePk,
    dateYmd,
    status: prediction.status,
    startTime: prediction.startTime || null,
    matchup: `${prediction.away.name} @ ${prediction.home.name}`,
    away: {
      id: prediction.away.id,
      name: prediction.away.name,
      abbreviation: prediction.away.abbreviation,
      winProbability: awayProbability,
      winProbabilityRaw: prediction.away.winProbabilityRaw ?? awayProbability,
      pureModelProbability: prediction.away.pureModelProbability ?? prediction.modelBreakdown?.pureAwayProbability ?? awayProbability,
      marketInformedProbability: prediction.away.marketInformedProbability ?? prediction.modelBreakdown?.marketInformedAwayProbability ?? null,
      record: prediction.away.record || null
    },
    home: {
      id: prediction.home.id,
      name: prediction.home.name,
      abbreviation: prediction.home.abbreviation,
      winProbability: homeProbability,
      winProbabilityRaw: prediction.home.winProbabilityRaw ?? homeProbability,
      pureModelProbability: prediction.home.pureModelProbability ?? prediction.modelBreakdown?.pureHomeProbability ?? homeProbability,
      marketInformedProbability: prediction.home.marketInformedProbability ?? prediction.modelBreakdown?.marketInformedHomeProbability ?? null,
      record: prediction.home.record || null
    },
    pick: {
      id: modelPick.id,
      name: modelPick.name,
      abbreviation: modelPick.abbreviation,
      winProbability: pickProbability,
      source: 'baseline-model',
      confidence: 'model'
    },
    // Explanation-only agent fields (do not replace pick identity).
    agentExplanation: agent
      ? {
          reasons: agent.reasons || [],
          risk: agent.risk || '',
          memoryNote: agent.memoryNote || '',
          supportingFactors: agent.supportingFactors || [],
          counterFactors: agent.counterFactors || [],
          dataQualityWarnings: agent.dataQualityWarnings || [],
          marketDisagreement: agent.marketDisagreement || '',
          recommendationExplanation: agent.recommendationExplanation || ''
        }
      : null,
    reasons: agent?.reasons || prediction.reasons,
    firstInning: prediction.firstInning
      ? {
          // Deterministic first-inning pick/prob only; agent reasons may annotate.
          pick: prediction.firstInning.baselinePick || prediction.firstInning.pick,
          probability: Math.round(
            prediction.firstInning.baselineProbability ?? prediction.firstInning.probability ?? 50
          ),
          source: 'baseline-model',
          reasons: prediction.firstInning.agent?.reasons || prediction.firstInning.reasons || []
        }
      : null,
    modelBreakdown: prediction.modelBreakdown || null,
    modelBreakdownLine: prediction.modelBreakdownLine || '',
    currentOdds: prediction.currentOdds || null,
    valuePick: prediction.valuePick || null,
    moneylineValueOptions: prediction.moneylineValueOptions || [],
    betDecision: prediction.betDecision || null,
    auditMemoryNotes: prediction.auditMemoryNotes || [],
    auditAdjustments: prediction.auditAdjustments || [],
    agentRisk: agent?.risk || '',
    agentMemoryNote: agent?.memoryNote || '',
    agentShift: agent?.probabilityShift
      ? {
          applied: false,
          rejected: Boolean(agent.probabilityShift.rejected || agent.probabilityShift.shift),
          shift: agent.probabilityShift.shift,
          reason: agent.probabilityShift.reason || null,
          baselineAwayProbability: agent.probabilityShift.baselineAwayProbability,
          baselineHomeProbability: agent.probabilityShift.baselineHomeProbability
        }
      : null,
    savedAt: new Date().toISOString(),
    snapshotHash: prediction.snapshotHash || null,
    asOfUtc: prediction.asOfUtc || null,
    predictionTimestampUtc: prediction.predictionTimestampUtc || null,
    calibrationVersion: prediction.calibrationVersion || null,
    calibrationArtifact: prediction.calibrationArtifact || null,
    runId: prediction.runId || null,
    snapshotPath: prediction.snapshotPath || null,
    versions: prediction.versions || null,
    newsContext: prediction.newsContext || null,
    featureSnapshot: prediction.featureSnapshot || null
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  return JSON.stringify(value ?? null);
}

// Normalize a feature-fallback payload (the Python FallbackTracker.summary())
// into { count, features } for storage. When the payload is absent we return
// nulls so historical/agent-only rows are not falsely marked as "0 fallbacks".
function normalizeFeatureFallbacks(value) {
  if (value === null || value === undefined) {
    return { count: null, features: null };
  }
  if (Array.isArray(value)) {
    return { count: value.length, features: value };
  }
  if (typeof value === 'object') {
    const features = Array.isArray(value.features) ? value.features : [];
    const count = Number.isInteger(value.count) ? value.count : features.length;
    return { count, features };
  }
  return { count: null, features: null };
}

function hashDecisionPayload(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

function ensureColumn(db, table, column, definitionSql) {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
  if (!columns.includes(column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definitionSql}`).run();
  }
}

function toInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolToInt(value) {
  return value ? 1 : 0;
}

function intToBool(value) {
  return Number(value) === 1;
}

function deriveBasePath(filePath) {
  const resolved = resolve(filePath);
  const extension = extname(resolved).toLowerCase();
  const baseName = basename(resolved, extension);
  return {
    directory: dirname(resolved),
    baseName,
    extension,
    resolved
  };
}

function resolveDatabasePath(filePath) {
  if (process.env.MLB_STORAGE_DB_PATH) {
    return resolve(process.env.MLB_STORAGE_DB_PATH);
  }

  const { directory, baseName, extension, resolved } = deriveBasePath(filePath);
  if (SQLITE_EXTENSIONS.has(extension)) return resolved;
  return resolve(directory, `${baseName}.sqlite`);
}

function resolveLegacyStatePath(filePath) {
  const { directory, baseName, extension, resolved } = deriveBasePath(filePath);
  if (SQLITE_EXTENSIONS.has(extension)) return resolve(directory, `${baseName}.json`);
  return resolved;
}

export class Storage {
  constructor(filePath = resolve(process.cwd(), 'data', 'state.json')) {
    this.filePath = resolveLegacyStatePath(filePath);
    this.dbPath = resolveDatabasePath(filePath);
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initializeSchema();
    this.migrateLegacyJsonOnFirstRun();
    this.state = this.read();
  }

  initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_settings (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        subscribed_at TEXT NOT NULL,
        auto_update_enabled INTEGER NOT NULL DEFAULT 0,
        daily_time TEXT NOT NULL DEFAULT '',
        last_sent_date TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS picks (
        game_pk TEXT PRIMARY KEY,
        date_ymd TEXT NOT NULL,
        status TEXT,
        matchup TEXT,
        away_team_id TEXT,
        home_team_id TEXT,
        pick_team_id TEXT,
        pick_confidence TEXT,
        pick_source TEXT,
        post_game_processed INTEGER NOT NULL DEFAULT 0,
        post_game_processed_at TEXT,
        saved_at TEXT,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS yrfi_results (
        game_pk TEXT PRIMARY KEY,
        date_ymd TEXT NOT NULL,
        pick TEXT,
        probability INTEGER,
        source TEXT,
        prediction_payload TEXT,
        actual_any_run INTEGER,
        actual_pick TEXT,
        correct INTEGER,
        processed_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (game_pk) REFERENCES picks(game_pk) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_summary (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 1,
        total_picks INTEGER NOT NULL DEFAULT 0,
        correct_picks INTEGER NOT NULL DEFAULT 0,
        wrong_picks INTEGER NOT NULL DEFAULT 0,
        by_confidence TEXT NOT NULL,
        first_inning TEXT NOT NULL,
        team_bias TEXT NOT NULL,
        matchup_memory TEXT NOT NULL DEFAULT '{}',
        learning_log TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bet_ledger (
        decision_id TEXT PRIMARY KEY,
        game_pk TEXT NOT NULL,
        date_ymd TEXT NOT NULL,
        market TEXT NOT NULL,
        team TEXT,
        side TEXT,
        line REAL,
        odds REAL,
        fair_prob REAL,
        model_prob REAL,
        edge REAL,
        units_staked REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        result TEXT,
        units_pl REAL,
        clv REAL,
        recommended_at TEXT NOT NULL,
        settled_at TEXT,
        UNIQUE(game_pk, market),
        FOREIGN KEY (game_pk) REFERENCES picks(game_pk) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS line_snapshots (
        game_pk TEXT NOT NULL,
        market TEXT NOT NULL,
        value REAL NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (game_pk, market)
      );

      CREATE TABLE IF NOT EXISTS line_alerts (
        alert_key TEXT PRIMARY KEY,
        game_pk TEXT NOT NULL,
        market TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      -- Per-game raw feature snapshots: an append-on-first-write store for
      -- discriminative inputs (umpire, platoon, statcast, closing line) captured
      -- pre-game so they can be joined to outcomes and backtested LATER. Keyed by
      -- (game_pk, feature_group); payload is JSON so new feature groups need no
      -- schema change. date_ymd is denormalized for cheap date-range backtests.
      CREATE TABLE IF NOT EXISTS feature_snapshots (
        game_pk TEXT NOT NULL,
        feature_group TEXT NOT NULL,
        date_ymd TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (game_pk, feature_group)
      );

      CREATE TABLE IF NOT EXISTS news_feed_cache (
        feed_url TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        fetched_at TEXT,
        expires_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_picks_date ON picks(date_ymd);
      CREATE INDEX IF NOT EXISTS idx_picks_post_game ON picks(post_game_processed);
      CREATE INDEX IF NOT EXISTS idx_yrfi_date ON yrfi_results(date_ymd);
      CREATE INDEX IF NOT EXISTS idx_bet_ledger_date ON bet_ledger(date_ymd);
      CREATE INDEX IF NOT EXISTS idx_bet_ledger_status ON bet_ledger(status);
      CREATE INDEX IF NOT EXISTS idx_line_snapshots_timestamp ON line_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_line_alerts_timestamp ON line_alerts(timestamp);
      CREATE INDEX IF NOT EXISTS idx_feature_snapshots_date ON feature_snapshots(date_ymd);

      CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_history_chat ON chat_history(chat_id, timestamp);
    `);

    const now = new Date().toISOString();
    const memoryColumns = this.db
      .prepare('PRAGMA table_info(memory_summary)')
      .all()
      .map((column) => column.name);
    if (!memoryColumns.includes('matchup_memory')) {
      this.db
        .prepare("ALTER TABLE memory_summary ADD COLUMN matchup_memory TEXT NOT NULL DEFAULT '{}'")
        .run();
    }

    const ledgerColumns = this.db
      .prepare('PRAGMA table_info(bet_ledger)')
      .all()
      .map((column) => column.name);
    if (!ledgerColumns.includes('line')) {
      this.db.prepare('ALTER TABLE bet_ledger ADD COLUMN line REAL').run();
    }
    // Feature-fallback visibility (Stage 3). Backward-compatible ALTERs so
    // historical rows are preserved. `feature_fallback_count` = number of
    // features that fell back to a generic default for that pick;
    // `fallback_features_used` = JSON array of the feature names that fell back.
    if (!ledgerColumns.includes('feature_fallback_count')) {
      this.db
        .prepare('ALTER TABLE bet_ledger ADD COLUMN feature_fallback_count INTEGER')
        .run();
    }
    if (!ledgerColumns.includes('fallback_features_used')) {
      this.db
        .prepare('ALTER TABLE bet_ledger ADD COLUMN fallback_features_used TEXT')
        .run();
    }

    // Immutable selection identity on legacy ledger (idempotent ALTERs).
    ensureColumn(this.db, 'bet_ledger', 'selected_team_id', 'TEXT');
    ensureColumn(this.db, 'bet_ledger', 'model_pick_team_id', 'TEXT');
    ensureColumn(this.db, 'bet_ledger', 'bookmaker', 'TEXT');
    ensureColumn(this.db, 'bet_ledger', 'quote_id', 'TEXT');
    ensureColumn(this.db, 'bet_ledger', 'decision_hash', 'TEXT');
    ensureColumn(this.db, 'bet_ledger', 'model_version', 'TEXT');
    ensureColumn(this.db, 'bet_ledger', 'calibration_version', 'TEXT');
    ensureColumn(this.db, 'bet_ledger', 'bet_policy_version', 'TEXT');
    ensureColumn(this.db, 'bet_ledger', 'run_id', 'TEXT');
    ensureColumn(this.db, 'bet_ledger', 'settlement_pending', 'INTEGER NOT NULL DEFAULT 0');

    const pickColumns = this.db
      .prepare('PRAGMA table_info(picks)')
      .all()
      .map((column) => column.name);
    if (!pickColumns.includes('feature_fallback_count')) {
      this.db.prepare('ALTER TABLE picks ADD COLUMN feature_fallback_count INTEGER').run();
    }
    if (!pickColumns.includes('fallback_features_used')) {
      this.db.prepare('ALTER TABLE picks ADD COLUMN fallback_features_used TEXT').run();
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_summary (
          id, version, total_picks, correct_picks, wrong_picks, by_confidence,
          first_inning, team_bias, matchup_memory, learning_log, updated_at
        ) VALUES (1, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        DEFAULT_STATE.memory.version,
        toJson(DEFAULT_STATE.memory.byConfidence),
        toJson(DEFAULT_STATE.memory.firstInning),
        toJson(DEFAULT_STATE.memory.teamBias),
        toJson(DEFAULT_STATE.memory.matchupMemory),
        toJson(DEFAULT_STATE.memory.learningLog),
        now
      );

    this.setMetaIfMissing('lastUpdateId', String(DEFAULT_STATE.lastUpdateId));
    this.setMetaIfMissing('lastAutoAlertDate', DEFAULT_STATE.lastAutoAlertDate);

    // Ordered immutable accounting migrations (prediction_runs, decisions, etc.).
    applyMigrations(this.db);
  }

  setMetaIfMissing(key, value) {
    this.db
      .prepare('INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, String(value ?? ''), new Date().toISOString());
  }

  getMeta(key, fallback = '') {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    return row?.value ?? fallback;
  }

  setMeta(key, value) {
    this.db
      .prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(key, String(value ?? ''), new Date().toISOString());
  }

  hasExistingSqlState() {
    const pickCount = this.db.prepare('SELECT COUNT(*) AS count FROM picks').get().count;
    const chatCount = this.db.prepare('SELECT COUNT(*) AS count FROM chat_settings').get().count;
    if (pickCount > 0 || chatCount > 0) return true;

    if (toInteger(this.getMeta('lastUpdateId', '0')) > 0) return true;
    if (this.getMeta('lastAutoAlertDate', '')) return true;

    const memory = this.readMemory();
    return (
      memory.totalPicks > 0 ||
      memory.correctPicks > 0 ||
      memory.wrongPicks > 0 ||
      Object.keys(memory.byConfidence || {}).length > 0 ||
      Object.keys(memory.teamBias || {}).length > 0 ||
      Object.keys(memory.matchupMemory || {}).length > 0 ||
      (memory.learningLog || []).length > 0
    );
  }

  migrateLegacyJsonOnFirstRun() {
    if (this.getMeta('legacyJsonMigrated', '') === '1') return;

    const now = new Date().toISOString();
    if (!existsSync(this.filePath) || this.hasExistingSqlState()) {
      this.setMeta('legacyJsonMigrated', '1');
      this.setMeta('legacyJsonMigratedAt', now);
      return;
    }

    try {
      const legacyState = normalizeState(JSON.parse(readFileSync(this.filePath, 'utf8')));
      this.replaceAllFromState(legacyState);
      this.setMeta('legacyJsonMigrated', '1');
      this.setMeta('legacyJsonMigratedAt', now);
      this.setMeta('legacyJsonPath', this.filePath);
    } catch (error) {
      this.setMeta('legacyJsonMigrated', '1');
      this.setMeta('legacyJsonMigratedAt', now);
      this.setMeta('legacyJsonMigrationError', error?.message || 'Unknown migration error');
    }
  }

  replaceAllFromState(state) {
    const normalized = normalizeState(state);
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM yrfi_results').run();
      this.db.prepare('DELETE FROM bet_ledger').run();
      this.db.prepare('DELETE FROM pick_processing').run();
      this.db.prepare('DELETE FROM picks').run();
      this.db.prepare('DELETE FROM chat_settings').run();

      this.setMeta('lastUpdateId', normalized.lastUpdateId || 0);
      this.setMeta('lastAutoAlertDate', normalized.lastAutoAlertDate || '');
      this.writeMemory(normalized.memory);

      for (const subscriber of Object.values(normalized.subscribers || {})) {
        this.writeSubscriber(subscriber);
      }

      for (const prediction of Object.values(normalized.predictions || {})) {
        this.writePredictionRow(prediction);
      }
    });

    replace();
  }

  read() {
    const subscribers = {};
    for (const row of this.db.prepare('SELECT * FROM chat_settings ORDER BY chat_id').all()) {
      const subscriber = this.subscriberFromRow(row);
      subscribers[String(subscriber.id)] = subscriber;
    }

    const predictions = {};
    const latestRows = this.db
      .prepare(
        `SELECT p.*, pp.post_game_processed AS processing_post_game_processed,
                pp.post_game_processed_at AS processing_post_game_processed_at
         FROM picks p
         LEFT JOIN pick_processing pp ON pp.game_pk = p.game_pk
         WHERE p.prediction_version = (
           SELECT MAX(p2.prediction_version) FROM picks p2 WHERE p2.game_pk = p.game_pk
         )
         ORDER BY p.date_ymd, p.game_pk`
      )
      .all();
    for (const row of latestRows) {
      const prediction = this.predictionFromRow(row);
      predictions[String(prediction.gamePk)] = prediction;
    }

    return normalizeState({
      lastUpdateId: toInteger(this.getMeta('lastUpdateId', '0')),
      lastAutoAlertDate: this.getMeta('lastAutoAlertDate', ''),
      subscribers,
      predictions,
      memory: this.readMemory()
    });
  }

  refreshState() {
    this.state = this.read();
    return this.state;
  }

  save() {
    this.replaceAllFromState(this.state || DEFAULT_STATE);
    this.refreshState();
  }

  close() {
    this.db.close();
  }

  readMemory() {
    const row = this.db.prepare('SELECT * FROM memory_summary WHERE id = 1').get();
    if (!row) return normalizeState(DEFAULT_STATE).memory;

    return normalizeState({
      memory: {
        version: row.version || DEFAULT_STATE.memory.version,
        totalPicks: row.total_picks || 0,
        correctPicks: row.correct_picks || 0,
        wrongPicks: row.wrong_picks || 0,
        byConfidence: parseJson(row.by_confidence, {}),
        firstInning: parseJson(row.first_inning, DEFAULT_STATE.memory.firstInning),
        teamBias: parseJson(row.team_bias, {}),
        matchupMemory: parseJson(row.matchup_memory, {}),
        learningLog: parseJson(row.learning_log, [])
      }
    }).memory;
  }

  writeMemory(memory) {
    const normalized = normalizeState({ memory }).memory;
    this.db
      .prepare(
        `INSERT INTO memory_summary (
          id, version, total_picks, correct_picks, wrong_picks, by_confidence,
          first_inning, team_bias, matchup_memory, learning_log, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version,
          total_picks = excluded.total_picks,
          correct_picks = excluded.correct_picks,
          wrong_picks = excluded.wrong_picks,
          by_confidence = excluded.by_confidence,
          first_inning = excluded.first_inning,
          team_bias = excluded.team_bias,
          matchup_memory = excluded.matchup_memory,
          learning_log = excluded.learning_log,
          updated_at = excluded.updated_at`
      )
      .run(
        normalized.version || 1,
        normalized.totalPicks || 0,
        normalized.correctPicks || 0,
        normalized.wrongPicks || 0,
        toJson(normalized.byConfidence),
        toJson(normalized.firstInning),
        toJson(normalized.teamBias),
        toJson(normalized.matchupMemory),
        toJson(normalized.learningLog),
        new Date().toISOString()
      );
  }

  subscriberFromRow(row) {
    const payload = parseJson(row.payload, {});
    const numericId = Number(row.chat_id);
    const id =
      payload.id !== undefined
        ? payload.id
        : Number.isSafeInteger(numericId)
          ? numericId
          : row.chat_id;

    return normalizeSubscriber({
      ...payload,
      id,
      title: row.title || payload.title || String(id),
      subscribedAt: row.subscribed_at || payload.subscribedAt || new Date().toISOString(),
      autoUpdate: {
        enabled: intToBool(row.auto_update_enabled),
        dailyTime: row.daily_time || '',
        lastSentDate: row.last_sent_date || ''
      }
    });
  }

  readSubscriber(chatId) {
    const row = this.db.prepare('SELECT * FROM chat_settings WHERE chat_id = ?').get(String(chatId));
    return row ? this.subscriberFromRow(row) : null;
  }

  writeSubscriber(subscriber) {
    const normalized = normalizeSubscriber(subscriber);
    const chatId = String(normalized.id);
    const autoUpdate = {
      ...DEFAULT_AUTO_UPDATE,
      ...(normalized.autoUpdate || {})
    };
    const payload = {
      ...normalized,
      autoUpdate,
      lineMovementAlerts: {
        ...DEFAULT_LINE_MOVEMENT_ALERTS,
        ...(normalized.lineMovementAlerts || {})
      }
    };

    this.db
      .prepare(
        `INSERT INTO chat_settings (
          chat_id, title, subscribed_at, auto_update_enabled, daily_time,
          last_sent_date, payload, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          title = excluded.title,
          subscribed_at = excluded.subscribed_at,
          auto_update_enabled = excluded.auto_update_enabled,
          daily_time = excluded.daily_time,
          last_sent_date = excluded.last_sent_date,
          payload = excluded.payload,
          updated_at = excluded.updated_at`
      )
      .run(
        chatId,
        normalized.title || chatId,
        normalized.subscribedAt || new Date().toISOString(),
        boolToInt(autoUpdate.enabled),
        autoUpdate.dailyTime || '',
        autoUpdate.lastSentDate || '',
        toJson(payload),
        new Date().toISOString()
      );
  }

  predictionFromRow(row) {
    const prediction = parseJson(row.payload, {});
    return {
      ...prediction,
      gamePk: prediction.gamePk ?? row.game_pk,
      dateYmd: prediction.dateYmd ?? row.date_ymd,
      status: prediction.status ?? row.status,
      matchup: prediction.matchup ?? row.matchup,
      predictionRunId: prediction.predictionRunId ?? row.prediction_run_id ?? null,
      predictionVersion: prediction.predictionVersion ?? row.prediction_version ?? null,
      modelVersion: prediction.modelVersion ?? row.model_version ?? null,
      featureVersion: prediction.featureVersion ?? row.feature_version ?? null,
      calibrationVersion: prediction.calibrationVersion ?? row.calibration_version ?? null,
      betPolicyVersion: prediction.betPolicyVersion ?? row.bet_policy_version ?? null,
      snapshotHash: prediction.snapshotHash ?? row.snapshot_hash ?? null,
      payloadHash: prediction.payloadHash ?? row.payload_hash ?? null,
      postGameProcessed: intToBool(
        row.processing_post_game_processed ?? row.post_game_processed
      ),
      postGameProcessedAt:
        row.processing_post_game_processed_at ?? row.post_game_processed_at ?? null
    };
  }

  writePredictionRow(prediction) {
    const gamePk = String(prediction.gamePk);
    const now = new Date().toISOString();
    const fallback = normalizeFeatureFallbacks(prediction.featureFallbacks);
    const predictionRunId = String(prediction.predictionRunId || randomUUID());
    const latestVersion = this.db
      .prepare('SELECT COALESCE(MAX(prediction_version), 0) AS value FROM picks WHERE game_pk = ?')
      .get(gamePk)?.value;
    const predictionVersion = Number(latestVersion || 0) + 1;
    const normalizedPrediction = {
      ...prediction,
      predictionRunId,
      predictionVersion,
      postGameProcessed: false,
      postGameProcessedAt: null
    };
    const hashPayload = toJson(normalizedPrediction);
    const payloadHash = createHash('sha256').update(hashPayload).digest('hex');
    normalizedPrediction.payloadHash = payloadHash;
    const payload = toJson(normalizedPrediction);

    this.db
      .prepare(
        `INSERT INTO picks (
          prediction_run_id, game_pk, prediction_version, run_id,
          model_version, feature_version, calibration_version, bet_policy_version,
          snapshot_hash, payload_hash, date_ymd, status, matchup,
          away_team_id, home_team_id, pick_team_id, pick_confidence, pick_source,
          post_game_processed, post_game_processed_at, saved_at, payload, updated_at,
          feature_fallback_count, fallback_features_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        predictionRunId,
        gamePk,
        predictionVersion,
        normalizedPrediction.runId || null,
        normalizedPrediction.modelVersion || normalizedPrediction.versions?.model || null,
        normalizedPrediction.featureVersion || normalizedPrediction.versions?.feature || null,
        normalizedPrediction.calibrationVersion || normalizedPrediction.versions?.calibration || null,
        normalizedPrediction.betPolicyVersion || normalizedPrediction.versions?.betPolicy || null,
        normalizedPrediction.snapshotHash || null,
        payloadHash,
        normalizedPrediction.dateYmd || '',
        normalizedPrediction.status || '',
        normalizedPrediction.matchup || '',
        normalizedPrediction.away?.id !== undefined ? String(normalizedPrediction.away.id) : null,
        normalizedPrediction.home?.id !== undefined ? String(normalizedPrediction.home.id) : null,
        normalizedPrediction.pick?.id !== undefined ? String(normalizedPrediction.pick.id) : null,
        normalizedPrediction.pick?.confidence || '',
        normalizedPrediction.pick?.source || '',
        normalizedPrediction.savedAt || now,
        payload,
        now,
        fallback.count,
        fallback.features === null ? null : toJson(fallback.features)
      );

    this.db
      .prepare(
        `INSERT INTO pick_processing (
          game_pk, prediction_run_id, post_game_processed, post_game_processed_at, updated_at
        ) VALUES (?, ?, 0, NULL, ?)
        ON CONFLICT(game_pk) DO UPDATE SET
          prediction_run_id = excluded.prediction_run_id,
          updated_at = excluded.updated_at
        WHERE pick_processing.post_game_processed = 0`
      )
      .run(gamePk, predictionRunId, now);

    // YRFI/NRFI market removed — yrfi_results table retained for historical data but no longer written to or read. See migration note.

    prediction.predictionRunId = predictionRunId;
    prediction.predictionVersion = predictionVersion;
    prediction.payloadHash = payloadHash;
  }

  getLastUpdateId() {
    return toInteger(this.getMeta('lastUpdateId', '0'));
  }

  setLastUpdateId(updateId) {
    this.setMeta('lastUpdateId', updateId || 0);
    this.refreshState();
  }

  addSubscriber(chat, options = {}) {
    const key = String(chat.id);
    const existing = this.readSubscriber(key) || {};
    const subscriber = normalizeSubscriber({
      ...existing,
      id: chat.id,
      title: chat.title || chat.username || chat.first_name || String(chat.id),
      subscribedAt: existing.subscribedAt || new Date().toISOString(),
      autoUpdate: {
        ...(existing.autoUpdate || {}),
        ...(options.autoUpdate || {})
      }
    });

    this.writeSubscriber(subscriber);
    this.refreshState();
  }

  removeSubscriber(chatId) {
    this.db.prepare('DELETE FROM chat_settings WHERE chat_id = ?').run(String(chatId));
    this.refreshState();
  }

  listSubscriberIds() {
    return this.db
      .prepare('SELECT chat_id FROM chat_settings ORDER BY chat_id')
      .all()
      .map((row) => row.chat_id);
  }

  getSubscriber(chatId) {
    return this.readSubscriber(chatId);
  }

  setAutoUpdate(chat, updates = {}) {
    const key = String(chat.id);
    const existing =
      this.readSubscriber(key) ||
      normalizeSubscriber({
        id: chat.id,
        title: chat.title || chat.username || chat.first_name || String(chat.id),
        subscribedAt: new Date().toISOString()
      });

    const subscriber = normalizeSubscriber({
      ...existing,
      id: chat.id,
      title: existing.title || chat.title || chat.username || chat.first_name || String(chat.id),
      autoUpdate: {
        ...DEFAULT_AUTO_UPDATE,
        ...(existing.autoUpdate || {}),
        ...updates
      }
    });

    this.writeSubscriber(subscriber);
    this.refreshState();
  }

  getAutoUpdate(chatId) {
    const subscriber = this.readSubscriber(chatId);
    return {
      ...DEFAULT_AUTO_UPDATE,
      ...(subscriber?.autoUpdate || {})
    };
  }

  setLineMovementAlerts(chat, updates = {}) {
    const key = String(chat.id);
    const existing =
      this.readSubscriber(key) ||
      normalizeSubscriber({
        id: chat.id,
        title: chat.title || chat.username || chat.first_name || String(chat.id),
        subscribedAt: new Date().toISOString()
      });

    const subscriber = normalizeSubscriber({
      ...existing,
      id: chat.id,
      title: existing.title || chat.title || chat.username || chat.first_name || String(chat.id),
      lineMovementAlerts: {
        ...DEFAULT_LINE_MOVEMENT_ALERTS,
        ...(existing.lineMovementAlerts || {}),
        ...updates
      }
    });

    this.writeSubscriber(subscriber);
    this.refreshState();
  }

  getLineMovementAlerts(chatId) {
    const subscriber = this.readSubscriber(chatId);
    return {
      ...DEFAULT_LINE_MOVEMENT_ALERTS,
      ...(subscriber?.lineMovementAlerts || {})
    };
  }

  listAutoUpdateTargets(defaultDailyTime = '20:00') {
    return this.db
      .prepare('SELECT * FROM chat_settings WHERE auto_update_enabled = 1 ORDER BY chat_id')
      .all()
      .map((row) => ({
        chatId: row.chat_id,
        title: row.title || row.chat_id,
        dailyTime: row.daily_time || defaultDailyTime,
        lastSentDate: row.last_sent_date || ''
      }));
  }

  setAutoUpdateLastSent(chatId, dateYmd) {
    const subscriber = this.readSubscriber(chatId);
    if (!subscriber) return;

    subscriber.autoUpdate = {
      ...DEFAULT_AUTO_UPDATE,
      ...(subscriber.autoUpdate || {}),
      lastSentDate: dateYmd
    };
    this.writeSubscriber(subscriber);
    this.refreshState();
  }

  getLastAutoAlertDate() {
    return this.getMeta('lastAutoAlertDate', '');
  }

  setLastAutoAlertDate(dateYmd) {
    this.setMeta('lastAutoAlertDate', dateYmd || '');
    this.refreshState();
  }

  /**
   * Capture an immutable decision snapshot for a prediction (best-effort).
   * Writes feature_snapshots + optional JSON file under data/prediction_snapshots.
   * Never throws into the live path.
   */
  capturePredictionSnapshot(prediction, dateYmd = prediction?.dateYmd || '') {
    try {
      if (!prediction?.gamePk) return null;

      // Immutable first-write semantics: a refresh must reuse the original
      // prediction_decision_snapshot, not mint a new as_of/hash for the same game.
      const existingFeature = this.db
        .prepare(
          `SELECT payload FROM feature_snapshots
           WHERE game_pk = ? AND feature_group = 'prediction_decision_snapshot'`
        )
        .get(String(prediction.gamePk));
      if (existingFeature?.payload) {
        const stored = parseJson(existingFeature.payload, {});
        if (stored.snapshotHash) {
          prediction.snapshotHash = stored.snapshotHash;
          prediction.asOfUtc = stored.asOfUtc || prediction.asOfUtc || null;
          prediction.predictionTimestampUtc =
            stored.predictionTimestampUtc || prediction.predictionTimestampUtc || prediction.asOfUtc || null;
          prediction.calibrationVersion =
            stored.versions?.calibrationVersion || prediction.calibrationVersion || null;
          // Reuse the immutable first-write core inputs and artifact on refresh.
          // Never let a later mutable prediction overwrite the replay authority.
          if (stored.coreInputs) prediction.coreInputs = stored.coreInputs;
          if (stored.features) prediction.featureSnapshot = stored.features;
          if (stored.calibrationArtifact) prediction.calibrationArtifact = stored.calibrationArtifact;
          if (!prediction.versions) prediction.versions = {};
          prediction.versions.calibration = prediction.calibrationVersion;
          return stored;
        }
      }

      const cal = getCalibrationArtifact('moneyline');
      // Frozen artifact (with mapping) so replay reconstructs the exact map.
      const frozenCal = freezeCalibrationArtifact('moneyline');
      prediction.calibrationArtifact = frozenCal;
      const asOfUtc = new Date().toISOString();
      const snapshot = buildPredictionSnapshot({
        prediction,
        dateYmd,
        asOfUtc,
        predictionTimestampUtc: asOfUtc,
        firstPitchUtc: prediction.startTime || null,
        versions: {
          modelVersion: prediction.modelVersion || prediction.versions?.model || 'mlb-js-live',
          featureVersion: prediction.featureVersion || prediction.versions?.feature || 'live-features',
          calibrationVersion: cal.calibrationVersion,
          betPolicyVersion: prediction.betPolicyVersion || prediction.versions?.betPolicy || 'value-v1'
        },
        coreInputs: prediction.coreInputs || null,
        features: prediction.featureSnapshot || null,
        calibrationArtifact: frozenCal
      });

      prediction.snapshotHash = snapshot.snapshotHash;
      prediction.asOfUtc = snapshot.asOfUtc;
      prediction.predictionTimestampUtc = snapshot.predictionTimestampUtc;
      prediction.calibrationVersion = cal.calibrationVersion;
      prediction.calibrationArtifact = cal;
      if (!prediction.versions) prediction.versions = {};
      prediction.versions.calibration = cal.calibrationVersion;

      // Write-once feature snapshot group for later replay joins.
      this.setFeatureSnapshot(
        prediction.gamePk,
        'prediction_decision_snapshot',
        dateYmd,
        {
          snapshotHash: snapshot.snapshotHash,
          asOfUtc: snapshot.asOfUtc,
          predictionTimestampUtc: snapshot.predictionTimestampUtc,
          firstPitchUtc: snapshot.firstPitchUtc,
          versions: snapshot.versions,
          decisionInputs: snapshot.decisionInputs,
          modelInputs: snapshot.modelInputs,
          quotes: snapshot.quotes,
          coreInputs: snapshot.coreInputs,
          features: snapshot.features,
          calibration: frozenCal,
          calibrationArtifact: snapshot.calibrationArtifact
        },
        { overwrite: false, timestamp: asOfUtc }
      );

      // Best-effort file capture for offline replay tooling.
      try {
        const snapDir = resolve(dirname(this.dbPath), 'prediction_snapshots', String(dateYmd || 'unknown'));
        const snapPath = resolve(snapDir, `${prediction.gamePk}-${snapshot.snapshotHash.slice(0, 12)}.json`);
        writeSnapshotFile(snapPath, snapshot);
        prediction.snapshotPath = snapPath;
      } catch {
        // disk full / permissions — feature_snapshots row is enough for join
      }

      // Immutable prediction_runs row when migrations are present.
      try {
        const runId = `run-${prediction.gamePk}-${snapshot.snapshotHash.slice(0, 16)}`;
        prediction.runId = prediction.runId || runId;
        this.db
          .prepare(
            `INSERT INTO prediction_runs (
              run_id, game_pk, market, date_ymd, prediction_timestamp_utc, as_of_utc,
              first_pitch_utc, model_version, feature_version, calibration_version,
              bet_policy_version, snapshot_hash, payload, created_at
            ) VALUES (?, ?, 'moneyline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO NOTHING`
          )
          .run(
            prediction.runId,
            String(prediction.gamePk),
            dateYmd || null,
            snapshot.predictionTimestampUtc,
            snapshot.asOfUtc,
            snapshot.firstPitchUtc,
            snapshot.versions.modelVersion,
            snapshot.versions.featureVersion,
            snapshot.versions.calibrationVersion,
            snapshot.versions.betPolicyVersion,
            snapshot.snapshotHash,
            toJson({
              valuePick: prediction.valuePick || null,
              betDecision: prediction.betDecision || null,
              snapshotPath: prediction.snapshotPath || null
            }),
            asOfUtc
          );
      } catch {
        // table may be missing on partial fixtures
      }

      return snapshot;
    } catch (error) {
      console.error('capturePredictionSnapshot failed:', error?.message || error);
      return null;
    }
  }

  savePredictions(dateYmd, predictions) {
    const saveRows = this.db.transaction(() => {
      for (const prediction of predictions) {
        if (String(prediction.status).toLowerCase().includes('final')) continue;

        const key = String(prediction.gamePk);
        const existing = this.getPrediction(key) || {};
        prediction.predictionRunId = randomUUID();
        // Freeze decision inputs before compacting mutable display fields.
        this.capturePredictionSnapshot(prediction, dateYmd);
        const compact = compactPrediction(prediction, dateYmd);
        compact.snapshotHash = prediction.snapshotHash || existing.snapshotHash || null;
        compact.asOfUtc = prediction.asOfUtc || existing.asOfUtc || null;
        compact.calibrationVersion =
          prediction.calibrationVersion || existing.calibrationVersion || null;
        compact.runId = prediction.runId || existing.runId || null;
        compact.predictionRunId = prediction.predictionRunId;
        // Keep latest display-only news context while immutable featureSnapshot
        // remains first-write authority restored by capturePredictionSnapshot.
        compact.newsContext = prediction.newsContext || existing.newsContext || null;
        if (!compact.openingOdds && existing.openingOdds) {
          compact.openingOdds = existing.openingOdds;
        } else if (!compact.openingOdds && compact.currentOdds) {
          compact.openingOdds = { ...compact.currentOdds, savedAt: new Date().toISOString() };
        } else if (!compact.openingOdds) {
          // Live Odds API often fails to match, leaving currentOdds null. Fall
          // back to the write-once opening_* line snapshots so moneyline CLV can
          // still be computed (opening implied vs closing implied).
          const openingOdds = this.openingOddsFromSnapshots(key);
          if (openingOdds) compact.openingOdds = openingOdds;
        }
        this.writePredictionRow({
          ...compact,
          postGameProcessed: existing.postGameProcessed || false,
          postGameProcessedAt: existing.postGameProcessedAt || null
        });
      }
    });

    saveRows();
    this.refreshState();
  }

  latestPickRow(gamePk) {
    return this.db
      .prepare(
        `SELECT p.*, pp.post_game_processed AS processing_post_game_processed,
                pp.post_game_processed_at AS processing_post_game_processed_at
         FROM picks p
         LEFT JOIN pick_processing pp ON pp.game_pk = p.game_pk
         WHERE p.game_pk = ?
         ORDER BY p.prediction_version DESC, p.saved_at DESC
         LIMIT 1`
      )
      .get(String(gamePk));
  }

  getPrediction(gamePk) {
    const row = this.latestPickRow(gamePk);
    return row ? this.predictionFromRow(row) : null;
  }

  listPredictionsByDate(dateYmd) {
    return this.db
      .prepare(
        `SELECT p.*, pp.post_game_processed AS processing_post_game_processed,
                pp.post_game_processed_at AS processing_post_game_processed_at
         FROM picks p
         LEFT JOIN pick_processing pp ON pp.game_pk = p.game_pk
         WHERE p.date_ymd = ?
           AND p.prediction_version = (
             SELECT MAX(p2.prediction_version) FROM picks p2 WHERE p2.game_pk = p.game_pk
           )
         ORDER BY p.game_pk`
      )
      .all(String(dateYmd || ''))
      .map((row) => this.predictionFromRow(row));
  }

  // Predictions stored on or after a date string. Used by closing-line capture,
  // which must NOT scope to a single timezone-derived day.
  listPredictionsSinceDate(dateYmd) {
    return this.db
      .prepare(
        `SELECT p.*, pp.post_game_processed AS processing_post_game_processed,
                pp.post_game_processed_at AS processing_post_game_processed_at
         FROM picks p
         LEFT JOIN pick_processing pp ON pp.game_pk = p.game_pk
         WHERE p.date_ymd >= ?
           AND p.prediction_version = (
             SELECT MAX(p2.prediction_version) FROM picks p2 WHERE p2.game_pk = p.game_pk
           )
         ORDER BY p.date_ymd, p.game_pk`
      )
      .all(String(dateYmd || ''))
      .map((row) => this.predictionFromRow(row));
  }

  getLineSnapshot(gamePk, market) {
    const row = this.db
      .prepare(
        `SELECT game_pk AS gamePk, market, value, timestamp
         FROM line_snapshots
         WHERE game_pk = ? AND market = ?`
      )
      .get(String(gamePk), String(market));

    return row || null;
  }

  hasClosingLine(gamePk) {
    return this.getLineSnapshot(gamePk, 'closing_home') !== null;
  }

  openingOddsFromSnapshots(gamePk) {
    if (!gamePk) return null;
    const plausibleMoneyline = (value) => Number.isFinite(value) && Math.abs(value) >= 100 && Math.abs(value) <= 1000;
    const plausibleTotal = (value) => Number.isFinite(value) && value >= 4 && value <= 14;
    const read = (market) => {
      const snapshot = this.getLineSnapshot(gamePk, market);
      return snapshot ? Number(snapshot.value) : NaN;
    };
    const home = read('opening_home');
    const away = read('opening_away');
    const total = read('opening_total');
    if (!plausibleMoneyline(home) && !plausibleMoneyline(away)) return null;
    return {
      homeMoneyline: plausibleMoneyline(home) ? home : null,
      awayMoneyline: plausibleMoneyline(away) ? away : null,
      totalLine: plausibleTotal(total) ? total : null,
      moneylineBook: 'snapshot-open',
      source: 'line_snapshots',
      savedAt: new Date().toISOString()
    };
  }

  setLineSnapshot(gamePk, market, value, timestamp = new Date().toISOString()) {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) return;

    this.db
      .prepare(
        `INSERT INTO line_snapshots (game_pk, market, value, timestamp)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(game_pk, market) DO UPDATE SET
           value = excluded.value,
           timestamp = excluded.timestamp`
      )
      .run(String(gamePk), String(market), parsedValue, timestamp);

    // Freeze the first-seen moneyline/total as the OPENING line (write-once).
    // Live moneyline_*/total rows get overwritten every poll, so without this
    // the opening price is lost and moneyline CLV can't be computed. INSERT OR
    // IGNORE keeps only the earliest value.
    const openingMarket = {
      moneyline_home: 'opening_home',
      moneyline_away: 'opening_away',
      total: 'opening_total'
    }[String(market)];
    if (openingMarket) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO line_snapshots (game_pk, market, value, timestamp)
           VALUES (?, ?, ?, ?)`
        )
        .run(String(gamePk), openingMarket, parsedValue, timestamp);
    }
  }

  // Write-once per (game_pk, feature_group): the first pre-game capture is the
  // one we want to validate against later, so re-runs don't overwrite it. Pass
  // overwrite=true only for features that legitimately refresh (e.g. closing
  // line moving toward first pitch). payload is any JSON-serializable object.
  setFeatureSnapshot(gamePk, featureGroup, dateYmd, payload, { overwrite = false, timestamp = new Date().toISOString() } = {}) {
    const pk = String(gamePk || '');
    const group = String(featureGroup || '');
    if (!pk || !group) return false;
    let serialized;
    try {
      serialized = JSON.stringify(payload ?? null);
    } catch {
      return false;
    }
    const sql = overwrite
      ? `INSERT INTO feature_snapshots (game_pk, feature_group, date_ymd, payload, timestamp)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(game_pk, feature_group) DO UPDATE SET
           date_ymd = excluded.date_ymd,
           payload = excluded.payload,
           timestamp = excluded.timestamp`
      : `INSERT OR IGNORE INTO feature_snapshots (game_pk, feature_group, date_ymd, payload, timestamp)
         VALUES (?, ?, ?, ?, ?)`;
    const result = this.db.prepare(sql).run(pk, group, String(dateYmd || ''), serialized, timestamp);
    return result.changes > 0;
  }

  getNewsFeedCache(feedUrl) {
    const row = this.db
      .prepare(
        `SELECT feed_url AS feedUrl, source, payload, fetched_at AS fetchedAt,
                expires_at AS expiresAt, last_error AS lastError, updated_at AS updatedAt
         FROM news_feed_cache WHERE feed_url = ?`
      )
      .get(String(feedUrl || ''));
    if (!row) return null;
    return { ...row, payload: parseJson(row.payload, []) };
  }

  setNewsFeedCache(feedUrl, payload, { source = 'unknown', fetchedAt = null, expiresAt = null, lastError = null } = {}) {
    const url = String(feedUrl || '');
    if (!url) return false;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO news_feed_cache (feed_url, source, payload, fetched_at, expires_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(feed_url) DO UPDATE SET
           source = excluded.source,
           payload = excluded.payload,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      )
      .run(url, String(source || 'unknown'), toJson(payload || []), fetchedAt, expiresAt, lastError, now);
    return true;
  }

  getFeatureSnapshot(gamePk, featureGroup) {
    const row = this.db
      .prepare(
        `SELECT game_pk AS gamePk, feature_group AS featureGroup, date_ymd AS dateYmd, payload, timestamp
         FROM feature_snapshots
         WHERE game_pk = ? AND feature_group = ?`
      )
      .get(String(gamePk), String(featureGroup));
    if (!row) return null;
    try {
      row.payload = JSON.parse(row.payload);
    } catch {
      row.payload = null;
    }
    return row;
  }

  listFeatureSnapshotsByDate(dateYmd, featureGroup = null) {
    const rows = featureGroup
      ? this.db
          .prepare(
            `SELECT game_pk AS gamePk, feature_group AS featureGroup, date_ymd AS dateYmd, payload, timestamp
             FROM feature_snapshots WHERE date_ymd = ? AND feature_group = ? ORDER BY game_pk`
          )
          .all(String(dateYmd), String(featureGroup))
      : this.db
          .prepare(
            `SELECT game_pk AS gamePk, feature_group AS featureGroup, date_ymd AS dateYmd, payload, timestamp
             FROM feature_snapshots WHERE date_ymd = ? ORDER BY game_pk`
          )
          .all(String(dateYmd));
    for (const row of rows) {
      try {
        row.payload = JSON.parse(row.payload);
      } catch {
        row.payload = null;
      }
    }
    return rows;
  }

  reserveLineAlert(alertKey, movement, chatId, timestamp = new Date().toISOString(), ttlHours = 18) {
    const key = String(alertKey || '');
    if (!key) return false;

    const cutoff = new Date(Date.now() - Math.max(1, Number(ttlHours) || 18) * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM line_alerts WHERE timestamp < ?').run(cutoff);

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO line_alerts (alert_key, game_pk, market, chat_id, payload, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        key,
        String(movement?.gamePk || ''),
        String(movement?.storageMarket || movement?.market || ''),
        String(chatId || ''),
        toJson(movement || {}),
        timestamp
      );

    return result.changes === 1;
  }

  // Durable dedupe for lineup-confirmed pre-game alerts. Reuses the line_alerts
  // table since the contract is identical: at-most-once delivery per
  // (chatId, gamePk) pair, with TTL cleanup.
  reserveLineupAlert(chatId, gamePk, timestamp = new Date().toISOString(), ttlHours = 24) {
    const chat = String(chatId || '');
    const game = String(gamePk || '');
    if (!chat || !game) return false;
    const key = `lineup-both:${chat}:${game}`;
    return this.reserveLineAlert(
      key,
      { gamePk: game, market: 'lineup_both_confirmed' },
      chat,
      timestamp,
      ttlHours
    );
  }

  listPendingPredictionDates() {
    return this.db
      .prepare(
        `SELECT DISTINCT p.date_ymd
         FROM picks p
         JOIN pick_processing pp ON pp.game_pk = p.game_pk
         WHERE pp.post_game_processed = 0 AND p.date_ymd <> ''
         ORDER BY p.date_ymd`
      )
      .all()
      .map((row) => row.date_ymd);
  }

  markPostGameProcessed(gamePk) {
    this.markPostGameProcessedRow(gamePk);
    this.refreshState();
  }

  markPostGameProcessedRow(gamePk) {
    const row = this.latestPickRow(gamePk);
    if (!row) return;

    const processedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE pick_processing
         SET post_game_processed = 1,
             post_game_processed_at = ?,
             updated_at = ?
         WHERE game_pk = ? AND post_game_processed = 0`
      )
      .run(processedAt, processedAt, String(gamePk));
  }

  getMemory() {
    const memory = this.readMemory();
    if (this.state) this.state.memory = memory;
    return memory;
  }

  getMemorySummary() {
    const memory = this.readMemory();
    const accuracy =
      memory.totalPicks > 0 ? Math.round((memory.correctPicks / memory.totalPicks) * 100) : 0;
    const firstInningAccuracy =
      memory.firstInning.totalPicks > 0
        ? Math.round((memory.firstInning.correctPicks / memory.firstInning.totalPicks) * 100)
        : 0;

    return {
      totalPicks: memory.totalPicks,
      correctPicks: memory.correctPicks,
      wrongPicks: memory.wrongPicks,
      accuracy,
      byConfidence: memory.byConfidence,
      firstInning: {
        ...memory.firstInning,
        accuracy: firstInningAccuracy
      },
      matchupMemory: {
        totalMatchups: Object.keys(memory.matchupMemory || {}).length,
        recent: Object.values(memory.matchupMemory || {})
          .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
          .slice(0, 5)
          .map((entry) => ({
            key: entry.key,
            teams: entry.teams,
            totalGames: entry.totalGames,
            currentStreak: entry.currentStreak,
            alternating: entry.alternating,
            averageMargin: entry.averageMargin,
            pickStats: entry.pickStats,
            note: entry.note
          }))
      },
      recentLog: memory.learningLog.slice(0, 5)
    };
  }

  recordOutcome(prediction, result, { enabled = true } = {}) {
    const updateOutcome = this.db.transaction(() => {
      const correct = prediction.pick.id === result.winner.id;
      const actualFirstInningRun = result.firstInning?.anyRun;
      const memory = this.readMemory();

      memory.totalPicks += 1;
      if (correct) memory.correctPicks += 1;
      if (!correct) memory.wrongPicks += 1;

      const confidence = prediction.pick.confidence || 'unknown';
      if (!memory.byConfidence[confidence]) {
        memory.byConfidence[confidence] = { total: 0, correct: 0 };
      }
      memory.byConfidence[confidence].total += 1;
      if (correct) memory.byConfidence[confidence].correct += 1;

      let firstInningCorrect = null;
      // YRFI/NRFI market removed — firstInning grading block never fires
      // (prediction.firstInning is always undefined). Retained as null for
      // learningLog/matchup-memory shape compatibility.

      if (enabled) {
        const winnerKey = String(result.winner.id);
        const loserKey = String(result.loser.id);
        const pickKey = String(prediction.pick.id);

        // When correct: small reinforcement for winner, small penalty for loser.
        // When wrong: penalize the PREDICTED team more (model was wrong about them),
        // give the ACTUAL winner only a small bump (they earned it but don't over-reward).
        const winnerBump = correct ? 0.002 : 0.002;
        const loserDrop = correct ? 0.001 : 0.004;
        memory.teamBias[winnerKey] = clamp(
          (memory.teamBias[winnerKey] || 0) + winnerBump,
          -TEAM_BIAS_LIMIT,
          TEAM_BIAS_LIMIT
        );
        memory.teamBias[loserKey] = clamp(
          (memory.teamBias[loserKey] || 0) - loserDrop,
          -TEAM_BIAS_LIMIT,
          TEAM_BIAS_LIMIT
        );

        // Extra penalty on the predicted team when the model was wrong
        if (!correct) {
          memory.teamBias[pickKey] = clamp(
            (memory.teamBias[pickKey] || 0) - 0.006,
            -TEAM_BIAS_LIMIT,
            TEAM_BIAS_LIMIT
          );
        }
      }

      const matchupMemory = updateMatchupMemory(memory, prediction, result, correct, firstInningCorrect);

      memory.learningLog.unshift({
        at: new Date().toISOString(),
        gamePk: prediction.gamePk,
        matchup: prediction.matchup,
        pick: prediction.pick.name,
        pickProbability: prediction.pick.winProbability,
        winner: result.winner.name,
        score: `${result.away.abbreviation || result.away.name} ${result.away.score} - ${result.home.score} ${result.home.abbreviation || result.home.name}`,
        correct,
        firstInningCorrect,
        firstInningPick: prediction.firstInning?.pick || null,
        firstInningActual:
          actualFirstInningRun === null || actualFirstInningRun === undefined
            ? null
            : actualFirstInningRun
              ? 'YES'
              : 'NO',
        matchupMemoryKey: matchupMemory.key,
        matchupMemoryNote: matchupMemory.note,
        confidence: prediction.pick.confidence || 'unknown',
        edge: prediction.betDecision?.edge ?? prediction.valuePick?.edge ?? null,
        dataQuality: prediction.modelBreakdown?.dataQuality ?? null,
        modelBreakdown: prediction.modelBreakdown || null,
        note: correct
          ? `Pick benar: ${prediction.pick.name}. Matchup memory menyimpan pola pertemuan ini tanpa over-bias.`
          : `Pick salah: ${prediction.pick.name}, pemenang ${result.winner.name}. Matchup memory mencatat miss dan pola seri untuk pertemuan berikutnya.`
      });

      memory.learningLog = memory.learningLog.slice(0, 75);
      this.writeMemory(memory);
      this.markPostGameProcessedRow(prediction.gamePk);
    });

    updateOutcome();
    this.refreshState();
  }

  // YRFI/NRFI market removed (scope reduction: no per-game edge, was advisory-only).
  // writeYrfiOutcome deleted — stop writing/reading yrfi_results going forward.
  // Table CREATE TABLE IF NOT EXISTS yrfi_results retained so existing DBs keep
  // historical rows; do not DROP TABLE in production. Migration note: archive-only.

  // Record a VALUE bet at decision time. Idempotent on (game_pk, market): a
  // re-run of /picks for the same game never creates a duplicate ledger row.
  // Only VALUE picks with a positive Kelly stake are recorded.
  // `dateYmd` should be passed explicitly by the caller: raw predictGame objects
  // carry only `startTime` (no `dateYmd`), and savePredictions writes a compact
  // COPY without mutating the in-memory object — so relying on prediction.dateYmd
  // alone stored an empty date_ymd and a "-moneyline-<pk>" decision_id, which
  // broke every date-scoped ledger query (readLedger({sinceDays})).
  recordBet(prediction, dateYmd = prediction?.dateYmd || '') {
    const decision = prediction?.betDecision;
    const value = prediction?.valuePick;
    if (!decision || decision.status !== 'VALUE') return null;
    if (Array.isArray(decision.reasons) && decision.reasons.length > 0) return null;
    if (!value || !(Number(value.kellyStakePercent) > 0)) return null;

    const gamePk = String(prediction.gamePk || '');
    const market = 'moneyline';
    if (!gamePk) return null;

    // decision_id is derived from the natural key (game_pk + market), which the
    // UNIQUE constraint already guarantees. A per-date counter could collide
    // when two recordBet() calls race for different games on the same date.
    const decisionId = `${dateYmd}-${market}-${gamePk}`;
    const now = new Date().toISOString();

    const fallback = normalizeFeatureFallbacks(prediction.featureFallbacks);
    const selectedTeamId =
      value.teamId != null
        ? String(value.teamId)
        : value.side === 'home'
          ? prediction.home?.id != null
            ? String(prediction.home.id)
            : null
          : value.side === 'away'
            ? prediction.away?.id != null
              ? String(prediction.away.id)
              : null
            : null;
    const modelPickTeamId =
      prediction.modelBreakdown?.purePickTeamId != null
        ? String(prediction.modelBreakdown.purePickTeamId)
        : prediction.winner?.id != null
          ? String(prediction.winner.id)
          : prediction.pick?.id != null
            ? String(prediction.pick.id)
            : null;
    const bookmaker =
      value.book ||
      value.bookmaker ||
      prediction.currentOdds?.moneylineBook ||
      prediction.currentOdds?.book ||
      null;
    const quoteId = value.quoteId || value.quote_id || null;
    const modelVersion = prediction.modelVersion || prediction.versions?.model || null;
    const calibrationVersion =
      prediction.calibrationVersion || prediction.versions?.calibration || null;
    const betPolicyVersion =
      prediction.betPolicyVersion || prediction.versions?.betPolicy || null;
    const runId = prediction.runId || prediction.predictionRunId || null;
    // Bind ledger row to immutable pick identity when available.
    const latestPick = this.latestPickRow(gamePk);
    const predictionRunId =
      prediction.predictionRunId ||
      latestPick?.prediction_run_id ||
      null;
    const decisionHash = hashDecisionPayload({
      gamePk,
      market,
      selectedTeamId,
      side: value.side || null,
      odds: Number(value.odds),
      modelProb: Number(value.modelProbability),
      fairProb: Number(value.fairProbability),
      edge: Number(value.edge),
      stake: Number(value.kellyStakePercent),
      bookmaker,
      quoteId
    });

    const insertLedger = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO bet_ledger (
            decision_id, game_pk, prediction_run_id, date_ymd, market, team, side, odds,
            fair_prob, model_prob, edge, units_staked, status, recommended_at,
            feature_fallback_count, fallback_features_used,
            selected_team_id, model_pick_team_id, bookmaker, quote_id,
            decision_hash, model_version, calibration_version, bet_policy_version, run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(game_pk, market) DO NOTHING`
        )
        .run(
          decisionId,
          gamePk,
          predictionRunId,
          dateYmd,
          market,
          value.teamName || null,
          value.side || null,
          Number(value.odds),
          Number(value.fairProbability),
          Number(value.modelProbability),
          Number(value.edge),
          Number(value.kellyStakePercent),
          now,
          fallback.count,
          fallback.features === null ? null : toJson(fallback.features),
          selectedTeamId,
          modelPickTeamId,
          bookmaker,
          quoteId,
          decisionHash,
          modelVersion,
          calibrationVersion,
          betPolicyVersion,
          runId
        );

      if (info.changes > 0) {
        // Mirror into immutable prediction_decisions when migration tables exist.
        try {
          this.db
            .prepare(
              `INSERT INTO prediction_decisions (
                decision_id, run_id, game_pk, date_ymd, market,
                model_pick_team_id, value_bet_team_id, value_bet_team_name, value_side,
                value_model_prob, market_fair_prob, edge, odds, bookmaker, quote_id,
                status, units_staked, kelly_stake_percent, decision_hash, payload, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(game_pk, market) DO NOTHING`
            )
            .run(
              decisionId,
              runId,
              gamePk,
              dateYmd,
              market,
              modelPickTeamId,
              selectedTeamId,
              value.teamName || null,
              value.side || null,
              Number(value.modelProbability),
              Number(value.fairProbability),
              Number(value.edge),
              Number(value.odds),
              bookmaker,
              quoteId,
              'VALUE',
              Number(value.kellyStakePercent),
              Number(value.kellyStakePercent),
              decisionHash,
              toJson({
                team: value.teamName || null,
                side: value.side || null,
                selectedTeamId
              }),
              now
            );
        } catch {
          // Table may be absent on partially migrated test DBs; ledger row is authoritative.
        }
      }

      return info.changes > 0 ? decisionId : null;
    });

    return insertLedger();
  }

  /**
   * Resolve the immutable selected team id for a ledger row.
   * Prefer selected_team_id; fall back to side + prediction home/away.
   */
  resolveSelectedTeamId(row, prediction = null) {
    if (row?.selected_team_id != null && String(row.selected_team_id) !== '') {
      return String(row.selected_team_id);
    }
    if (row?.side === 'home' && prediction?.home?.id != null) return String(prediction.home.id);
    if (row?.side === 'away' && prediction?.away?.id != null) return String(prediction.away.id);
    return null;
  }

  // Settle an open bet against the final result. Idempotent: the status='open'
  // guard makes a second settle of the same game a no-op (units_pl unchanged).
  // Uses value_bet selected_team_id / ledger.side — never prediction.pick.
  // 100u notional bankroll, so units_staked = stake% and a win pays
  // units_staked * profit-multiple of the American odds; a loss returns -stake.
  settleBet(prediction, result, clv = null) {
    const gamePk = String(prediction?.gamePk || '');
    const market = 'moneyline';
    if (!gamePk) return false;

    const row = this.db
      .prepare("SELECT * FROM bet_ledger WHERE game_pk = ? AND market = ? AND status = 'open'")
      .get(gamePk, market);
    if (!row) return false;

    const stakedTeamId = this.resolveSelectedTeamId(row, prediction);
    const winnerId = result?.winner?.id;
    let outcome = 'loss';
    let unitsPl = -row.units_staked;
    if (winnerId == null) {
      outcome = 'push';
      unitsPl = 0;
    } else if (stakedTeamId != null && String(stakedTeamId) === String(winnerId)) {
      outcome = 'win';
      const odds = Number(row.odds);
      const profitMultiple = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
      unitsPl = row.units_staked * profitMultiple;
    }

    const settledAt = new Date().toISOString();
    const roundedPl = Math.round(unitsPl * 1000) / 1000;
    const settlementId = `settle-${row.decision_id}`;

    const settleTx = this.db.transaction(() => {
      const update = this.db
        .prepare(
          `UPDATE bet_ledger
           SET status = 'settled', result = ?, units_pl = ?, clv = ?, settled_at = ?,
               settlement_pending = 0
           WHERE game_pk = ? AND market = ? AND status = 'open'`
        )
        .run(outcome, roundedPl, clv, settledAt, gamePk, market);

      if (update.changes !== 1) {
        return false;
      }

      try {
        this.db
          .prepare(
            `INSERT INTO settlements (
              settlement_id, decision_id, game_pk, market, selected_team_id, selected_side,
              result, units_staked, units_pl, odds, clv, settled_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(decision_id) DO NOTHING`
          )
          .run(
            settlementId,
            row.decision_id,
            gamePk,
            market,
            stakedTeamId,
            row.side || null,
            outcome,
            row.units_staked,
            roundedPl,
            row.odds,
            clv,
            settledAt
          );
      } catch {
        // settlements table may be missing on old fixtures; ledger update is enough.
      }

      return true;
    });

    return settleTx();
  }

  /**
   * Atomic post-game processing for a single prediction:
   * 1) record memory/outcome
   * 2) settle open value bet (if any)
   * 3) mark pick processed only after settlement attempt is recorded
   *
   * If settlement throws, the pick is NOT marked processed so the scheduler can retry.
   * If there is no open bet, mark processed after outcome as before.
   */
  processPostGameOutcome(prediction, result, { enabled = true, clv = null } = {}) {
    const gamePk = String(prediction?.gamePk || '');
    if (!gamePk) {
      return { settled: false, processed: false, error: 'missing_game_pk' };
    }

    const existing = this.getPrediction(gamePk);
    if (existing?.postGameProcessed) {
      // Still try idempotent settle for stranded open+processed rows.
      const settled = this.settleBet(prediction, result, clv);
      return { settled, processed: true, retriedStranded: true };
    }

    try {
      const run = this.db.transaction(() => {
        // Outcome/memory first, but do not mark processed inside recordOutcome path
        // when we control the checkpoint here.
        this.recordOutcomeWithoutProcessedMark(prediction, result, { enabled });

        const open = this.db
          .prepare("SELECT decision_id FROM bet_ledger WHERE game_pk = ? AND status = 'open'")
          .get(gamePk);

        let settled = false;
        if (open) {
          // Mark pending so operators can see settle-in-progress after crash mid-tx
          // (transaction rollback clears this if we fail before commit).
          this.db
            .prepare(
              `UPDATE bet_ledger SET settlement_pending = 1
               WHERE game_pk = ? AND status = 'open'`
            )
            .run(gamePk);
          settled = this.settleBet(prediction, result, clv);
          if (open && !settled) {
            // Keep open + not processed for retry.
            this.db
              .prepare(
                `UPDATE bet_ledger SET settlement_pending = 0
                 WHERE game_pk = ? AND status = 'open'`
              )
              .run(gamePk);
            return { settled: false, processed: false, error: 'settle_failed' };
          }
        }

        this.markPostGameProcessedRow(gamePk);

        try {
          this.db
            .prepare(
              `INSERT INTO outbox (outbox_id, event_type, aggregate_id, payload, created_at, available_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(
              `postgame-${gamePk}-${Date.now()}`,
              'postgame_processed',
              gamePk,
              toJson({ gamePk, settled, clv }),
              new Date().toISOString(),
              new Date().toISOString()
            );
        } catch {
          // outbox optional
        }

        return { settled, processed: true };
      });

      const resultInfo = run();
      this.refreshState();
      return resultInfo;
    } catch (error) {
      return {
        settled: false,
        processed: false,
        error: error?.message || String(error)
      };
    }
  }

  /**
   * Same as recordOutcome but does not mark the pick processed.
   * Used by processPostGameOutcome so the checkpoint stays after settlement.
   */
  recordOutcomeWithoutProcessedMark(prediction, result, { enabled = true } = {}) {
    const updateOutcome = this.db.transaction(() => {
      const memory = this.readMemory();
      const alreadyLogged = (memory.learningLog || []).some(
        (entry) => String(entry.gamePk) === String(prediction.gamePk)
      );
      if (alreadyLogged) {
        // Idempotent retry after partial post-game failure: do not double-count memory.
        return { skipped: true };
      }

      const correct = prediction.pick.id === result.winner.id;
      const actualFirstInningRun = result.firstInning?.anyRun;

      memory.totalPicks += 1;
      if (correct) memory.correctPicks += 1;
      if (!correct) memory.wrongPicks += 1;

      const confidence = prediction.pick.confidence || 'unknown';
      if (!memory.byConfidence[confidence]) {
        memory.byConfidence[confidence] = { total: 0, correct: 0 };
      }
      memory.byConfidence[confidence].total += 1;
      if (correct) memory.byConfidence[confidence].correct += 1;

      // YRFI/NRFI market removed — firstInning grading and yrfi_results writes stopped.
      // yrfi_results table retained for historical data only (do not drop).
      let firstInningCorrect = null;

      if (enabled) {
        if (!result.winner || !result.winner.id || !result.loser || !result.loser.id) {
          // Skip bias update for games without clear winner/loser (ties, suspended)
        } else {
          const winnerKey = String(result.winner.id);
          const loserKey = String(result.loser.id);
          const pickKey = String(prediction.pick.id);

          const winnerBump = correct ? 0.002 : 0.002;
          const loserDrop = correct ? 0.001 : 0.004;
          memory.teamBias[winnerKey] = clamp(
            (memory.teamBias[winnerKey] || 0) + winnerBump,
            -TEAM_BIAS_LIMIT,
            TEAM_BIAS_LIMIT
          );
          memory.teamBias[loserKey] = clamp(
            (memory.teamBias[loserKey] || 0) - loserDrop,
            -TEAM_BIAS_LIMIT,
            TEAM_BIAS_LIMIT
          );

          if (!correct) {
            memory.teamBias[pickKey] = clamp(
              (memory.teamBias[pickKey] || 0) - 0.006,
              -TEAM_BIAS_LIMIT,
              TEAM_BIAS_LIMIT
            );
          }
        }
      }

      const matchupMemory = updateMatchupMemory(
        memory,
        prediction,
        result,
        correct,
        firstInningCorrect
      );

      memory.learningLog.unshift({
        at: new Date().toISOString(),
        gamePk: prediction.gamePk,
        matchup: prediction.matchup,
        pick: prediction.pick.name,
        pickProbability: prediction.pick.winProbability,
        winner: result.winner.name,
        score: `${result.away.abbreviation || result.away.name} ${result.away.score} - ${result.home.score} ${result.home.abbreviation || result.home.name}`,
        correct,
        firstInningCorrect,
        firstInningPick: prediction.firstInning?.pick || null,
        firstInningActual:
          actualFirstInningRun === null || actualFirstInningRun === undefined
            ? null
            : actualFirstInningRun
              ? 'YES'
              : 'NO',
        matchupMemoryKey: matchupMemory.key,
        matchupMemoryNote: matchupMemory.note,
        confidence: prediction.pick.confidence || 'unknown',
        edge: prediction.betDecision?.edge ?? prediction.valuePick?.edge ?? null,
        dataQuality: prediction.modelBreakdown?.dataQuality ?? null,
        modelBreakdown: prediction.modelBreakdown || null,
        note: correct
          ? `Pick benar: ${prediction.pick.name}. Matchup memory menyimpan pola pertemuan ini tanpa over-bias.`
          : `Pick salah: ${prediction.pick.name}, pemenang ${result.winner.name}. Matchup memory mencatat miss dan pola seri untuk pertemuan berikutnya.`
      });

      memory.learningLog = memory.learningLog.slice(0, 75);
      this.writeMemory(memory);

      try {
        this.db
          .prepare(
            `INSERT INTO game_outcomes (
              game_pk, date_ymd, home_team_id, away_team_id, home_score, away_score,
              winner_team_id, loser_team_id, first_inning_any_run, payload, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_pk) DO NOTHING`
          )
          .run(
            String(prediction.gamePk),
            prediction.dateYmd || result.dateYmd || '',
            prediction.home?.id != null ? String(prediction.home.id) : null,
            prediction.away?.id != null ? String(prediction.away.id) : null,
            result.home?.score ?? null,
            result.away?.score ?? null,
            result.winner?.id != null ? String(result.winner.id) : null,
            result.loser?.id != null ? String(result.loser.id) : null,
            result.firstInning?.anyRun == null ? null : result.firstInning.anyRun ? 1 : 0,
            toJson(result),
            new Date().toISOString()
          );
      } catch {
        // optional table
      }
    });

    updateOutcome();
  }


  readLedger({ status = null, sinceDays = null, includeArchived = false } = {}) {
    const clauses = [];
    const params = [];
    if (!includeArchived) {
      clauses.push("market = 'moneyline'");
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (Number.isFinite(sinceDays)) {
      const cutoff = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
      clauses.push('date_ymd >= ?');
      params.push(cutoff);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM bet_ledger ${where} ORDER BY date_ymd ASC, decision_id ASC`)
      .all(...params);
  }

  getOpenBet(gamePk, market = 'moneyline') {
    if (!gamePk) return null;
    return (
      this.db
        .prepare(
          `SELECT * FROM bet_ledger WHERE game_pk = ? AND market = ? AND status = 'open' LIMIT 1`
        )
        .get(String(gamePk), String(market)) || null
    );
  }

  getLedgerSide(gamePk, market = 'moneyline') {
    if (!gamePk) return null;
    const row = this.db
      .prepare(
        `SELECT side, selected_team_id FROM bet_ledger
         WHERE game_pk = ? AND market = ?
         ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, recommended_at DESC
         LIMIT 1`
      )
      .get(String(gamePk), String(market));
    if (!row) return null;
    if (row.side === 'home' || row.side === 'away') return row.side;
    return null;
  }

  /**
   * Best-effort outbox insert for post-commit side effects / proposals.
   * No-op if outbox table is absent.
   */
  enqueueOutbox(eventType, aggregateId, payload) {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO outbox (outbox_id, event_type, aggregate_id, payload, created_at, available_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          `${eventType}-${aggregateId || 'na'}-${Date.now()}`,
          String(eventType || 'event'),
          aggregateId != null ? String(aggregateId) : null,
          toJson(payload ?? null),
          now,
          now
        );
      return true;
    } catch {
      return false;
    }
  }

  appendChatMessage(chatId, role, content) {
    const maxMessages = 20;
    this.db
      .prepare('INSERT INTO chat_history (chat_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run(String(chatId), role, content, new Date().toISOString());

    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM chat_history WHERE chat_id = ?')
      .get(String(chatId)).count;

    if (count > maxMessages) {
      this.db
        .prepare(
          `DELETE FROM chat_history WHERE id IN (
            SELECT id FROM chat_history WHERE chat_id = ? ORDER BY timestamp ASC LIMIT ?
          )`
        )
        .run(String(chatId), count - maxMessages);
    }
  }

  getChatHistory(chatId, limit = 10) {
    return this.db
      .prepare('SELECT role, content FROM chat_history WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(String(chatId), limit)
      .reverse();
  }

  clearChatHistory(chatId) {
    this.db.prepare('DELETE FROM chat_history WHERE chat_id = ?').run(String(chatId));
  }
}
