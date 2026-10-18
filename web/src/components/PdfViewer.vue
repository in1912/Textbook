<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import Icon from './Icon.vue';
import BrushBar from './BrushBar.vue';
import { API_BASE, api, fileUrl, token } from '../api.js';
import { debounce } from '../util.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const props = defineProps({
  path: { type: String, default: '' },      // relative path inside the library
  src: { type: String, default: '' },       // direct URL (public share)
  title: { type: String, default: '' },
  initialPage: { type: Number, default: 1 },
  bookmarks: { type: Array, default: () => [] },
  readOnly: { type: Boolean, default: false },
  showClose: { type: Boolean, default: false },
});
const emit = defineEmits(['page', 'close', 'add-bookmark', 'goto-bookmark', 'delete-bookmark', 'loaded', 'error', 'toggle-notes']);

const TOOL_STYLE = {
  pencil: { width: 2.2, alpha: 0.55 },
  ballpoint: { width: 2.6, alpha: 1 },
  crayon: { width: 9, alpha: 0.5 },
  marker: { width: 16, alpha: 0.38 },
  highlighter: { width: 34, alpha: 0.3 },
  line: { width: 2.6, alpha: 1 },
  circle: { width: 2.6, alpha: 1 },
};
const TOOL_COLOR = {
  pencil: '#4b5563', ballpoint: '#1d4ed8', crayon: '#b45309', marker: '#dc2626',
  highlighter: '#fbbf24', line: '#111827', circle: '#dc2626',
};

const tool = ref('select');
const color = ref('#e11d48');
const width = ref(2.6);
const alpha = ref(1);
const toolColor = reactive({ ...TOOL_COLOR });

// shallowRef: a pdf.js document is a class instance with #private fields, and a
// Vue reactive proxy would break every access through `this`.
const doc = shallowRef(null);
const numPages = ref(0);
const loading = ref(true);
const progress = ref('');
const loadError = ref('');
const currentPage = ref(1);
const zoom = ref(1);
const fitScale = ref(1);
const scrollEl = ref(null);
const stageEl = ref(null);

const pages = reactive([]); // { el, rendered, rendering, dpr }
// RenderTasks stay outside reactive state for the same reason as `doc`.
const renderTasks = new Map();
const dims = ref([]);       // page size at scale 1
const marksDoc = reactive({ pages: {} });
const marksLoaded = ref(false);
const undoStack = [];
const redoStack = reactive([]);
const canUndo = ref(false);
const canRedo = computed(() => redoStack.length > 0);

let rafPending = false;
let resizeTimer = null;
let resizeObs = null;

function setPageEl(i, el) { if (el) pages[i].el = el; }

function pageStyle(i) {
  const d = dims.value[i];
  if (!d) return { width: '100%', aspectRatio: '3 / 4' };
  const s = fitScale.value * zoom.value;
  return { width: Math.round(d.w * s) + 'px', height: Math.round(d.h * s) + 'px' };
}

function pageUrl() { return props.src || fileUrl(props.path); }

