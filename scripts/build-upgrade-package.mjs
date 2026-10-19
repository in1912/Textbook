#!/usr/bin/env node
// Build an upgrade package for an existing installation:
//
//   node scripts/build-upgrade-package.mjs
//   -> textbook-upgrade-<version>.zip      (repository root, git-ignored)
//
// Upload it from 设置 → 系统升级 in a running installation. The package only
// carries what the upgrade endpoint is allowed to write:
//
//   package.json
//   server/**.js
//   web/dist/**            (the built SPA, including pdfjs cmaps/fonts)
//
// manifest.json holds the version and a size + sha256 per file; the server
// rejects the package if anything does not match. Data (data/), the textbook
// tree (book/) and node_modules are never part of it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildZip } = require('../server/zip.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function walk(base, rel, out) {
  for (const e of fs.readdirSync(path.join(base, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (JUNK.has(e.name)) continue;
    const r = rel + '/' + e.name;
    if (e.isDirectory()) walk(base, r, out);
    else out.push(r);
  }
}

export function collectFiles(root = ROOT) {
  const files = ['package.json'];
  walk(root, 'server', files);
  walk(root, 'web/dist', files);
  // The API only accepts server JS; keep data files out even if someone drops
  // them under server/ by accident.
  return files.filter((rel) => rel === 'package.json' || rel.endsWith('.js') || rel.startsWith('web/dist/'));
}

export function buildUpgradePackage({ root = ROOT, out, version } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ver = String(version || pkg.version || '').trim();
  if (!ver) throw new Error('package.json 没有 version');

  const rels = collectFiles(root);
  if (!rels.includes('web/dist/index.html')) {
    throw new Error('web/dist/index.html 不存在——先运行 npm run build:web');
  }
  const files = rels.map((rel) => {
    const data = fs.readFileSync(path.join(root, rel));
    return {
      path: rel,
      size: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      data,
    };
  });
  const manifest = {
    app: 'textbook',
    kind: 'upgrade-pack',
    version: ver,
    from_version: String(process.env.TEXTBOOK_FROM_VERSION || ''),
    built_at: new Date().toISOString(),
    files: files.map(({ path: p, size, sha256 }) => ({ path: p, size, sha256 })),
  };
  const entries = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    ...files.map((f) => ({ name: f.path, data: f.data })),
  ];
  const buf = buildZip(entries);
  const target = out || path.join(root, `textbook-upgrade-${ver}.zip`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  const raw = files.reduce((n, f) => n + f.size, 0);
  console.log(`[upgrade-pack] ${target}`);
  console.log(`[upgrade-pack] version ${ver} | ${files.length + 1} entries | ${(buf.length / 1048576).toFixed(2)} MB zip | ${(raw / 1048576).toFixed(2)} MB raw`);
  return { target, buffer: buf, manifest };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    buildUpgradePackage({ out: process.argv[2] || undefined });
  } catch (e) {
    console.error('[upgrade-pack] ' + e.message);
    process.exit(1);
  }
}
