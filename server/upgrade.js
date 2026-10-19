// Standalone-only system upgrade: the settings page uploads a ZIP produced by
// scripts/build-upgrade-package.mjs, the server validates it, then writes it
// into the installation directory and (when server code changed) restarts.
//
// Security model: a package may only touch these trees
//
//   manifest.json          validation only, never written
//   package.json           version + dependency list
//   server/**.js           backend code
//   web/dist/**            built frontend
//
// Everything is validated before a single byte is written:
//   - path traversal / absolute paths / Windows-hostile names are rejected
//   - manifest.json lists every file with size + sha256 and must match exactly
//   - server JS is compiled with vm.Script (compiled, never executed)
//   - an incomplete dist (no index.html, or assets it references are missing)
//     is rejected, because that produces a white screen
//
// Writes are two-phase: everything goes to `<dest>.upgrade-tmp-<pid>` first,
// then each file is renamed into place. Overwritten files are copied into
// data/upgrades/backup_<timestamp>/ beforehand so a bad upgrade is reversible.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const auth = require('./auth');
const { extractZip, buildZip } = require('./zip');

const RUNNING_VERSION = (() => {
  try { return require('../package.json').version || ''; } catch { return ''; }
})();
const TOKEN_TTL_MS = 10 * 60 * 1000;

class UpgradeError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function localNow() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().replace('T', ' ').slice(0, 19);
}
function mb(n) { return (n / 1048576).toFixed(2); }