// ---- loading ---------------------------------------------------------------
let loadSeq = 0;
async function loadPdf() {
  const seq = ++loadSeq;
  loading.value = true;
  loadError.value = '';
  progress.value = '';
  pages.splice(0, pages.length);
  dims.value = [];
  marksDoc.pages = {};
  marksLoaded.value = false;
  undoStack.length = 0;
  redoStack.length = 0;
  canUndo.value = false;
  currentPage.value = Math.max(1, props.initialPage || 1);
  zoom.value = 1;
  if (doc.value) { try { doc.value.destroy(); } catch { /* already gone */ } doc.value = null; }
  if (!props.path && !props.src) { loading.value = false; return; }

  try {
    const task = pdfjsLib.getDocument({
      url: pageUrl(),
      isEvalSupported: false,
      // copied from pdfjs-dist by web/scripts/copy-pdfjs-assets.mjs; without
      // the cmaps Chinese textbooks render with blank glyphs
      cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
    });
    const d = await task.promise;
    if (seq !== loadSeq) { try { d.destroy(); } catch { /* noop */ } return; }
    doc.value = d;
    numPages.value = d.numPages;
    progress.value = '正在准备页面…';
    const list = [];
    for (let i = 1; i <= d.numPages; i++) {
      const p = await d.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      list.push({ w: vp.width, h: vp.height });
      if (i % 20 === 0) progress.value = `正在准备页面 ${i}/${d.numPages}`;
      if (seq !== loadSeq) return;
    }
    dims.value = list;
    pages.splice(0, pages.length, ...list.map(() => ({ el: null, rendered: false, rendering: false, dpr: 1 })));

    if (props.path && !props.readOnly && !props.src) {
      try {
        const m = await api.get('/marks?path=' + encodeURIComponent(props.path));
        if (seq === loadSeq) {
          marksDoc.pages = (m && m.pages) || {};
          if (m && m.corrupt) progress.value = '批注文件损坏，已按空白批注重开';
        }
      } catch { /* an unreadable sidecar should not block reading */ }
      if (seq === loadSeq) marksLoaded.value = true;
    }

    await nextTick();
    recomputeFit();
    loading.value = false;
    progress.value = '';
    emit('loaded', { pages: d.numPages });
    await nextTick();
    updateVisible(true);
    requestAnimationFrame(() => gotoPage(currentPage.value, false));
  } catch (e) {
    if (seq !== loadSeq) return;
    loading.value = false;
    loadError.value = String((e && e.message) || 'PDF 打不开');
    emit('error', loadError.value);
  }
}

function recomputeFit() {
  const el = scrollEl.value;
  const first = dims.value[0];
  if (!el || !first) return;
  const avail = Math.max(200, el.clientWidth - 32);
  fitScale.value = Math.max(0.2, Math.min(3, avail / first.w));
}

// ---- rendering -------------------------------------------------------------
function ensureRender(i) {
  const st = pages[i];
  if (!st || st.rendered || st.rendering || !st.el || !doc.value) return;
  renderPage(i, st);
}

async function renderPage(i, st) {
  st.rendering = true;
  try {
    const page = await doc.value.getPage(i + 1);
    const scale = fitScale.value * zoom.value;
    const vp = page.getViewport({ scale });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    st.dpr = dpr;
    const canvas = st.el.querySelector('canvas.render');
    if (!canvas) { st.rendering = false; return; }
    canvas.width = Math.max(1, Math.floor(vp.width * dpr));
    canvas.height = Math.max(1, Math.floor(vp.height * dpr));
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, vp.width, vp.height);
    const task = page.render({ canvasContext: ctx, viewport: vp });
    renderTasks.set(i, task);
    await task.promise;
    renderTasks.delete(i);
    if (!st.el) return;
    st.rendered = true;
    buildTextLayer(st.el, page, vp);
    setupAnnot(st, vp);
    redrawPage(i);
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') loadError.value = String(e.message || e);
  } finally {
    st.rendering = false;
  }
}

function buildTextLayer(el, page, viewport) {
  let layer = el.querySelector('.textLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'textLayer';
    el.appendChild(layer);
  }
  layer.textContent = '';
  page.getTextContent().then((tc) => {
    if (!layer.isConnected) return;
    const frag = document.createDocumentFragment();
    for (const item of tc.items) {
      if (!item.str) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      if (!fontHeight) continue;
      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.left = tx[4] + 'px';
      span.style.top = (tx[5] - fontHeight) + 'px';
      span.style.fontSize = fontHeight + 'px';
      span.style.fontFamily = 'sans-serif';
      const w = item.width * viewport.scale;
      if (w > 0) span.style.width = w + 'px';
      frag.appendChild(span);
    }
    layer.appendChild(frag);
  }).catch(() => { /* text layer is optional */ });
}

function setupAnnot(st, vp) {
  const tag = st.el.querySelector('canvas.annot');
  if (!tag) return;
  const dpr = st.dpr;
  tag.width = Math.max(1, Math.floor(vp.width * dpr));
  tag.height = Math.max(1, Math.floor(vp.height * dpr));
}

