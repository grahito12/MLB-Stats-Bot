import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
const TEAM_BIAS_LIMIT = 0.08;

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

  const winnerId = String(games[0].winner.id);
  let length = 0;
  for (const game of games) {
    if (String(game.winner.id) !== winnerId) break;
    length += 1;
  }

  return {
    winner: games[0].winner,
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
  const awayProbability = agent?.awayProbability ?? Math.round(prediction.away.winProbability);
  const homeProbability = agent?.homeProbability ?? Math.round(prediction.home.winProbability);
  const agentPick =
    agent?.pickTeamId === prediction.away.id
      ? prediction.away
      : agent?.pickTeamId === prediction.home.id
        ? prediction.home
        : prediction.winner;
  const pickProbability =
    agentPick.id === prediction.away.id
      ? awayProbability
      : agentPick.id === prediction.home.id
        ? homeProbability
        : Math.round(prediction.winner.winProbability);

  return {
    gamePk: prediction.gamePk,
    dateYmd,
    status: prediction.status,
    matchup: `${prediction.away.name} @ ${prediction.home.name}`,
    away: {
      id: prediction.away.id,
      name: prediction.away.name,
      abbreviation: prediction.away.abbreviation,
      winProbability: awayProbability
    },
    home: {
      id: prediction.home.id,
      name: prediction.home.name,
      abbreviation: prediction.home.abbreviation,
      winProbability: homeProbability
    },
    pick: {
      id: agentPick.id,
      name: agentPick.name,
      abbreviation: agentPick.abbreviation,
      winProbability: pickProbability,
      source: agent ? 'analyst-agent' : 'baseline-model',
      confidence: agent?.confidence || 'model'
    },
    reasons: agent?.reasons || prediction.reasons,
    firstInning: prediction.firstInning
      ? {
          pick: prediction.firstInning.agent?.pick || prediction.firstInning.baselinePick,
          probability: Math.round(
            prediction.firstInning.agent?.probability ?? prediction.firstInning.baselineProbability
          ),
          source: prediction.firstInning.agent ? 'analyst-agent' : 'baseline-model',
          reasons: prediction.firstInning.agent?.reasons || prediction.firstInning.reasons || []
        }
      : null,
    agentRisk: agent?.risk || '',
    agentMemoryNote: agent?.memoryNote || '',
    savedAt: new Date().toISOString()
  };
}

export class Storage {
  constructor(filePath = resolve(process.cwd(), 'data', 'state.json')) {
    this.filePath = filePath;
    this.state = this.read();
  }

