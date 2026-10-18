import DOMPurify from 'dompurify';

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Notes are authored by a logged-in user but rendered publicly on share pages,
// inside the workbench origin. Treat every stored HTML string as untrusted.
const PURIFY = {
  ADD_ATTR: ['data-page', 'data-bm', 'target', 'rel'],
  ADD_TAGS: ['table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'span', 'u', 's', 'font', 'center'],
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'input'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick'],
};
export function cleanHtml(html) {
  return DOMPurify.sanitize(String(html || ''), PURIFY);
}

export function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// Small Markdown subset for AI reports: headings, bold, italic, lists, code.
export function mdToHtml(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inList = 0;
  const closeList = () => { if (inList) { out.push(`</${inList === 1 ? 'ul' : 'ol'}>`); inList = 0; } };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const n = Math.min(4, h[1].length);
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (inList !== 1) { closeList(); out.push('<ul>'); inList = 1; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (inList !== 2) { closeList(); out.push('<ol>'); inList = 2; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return cleanHtml(out.join('\n'));
}
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function fmtNum(n) {
  const x = Number(n) || 0;
  if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (x >= 1e4) return (x / 1e4).toFixed(1) + '万';
  return String(x);
}
export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
export function fmtTime(s) {
  if (!s) return '';
  return String(s).replace('T', ' ').slice(0, 16);
}
export function isExerciseName(name) {
  return /习题|练习|试卷|真题/.test(String(name || ''));
}
export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
