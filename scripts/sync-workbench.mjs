// Mirror the standalone textbook module into the personal workbench.
//
//   node scripts/sync-workbench.mjs               # copy now
//   node scripts/sync-workbench.mjs --check       # report drift, change nothing
//   node scripts/sync-workbench.mjs --dest D:\CC\personal-workbench
//
// Two trees are produced:
//   <workspace>/server/textbook/*.js      the API router and its helpers
//   <workspace>/web/public/textbook/**    the built SPA, served at /textbook/
//
// The workbench wires these up once (server/index.js mount, auth.js page map,
// tabs.js entry, Learning.vue panel). Everything that changes per textbook
// version lives in the files copied here, so "change both projects" reduces to
// running this script after each build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const destArg = args.indexOf('--dest');
const workbench = destArg >= 0
  ? path.resolve(args[destArg + 1])
  : (process.env.WORKBENCH_DIR || path.resolve(repo, '..', 'personal-workbench'));

const SERVER_FILES = ['router.js', 'books.js', 'marks.js', 'schema.js'];
const WEB_SRC = path.join(repo, 'web', 'dist');
const SERVER_DEST = path.join(workbench, 'server', 'textbook');
const WEB_DEST = path.join(workbench, 'web', 'public', 'textbook');

const drift = [];
function copyFile(from, to) {
  const src = fs.readFileSync(from);
  let same = false;
  try { same = fs.readFileSync(to).equals(src); } catch { /* missing */ }
  if (same) return false;
  if (!check) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, src);
  }
  drift.push(path.relative(workbench, to));
  return true;
}

function walk(from, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
    const r = path.join(rel, ent.name);
    if (ent.isDirectory()) out.push(...walk(from, r));
    else out.push(r);
  }
  return out;
}

if (!fs.existsSync(workbench)) {
  console.error(`[sync] workbench not found: ${workbench}`);
  process.exit(1);
}
if (!fs.existsSync(WEB_SRC)) {
  console.error('[sync] web/dist is missing — run `npm run build:web` first');
  process.exit(1);
}

for (const f of SERVER_FILES) copyFile(path.join(repo, 'server', f), path.join(SERVER_DEST, f));

const files = walk(WEB_SRC);
for (const rel of files) copyFile(path.join(WEB_SRC, rel), path.join(WEB_DEST, rel));

// stale files from a previous build (old hashed asset names) would pile up
const wanted = new Set(files);
let removed = 0;
if (fs.existsSync(WEB_DEST)) {
  for (const rel of walk(WEB_DEST)) {
    if (wanted.has(rel)) continue;
    removed += 1;
    if (!check) fs.rmSync(path.join(WEB_DEST, rel), { force: true });
  }
}

if (!drift.length && !removed) {
  console.log('[sync] workbench is already up to date');
} else {
  console.log(`[sync] ${check ? 'drifted' : 'updated'}: ${drift.length} file(s), ${removed} stale removed`);
  for (const d of drift.slice(0, 40)) console.log('  ' + d);
  if (drift.length > 40) console.log(`  ... ${drift.length - 40} more`);
  if (check) process.exitCode = 2;
}
