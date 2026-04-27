import {
  clamp,
  dateInTimezone,
  formatGameTime,
  percent,
  safeFixed,
  sigmoid,
  toNumber
} from './utils.js';

const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';
const GAME_SEPARATOR = '━━━━━━━━━━━━━━━━━━━━';
const SECTION_SEPARATOR = '────────────';
const DEFAULTS = {
  rpg: 4.4,
  ops: 0.72,
  era: 4.2,
  whip: 1.3,
  winPct: 0.5,
  iso: 0.15,
  kRate: 0.22,
  bbRate: 0.085,
  kMinusBb: 0.12,
  hr9: 1.1,
  firstInningRunRate: 0.26,
  gameFirstInningRunRate: 0.46
};

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'mlb-alert-telegram-agent/0.1'
      }
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function seasonFromDate(dateYmd) {
  return Number.parseInt(dateYmd.slice(0, 4), 10);
}

function seasonStartDate(season) {
  return `${season}-03-01`;
}

function teamMemoryBias(modelMemory, teamId) {
  return clamp(toNumber(modelMemory?.teamBias?.[String(teamId)], 0), -0.18, 0.18);
}

function leagueRecordPct(record) {
  if (!record) return DEFAULTS.winPct;
  if (record.pct !== undefined) return toNumber(record.pct, DEFAULTS.winPct);

  const wins = toNumber(record.wins, 0);
  const losses = toNumber(record.losses, 0);
  const total = wins + losses;
  return total > 0 ? wins / total : DEFAULTS.winPct;
}

function recordText(record) {
  if (!record) return '-';

  const wins = record.wins ?? 0;
  const losses = record.losses ?? 0;
  return `${wins}-${losses}`;
}

function winProbText(team) {
  return `${team.abbreviation || team.name} ${percent(team.winProbability)}`;
}

function displayedProbabilities(item) {
  return {
    away: item.agentAnalysis?.awayProbability ?? item.away.winProbability,
    home: item.agentAnalysis?.homeProbability ?? item.home.winProbability
  };
}

function agentPick(item) {
  if (item.agentAnalysis?.pickTeamId === item.away.id) return item.away;
  if (item.agentAnalysis?.pickTeamId === item.home.id) return item.home;
  return item.winner;
}

function displayedWinProbText(team, value) {
  return `${team.abbreviation || team.name} ${percent(value)}`;
}

function h2hProbText(team, probability) {
  return `${team.abbreviation || team.name} ${percent(probability)}`;
}

function firstInningPickText(firstInning) {
  const pick = firstInning?.agent?.pick || firstInning?.baselinePick || 'NO';
  const probability = firstInning?.agent?.probability ?? firstInning?.baselineProbability ?? 50;
  const label = pick === 'YES' ? 'YES / YRFI' : 'NO / NRFI';
  return `${label} ${percent(probability)}`;
}

function splitInfoLine(value) {
  return String(value || '-')
    .split(' | ')
    .filter(Boolean)
    .map((part) => `• ${part}`);
}

function splitRecord(standing, type) {
  return standing?.records?.splitRecords?.find((record) => record.type === type) || null;
}

function expectedRecord(standing) {
  return standing?.records?.expectedRecords?.find((record) => record.type === 'xWinLoss') || null;
}

function splitPct(standing, type) {
  return leagueRecordPct(splitRecord(standing, type));
}

function runDiffPerGame(standing) {
  const games = Math.max(1, toNumber(standing?.gamesPlayed, 1));
  return toNumber(standing?.runDifferential, 0) / games;
}

