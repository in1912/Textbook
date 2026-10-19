#!/usr/bin/env node
// Browser self-check for the settings/crash-log work.
//
//   node scripts/check-features.mjs
//   KEEP=1 node scripts/check-features.mjs     # keep .smoke-features/
//
// Starts a throwaway installation on a free port with no TEXTBOOK_ADMIN_PASS,
// so the default admin/admin123 rule is what gets tested. Then it drives the
// real SPA with Playwright:
//
//   - the login screen no longer mentions initial-admin.txt;
//   - admin/admin123 logs in on a brand-new database;
//   - 目录 collapses to the left edge tab and opens again;
//   - 笔记 has its own collapse button;
//   - 设置 shows 崩溃日志 and 退出登录;
//   - a simulated unclean exit (dirty heartbeat in sessionStorage) is reported
//     on the next load and appears in 崩溃日志 with the book/page/canvas data;
//   - logs can be cleared, and logging out returns to the login screen.
//
// Playwright lives in the Alleyu workspace; point PLAYWRIGHT_DIR elsewhere if
// needed. The real repository is never modified: the installation is a copy.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.smoke-features');
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

// One-page PDF with a correct xref table, so pdf.js opens it without rebuilding.
function makePdf() {
  const content = Buffer.from('BT /F1 18 Tf 40 340 Td (Test Page) Tj ET\n', 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}endstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += String(off).padStart(10, '0') + ' 00000 n \n';
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function makeInstall() {
  const dir = path.join(WORK, 'app');
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.version = '1.2.0-feat';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.cpSync(path.join(ROOT, 'web', 'dist'), path.join(dir, 'web', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const bookdir = path.join(dir, 'book', '数学', '人教版');
  fs.mkdirSync(bookdir, { recursive: true });
  fs.writeFileSync(path.join(bookdir, '一年级上册.pdf'), makePdf());
  return dir;
}

async function main() {
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
      TEXTBOOK_ADMIN_PASS: '',      // empty: the default admin123 rule applies
      TEXTBOOK_ROOT: path.join(dir, 'book'),
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
    check('server is up', !!health && health.version === '1.2.0-feat', JSON.stringify(health));
    const bootLog = fs.readFileSync(log, 'utf8');
    check('server log mentions the default password once', bootLog.includes('默认密码 admin123'));
    check('no initial-admin.txt is written', !fs.existsSync(path.join(dir, 'data', 'initial-admin.txt')));

    // ---- HTTP: auth + crash log ----
    const anon = await fetch(`http://127.0.0.1:${port}/api/textbook/crashlog`);
    check('crash log requires a login', anon.status === 401, String(anon.status));

    let r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    check('a fresh database logs in with admin/admin123', r.ok, String(r.status));
    const apiToken = (await r.json()).token;

    r = await fetch(`http://127.0.0.1:${port}/api/textbook/crashlog?token=${apiToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'js_error', summary: 'api probe', detail: { probe: true } }),
    });
    check('a report is accepted', r.ok, String(r.status));
    r = await fetch(`http://127.0.0.1:${port}/api/textbook/crashlog?token=${apiToken}`);
    let list = (await r.json()).items || [];
    check('the report is listed', list.length === 1 && list[0].kind === 'js_error', JSON.stringify(list[0] || {}));
    r = await fetch(`http://127.0.0.1:${port}/api/textbook/crashlog?token=${apiToken}`, { method: 'DELETE' });
    const cleared = (await r.json()).deleted;
    check('a user can clear their own reports', r.ok && cleared === 1, String(cleared));

    // ---- build output ----
    const distHtml = fs.readFileSync(path.join(ROOT, 'web', 'dist', 'index.html'), 'utf8');
    check('index.html ships the Promise.withResolvers polyfill',
      distHtml.includes('Promise.withResolvers'));
    const assetsDir = path.join(ROOT, 'web', 'dist', 'assets');
    const workerName = fs.readdirSync(assetsDir).find((f) => /^pdf\.worker.*\.mjs$/.test(f));
    check('the worker asset exists', !!workerName);
    const workerSrc = workerName ? fs.readFileSync(path.join(assetsDir, workerName), 'utf8') : '';
    check('the worker asset starts with the same polyfill',
      workerSrc.startsWith('/*tb-withresolvers*/'), workerSrc.slice(0, 40));

    // ---- browser ----
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    // Simulate Safari < 17.4 / older Android WebViews: no native
    // Promise.withResolvers. index.html must put it back before pdf.js runs.
    await context.addInitScript(() => { Promise.withResolvers = undefined; });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('dialog', (d) => d.accept().catch(() => {}));
    page.on('response', (res) => {
      if (loggedIn && (res.status() === 401 || res.status() === 403 || res.status() >= 500)) {
        badResponses.push(res.status() + ' ' + res.url());
      }
    });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.login-page').waitFor({ timeout: 15000 });
    const loginText = await page.locator('.login-page').innerText();
    check('login screen has no password/initial-admin hint',
      !loginText.includes('initial-admin') && !loginText.includes('首次部署'), loginText.slice(0, 120));

    await page.locator('input[autocomplete="username"]').fill('admin');
    await page.locator('input[type="password"]').fill('admin123');
    await page.locator('.login-submit').click();
    await page.locator('nav.tabs').waitFor({ timeout: 15000 });
    loggedIn = true;
    check('the login screen accepts admin/admin123', true);

    // ---- 目录 collapse ----
    await sleep(400);
    const dirWidth = () => page.locator('.dircol').evaluate((el) => el.getBoundingClientRect().width);
    const w0 = await dirWidth();
    check('目录 is open by default on a wide window', w0 > 200, String(w0));
    await page.locator('.dircol-head .desktop-only[title="收起目录"]').click();
    await sleep(450);
    const w1 = await dirWidth();
    check('目录 collapses to zero width', w1 < 2, String(w1));
    const edge = page.locator('button.edge-btn.left');
    check('a slim 目录 tab appears on the left edge', (await edge.count()) === 1 && await edge.isVisible());
    await edge.click();
    await sleep(450);
    const w2 = await dirWidth();
    check('the edge tab reopens 目录', w2 > 200, String(w2));

    // ---- 笔记 collapse, with a real book open ----
    await page.locator('.tree-row[title="数学"]').click();
    await page.locator('.tree-row[title="人教版"]').waitFor({ timeout: 10000 });
    await page.locator('.tree-row[title="人教版"]').click();
    await page.locator('.tree-row[title="一年级上册.pdf"]').waitFor({ timeout: 10000 });
    await page.locator('.tree-row[title="一年级上册.pdf"]').click();
    await page.locator('.study.notes-open').waitFor({ timeout: 15000 });
    const firstCanvas = page.locator('.pdf-page canvas.render').first();
    await firstCanvas.waitFor({ timeout: 15000 });
    let pdfWiped = 0;
    for (let i = 0; i < 60; i++) {
      pdfWiped = await firstCanvas.evaluate((el) => el.width * el.height);
      if (pdfWiped > 0) break;
      await sleep(250);
    }
    check('PDF renders with Promise.withResolvers removed', pdfWiped > 0, String(pdfWiped));
    await sleep(600);
    const noteWidth = () => page.locator('.notecol').evaluate((el) => el.getBoundingClientRect().width);
    const n0 = await noteWidth();
    check('笔记 opens beside the book', n0 > 200, String(n0));
    const noteBtn = page.locator('.notecol button[title="收起笔记"]');
    check('笔记 has a collapse button', (await noteBtn.count()) === 1 && await noteBtn.isVisible());
    await noteBtn.click();
    await sleep(450);
    const n1 = await noteWidth();
    check('笔记 collapses', n1 < 2, String(n1));
    const noteEdge = page.locator('button.edge-btn[title="展开笔记"]');
    check('a 笔记 tab appears on the right edge', (await noteEdge.count()) === 1 && await noteEdge.isVisible());
    await noteEdge.click();
    await sleep(450);
    const n2 = await noteWidth();
    check('the edge tab reopens 笔记', n2 > 200, String(n2));

    // ---- settings: crash log + logout ----
    await page.locator('nav.tabs button.tab', { hasText: '设置' }).click();
    const crashCard = page.locator('.card').filter({ has: page.locator('h3', { hasText: '崩溃日志' }) });
    await crashCard.waitFor({ timeout: 10000 });
    check('设置 shows the 崩溃日志 card', true);
    check('设置 shows the 账户 / 退出登录 card',
      (await page.getByText('退出登录', { exact: true }).count()) === 1);

    // ---- simulated unclean exit ----
    // Runs before the app on every load. The old document's pagehide marks its
    // own state clean, then this seed replaces it with a dirty one, so the app
    // must conclude that the *previous* session died without a clean stop.
    await page.addInitScript(() => {
      try {
        const now = Date.now();
        sessionStorage.setItem('tb_crash_state_v1', JSON.stringify({
          id: 'seeded-crash',
          started_at: now - 300000,
          last_beat: now - 45000,
          clean: false,
          loads: 3,
          last_action: 'pdf 37/120 页',
          view: { path: '数学/测试教材.pdf', pages: 120, page: 37, rendered: 10, canvas_mb: 196, platform: 'ipad' },
          crumbs: [{ t: now - 50000, k: 'page', d: '37' }],
        }));
      } catch { /* opaque origin */ }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('nav.tabs').waitFor({ timeout: 15000 });
    await page.locator('nav.tabs button.tab', { hasText: '设置' }).click();
    await crashCard.locator('.crash-item').first().waitFor({ timeout: 15000 });
    const crashText = await crashCard.locator('.crash-item').first().textContent();
    check('an unclean exit is reported as 异常退出', crashText.includes('异常退出'), crashText.slice(0, 160));
    check('the report says the previous page did not end normally',
      crashText.includes('上次页面没有正常结束'), crashText.slice(0, 160));
    check('the report keeps the book/page/canvas context',
      crashText.includes('测试教材.pdf') && crashText.includes('canvas_mb') && crashText.includes('196'),
      crashText.slice(0, 240));

    // ---- clear ----
    await crashCard.locator('button', { hasText: '清空日志' }).click();
    await crashCard.getByText('暂时没有记录。').waitFor({ timeout: 10000 });
    check('日志 can be cleared', true);

    // ---- logout ----
    loggedIn = false;
    await page.getByText('退出登录', { exact: true }).click();
    await page.locator('input[autocomplete="username"]').waitFor({ timeout: 15000 });
    const tokenLeft = await page.evaluate(() => localStorage.getItem('wb_token'));
    check('logout returns to the login screen', true);
    check('logout drops the local token', !tokenLeft, String(tokenLeft));

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    check('no auth failures or server errors while logged in', badResponses.length === 0,
      badResponses.slice(0, 3).join(' | '));

    if (process.env.KEEP) {
      await page.screenshot({ path: path.join(WORK, 'login-after-logout.png'), fullPage: true });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    killPid(server.pid);
    await sleep(300);
    if (!process.env.KEEP) rmrf(WORK);
    else console.log(`  kept ${WORK} (server log: ${path.join(WORK, 'app', 'server.log')})`);
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[check-features] fatal:', e);
  if (!process.env.KEEP) { try { rmrf(WORK); } catch { /* ignore */ } }
  process.exit(1);
});
