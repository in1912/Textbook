#!/usr/bin/env node
// Browser self-check for 设置 → 系统升级.
//
//   node scripts/check-upgrade-ui.mjs
//   KEEP=1 node scripts/check-upgrade-ui.mjs     # keep .smoke-upgrade-ui/
//
// Starts a throwaway installation (copy of server/, package.json and the real
// web/dist) on a free port with TEXTBOOK_NO_RESTART=1, logs in with Playwright,
// uploads textbook-upgrade-<version>.zip, runs preflight, applies it, and
// checks what the page says. The real repository is never modified.
//
// Playwright lives in the Alleyu workspace; point PLAYWRIGHT_DIR at another
// node_modules that contains it if needed.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_VER = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const WORK = path.join(ROOT, '.smoke-upgrade-ui');
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
async function waitHealth(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return null;
}
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function makeInstall() {
  const dir = path.join(WORK, 'ui');
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.version = '1.0.0-ui';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.cpSync(path.join(ROOT, 'web', 'dist'), path.join(dir, 'web', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

async function main() {
  const pack = path.join(ROOT, `textbook-upgrade-${REPO_VER}.zip`);
  if (!fs.existsSync(pack)) {
    console.error(`[check-upgrade-ui] 缺少升级包 ${path.basename(pack)}，先运行 npm run pack:upgrade`);
    process.exit(1);
  }
  rmrf(WORK);
  const dir = makeInstall();
  const port = await freePort();
  const log = path.join(dir, 'server.log');
  const fd = fs.openSync(log, 'a');
  const server = spawn(process.execPath, ['--experimental-sqlite', path.join(dir, 'server', 'index.js')], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      TEXTBOOK_DATA_DIR: path.join(dir, 'data'),
      TEXTBOOK_WEB_DIST: path.join(dir, 'web', 'dist'),
      TEXTBOOK_ADMIN_USER: 'admin',
      TEXTBOOK_ADMIN_PASS: 'testpass123',
      TEXTBOOK_NO_RESTART: '1',
      NODE_PATH: path.join(ROOT, 'node_modules'),
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);

  let browser = null;
  const errors = [];
  const badResponses = [];
  let loggedIn = false;
  try {
    const health = await waitHealth(port, 15000);
    check('server is up', !!health && health.version === '1.0.0-ui', JSON.stringify(health));

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    // Before login the SPA probes /api/textbook/settings and gets 401 — that is
    // the login trigger, not a failure. After login, 400 from /tree and /covers
    // is also expected: this throwaway install has no book root configured.
    // Only auth failures and 5xx indicate a real problem here.
    page.on('response', (r) => {
      if (loggedIn && (r.status() === 401 || r.status() === 403 || r.status() >= 500)) {
        badResponses.push(r.status() + ' ' + r.url());
      }
    });
    page.on('dialog', (d) => d.accept());

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[autocomplete="username"]').fill('admin');
    await page.locator('input[type="password"]').fill('testpass123');
    await page.locator('.login-submit').click();
    await page.locator('nav.tabs').waitFor({ timeout: 15000 });
    loggedIn = true;
    check('logged in and the tab bar is visible', true);

    await page.locator('nav.tabs button.tab', { hasText: '设置' }).click();
    await page.getByText('系统升级', { exact: true }).waitFor({ timeout: 10000 });
    check('settings shows the 系统升级 card', true);

    const hint = await page.locator('.card', { hasText: '系统升级' }).innerText();
    check('running version is shown', hint.includes('1.0.0-ui'), hint.slice(0, 120));

    await page.locator('input[type="file"]').setInputFiles(pack);
    await page.locator('button', { hasText: '预检' }).click();
    await page.locator('text=应用升级').waitFor({ timeout: 20000 });
    const planText = await page.locator('.up-plan').innerText();
    check(`preflight renders a plan for v${REPO_VER}`, planText.includes(REPO_VER) && planText.includes('覆盖'),
      planText.slice(0, 160));
    check('plan says the server will restart', planText.includes('自动重启'));

    await page.locator('button', { hasText: '应用升级' }).click();
    await page.getByText('升级完成', { exact: false }).waitFor({ timeout: 20000 });
    const done = await page.locator('.chip').filter({ hasText: '升级完成' }).first().innerText().catch(() => '');
    check('apply reports success', done.includes('v' + REPO_VER), done);

    // With TEXTBOOK_NO_RESTART=1 the page must say the process kept running.
    await sleep(1200);
    const card = await page.locator('.card', { hasText: '系统升级' }).innerText();
    check('page says the new files are on disk but not running', card.includes('磁盘上是') && card.includes(REPO_VER),
      card.slice(0, 200));

    await page.screenshot({ path: path.join(WORK, 'settings-upgrade.png'), fullPage: true });
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    check('no auth failures or server errors after login', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    killPid(server.pid);
    await sleep(300);
    if (!process.env.KEEP) rmrf(WORK);
    else console.log(`  kept ${WORK} (server log: ${path.join(WORK, 'ui', 'server.log')})`);
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[check-upgrade-ui] fatal:', e);
  if (!process.env.KEEP) { try { rmrf(WORK); } catch { /* ignore */ } }
  process.exit(1);
});
