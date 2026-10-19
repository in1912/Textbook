#!/usr/bin/env node
// Self-check for the Settings → HTTPS 证书 (self-signed) feature.
//
//   node scripts/check-ssl.mjs
//   KEEP=1 node scripts/check-ssl.mjs        # keep .smoke-ssl/
//
// Starts a throwaway installation on a free port, then checks:
//
//   - /api/admin/ssl is admin-only (401 anonymous, 403 for a normal user);
//   - generating a certificate writes data/ssl/cert.pem|key.pem, classifies
//     DNS/IP SANs, pairs the key and flags pending_restart;
//   - the PEM files can be downloaded byte-for-byte;
//   - uploads reject garbage and mismatched pairs, accept the real pair;
//   - TEXTBOOK_NO_RESTART=1 makes /restart a suppressed no-op;
//   - after a real restart the same port answers BOTH http:// and https://,
//     including a 1.4 MB POST (the sniffer must not reorder the first chunk);
//   - the SPA renders the panel and can generate a certificate from the UI.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.smoke-ssl');
const PW = process.env.PLAYWRIGHT_DIR || 'D:/CC/Alleyu/node_modules';
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(PW, 'playwright'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}
function waitExit(child, ms = 8000) {
  return Promise.race([
    new Promise((r) => child.once('exit', r)),
    sleep(ms),
  ]);
}

async function waitHealth(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return null;
}

