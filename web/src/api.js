// Thin API layer. The SPA runs in three settings with the same code:
//   - embedded by the workbench at /textbook/index.html
//   - embedded behind the fnOS gateway at /app/qgworkbench/textbook/index.html
//   - standalone at the server root
// In the first two the workbench token lives in localStorage.wb_token and is
// accepted both as a header and as ?token=; the query form is used everywhere
// here because PDF.js and <img> issue their own requests.
const m = location.pathname.match(/^(.*?)\/textbook(\/|$)/);
export const BASE_PREFIX = m ? m[1] : ''; // '' or '/app/qgworkbench'
export const API_BASE = BASE_PREFIX + '/api/textbook';

export function token() {
  try { return localStorage.getItem('wb_token') || ''; } catch { return ''; }
}

function withToken(url) {
  const t = token();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
}

export function fileUrl(path) {
  return withToken(`${API_BASE}/file?path=${encodeURIComponent(path)}`);
}
export function thumbUrl(path) {
  return withToken(`${API_BASE}/thumb?path=${encodeURIComponent(path)}`);
}
export function shareFileUrl(tok) {
  return withToken(`${API_BASE}/pub/${encodeURIComponent(tok)}/file`);
}
export function shareThumbUrl(tok) {
  return withToken(`${API_BASE}/pub/${encodeURIComponent(tok)}/thumb`);
}

async function request(path, opts = {}) {
  const url = withToken(API_BASE + path);
  const init = { ...opts };
  init.headers = { ...(opts.headers || {}) };
  if (opts.body && typeof opts.body !== 'string') {
    init.body = JSON.stringify(opts.body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body: body || {} }),
  put: (p, body) => request(p, { method: 'PUT', body: body || {} }),
  del: (p) => request(p, { method: 'DELETE' }),
};
