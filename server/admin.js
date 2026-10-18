// Standalone-only administration: AI provider settings and workbench-style
// multi-tenant accounts. The embedded copy never mounts this router.
const express = require('express');
const { db } = require('./db');
const auth = require('./auth');
const ai = require('./ai');

const router = express.Router();
router.use(auth.requireUser, auth.requireAdmin);

function userOut(u) {
  return {
    id: u.id, username: u.username, display_name: u.display_name || '',
    nickname: u.nickname || '', role: u.role, disabled: !!u.disabled, created_at: u.created_at,
  };
}
function enabledAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n;
}
function getUser(id) {
  return db.prepare('SELECT id, username, display_name, nickname, role, disabled, created_at FROM users WHERE id=?').get(Number(id));
}

// ---- AI configuration ------------------------------------------------------
router.get('/ai', (req, res) => res.json(ai.publicConfig()));

router.put('/ai', (req, res) => {
  const b = req.body || {};
  const model = String(b.model == null ? ai.getConfig().model : b.model).trim();
  const base = String(b.base_url == null ? ai.getConfig().base_url : b.base_url).trim();
  if (!model || !base) return res.status(400).json({ error: 'missing', message: '接口地址和模型名称不能为空' });
  if (!/^https?:\/\//i.test(base)) return res.status(400).json({ error: 'bad_url', message: '接口地址必须以 http:// 或 https:// 开头' });
  if (b.api_key != null && String(b.api_key).trim() && String(b.api_key).trim().length < 8) {
    return res.status(400).json({ error: 'bad_key', message: 'API Key 看起来太短' });
  }
  const out = ai.saveConfig({ base_url: base, model, api_key: b.api_key });
  res.json({ ok: true, ...out });
});

router.post('/ai/test', async (req, res) => {
  try {
    const r = await ai.testConnection();
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: 'ai_test_failed', message: String(e.message || e) });
  }
});

// ---- users -----------------------------------------------------------------
router.get('/users', (req, res) => {
  res.json({ items: auth.listUsers().map(userOut) });
});

router.post('/users', (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const role = b.role === 'admin' ? 'admin' : 'user';
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'bad_username', message: '账号需为 3-32 位字母、数字、下划线、点或短横线' });
  }
  if (password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: 'bad_password', message: '密码长度需为 6-128 位' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(409).json({ error: 'exists', message: '账号已存在' });
  const display = String(b.display_name || '').trim().slice(0, 40) || username;
  const r = db.prepare('INSERT INTO users(username, password_hash, role, display_name) VALUES(?,?,?,?)')
    .run(username, auth.hashPassword(password), role, display);
  res.json({ ok: true, user: userOut(getUser(r.lastInsertRowid)) });
});

router.put('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = getUser(id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const isSelf = id === Number(req.user.id);
  const role = b.role === 'admin' ? 'admin' : (b.role === 'user' ? 'user' : u.role);
  const disabled = 'disabled' in b ? !!b.disabled : !!u.disabled;

  if (isSelf && (role !== 'admin' || disabled)) {
    return res.status(400).json({ error: 'self', message: '不能停用自己或取消自己的管理员权限' });
  }
  if (u.role === 'admin' && !u.disabled && (role !== 'admin' || disabled) && enabledAdmins() <= 1) {
    return res.status(400).json({ error: 'last_admin', message: '至少要保留一个可用的管理员' });
  }
  if (b.password != null && String(b.password) !== '') {
    const p = String(b.password);
    if (p.length < 6 || p.length > 128) {
      return res.status(400).json({ error: 'bad_password', message: '密码长度需为 6-128 位' });
    }
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(p), id);
    // Password reset invalidates existing sessions of that user (except the
    // administrator who did it, when resetting their own account).
    if (!isSelf) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  if ('display_name' in b) {
    db.prepare('UPDATE users SET display_name=? WHERE id=?').run(String(b.display_name || '').trim().slice(0, 40), id);
  }
  if ('role' in b) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
  if ('disabled' in b) {
    db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled ? 1 : 0, id);
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  res.json({ ok: true, user: userOut(getUser(id)) });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = getUser(id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  if (id === Number(req.user.id)) return res.status(400).json({ error: 'self', message: '不能删除自己' });
  if (u.role === 'admin' && !u.disabled && enabledAdmins() <= 1) {
    return res.status(400).json({ error: 'last_admin', message: '至少要保留一个可用的管理员' });
  }
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  // Notes, annotations and usage stay in the database: deleting an account is
  // not meant to destroy a student's notes. An admin can still see the usage
  // rows by id if they need to audit them.
  res.json({ ok: true });
});

module.exports = router;