function httpsRequest(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, method, path: p, headers,
      rejectUnauthorized: false, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
        json() { try { return JSON.parse(this.text); } catch { return null; } },
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeInstall() {
  const dir = path.join(WORK, 'app');
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.version = '1.3.0-ssl';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.cpSync(path.join(ROOT, 'web', 'dist'), path.join(dir, 'web', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

function startServer(dir, port, log, noRestart) {
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, ['--experimental-sqlite', path.join(dir, 'server', 'index.js')], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      TEXTBOOK_DATA_DIR: path.join(dir, 'data'),
      TEXTBOOK_WEB_DIST: path.join(dir, 'web', 'dist'),
      TEXTBOOK_ADMIN_USER: 'admin',
      TEXTBOOK_ADMIN_PASS: '',
      TEXTBOOK_NO_RESTART: noRestart ? '1' : '',
      NODE_PATH: path.join(ROOT, 'node_modules'),
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  return child;
}

async function login(port, username, password) {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) return null;
  return (await r.json()).token;
}

async function main() {
  rmrf(WORK);
  const dir = makeInstall();
  const dataDir = path.join(dir, 'data');
  const sslDir = path.join(dataDir, 'ssl');
  const port = await freePort();
  const log = path.join(dir, 'server.log');

  let server = startServer(dir, port, log, true);
  let browser = null;
  try {
    const health = await waitHealth(port, 15000);
    check('server is up', !!health && health.version === '1.3.0-ssl', JSON.stringify(health));

    // ---- auth boundaries ---------------------------------------------------
    let r = await fetch(`http://127.0.0.1:${port}/api/admin/ssl/status`);
    check('ssl status requires a login (401)', r.status === 401, String(r.status));

    const adminToken = await login(port, 'admin', 'admin123');
    check('admin can log in', !!adminToken);
    const sslGet = (p) => fetch(`http://127.0.0.1:${port}/api/admin/ssl${p}${p.includes('?') ? '&' : '?'}token=${adminToken}`);
    const sslPost = (p, body) => fetch(`http://127.0.0.1:${port}/api/admin/ssl${p}?token=${adminToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });

    r = await sslGet('/status');
    let st = await r.json();
    check('status starts unconfigured', r.ok && st.configured === false, JSON.stringify(st).slice(0, 160));
    check('status points at <data>/ssl', st.dir === sslDir, st.dir);
    check('status advertises the 825-day cap', st.max_days === 825 && st.remind_days === 30, `${st.max_days}/${st.remind_days}`);

    // A normal user must be refused even though the login gate passes.
    await fetch(`http://127.0.0.1:${port}/api/admin/users?token=${adminToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'student', password: 'student123', role: 'user' }),
    });
    const userToken = await login(port, 'student', 'student123');
    r = await fetch(`http://127.0.0.1:${port}/api/admin/ssl/status?token=${userToken}`);
    check('ssl status is 403 for a non-admin user', r.status === 403, String(r.status));

    // ---- generate ----------------------------------------------------------
    r = await sslPost('/generate', { cn: 'textbook.local', san: ['192.168.1.50', 'alt.test'], days: 30, org: 'TB' });
    const gen = await r.json();
    check('generate succeeds', r.ok && gen.ok === true, JSON.stringify(gen).slice(0, 200));
    check('DNS SANs include CN, the extra host and localhost',
      (gen.dns || []).includes('textbook.local') && (gen.dns || []).includes('alt.test') && (gen.dns || []).includes('localhost'),
      JSON.stringify(gen.dns));
    check('IP SANs include the extra IPv4 and 127.0.0.1',
      (gen.ips || []).includes('192.168.1.50') && (gen.ips || []).includes('127.0.0.1'), JSON.stringify(gen.ips));
    check('requested days are honoured', gen.days === 30, String(gen.days));
    check('cert.pem and key.pem exist on disk',
      fs.existsSync(path.join(sslDir, 'cert.pem')) && fs.existsSync(path.join(sslDir, 'key.pem')));

    st = (await (await sslGet('/status')).json());
    check('status is now configured', st.configured === true, JSON.stringify(st).slice(0, 160));
    check('the certificate parses and the key matches', st.key_matches === true, String(st.key_matches));
    check('SAN text lists every name',
      /textbook\.local/.test(st.san) && /alt\.test/.test(st.san) && /192\.168\.1\.50/.test(st.san), st.san);
    check('days_left is about 30', st.days_left >= 29 && st.days_left <= 30, String(st.days_left));
    check('a freshly written pair is flagged pending_restart', st.pending_restart === true, String(st.pending_restart));

    // ---- downloads ---------------------------------------------------------
    const diskCert = fs.readFileSync(path.join(sslDir, 'cert.pem'), 'utf8');
    const diskKey = fs.readFileSync(path.join(sslDir, 'key.pem'), 'utf8');
    r = await sslGet('/file/cert');
    const dlCert = await r.text();
    check('cert download is byte-identical to disk', r.ok && dlCert === diskCert);
    check('cert download sets an attachment filename',
      /filename="cert\.pem"/.test(r.headers.get('content-disposition') || ''),
      r.headers.get('content-disposition') || '');
    r = await sslGet('/file/key');
    const dlKey = await r.text();
    check('key download is byte-identical to disk', r.ok && dlKey === diskKey);

    // ---- uploads -----------------------------------------------------------
    r = await sslPost('/upload', { cert: 'not a cert', key: 'not a key' });
    check('garbage upload is rejected (400)', r.status === 400, String(r.status));
    r = await sslPost('/upload', { cert: diskCert });
    check('upload without a key is rejected (400)', r.status === 400, String(r.status));

    const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ type: 'pkcs8', format: 'pem' });
    r = await sslPost('/upload', { cert: diskCert, key: otherKey });
    const mismatch = await r.json().catch(() => ({}));
    check('certificate + unrelated key is rejected as mismatch',
      r.status === 400 && mismatch.error === 'mismatch', `${r.status} ${JSON.stringify(mismatch)}`);

    r = await sslPost('/upload', { cert: diskCert, key: diskKey });
    check('the real pair is accepted', r.ok, String(r.status));
    const backups = fs.readdirSync(sslDir).filter((n) => n.startsWith('backup-'));
    check('replacing a pair leaves a backup directory', backups.length >= 1, backups.join(','));
    check('the upload did not change the files',
      fs.readFileSync(path.join(sslDir, 'cert.pem'), 'utf8') === diskCert);

    // ---- restart (suppressed in self-check mode) ---------------------------
    r = await sslPost('/restart', {});
    const sup = await r.json();
    check('TEXTBOOK_NO_RESTART=1 turns restart into a suppressed no-op',
      r.ok && sup.restart === 'suppressed', JSON.stringify(sup));
    r = await fetch(`http://127.0.0.1:${port}/api/health`);
    check('the server is still the same process after a suppressed restart', r.ok);

    // ---- real restart: same port must answer http and https ----------------
    killPid(server.pid);
    await waitExit(server);
    await sleep(400);
    server = startServer(dir, port, log, false);
    const health2 = await waitHealth(port, 20000);
    check('server restarts with the certificate', !!health2);
    const bootLog = fs.readFileSync(log, 'utf8');
    check('the log announces the HTTP/HTTPS adaptive port',
      bootLog.includes('HTTP/HTTPS 同端口自适应'), bootLog.split('\n').filter((l) => l.includes('listening')).slice(-2).join(' | '));

    const h = await httpsRequest(port, { path: '/api/health' });
    check('https:// works on the same port', h.status === 200 && h.json() && h.json().name === 'textbook',
      `${h.status} ${h.text.slice(0, 80)}`);
    r = await fetch(`http://127.0.0.1:${port}/api/health`);
    check('http:// still works on the same port', r.ok);

    // The sniffer forwards the first chunk immediately. A body larger than one
    // TCP read proves the bytes were not dropped or reordered.
    const bigPad = 'x'.repeat(1400 * 1024);
    const bigBody = JSON.stringify({ username: 'admin', password: 'admin123', pad: bigPad });
    const bigHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bigBody) };
    let hh = await httpsRequest(port, { method: 'POST', path: '/api/auth/login', headers: bigHeaders, body: bigBody });
    check('a 1.4MB POST survives the TLS sniffer', hh.status === 200 && !!hh.json().token, `${hh.status} ${hh.text.slice(0, 120)}`);
    r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: bigHeaders, body: bigBody });
    check('a 1.4MB POST survives the plain-HTTP branch', r.ok, String(r.status));

    const token2 = (await r.json()).token;
    hh = await httpsRequest(port, { path: `/api/admin/ssl/status?token=${token2}` });
    const st2 = hh.json();
    check('https admin api works', hh.status === 200 && st2 && st2.configured === true, `${hh.status}`);
    check('pending_restart clears after the restart', st2 && st2.pending_restart === false, String(st2 && st2.pending_restart));

    // ---- UI ----------------------------------------------------------------
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept().catch(() => {}));

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.login-page').waitFor({ timeout: 15000 });
    await page.locator('input[autocomplete="username"]').fill('admin');
    await page.locator('input[type="password"]').fill('admin123');
    await page.locator('.login-submit').click();
    await page.locator('nav.tabs').waitFor({ timeout: 15000 });
    await page.locator('nav.tabs button.tab', { hasText: '设置' }).click();

    const statusCard = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'HTTPS 证书' }) });
    await statusCard.waitFor({ timeout: 15000 });
    const statusText = await statusCard.innerText();
    check('设置 renders the 当前签名 card', statusText.includes('当前签名'), statusText.slice(0, 120));
    check('the panel shows the expiry reminder (≤ remind_days)',
      statusText.includes('证书还有') && statusText.includes('天到期'), statusText.slice(0, 200));
    check('the panel lists the SAN names',
      statusText.includes('textbook.local') && statusText.includes('192.168.1.50'), statusText.slice(0, 400));
    check('the panel shows the file location', statusText.includes(sslDir), statusText.slice(0, 400));
    check('the panel reports the key pair as matching', statusText.includes('匹配'), statusText.slice(0, 400));

    const genCard = page.locator('.card').filter({ has: page.locator('h3', { hasText: '生成新证书' }) });
    await genCard.waitFor({ timeout: 10000 });
    const cnInput = genCard.locator('label.field', { hasText: '通用名称' }).locator('input');
    const sanInput = genCard.locator('label.field', { hasText: '附加域名' }).locator('input');
    check('the generate form is prefilled with the visiting IP as SAN',
      (await sanInput.inputValue()) === '127.0.0.1', await sanInput.inputValue());

    // Download from the UI.
    let downloadName = '';
    try {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 8000 }),
        statusCard.locator('button', { hasText: '下载证书' }).click(),
      ]);
      downloadName = dl.suggestedFilename();
    } catch { /* download event unsupported in this environment */ }
    check('the cert downloads from the UI', downloadName === 'cert.pem', downloadName);

    // Generate from the UI.
    await cnInput.fill('ui.textbook.test');
    await genCard.locator('button', { hasText: '生成并替换证书' }).click();
    await page.getByText('新证书已生成').waitFor({ timeout: 15000 });
    check('the UI generates a certificate', true);
    await statusCard.getByText('证书文件已替换').waitFor({ timeout: 8000 });
    check('the UI flags the replaced certificate as pending restart', true);
    check('the new certificate is on disk',
      fs.readFileSync(path.join(sslDir, 'cert.pem'), 'utf8').includes('BEGIN CERTIFICATE')
      && new crypto.X509Certificate(fs.readFileSync(path.join(sslDir, 'cert.pem'))).subject.includes('ui.textbook.test'));
    check('no page errors in the settings view', errors.length === 0, errors.join(' | '));

    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log('\nFailures:');
      for (const f of failures) console.log('  - ' + f);
    }
  } catch (e) {
    console.error('\nFATAL', e);
    failures.push('fatal: ' + (e && e.message));
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    if (server && !server.killed) { killPid(server.pid); await waitExit(server); }
    if (!process.env.KEEP) rmrf(WORK);
  }
  process.exit(failures.length ? 1 : 0);
}

main();
