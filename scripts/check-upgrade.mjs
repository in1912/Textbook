#!/usr/bin/env node
// End-to-end self-check for the standalone upgrade feature.
//
//   node scripts/check-upgrade.mjs            # run, clean up
//   KEEP=1 node scripts/check-upgrade.mjs     # keep .smoke-upgrade for inspection
//
// It creates two throwaway installations under .smoke-upgrade/ (a copy of
// server/*.js, package.json and a tiny web/dist), starts the real server on a
// free port, and drives the same HTTP endpoints the settings page uses:
//
//   1) unauthenticated / non-admin access is refused
//   2) bad packages are refused before a single byte is written
//      (path traversal, data/ write, wrong app, sha256 mismatch)
//   3) a good package preflights, applies, backs up, and with
//      TEXTBOOK_NO_RESTART=1 reports "suppressed" instead of restarting
//   4) a second install restarts for real: the old process exits, the detached
//      child retries the port, and /api/health reports the new version
//
// The real repo is never modified: every installation is a copy.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildZip, extractZip } = require('../server/zip.js');
const { buildUpgradePackage } = require('./build-upgrade-package.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.smoke-upgrade');
const NODE = process.execPath;
const NODE_ARGS = ['--experimental-sqlite'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex');

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n── ${t}`); }

// ---- filesystem helpers ----------------------------------------------------
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}
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
function writeDist(dir, marker) {
  fs.mkdirSync(path.join(dir, 'web', 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'dist', 'index.html'),
    `<!doctype html><html><head><title>textbook</title></head>`
    + `<body><div id="app"></div><script type="module" src="./assets/app.js"></script></body></html>\n`);
  fs.writeFileSync(path.join(dir, 'web', 'dist', 'assets', 'app.js'), `console.log(${JSON.stringify(marker)});\n`);
}
function makeInstall(name, version, marker) {
  const dir = path.join(WORK, name);
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  copyDir(path.join(ROOT, 'server'), path.join(dir, 'server'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.version = version;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeDist(dir, marker);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'keep-me.txt'), 'user data must survive an upgrade\n');
  return dir;
}
function makePackage(newDir, out) {
  return buildUpgradePackage({ root: newDir, out });
}
function manifestFor(files, extra = {}) {
  return {
    app: 'textbook', kind: 'upgrade-pack', version: '9.9.9',
    built_at: new Date().toISOString(),
    files: files.map(({ name, data }) => ({ path: name, size: data.length, sha256: sha(data) })),
    ...extra,
  };
}
function packWith(entries) {
  const files = entries.filter((e) => e.name !== 'manifest.json');
  const manifest = manifestFor(files);
  return buildZip([{ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }, ...files]);
}

// ---- server helpers --------------------------------------------------------
async function startServer(dir, port, extraEnv = {}) {
  const log = path.join(dir, 'server.log');
  const fd = fs.openSync(log, 'a');
  const child = spawn(NODE, [...NODE_ARGS, path.join(dir, 'server', 'index.js')], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      TEXTBOOK_DATA_DIR: path.join(dir, 'data'),
      TEXTBOOK_WEB_DIST: path.join(dir, 'web', 'dist'),
      TEXTBOOK_ADMIN_USER: 'admin',
      TEXTBOOK_ADMIN_PASS: 'testpass123',
      NODE_PATH: path.join(ROOT, 'node_modules'),
      ...extraEnv,
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  child.on('exit', () => { /* expected during the restart test */ });
  const ok = await waitHealth(port, 15000);
  if (!ok) throw new Error(`server did not start on ${port}; see ${log}`);
  return child;
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
async function login(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'testpass123' }),
  });
  if (!r.ok) throw new Error('login failed: ' + r.status);
  return (await r.json()).token;
}
function api(port, token, p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  return fetch(`http://127.0.0.1:${port}/api/admin/upgrade${p}`, { ...opts, headers });
}
async function jsonOf(res) {
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : null;
}
function pidOnPort(port) {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[1].endsWith(':' + port)) return Number(cols[4]) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

