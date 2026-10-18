#!/usr/bin/env node
// Build the three distributables in the repository root:
//
//   textbook-<version>-windows.zip   node_modules + web/dist + start-windows.cmd
//   textbook-<version>-macos.zip     node_modules + web/dist + start-macos.command
//   textbook-<version>-docker.zip    Dockerfile + compose, no node_modules
//
// The textbook tree (book/) and the runtime database (data/) are never packaged;
// they live on the user's machine and are configured from the 设置 tab.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const STAGE = path.join(ROOT, 'dist-packages', '.stage');
const OUT = ROOT;

const COMMON = ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'server', 'web/dist'];
const SKIP_NODE_MODULES = new Set(['.cache', '.bin']);

function die(msg) { console.error('[pack] ' + msg); process.exit(1); }
function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

function copy(rel, dest, { optional = false } = {}) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    if (optional) return;
    die(`missing ${rel} — run "npm run build:web" first`);
  }
  fs.cpSync(src, path.join(dest, rel), { recursive: true });
}

function stage(name, { nodeModules = false, extra = [] } = {}) {
  const dir = path.join(STAGE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of COMMON) copy(rel, dir);
  for (const rel of extra) copy(rel, dir);
  if (nodeModules) {
    const src = path.join(ROOT, 'node_modules');
    if (!fs.existsSync(path.join(src, 'express'))) die('node_modules/express is missing — run npm install');
    const dest = path.join(dir, 'node_modules');
    fs.cpSync(src, dest, {
      recursive: true,
      filter: (p) => {
        const rel = path.relative(src, p);
        return !rel.split(path.sep).some((part) => SKIP_NODE_MODULES.has(part));
      },
    });
    // The distribution ships a runtime only; keep the package manager out of it.
    for (const f of ['package-lock.json']) fs.rmSync(path.join(dest, f), { force: true });
  }
  return dir;
}

function zip(dir, outName) {
  const out = path.join(OUT, outName);
  fs.rmSync(out, { force: true });
  const py = process.env.PYTHON || 'python';
  execFileSync(py, [path.join(ROOT, 'scripts', 'zip-utf8.py'), dir, out, `textbook-${PKG.version}`], {
    stdio: 'inherit',
  });
  const size = fs.statSync(out).size;
  console.log(`[pack] ${outName}  ${mb(size)}`);
  return out;
}

function walkSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? walkSize(p) : fs.statSync(p).size;
  }
  return n;
}

if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
  die('web/dist/index.html is missing — run "npm run build:web" first');
}
if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'pdfjs', 'cmaps'))) {
  die('web/dist/pdfjs is missing — rebuild the web app (the build copies cmaps/standard_fonts)');
}
if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'pdfjs', 'standard_fonts'))) {
  die('web/dist/pdfjs/standard_fonts is missing — rebuild the web app');
}

fs.rmSync(STAGE, { recursive: true, force: true });

const win = stage('windows', { nodeModules: true, extra: ['start-windows.cmd'] });
const mac = stage('macos', { nodeModules: true, extra: ['start-macos.command'] });
const dock = stage('docker', { extra: ['Dockerfile', 'docker-compose.yml', '.dockerignore'] });

console.log(`[pack] windows staging ${mb(walkSize(win))}`);
console.log(`[pack] macos   staging ${mb(walkSize(mac))}`);
console.log(`[pack] docker  staging ${mb(walkSize(dock))}`);

zip(win, `textbook-${PKG.version}-windows.zip`);
zip(mac, `textbook-${PKG.version}-macos.zip`);
zip(dock, `textbook-${PKG.version}-docker.zip`);

if (!process.env.KEEP_STAGE) fs.rmSync(STAGE, { recursive: true, force: true });
console.log('[pack] done');
