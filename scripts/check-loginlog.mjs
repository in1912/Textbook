#!/usr/bin/env node
// Self-check for 登录日志 + IP 黑名单.
//
//   node scripts/check-loginlog.mjs
//   KEEP=1 node scripts/check-loginlog.mjs      # keep .smoke-loginlog/
//
// Starts a throwaway installation (copied server + built SPA, temp data dir) on
// a free port, then drives the real HTTP API and the real page with Playwright:
//
//   - failed / successful / blocked attempts all land in the log;
//   - the attempted password comes back readable but is not stored in plaintext;
//   - the Chinese display name, client label and private-IP region are filled;
//   - pagination defaults to 5 rows and honours 5/15/30/50/100, with prev/next;
//   - the blacklist rejects malformed IPs, blocks with the correct password,
//     records the attempt as 拦截, and unban restores login;
//   - a non-admin gets 403 from /api/admin/login-logs and sees no tab.
//
// TEXTBOOK_GEO=off keeps the check offline (region for public IPs stays empty).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TEST_VERSION = REPO_VERSION + '-logtest';
const WORK = path.join(ROOT, '.smoke-loginlog');
const PW = process.env.PLAYWRIGHT_DIR || 'D:/CC/Alleyu/node_modules';
const require = createRequire(import.meta.url);

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
  const dir = path.join(WORK, 'app');
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.version = TEST_VERSION;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.cpSync(path.join(ROOT, 'web', 'dist'), path.join(dir, 'web', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });

  // Plant one row in the v1.4.0 format (localtime, no trailing Z) before the
  // server starts, so the startup migration is exercised for real.
  const seed = path.join(WORK, 'seed.cjs');
  fs.writeFileSync(seed, `
const { db } = require(${JSON.stringify(path.join(dir, 'server', 'db.js'))});
require(${JSON.stringify(path.join(dir, 'server', 'schema.js'))}).ensureSchema(db);
db.prepare("INSERT INTO tb_login_logs(at, username, display_name, status, ip) VALUES (datetime('now','localtime'),'legacy','旧版','ok','192.0.2.99')").run();
console.log(db.prepare("SELECT at FROM tb_login_logs WHERE username='legacy'").get().at);
`);
  const seeded = execFileSync(process.execPath, ['--experimental-sqlite', seed], {
    cwd: dir,
    env: { ...process.env, TEXTBOOK_DATA_DIR: path.join(dir, 'data'), NODE_PATH: path.join(ROOT, 'node_modules') },
    encoding: 'utf8',
  }).trim();
  if (/Z$/.test(seeded)) throw new Error('seed row unexpectedly already UTC: ' + seeded);
  return dir;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function main() {
  rmrf(WORK);
  const dir = makeInstall();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
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
      TEXTBOOK_ADMIN_PASS: 'admin123',
      TEXTBOOK_GEO: 'off',
      TEXTBOOK_NO_RESTART: '1',
      NODE_PATH: path.join(ROOT, 'node_modules'),
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);

  function req(pathname, { method = 'GET', token, body, ip = '192.0.2.10', ua = UA } = {}) {
    const headers = { 'User-Agent': ua, 'X-Forwarded-For': ip };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(base + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  }
  const login = (username, password, ip = '192.0.2.10', ua = UA) =>
    req('/api/auth/login', { method: 'POST', body: { username, password }, ip, ua });

  let browser = null;
  try {
    const health = await waitHealth(port, 15000);
    check('server is up', !!health && health.version === TEST_VERSION, JSON.stringify(health));

    // ---- anonymous / admin auth ----
    let r = await req('/api/admin/login-logs');
    check('login log requires a login', r.status === 401, String(r.status));

    r = await login('admin', 'WrongPass!123', '198.51.100.10');
    check('a wrong password is rejected', r.status === 401, String(r.status));
    r = await login('admin', 'admin123', '198.51.100.11');
    check('a correct password returns a token', r.status === 200 && r.data && r.data.token, String(r.status));
    const adminToken = r.data.token;

    r = await req('/api/admin/login-logs?page=1&page_size=5', { token: adminToken });
    check('the log endpoint answers an admin', r.status === 200, String(r.status));
    const first = r.data.items || [];
    const failRow = first.find((x) => x.status === 'fail');
    check('the failed attempt is logged with the typed password',
      !!failRow && failRow.password === 'WrongPass!123', JSON.stringify(failRow && { s: failRow.status, p: failRow.password }));
    check('the failed attempt keeps the IP', !!failRow && failRow.ip === '198.51.100.10', failRow && failRow.ip);
    check('the log time is stored as UTC', !!failRow && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(failRow.at), failRow && failRow.at);
    const legacyRow = first.find((x) => x.username === 'legacy');
    check('a v1.4.0 localtime row is migrated to UTC at startup',
      !!legacyRow && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(legacyRow.at), legacyRow && legacyRow.at);
    check('the migrated legacy time still points at the same moment',
      !!legacyRow && Math.abs(new Date(legacyRow.at).getTime() - Date.now()) < 2 * 60 * 1000,
      legacyRow && String(Math.round((Date.now() - new Date(legacyRow.at).getTime()) / 1000)) + 's');
    check('the Chinese display name is filled', !!failRow && failRow.display_name === '管理员', failRow && failRow.display_name);
    check('the client label is parsed', !!failRow && /Chrome/.test(failRow.client) && /Windows/.test(failRow.client), failRow && failRow.client);
    check('a successful login is marked ok', first.some((x) => x.status === 'ok' && x.username === 'admin'));
    check('default page size is 5', r.data.page_size === 5 && first.length <= 5, JSON.stringify({ size: r.data.page_size, n: first.length }));
    check('the log is newest-first', first.length < 2 || first[0].id > first[1].id);

    // private addresses never leave the machine
    await login('admin', 'nope', '192.168.1.5');
    r = await req('/api/admin/login-logs?page=1&page_size=5', { token: adminToken });
    const privateRow = (r.data.items || []).find((x) => x.ip === '192.168.1.5');
    check('private IPs are labelled 内网', !!privateRow && privateRow.region === '内网', privateRow && privateRow.region);

    // ---- pagination ----
    for (let i = 1; i <= 6; i++) await login('nobody' + i, 'bad', `10.0.0.${i}`);
    r = await req('/api/admin/login-logs?page=1&page_size=5', { token: adminToken });
    const p1 = r.data;
    check('the log grew past one page', p1.total > 5 && p1.pages >= 2, JSON.stringify({ total: p1.total, pages: p1.pages }));
    check('page 1 holds exactly 5 rows', p1.items.length === 5 && p1.page === 1, JSON.stringify({ n: p1.items.length, page: p1.page }));
    r = await req('/api/admin/login-logs?page=2&page_size=5', { token: adminToken });
    const p2 = r.data;
    check('page 2 continues without overlap',
      p2.items.length > 0 && p2.page === 2 && !p2.items.some((x) => p1.items.some((y) => y.id === x.id)),
      JSON.stringify({ n: p2.items.length, page: p2.page }));
    r = await req('/api/admin/login-logs?page=1&page_size=7', { token: adminToken });
    check('an unsupported page size falls back to 5', r.data.page_size === 5, String(r.data.page_size));

    // ---- non-admin ----
    r = await req('/api/admin/users', { method: 'POST', token: adminToken, body: { username: 'student1', password: 'userpass1', role: 'user' } });
    check('an admin can create a normal user', r.status === 200, String(r.status));
    r = await login('student1', 'userpass1', '198.51.100.12');
    const userToken = r.data && r.data.token;
    check('the normal user can log in', r.status === 200 && !!userToken, String(r.status));
    r = await req('/api/admin/login-logs', { token: userToken });
    check('a non-admin gets 403 from the log endpoint', r.status === 403, String(r.status));

    // ---- blacklist ----
    r = await req('/api/admin/ip-blacklist', { method: 'POST', token: adminToken, body: { ip: 'not-an-ip', note: 'x' } });
    check('a malformed IP is rejected', r.status === 400, String(r.status));
    r = await req('/api/admin/ip-blacklist', { method: 'POST', token: adminToken, body: { ip: '203.0.113.77', note: '测试封禁' } });
    check('a valid IP is added to the blacklist', r.status === 200 && r.data.item && r.data.item.ip === '203.0.113.77', JSON.stringify(r.data));
    r = await req('/api/admin/ip-blacklist', { token: adminToken });
    check('the blacklist lists the IP with its note', (r.data.items || []).some((x) => x.ip === '203.0.113.77' && x.note === '测试封禁'), JSON.stringify(r.data.items));

    r = await login('admin', 'admin123', '203.0.113.77');
    check('a blacklisted IP cannot log in even with the right password', r.status === 403 && r.data && r.data.error === 'ip_blocked', String(r.status));
    r = await req('/api/admin/login-logs?page=1&page_size=5', { token: adminToken });
    const blockedRow = (r.data.items || []).find((x) => x.ip === '203.0.113.77');
    check('the blocked attempt is logged as 拦截', !!blockedRow && blockedRow.status === 'blocked', blockedRow && blockedRow.status);
    check('the log row knows the IP is blacklisted', !!blockedRow && blockedRow.blacklisted === true, String(blockedRow && blockedRow.blacklisted));

    r = await req('/api/admin/ip-blacklist/203.0.113.77', { method: 'DELETE', token: adminToken });
    check('the IP can be unbanned', r.status === 200 && r.data.removed === 1, JSON.stringify(r.data));
    r = await login('admin', 'admin123', '203.0.113.77');
    check('an unbanned IP can log in again', r.status === 200, String(r.status));

    // ---- rate limit is recorded as 拦截 ----
    for (let i = 0; i < 8; i++) await login('admin', 'bad' + i, '203.0.113.99');
    r = await login('admin', 'admin123', '203.0.113.99');
    check('too many failures are blocked', r.status === 429, String(r.status));
    r = await req('/api/admin/login-logs?page=1&page_size=5', { token: adminToken });
    const limited = (r.data.items || []).find((x) => x.ip === '203.0.113.99' && x.status === 'blocked');
    check('the rate-limited attempt is logged as 拦截', !!limited, JSON.stringify(r.data.items.map((x) => [x.ip, x.status])));

    // ---- password at rest ----
    const dbBytes = [path.join(dir, 'data', 'textbook.sqlite'), path.join(dir, 'data', 'textbook.sqlite-wal')]
      .map((p) => (fs.existsSync(p) ? fs.readFileSync(p).toString('latin1') : ''))
      .join('\n');
    check('the attempted password is not stored in plaintext', !dbBytes.includes('WrongPass!123'));

    // ---- browser ----
    const { chromium } = require(path.join(PW, 'playwright'));
    browser = await chromium.launch({ headless: true });
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('dialog', (d) => d.accept().catch(() => {}));

    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.locator('.login-page').waitFor({ timeout: 15000 });
    await page.locator('input[autocomplete="username"]').fill('admin');
    await page.locator('input[type="password"]').fill('admin123');
    await page.locator('.login-submit').click();
    await page.locator('nav.tabs').waitFor({ timeout: 15000 });

    const tab = page.locator('nav.tabs button', { hasText: '登录日志' });
    check('the 登录日志 tab is shown to an admin', (await tab.count()) === 1 && await tab.isVisible());
    await tab.click();
    await page.locator('table.logs').waitFor({ timeout: 15000 });
    await sleep(400);

    const headers = await page.locator('table.logs thead th').allInnerTexts();
    const wanted = ['操作日期时间', '用户名', '中文名称', '状态', 'IP地址', '地区', '尝试的密码', '客户端', '操作'];
    check('the table has all nine columns', wanted.every((h) => headers.includes(h)), headers.join('|'));
    check('the page-size selector defaults to 5', await page.locator('.pager select').inputValue() === '5');
    const rowCount1 = await page.locator('table.logs tbody tr').count();
    check('the first page shows at most 5 rows', rowCount1 <= 5 && rowCount1 > 0, String(rowCount1));
    const firstTime = (await page.locator('table.logs tbody tr').first().locator('td').first().innerText()).trim();
    check('the UTC timestamp is shown in local time', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(firstTime), firstTime);
    const drift = Math.abs(new Date(firstTime.replace(' ', 'T')).getTime() - Date.now());
    check('the shown time is the login that just happened', drift < 10 * 60 * 1000, String(Math.round(drift / 1000)) + 's');
    const pagerText = await page.locator('.pager .muted').first().innerText();
    check('the pager reports page 1', pagerText.includes('第 1 /'), pagerText);

    await page.locator('.pager button', { hasText: '下一页' }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector('.pager .muted');
      return el && el.innerText.includes('第 2 /');
    }, null, { timeout: 5000 });
    check('下一页 moves to page 2', true);
    await page.locator('.pager button', { hasText: '上一页' }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector('.pager .muted');
      return el && el.innerText.includes('第 1 /');
    }, null, { timeout: 5000 });
    check('上一页 returns to page 1', true);

    await page.locator('.pager select').selectOption('15');
    await page.waitForFunction(() => {
      const el = document.querySelector('.pager .muted');
      return el && el.innerText.includes('第 1 /');
    }, null, { timeout: 5000 });
    const rowCount15 = await page.locator('table.logs tbody tr').count();
    check('15 rows per page is honoured', rowCount15 > rowCount1 && rowCount15 <= 15, String(rowCount15));

    const ipInput = page.locator('input[placeholder^="IP 地址"]');
    await ipInput.fill('198.51.100.200');
    await page.locator('input[placeholder^="备注名"]').fill('UI 测试');
    await page.locator('.card').last().locator('button', { hasText: '封禁' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('198.51.100.200'), null, { timeout: 8000 });
    check('the blacklist form adds an IP from the page', true);
    const banRow = page.locator('table.ban-list tbody tr', { hasText: '198.51.100.200' });
    check('the blacklist table shows the note', (await banRow.innerText()).includes('UI 测试'));

    if (process.env.SHOT) {
      // The panel is its own scroll container, so let it grow before the shot.
      await page.locator('.pager select').selectOption('5');
      await sleep(500);
      await page.addStyleTag({ content: '.panel{height:auto!important;overflow:visible!important}' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(200);
      await page.screenshot({ path: path.join(ROOT, 'img', '登录日志.png'), fullPage: true });
      console.log('  📷 img/登录日志.png');
    }
    await banRow.locator('button', { hasText: '解封' }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('198.51.100.200'), null, { timeout: 8000 });
    check('the page can unban again', true);

    check('no page errors on the 登录日志 screen', errors.length === 0, errors.join(' | '));

    // A normal user must not see the tab.
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page2 = await context2.newPage();
    await page2.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page2.locator('.login-page').waitFor({ timeout: 15000 });
    await page2.locator('input[autocomplete="username"]').fill('student1');
    await page2.locator('input[type="password"]').fill('userpass1');
    await page2.locator('.login-submit').click();
    await page2.locator('nav.tabs').waitFor({ timeout: 15000 });
    await sleep(500);
    check('a normal user does not see the 登录日志 tab',
      (await page2.locator('nav.tabs button', { hasText: '登录日志' }).count()) === 0);
    await context2.close();

    const serverLog = fs.readFileSync(log, 'utf8');
    check('the server never logged a crash', !/\[textbook\] Error|Unhandled/.test(serverLog), serverLog.slice(-300));
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    killPid(server.pid);
    await sleep(300);
    if (!process.env.KEEP) rmrf(WORK);
  }

  console.log(`\n[check-loginlog] ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failed checks:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[check-loginlog] fatal: ' + (e && e.stack || e));
  process.exit(1);
});
