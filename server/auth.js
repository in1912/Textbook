// Standalone accounts. The embedded (workbench) copy has no auth code at all:
// the workbench resolves req.user before the textbook router sees the request.
// Here we mirror the workbench contract — Bearer, ?token= and a cookie — so the
// same frontend works in both places.
const crypto = require('crypto');
const { db } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'wb_token';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const calc = crypto.scryptSync(String(password), salt, 64);
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
  } catch { return false; }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions(token, user_id, expires_at)
    VALUES(?, ?, datetime('now','localtime','+${SESSION_DAYS} days'))`).run(token, userId);
  return token;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now','localtime')").run();
}

function cookieToken(req) {
  const m = /(?:^|;\s*)wb_token=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}
function tokenCandidates(req) {
  const out = [];
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) out.push(header.slice(7));
  const q = req.query && req.query.token;
  if (typeof q === 'string') out.push(q);
  else if (Array.isArray(q)) out.push(...q.filter(Boolean).map(String));
  out.push(cookieToken(req));
  return out.filter(Boolean);
}

function resolveUser(req) {
  for (const token of tokenCandidates(req)) {
    const row = db.prepare(`SELECT u.id, u.username, u.role, u.display_name, u.nickname, u.disabled
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now','localtime')`).get(token);
    if (row && !row.disabled) return row;
  }
  return null;
}

function requireUser(req, res, next) {
  const u = resolveUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized', message: '请先登录' });
  req.user = u;
  return next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: '需要管理员权限' });
  return next();
}

function listUsers() {
  return db.prepare('SELECT id, username, display_name, nickname, role, disabled, created_at FROM users ORDER BY id').all();
}

function ensureAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return null;
  const username = String(process.env.TEXTBOOK_ADMIN_USER || 'admin').trim() || 'admin';
  const envPass = process.env.TEXTBOOK_ADMIN_PASS;
  // A brand-new deployment gets a predictable first login. The login screen no
  // longer mentions it; the server log says it once and the admin should change
  // it in 用户管理 straight away.
  const password = envPass || 'admin123';
  db.prepare('INSERT INTO users(username, password_hash, role, display_name) VALUES(?,?,?,?)')
    .run(username, hashPassword(password), 'admin', '管理员');
  return { username, password, from_env: !!envPass };
}

function setCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, cleanupSessions,
  resolveUser, requireUser, requireAdmin, listUsers, ensureAdmin, setCookie, clearCookie,
  cookieToken, SESSION_DAYS,
};
