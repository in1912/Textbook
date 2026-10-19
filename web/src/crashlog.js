// Crash recorder for the textbook SPA.
//
// iOS Safari does not let a page observe its own death: when WebKit kills the
// tab for using too much memory, no callback runs. So instead of trying to
// catch the crash, this module leaves a trail:
//
//   - a heartbeat and a small ring of breadcrumbs in sessionStorage, written
//     on every important step (opening a PDF, paging, rendering, zooming);
//   - on the next load of the same tab, a heartbeat that stopped without a
//     `pagehide` is reported as `unclean_exit` (crash / killed by the system);
//   - JavaScript errors and PDF render failures are reported immediately;
//   - reports are queued in localStorage while logged out and flushed once a
//     token is available.
//
// sessionStorage (not localStorage) is deliberate: two open tabs must not see
// each other's heartbeat and mistake it for a crash.
import { API_BASE, token } from './api.js';

const STATE_KEY = 'tb_crash_state_v1';
const PENDING_KEY = 'tb_crash_pending_v1';
const HEARTBEAT_MS = 5000;
const MAX_CRUMBS = 40;
const MAX_PENDING = 10;
const MAX_DETAIL = 24000;

let state = null;
let beatTimer = null;
let persistTimer = null;
const reportedErrors = new Map(); // message -> count, per page load

function storage() {
  try {
    // sessionStorage survives a tab reload (including the reload Safari does
    // after killing a tab) but is per-tab.
    const s = window.sessionStorage;
    s.getItem(STATE_KEY);
    return s;
  } catch {
    try { return window.localStorage; } catch { return null; }
  }
}

function readJson(store, key) {
  if (!store) return null;
  try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(store, key, value) {
  if (!store) return;
  try { store.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota */ }
}
function pendingRead() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]') || []; } catch { return []; }
}
function pendingWrite(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(0, MAX_PENDING))); } catch { /* ignore */ }
}

export function isIpadLike() {
  const ua = navigator.userAgent || '';
  if (/iPad/.test(ua)) return true;
  // iPadOS 13+ Safari sends a desktop "Macintosh" UA; touch points give it away.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

export function envInfo() {
  const nav = navigator;
  return {
    ua: nav.userAgent,
    platform: (nav.userAgentData && nav.userAgentData.platform) || nav.platform || '',
    ipad_like: isIpadLike(),
    dpr: window.devicePixelRatio || 1,
    screen: [window.screen.width, window.screen.height],
    viewport: [window.innerWidth, window.innerHeight],
    cores: nav.hardwareConcurrency || 0,
    device_memory_gb: nav.deviceMemory || 0,
    online: nav.onLine,
    language: nav.language,
    timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })(),
  };
}

function trimDetail(v) {
  let s;
  if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  return s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) : s;
}

function persist(now = false) {
  if (!state) return;
  const store = storage();
  if (!store) return;
  const snap = {
    id: state.id,
    started_at: state.started_at,
    last_beat: state.last_beat,
    clean: state.clean,
    loads: state.loads,
    last_action: state.last_action,
    view: state.view,
    crumbs: state.crumbs.slice(-MAX_CRUMBS),
  };
  if (now) { if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; } }
  writeJson(store, STATE_KEY, snap);
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 700);
}

export function crumb(kind, detail) {
  if (!state) return;
  const d = detail == null ? '' : trimDetail(detail).slice(0, 600);
  state.last_action = kind + (d ? ' ' + d.replace(/\s+/g, ' ').slice(0, 120) : '');
  state.crumbs.push({ t: Date.now(), k: String(kind).slice(0, 40), d });
  if (state.crumbs.length > MAX_CRUMBS) state.crumbs.splice(0, state.crumbs.length - MAX_CRUMBS);
  schedulePersist();
}

// PdfViewer tells us what is on screen: which book, how many pages, how many
// canvases are alive and roughly how many megabytes they occupy. That estimate
// is the single most useful number when a tablet runs out of memory.
export function notePdfState(view) {
  if (!state) return;
  state.view = { ...state.view, ...view, at: Date.now() };
  if (view && view.path) state.last_action = `pdf ${view.page || '?'}/${view.pages || '?'} 页`;
  schedulePersist();
}

function addPending(entry) {
  const list = pendingRead();
  list.unshift({ at: new Date().toISOString(), ...entry });
  pendingWrite(list);
}

