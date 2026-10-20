// Login audit trail and IP blacklist for the standalone server.
//
// Every attempt (ok / fail / blocked) is written to tb_login_logs. The password
// people typed is stored AES-256-GCM encrypted with the same key material as
// the AI API key (server/secret.js): the administrator can read it in 登录日志,
// but a copied .sqlite alone does not leak it.
//
// Region lookup is best-effort and asynchronous: the row is written first, then
// ip-api.com fills `region` a moment later. Set TEXTBOOK_GEO=off to keep every
// log line on this machine (the column then stays empty for public IPs).
//
// Recording must never break a login, so record() swallows all errors.
const net = require('net');
const { db } = require('./db');
const secret = require('./secret');

const PAGE_SIZES = [5, 15, 30, 50, 100];
const STATUSES = new Set(['ok', 'fail', 'blocked']);
const MAX_PASSWORD_CHARS = 128;
const MAX_UA_CHARS = 400;
const MAX_REGION_CHARS = 80;
const LOG_MAX_ROWS = Math.max(1000, Number(process.env.TEXTBOOK_LOGIN_LOG_MAX) || 10000);

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return 'unknown';
  if (ip.includes(',')) ip = ip.split(',')[0].trim(); // defensive: XFF list
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip.slice(0, 64);
}

// Only real addresses can be blacklisted; "unknown" and raw proxy junk stay in
// the log but never in the list, otherwise one bad request could ban everyone.
function validIp(value) {
  const ip = normalizeIp(value);
  return net.isIP(ip) ? ip : '';
}

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const low = ip.toLowerCase();
  return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80:');
}

const BROWSERS = [
  ['MicroMessenger', '微信'],
  ['QQBrowser', 'QQ浏览器'],
  ['EdgA', 'Edge'], ['EdgiOS', 'Edge'], ['Edg', 'Edge'],
  ['OPR', 'Opera'], ['Opera', 'Opera'],
  ['CriOS', 'Chrome'], ['Chrome', 'Chrome'],
  ['FxiOS', 'Firefox'], ['Firefox', 'Firefox'],
  ['MSIE', 'IE'], ['Trident', 'IE'],
  ['Safari', 'Safari'],
];

function clientLabel(ua) {
  const s = String(ua || '').trim();
  if (!s) return '';
  let os = '';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';

  let browser = '';
  for (const [token, label] of BROWSERS) {
    const m = new RegExp(token + '/([\\d.]+)').exec(s);
    if (!m) continue;
    let version = m[1];
    if (label === 'Safari') {
      const v = /Version\/([\d.]+)/.exec(s);
      if (v) version = v[1];
    }
    browser = label + ' ' + version.split('.')[0];
    break;
  }
  if (!browser) {
    const m = /^([A-Za-z][\w.-]*)\/([\d.]+)/.exec(s);
    if (m) browser = m[1] + ' ' + m[2].split('.')[0];
  }
  return [browser, os].filter(Boolean).join(' · ') || s.slice(0, 40);
}

// ---- region lookup ---------------------------------------------------------
const geoCache = new Map(); // ip -> { region, at }
const GEO_TTL = 24 * 60 * 60 * 1000;
const GEO_FAIL_TTL = 10 * 60 * 1000; // don't hammer a provider that cannot be reached

function geoEnabled() {
  return String(process.env.TEXTBOOK_GEO || '').toLowerCase() !== 'off';
}

function cachedRegion(ip) {
  if (!ip || ip === 'unknown') return '未知';
  if (isPrivate(ip)) return '内网';
  const hit = geoCache.get(ip);
  if (hit && Date.now() - hit.at < (hit.region ? GEO_TTL : GEO_FAIL_TTL)) return hit.region;
  return '';
}

async function lookupRegion(ip) {
  const hit = geoCache.get(ip);
  if (hit && Date.now() - hit.at < (hit.region ? GEO_TTL : GEO_FAIL_TTL)) return hit.region;
  if (!geoEnabled() || isPrivate(ip) || !net.isIP(ip)) return '';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  let region = '';
  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city&lang=zh-CN`;
    const r = await fetch(url, { signal: ctl.signal });
    const d = await r.json();
    if (d && d.status === 'success') {
      const parts = [d.country, d.regionName, d.city].filter(Boolean);
      region = [...new Set(parts)].join(' ').slice(0, MAX_REGION_CHARS);
    }
  } catch {
    region = '';
  } finally {
    clearTimeout(timer);
  }
  geoCache.set(ip, { region, at: Date.now() });
  return region;
}

// ---- writing ---------------------------------------------------------------
let sincePrune = 0;
function prune() {
  if (++sincePrune < 200) return;
  sincePrune = 0;
  try {
    db.prepare('DELETE FROM tb_login_logs WHERE id <= (SELECT MAX(id) - ? FROM tb_login_logs)').run(LOG_MAX_ROWS);
  } catch { /* pruning is housekeeping, never fatal */ }
}

function record({ username = '', display_name = '', status = 'fail', ip = '', password = '', ua = '' } = {}) {
  try {
    const addr = normalizeIp(ip);
    const agent = String(ua || '').slice(0, MAX_UA_CHARS);
    const attempt = String(password == null ? '' : password).slice(0, MAX_PASSWORD_CHARS);
    const region = cachedRegion(addr);
    // Store UTC. The page formats it in the browser's own timezone, so a
    // container that forgot TZ=Asia/Shanghai cannot shift the whole log by
    // eight hours (the standalone server otherwise stores localtime).
    const info = db.prepare(`INSERT INTO tb_login_logs
      (at, username, display_name, status, ip, region, password_enc, client, ua)
      VALUES (strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      String(username || '').slice(0, 64),
      String(display_name || '').slice(0, 64),
      STATUSES.has(status) ? status : 'fail',
      addr,
      region,
      secret.encrypt(attempt),
      clientLabel(agent),
      agent,
    );
    const id = Number(info.lastInsertRowid);
    if (!region) {
      lookupRegion(addr).then((found) => {
        if (!found) return;
        try { db.prepare('UPDATE tb_login_logs SET region=? WHERE id=?').run(found, id); } catch { /* ignore */ }
      }).catch(() => {});
    }
    prune();
    return id;
  } catch {
    return 0;
  }
}

