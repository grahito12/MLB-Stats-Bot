import { uiBullet, uiKV, uiTitle } from './telegramFormat.js';

const ODDS_API_URL = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/odds';
const DEFAULT_INTERVAL_MINUTES = 10;
const MONEYLINE_MOVE_THRESHOLD = 15;
const MONITOR_TTL_HOURS = 18;
const ALERT_DEDUPE_TTL_HOURS = 18;

const activeMonitors = new Map();
const state = {
  bot: null,
  storage: null,
  config: {}
};

let missingKeyLogged = false;
let oddsCache = {
  fetchedAt: 0,
  dataFetchedAt: 0,
  data: []
};

// Test seam: injectable fetch + cache reset so the key-rotation path in
// fetchOdds can be unit-tested without real network or the 10-min cache TTL.
let oddsFetchImpl = null;
export function __setOddsFetchForTest(fn) {
  oddsFetchImpl = fn;
}
export function __resetOddsCacheForTest() {
  oddsCache = { fetchedAt: 0, dataFetchedAt: 0, data: [] };
  missingKeyLogged = false;
}
export async function __fetchOddsForTest() {
  return fetchOdds();
}

// How long a single odds fetch is reused before hitting the API again. The old
// 30s value, combined with the 60s closing-capture scheduler, fired ~1 call per
// tick: ~1440 calls/day x 1 credit (h2h x us region) = ~1440 credits/day,
// which exhausts an Odds API free-tier 500-credit MONTH in ~4 hours (the live
// 401 OUT_OF_USAGE_CREDITS we hit). Closing lines move slowly, so a multi-minute
// cache loses no real signal. Override with ODDS_CACHE_TTL_MS for a paid plan.
function oddsCacheTtlMs() {
  const configured = Number(process.env.ODDS_CACHE_TTL_MS);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return 10 * 60 * 1000; // 10 minutes
}

function intervalMinutes() {
  const configured = Number(state.config?.lineMonitor?.intervalMinutes);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const envValue = Number.parseInt(process.env.LINE_MONITOR_INTERVAL_MINUTES || '', 10);
  return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_INTERVAL_MINUTES;
}

