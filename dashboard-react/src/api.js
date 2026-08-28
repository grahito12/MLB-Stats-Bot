import { getSessionToken } from './useAuth.js';

const RAW_API_BASE = (import.meta.env?.VITE_API_BASE_URL || '').trim();
const API_BASE = RAW_API_BASE.replace(/\/+$/, '');
const API_LABEL = API_BASE || 'relative Vite proxy';

function queryString(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, value);
    }
  });
  const text = query.toString();
  return text ? `?${text}` : '';
}

async function errorMessage(response, fallback) {
  const text = await response.text();
  if (!text) return fallback;
  try {
    const payload = JSON.parse(text);
    return payload.detail || fallback;
  } catch {
    return text;
  }
}

function buildError(message, status) {
  const error = new Error(message);
  if (status) error.status = status;
  return error;
}

function connectionError(path, error) {
  const reason = error?.message ? ` ${error.message}` : '';
  return buildError(`Dashboard API request failed for ${path} using ${API_LABEL}.${reason}`);
}

export function buildRequestHeaders(extraHeaders = {}) {
  const token = getSessionToken();
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function request(path, options = {}) {
  const headers = buildRequestHeaders(options.headers || {});
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (error) {
    throw connectionError(path, error);
  }
  if (!response.ok) {
    const message = await errorMessage(response, `Request failed: ${response.status}`);
    throw buildError(message, response.status);
  }
  return response.json();
}

export const api = {
  health: () => request('/health'),
  today: (params) => request(`/api/today${queryString(params)}`),
  history: () => request('/api/history'),
  performance: () => request('/api/performance'),
  ledger: () => request('/api/ledger'),
  evolution: () => request('/api/evolution'),
  evolve: () => request('/api/evolve', { method: 'POST' }),
  // Backwards-compatible alias; the backend runs the same full pipeline.
  audit: () => request('/api/evolve', { method: 'POST' }),
  auditPredictions: (params) => request(`/api/predictions/audit${queryString(params)}`),
  predictionAudit: (predictionId) =>
    request(`/api/predictions/${encodeURIComponent(predictionId)}/audit`),
  settings: () => request('/api/settings'),
  saveSettings: (payload) =>
    request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  backtest: (payload) =>
    request('/api/backtest', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

export async function downloadExport(kind, params = {}) {
  const response = await fetch(`${API_BASE}/api/export/${kind}${queryString(params)}`, {
    headers: buildRequestHeaders({ 'Content-Type': 'text/csv' }),
  });
  if (!response.ok) {
    const message = await errorMessage(response, `Export failed: ${response.status}`);
    throw buildError(message, response.status);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  link.download = match?.[1] || `${kind}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