function releasePage(i) {
  const st = pages[i];
  if (!st || !st.el) return;
  const task = renderTasks.get(i);
  if (task) { try { task.cancel(); } catch { /* noop */ } renderTasks.delete(i); }
  st.rendered = false;
  const c = st.el.querySelector('canvas.render');
  if (c) { c.width = 0; c.height = 0; }
  const a = st.el.querySelector('canvas.annot');
  if (a) { a.width = 0; a.height = 0; }
  const t = st.el.querySelector('.textLayer');
  if (t) t.textContent = '';
}

function pruneRendered() {
  const rendered = [];
  for (let i = 0; i < pages.length; i++) if (pages[i].rendered) rendered.push(i);
  if (rendered.length <= 16) return;
  rendered.sort((a, b) => Math.abs(b - currentPage.value) - Math.abs(a - currentPage.value));
  for (let k = 0; k < rendered.length - 14; k++) releasePage(rendered[k]);
}

function updateVisible(force = false) {
  const el = scrollEl.value;
  if (!el || !pages.length) return;
  const top = el.scrollTop;
  const bottom = top + el.clientHeight;
  const margin = el.clientHeight * 0.8;
  let first = -1, last = -1;
  for (let i = 0; i < pages.length; i++) {
    const st = pages[i];
    if (!st.el) continue;
    const y = st.el.offsetTop;
    const h = st.el.offsetHeight;
    if (y + h >= top - margin && y <= bottom + margin) {
      if (first < 0) first = i;
      last = i;
      ensureRender(i);
    }
  }
  if (first >= 0) {
    for (let i = Math.max(0, first - 1); i <= Math.min(pages.length - 1, last + 1); i++) ensureRender(i);
    let cur = first + 1;
    for (let i = first; i <= last; i++) {
      const st = pages[i];
      if (st.el && st.el.offsetTop <= top + 60) cur = i + 1;
    }
    if (cur !== currentPage.value) {
      currentPage.value = cur;
      emit('page', cur);
      pruneRendered();
    }
  }
  if (force) pruneRendered();
}

function onScroll() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; updateVisible(); });
}

function gotoPage(n, smooth = true) {
  const idx = Math.max(0, Math.min(pages.length - 1, Math.floor(Number(n) || 1) - 1));
  const st = pages[idx];
  if (!st || !st.el || !scrollEl.value) return;
  scrollEl.value.scrollTo({ top: Math.max(0, st.el.offsetTop - 8), behavior: smooth ? 'smooth' : 'auto' });
  currentPage.value = idx + 1;
  emit('page', idx + 1);
  ensureRender(idx);
}

// ---- annotations -----------------------------------------------------------
function redrawPage(i) {
  const st = pages[i];
  if (!st || !st.el) return;
  const canvas = st.el.querySelector('canvas.annot');
  if (!canvas || !canvas.width) return;
  const w = canvas.width / st.dpr;
  const h = canvas.height / st.dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
  const list = (marksDoc.pages[String(i + 1)] || []);
  for (const s of list) drawStroke(ctx, s, w, h);
  if (drawing && drawing.page === i) drawStroke(ctx, drawing, w, h);
}

function redrawAll() {
  for (let i = 0; i < pages.length; i++) if (pages[i].rendered) redrawPage(i);
}

