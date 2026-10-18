// Standalone AI configuration and an OpenAI-compatible chat client.
//
// The API key is encrypted at rest with AES-256-GCM. The key material lives in
// data/secret.key (or TEXTBOOK_SECRET), separate from the database file, so a
// copied .sqlite alone does not leak the credential.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

const ROW_KEY = 'ai_config';
let cachedKey = null;

function secretKey() {
  if (cachedKey) return cachedKey;
  const env = process.env.TEXTBOOK_SECRET;
  if (env) { cachedKey = crypto.createHash('sha256').update(String(env)).digest(); return cachedKey; }
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) { cachedKey = Buffer.from(hex, 'hex'); return cachedKey; }
  } catch { /* create below */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k.toString('hex'), { mode: 0o600 });
  cachedKey = k;
  return k;
}

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(parts[1], 'base64'));
    d.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
  } catch { return ''; }
}

function readRow() {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(ROW_KEY);
    if (!row || !row.value) return {};
    const obj = JSON.parse(row.value);
    return {
      base_url: String(obj.base_url || ''),
      model: String(obj.model || ''),
      api_key: obj.enc ? decrypt(obj.enc) : '',
    };
  } catch { return {}; }
}

function writeRow(cfg) {
  const value = JSON.stringify({
    base_url: cfg.base_url || '',
    model: cfg.model || '',
    enc: cfg.api_key ? encrypt(cfg.api_key) : '',
  });
  db.prepare(`INSERT INTO app_settings(key, value, updated_at) VALUES(?,?,datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(ROW_KEY, value);
}

function getConfig() { return readRow(); }
function hasConfig() {
  const c = readRow();
  return !!(c.model && c.base_url && c.api_key);
}

function publicConfig() {
  const c = readRow();
  const hint = c.api_key ? '••••' + c.api_key.slice(-4) : '';
  return {
    base_url: c.base_url || '',
    model: c.model || '',
    has_key: !!c.api_key,
    key_hint: hint,
  };
}

function saveConfig({ base_url, model, api_key }) {
  const cur = readRow();
  const next = {
    base_url: String(base_url == null ? cur.base_url : base_url).trim().replace(/\/+$/, ''),
    model: String(model == null ? cur.model : model).trim(),
    api_key: api_key == null || api_key === '' ? cur.api_key : String(api_key).trim(),
  };
  writeRow(next);
  return publicConfig();
}

function chatEndpoint(base) {
  return String(base || '').replace(/\/+$/, '').replace(/\/chat\/completions$/i, '') + '/chat/completions';
}

async function chatEx(messages, { maxTokens = 1024, temperature = 0.7 } = {}) {
  const cfg = readRow();
  if (!cfg.model || !cfg.base_url || !cfg.api_key) {
    const e = new Error('AI 尚未配置，请先在「设置」中填写接口地址、模型名称和 API Key');
    e.code = 'ai_unconfigured';
    throw e;
  }
  const url = chatEndpoint(cfg.base_url);
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the raw url in the message */ }
  const attempt = async () => {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: false,
        }),
        signal: AbortSignal.timeout(150000),
      });
    } catch (e) {
      // fetch() only rejects for transport problems; make the reason readable
      const reason = e.name === 'TimeoutError' ? '150 秒内没有响应' : (e.cause && e.cause.code) || e.message || '未知原因';
      const err = new Error(`连不上 AI 接口 ${host}：${reason}（请检查接口地址、网络和代理）`);
      err.name = e.name;
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`AI 接口错误 ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  let data;
  try {
    data = await attempt();
  } catch (e) {
    const retryable = e.status === 408 || e.status === 429 || (e.status >= 500 && e.status < 600) || e.name === 'TimeoutError';
    if (!retryable) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    data = await attempt();
  }
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  const content = (msg && (msg.content || msg.reasoning_content)) || '';
  if (!content) throw new Error('AI 返回内容为空，请重试一次');
  const u = data.usage || null;
  return {
    content: String(content).trim(),
    model: cfg.model,
    usage: u ? {
      prompt_tokens: u.prompt_tokens == null ? null : u.prompt_tokens,
      completion_tokens: u.completion_tokens == null ? null : u.completion_tokens,
      total_tokens: u.total_tokens == null ? null : u.total_tokens,
    } : null,
    finish_reason: data.choices && data.choices[0] ? data.choices[0].finish_reason : null,
  };
}

async function testConnection() {
  const t0 = Date.now();
  const r = await chatEx([{ role: 'user', content: '请只回复：OK' }], { maxTokens: 16, temperature: 0 });
  return { ok: true, model: r.model, ms: Date.now() - t0, reply: r.content.slice(0, 40) };
}

module.exports = { getConfig, publicConfig, saveConfig, hasConfig, chatEx, testConnection, chatEndpoint };