// ---- path safety -----------------------------------------------------------
function validateEntryName(name) {
  if (name.length > 300) return { code: 'PATH_TRAVERSAL', msg: `包内条目路径过长（>300）：${name.slice(0, 60)}…` };
  if (name.includes('\\')) return { code: 'PATH_TRAVERSAL', msg: `包内条目用反斜杠分隔（应为 /）：${name}` };
  if (/^[A-Za-z]:/.test(name)) return { code: 'PATH_TRAVERSAL', msg: `包内条目是盘符绝对路径：${name}` };
  if (name.startsWith('/')) return { code: 'PATH_TRAVERSAL', msg: `包内条目是绝对路径：${name}` };
  const segs = name.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    return { code: 'PATH_TRAVERSAL', msg: `包内条目含空段或 . / ..（试图跳出安装目录）：${name}` };
  }
  if (/[\x00-\x1f\x7f]/.test(name)) return { code: 'PATH_TRAVERSAL', msg: `包内条目含控制字符：${JSON.stringify(name)}` };
  if (/[:|?*"<>]/.test(name)) return { code: 'PATH_TRAVERSAL', msg: `包内条目含 Windows 非法字符 :|?*"<>：${name}` };
  if (/^(data|book|node_modules)(\/|$)/i.test(name)) {
    return { code: 'FORBIDDEN_PATH', msg: `升级包不允许写 ${name.split('/')[0]}/（数据、教材、依赖不在升级范围内）` };
  }
  return null;
}

// Only these trees are writable. Anything else rejects the whole package.
function classify(name) {
  if (name === 'manifest.json') return { action: 'skip', kind: 'manifest' };
  if (name === 'package.json') return { action: 'write', kind: 'pkg' };
  if (/^server\/.*\.js$/.test(name)) return { action: 'write', kind: 'server' };
  if (/^web\/dist\/(.*)$/.test(name)) {
    return { action: 'write', kind: name === 'web/dist/index.html' ? 'index' : 'dist' };
  }
  return {
    action: 'reject', code: 'NOT_ALLOWED',
    msg: `包内条目不在升级白名单里（只允许 manifest.json、package.json、server/**.js、web/dist/**）：${name}`,
  };
}

function createUpgradeService({ root, webDist, restart, maxUploadMb }) {
  const R = (rel) => path.join(root, rel);
  const WEB_DIST = webDist || R(path.join('web', 'dist'));
  const dataDir = process.env.TEXTBOOK_DATA_DIR
    ? path.resolve(process.env.TEXTBOOK_DATA_DIR)
    : R('data');
  const upgradeDir = path.join(dataDir, 'upgrades');
  const historyFile = path.join(upgradeDir, 'history.jsonl');
  const MAX_UPLOAD_MB = maxUploadMb || Number(process.env.TEXTBOOK_UPGRADE_MAX_MB) || 64;
  const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1048576;

  let busy = false;
  let pendingPlan = null; // { token, buf, plan, at } — one at a time, never two

  const diskVersion = () => {
    try { return JSON.parse(fs.readFileSync(R('package.json'), 'utf8')).version || ''; } catch { return ''; }
  };
  const pkgVersionOf = (buf) => {
    try { return JSON.parse(buf.toString('utf8')).version || ''; } catch { return ''; }
  };
  function ensureUpgradeDir() {
    fs.mkdirSync(upgradeDir, { recursive: true });
  }

  // ---- status / history / backups -----------------------------------------
  function backupDirs() {
    try {
      return fs.readdirSync(upgradeDir)
        .filter((n) => /^backup_\d{14}$/.test(n) && fs.statSync(path.join(upgradeDir, n)).isDirectory())
        .sort().reverse();
    } catch { return []; }
  }
  function backupInfo(name) {
    const dir = path.join(upgradeDir, name);
    let files = 0, bytes = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { files += 1; bytes += fs.statSync(p).size; }
      }
    };
    try { walk(dir); } catch { /* partial */ }
    return { name, files, bytes };
  }
  function readHistory(limit = 20) {
    try {
      const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-limit).reverse().map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }
  function logRun(row) {
    ensureUpgradeDir();
    fs.appendFileSync(historyFile, JSON.stringify(row) + '\n');
    return row.at;
  }

  function status() {
    let distOk = false;
    try { distOk = fs.statSync(path.join(WEB_DIST, 'index.html')).isFile(); } catch { /* missing */ }
    const backups = backupDirs();
    return {
      app: 'textbook',
      version: RUNNING_VERSION,            // the code this process is running
      disk_version: diskVersion(),         // package.json on disk (differs until restart)
      data_dir: dataDir,
      dist_dir: WEB_DIST,
      dist_ok: distOk,
      max_upload_mb: MAX_UPLOAD_MB,
      pending_plan: !!pendingPlan && Date.now() - pendingPlan.at < TOKEN_TTL_MS,
      restart_pending: !!(restart.readPending() || {}).restart_pending,
      restart_suppressed: restart.isSuppressed(),
      backup_count: backups.length,
      backups: backups.slice(0, 5).map(backupInfo),
      history: readHistory(10),
    };
  }

  // ---- preflight ----------------------------------------------------------
  function parseManifest(buf) {
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch (e) {
      throw new UpgradeError(400, 'BAD_MANIFEST', 'manifest.json 不是合法 JSON：' + e.message);
    }
    if (!m || typeof m !== 'object') throw new UpgradeError(400, 'BAD_MANIFEST', 'manifest.json 不是对象');
    if (m.app !== 'textbook') {
      throw new UpgradeError(400, 'BAD_MANIFEST', `manifest.json 的 app 应为 textbook，实际是 ${JSON.stringify(m.app)}——这不是教材系统的升级包`);
    }
    if (m.kind !== 'upgrade-pack') {
      throw new UpgradeError(400, 'BAD_MANIFEST', `manifest.json 的 kind 应为 upgrade-pack，实际是 ${JSON.stringify(m.kind)}`);
    }
    if (!m.version) throw new UpgradeError(400, 'BAD_MANIFEST', 'manifest.json 缺 version');
    if (!Array.isArray(m.files)) throw new UpgradeError(400, 'BAD_MANIFEST', 'manifest.json 缺 files 清单（逐文件大小与 sha256）');
    return m;
  }

  function preflight(buf) {
    if (busy) throw new UpgradeError(409, 'BUSY', '已有一个预检/应用正在处理，请稍候');
    if (!Buffer.isBuffer(buf) || !buf.length) throw new UpgradeError(400, 'EMPTY_PACK', '没有收到升级包内容');
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw new UpgradeError(413, 'TOO_LARGE', `升级包 ${mb(buf.length)}MB 超过上限 ${MAX_UPLOAD_MB}MB`);
    }
    busy = true;
    try { return doPreflight(buf); } finally { busy = false; }
  }

  function doPreflight(buf) {
    let entries;
    try { entries = extractZip(buf); } catch (e) {
      throw new UpgradeError(400, 'BAD_ZIP', e.message);
    }
    if (!entries.length) throw new UpgradeError(400, 'EMPTY_PACK', '升级包里没有任何文件');

    // 1) path validation + classification (collect all bad ones first)
    const bad = [];
    const items = [];
    let pkgJson = null;
    let manifestEntry = null;
    for (const e of entries) {
      const v = validateEntryName(e.name);
      if (v) { bad.push({ path: e.name, code: v.code, msg: v.msg }); continue; }
      const c = classify(e.name);
      if (c.action === 'reject') { bad.push({ path: e.name, code: c.code, msg: c.msg }); continue; }
      if (c.kind === 'manifest') {
        if (manifestEntry) { bad.push({ path: e.name, code: 'BAD_MANIFEST', msg: '包里有多个 manifest.json' }); continue; }
        manifestEntry = e;
        continue;
      }
      if (c.kind === 'pkg') pkgJson = e.data;
      items.push({ ...c, name: e.name, data: e.data, size: e.data.length });
    }
    if (bad.length) {
      const head = bad.slice(0, 3).map((b) => b.msg).join('；');
      throw new UpgradeError(400, bad[0].code,
        `升级包里有 ${bad.length} 个非法条目：${head}${bad.length > 3 ? ` …等 ${bad.length} 条` : ''}`, { rejected: bad });
    }
    if (!manifestEntry) throw new UpgradeError(400, 'BAD_MANIFEST', '包里没有 manifest.json——无法确认这是教材系统的升级包');
    if (!pkgJson) throw new UpgradeError(400, 'BAD_MANIFEST', '包里没有 package.json');

    // 2) manifest <-> actual entries must match one to one
    const manifest = parseManifest(manifestEntry.data);
    const packedVersion = pkgVersionOf(pkgJson);
    if (!packedVersion) throw new UpgradeError(400, 'BAD_MANIFEST', '包内 package.json 没有可解析的 version');
    if (manifest.version !== packedVersion) {
      throw new UpgradeError(400, 'BAD_MANIFEST', `manifest 的 version ${manifest.version} 与包内 package.json 的 ${packedVersion} 不一致`);
    }
    const maniMap = new Map();
    for (const f of manifest.files) {
      if (!f || typeof f.path !== 'string') throw new UpgradeError(400, 'BAD_MANIFEST', 'manifest.files 有条目缺 path');
      if (maniMap.has(f.path)) throw new UpgradeError(400, 'BAD_MANIFEST', `manifest.files 里 ${f.path} 重复`);
      maniMap.set(f.path, f);
    }
    const realMap = new Map(entries.filter((e) => e.name !== 'manifest.json').map((e) => [e.name, e]));
    for (const [p, f] of maniMap) {
      const real = realMap.get(p);
      if (!real) throw new UpgradeError(400, 'BAD_MANIFEST', `manifest 里列了 ${p}，包里却没有这个文件（包被改过或打包中断）`);
      const h = sha256(real.data);
      if (f.sha256 && f.sha256 !== h) {
        throw new UpgradeError(400, 'BAD_MANIFEST', `${p} 的内容与清单里的 sha256 不符（文件被改过或传输损坏）`);
      }
      if (f.size !== undefined && Number(f.size) !== real.data.length) {
        throw new UpgradeError(400, 'BAD_MANIFEST', `${p} 的大小与清单不符（清单 ${f.size} ≠ 实际 ${real.data.length}）`);
      }
    }
    for (const p of realMap.keys()) {
      if (!maniMap.has(p)) throw new UpgradeError(400, 'BAD_MANIFEST', `包里有 ${p}，但 manifest 清单里没列`);
    }

    // 3) frontend completeness
    const distItems = items.filter((i) => i.kind === 'dist' || i.kind === 'index');
    const indexItem = items.find((i) => i.name === 'web/dist/index.html');
    if (distItems.length && !indexItem) {
      throw new UpgradeError(400, 'INCOMPLETE_DIST', '包里带了前端文件却没有 web/dist/index.html——装上会白屏');
    }
    if (indexItem) {
      const html = indexItem.data.toString('utf8');
      const refs = new Set();
      const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(html))) {
        const url = m[1];
        if (!/^\.?\/assets\//.test(url)) continue;
        refs.add('web/dist/' + url.replace(/^\.?\//, ''));
      }
      const inPack = new Set(items.map((i) => i.name));
      const missing = [...refs].filter((p) => !inPack.has(p) && !fs.existsSync(R(p)));
      if (missing.length) {
        throw new UpgradeError(400, 'INCOMPLETE_DIST',
          `index.html 引用了 ${missing.length} 个包里和磁盘上都没有的静态文件：${missing.slice(0, 3).join('、')}`);
      }
    }

    // 4) server JS syntax check (compiled, never executed)
    const warnings = [];
    const serverItems = items.filter((i) => i.kind === 'server');
    for (const it of serverItems) {
      try { new vm.Script(it.data.toString('utf8'), { filename: it.name }); }
      catch (e) {
        throw new UpgradeError(400, 'SYNTAX', `包内 ${it.name} 有语法错误，整个升级包被拒绝（磁盘未做任何改动）：${e.message}`);
      }
    }

    // 5) require closure: a target missing from both pack and disk only warns
    const inPack = new Set(items.map((i) => i.name));
    const missingReq = new Set();
    for (const it of serverItems) {
      const code = it.data.toString('utf8');
      const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
      let m;
      while ((m = re.exec(code))) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(it.name), spec));
        const cands = [target, target + '.js', target + '/index.js'];
        if (!cands.some((c) => inPack.has(c) || fs.existsSync(R(c)))) missingReq.add(`${it.name} → ${spec}`);
      }
    }
    if (missingReq.size) {
      warnings.push(`有 ${missingReq.size} 个 require 目标在包里和磁盘上都找不到（服务端可能起不来）：${[...missingReq].slice(0, 5).join('、')}`);
    }

    // 6) dependency changes need an explicit confirmation at apply time
    let depChanged = false;
    try {
      const deps = JSON.parse(pkgJson.toString('utf8')).dependencies || {};
      const diskDeps = JSON.parse(fs.readFileSync(R('package.json'), 'utf8')).dependencies || {};
      const diff = [...new Set([...Object.keys(deps), ...Object.keys(diskDeps)])].filter((k) => deps[k] !== diskDeps[k]);
      if (diff.length) {
        depChanged = true;
        warnings.push(`依赖清单有变化（${diff.join('、')}）：升级后需要到服务器上执行 npm install --omit=dev，否则服务端可能起不来`);
      }
    } catch { warnings.push('读不到磁盘上的 package.json，无法比对依赖'); }

    // 7) plan file actions
    let add = 0, overwrite = 0, skip = 0, bytesUncomp = 0;
    const files = [];
    for (const it of items) {
      const dest = R(it.name);
      let exists = false, same = false;
      try {
        const st = fs.statSync(dest);
        exists = st.isFile();
        if (exists) same = sha256(fs.readFileSync(dest)) === sha256(it.data);
      } catch { /* new file */ }
      const action = same ? 'skip' : (exists ? 'overwrite' : 'add');
      if (action === 'add') add++;
      else if (action === 'overwrite') overwrite++;
      else skip++;
      bytesUncomp += it.size;
      files.push({ path: it.name, kind: it.kind, size: it.size, action });
    }
    const restartRequired = items.some((i) => (i.kind === 'server' || i.kind === 'pkg')
      && files.find((f) => f.path === i.name).action !== 'skip');

    const current = RUNNING_VERSION;
    if (current && packedVersion && packedVersion === current) {
      warnings.push(`包内版本与当前运行版本相同（${current}）：如果内容确实更新了，请先修改 package.json 的 version 再打包`);
    }
    if (current && packedVersion && packedVersion < current) {
      warnings.push(`这是降级（现役 ${current} → 包内 ${packedVersion}）——只有在明确回滚时才继续`);
    }
    if (!distItems.length) warnings.push('这个包没有前端文件：只更新服务端');

    const plan = {
      manifest: {
        version: packedVersion,
        from_version: manifest.from_version || '',
        built_at: manifest.built_at || '',
        files: manifest.files.length,
      },
      version: { current, disk: diskVersion(), incoming: packedVersion },
      summary: {
        files_total: items.length,
        add, overwrite, skip,
        bytes_zip: buf.length,
        bytes_uncompiled: bytesUncomp,
        dist_files: distItems.length,
        dep_changed: depChanged,
      },
      files,
      warnings,
      restart_required: restartRequired,
    };
    const token = crypto.randomBytes(16).toString('hex');
    pendingPlan = { token, buf, plan, at: Date.now() };
    return { token, plan };
  }

  // ---- apply --------------------------------------------------------------
  const keepBackups = () => Math.max(1, Number(process.env.TEXTBOOK_UPGRADE_KEEP_BACKUPS) || 5);
  function nextBackupDir() {
    ensureUpgradeDir();
    const base = `backup_${stamp()}`;
    let name = base, n = 1;
    // two upgrades in the same second must not share a directory
    while (fs.existsSync(path.join(upgradeDir, name))) {
      name = `${base}_${n++}`;
    }
    return path.join(upgradeDir, name);
  }
  function pruneBackups(keep) {
    const dirs = backupDirs();
    for (const d of dirs.slice(keep)) {
      try { fs.rmSync(path.join(upgradeDir, d), { recursive: true, force: true }); } catch { /* keep on failure */ }
    }
  }

  function apply({ token, allowDepChange = false, actor = '', ip = '' }) {
    if (busy) throw new UpgradeError(409, 'BUSY', '已有一个预检/应用正在处理，请稍候');
    if (!pendingPlan || !token || token !== pendingPlan.token) {
      throw new UpgradeError(400, 'BAD_TOKEN', '预检凭证无效或已过期，请重新选择升级包并预检');
    }
    if (Date.now() - pendingPlan.at > TOKEN_TTL_MS) {
      pendingPlan = null;
      throw new UpgradeError(400, 'BAD_TOKEN', '预检已超过 10 分钟，请重新选择升级包并预检');
    }
    const { buf, plan } = pendingPlan;
    if (plan.summary.dep_changed && !allowDepChange) {
      throw new UpgradeError(409, 'DEP_CHANGED',
        '这个包改变了 npm 依赖，直接升级会让服务端起不来：请先到服务器上执行 npm install --omit=dev，确认后再点「仍要继续」。',
        { dep_changed: true });
    }
    pendingPlan = null; // one-shot
    busy = true;
    try { return doApply({ buf, plan, actor, ip }); } finally { busy = false; }
  }

  function doApply({ buf, plan, actor, ip }) {
    const entries = extractZip(buf);
    const order = { server: 1, pkg: 2, dist: 3, index: 4 };
    const writes = [];
    for (const e of entries) {
      const c = classify(e.name);
      if (c.action !== 'write') continue;
      writes.push({ name: e.name, kind: c.kind, data: e.data, ord: order[c.kind] || 9 });
    }
    writes.sort((a, b) => (a.ord - b.ord) || a.name.localeCompare(b.name));

    // skip files whose bytes already match: the plan said "skip", so apply must
    // not claim it wrote them
    const same = [];
    const todo = [];
    for (const w of writes) {
      const dest = R(w.name);
      let eq = false;
      try { eq = fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === sha256(w.data); } catch { eq = false; }
      if (eq) same.push(w.name);
      else todo.push(w);
    }
    const overwritten = todo.filter((w) => fs.existsSync(R(w.name)));
    const added = todo.filter((w) => !fs.existsSync(R(w.name)));

    // phase A: write temp files (disk unchanged if this fails)
    const tmps = [];
    try {
      for (const w of todo) {
        const dest = R(w.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.upgrade-tmp-${process.pid}`;
        fs.writeFileSync(tmp, w.data);
        tmps.push({ tmp, dest, name: w.name });
      }
    } catch (e) {
      for (const t of tmps) { try { fs.unlinkSync(t.tmp); } catch { /* best effort */ } }
      const msg = `写入临时文件失败（磁盘未做任何改动）：${e.message}`;
      logRun({
        at: localNow(), actor, ip, from: plan.version.current, to: plan.manifest.version,
        add: 0, overwrite: 0, skip: same.length, bytes: buf.length, backup_dir: '',
        restart: 'not_started', ok: false, note: msg,
      });
      throw new UpgradeError(500, 'WRITE_FAILED', msg);
    }

    // backup every file that will be overwritten
    let backupDir = '';
    if (overwritten.length) {
      backupDir = nextBackupDir();
      for (const w of overwritten) {
        const dst = path.join(backupDir, w.name);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(R(w.name), dst);
      }
      fs.writeFileSync(path.join(backupDir, 'RESTORE.txt'),
        `升级前备份（${new Date().toISOString()}）\n`
        + `从 ${plan.version.current} 升到 ${plan.manifest.version}\n\n`
        + `回滚：把本目录里的文件按相同相对路径拷回安装目录，然后重启服务。\n`
        + `本目录只包含「被覆盖」的 ${overwritten.length} 个文件；新增的文件不会被撤销（留着不影响运行）。\n`);
      pruneBackups(keepBackups());
    }

    // phase B: rename into place
    const written = [];
    const failed = [];
    for (const t of tmps) {
      if (failed.length) { try { fs.unlinkSync(t.tmp); } catch { /* cleanup */ } continue; }
      let ok = false, lastErr = null;
      for (let i = 0; i < 3 && !ok; i++) {
        try { fs.renameSync(t.tmp, t.dest); ok = true; }
        catch (e) {
          lastErr = e;
          if (i < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
      }
      if (ok) written.push(t.name);
      else failed.push({ path: t.name, error: lastErr ? lastErr.message : '未知错误' });
    }

    if (failed.length) {
      const note = `部分文件写不进去（可能被杀毒/索引程序锁住）：已生效 ${written.length} 个，未生效 ${failed.length} 个。`
        + `服务没有重启，旧代码还在跑。请把 ${backupDir || 'data/upgrades/backup_*'} 里的文件拷回安装目录后重启，再重试升级。`;
      logRun({
        at: localNow(), actor, ip, from: plan.version.current, to: plan.manifest.version,
        add: added.length, overwrite: overwritten.length, skip: same.length, bytes: buf.length,
        backup_dir: backupDir, restart: 'not_started', ok: false, note,
      });
      throw new UpgradeError(500, 'PARTIAL_WRITE', note, { files_written: written, files_failed: failed, backup_dir: backupDir });
    }

    const addNames = added.map((w) => w.name);
    const overNames = overwritten.map((w) => w.name);
    const restartMode = !plan.restart_required ? 'not_needed' : (restart.isSuppressed() ? 'suppressed' : 'scheduled');
    const note = `已写入 ${written.length} 个文件（覆盖 ${overNames.length}、新增 ${addNames.length}、内容相同跳过 ${same.length}）`;
    const logId = logRun({
      at: localNow(), actor, ip,
      from: plan.version.current, to: plan.manifest.version,
      add: addNames.length, overwrite: overNames.length, skip: same.length,
      bytes: buf.length, backup_dir: backupDir, restart: restartMode, ok: true, note,
    });

    const restartNote = {
      not_needed: '这个包只换了前端，静态文件下一次请求就生效，不用重启',
      suppressed: '文件已落盘，但 TEXTBOOK_NO_RESTART=1：进程没有重启，手动重启后新代码才生效（自检/调试模式）',
      scheduled: `已在响应之后拉起接替进程（${plan.manifest.version}），1~3 秒后新版本上线，页面会短暂打不开`,
    }[restartMode];

    return {
      applied: true,
      ok: true,
      version: { from: plan.version.current, to: plan.manifest.version, disk: diskVersion() },
      files_written: { add: addNames, overwrite: overNames, skipped: same, total: written.length },
      backup_dir: backupDir,
      restart_required: plan.restart_required,
      restart: restartMode,
      restart_note: restartNote,
      log_id: logId,
      // The router calls this on res 'finish': the response must reach the
      // browser before the old process exits.
      afterRespond: () => {
        if (restartMode !== 'scheduled') return null;
        return restart.scheduleRestart({
          fromVersion: plan.version.current,
          toVersion: plan.manifest.version,
          backupDir,
        });
      },
    };
  }

  // ---- backup download ----------------------------------------------------
  function backupZip(name) {
    if (!/^backup_\d{14}(_\d+)?$/.test(name)) throw new UpgradeError(400, 'BAD_NAME', '备份目录名不合法');
    const dir = path.join(upgradeDir, name);
    if (!fs.existsSync(dir)) throw new UpgradeError(404, 'NOT_FOUND', '备份不存在');
    const entries = [];
    const walk = (d, rel = '') => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(p, r);
        else entries.push({ name: r, data: fs.readFileSync(p) });
      }
    };
    walk(dir);
    return { name, buffer: buildZip(entries), count: entries.length };
  }

  return { status, preflight, apply, readHistory, backupDirs, backupInfo, backupZip, MAX_UPLOAD_MB };
}

// ---- HTTP router -----------------------------------------------------------
function createUpgradeRouter(opts) {
  const svc = createUpgradeService(opts);
  const router = express.Router();
  router.use(auth.requireUser, auth.requireAdmin);

  const sendError = (res, e) => {
    const status = e instanceof UpgradeError ? e.status : 500;
    res.status(status).json({
      error: (e && e.code) || 'internal',
      message: e ? String(e.message || e) : '服务器内部错误',
      ...(e && e.extra ? e.extra : {}),
    });
  };

  router.get('/status', (req, res) => {
    try { res.json(svc.status()); } catch (e) { sendError(res, e); }
  });

  // The browser POSTs the raw ZIP body (no multipart): one dependency less and
  // the browser still shows upload progress on large packages.
  router.post('/preflight',
    express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: svc.MAX_UPLOAD_MB + 'mb' }),
    (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
          throw new UpgradeError(400, 'EMPTY_PACK', '没有收到升级包内容（请选择 .zip 文件）');
        }
        res.json(svc.preflight(req.body));
      } catch (e) { sendError(res, e); }
    });

  router.post('/apply', (req, res) => {
    try {
      const b = req.body || {};
      const out = svc.apply({
        token: String(b.token || ''),
        allowDepChange: !!b.allow_dep_change,
        actor: (req.user && req.user.username) || '',
        ip: req.ip || '',
      });
      const after = out.afterRespond;
      delete out.afterRespond;
      if (typeof after === 'function') res.on('finish', () => { try { after(); } catch { /* logged in restart */ } });
      res.json(out);
    } catch (e) { sendError(res, e); }
  });

  router.get('/history', (req, res) => {
    try { res.json({ items: svc.readHistory(50) }); } catch (e) { sendError(res, e); }
  });

  router.get('/backups', (req, res) => {
    try {
      res.json({ items: svc.backupDirs().map((n) => svc.backupInfo(n)) });
    } catch (e) { sendError(res, e); }
  });

  router.get('/backups/:name/download', (req, res) => {
    try {
      const z = svc.backupZip(req.params.name);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${z.name}.zip"`);
      res.send(z.buffer);
    } catch (e) { sendError(res, e); }
  });

  return router;
}

module.exports = { createUpgradeRouter, createUpgradeService, UpgradeError };