function drawStroke(ctx, s, w, h) {
  const pts = (s.points || []).map((p) => [p[0] * w, p[1] * h]);
  if (!pts.length) return;
  const lw = Math.max(0.6, (Number(s.width) || 2) * w / 1000);
  const a = Math.max(0.03, Math.min(1, Number(s.alpha) || 1));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = s.color || '#e11d48';
  ctx.fillStyle = s.color || '#e11d48';
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'highlighter') ctx.globalCompositeOperation = 'multiply';

  if (s.tool === 'circle') {
    const p0 = pts[0], p1 = pts[pts.length - 1];
    const cx = (p0[0] + p1[0]) / 2, cy = (p0[1] + p1[1]) / 2;
    const rx = Math.abs(p1[0] - p0[0]) / 2, ry = Math.abs(p1[1] - p0[1]) / 2;
    if (rx < 1 || ry < 1) { ctx.restore(); return; }
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.tool === 'line') {
    const p0 = pts[0], p1 = pts[pts.length - 1];
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    if (s.tool === 'pencil') {
      // graphite grain: a few light flecks along the line
      ctx.globalAlpha = a * 0.28;
      ctx.lineWidth = lw * 0.5;
      for (let i = 0; i < pts.length; i += 3) {
        const jx = Math.sin(i * 12.9898) * lw * 0.6;
        const jy = Math.cos(i * 78.233) * lw * 0.6;
        ctx.beginPath();
        ctx.arc(pts[i][0] + jx, pts[i][1] + jy, lw * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (s.tool === 'crayon') {
      ctx.globalAlpha = a * 0.35;
      ctx.lineWidth = lw * 0.45;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + 1.2, pts[i][1] + 0.8);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

let drawing = null;
let erasing = false;
let eraseChanged = false;

function localPos(ev, el) {
  const r = el.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)),
    Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)),
  ];
}

function onPointerDown(ev, pageIndex) {
  if (props.readOnly || tool.value === 'select') return;
  if (!pages[pageIndex] || !pages[pageIndex].rendered) return;
  if (ev.button != null && ev.button !== 0) return;
  const el = ev.currentTarget;
  const p = localPos(ev, el);
  el.setPointerCapture(ev.pointerId);
  pushHistory();
  if (tool.value === 'eraser') {
    erasing = true; eraseChanged = false;
    eraseAt(pageIndex, p, el);
    return;
  }
  drawing = {
    id: Math.random().toString(36).slice(2, 10),
    tool: tool.value,
    color: color.value,
    width: width.value,
    alpha: alpha.value,
    points: [p, p],
    page: pageIndex,
  };
  redrawPage(pageIndex);
}

function onPointerMove(ev, pageIndex) {
  if (props.readOnly) return;
  if (erasing) {
    if (!ev.buttons) return;
    eraseAt(pageIndex, localPos(ev, ev.currentTarget), ev.currentTarget);
    return;
  }
  if (!drawing || drawing.page !== pageIndex) return;
  const p = localPos(ev, ev.currentTarget);
  if (drawing.tool === 'line' || drawing.tool === 'circle') {
    drawing.points[1] = p;
  } else {
    const last = drawing.points[drawing.points.length - 1];
    if (Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) < 0.0012) return;
    drawing.points.push(p);
    if (drawing.points.length > 4000) drawing.points.length = 4000;
  }
  redrawPage(pageIndex);
}

function onPointerUp(ev, pageIndex) {
  if (erasing) {
    erasing = false;
    if (eraseChanged) scheduleSave();
    return;
  }
  if (!drawing || drawing.page !== pageIndex) return;
  const s = drawing;
  drawing = null;
  if (s.tool !== 'line' && s.tool !== 'circle' && s.points.length < 2) s.points.push(s.points[0]);
  const key = String(pageIndex + 1);
  if (!marksDoc.pages[key]) marksDoc.pages[key] = [];
  marksDoc.pages[key].push(s);
  redrawPage(pageIndex);
  scheduleSave();
}

function eraseAt(pageIndex, p, el) {
  const key = String(pageIndex + 1);
  const list = marksDoc.pages[key] || [];
  const r = el.getBoundingClientRect();
  const px = p[0] * r.width, py = p[1] * r.height;
  const threshold = 9;
  let removed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    if (strokeHit(list[i], px, py, r.width, r.height, threshold)) {
      list.splice(i, 1);
      removed = true;
    }
  }
  if (!list.length) delete marksDoc.pages[key];
  if (removed) { eraseChanged = true; redrawPage(pageIndex); }
}