  read() {
    if (!existsSync(this.filePath)) return normalizeState(DEFAULT_STATE);

    try {
      return normalizeState(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      return normalizeState(DEFAULT_STATE);
    }
  }

  save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  getLastUpdateId() {
    return this.state.lastUpdateId || 0;
  }

  setLastUpdateId(updateId) {
    this.state.lastUpdateId = updateId;
    this.save();
  }

  addSubscriber(chat, options = {}) {
    const key = String(chat.id);
    const existing = this.state.subscribers[key] || {};
    this.state.subscribers[key] = normalizeSubscriber({
      ...existing,
      id: chat.id,
      title: chat.title || chat.username || chat.first_name || String(chat.id),
      subscribedAt: existing.subscribedAt || new Date().toISOString(),
      autoUpdate: {
        ...(existing.autoUpdate || {}),
        ...(options.autoUpdate || {})
      }
    });
    this.save();
  }

  removeSubscriber(chatId) {
    delete this.state.subscribers[String(chatId)];
    this.save();
  }

  listSubscriberIds() {
    return Object.keys(this.state.subscribers);
  }

  getSubscriber(chatId) {
    return this.state.subscribers[String(chatId)] || null;
  }

  setAutoUpdate(chat, updates = {}) {
    const key = String(chat.id);
    if (!this.state.subscribers[key]) {
      this.addSubscriber(chat);
    }

    const subscriber = this.state.subscribers[key];
    subscriber.autoUpdate = {
      ...DEFAULT_AUTO_UPDATE,
      ...(subscriber.autoUpdate || {}),
      ...updates
    };
    this.save();
  }

  getAutoUpdate(chatId) {
    const subscriber = this.getSubscriber(chatId);
    return {
      ...DEFAULT_AUTO_UPDATE,
      ...(subscriber?.autoUpdate || {})
    };
  }

  listAutoUpdateTargets(defaultDailyTime = '20:00') {
    return Object.values(this.state.subscribers)
      .filter((subscriber) => subscriber.autoUpdate?.enabled)
      .map((subscriber) => ({
        chatId: String(subscriber.id),
        title: subscriber.title || String(subscriber.id),
        dailyTime: subscriber.autoUpdate.dailyTime || defaultDailyTime,
        lastSentDate: subscriber.autoUpdate.lastSentDate || ''
      }));
  }

  setAutoUpdateLastSent(chatId, dateYmd) {
    const subscriber = this.state.subscribers[String(chatId)];
    if (!subscriber) return;

    subscriber.autoUpdate = {
      ...DEFAULT_AUTO_UPDATE,
      ...(subscriber.autoUpdate || {}),
      lastSentDate: dateYmd
    };
    this.save();
  }

  getLastAutoAlertDate() {
    return this.state.lastAutoAlertDate || '';
  }

  setLastAutoAlertDate(dateYmd) {
    this.state.lastAutoAlertDate = dateYmd;
    this.save();
  }

  savePredictions(dateYmd, predictions) {
    for (const prediction of predictions) {
      if (String(prediction.status).toLowerCase().includes('final')) continue;

      const key = String(prediction.gamePk);
      const existing = this.state.predictions[key] || {};
      this.state.predictions[key] = {
        ...compactPrediction(prediction, dateYmd),
        postGameProcessed: existing.postGameProcessed || false,
        postGameProcessedAt: existing.postGameProcessedAt || null
      };
    }

    this.save();
  }

  getPrediction(gamePk) {
    return this.state.predictions[String(gamePk)] || null;
  }

  listPendingPredictionDates() {
    return [
      ...new Set(
        Object.values(this.state.predictions)
          .filter((prediction) => !prediction.postGameProcessed)
          .map((prediction) => prediction.dateYmd)
          .filter(Boolean)
      )
    ];
  }

  markPostGameProcessed(gamePk) {
    const key = String(gamePk);
    if (!this.state.predictions[key]) return;

    this.state.predictions[key].postGameProcessed = true;
    this.state.predictions[key].postGameProcessedAt = new Date().toISOString();
    this.save();
  }

  getMemory() {
    return this.state.memory;
  }

  getMemorySummary() {
    const memory = this.state.memory;
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
    const correct = prediction.pick.id === result.winner.id;
    const memory = this.state.memory;

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
    if (prediction.firstInning && result.firstInning?.anyRun !== null) {
      const actualPick = result.firstInning.anyRun ? 'YES' : 'NO';
      const predictedPick = prediction.firstInning.pick || 'NO';
      firstInningCorrect = predictedPick === actualPick;
      memory.firstInning.totalPicks += 1;
      if (firstInningCorrect) memory.firstInning.correctPicks += 1;
      if (!firstInningCorrect) memory.firstInning.wrongPicks += 1;

      if (!memory.firstInning.byPick[predictedPick]) {
        memory.firstInning.byPick[predictedPick] = { total: 0, correct: 0 };
      }
      memory.firstInning.byPick[predictedPick].total += 1;
      if (firstInningCorrect) memory.firstInning.byPick[predictedPick].correct += 1;
    }

    if (enabled) {
      const winnerKey = String(result.winner.id);
      const loserKey = String(result.loser.id);
      const pickKey = String(prediction.pick.id);

      const winnerBump = correct ? 0.002 : 0.006;
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
          (memory.teamBias[pickKey] || 0) - 0.004,
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
        result.firstInning?.anyRun === null ? null : result.firstInning.anyRun ? 'YES' : 'NO',
      matchupMemoryKey: matchupMemory.key,
      matchupMemoryNote: matchupMemory.note,
      note: correct
        ? `Pick benar: ${prediction.pick.name}. Matchup memory menyimpan pola pertemuan ini tanpa over-bias.`
        : `Pick salah: ${prediction.pick.name}, pemenang ${result.winner.name}. Matchup memory mencatat miss dan pola seri untuk pertemuan berikutnya.`
    });

    memory.learningLog = memory.learningLog.slice(0, 75);
    this.markPostGameProcessed(prediction.gamePk);
  }
}