// ---- main ------------------------------------------------------------------
async function main() {
  rmrf(WORK);
  fs.mkdirSync(WORK, { recursive: true });

  // ---------- part 1: no restart (suppressed) + security ----------
  section('installation A: preflight / apply / backup (TEXTBOOK_NO_RESTART=1)');
  const a = makeInstall('a', '1.0.0-test', 'old-a');
  const portA = await freePort();
  const serverA = await startServer(a, portA, { TEXTBOOK_NO_RESTART: '1' });
  let childAAlive = true;
  serverA.on('exit', () => { childAAlive = false; });

  try {
    const health = await waitHealth(portA, 5000);
    check('server starts and reports its running version', health && health.version === '1.0.0-test', JSON.stringify(health));
    check('data directory survives', fs.existsSync(path.join(a, 'data', 'keep-me.txt')));

    // --- unauthenticated / non-admin
    const anon = await api(portA, '', '/status');
    check('anonymous /status is 401', anon.status === 401, String(anon.status));

    const token = await login(portA);
    const status0 = await jsonOf(await api(portA, token, '/status'));
    check('status reports running + disk version', status0 && status0.version === '1.0.0-test' && status0.disk_version === '1.0.0-test');

    // --- build the good package from a "new release" tree
    const newA = makeInstall('new-a', '1.1.0-test', 'new-a');
    const pkgA = makePackage(newA, path.join(WORK, 'pkg-a.zip'));
    check('package builder produced a zip', pkgA.buffer.length > 0);

    // --- bad packages are refused before touching disk
    const readIndex = () => fs.readFileSync(path.join(a, 'web', 'dist', 'index.html'), 'utf8');
    const before = readIndex();

    const traversal = buildZip([
      { name: 'manifest.json', data: JSON.stringify({ app: 'textbook', kind: 'upgrade-pack', version: '1.1.0-test', files: [] }) },
      { name: '../evil.js', data: 'x' },
    ]);
    let r = await api(portA, token, '/preflight', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: traversal });
    let j = await jsonOf(r);
    check('path traversal is rejected', r.status === 400 && j && j.error === 'PATH_TRAVERSAL', `${r.status} ${j && j.error}`);

    const forbidden = buildZip([
      { name: 'manifest.json', data: JSON.stringify({ app: 'textbook', kind: 'upgrade-pack', version: '1.1.0-test', files: [] }) },
      { name: 'data/textbook.sqlite', data: 'x' },
    ]);
    r = await api(portA, token, '/preflight', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: forbidden });
    j = await jsonOf(r);
    check('writing data/ is rejected', r.status === 400 && j && j.error === 'FORBIDDEN_PATH', `${r.status} ${j && j.error}`);

    const wrongApp = buildZip([
      { name: 'manifest.json', data: JSON.stringify({ app: 'other', kind: 'upgrade-pack', version: '1.1.0-test', files: [] }) },
      { name: 'package.json', data: '{"name":"x","version":"1.1.0-test"}' },
    ]);
    r = await api(portA, token, '/preflight', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: wrongApp });
    j = await jsonOf(r);
    check('a package for another app is rejected', r.status === 400 && j && j.error === 'BAD_MANIFEST', `${r.status} ${j && j.error}`);

    const okEntries = extractZip(pkgA.buffer);
    const tampered = okEntries.map((e) => ({ ...e }));
    const victim = tampered.find((e) => e.name === 'server/index.js');
    victim.data = Buffer.concat([victim.data, Buffer.from('\n// tampered\n')]);
    r = await api(portA, token, '/preflight', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: buildZip(tampered) });
    j = await jsonOf(r);
    check('sha256 mismatch is rejected', r.status === 400 && j && j.error === 'BAD_MANIFEST', `${r.status} ${j && j.error}`);

    check('rejected packages wrote nothing', readIndex() === before);

    // --- good preflight
    r = await api(portA, token, '/preflight', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: pkgA.buffer });
    j = await jsonOf(r);
    check('good package passes preflight', r.status === 200 && j && j.plan, `${r.status} ${j && j.error}`);
    const plan = j.plan;
    check('plan knows the incoming version', plan.version.incoming === '1.1.0-test', plan.version.incoming);
    check('plan requires a restart (server changed)', plan.restart_required === true);
    // unchanged files (most of server/) must be skipped, the changed ones written
    check('plan separates overwrite from unchanged files', plan.summary.overwrite >= 1 && plan.summary.skip >= 1,
      `add=${plan.summary.add} overwrite=${plan.summary.overwrite} skip=${plan.summary.skip}`);

    // --- apply
    r = await api(portA, token, '/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: j.token }),
    });
    j = await jsonOf(r);
    check('apply returns ok', r.status === 200 && j && j.applied === true, `${r.status} ${j && (j.error + ' ' + j.message)}`);
    check('restart is suppressed by TEXTBOOK_NO_RESTART=1', j.restart === 'suppressed', j.restart);
    check('package.json on disk is the new version', JSON.parse(fs.readFileSync(path.join(a, 'package.json'), 'utf8')).version === '1.1.0-test');
    check('new dist was written', readIndex().includes('app.js') && fs.readFileSync(path.join(a, 'web', 'dist', 'assets', 'app.js'), 'utf8').includes('new-a'));
    check('overwritten files were backed up',
      !!j.backup_dir && fs.existsSync(path.join(j.backup_dir, 'web', 'dist', 'assets', 'app.js')));
    check('user data was not touched', fs.existsSync(path.join(a, 'data', 'keep-me.txt')));

    const status1 = await jsonOf(await api(portA, token, '/status'));
    check('running version stays old until restart', status1.version === '1.0.0-test' && status1.disk_version === '1.1.0-test',
      `${status1.version}/${status1.disk_version}`);
    check('history has the successful run', status1.history.length >= 1 && status1.history[0].ok === true);

    // --- backup download is a readable zip
    const bname = path.basename(j.backup_dir);
    r = await api(portA, token, `/backups/${bname}/download`);
    const zbuf = Buffer.from(await r.arrayBuffer());
    check('backup downloads as a zip', r.status === 200 && r.headers.get('content-type') === 'application/zip' && zbuf.length > 0);
    const back = extractZip(zbuf);
    check('backup contains the previous asset bytes',
      back.some((e) => e.name === 'web/dist/assets/app.js' && e.data.toString('utf8').includes('old-a')));
  } finally {
    killPid(serverA.pid);
    await sleep(200);
  }

  // ---------- part 2: a real restart handoff ----------
  section('installation B: apply triggers a real restart');
  const b = makeInstall('b', '1.0.0-test', 'old-b');
  const portB = await freePort();
  const serverB = await startServer(b, portB, {}); // no NO_RESTART: handoff is real
  let bExited = false;
  serverB.on('exit', () => { bExited = true; });
  let restartedPid = 0;
  try {
    const token = await login(portB);
    const newB = makeInstall('new-b', '1.1.0-test', 'new-b');
    const pkgB = makePackage(newB, path.join(WORK, 'pkg-b.zip'));

    let r = await api(portB, token, '/preflight', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: pkgB.buffer });
    let j = await jsonOf(r);
    check('preflight ok', r.status === 200 && j && j.token, `${r.status} ${j && j.error}`);

    r = await api(portB, token, '/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: j.token }),
    });
    j = await jsonOf(r);
    check('apply schedules a restart', r.status === 200 && j.restart === 'scheduled', `${r.status} ${j && j.restart}`);

    // Wait for the old process to exit and the new one to answer with the new version.
    const started = Date.now();
    let health = null;
    while (Date.now() - started < 20000) {
      try {
        const hr = await fetch(`http://127.0.0.1:${portB}/api/health`);
        const d = await hr.json();
        if (d && d.version === '1.1.0-test') { health = d; break; }
      } catch { /* port still closed */ }
      await sleep(250);
    }
    const elapsed = Date.now() - started;
    await sleep(400); // let the old child's 'exit' event land
    check('new version answers /api/health after the handoff', !!health && health.version === '1.1.0-test',
      health ? health.version : `no answer in 20s`);
    check('handoff took under 15s', !!health && elapsed < 15000, `${elapsed}ms`);
    check('old process exited', bExited);
    check('data survived the restart', fs.existsSync(path.join(b, 'data', 'keep-me.txt')));
    check('restart_pending is cleared', JSON.parse(fs.readFileSync(path.join(b, 'data', 'upgrades', 'state.json'), 'utf8')).restart_pending === false);

    restartedPid = pidOnPort(portB);
    check('the restarted process is a new pid', !restartedPid || restartedPid !== serverB.pid, `${serverB.pid} -> ${restartedPid}`);
  } finally {
    killPid(serverB.pid);
    killPid(restartedPid || pidOnPort(portB));
    await sleep(300);
  }

  // ---------- summary ----------
  section('summary');
  console.log(`  ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
  }
  if (!process.env.KEEP) rmrf(WORK);
  else console.log(`  kept ${WORK}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[check-upgrade] fatal:', e);
  if (!process.env.KEEP) { try { rmrf(WORK); } catch { /* ignore */ } }
  process.exit(1);
});