// v1.4.0 stored datetime('now','localtime'), which in a UTC container is eight
// hours behind what the page used to show. Rewrite those rows once, using this
// host's current offset, so old and new rows share the same UTC format. Rows
// that already end in Z are left alone, which also makes this safe to re-run.
function migrateLegacyTimes() {
  try {
    const logs = db.prepare("SELECT COUNT(*) AS n FROM tb_login_logs WHERE at NOT LIKE '%Z'").get().n;
    const bans = db.prepare(`SELECT COUNT(*) AS n FROM tb_ip_blacklist
      WHERE created_at IS NOT NULL AND created_at <> '' AND created_at NOT LIKE '%Z'`).get().n;
    if (!logs && !bans) return { logs: 0, bans: 0 };
    const offset = db.prepare(`SELECT CAST(strftime('%s','now','localtime') AS INTEGER)
      - CAST(strftime('%s','now') AS INTEGER) AS s`).get().s || 0;
    if (logs) {
      db.prepare(`UPDATE tb_login_logs
        SET at = strftime('%Y-%m-%dT%H:%M:%SZ', at, printf('%+d seconds', ?))
        WHERE at NOT LIKE '%Z'`).run(-offset);
    }
    if (bans) {
      db.prepare(`UPDATE tb_ip_blacklist
        SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, printf('%+d seconds', ?))
        WHERE created_at IS NOT NULL AND created_at <> '' AND created_at NOT LIKE '%Z'`).run(-offset);
    }
    return { logs, bans, offsetSeconds: offset };
  } catch {
    return { logs: 0, bans: 0 };
  }
}

// ---- reading ---------------------------------------------------------------
function list({ page = 1, page_size = 5 } = {}) {
  let size = Number(page_size);
  if (!PAGE_SIZES.includes(size)) size = 5;
  let p = Math.max(1, Math.floor(Number(page) || 1));
  const total = db.prepare('SELECT COUNT(*) AS n FROM tb_login_logs').get().n;
  const pages = Math.max(1, Math.ceil(total / size));
  if (p > pages) p = pages;
  const rows = db.prepare(`SELECT id, at, username, display_name, status, ip, region, password_enc, client, ua
    FROM tb_login_logs ORDER BY id DESC LIMIT ? OFFSET ?`).all(size, (p - 1) * size);
  const banned = new Set(db.prepare('SELECT ip FROM tb_ip_blacklist').all().map((r) => r.ip));
  return {
    items: rows.map((r) => ({
      id: r.id,
      at: r.at || '',
      username: r.username || '',
      display_name: r.display_name || '',
      status: r.status || 'fail',
      ip: r.ip || '',
      region: r.region || '',
      password: secret.decrypt(r.password_enc),
      client: r.client || '',
      ua: r.ua || '',
      blacklisted: banned.has(r.ip),
    })),
    total,
    page: p,
    page_size: size,
    pages,
  };
}

// ---- blacklist -------------------------------------------------------------
function isBlocked(ip) {
  const addr = normalizeIp(ip);
  if (!net.isIP(addr)) return false;
  try {
    return !!db.prepare('SELECT 1 FROM tb_ip_blacklist WHERE ip=?').get(addr);
  } catch {
    return false;
  }
}

function listBlacklist() {
  return db.prepare('SELECT ip, note, created_at, created_by FROM tb_ip_blacklist ORDER BY created_at DESC, ip')
    .all()
    .map((r) => ({ ip: r.ip, note: r.note || '', created_at: r.created_at || '', created_by: r.created_by || '' }));
}

function addBlacklist(ip, note, by) {
  const addr = validIp(ip);
  if (!addr) return { error: 'bad_ip', message: 'IP 地址格式不正确' };
  const text = String(note || '').trim().slice(0, 80);
  db.prepare(`INSERT INTO tb_ip_blacklist(ip, note, created_at, created_by)
    VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),?)
    ON CONFLICT(ip) DO UPDATE SET note=excluded.note`).run(addr, text, String(by || '').slice(0, 64));
  const row = db.prepare('SELECT ip, note, created_at, created_by FROM tb_ip_blacklist WHERE ip=?').get(addr);
  return { ok: true, item: { ip: row.ip, note: row.note || '', created_at: row.created_at || '', created_by: row.created_by || '' } };
}

function removeBlacklist(ip) {
  const addr = validIp(ip);
  if (!addr) return { error: 'bad_ip', message: 'IP 地址格式不正确' };
  const info = db.prepare('DELETE FROM tb_ip_blacklist WHERE ip=?').run(addr);
  return { ok: true, removed: Number(info.changes) };
}

module.exports = {
  PAGE_SIZES,
  normalizeIp,
  validIp,
  clientLabel,
  isBlocked,
  record,
  list,
  migrateLegacyTimes,
  listBlacklist,
  addBlacklist,
  removeBlacklist,
};