function lineAlertsEnabled() {
  const configured = state.config?.lineMonitor?.enabled;
  if (typeof configured === 'boolean') return configured;

  const value = process.env.LINE_MOVEMENT_ALERTS;
  if (value === undefined || value === '') return true;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function chatLineAlertsEnabled(chatId) {
  if (!lineAlertsEnabled()) return false;
  if (!state.storage?.getLineMovementAlerts || chatId === undefined || chatId === null) return true;

  return state.storage.getLineMovementAlerts(chatId).enabled !== false;
}

function moneylineMoveThreshold() {
  const configured = Number(state.config?.lineMonitor?.moneylineThreshold);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const envValue = Number(process.env.LINE_MOVEMENT_THRESHOLD_ML || '');
  return Number.isFinite(envValue) && envValue > 0 ? envValue : MONEYLINE_MOVE_THRESHOLD;
}

// Odds API key pool. Supports multiple keys so several free-tier accounts
// (500 credits/month each) can be chained: when one returns OUT_OF_USAGE_CREDITS
// the pool rotates to the next and remembers the exhausted one for a cooldown so
// it isn't retried every cycle. Sources (all merged, de-duped, order preserved):
//   * state.config.lineMonitor.oddsApiKey (may itself be comma-separated)
//   * ODDS_API_KEY / THE_ODDS_API_KEY (each may be comma-separated)
//   * ODDS_API_KEYS (comma-separated list, the canonical multi-key var)
const EXHAUSTED_COOLDOWN_MS = 12 * 60 * 60 * 1000; // retry an exhausted key after 12h
const exhaustedKeys = new Map(); // key -> timestamp when marked exhausted

export function parseOddsApiKeys() {
  const raw = [
    state.config?.lineMonitor?.oddsApiKey,
    process.env.ODDS_API_KEY,
    process.env.THE_ODDS_API_KEY,
    process.env.ODDS_API_KEYS
  ];
  const keys = [];
  for (const value of raw) {
    if (!value) continue;
    for (const part of String(value).split(',')) {
      const key = part.trim();
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

// Keys not currently in cooldown, in priority order. Expired cooldowns are
// cleared so a key becomes usable again after EXHAUSTED_COOLDOWN_MS (covers the
// monthly quota reset without needing to know each account's exact reset date).
function availableOddsApiKeys(now = Date.now()) {
  return parseOddsApiKeys().filter((key) => {
    const exhaustedAt = exhaustedKeys.get(key);
    if (exhaustedAt === undefined) return true;
    if (now - exhaustedAt >= EXHAUSTED_COOLDOWN_MS) {
      exhaustedKeys.delete(key);
      return true;
    }
    return false;
  });
}

function markKeyExhausted(key, now = Date.now()) {
  if (key) exhaustedKeys.set(key, now);
}

// Test/ops hook: clear cooldown state so all keys are considered available again.
export function resetOddsApiKeyPool() {
  exhaustedKeys.clear();
}

// Legacy single-key accessor (first available, or first configured). Kept so any
// other caller/logging that referenced oddsApiKey() still works.
function oddsApiKey() {
  return availableOddsApiKeys()[0] || parseOddsApiKeys()[0] || '';
}

function monitorKey(games, chatId) {
  const gameIds = games
    .map((game) => String(game.gamePk || game.game_id || game.id || ''))
    .filter(Boolean)
    .sort()
    .join(',');
  return `${chatId}:${gameIds}`;
}

function isFinalStatus(status) {
  const value = String(status || '').toLowerCase();
  return (
    value.includes('final') ||
    value.includes('completed') ||
    value.includes('cancelled') ||
    value.includes('canceled') ||
    value.includes('postponed')
  );
}

// Canonical team tokens keyed by distinctive nickname/city words. Both the MLB
// StatsAPI name and the Odds API name reduce to the same token, so matching no
// longer depends on full-string substring equality (which silently dropped
// relocated/aliased clubs like the Athletics and accented names). Each entry's
// key is a word that appears in the team's name on BOTH feeds.
const TEAM_TOKENS = {
  diamondbacks: 'ari', dbacks: 'ari',
  braves: 'atl',
  orioles: 'bal',
  red: 'bos', // "red sox"
  cubs: 'chc',
  sox: 'chw', // "white sox" — disambiguated below by "white"/"red"
  reds: 'cin',
  guardians: 'cle', indians: 'cle',
  rockies: 'col',
  tigers: 'det',
  astros: 'hou',
  royals: 'kc',
  angels: 'laa',
  dodgers: 'lad',
  marlins: 'mia',
  brewers: 'mil',
  twins: 'min',
  mets: 'nym',
  yankees: 'nyy',
  athletics: 'oak', // covers "Athletics", "Oakland Athletics", "Las Vegas Athletics"
  phillies: 'phi',
  pirates: 'pit',
  padres: 'sd',
  mariners: 'sea',
  giants: 'sf',
  cardinals: 'stl',
  rays: 'tb',
  rangers: 'tex',
  jays: 'tor', // "blue jays"
  nationals: 'was'
};

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents (e.g. Pena, Jose)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bst\b/g, 'saint')
    .replace(/\s+/g, ' ')
    .trim();
}

// Map a team name (from either feed) to a stable 2-3 letter token. Handles the
// two Sox by requiring the qualifying word; falls back to the normalized name
// when no token matches so unknown/new teams still compare by string.
export function teamToken(value) {
  const norm = normalizeName(value);
  if (!norm) return '';
  const words = new Set(norm.split(' '));
  if (words.has('sox')) {
    if (words.has('white')) return 'chw';
    if (words.has('red')) return 'bos';
  }
  for (const word of words) {
    if (TEAM_TOKENS[word]) return TEAM_TOKENS[word];
  }
  return norm;
}

export function namesMatch(left, right) {
  const a = teamToken(left);
  const b = teamToken(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // Fall back to substring comparison only when neither side resolved to a
  // known token (both are raw normalized names), preserving prior leniency.
  const knownA = Object.values(TEAM_TOKENS).includes(a) || a === 'chw' || a === 'bos';
  const knownB = Object.values(TEAM_TOKENS).includes(b) || b === 'chw' || b === 'bos';
  if (knownA || knownB) return false;
  return a.includes(b) || b.includes(a);
}

// Minutes between a game's scheduled first pitch and an odds event's commence
// time. Used to disambiguate doubleheaders, where both games share team names
// but the Odds API lists two events at different times. Returns Infinity when
// either timestamp is missing/unparseable so name-only matches still work.
function startTimeGapMinutes(game, event) {
  const gameStart = Date.parse(game?.startTime || game?.gameDate || game?.gameTime || '');
  const eventStart = Date.parse(event?.commence_time || '');
  if (!Number.isFinite(gameStart) || !Number.isFinite(eventStart)) return Infinity;
  return Math.abs(gameStart - eventStart) / 60000;
}

export function findEventForGame(game, events) {
  const matches = (events || []).filter((event) => {
    const homeMatches = namesMatch(event.home_team, game.home?.name);
    const awayMatches = namesMatch(event.away_team, game.away?.name);
    return homeMatches && awayMatches;
  });
  if (matches.length <= 1) return matches[0];
  // Doubleheader (or duplicate listing): pick the event whose commence_time is
  // closest to this game's scheduled start so each leg maps to its own line.
  return matches.reduce((best, event) =>
    startTimeGapMinutes(game, event) < startTimeGapMinutes(game, best) ? event : best
  );
}

function findOutcome(outcomes, teamName) {
  return outcomes.find((outcome) => namesMatch(outcome.name, teamName));
}

function firstMarket(bookmakers, key) {
  for (const bookmaker of bookmakers || []) {
    const market = (bookmaker.markets || []).find((item) => item.key === key);
    if (market?.outcomes?.length) {
      return { bookmaker, market };
    }
  }

  return null;
}

// American odds → decimal payout. Higher decimal = better price for the bettor
// (+160 beats +150; -110 beats -120). Used to line-shop the best moneyline.
function americanToDecimal(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? odds / 100 + 1 : 100 / Math.abs(odds) + 1;
}

// Line shopping: scan EVERY bookmaker's market for the outcome matching teamName
// and return the single best price across all books, plus which book offered it.
// Betting each side at its best available price is free CLV — the model and edge
// are unchanged, only the price improves.
function bestMoneylineForTeam(bookmakers, teamName) {
  let best = null;
  for (const bookmaker of bookmakers || []) {
    const market = (bookmaker.markets || []).find((item) => item.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const outcome = findOutcome(market.outcomes, teamName);
    const price = toFiniteNumber(outcome?.price);
    if (price === null) continue;
    const decimal = americanToDecimal(price);
    if (decimal === null) continue;
    if (!best || decimal > best.decimal) {
      best = { price, decimal, book: bookmaker.title || bookmaker.key || 'bookmaker' };
    }
  }
  return best;
}

// Sharp reference: Pinnacle/Circa lines are the most efficient (sharpest) books.
// Comparing the model pick's odds at a sharp book vs the retail book (The Odds API
// aggregate) detects steam moves and sharp money more reliably than retail-only.
const SHARP_BOOK_KEYS = new Set(['pinnacle', 'pinnacle_es', 'circa', 'circa_sports']);
const SHARP_BOOK_TITLES = new Set(['pinnacle', 'circa']);

function sharpBookMoneyline(bookmakers, teamName) {
  let sharp = null;
  for (const bookmaker of bookmakers || []) {
    const key = String(bookmaker.key || '').toLowerCase();
    const title = String(bookmaker.title || '').toLowerCase();
    if (!SHARP_BOOK_KEYS.has(key) && !SHARP_BOOK_TITLES.has(title)) continue;
    const market = (bookmaker.markets || []).find((item) => item.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const outcome = findOutcome(market.outcomes, teamName);
    const price = toFiniteNumber(outcome?.price);
    if (price === null) continue;
    const decimal = americanToDecimal(price);
    if (decimal === null) continue;
    if (!sharp || decimal > sharp.decimal) {
      sharp = { price, decimal, book: bookmaker.title || bookmaker.key || 'sharp' };
    }
  }
  return sharp;
}

// Best retail (non-sharp) moneyline for a team. Separating sharp books out is
// required for a meaningful sharp-vs-retail comparison: bestMoneylineForTeam
// can return a Pinnacle/Circa price, which would make "divergence" zero or noise.
function bestRetailMoneylineForTeam(bookmakers, teamName) {
  let best = null;
  for (const bookmaker of bookmakers || []) {
    const key = String(bookmaker.key || '').toLowerCase();
    const title = String(bookmaker.title || '').toLowerCase();
    if (SHARP_BOOK_KEYS.has(key) || SHARP_BOOK_TITLES.has(title)) continue;
    const market = (bookmaker.markets || []).find((item) => item.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const outcome = findOutcome(market.outcomes, teamName);
    const price = toFiniteNumber(outcome?.price);
    if (price === null) continue;
    const decimal = americanToDecimal(price);
    if (decimal === null) continue;
    if (!best || decimal > best.decimal) {
      best = { price, decimal, book: bookmaker.title || bookmaker.key || 'bookmaker' };
    }
  }
  return best;
}

// Detect sharp-vs-retail line divergence: if Pinnacle moved but retail books
// haven't followed yet, the retail line is stale and the model pick may have
// more (or less) value than it appears.
// Compare on IMPLIED PROBABILITY, not American odds. Subtracting American
// prices across the sign boundary (+150 - (-110) = 260) is not a meaningful
// probability gap and mislabels direction.
function sharpRetailDivergence(bookmakers, teamName) {
  const sharp = sharpBookMoneyline(bookmakers, teamName);
  const retail = bestRetailMoneylineForTeam(bookmakers, teamName);
  if (!sharp || !retail) return null;
  const sharpImplied = americanImpliedProbability(sharp.price);
  const retailImplied = americanImpliedProbability(retail.price);
  if (sharpImplied === null || retailImplied === null) return null;
  // Positive = sharp prices the team as MORE likely than retail (retail is soft
  // if we want the other side; retail is a better bettor price if we want this side).
  const diffPp = Math.round((sharpImplied - retailImplied) * 1000) / 10; // percentage points
  if (Math.abs(diffPp) < 1.0) return null; // ignore <1pp noise
  return {
    sharpPrice: sharp.price,
    retailPrice: retail.price,
    sharpImplied: Math.round(sharpImplied * 1000) / 10,
    retailImplied: Math.round(retailImplied * 1000) / 10,
    divergence: diffPp,
    direction: diffPp > 0 ? 'sharp_higher' : 'sharp_lower'
  };
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function originalModelEdge(game) {
  const agentPickId = game.agentAnalysis?.pickTeamId;
  const isAwayAgentPick = String(agentPickId) === String(game.away?.id);
  const isHomeAgentPick = String(agentPickId) === String(game.home?.id);
  const pick =
    isAwayAgentPick
      ? game.away
      : isHomeAgentPick
        ? game.home
        : game.pick || game.winner;
  const agentProbability =
    isAwayAgentPick
      ? game.agentAnalysis?.awayProbability
      : isHomeAgentPick
        ? game.agentAnalysis?.homeProbability
        : null;
  const pickProbability = Number(agentProbability ?? pick?.winProbability);

  return Number.isFinite(pickProbability) ? pickProbability - 50 : null;
}

function buildSnapshot(game, event) {
  const h2h = firstMarket(event.bookmakers, 'h2h');
  // Line shopping: take the best moneyline price for each side across ALL books,
  // not just the first book that lists the market.
  const bestHome = bestMoneylineForTeam(event.bookmakers, game.home?.name);
  const bestAway = bestMoneylineForTeam(event.bookmakers, game.away?.name);
  const moneylineBook = bestHome?.book || bestAway?.book || h2h?.bookmaker?.title || h2h?.bookmaker?.key || 'bookmaker';

  // Sharp book reference: Pinnacle/Circa lines detect steam moves earlier
  // than retail books (The Odds API aggregate).
  const sharpHome = sharpBookMoneyline(event.bookmakers, game.home?.name);
  const sharpAway = sharpBookMoneyline(event.bookmakers, game.away?.name);
  const sharpDivergenceHome = sharpRetailDivergence(event.bookmakers, game.home?.name);
  const sharpDivergenceAway = sharpRetailDivergence(event.bookmakers, game.away?.name);

  return {
    gamePk: String(game.gamePk || game.game_id || game.id || ''),
    matchup: `${game.away?.name || event.away_team} @ ${game.home?.name || event.home_team}`,
    homeTeam: game.home?.name || event.home_team,
    awayTeam: game.away?.name || event.away_team,
    homeAbbreviation: game.home?.abbreviation || game.home?.name || event.home_team,
    awayAbbreviation: game.away?.abbreviation || game.away?.name || event.away_team,
    homeMoneyline: bestHome ? bestHome.price : null,
    awayMoneyline: bestAway ? bestAway.price : null,
    homeMoneylineBook: bestHome?.book || null,
    awayMoneylineBook: bestAway?.book || null,
    moneylineBook,
    sharpHomeMoneyline: sharpHome?.price || null,
    sharpAwayMoneyline: sharpAway?.price || null,
    sharpDivergence: sharpDivergenceHome || sharpDivergenceAway,
    originalModelEdge: originalModelEdge(game)
  };
}

async function fetchOdds() {
  if (Date.now() - oddsCache.fetchedAt < oddsCacheTtlMs()) {
    return oddsCache.data;
  }

  const keys = availableOddsApiKeys();
  if (!keys.length) {
    if (!missingKeyLogged) {
      const anyConfigured = parseOddsApiKeys().length > 0;
      console.warn(
        anyConfigured
          ? 'Odds API unavailable: all keys are in cooldown (quota exhausted). Add more via ODDS_API_KEYS or wait for reset.'
          : 'Odds API unavailable: ODDS_API_KEY/THE_ODDS_API_KEY/ODDS_API_KEYS belum diisi.'
      );
      missingKeyLogged = true;
    }
    return oddsCache.data.length ? oddsCache.data : [];
  }
  missingKeyLogged = false;

  let lastError = null;
  for (const key of keys) {
    const url = new URL(ODDS_API_URL);
    url.searchParams.set('apiKey', key);
    url.searchParams.set('regions', 'us');
    url.searchParams.set('markets', 'h2h');
    url.searchParams.set('oddsFormat', 'american');
    url.searchParams.set('dateFormat', 'iso');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const doFetch = oddsFetchImpl || fetch;
      const response = await doFetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'mlb-stats-bot/line-monitor' }
      });

      if (!response.ok) {
        // Quota exhaustion: cool the key down and try the next one.
        // Transient HTTP (429/5xx/timeouts): also try the next key — a single
        // flaky key must not skip the rest of a healthy pool for this cycle.
        // Permanent client errors (400/403) are not key-specific either, so
        // rotate once more rather than short-circuiting the whole fetch.
        const bodyText = await response.text().catch(() => '');
        const isQuota =
          response.status === 401 && /OUT_OF_USAGE_CREDITS|usage quota/i.test(bodyText);
        if (isQuota) {
          markKeyExhausted(key);
          console.warn(`Odds API key exhausted (quota); rotating. ${availableOddsApiKeys().length} key(s) left.`);
          lastError = new Error(`${response.status} quota exhausted`);
          continue;
        }
        lastError = new Error(`${response.status} ${response.statusText}`);
        console.warn(`Odds API key failed (${response.status}); trying next key if any.`);
        continue;
      }

      const data = await response.json();
      const fetchedAt = Date.now();
      oddsCache = { fetchedAt, dataFetchedAt: fetchedAt, data };
      return data;
    } catch (err) {
      // Network/abort/parse failure on this key: keep going to the next key.
      // Do NOT reset oddsCache.fetchedAt here — that would re-arm the TTL and
      // serve stale data for another full cycle on every transient failure.
      lastError = err;
      console.warn(`Odds API key threw (${err?.message || err}); trying next key if any.`);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  // Every available key failed this pass (quota, HTTP, or network). Return
  // cache-or-empty rather than throwing — callers treat [] as "no odds", and
  // throwing would spam logs every cycle. Keep prior dataFetchedAt so a
  // subsequent success can still report real freshness.
  if (lastError) {
    console.warn(`Odds API: all keys failed this cycle (${lastError.message || lastError}); serving cache.`);
  }
  oddsCache = { fetchedAt: Date.now(), dataFetchedAt: oddsCache.dataFetchedAt || 0, data: oddsCache.data };
  return oddsCache.data.length ? oddsCache.data : [];
}

export async function attachCurrentOdds(games = []) {
  const activeGames = Array.isArray(games)
    ? games.filter((game) => game?.gamePk && !isFinalStatus(game.status))
    : [];
  const result = {
    checkedGames: activeGames.length,
    matchedGames: 0,
    hasOddsApiKey: Boolean(oddsApiKey())
  };

  if (!activeGames.length) return result;

  const events = await fetchOdds();
  const fetchedAtIso = new Date(oddsCache.dataFetchedAt || oddsCache.fetchedAt || Date.now()).toISOString();
  for (const game of activeGames) {
    const event = findEventForGame(game, events);
    if (!event) continue;

    const snapshot = buildSnapshot(game, event);
    game.currentOdds = {
      moneylineBook: snapshot.moneylineBook,
      awayMoneylineBook: snapshot.awayMoneylineBook,
      homeMoneylineBook: snapshot.homeMoneylineBook,
      awayMoneyline: snapshot.awayMoneyline,
      homeMoneyline: snapshot.homeMoneyline,
      oddsFetchedAt: fetchedAtIso
    };
    result.matchedGames += 1;

    // P1 market tape: capture complete same-book home/away quote pairs for the
    // all-game research dataset. Best-effort — never breaks odds attachment.
    try {
      const pairs = extractSameBookQuotePairs(game, event);
      if (pairs.length && state.storage?.recordMarketQuotePair) {
        const firstPitch = game.startTime || game.firstPitchUtc || null;
        const asOf = fetchedAtIso;
        for (const pair of pairs) {
          state.storage.recordMarketQuotePair({
            ...pair,
            fetchedAtUtc: fetchedAtIso,
            observedAtUtc: pair.bookmakerLastUpdate || fetchedAtIso,
            firstPitchUtc: firstPitch,
            asOfUtc: asOf
          });
        }
      }
    } catch {
      // market tape is research-only; never block the live path
    }
  }

  return result;
}

function formatOdds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return parsed > 0 ? `+${parsed}` : String(parsed);
}

function formatSigned(value, decimals = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(decimals)}`;
}

export function americanImpliedProbability(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

/**
 * Extract complete same-book home/away moneyline quote pairs from raw Odds API
 * bookmaker markets. Each pair has BOTH prices from the SAME bookmaker — this
 * is the market tape for no-vig consensus, separate from best-price line
 * shopping (which serves betting). Returns [] when no complete pairs exist.
 *
 * Pairs include home/away odds, implied probabilities, overround, no-vig
 * probabilities, and bookmaker last_update when supplied. The caller (storage)
 * stamps fetched_at_utc and enforces first-pitch guards.
 */
export function extractSameBookQuotePairs(game, event) {
  if (!event?.bookmakers || !game?.home?.name || !game?.away?.name) return [];
  const homeName = game.home.name;
  const awayName = game.away.name;
  const pairs = [];

  for (const bookmaker of event.bookmakers) {
    const h2h = (bookmaker.markets || []).find((m) => m.key === 'h2h' || m.key === 'moneyline');
    if (!h2h?.outcomes?.length) continue;
    const homeOutcome = h2h.outcomes.find((o) => namesMatch(o.name, homeName));
    const awayOutcome = h2h.outcomes.find((o) => namesMatch(o.name, awayName));
    if (!homeOutcome || !awayOutcome) continue;

    const homeOdds = toFiniteNumber(homeOutcome.price);
    const awayOdds = toFiniteNumber(awayOutcome.price);
    if (homeOdds === null || awayOdds === null) continue;

    const homeImplied = americanImpliedProbability(homeOdds);
    const awayImplied = americanImpliedProbability(awayOdds);
    if (homeImplied == null || awayImplied == null) continue;

    const overround = homeImplied + awayImplied;
    const homeNoVig = overround > 0 ? homeImplied / overround : null;
    const awayNoVig = overround > 0 ? awayImplied / overround : null;

    pairs.push({
      gamePk: String(game.gamePk || ''),
      sourceEventId: event.id || null,
      bookmaker: bookmaker.key || bookmaker.title || 'unknown',
      market: 'moneyline',
      homeOdds,
      awayOdds,
      homeImpliedProb: homeImplied,
      awayImpliedProb: awayImplied,
      overround,
      homeNoVigProb: homeNoVig,
      awayNoVigProb: awayNoVig,
      bookmakerLastUpdate: h2h.last_update || bookmaker.last_update || null
    });
  }

  return pairs;
}

function movementArrow(movement) {
  const previous = americanImpliedProbability(movement.previousValue);
  const current = americanImpliedProbability(movement.currentValue);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) {
    return movement.delta > 0 ? '↗️' : '↘️';
  }

  return current >= previous ? '↗️' : '↘️';
}

function formatOriginalModelEdge(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  return `${formatSigned(parsed, 1)}%`;
}

function formatMovementLine(movement) {
  const arrow = movementArrow(movement);
  return uiKV('💰', 'Moneyline', `${movement.teamLabel} | ${movement.oldText} -> ${movement.newText} ${arrow}`);
}

function formatMovementAlert({ snapshot, movements }) {
  const edge = formatOriginalModelEdge(snapshot.originalModelEdge);
  return [
    uiTitle('📊', 'Line Movement Alert'),
    uiKV('🏟️', 'Matchup', snapshot.matchup),
    ...movements.map(formatMovementLine),
    uiBullet('⚠️', 'This may indicate sharp money.'),
    edge ? uiKV('🎯', 'Original model edge', edge) : null
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeAlertValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value || '');
  return parsed.toFixed(3);
}

function movementAlertKey(movement, chatId) {
  return [
    'line-move',
    chatId,
    movement.gamePk,
    movement.storageMarket || movement.market,
    movement.bookmaker || '',
    normalizeAlertValue(movement.previousValue),
    normalizeAlertValue(movement.currentValue)
  ].join(':');
}

function reserveMovementAlert(movement, chatId) {
  if (!state.storage?.reserveLineAlert) return true;
  const key = movementAlertKey(movement, chatId);
  return state.storage.reserveLineAlert(key, movement, chatId, new Date().toISOString(), ALERT_DEDUPE_TTL_HOURS);
}

function snapshotFields(snapshot) {
  return [
    {
      market: 'moneyline_home',
      type: 'moneyline',
      teamLabel: snapshot.homeAbbreviation,
      value: snapshot.homeMoneyline,
      threshold: moneylineMoveThreshold(),
      unit: 'cents',
      formatter: formatOdds,
      bookmaker: snapshot.moneylineBook
    },
    {
      market: 'moneyline_away',
      type: 'moneyline',
      teamLabel: snapshot.awayAbbreviation,
      value: snapshot.awayMoneyline,
      threshold: moneylineMoveThreshold(),
      unit: 'cents',
      formatter: formatOdds,
      bookmaker: snapshot.moneylineBook

    }
  ].filter((field) => Number.isFinite(field.value));
}

async function compareSnapshot(snapshot, chatId, { sendAlerts = true } = {}) {
  const result = {
    initializedCount: 0,
    movements: [],
    alertSent: false,
    alertText: ''
  };

  if (!state.storage) return result;
  const timestamp = new Date().toISOString();

  for (const field of snapshotFields(snapshot)) {
    const previous = state.storage.getLineSnapshot(snapshot.gamePk, field.market);
    state.storage.setLineSnapshot(snapshot.gamePk, field.market, field.value, timestamp);

    if (!previous) {
      result.initializedCount += 1;
      continue;
    }

    const oldValue = Number(previous.value);
    const delta = field.value - oldValue;
    if (!Number.isFinite(delta) || Math.abs(delta) < field.threshold) continue;

    result.movements.push({
      gamePk: snapshot.gamePk,
      matchup: snapshot.matchup,
      market: field.type,
      storageMarket: field.market,
      teamLabel: field.teamLabel,
      oldText: field.formatter(oldValue),
      newText: field.formatter(field.value),
      previousValue: oldValue,
      currentValue: field.value,
      delta,
      unit: field.unit,
      bookmaker: field.bookmaker,
      threshold: field.threshold
    });
  }

  if (result.movements.length > 0 && sendAlerts && state.bot && chatId && chatLineAlertsEnabled(chatId)) {
    const freshMovements = result.movements.filter((movement) => reserveMovementAlert(movement, chatId));
    if (freshMovements.length === 0) {
      console.log(`Line movement alert skipped duplicate ${snapshot.gamePk}.`);
      return result;
    }

    const text = formatMovementAlert({ snapshot, movements: freshMovements });
    result.alertText = text;

    await state.bot.sendMessage(chatId, text).catch((error) => {
      console.error(`Line movement alert gagal ke ${chatId}:`, error.message);
    });
    result.alertSent = true;
    result.movements = freshMovements;
    console.log(`Line movement alert ${snapshot.gamePk}: ${freshMovements.length} move(s).`);
  }

  return result;
}

function stopMonitor(key) {
  const monitor = activeMonitors.get(key);
  if (!monitor) return;
  clearInterval(monitor.timer);
  activeMonitors.delete(key);
}

async function pollMonitor(key) {
  const monitor = activeMonitors.get(key);
  if (!monitor) return;

  if (Date.now() > monitor.expiresAt) {
    stopMonitor(key);
    return;
  }

  const games = monitor.games.filter((game) => !isFinalStatus(game.status));
  if (games.length === 0) {
    stopMonitor(key);
    return;
  }

  const oddsEvents = await fetchOdds();
  if (!oddsEvents.length) return;

  for (const game of games) {
    const event = findEventForGame(game, oddsEvents);
    if (!event) continue;

    const snapshot = buildSnapshot(game, event);
    if (!snapshot.gamePk) continue;

    if (state.storage) {
      const gamePk = snapshot.gamePk;
      if (snapshot.homeMoneyline !== null) {
        state.storage.setLineSnapshot(gamePk, 'closing_home', snapshot.homeMoneyline);
      }
      if (snapshot.awayMoneyline !== null) {
        state.storage.setLineSnapshot(gamePk, 'closing_away', snapshot.awayMoneyline);
      }
    }

    await compareSnapshot(snapshot, monitor.chatId, { sendAlerts: true });
  }
}

export function configureLineMonitor({ bot, storage, config } = {}) {
  state.bot = bot || state.bot;
  state.storage = storage || state.storage;
  state.config = config || state.config || {};
}

export async function captureClosingLines(games) {
  if (!Array.isArray(games) || games.length === 0) return { captured: 0 };
  if (!state.storage) return { captured: 0 };

  const events = await fetchOdds();
  if (!events.length) return { captured: 0 };

  let captured = 0;
  for (const game of games) {
    const gamePk = String(game.gamePk || game.game_id || '');
    if (!gamePk) continue;

    // No skip-on-existing: the caller only passes pre-game games, so overwriting
    // refreshes the line toward first pitch. The last write before the game
    // starts is the closing proxy (setLineSnapshot upserts on game_pk+market).
    const event = findEventForGame(game, events);
    if (!event) continue;

    const snapshot = buildSnapshot(game, event);
    let wrote = false;
    if (snapshot.homeMoneyline != null) {
      state.storage.setLineSnapshot(gamePk, 'closing_home', snapshot.homeMoneyline);
      wrote = true;
    }
    if (snapshot.awayMoneyline != null) {
      state.storage.setLineSnapshot(gamePk, 'closing_away', snapshot.awayMoneyline);
      wrote = true;
    }
    if (wrote) {
      captured++;
      // Mirror the closing line into the feature store for LATER backtesting
      // (the single strongest predictor in sports betting). overwrite:true so
      // the last write before first pitch wins, matching the line_snapshots
      // "closing proxy" design. Best-effort; never break capture on a store error.
      if (state.storage.setFeatureSnapshot) {
        const dateYmd = game.dateYmd || game.date || String(game.gameDate || '').slice(0, 10) || '';
        try {
          state.storage.setFeatureSnapshot(
            gamePk,
            'closing_line',
            dateYmd,
            {
              homeMoneyline: snapshot.homeMoneyline ?? null,
              awayMoneyline: snapshot.awayMoneyline ?? null,
              moneylineBook: snapshot.moneylineBook ?? null,
              capturedAt: new Date().toISOString()
            },
            { overwrite: true }
          );
        } catch {
          // ignore: feature store is supplementary to line_snapshots
        }
      }
    }
  }

  return { captured };
}

export function resolveClosingLine(gamePk, side) {
  if (!state.storage || !gamePk) return null;
  const markets = side === 'home'
    ? ['closing_home', 'moneyline_home']
    : ['closing_away', 'moneyline_away'];
  const isPlausible = (value) => Math.abs(value) >= 100 && Math.abs(value) <= 1000;
  for (const market of markets) {
    const snapshot = state.storage.getLineSnapshot(gamePk, market);
    const value = snapshot ? Number(snapshot.value) : NaN;
    if (Number.isFinite(value) && isPlausible(value)) {
      return value;
    }
  }
  return null;
}

export function startLineMonitor(games, chatId) {
  if (!Array.isArray(games) || games.length === 0 || !chatId) return null;
  if (!chatLineAlertsEnabled(chatId)) return null;
  if (!state.bot || !state.storage) {
    console.warn('Line movement monitor belum dikonfigurasi dengan bot/storage.');
    return null;
  }

  const activeGames = games.filter((game) => game?.gamePk && !isFinalStatus(game.status));
  if (activeGames.length === 0) return null;

  const key = monitorKey(activeGames, chatId);
  const expiresAt = Date.now() + MONITOR_TTL_HOURS * 60 * 60 * 1000;
  const existing = activeMonitors.get(key);
  if (existing) {
    existing.games = activeGames;
    existing.expiresAt = expiresAt;
    return existing;
  }

  const intervalMs = Math.max(1, intervalMinutes()) * 60 * 1000;
  const monitor = {
    chatId,
    games: activeGames,
    expiresAt,
    timer: setInterval(() => {
      pollMonitor(key).catch((error) => {
        console.error('Line movement monitor error:', error.message);
      });
    }, intervalMs)
  };

  monitor.timer.unref?.();
  activeMonitors.set(key, monitor);
  pollMonitor(key).catch((error) => {
    console.error('Line movement monitor error:', error.message);
  });
  console.log(
    `Line movement monitor aktif untuk ${chatId}: ${activeGames.length} game, interval ${intervalMinutes()} menit.`
  );

  return monitor;
}

export function stopLineMonitorForChat(chatId) {
  const target = String(chatId);
  let stopped = 0;

  for (const [key, monitor] of activeMonitors.entries()) {
    if (String(monitor.chatId) !== target) continue;
    stopMonitor(key);
    stopped += 1;
  }

  return stopped;
}

export async function checkLineMovement(games, chatId, { sendAlerts = true } = {}) {
  const activeGames = Array.isArray(games)
    ? games.filter((game) => game?.gamePk && !isFinalStatus(game.status))
    : [];
  const result = {
    checkedGames: activeGames.length,
    matchedGames: 0,
    initializedSnapshots: 0,
    movements: [],
    alertsSent: 0,
    hasOddsApiKey: Boolean(oddsApiKey())
  };

  if (!state.storage) {
    console.warn('Line movement check membutuhkan storage.');
    return result;
  }

  if (!result.hasOddsApiKey || activeGames.length === 0) {
    return result;
  }

  const oddsEvents = await fetchOdds();
  if (!oddsEvents.length) return result;

  for (const game of activeGames) {
    const event = findEventForGame(game, oddsEvents);
    if (!event) continue;

    const snapshot = buildSnapshot(game, event);
    if (!snapshot.gamePk) continue;

    result.matchedGames += 1;
    const comparison = await compareSnapshot(snapshot, chatId, { sendAlerts });
    result.initializedSnapshots += comparison.initializedCount;
    result.alertsSent += comparison.alertSent ? 1 : 0;
    result.movements.push(...comparison.movements);
  }

  return result;
}

export function lineMonitorSettings() {
  return {
    enabled: lineAlertsEnabled(),
    intervalMinutes: intervalMinutes(),
    moneylineThreshold: moneylineMoveThreshold(),
    hasOddsApiKey: Boolean(oddsApiKey())
  };
}