function strokeHit(s, x, y, w, h, th) {
  const pts = (s.points || []).map((p) => [p[0] * w, p[1] * h]);
  if (!pts.length) return false;
  const reach = Math.max(th, ((Number(s.width) || 2) * w / 1000) / 2 + 4);
  if (s.tool === 'circle' && pts.length >= 2) {
    const p0 = pts[0], p1 = pts[pts.length - 1];
    const cx = (p0[0] + p1[0]) / 2, cy = (p0[1] + p1[1]) / 2;
    const rx = Math.abs(p1[0] - p0[0]) / 2, ry = Math.abs(p1[1] - p0[1]) / 2;
    if (rx < 1 || ry < 1) return false;
    const t = Math.atan2((y - cy) / ry, (x - cx) / rx);
    const ex = cx + rx * Math.cos(t), ey = cy + ry * Math.sin(t);
    return Math.hypot(ex - x, ey - y) <= reach;
  }
  if (s.tool === 'line' && pts.length >= 2) {
    return segDist(pts[0], pts[pts.length - 1], x, y) <= reach;
  }
  for (let i = 1; i < pts.length; i++) {
    if (segDist(pts[i - 1], pts[i], x, y) <= reach) return true;
  }
  return pts.length === 1 ? Math.hypot(pts[0][0] - x, pts[0][1] - y) <= reach : false;
}

function segDist(a, b, x, y) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
}

// ---- history / saving ------------------------------------------------------
function snapshot() { return JSON.stringify(marksDoc.pages || {}); }
function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack.splice(0, redoStack.length);
  canUndo.value = true;
}
function applySnapshot(json) {
  marksDoc.pages = JSON.parse(json || '{}');
  redrawAll();
  scheduleSave();
}
function undo() {
  if (props.readOnly || !undoStack.length) return;
  redoStack.push(snapshot());
  applySnapshot(undoStack.pop());
  canUndo.value = undoStack.length > 0;
}
function redo() {
  if (props.readOnly || !redoStack.length) return;
  undoStack.push(snapshot());
  canUndo.value = true;
  applySnapshot(redoStack.pop());
}

async function saveMarks() {
  if (props.readOnly || !props.path || props.src) return;
  try {
    await api.put('/marks?path=' + encodeURIComponent(props.path), { pages: marksDoc.pages });
  } catch { /* keep the strokes in memory; the next edit retries */ }
}
const scheduleSave = debounce(saveMarks, 700);

function flushSave() {
  if (props.readOnly || !props.path || props.src) return;
  const body = JSON.stringify({ pages: marksDoc.pages || {} });
  const t = token();
  const url = API_BASE + '/marks?path=' + encodeURIComponent(props.path)
    + (t ? '&token=' + encodeURIComponent(t) : '');
  try {
    fetch(url, { method: 'PUT', body, keepalive: true, headers: { 'Content-Type': 'application/json' } });
  } catch { /* page is going away anyway */ }
}

// ---- tool switching --------------------------------------------------------
watch(tool, (t) => {
  if (t === 'select' || t === 'eraser') return;
  const st = TOOL_STYLE[t];
  if (st) { width.value = st.width; alpha.value = st.alpha; }
  if (TOOL_COLOR[t] && (toolColor[t] || TOOL_COLOR[t])) color.value = toolColor[t] || TOOL_COLOR[t];
});
watch(color, (c) => {
  if (tool.value !== 'select' && tool.value !== 'eraser') toolColor[tool.value] = c;
});

// ---- zoom / resize ---------------------------------------------------------
function setZoom(z) {
  const next = Math.max(0.5, Math.min(3, Math.round(z * 100) / 100));
  if (Math.abs(next - zoom.value) < 0.001) return;
  zoom.value = next;
  relayout();
}
function relayout() {
  for (let i = 0; i < pages.length; i++) { if (pages[i].rendered) releasePage(i); }
  nextTick(() => {
    updateVisible(true);
    requestAnimationFrame(() => {
      const st = pages[currentPage.value - 1];
      if (st && st.el && scrollEl.value) scrollEl.value.scrollTop = Math.max(0, st.el.offsetTop - 8);
    });
  });
}

function onResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const old = fitScale.value;
    recomputeFit();
    if (Math.abs(old - fitScale.value) > 0.001) relayout();
  }, 180);
}

onMounted(() => {
  loadPdf();
  if (scrollEl.value) scrollEl.value.addEventListener('scroll', onScroll, { passive: true });
  resizeObs = new ResizeObserver(onResize);
  if (scrollEl.value) resizeObs.observe(scrollEl.value);
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', onHide);
});
onBeforeUnmount(() => {
  loadSeq++;
  window.removeEventListener('pagehide', flushSave);
  document.removeEventListener('visibilitychange', onHide);
  if (resizeObs) resizeObs.disconnect();
  if (resizeTimer) clearTimeout(resizeTimer);
});
function onHide() { if (document.hidden) flushSave(); }

watch(() => [props.path, props.src], () => { loadPdf(); });
watch(() => props.initialPage, (v) => { if (v) gotoPage(v, false); });

defineExpose({ gotoPage, currentPage, numPages });
</script>

<template>
  <div class="pdf-viewer" style="height:100%;display:flex;flex-direction:column;min-height:0">
    <div class="pdf-head">
      <button v-if="showClose" class="icbtn" title="关闭教材" @click="$emit('close')">
        <Icon name="arrow-left" :size="16" />
      </button>
      <Icon v-else name="book" :size="16" />
      <span class="title" :title="title">{{ title || '教材' }}</span>
      <button class="icbtn" title="缩小" @click="setZoom(zoom - 0.15)"><span style="font-size:15px">−</span></button>
      <span class="muted mono" style="font-size:11.5px;min-width:38px;text-align:center">{{ Math.round(zoom * 100) }}%</span>
      <button class="icbtn" title="放大" @click="setZoom(zoom + 0.15)"><Icon name="plus" :size="15" /></button>
      <a class="icbtn" :href="pageUrl()" download :title="readOnly ? '下载教材' : '下载原 PDF'">
        <Icon name="download" :size="16" />
      </a>
      <button v-if="!readOnly" class="icbtn hide-sm" title="显示/隐藏笔记" @click="$emit('toggle-notes')">
        <Icon name="panel-right" :size="16" />
      </button>
    </div>

    <div class="pdf-scroll" ref="scrollEl" @scroll.passive="onScroll">
      <div v-if="loading" class="pdf-loading">
        正在打开 PDF…<br />
        <span class="muted">{{ progress }}</span>
      </div>
      <div v-else-if="loadError" class="pdf-error">
        <div class="notice err">{{ loadError }}</div>
        <p class="muted">如果是网络中断，刷新页面重试。</p>
      </div>
      <div v-else class="pdf-stage" ref="stageEl">
        <div v-for="(st, i) in pages" :key="i" class="pdf-page"
             :class="{ phbox: !st.rendered }" :style="pageStyle(i)" :ref="(el) => setPageEl(i, el)">
          <canvas class="render" />
          <canvas class="annot" :class="{ passthrough: readOnly || tool === 'select' }"
                  @pointerdown="onPointerDown($event, i)"
                  @pointermove="onPointerMove($event, i)"
                  @pointerup="onPointerUp($event, i)"
                  @pointercancel="onPointerUp($event, i)" />
          <span class="page-badge">{{ i + 1 }}</span>
        </div>
      </div>
    </div>

    <BrushBar v-if="!readOnly && !loading && !loadError"
              :tool="tool" :color="color" :width="width" :alpha="alpha"
              :page="currentPage" :pages="numPages" :bookmarks="bookmarks"
              :can-undo="canUndo" :can-redo="canRedo"
              @update:tool="tool = $event" @update:color="color = $event" @update:alpha="alpha = $event"
              @goto-page="gotoPage" @undo="undo" @redo="redo"
              @add-bookmark="$emit('add-bookmark', $event)"
              @goto-bookmark="$emit('goto-bookmark', $event)"
              @delete-bookmark="$emit('delete-bookmark', $event)" />
  </div>
</template>
