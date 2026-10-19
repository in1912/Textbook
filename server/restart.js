// Self-handoff after an upgrade.
//
// Windows has no SO_REUSEPORT, so two processes cannot bind the same port at
// the same time. The only reliable model for a plain `node server/index.js`
// install is: spawn a detached copy of ourselves, wait for the HTTP response to
// flush, exit, and let the child retry the port until the old socket is gone
// (see boot() in index.js).
//
// All three stdio handles must be redirected to a file — otherwise closing the
// parent's console takes the child with it.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHILD_FLAG = 'TEXTBOOK_RESTART_CHILD';
const EXIT_DELAY_MS = 900;
const NO_RESTART = process.env.TEXTBOOK_NO_RESTART === '1';

let scheduled = false;

function dataDir() {
  return process.env.TEXTBOOK_DATA_DIR
    ? path.resolve(process.env.TEXTBOOK_DATA_DIR)
    : path.join(ROOT, 'data');
}
function statePath() {
  const dir = path.join(dataDir(), 'upgrades');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'state.json');
}
const LOG_FILE = () => path.join(ROOT, 'Logs', 'restart-child.log');

function isSuppressed() { return NO_RESTART; }
function isChild() { return process.env[CHILD_FLAG] === '1'; }

// restart_pending is written before a handoff and cleared once the new process
// is listening. A leftover `true` means the handoff failed — the next boot says
// so out loud instead of leaving the administrator guessing.
function readPending() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return null; }
}
function writeState(patch) {
  try {
    const cur = readPending() || {};
    fs.writeFileSync(statePath(), JSON.stringify({ ...cur, ...patch }, null, 2));
  } catch (e) {
    console.warn('[restart] 写 state.json 失败（不影响升级）:', e.message);
  }
}
function clearPending(extra = {}) {
  if (!fs.existsSync(statePath())) return;
  writeState({ restart_pending: false, handoff_at: new Date().toISOString(), ...extra });
}
function writeFatal(err) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE()), { recursive: true });
    const pend = readPending();
    fs.appendFileSync(LOG_FILE(),
      `[${new Date().toISOString()}] 接管启动失败：${err && err.code ? err.code + ' ' : ''}${err && err.message}\n`
      + `    手工恢复：把 ${(pend && pend.backup_dir) || 'data/upgrades/backup_*'} 里的文件拷回安装目录，然后重新启动。\n`);
  } catch { /* nothing left to do */ }
}

// Call only after the HTTP response has finished (res 'finish').
function scheduleRestart({ fromVersion = '', toVersion = '', backupDir = '' } = {}) {
  if (NO_RESTART) {
    return {
      restart: 'suppressed', child_pid: 0,
      note: 'TEXTBOOK_NO_RESTART=1：文件已落盘，但进程没有重启（自检/调试模式）；手动重启后新代码才生效',
    };
  }
  if (scheduled) return { restart: 'scheduled', child_pid: 0, note: '已经发起过一次重启，本次不重复' };
  scheduled = true;

  writeState({ restart_pending: true, from_version: fromVersion, to_version: toVersion, backup_dir: backupDir, at: new Date().toISOString() });

  const logPath = LOG_FILE();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} pid ${process.pid} 发起重启交接（v${fromVersion} → v${toVersion}）=====\n`);

  let child;
  try {
    child = spawn(process.execPath, process.argv.slice(1), {
      cwd: ROOT,
      env: { ...process.env, [CHILD_FLAG]: '1' },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    fs.closeSync(fd);
    writeFatal(e);
    return { restart: 'failed', child_pid: 0, note: '拉起接替进程失败：' + e.message + '（文件已落盘，请手动重启）' };
  }
  child.unref();
  const pid = child.pid;
  fs.closeSync(fd);
  console.log(`[restart] 已拉起接替进程 pid ${pid}，${EXIT_DELAY_MS}ms 后本进程退出（日志 Logs/restart-child.log）`);
  setTimeout(() => process.exit(0), EXIT_DELAY_MS);
  return { restart: 'scheduled', child_pid: pid, note: `已拉起接替进程（pid ${pid}），1~3 秒后新版本上线` };
}

module.exports = { scheduleRestart, isSuppressed, isChild, readPending, clearPending, writeFatal, CHILD_FLAG, LOG_FILE };
