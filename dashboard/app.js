const state = {
  source: 'live',
  games: [],
  selectedId: null,
  selectedAnalysis: null,
  activeView: 'overview',
  evaluation: null,
  status: null,
};

const els = {
  sourceSample: document.querySelector('#sourceSample'),
  sourceLive: document.querySelector('#sourceLive'),
  dateInput: document.querySelector('#dateInput'),
  refreshButton: document.querySelector('#refreshButton'),
  telegramStatus: document.querySelector('#telegramStatus'),
  telegramDetail: document.querySelector('#telegramDetail'),
  agentStatus: document.querySelector('#agentStatus'),
  agentDetail: document.querySelector('#agentDetail'),
  memoryAccuracy: document.querySelector('#memoryAccuracy'),
  memoryDetail: document.querySelector('#memoryDetail'),
  backtestRoi: document.querySelector('#backtestRoi'),
  backtestDetail: document.querySelector('#backtestDetail'),
  gameCount: document.querySelector('#gameCount'),
  gameSearch: document.querySelector('#gameSearch'),
  gameList: document.querySelector('#gameList'),
  selectedSource: document.querySelector('#selectedSource'),
  matchupTitle: document.querySelector('#matchupTitle'),
  matchupMeta: document.querySelector('#matchupMeta'),
  analysisBody: document.querySelector('#analysisBody'),
  tabButtons: [...document.querySelectorAll('.tabbar button')],
  evaluationReport: document.querySelector('#evaluationReport'),
  backtestMarket: document.querySelector('#backtestMarket'),
  backtestSeason: document.querySelector('#backtestSeason'),
  runBacktestButton: document.querySelector('#runBacktestButton'),
  knowledgeInput: document.querySelector('#knowledgeInput'),
  askButton: document.querySelector('#askButton'),
  knowledgeAnswer: document.querySelector('#knowledgeAnswer'),
  quickQuestions: [...document.querySelectorAll('[data-question]')],
  toast: document.querySelector('#toast'),
};

function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed <= 1 ? parsed * 100 : parsed;
}

function pct(value, digits = 0) {
  return `${toPercent(value).toFixed(digits)}%`;
}

function runs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(1) : '-';
}

function signedPct(value) {
  const parsed = toPercent(value);
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(1)}%`;
}

function signedRuns(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(1)}`;
}

function formatDateTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceLabel() {
  return state.source === 'live' ? 'Live MLB StatsAPI' : 'Sample CSV model';
}

function sourceHelp() {
  return state.source === 'live'
    ? 'Jadwal dan konteks diambil dari MLB StatsAPI untuk tanggal yang dipilih.'
    : 'Sample CSV lokal untuk tes model saat data live/API tidak dipakai.';
}

function compactLine(value, fallback = '-') {
  const text = String(value || '').trim();
  return text || fallback;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.detail || payload.error || 'Request failed');
  }
  return payload;
}

function setLoading(element, enabled) {
  element.classList.toggle('loading', enabled);
}

function confidenceClass(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('high') || text === 'bet') return 'good';
  if (text.includes('medium') || text === 'lean') return 'warn';
  if (text.includes('low') || text.includes('no')) return 'bad';
  return '';
}

