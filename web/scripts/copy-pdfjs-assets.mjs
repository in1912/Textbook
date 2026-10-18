// Copy the pdf.js runtime data files that are not part of the JS bundle:
//   cmaps/           — character maps, required to draw Chinese/Japanese text
//   standard_fonts/  — substitutes for the 14 standard PDF fonts
//
// They land in public/pdfjs and Vite copies public/ into dist/ on build, so the
// packaged app renders CJK textbooks without reaching out to a CDN.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const src = path.join(webRoot, 'node_modules', 'pdfjs-dist');
const dest = path.join(webRoot, 'public', 'pdfjs');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) n += copyDir(a, b);
    else { fs.copyFileSync(a, b); n += 1; }
  }
  return n;
}

if (!fs.existsSync(src)) {
  console.error('[pdfjs-assets] pdfjs-dist is not installed; run npm install first');
  process.exit(1);
}
let total = 0;
for (const name of ['cmaps', 'standard_fonts']) {
  const from = path.join(src, name);
  if (!fs.existsSync(from)) {
    console.warn(`[pdfjs-assets] missing ${name}, skipped`);
    continue;
  }
  const n = copyDir(from, path.join(dest, name));
  total += n;
  console.log(`[pdfjs-assets] ${name}: ${n} files`);
}
console.log(`[pdfjs-assets] ${total} files -> ${path.relative(webRoot, dest)}`);
