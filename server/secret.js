// AES-256-GCM secret material shared by the AI API key and the login-log
// password column. The key lives in data/secret.key (or TEXTBOOK_SECRET),
// separate from the database file, so a copied .sqlite alone does not leak
// credentials or the passwords people typed into the login screen.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

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

module.exports = { secretKey, encrypt, decrypt };
