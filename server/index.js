// Standalone server.
//
//   node server/index.js
//
// Serves the built SPA from web/dist, the textbook API at /api/textbook and the
// standalone-only admin API at /api/admin. Requires Node >= 22.5 for node:sqlite
// (no native modules, no build step).
const express = require('express');
const fs = require('fs');
const path = require('path');

const { db, DATA_DIR } = require('./db');
const auth = require('./auth');
const ai = require('./ai');
const adminRouter = require('./admin');
const { ensureSchema } = require('./schema');
const { createRouter } = require('./router');

ensureSchema(db);
auth.cleanupSessions();
const boot = auth.ensureAdmin();

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 9621);
const WEB_DIST = process.env.TEXTBOOK_WEB_DIST
  ? path.resolve(process.env.TEXTBOOK_WEB_DIST)
  : path.join(ROOT, 'web', 'dist');
const INDEX_HTML = path.join(WEB_DIST, 'index.html');
const defaultRoot = process.env.TEXTBOOK_ROOT
  ? path.resolve(process.env.TEXTBOOK_ROOT)
  : (fs.existsSync(path.join(ROOT, 'book')) ? path.join(ROOT, 'book') : '');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '20mb' }));

// ---- auth endpoints (public except where noted) ----------------------------
const loginHits = new Map(); // ip -> { n, until }
function loginBlocked(ip) {
  const h = loginHits.get(ip);
  if (!h) return false;
  if (Date.now() > h.until) { loginHits.delete(ip); return false; }
  return h.n >= 8;
}
function noteLoginFailure(ip) {
  const now = Date.now();
  const h = loginHits.get(ip) || { n: 0, until: now + 5 * 60 * 1000 };
  if (now > h.until) { h.n = 0; h.until = now + 5 * 60 * 1000; }
  h.n += 1;
  loginHits.set(ip, h);
}

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) {
    return res.status(429).json({ error: 'too_many', message: '尝试次数过多，请 5 分钟后再试' });
  }
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const row = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!row || row.disabled || !auth.verifyPassword(password, row.password_hash)) {
    noteLoginFailure(ip);
    return res.status(401).json({ error: 'bad_credentials', message: '账号或密码不正确' });
  }
  loginHits.delete(ip);
  const token = auth.createSession(row.id);
  auth.setCookie(res, token);
  res.json({
    token,
    user: { id: row.id, username: row.username, display_name: row.display_name, role: row.role },
  });
});

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(auth.cookieToken(req));
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) auth.destroySession(header.slice(7));
  auth.clearCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth.requireUser, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/password', auth.requireUser, (req, res) => {
  const oldPass = String((req.body && req.body.old_password) || '');
  const newPass = String((req.body && req.body.new_password) || '');
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!row || !auth.verifyPassword(oldPass, row.password_hash)) {
    return res.status(400).json({ error: 'bad_password', message: '原密码不正确' });
  }
  if (newPass.length < 6 || newPass.length > 128) {
    return res.status(400).json({ error: 'bad_password', message: '新密码长度需为 6-128 位' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(newPass), req.user.id);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  let version = '1.0.0';
  try { version = require(path.join(ROOT, 'package.json')).version; } catch { /* dev */ }
  res.json({ ok: true, name: 'textbook', version });
});

// Login gate. Public textbook share endpoints and auth routes stay open.
app.use('/api', (req, res, next) => {
  const p = req.path;
  if (p === '/auth/login' || p === '/auth/logout') return next();
  if (p === '/health') return next();
  if (p.startsWith('/textbook/pub/')) return next();
  return auth.requireUser(req, res, next);
});

// ---- textbook API ----------------------------------------------------------
const textbookRouter = createRouter({
  db,
  ai,
  defaultRoot,
  listUsers: auth.listUsers,
  isAdmin: (req) => !!(req.user && req.user.role === 'admin'),
  manageUsers: true,
  aiConfig: true,
  embedded: false,
  mountBase: '',
});
app.use('/api/textbook', textbookRouter);
app.use('/api/admin', adminRouter);

// ---- static SPA ------------------------------------------------------------
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
}
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (!fs.existsSync(INDEX_HTML)) {
    return res.status(503).type('text/plain; charset=utf-8')
      .send('前端还没有构建。请先运行：cd web && npm install && npm run build');
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(INDEX_HTML);
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).type('text/plain; charset=utf-8').send('Not found');
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[textbook]', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({
      error: 'internal',
      message: process.env.NODE_ENV === 'production' ? '服务器内部错误' : String(err.message || err),
    });
  }
  res.status(500).type('text/plain; charset=utf-8').send('Server error');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[textbook] listening on http://0.0.0.0:${PORT}`);
  console.log(`[textbook] data: ${DATA_DIR}`);
  console.log(`[textbook] web:  ${WEB_DIST}`);
  if (defaultRoot) console.log(`[textbook] default root: ${defaultRoot}`);
  else console.log('[textbook] no default book root; set it in the 设置 tab after login');
  if (boot) {
    if (boot.file) console.log(`[textbook] 初始管理员 ${boot.username} 已创建，密码写入 ${boot.file}`);
    else console.log(`[textbook] 初始管理员 ${boot.username} 已按环境变量创建`);
  }
});

// Keep the process alive on unexpected rejections but make them visible.
process.on('unhandledRejection', (e) => console.error('[textbook] unhandled rejection', e));