function snapshotForReport() {
  return {
    env: envInfo(),
    view: state ? state.view : {},
    last_action: state ? state.last_action : '',
    crumbs: state ? state.crumbs.slice(-20) : [],
  };
}

function reportNow(kind, summary, detail) {
  addPending({ kind, summary: String(summary || '').slice(0, 500), detail: trimDetail(detail) });
  flushPendingCrash();
}

let inFlight = null;

// Boot and the settings page may both ask to flush; keep one request at a time
// so the same report is not posted twice.
export function flushPendingCrash() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const list = pendingRead();
    const t = token();
    if (!list.length || !t) return 0;
    const keep = [];
    let sent = 0;
    for (const entry of list) {
      try {
        const r = await fetch(API_BASE + '/crashlog?token=' + encodeURIComponent(t), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
        if (r.ok) sent++;
        else if (r.status !== 400) keep.push(entry); // 401/5xx: keep for the next login
      } catch {
        keep.push(entry);
      }
    }
    pendingWrite(keep);
    return sent;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function fmtGap(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} 分钟`;
  return `${Math.round(m / 60)} 小时`;
}

function registerPrevious(prev) {
  if (!prev || typeof prev !== 'object') return;
  if (prev.clean) return;
  const last = Number(prev.last_beat) || Number(prev.started_at) || Date.now();
  const gap = Date.now() - last;
  const summary = `上次页面没有正常结束（最后心跳在 ${fmtGap(gap)}前；可能是浏览器进程被系统回收或崩溃）`;
  addPending({
    kind: 'unclean_exit',
    summary,
    detail: trimDetail({
      env: envInfo(),
      previous: {
        started_at: prev.started_at ? new Date(prev.started_at).toISOString() : '',
        last_beat: new Date(last).toISOString(),
        heartbeat_gap_ms: gap,
        loads: prev.loads || 0,
        last_action: prev.last_action || '',
        view: prev.view || {},
        crumbs: Array.isArray(prev.crumbs) ? prev.crumbs.slice(-30) : [],
      },
    }),
  });
}

function installListeners() {
  window.addEventListener('error', (ev) => {
    const msg = String((ev && (ev.message || (ev.error && ev.error.message))) || 'unknown error');
    const n = reportedErrors.get(msg) || 0;
    if (n >= 5) return;
    reportedErrors.set(msg, n + 1);
    crumb('js_error', msg);
    reportNow('js_error', msg, {
      ...snapshotForReport(),
      where: [ev && ev.filename, ev && ev.lineno, ev && ev.colno].filter(Boolean).join(':'),
      stack: String((ev && ev.error && ev.error.stack) || '').slice(0, 6000),
    });
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev && ev.reason;
    const msg = String((reason && (reason.message || reason)) || 'unhandled rejection');
    const n = reportedErrors.get('rejection:' + msg) || 0;
    if (n >= 5) return;
    reportedErrors.set('rejection:' + msg, n + 1);
    crumb('js_error', msg);
    reportNow('js_error', '未处理的 Promise 拒绝：' + msg, {
      ...snapshotForReport(),
      stack: String((reason && reason.stack) || '').slice(0, 6000),
    });
  });

  // A real unload proves the page ended on its own. A crash or an OS kill
  // never gets here, which is exactly what registerPrevious() looks for.
  const markClean = (ev) => {
    if (ev && ev.type === 'pagehide' && ev.persisted) return; // bfcache: still alive
    if (!state || state.clean) return;
    state.clean = true;
    state.last_beat = Date.now();
    persist(true);
  };
  window.addEventListener('pagehide', markClean);
  window.addEventListener('beforeunload', markClean);
}

export function initCrashLog() {
  if (state) return;
  const store = storage();
  const prev = readJson(store, STATE_KEY);

  state = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    started_at: Date.now(),
    last_beat: Date.now(),
    clean: false,
    loads: (prev && Number(prev.loads) ? Number(prev.loads) : 0) + 1,
    last_action: 'boot',
    view: {},
    crumbs: [{ t: Date.now(), k: 'boot', d: '' }],
  };

  registerPrevious(prev);
  persist(true);
  installListeners();

  beatTimer = setInterval(() => {
    if (!state) return;
    state.last_beat = Date.now();
    persist();
  }, HEARTBEAT_MS);
  // No unref in the browser; the interval dies with the page.
  if (beatTimer && typeof beatTimer.unref === 'function') beatTimer.unref();

  flushPendingCrash();
}