function firstFiniteNumber(values, fallback) {
  for (const value of values) {
    const parsed = toNumber(value, Number.NaN);
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function pythagoreanWinPct(standing, profile) {
  const games = Math.max(
    1,
    firstFiniteNumber([standing?.gamesPlayed, profile?.hitting?.gamesPlayed], 1)
  );
  const runsFor = Math.max(
    1,
    firstFiniteNumber([standing?.runsScored, profile?.hitting?.runs], DEFAULTS.rpg * games)
  );
  const runsAgainst = Math.max(
    1,
    firstFiniteNumber([standing?.runsAllowed, profile?.pitching?.runs], DEFAULTS.rpg * games)
  );
  const exponent = 1.83;
  const scoredPower = Math.pow(runsFor, exponent);
  const allowedPower = Math.pow(runsAgainst, exponent);
  return clamp(scoredPower / (scoredPower + allowedPower), 0.25, 0.75);
}

function log5Probability(teamWinPct, opponentWinPct) {
  const team = clamp(toNumber(teamWinPct, DEFAULTS.winPct), 0.05, 0.95);
  const opponent = clamp(toNumber(opponentWinPct, DEFAULTS.winPct), 0.05, 0.95);
  const denominator = team + opponent - 2 * team * opponent;
  if (Math.abs(denominator) < 0.0001) return DEFAULTS.winPct;
  return clamp((team - team * opponent) / denominator, 0.05, 0.95);
}

function signed(value) {
  const parsed = toNumber(value, 0);
  return parsed > 0 ? `+${parsed}` : String(parsed);
}

function ratePct(value, fallback = 0) {
  return `${(toNumber(value, fallback) * 100).toFixed(1)}%`;
}

function parseInnings(value) {
  if (value === null || value === undefined || value === '') return 0;
  const [whole, partial = '0'] = String(value).split('.');
  const outs = Number.parseInt(whole, 10) * 3 + Number.parseInt(partial, 10);
  return Number.isFinite(outs) ? outs / 3 : 0;
}

function ymdOffset(dateYmd, offsetDays) {
  const date = new Date(`${dateYmd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function splitRecordText(record) {
  return record ? `${record.wins}-${record.losses} (${safeFixed(toNumber(record.pct, 0) * 100, 0)}%)` : '-';
}

function gamesPlayed(stat) {
  return Math.max(1, toNumber(stat?.gamesPlayed, 1));
}

function rpg(stat) {
  return toNumber(stat?.runs, DEFAULTS.rpg * gamesPlayed(stat)) / gamesPlayed(stat);
}

function statOps(stat) {
  return toNumber(stat?.ops, DEFAULTS.ops);
}

function statEra(stat) {
  return toNumber(stat?.era, DEFAULTS.era);
}

function statWhip(stat) {
  return toNumber(stat?.whip, DEFAULTS.whip);
}

function kToBb(stat) {
  const strikeouts = toNumber(stat?.strikeOuts, 0);
  const walks = toNumber(stat?.baseOnBalls, 0);
  if (strikeouts <= 0 && walks <= 0) return 2.2;
  return strikeouts / Math.max(1, walks);
}

function statIso(stat) {
  return toNumber(stat?.iso, DEFAULTS.iso);
}

function battingKRate(stat) {
  return toNumber(stat?.strikeoutsPerPlateAppearance, DEFAULTS.kRate);
}

function battingBbRate(stat) {
  return toNumber(stat?.walksPerPlateAppearance, DEFAULTS.bbRate);
}

function pitchingKMinusBb(stat) {
  return toNumber(stat?.strikeoutsMinusWalksPercentage, DEFAULTS.kMinusBb);
}

function pitchingHr9(stat) {
  return toNumber(stat?.homeRunsPer9, DEFAULTS.hr9);
}

function pitcherLabel(pitcher, stats) {
  if (!pitcher?.fullName) return 'TBD';
  const hand = pitcher.pitchHand?.code ? `${pitcher.pitchHand.code}HP ` : '';
  if (!stats) return `${pitcher.fullName} ${hand}`.trim();
  return `${pitcher.fullName} ${hand}ERA ${safeFixed(stats.era)} WHIP ${safeFixed(stats.whip)}`;
}

function getTeamStatMap(statsData) {
  const teams = new Map();

  for (const block of statsData.stats || []) {
    const group = block.group?.displayName?.toLowerCase();
    if (!group) continue;

    for (const split of block.splits || []) {
      const teamId = split.team?.id;
      if (!teamId) continue;

      if (!teams.has(teamId)) {
        teams.set(teamId, {
          team: split.team,
          hitting: null,
          hittingAdvanced: null,
          pitching: null,
          pitchingAdvanced: null
        });
      }

      const profile = teams.get(teamId);
      const type = block.type?.displayName;
      if (group === 'hitting' && type === 'season') profile.hitting = split.stat;
      if (group === 'hitting' && type === 'seasonAdvanced') profile.hittingAdvanced = split.stat;
      if (group === 'pitching' && type === 'season') profile.pitching = split.stat;
      if (group === 'pitching' && type === 'seasonAdvanced') profile.pitchingAdvanced = split.stat;
    }
  }

  return teams;
}

function getStandingMap(standingsData) {
  const teams = new Map();

  for (const division of standingsData.records || []) {
    for (const teamRecord of division.teamRecords || []) {
      if (teamRecord.team?.id) {
        teams.set(teamRecord.team.id, teamRecord);
      }
    }
  }

  return teams;
}

async function fetchRecentTeamGames(teamIds, dateYmd, daysBack = 3) {
  const params = new URLSearchParams({
    sportId: '1',
    gameTypes: 'R',
    startDate: ymdOffset(dateYmd, -daysBack),
    endDate: ymdOffset(dateYmd, -1),
    hydrate: 'team'
  });

  const idSet = new Set(teamIds);
  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  return (data.dates || [])
    .flatMap((date) => date.games || [])
    .filter((game) => game.status?.abstractGameState === 'Final')
    .filter((game) => idSet.has(game.teams.away.team.id) || idSet.has(game.teams.home.team.id));
}

async function fetchBoxscore(gamePk) {
  return fetchJson(`${MLB_BASE_URL}/game/${gamePk}/boxscore`);
}

async function fetchBullpenProfiles(teamIds, dateYmd) {
  const profiles = new Map(
    teamIds.map((teamId) => [
      teamId,
      {
        teamId,
        games: 0,
        bullpenPitches: 0,
        bullpenOuts: 0,
        relieverAppearances: 0,
        relieverDates: new Map(),
        highPitchRelievers: 0
      }
    ])
  );
  const games = await fetchRecentTeamGames(teamIds, dateYmd, 3);

  await Promise.all(
    games.map(async (game) => {
      let boxscore;
      try {
        boxscore = await fetchBoxscore(game.gamePk);
      } catch {
        return;
      }

      for (const side of ['away', 'home']) {
        const team = game.teams[side].team;
        const profile = profiles.get(team.id);
        if (!profile) continue;

        profile.games += 1;
        const boxTeam = boxscore.teams?.[side];
        for (const personId of boxTeam?.pitchers || []) {
          const player = boxTeam.players?.[`ID${personId}`];
          const stats = player?.stats?.pitching || {};
          if (toNumber(stats.gamesStarted, 0) > 0) continue;

          const pitches = toNumber(stats.numberOfPitches, 0);
          profile.bullpenPitches += pitches;
          profile.bullpenOuts += Math.round(parseInnings(stats.inningsPitched) * 3);
          profile.relieverAppearances += 1;
          if (pitches >= 25) profile.highPitchRelievers += 1;

          const key = String(personId);
          if (!profile.relieverDates.has(key)) profile.relieverDates.set(key, new Set());
          profile.relieverDates.get(key).add(game.officialDate || game.gameDate);
        }
      }
    })
  );

  for (const [teamId, profile] of profiles.entries()) {
    profiles.set(teamId, finalizeBullpenProfile(profile));
  }

  return profiles;
}

function finalizeBullpenProfile(profile) {
  const backToBackRelievers = [...profile.relieverDates.values()].filter((dates) => dates.size >= 2).length;
  const innings = profile.bullpenOuts / 3;
  const fatigueScore =
    profile.bullpenPitches / 120 +
    backToBackRelievers * 0.2 +
    profile.highPitchRelievers * 0.12 +
    Math.max(0, profile.games - 2) * 0.15;
  const level = fatigueScore >= 1.7 ? 'high' : fatigueScore >= 0.9 ? 'medium' : 'low';

  return {
    teamId: profile.teamId,
    games: profile.games,
    bullpenPitches: profile.bullpenPitches,
    bullpenInnings: innings,
    relieverAppearances: profile.relieverAppearances,
    backToBackRelievers,
    highPitchRelievers: profile.highPitchRelievers,
    fatigueScore,
    level,
    line: `${profile.games}G last 3d, ${Math.round(profile.bullpenPitches)} pitches, ${safeFixed(innings, 1)} IP, B2B relievers ${backToBackRelievers}, fatigue ${level}`
  };
}

async function fetchSchedule(dateYmd) {
  const params = new URLSearchParams({
    sportId: '1',
    date: dateYmd,
    gameTypes: 'R',
    hydrate: 'probablePitcher,team,venue,weather,linescore'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  return (data.dates || []).flatMap((date) => date.games || []);
}

async function fetchTeamStats(season) {
  const params = new URLSearchParams({
    season: String(season),
    stats: 'season,seasonAdvanced',
    group: 'hitting,pitching',
    sportIds: '1',
    gameType: 'R'
  });

  return getTeamStatMap(await fetchJson(`${MLB_BASE_URL}/teams/stats?${params}`));
}

async function fetchStandings(season, dateYmd) {
  const params = new URLSearchParams({
    leagueId: '103,104',
    season: String(season),
    standingsTypes: 'regularSeason',
    date: dateYmd
  });

  return getStandingMap(await fetchJson(`${MLB_BASE_URL}/standings?${params}`));
}

async function fetchFirstInningProfiles(season, dateYmd) {
  const params = new URLSearchParams({
    sportId: '1',
    season: String(season),
    gameTypes: 'R',
    startDate: seasonStartDate(season),
    endDate: dateYmd,
    hydrate: 'linescore,team'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  const profiles = new Map();
  const games = (data.dates || [])
    .flatMap((date) => date.games || [])
    .filter((game) => game.status?.abstractGameState === 'Final')
    .filter((game) => game.linescore?.innings?.[0]);

  for (const game of games) {
    addFirstInningGame(profiles, game, game.teams.away.team, 'away');
    addFirstInningGame(profiles, game, game.teams.home.team, 'home');
  }

  for (const [teamId, profile] of profiles.entries()) {
    profiles.set(teamId, finalizeFirstInningProfile(profile));
  }

  return profiles;
}

async function fetchPitcherStats(personId, season) {
  if (!personId) return null;

  const params = new URLSearchParams({
    stats: 'season',
    group: 'pitching',
    season: String(season),
    gameType: 'R'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  return data.stats?.[0]?.splits?.[0]?.stat || null;
}

async function fetchPerson(personId) {
  if (!personId) return null;
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}`);
  return data.people?.[0] || null;
}

async function fetchPitcherRecentStarts(personId, season, limit = 5) {
  if (!personId) return null;

  const params = new URLSearchParams({
    stats: 'gameLog',
    group: 'pitching',
    season: String(season),
    gameType: 'R'
  });
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  const starts = (data.stats?.[0]?.splits || [])
    .filter((split) => toNumber(split.stat?.gamesStarted, 0) > 0)
    .slice(-limit);

  return summarizePitcherStarts(starts);
}

function summarizePitcherStarts(starts) {
  if (!starts || starts.length === 0) {
    return {
      games: 0,
      line: 'recent starts unavailable'
    };
  }

  const innings = starts.reduce((sum, split) => sum + parseInnings(split.stat?.inningsPitched), 0);
  const earnedRuns = starts.reduce((sum, split) => sum + toNumber(split.stat?.earnedRuns, 0), 0);
  const hits = starts.reduce((sum, split) => sum + toNumber(split.stat?.hits, 0), 0);
  const walks = starts.reduce((sum, split) => sum + toNumber(split.stat?.baseOnBalls, 0), 0);
  const strikeouts = starts.reduce((sum, split) => sum + toNumber(split.stat?.strikeOuts, 0), 0);
  const homeRuns = starts.reduce((sum, split) => sum + toNumber(split.stat?.homeRuns, 0), 0);
  const pitches = starts.reduce((sum, split) => sum + toNumber(split.stat?.numberOfPitches, 0), 0);
  const era = innings > 0 ? (earnedRuns * 9) / innings : 0;
  const whip = innings > 0 ? (hits + walks) / innings : 0;
  const kbb = strikeouts / Math.max(1, walks);
  const last = starts[starts.length - 1];

  return {
    games: starts.length,
    innings,
    era,
    whip,
    strikeouts,
    walks,
    homeRuns,
    avgPitches: pitches / starts.length,
    lastStartDate: last?.date || '',
    lastStartPitches: toNumber(last?.stat?.numberOfPitches, 0),
    line: `last ${starts.length}: ERA ${safeFixed(era)}, WHIP ${safeFixed(whip)}, K/BB ${safeFixed(kbb, 1)}, HR ${homeRuns}, avg ${safeFixed(pitches / starts.length, 0)} pitches`
  };
}

function emptyFirstInningProfile(team) {
  return {
    team: {
      id: team.id,
      name: team.name,
      abbreviation: team.abbreviation
    },
    games: []
  };
}

function addFirstInningGame(profiles, game, team, side) {
  if (!profiles.has(team.id)) {
    profiles.set(team.id, emptyFirstInningProfile(team));
  }

  const first = game.linescore?.innings?.[0];
  if (!first) return;

  const defenseSide = side === 'away' ? 'home' : 'away';
  const offenseRuns = toNumber(first[side]?.runs, 0);
  const allowedRuns = toNumber(first[defenseSide]?.runs, 0);

  profiles.get(team.id).games.push({
    gamePk: game.gamePk,
    date: game.officialDate || game.gameDate,
    scored: offenseRuns > 0,
    allowed: allowedRuns > 0,
    anyRun: offenseRuns + allowedRuns > 0,
    offenseRuns,
    allowedRuns
  });
}

function smoothedRate(count, total, prior, weight = 8) {
  return (count + prior * weight) / (Math.max(0, total) + weight);
}

function summarizeFirstInningGames(games) {
  const total = games.length;
  const scored = games.filter((game) => game.scored).length;
  const allowed = games.filter((game) => game.allowed).length;
  const anyRun = games.filter((game) => game.anyRun).length;

  return {
    games: total,
    scored,
    allowed,
    anyRun,
    scoredRate: smoothedRate(scored, total, DEFAULTS.firstInningRunRate),
    allowedRate: smoothedRate(allowed, total, DEFAULTS.firstInningRunRate),
    anyRunRate: smoothedRate(anyRun, total, DEFAULTS.gameFirstInningRunRate)
  };
}

function finalizeFirstInningProfile(profile) {
  const games = [...profile.games].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const recentGames = games.slice(-10);
  const season = summarizeFirstInningGames(games);
  const recent = summarizeFirstInningGames(recentGames);

  return {
    ...profile,
    games,
    season,
    recent,
    scoredBlend: season.scoredRate * 0.65 + recent.scoredRate * 0.35,
    allowedBlend: season.allowedRate * 0.65 + recent.allowedRate * 0.35,
    anyRunBlend: season.anyRunRate * 0.65 + recent.anyRunRate * 0.35
  };
}

function defaultFirstInningProfile(team) {
  return finalizeFirstInningProfile(emptyFirstInningProfile(team));
}

function pitcherFirstInningRisk(stats) {
  if (!stats) return 0;

  const eraRisk = (statEra(stats) - DEFAULTS.era) / 18;
  const whipRisk = (statWhip(stats) - DEFAULTS.whip) / 6;
  const kbbRisk = (2.2 - kToBb(stats)) / 18;
  return clamp(eraRisk + whipRisk + kbbRisk, -0.1, 0.1);
}

function firstInningProfileLine(profile) {
  const team = profile.team.abbreviation || profile.team.name;
  return `${team} scored 1st ${profile.season.scored}/${profile.season.games}, allowed ${profile.season.allowed}/${profile.season.games}, recent any ${profile.recent.anyRun}/${profile.recent.games}`;
}

function buildFirstInningProjection({
  away,
  home,
  awayProfile,
  homeProfile,
  awayPitcherStats,
  homePitcherStats,
  headToHead
}) {
  const topRate = clamp(
    awayProfile.scoredBlend * 0.55 +
      homeProfile.allowedBlend * 0.45 +
      pitcherFirstInningRisk(homePitcherStats),
    0.08,
    0.58
  );
  const bottomRate = clamp(
    homeProfile.scoredBlend * 0.55 +
      awayProfile.allowedBlend * 0.45 +
      pitcherFirstInningRisk(awayPitcherStats),
    0.08,
    0.58
  );
  const modelProbability = 1 - (1 - topRate) * (1 - bottomRate);
  const h2hGames = headToHead?.firstInning?.games || 0;
  const h2hProbability = (headToHead?.firstInning?.probability || DEFAULTS.gameFirstInningRunRate * 100) / 100;
  const blendedProbability =
    h2hGames >= 3 ? modelProbability * 0.85 + h2hProbability * 0.15 : modelProbability;
  const probability = clamp(blendedProbability * 100, 25, 75);
  const pick = probability >= 52 ? 'YES' : 'NO';

  const reasons = [
    `Top 1: ${away.abbreviation || away.name} offense/allowed profile projects ${percent(topRate * 100)} run chance.`,
    `Bottom 1: ${home.abbreviation || home.name} offense/allowed profile projects ${percent(bottomRate * 100)} run chance.`
  ];

  if (h2hGames > 0) {
    reasons.push(`H2H first-inning run: ${headToHead.firstInning.runGames}/${h2hGames}.`);
  }

  return {
    baselinePick: pick,
    baselineProbability: probability,
    confidence:
      probability >= 60 || probability <= 40 ? 'high' : probability >= 55 || probability <= 45 ? 'medium' : 'low',
    topRate: topRate * 100,
    bottomRate: bottomRate * 100,
    h2h: {
      games: h2hGames,
      runGames: headToHead?.firstInning?.runGames || 0,
      probability: h2hProbability * 100
    },
    awayProfileLine: firstInningProfileLine(awayProfile),
    homeProfileLine: firstInningProfileLine(homeProfile),
    reasons
  };
}

function matchupSplitLine(team, standing, opponentStarter, venueSplitType) {
  const hand = opponentStarter?.pitchHand?.code;
  if (!hand || !['L', 'R'].includes(hand)) {
    return `${team.abbreviation || team.name} vs starter hand: unavailable`;
  }

  const baseType = hand === 'L' ? 'left' : 'right';
  const venueType =
    hand === 'L'
      ? venueSplitType === 'home'
        ? 'leftHome'
        : 'leftAway'
      : venueSplitType === 'home'
        ? 'rightHome'
        : 'rightAway';
  const overall = splitRecord(standing, baseType);
  const venue = splitRecord(standing, venueType);
  const handLabel = hand === 'L' ? 'LHP' : 'RHP';

  return `${team.abbreviation || team.name} vs ${handLabel}: ${splitRecordText(overall)}, ${venueSplitType} ${splitRecordText(venue)}`;
}

async function fetchHeadToHead(game, season, dateYmd) {
  const awayTeamId = game.teams.away.team.id;
  const homeTeamId = game.teams.home.team.id;
  const params = new URLSearchParams({
    sportId: '1',
    season: String(season),
    gameTypes: 'R',
    teamId: String(awayTeamId),
    opponentId: String(homeTeamId),
    startDate: seasonStartDate(season),
    endDate: dateYmd,
    hydrate: 'linescore'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  const games = (data.dates || [])
    .flatMap((date) => date.games || [])
    .filter((item) => item.gamePk !== game.gamePk)
    .filter((item) => item.status?.abstractGameState === 'Final')
    .filter((item) => Number.isFinite(item.teams?.away?.score) && Number.isFinite(item.teams?.home?.score));

  let awayWins = 0;
  let homeWins = 0;
  let firstInningGames = 0;
  let firstInningRunGames = 0;

  for (const item of games) {
    const winnerId =
      item.teams.away.score > item.teams.home.score
        ? item.teams.away.team.id
        : item.teams.home.team.id;

    if (winnerId === awayTeamId) awayWins += 1;
    if (winnerId === homeTeamId) homeWins += 1;

    const first = item.linescore?.innings?.[0];
    if (first) {
      firstInningGames += 1;
      if (toNumber(first.away?.runs, 0) + toNumber(first.home?.runs, 0) > 0) {
        firstInningRunGames += 1;
      }
    }
  }

  const total = awayWins + homeWins;
  const awayProbability = ((awayWins + 1) / (total + 2)) * 100;
  const homeProbability = 100 - awayProbability;
  const firstInningProbability =
    ((firstInningRunGames + DEFAULTS.gameFirstInningRunRate * 4) / (firstInningGames + 4)) * 100;

  return {
    games: total,
    awayWins,
    homeWins,
    awayProbability,
    homeProbability,
    firstInning: {
      games: firstInningGames,
      runGames: firstInningRunGames,
      probability: firstInningProbability
    }
  };
}

function finalGameResult(game, dateYmd) {
  const awayScore = toNumber(game.teams?.away?.score, Number.NaN);
  const homeScore = toNumber(game.teams?.home?.score, Number.NaN);
  const awayTeam = game.teams.away.team;
  const homeTeam = game.teams.home.team;
  const winnerTeam = awayScore > homeScore ? awayTeam : homeTeam;
  const loserTeam = awayScore > homeScore ? homeTeam : awayTeam;
  const first = game.linescore?.innings?.[0];
  const firstInningAwayRuns = toNumber(first?.away?.runs, 0);
  const firstInningHomeRuns = toNumber(first?.home?.runs, 0);

  return {
    gamePk: game.gamePk,
    dateYmd,
    status: game.status?.detailedState || 'Final',
    away: {
      id: awayTeam.id,
      name: awayTeam.name,
      abbreviation: awayTeam.abbreviation,
      score: awayScore
    },
    home: {
      id: homeTeam.id,
      name: homeTeam.name,
      abbreviation: homeTeam.abbreviation,
      score: homeScore
    },
    winner: {
      id: winnerTeam.id,
      name: winnerTeam.name,
      abbreviation: winnerTeam.abbreviation
    },
    loser: {
      id: loserTeam.id,
      name: loserTeam.name,
      abbreviation: loserTeam.abbreviation
    },
    firstInning: {
      awayRuns: firstInningAwayRuns,
      homeRuns: firstInningHomeRuns,
      anyRun: first ? firstInningAwayRuns + firstInningHomeRuns > 0 : null
    }
  };
}

function starterEdge(homePitcherStats, awayPitcherStats) {
  if (!homePitcherStats && !awayPitcherStats) return 0;

  const homeEra = statEra(homePitcherStats);
  const awayEra = statEra(awayPitcherStats);
  const homeWhip = statWhip(homePitcherStats);
  const awayWhip = statWhip(awayPitcherStats);
  const homeKbb = kToBb(homePitcherStats);
  const awayKbb = kToBb(awayPitcherStats);

  return (
    (awayEra - homeEra) / 2.2 +
    (awayWhip - homeWhip) / 0.55 +
    (homeKbb - awayKbb) / 3.5
  );
}

function createReasons({
  home,
  away,
  homeProfile,
  awayProfile,
  homePitcherStats,
  awayPitcherStats,
  homeStarter,
  awayStarter,
  probHome
}) {
  const winner = probHome >= 50 ? home : away;
  const loser = probHome >= 50 ? away : home;
  const winnerProfile = probHome >= 50 ? homeProfile : awayProfile;
  const loserProfile = probHome >= 50 ? awayProfile : homeProfile;
  const winnerPitcherStats = probHome >= 50 ? homePitcherStats : awayPitcherStats;
  const loserPitcherStats = probHome >= 50 ? awayPitcherStats : homePitcherStats;
  const winnerStarter = probHome >= 50 ? homeStarter : awayStarter;
  const loserStarter = probHome >= 50 ? awayStarter : homeStarter;

  const reasons = [];
  const winnerRpg = rpg(winnerProfile?.hitting);
  const loserRpg = rpg(loserProfile?.hitting);
  const winnerOps = statOps(winnerProfile?.hitting);
  const loserOps = statOps(loserProfile?.hitting);
  const winnerIso = statIso(winnerProfile?.hittingAdvanced);
  const loserIso = statIso(loserProfile?.hittingAdvanced);
  const winnerKRate = battingKRate(winnerProfile?.hittingAdvanced);
  const loserKRate = battingKRate(loserProfile?.hittingAdvanced);
  const winnerBbRate = battingBbRate(winnerProfile?.hittingAdvanced);
  const loserBbRate = battingBbRate(loserProfile?.hittingAdvanced);
  const winnerEra = statEra(winnerProfile?.pitching);
  const loserEra = statEra(loserProfile?.pitching);
  const winnerWhip = statWhip(winnerProfile?.pitching);
  const loserWhip = statWhip(loserProfile?.pitching);
  const winnerKMinusBb = pitchingKMinusBb(winnerProfile?.pitchingAdvanced);
  const loserKMinusBb = pitchingKMinusBb(loserProfile?.pitchingAdvanced);
  const winnerHr9 = pitchingHr9(winnerProfile?.pitchingAdvanced);
  const loserHr9 = pitchingHr9(loserProfile?.pitchingAdvanced);
  const winnerSpEra = statEra(winnerPitcherStats);
  const loserSpEra = statEra(loserPitcherStats);
  const winnerSpWhip = statWhip(winnerPitcherStats);
  const loserSpWhip = statWhip(loserPitcherStats);
  const winnerSpKbb = kToBb(winnerPitcherStats);
  const loserSpKbb = kToBb(loserPitcherStats);

  if (
    winnerPitcherStats &&
    loserPitcherStats &&
    (winnerSpEra <= loserSpEra - 0.45 ||
      winnerSpWhip <= loserSpWhip - 0.12 ||
      winnerSpKbb >= loserSpKbb + 0.5)
  ) {
    reasons.push(
      `SP edge: ${winnerStarter?.fullName || winner.name} ERA ${safeFixed(winnerSpEra)}, WHIP ${safeFixed(winnerSpWhip)} vs ${loserStarter?.fullName || loser.name} ERA ${safeFixed(loserSpEra)}, WHIP ${safeFixed(loserSpWhip)}.`
    );
  }

  if (
    winnerRpg >= loserRpg + 0.25 ||
    winnerOps >= loserOps + 0.025 ||
    winnerIso >= loserIso + 0.025 ||
    winnerBbRate >= loserBbRate + 0.02 ||
    winnerKRate <= loserKRate - 0.03
  ) {
    reasons.push(
      `Offense edge: ${winner.name} ${safeFixed(winnerRpg, 2)} R/G, OPS ${safeFixed(winnerOps, 3)}, ISO ${safeFixed(winnerIso, 3)} vs ${loser.name} ${safeFixed(loserRpg, 2)} R/G, OPS ${safeFixed(loserOps, 3)}, ISO ${safeFixed(loserIso, 3)}.`
    );
  }

  if (
    winnerEra <= loserEra - 0.25 ||
    winnerWhip <= loserWhip - 0.08 ||
    winnerKMinusBb >= loserKMinusBb + 0.025 ||
    winnerHr9 <= loserHr9 - 0.2
  ) {
    reasons.push(
      `Pitching team lebih kuat: ERA ${safeFixed(winnerEra)}, WHIP ${safeFixed(winnerWhip)}, K-BB ${ratePct(winnerKMinusBb)} vs ERA ${safeFixed(loserEra)}, WHIP ${safeFixed(loserWhip)}, K-BB ${ratePct(loserKMinusBb)}.`
    );
  }

  const winnerPct = leagueRecordPct(winner.record);
  const loserPct = leagueRecordPct(loser.record);
  if (winnerPct >= loserPct + 0.05) {
    reasons.push(`Form season: win% ${safeFixed(winnerPct, 3)} vs ${safeFixed(loserPct, 3)}.`);
  }

  if (winner.id === home.id) {
    reasons.push('Home field memberi edge kecil.');
  }

  if (reasons.length === 0) {
    reasons.push('Edge tipis dari kombinasi record, offense, pitching, dan venue.');
  }

  return reasons.slice(0, 3);
}

function standingContext(team, standing, venueSplitType) {
  const lastTen = splitRecord(standing, 'lastTen');
  const venue = splitRecord(standing, venueSplitType);
  const xRecord = expectedRecord(standing);
  const streak = standing?.streak?.streakCode || '-';

  return [
    `${team.abbreviation || team.name} ${recordText(standing?.leagueRecord)}`,
    `L10 ${recordText(lastTen)}`,
    `${venueSplitType === 'home' ? 'home' : 'road'} ${recordText(venue)}`,
    `RD ${signed(standing?.runDifferential)}`,
    `xW-L ${recordText(xRecord)}`,
    streak
  ].join(', ');
}

function advancedContext(team, profile) {
  return [
    `${team.abbreviation || team.name}`,
    `ISO ${safeFixed(statIso(profile?.hittingAdvanced), 3)}`,
    `K ${ratePct(battingKRate(profile?.hittingAdvanced))}`,
    `BB ${ratePct(battingBbRate(profile?.hittingAdvanced))}`,
    `Pit K-BB ${ratePct(pitchingKMinusBb(profile?.pitchingAdvanced))}`,
    `HR9 ${safeFixed(pitchingHr9(profile?.pitchingAdvanced), 2)}`
  ].join(' ');
}

function predictGame(
  game,
  teamStats,
  standings,
  pitcherStats,
  pitcherDetails,
  pitcherRecentStarts,
  bullpenProfiles,
  headToHead,
  firstInningProfiles,
  modelMemory
) {
  const awayTeam = game.teams.away.team;
  const homeTeam = game.teams.home.team;
  const awayProfile = teamStats.get(awayTeam.id) || {};
  const homeProfile = teamStats.get(homeTeam.id) || {};
  const awayStanding = standings.get(awayTeam.id) || null;
  const homeStanding = standings.get(homeTeam.id) || null;
  const awayStarter = game.teams.away.probablePitcher
    ? { ...game.teams.away.probablePitcher, ...(pitcherDetails.get(game.teams.away.probablePitcher.id) || {}) }
    : null;
  const homeStarter = game.teams.home.probablePitcher
    ? { ...game.teams.home.probablePitcher, ...(pitcherDetails.get(game.teams.home.probablePitcher.id) || {}) }
    : null;
  const awayPitcherStats = awayStarter ? pitcherStats.get(awayStarter.id) : null;
  const homePitcherStats = homeStarter ? pitcherStats.get(homeStarter.id) : null;
  const awayPitcherRecent = awayStarter ? pitcherRecentStarts.get(awayStarter.id) : null;
  const homePitcherRecent = homeStarter ? pitcherRecentStarts.get(homeStarter.id) : null;
  const awayBullpen = bullpenProfiles.get(awayTeam.id) || finalizeBullpenProfile({ teamId: awayTeam.id, games: 0, bullpenPitches: 0, bullpenOuts: 0, relieverAppearances: 0, relieverDates: new Map(), highPitchRelievers: 0 });
  const homeBullpen = bullpenProfiles.get(homeTeam.id) || finalizeBullpenProfile({ teamId: homeTeam.id, games: 0, bullpenPitches: 0, bullpenOuts: 0, relieverAppearances: 0, relieverDates: new Map(), highPitchRelievers: 0 });
  const awayFirstInningProfile =
    firstInningProfiles.get(awayTeam.id) || defaultFirstInningProfile(awayTeam);
  const homeFirstInningProfile =
    firstInningProfiles.get(homeTeam.id) || defaultFirstInningProfile(homeTeam);

  const homeWinPct = leagueRecordPct(homeStanding?.leagueRecord || game.teams.home.leagueRecord);
  const awayWinPct = leagueRecordPct(awayStanding?.leagueRecord || game.teams.away.leagueRecord);
  const homeRpg = rpg(homeProfile.hitting);
  const awayRpg = rpg(awayProfile.hitting);
  const homeOps = statOps(homeProfile.hitting);
  const awayOps = statOps(awayProfile.hitting);
  const homeIso = statIso(homeProfile.hittingAdvanced);
  const awayIso = statIso(awayProfile.hittingAdvanced);
  const homeBatK = battingKRate(homeProfile.hittingAdvanced);
  const awayBatK = battingKRate(awayProfile.hittingAdvanced);
  const homeBatBb = battingBbRate(homeProfile.hittingAdvanced);
  const awayBatBb = battingBbRate(awayProfile.hittingAdvanced);
  const homeEra = statEra(homeProfile.pitching);
  const awayEra = statEra(awayProfile.pitching);
  const homeWhip = statWhip(homeProfile.pitching);
  const awayWhip = statWhip(awayProfile.pitching);
  const homeKMinusBb = pitchingKMinusBb(homeProfile.pitchingAdvanced);
  const awayKMinusBb = pitchingKMinusBb(awayProfile.pitchingAdvanced);
  const homeHr9 = pitchingHr9(homeProfile.pitchingAdvanced);
  const awayHr9 = pitchingHr9(awayProfile.pitchingAdvanced);
  const homeVenuePct = splitPct(homeStanding, 'home');
  const awayVenuePct = splitPct(awayStanding, 'away');
  const homeLastTenPct = splitPct(homeStanding, 'lastTen');
  const awayLastTenPct = splitPct(awayStanding, 'lastTen');
  const homeRunDiff = runDiffPerGame(homeStanding);
  const awayRunDiff = runDiffPerGame(awayStanding);
  const homePythagoreanPct = pythagoreanWinPct(homeStanding, homeProfile);
  const awayPythagoreanPct = pythagoreanWinPct(awayStanding, awayProfile);
  const homeSeasonLog5 = log5Probability(homeWinPct, awayWinPct);
  const homePythagoreanLog5 = log5Probability(homePythagoreanPct, awayPythagoreanPct);
  const homeRecentLog5 = log5Probability(homeLastTenPct, awayLastTenPct);
  const homeReferenceBlend =
    homeSeasonLog5 * 0.45 + homePythagoreanLog5 * 0.35 + homeRecentLog5 * 0.2;
  const homeMemoryBias = teamMemoryBias(modelMemory, homeTeam.id);
  const awayMemoryBias = teamMemoryBias(modelMemory, awayTeam.id);

  const winPctEdge = homeWinPct - awayWinPct;
  const offenseEdge =
    (homeRpg - awayRpg) / 2.2 +
    (homeOps - awayOps) / 0.14 +
    (homeIso - awayIso) / 0.1 +
    (awayBatK - homeBatK) / 0.16 +
    (homeBatBb - awayBatBb) / 0.12;
  const preventionEdge =
    (awayEra - homeEra) / 1.8 +
    (awayWhip - homeWhip) / 0.55 +
    (homeKMinusBb - awayKMinusBb) / 0.16 +
    (awayHr9 - homeHr9) / 1.2;
  const spEdge = starterEdge(homePitcherStats, awayPitcherStats);
  const formEdge =
    (homeLastTenPct - awayLastTenPct) * 0.45 +
    (homeVenuePct - awayVenuePct) * 0.3 +
    (homeRunDiff - awayRunDiff) / 7;
  const pythagoreanEdge = homePythagoreanPct - awayPythagoreanPct;
  const log5Edge = homeReferenceBlend - 0.5;
  const h2hEdge = headToHead?.games > 0 ? (headToHead.homeProbability - 50) / 50 : 0;
  const memoryEdge = homeMemoryBias - awayMemoryBias;
  const edge =
    winPctEdge * 0.65 +
    offenseEdge * 0.22 +
    preventionEdge * 0.2 +
    spEdge * 0.26 +
    formEdge +
    pythagoreanEdge * 0.35 +
    log5Edge * 0.85 +
    h2hEdge * 0.12 +
    memoryEdge +
    0.18;
  const homeProbability = clamp(sigmoid(edge) * 100, 30, 70);
  const awayProbability = 100 - homeProbability;

  const home = {
    id: homeTeam.id,
    name: homeTeam.name,
    abbreviation: homeTeam.abbreviation,
    record: homeStanding?.leagueRecord || game.teams.home.leagueRecord,
    starter: homeStarter,
    starterLine: pitcherLabel(homeStarter, homePitcherStats),
    winProbability: homeProbability
  };
  const away = {
    id: awayTeam.id,
    name: awayTeam.name,
    abbreviation: awayTeam.abbreviation,
    record: awayStanding?.leagueRecord || game.teams.away.leagueRecord,
    starter: awayStarter,
    starterLine: pitcherLabel(awayStarter, awayPitcherStats),
    winProbability: awayProbability
  };

  const reasons = createReasons({
    home,
    away,
    homeProfile,
    awayProfile,
    homePitcherStats,
    awayPitcherStats,
    homeStarter,
    awayStarter,
    probHome: homeProbability
  });
  const firstInning = buildFirstInningProjection({
    away,
    home,
    awayProfile: awayFirstInningProfile,
    homeProfile: homeFirstInningProfile,
    awayPitcherStats,
    homePitcherStats,
    headToHead
  });

  return {
    gamePk: game.gamePk,
    status: game.status?.detailedState || 'Scheduled',
    start: formatGameTime(game.gameDate),
    venue: game.venue?.name || 'TBD',
    away,
    home,
    contextLine: `${standingContext(away, awayStanding, 'away')} | ${standingContext(home, homeStanding, 'home')}`,
    advancedLine: `${advancedContext(away, awayProfile)} | ${advancedContext(home, homeProfile)}`,
    matchupSplitLine: `${matchupSplitLine(away, awayStanding, homeStarter, 'away')} | ${matchupSplitLine(home, homeStanding, awayStarter, 'home')}`,
    pitcherRecentLine: `${away.abbreviation || away.name} SP ${awayPitcherRecent?.line || 'recent starts unavailable'} | ${home.abbreviation || home.name} SP ${homePitcherRecent?.line || 'recent starts unavailable'}`,
    bullpenLine: `${away.abbreviation || away.name} bullpen ${awayBullpen.line} | ${home.abbreviation || home.name} bullpen ${homeBullpen.line}`,
    modelReferenceLine: `${away.abbreviation || away.name} Pyth ${percent(awayPythagoreanPct * 100)} | ${home.abbreviation || home.name} Pyth ${percent(homePythagoreanPct * 100)} | Log5 home season ${percent(homeSeasonLog5 * 100)}, pyth ${percent(homePythagoreanLog5 * 100)}, recent ${percent(homeRecentLog5 * 100)}`,
    modelReference: {
      awayPythagoreanPct: Math.round(awayPythagoreanPct * 100),
      homePythagoreanPct: Math.round(homePythagoreanPct * 100),
      homeSeasonLog5: Math.round(homeSeasonLog5 * 100),
      homePythagoreanLog5: Math.round(homePythagoreanLog5 * 100),
      homeRecentLog5: Math.round(homeRecentLog5 * 100),
      homeReferenceBlend: Math.round(homeReferenceBlend * 100)
    },
    pitcherRecent: {
      away: awayPitcherRecent,
      home: homePitcherRecent
    },
    bullpen: {
      away: awayBullpen,
      home: homeBullpen
    },
    memoryAdjustment: {
      away: awayMemoryBias,
      home: homeMemoryBias
    },
    headToHead,
    firstInning,
    winner: homeProbability >= awayProbability ? home : away,
    reasons
  };
}

export async function getMlbPredictions(dateYmd = dateInTimezone('Asia/Jakarta'), modelMemory = {}) {
  const season = seasonFromDate(dateYmd);
  const games = await fetchSchedule(dateYmd);
  if (games.length === 0) return [];

  const teamIds = [
    ...new Set(games.flatMap((game) => [game.teams.away.team.id, game.teams.home.team.id]))
  ];

  const [teamStats, standings, firstInningProfiles, bullpenProfiles] = await Promise.all([
    fetchTeamStats(season),
    fetchStandings(season, dateYmd),
    fetchFirstInningProfiles(season, dateYmd),
    fetchBullpenProfiles(teamIds, dateYmd)
  ]);
  const probablePitcherIds = [
    ...new Set(
      games
        .flatMap((game) => [
          game.teams.away.probablePitcher?.id,
          game.teams.home.probablePitcher?.id
        ])
        .filter(Boolean)
    )
  ];

  const pitcherStats = new Map();
  const pitcherDetails = new Map();
  const pitcherRecentStarts = new Map();
  await Promise.all(
    probablePitcherIds.map(async (personId) => {
      try {
        pitcherDetails.set(personId, await fetchPerson(personId));
      } catch {
        pitcherDetails.set(personId, null);
      }

      try {
        pitcherStats.set(personId, await fetchPitcherStats(personId, season));
      } catch {
        pitcherStats.set(personId, null);
      }

      try {
        pitcherRecentStarts.set(personId, await fetchPitcherRecentStarts(personId, season));
      } catch {
        pitcherRecentStarts.set(personId, null);
      }
    })
  );

  const headToHeadStats = new Map();
  await Promise.all(
    games.map(async (game) => {
      try {
        headToHeadStats.set(game.gamePk, await fetchHeadToHead(game, season, dateYmd));
      } catch {
        headToHeadStats.set(game.gamePk, {
          games: 0,
          awayWins: 0,
          homeWins: 0,
          awayProbability: 50,
          homeProbability: 50,
          firstInning: {
            games: 0,
            runGames: 0,
            probability: DEFAULTS.gameFirstInningRunRate * 100
          }
        });
      }
    })
  );

  return games.map((game) =>
    predictGame(
      game,
      teamStats,
      standings,
      pitcherStats,
      pitcherDetails,
      pitcherRecentStarts,
      bullpenProfiles,
      headToHeadStats.get(game.gamePk),
      firstInningProfiles,
      modelMemory
    )
  );
}

export async function getMlbScheduleChoices(dateYmd = dateInTimezone('Asia/Jakarta')) {
  const games = await fetchSchedule(dateYmd);

  return games.map((game) => ({
    gamePk: game.gamePk,
    status: game.status?.detailedState || 'Scheduled',
    abstractGameState: game.status?.abstractGameState || '',
    start: formatGameTime(game.gameDate),
    venue: game.venue?.name || 'TBD',
    away: {
      id: game.teams.away.team.id,
      name: game.teams.away.team.name,
      abbreviation: game.teams.away.team.abbreviation
    },
    home: {
      id: game.teams.home.team.id,
      name: game.teams.home.team.name,
      abbreviation: game.teams.home.team.abbreviation
    },
    probablePitchers: {
      away: game.teams.away.probablePitcher?.fullName || 'TBD',
      home: game.teams.home.probablePitcher?.fullName || 'TBD'
    }
  }));
}

export async function getFinalGameResults(dateYmd = dateInTimezone('Asia/Jakarta')) {
  const games = await fetchSchedule(dateYmd);

  return games
    .filter((game) => game.status?.abstractGameState === 'Final')
    .filter((game) =>
      Number.isFinite(toNumber(game.teams?.away?.score, Number.NaN)) &&
      Number.isFinite(toNumber(game.teams?.home?.score, Number.NaN))
    )
    .map((game) => finalGameResult(game, dateYmd));
}

export function formatPredictions(
  dateYmd,
  predictions,
  { maxGames = 8, teamFilter = '', includeAdvanced = true } = {}
) {
  const normalizedFilter = teamFilter.toLowerCase();
  const filtered = normalizedFilter
    ? predictions.filter((item) =>
        [item.away.name, item.home.name, item.away.abbreviation, item.home.abbreviation]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedFilter))
      )
    : predictions;

  if (filtered.length === 0) {
    return normalizedFilter
      ? `Tidak ada game MLB untuk filter "${teamFilter}" pada ${dateYmd}.`
      : `Tidak ada game MLB pada ${dateYmd}.`;
  }

  const shown = filtered.slice(0, maxGames);
  const lines = [`⚾ MLB Pre-game Alert\n📅 ${dateYmd}`, GAME_SEPARATOR];

  for (const item of shown) {
    const displayProb = displayedProbabilities(item);
    const pick = agentPick(item);
    const agentActive = Boolean(item.agentAnalysis);
    const contextLines = splitInfoLine(item.contextLine);
    const splitLines = splitInfoLine(item.matchupSplitLine);
    const bullpenLines = splitInfoLine(item.bullpenLine);
    const pitcherRecentLines = splitInfoLine(item.pitcherRecentLine);
    const advancedLines = splitInfoLine(item.advancedLine);
    const modelReferenceLines = splitInfoLine(item.modelReferenceLine);
    const firstInningReasonLines = item.firstInning.agent?.reasons?.length
      ? item.firstInning.agent.reasons.map((reason) => `• ${reason}`)
      : item.firstInning.reasons.map((reason) => `• ${reason}`);
    const h2hSummary =
      item.headToHead?.games > 0
        ? `${item.away.abbreviation || item.away.name} ${item.headToHead.awayWins}-${item.headToHead.homeWins} ${item.home.abbreviation || item.home.name}`
        : 'Belum ada final H2H musim ini';

    lines.push(
      [
        `🏟️ ${item.away.name} @ ${item.home.name}`,
        `🕒 ${item.start}`,
        `📍 ${item.venue}`,
        '',
        SECTION_SEPARATOR,
        '📊 Probabilitas',
        agentActive
          ? `🤖 Agent: ${displayedWinProbText(item.away, displayProb.away)}  |  ${displayedWinProbText(item.home, displayProb.home)}`
          : `Model: ${winProbText(item.away)}  |  ${winProbText(item.home)}`,
        agentActive ? `📐 Baseline: ${winProbText(item.away)}  |  ${winProbText(item.home)}` : null,
        `🤝 H2H: ${h2hSummary}`,
        `🎯 H2H Prob: ${h2hProbText(item.away, item.headToHead?.awayProbability ?? 50)}  |  ${h2hProbText(item.home, item.headToHead?.homeProbability ?? 50)}`,
        '',
        SECTION_SEPARATOR,
        `✅ Pick ${agentActive ? 'Agent' : 'Model'}: ${pick.name}${agentActive ? ` (${item.agentAnalysis.confidence})` : ''}`,
        `🔥 SP: ${item.away.starterLine} vs ${item.home.starterLine}`,
        '',
        SECTION_SEPARATOR,
        '📌 Context',
        ...contextLines,
        '',
        '⚾ Splits',
        ...splitLines,
        '',
        '🧤 Bullpen',
        ...bullpenLines,
        '',
        '📈 SP Recent',
        ...pitcherRecentLines,
        includeAdvanced ? '' : null,
        includeAdvanced ? '🔎 Advanced' : null,
        ...(includeAdvanced ? advancedLines : []),
        includeAdvanced ? '' : null,
        includeAdvanced ? '🧠 ML Reference' : null,
        ...(includeAdvanced ? modelReferenceLines : []),
        '',
        SECTION_SEPARATOR,
        agentActive ? '💡 Analisa Agent' : '💡 Alasan',
        agentActive
          ? item.agentAnalysis.reasons.map((reason) => `• ${reason}`).join('\n')
          : item.reasons.join(' '),
        agentActive ? `⚠️ Risk: ${item.agentAnalysis.risk}` : null,
        agentActive ? `🧠 Memory: ${item.agentAnalysis.memoryNote}` : null,
        '',
        SECTION_SEPARATOR,
        '🏁 First Inning',
        `Will there be a run in the 1st? ${firstInningPickText(item.firstInning)}`,
        `Baseline: ${item.firstInning.baselinePick} ${percent(item.firstInning.baselineProbability)}`,
        `Top 1: ${percent(item.firstInning.topRate)}  |  Bottom 1: ${percent(item.firstInning.bottomRate)}`,
        '',
        ...splitInfoLine(`${item.firstInning.awayProfileLine} | ${item.firstInning.homeProfileLine}`),
        '',
        ...firstInningReasonLines
      ]
        .filter((line) => line !== null)
        .join('\n')
    );
    lines.push(GAME_SEPARATOR);
  }

  if (filtered.length > shown.length) {
    lines.push(`➕ ${filtered.length - shown.length} game lain. Pakai /game TEAM untuk cek spesifik.`);
  }

  lines.push('⚠️ Note: probabilitas adalah estimasi model, bukan kepastian.');
  return lines.join('\n\n');
}