function pill(label, value) {
  return `<span class="pill ${confidenceClass(value)}">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
}

function statusPill(label, value, detail = '') {
  const normalized = String(value || '').toLowerCase();
  const cls =
    normalized.includes('confirm') || normalized.includes('available') || normalized.includes('ready')
      ? 'good'
      : normalized.includes('partial') ||
          normalized.includes('default') ||
          normalized.includes('projected') ||
          normalized.includes('scheduled')
        ? 'warn'
        : normalized.includes('missing') || normalized.includes('unavailable') || normalized.includes('stale')
          ? 'bad'
          : '';
  return `
    <div class="status-item">
      <div>
        <strong>${escapeHtml(label)}</strong>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
      </div>
      <span class="pill ${cls}">${escapeHtml(value || '-')}</span>
    </div>
  `;
}

function textList(items = [], fallback = 'No data available.') {
  const clean = items.map((item) => String(item || '').trim()).filter(Boolean);
  if (!clean.length) return `<p class="muted">${escapeHtml(fallback)}</p>`;
  return `<ul class="clean-list">${clean.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function barRow(label, value, alt = false) {
  const percent = Math.max(0, Math.min(100, toPercent(value)));
  return `
    <div class="bar-row">
      <span>${escapeHtml(label)}</span>
      <div class="bar-track"><div class="bar-fill ${alt ? 'alt' : ''}" style="--value:${percent}%"></div></div>
      <strong>${percent.toFixed(0)}%</strong>
    </div>
  `;
}

function factorList(items = []) {
  if (!items.length) return '<p class="muted">No factors available.</p>';
  return `<div class="pill-row">${items.slice(0, 6).map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join('')}</div>`;
}

function statusText(enabled) {
  return enabled ? 'Ready' : 'Not set';
}

async function loadStatus() {
  const status = await api('/api/status');
  state.status = status;
  els.telegramStatus.textContent = statusText(status.config.telegramConfigured);
  els.telegramDetail.textContent = status.config.telegramChatConfigured
    ? `${status.state.subscriberCount} subscriber, chat configured`
    : 'Token or chat id missing';

  els.agentStatus.textContent = status.config.analystAgentEnabled ? 'Enabled' : 'Disabled';
  els.agentDetail.textContent = `${status.config.analystAgentMode} mode, ${status.config.openaiConfigured ? status.config.openaiModel : 'no OpenAI key'}`;

  els.memoryAccuracy.textContent = `${status.memory.accuracy || 0}%`;
  els.memoryDetail.textContent = `${status.memory.correctPicks || 0}/${status.memory.totalPicks || 0} picks, ${status.memory.firstInning.accuracy || 0}% first inning`;
  return status;
}

async function loadEvaluation() {
  state.evaluation = await api('/api/evaluation');
  const metrics = state.evaluation.metrics || {};
  els.backtestRoi.textContent = signedPct(metrics.roi || 0);
  els.backtestDetail.textContent = `${metrics.wins || 0}/${metrics.bets || 0} wins, Brier ${(Number(metrics.brier_score || 0)).toFixed(3)}`;
  els.evaluationReport.textContent = state.evaluation.report || 'No report available.';
}

function normalizeGame(game) {
  return {
    id: String(game.game_id ?? game.gamePk ?? game.id),
    away: game.away_team || game.away?.name,
    home: game.home_team || game.home?.name,
    awayAbbr: game.away_abbreviation || game.away?.abbreviation,
    homeAbbr: game.home_abbreviation || game.home?.abbreviation,
    date: game.date || '',
    start: game.start || game.game_time || '',
    venue: game.venue || '',
    status: game.status || (game.final ? 'Final' : 'Scheduled'),
    gameState: game.gameState || '',
    updatedAt: game.updatedAt || '',
    raw: game,
  };
}

async function loadGames() {
  setLoading(els.gameList, true);
  try {
    els.selectedSource.textContent = sourceLabel();
    const payload =
      state.source === 'sample'
        ? await api('/api/sample/games')
        : await api(`/api/live/predictions?date=${encodeURIComponent(els.dateInput.value)}`);
    state.games = (payload.games || []).map(normalizeGame);
    if (!state.games.length) {
      state.selectedId = null;
      renderGames();
      const message =
        state.source === 'live'
          ? `Tidak ada MLB game live untuk ${els.dateInput.value}. Coba pilih tanggal lain atau gunakan Sample CSV untuk tes model.`
          : 'Tidak ada game sample CSV yang bisa ditampilkan.';
      renderEmpty(message);
      return;
    }
    state.selectedId = state.games[0].id;
    renderGames();
    await selectGame(state.selectedId);
  } catch (error) {
    state.games = [];
    state.selectedId = null;
    renderGames();
    toast(error.message);
    renderEmpty(`Live/source data gagal dimuat: ${error.message}`);
  } finally {
    setLoading(els.gameList, false);
  }
}

function renderGames() {
  const query = els.gameSearch.value.trim().toLowerCase();
  const filtered = state.games.filter((game) =>
    `${game.away} ${game.home}`.toLowerCase().includes(query)
  );
  els.gameCount.textContent = `${filtered.length} game${filtered.length === 1 ? '' : 's'}`;
  els.gameList.innerHTML = filtered
    .map((game) => {
      const raw = game.raw || {};
      const pick = raw.pick?.name
        ? `Pick: ${raw.pick.name} ${pct(raw.pick.probability || 0)}`
        : state.source === 'live'
          ? 'Pick: waiting for model'
          : 'Sample prediction';
      const total = raw.totalRuns?.projectedTotal
        ? `Total: ${runs(raw.totalRuns.projectedTotal)} | ${raw.totalRuns.bestLean || '-'}`
        : 'Total: unavailable';
      const stateLabel = game.gameState || (state.source === 'live' ? 'live' : 'sample');
      return `
        <button class="game-card ${game.id === state.selectedId ? 'active' : ''}" data-game-id="${escapeHtml(game.id)}" type="button">
          <div class="game-card-top">
            <strong>${escapeHtml(game.away)} @ ${escapeHtml(game.home)}</strong>
            <span class="source-badge">${escapeHtml(stateLabel)}</span>
          </div>
          <span>${escapeHtml(game.start || game.date || 'TBD')} | ${escapeHtml(game.status)}</span>
          <span>${escapeHtml(game.venue || sourceHelp())}</span>
          <div class="game-card-lines">
            <span>${escapeHtml(pick)}</span>
            <span>${escapeHtml(total)}</span>
          </div>
        </button>
      `;
    })
    .join('');
}

function renderEmpty(message) {
  els.matchupTitle.textContent = 'No selection';
  els.matchupMeta.textContent = sourceHelp();
  els.analysisBody.className = 'analysis-body empty-state';
  els.analysisBody.innerHTML = `
    <div class="empty-copy">
      <strong>${escapeHtml(sourceLabel())}</strong>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

async function selectGame(gameId) {
  state.selectedId = String(gameId);
  state.activeView = state.activeView || 'overview';
  renderGames();
  setLoading(els.analysisBody, true);
  try {
    if (state.source === 'sample') {
      state.selectedAnalysis = await api(`/api/sample/analysis?id=${encodeURIComponent(gameId)}`);
    } else {
      const game = state.games.find((item) => item.id === String(gameId));
      state.selectedAnalysis = { live: game?.raw };
    }
    renderAnalysis();
  } catch (error) {
    toast(error.message);
    renderEmpty(error.message);
  } finally {
    setLoading(els.analysisBody, false);
  }
}

function sampleMatchup(analysis) {
  return analysis?.context?.matchup || 'Sample matchup';
}

function renderAnalysis() {
  if (!state.selectedAnalysis) {
    renderEmpty('Choose a matchup from the left.');
    return;
  }
  els.analysisBody.className = 'analysis-body';
  els.selectedSource.textContent = sourceLabel();
  els.tabButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.activeView);
  });

  if (state.source === 'sample') {
    const analysis = state.selectedAnalysis;
    els.matchupTitle.textContent = sampleMatchup(analysis);
    els.matchupMeta.textContent = `${analysis.context?.date || ''} | ${analysis.context?.park?.park || 'Park unavailable'}`;
    renderSampleView(analysis);
    return;
  }

  const game = state.selectedAnalysis.live;
  els.matchupTitle.textContent = game?.matchup || 'Live matchup';
  els.matchupMeta.textContent = [
    game?.start || '',
    game?.venue || '',
    game?.status || '',
    game?.updatedAt ? `Updated ${formatDateTime(game.updatedAt)}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  renderLiveView(game);
}

function renderSampleView(analysis) {
  const moneyline = analysis.moneyline || {};
  const totals = analysis.totals || {};
  const context = analysis.context || {};
  const quality = moneyline.quality_report || totals.quality_report || {};
  const homeTeam = context.home_team?.team || 'Home';
  const awayTeam = context.away_team?.team || 'Away';

  if (state.activeView === 'moneyline') {
    els.analysisBody.innerHTML = `
      <div class="detail-grid">
        <section class="detail-panel wide">
          <h3>Moneyline Probability</h3>
          ${barRow(homeTeam, moneyline.home_win_probability)}
          ${barRow(awayTeam, moneyline.away_win_probability, true)}
          <div class="pill-row">
            ${pill('Pick', moneyline.predicted_winner || '-')}
            ${pill('Decision', moneyline.decision || '-')}
            ${pill('Confidence', moneyline.confidence || '-')}
          </div>
        </section>
        <section class="detail-panel">
          <h3>Market Edge</h3>
          <p class="big-number">${moneyline.model_edge === null || moneyline.model_edge === undefined ? '-' : signedPct(moneyline.model_edge)}</p>
          <p class="muted">Home edge ${moneyline.home_edge === null || moneyline.home_edge === undefined ? '-' : signedPct(moneyline.home_edge)}</p>
        </section>
        <section class="detail-panel full">
          <h3>Main Factors</h3>
          ${factorList(moneyline.main_factors || [])}
        </section>
      </div>
    `;
    return;
  }

  if (state.activeView === 'totals') {
    els.analysisBody.innerHTML = renderTotalsView(totals);
    return;
  }

  if (state.activeView === 'quality') {
    els.analysisBody.innerHTML = renderQualityView(quality, analysis.full_text);
    return;
  }

  els.analysisBody.innerHTML = `
    <div class="detail-grid">
      <section class="detail-panel">
        <h3>Moneyline</h3>
        <p class="big-number">${escapeHtml(moneyline.predicted_winner || '-')}</p>
        <p class="muted">${pct(Math.max(moneyline.home_win_probability || 0, moneyline.away_win_probability || 0), 1)} top probability</p>
      </section>
      <section class="detail-panel">
        <h3>Total Runs</h3>
        <p class="big-number">${runs(totals.projected_total_runs)}</p>
        <p class="muted">${escapeHtml(totals.raw_lean || totals.best_total_lean || '-')}</p>
      </section>
      <section class="detail-panel">
        <h3>Quality</h3>
        <p class="big-number">${quality.score ?? 0}/100</p>
        <div class="pill-row">${pill('ML', moneyline.decision || '-')}${pill('Total', totals.decision || '-')}</div>
      </section>
      <section class="detail-panel wide">
        <h3>Win Probability</h3>
        ${barRow(homeTeam, moneyline.home_win_probability)}
        ${barRow(awayTeam, moneyline.away_win_probability, true)}
      </section>
      <section class="detail-panel">
        <h3>First Read</h3>
        <p class="muted">${escapeHtml((moneyline.main_factors || [])[0] || 'No factor available.')}</p>
      </section>
      <section class="detail-panel full">
        <h3>Full Agent Output</h3>
        <pre class="text-output">${escapeHtml(analysis.full_text || '')}</pre>
      </section>
    </div>
  `;
}

function renderTotalsView(totals = {}) {
  const over = totals.over_probabilities || totals.over || {};
  const under = totals.under_probabilities || totals.under || {};
  const lines = ['6.5', '7.5', '8.5', '9.5', '10.5', '11.5'];
  const drivers = totals.drivers || {};
  const edge = totals.model_edge ?? totals.modelEdge;
  const marketDelta =
    totals.marketDeltaRuns ?? (Number(totals.projected_total_runs ?? totals.projectedTotal) - Number(totals.market_total ?? totals.marketLine));
  return `
    <div class="detail-grid">
      <section class="detail-panel">
        <h3>Projected Total</h3>
        <p class="big-number">${runs(totals.projected_total_runs ?? totals.projectedTotal)}</p>
        <p class="muted">Model expected total runs.</p>
      </section>
      <section class="detail-panel">
        <h3>Market Line</h3>
        <p class="big-number">${runs(totals.market_total ?? totals.marketLine)}</p>
        <p class="muted">${Number.isFinite(Number(marketDelta)) ? `${signedRuns(marketDelta)} runs vs model` : 'Market total unavailable'}</p>
      </section>
      <section class="detail-panel">
        <h3>Best Lean</h3>
        <p class="big-number">${escapeHtml(totals.raw_lean || totals.best_total_lean || totals.bestLean || '-')}</p>
        <p class="muted">${escapeHtml(totals.confidence || '-')} confidence | ${escapeHtml(totals.marketSource || totals.decision || '')}</p>
      </section>
      <section class="detail-panel">
        <h3>Model Edge</h3>
        <p class="big-number">${edge === null || edge === undefined ? '-' : signedPct(edge)}</p>
        <p class="muted">Compared with market/implied baseline.</p>
      </section>
      <section class="detail-panel wide">
        <h3>Over Probability</h3>
        ${lines.map((line) => barRow(`Over ${line}`, over[line])).join('')}
      </section>
      <section class="detail-panel">
        <h3>Expected Runs</h3>
        <p class="big-number">${runs(totals.away_expected_runs ?? totals.awayExpectedRuns)} / ${runs(totals.home_expected_runs ?? totals.homeExpectedRuns)}</p>
        <p class="muted">Away / home</p>
      </section>
      <section class="detail-panel wide">
        <h3>Under Probability</h3>
        ${lines.map((line) => barRow(`Under ${line}`, under[line], true)).join('')}
      </section>
      <section class="detail-panel">
        <h3>Run Drivers</h3>
        <div class="driver-grid">
          <span>Offense</span><strong>${signedRuns(drivers.offense)}</strong>
          <span>Starting pitcher</span><strong>${signedRuns(drivers.startingPitcher)}</strong>
          <span>Bullpen</span><strong>${signedRuns(drivers.bullpen)}</strong>
          <span>Weather</span><strong>${signedRuns(drivers.weather)}</strong>
          <span>Lineup</span><strong>${signedRuns(drivers.lineup)}</strong>
          <span>Injuries</span><strong>${signedRuns(drivers.injuries)}</strong>
        </div>
      </section>
      <section class="detail-panel full">
        <h3>Total Factors</h3>
        ${factorList(totals.main_factors || totals.factors || [])}
      </section>
    </div>
  `;
}

function renderQualityView(quality = {}, fullText = '') {
  const statuses = [
    ['Pitchers', quality.probable_pitchers],
    ['Lineup', quality.lineup],
    ['Weather', quality.weather],
    ['Odds', quality.odds],
    ['Bullpen', quality.bullpen_usage],
    ['Park', quality.park_factor],
    ['Market', quality.market_total],
  ];
  const missing = quality.missing_fields?.join(', ') || 'none';
  const stale = quality.stale_fields?.join(', ') || 'none';
  const adjustments = quality.confidence_adjustments?.join(', ') || 'none';
  return `
    <div class="detail-grid">
      <section class="detail-panel">
        <h3>Data Quality Score</h3>
        <p class="big-number">${quality.score ?? 0}/100</p>
        <p class="muted">Score before final confidence cap.</p>
      </section>
      <section class="detail-panel wide">
        <h3>Input Status</h3>
        <div class="pill-row">
          ${statuses.map(([label, value]) => pill(label, value || 'Missing')).join('')}
        </div>
      </section>
      <section class="detail-panel">
        <h3>Missing</h3>
        <p class="muted">${escapeHtml(missing)}</p>
      </section>
      <section class="detail-panel">
        <h3>Stale</h3>
        <p class="muted">${escapeHtml(stale)}</p>
      </section>
      <section class="detail-panel">
        <h3>Adjustments</h3>
        <p class="muted">${escapeHtml(adjustments)}</p>
      </section>
      <section class="detail-panel full">
        <h3>Full Quality-Aware Output</h3>
        <pre class="text-output">${escapeHtml(fullText || 'No quality text available.')}</pre>
      </section>
    </div>
  `;
}

function renderLiveView(game) {
  if (!game) {
    renderEmpty('Live game unavailable.');
    return;
  }
  if (state.activeView === 'totals') {
    els.analysisBody.innerHTML = renderTotalsView(game.totalRuns || {});
    return;
  }
  if (state.activeView === 'quality') {
    const fields = Object.values(game.quality?.fields || {});
    els.analysisBody.innerHTML = `
      <div class="detail-grid">
        <section class="detail-panel">
          <h3>Data Quality Score</h3>
          <p class="big-number">${game.quality?.score ?? 0}/100</p>
          <p class="muted">${escapeHtml(game.quality?.note || '')}</p>
        </section>
        <section class="detail-panel wide">
          <h3>Input Status</h3>
          <div class="status-list">
            ${fields.map((field) => statusPill(field.label, field.status, field.detail)).join('')}
          </div>
        </section>
        <section class="detail-panel">
          <h3>Missing Data</h3>
          ${textList(game.quality?.missingFields || [], 'No missing fields detected.')}
        </section>
        <section class="detail-panel">
          <h3>Confidence Notes</h3>
          ${textList(game.quality?.confidenceAdjustments || [], 'No confidence downgrade noted.')}
        </section>
        <section class="detail-panel full">
          <h3>Live Source</h3>
          <p class="muted">${escapeHtml(game.source || 'MLB StatsAPI live')}</p>
          <p class="muted">Fetched ${escapeHtml(formatDateTime(game.updatedAt))}. Market odds are shown only when an odds provider is configured.</p>
        </section>
      </div>
    `;
    return;
  }
  if (state.activeView === 'moneyline') {
    els.analysisBody.innerHTML = `
      <div class="detail-grid">
        <section class="detail-panel wide">
          <h3>Moneyline Probability</h3>
          ${barRow(game.home_team, game.probabilities?.home)}
          ${barRow(game.away_team, game.probabilities?.away, true)}
          <div class="pill-row">
            ${pill('Pick', game.pick?.name || '-')}
            ${pill('Confidence', game.pick?.confidence || '-')}
            ${pill('Source', game.pick?.source || 'model')}
          </div>
        </section>
        <section class="detail-panel">
          <h3>Starting Pitchers</h3>
          <p class="compact-text">${escapeHtml(game.starters?.away || '-')}</p>
          <p class="compact-text">${escapeHtml(game.starters?.home || '-')}</p>
        </section>
        <section class="detail-panel">
          <h3>First Inning</h3>
          <p class="big-number">${escapeHtml(game.firstInning?.pick || '-')}</p>
          <p class="muted">${pct(game.firstInning?.probability || 0)} probability</p>
        </section>
        <section class="detail-panel full">
          <h3>Main Supporting Factors</h3>
          ${textList(game.reasons || [])}
        </section>
        <section class="detail-panel full">
          <h3>Risk Factors</h3>
          <p class="muted">${escapeHtml(compactLine(game.risk, 'No specific risk note.'))}</p>
        </section>
      </div>
    `;
    return;
  }
  els.analysisBody.innerHTML = `
    <div class="detail-grid">
      <section class="detail-panel">
        <h3>Game Status</h3>
        <p class="big-number">${escapeHtml(game.gameState || 'live')}</p>
        <p class="muted">${escapeHtml(game.status || '-')} | ${escapeHtml(game.start || '-')}</p>
      </section>
      <section class="detail-panel">
        <h3>Moneyline Pick</h3>
        <p class="big-number">${escapeHtml(game.pick?.name || '-')}</p>
        <p class="muted">${pct(game.pick?.probability || 0)} probability</p>
      </section>
      <section class="detail-panel">
        <h3>Total Runs</h3>
        <p class="big-number">${runs(game.totalRuns?.projectedTotal)}</p>
        <p class="muted">${escapeHtml(game.totalRuns?.bestLean || 'No total data')} | market ${runs(game.totalRuns?.marketLine)}</p>
      </section>
      <section class="detail-panel">
        <h3>Quality</h3>
        <p class="big-number">${game.quality?.score ?? 0}/100</p>
        <p class="muted">${escapeHtml(game.quality?.missingFields?.length ? `${game.quality.missingFields.length} missing field(s)` : 'Core context available')}</p>
      </section>
      <section class="detail-panel wide">
        <h3>Win Probability</h3>
        ${barRow(game.home_team, game.probabilities?.home)}
        ${barRow(game.away_team, game.probabilities?.away, true)}
      </section>
      <section class="detail-panel">
        <h3>First Inning</h3>
        <p class="big-number">${escapeHtml(game.firstInning?.pick || '-')}</p>
        <p class="muted">${pct(game.firstInning?.probability || 0)} | baseline ${escapeHtml(game.firstInning?.baselinePick || '-')} ${pct(game.firstInning?.baselineProbability || 0)}</p>
      </section>
      <section class="detail-panel full">
        <h3>Starting Pitchers</h3>
        <div class="two-col-list">
          <div><span>Away</span><strong>${escapeHtml(game.starters?.away || '-')}</strong></div>
          <div><span>Home</span><strong>${escapeHtml(game.starters?.home || '-')}</strong></div>
        </div>
      </section>
      <section class="detail-panel wide">
        <h3>Main Supporting Factors</h3>
        ${textList(game.reasons || [])}
      </section>
      <section class="detail-panel">
        <h3>Market Note</h3>
        <p class="muted">${escapeHtml(game.totalRuns?.marketSource || 'Market odds unavailable until Odds API is configured.')}</p>
      </section>
      <section class="detail-panel full">
        <h3>Context Snapshot</h3>
        <div class="context-grid">
          <div>
            <strong>Standings/Form</strong>
            ${textList(game.context?.standings || [])}
          </div>
          <div>
            <strong>Bullpen</strong>
            ${textList(game.context?.bullpen || [])}
          </div>
          <div>
            <strong>Lineup</strong>
            ${textList(game.context?.lineup || [])}
          </div>
          <div>
            <strong>Injury</strong>
            ${textList(game.context?.injuries || [])}
          </div>
        </div>
      </section>
    </div>
  `;
}

async function askKnowledge(question) {
  const trimmed = question.trim();
  if (!trimmed) return;
  els.knowledgeAnswer.textContent = 'Thinking...';
  try {
    const answer = await api(`/api/knowledge?q=${encodeURIComponent(trimmed)}`);
    els.knowledgeAnswer.textContent = `${answer.answer || 'No answer.'}\n\nSource: ${(answer.sources || [])[0] || 'local knowledge base'}`;
  } catch (error) {
    els.knowledgeAnswer.textContent = error.message;
  }
}

async function runBacktest() {
  els.evaluationReport.textContent = 'Running backtest...';
  try {
    const payload = await api('/api/backtest', {
      method: 'POST',
      body: JSON.stringify({
        market: els.backtestMarket.value,
        season: Number(els.backtestSeason.value || 2025),
      }),
    });
    state.evaluation = payload.evaluation;
    els.evaluationReport.textContent = `${payload.output}\n\n${payload.evaluation.report}`;
    const metrics = payload.evaluation.metrics || {};
    els.backtestRoi.textContent = signedPct(metrics.roi || 0);
    els.backtestDetail.textContent = `${metrics.wins || 0}/${metrics.bets || 0} wins, Brier ${(Number(metrics.brier_score || 0)).toFixed(3)}`;
  } catch (error) {
    els.evaluationReport.textContent = error.message;
  }
}

function setSourceMode(source) {
  state.source = source;
  els.sourceLive.classList.toggle('active', source === 'live');
  els.sourceSample.classList.toggle('active', source === 'sample');
  els.selectedSource.textContent = sourceLabel();
}

function bindEvents() {
  els.sourceSample.addEventListener('click', async () => {
    setSourceMode('sample');
    await loadGames();
  });
  els.sourceLive.addEventListener('click', async () => {
    setSourceMode('live');
    await loadGames();
  });
  els.refreshButton.addEventListener('click', async () => {
    await Promise.allSettled([loadStatus(), loadEvaluation()]);
    await loadGames();
  });
  els.gameSearch.addEventListener('input', renderGames);
  els.gameList.addEventListener('click', async (event) => {
    const card = event.target.closest('[data-game-id]');
    if (!card) return;
    await selectGame(card.dataset.gameId);
  });
  els.tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.activeView = button.dataset.view;
      renderAnalysis();
    });
  });
  els.runBacktestButton.addEventListener('click', runBacktest);
  els.askButton.addEventListener('click', () => askKnowledge(els.knowledgeInput.value));
  els.knowledgeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') askKnowledge(els.knowledgeInput.value);
  });
  els.quickQuestions.forEach((button) => {
    button.addEventListener('click', () => {
      els.knowledgeInput.value = button.dataset.question;
      askKnowledge(button.dataset.question);
    });
  });
}

async function init() {
  bindEvents();
  setSourceMode(state.source);
  const [statusResult] = await Promise.allSettled([loadStatus(), loadEvaluation()]);
  els.dateInput.value =
    statusResult?.status === 'fulfilled' && statusResult.value?.app?.serverDate
      ? statusResult.value.app.serverDate
      : today();
  await loadGames();
}

init();
