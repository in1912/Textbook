<script setup>
import { nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { api } from '../api.js';
import { cleanHtml, debounce, esc, fmtTime, stripTags } from '../util.js';
import { copyText } from '../clipboard.js';

const props = defineProps({
  path: { type: String, default: '' },
  title: { type: String, default: '' },
  page: { type: Number, default: 1 },
  bookmarks: { type: Array, default: () => [] },
});
const emit = defineEmits(['goto-page', 'saved', 'share-changed', 'collapse']);

const editorEl = ref(null);
const loading = ref(false);
const status = ref('saved'); // saved | dirty | saving | error
const savedAt = ref('');
const words = ref(0);
const preview = ref(false);
const imageBusy = ref(false);
const fileInput = ref(null);
const bmOpen = ref(false);

const fontFamily = ref('');
const fontSize = ref('3');
const textColor = ref('#111827');
const markColor = ref('#fde68a');
const FONTS = ['', '宋体', '黑体', '楷体', '仿宋', '微软雅黑', 'Arial'];

const share = ref(null);
const shareOpen = ref(false);
const shareBusy = ref(false);
const shareErr = ref('');
const copied = ref(false);
const shareForm = reactive({ days: 7, mode: 'dynamic', with_book: true });

let lastPath = '';
let lastHtml = '';
let lastTitle = '';
let savedRange = null;

function defaultTitle() {
  return String(props.title || '').replace(/\.pdf$/i, '') || '学习笔记';
}

async function load() {
  const p = props.path || '';
  const prevPath = lastPath;
  if (prevPath && prevPath !== p && status.value !== 'saved') {
    await saveNow(prevPath, lastHtml, lastTitle);
  }
  lastPath = p;
  share.value = null;
  preview.value = false;
  bmOpen.value = false;
  if (!p) {
    lastHtml = ''; lastTitle = '';
    if (editorEl.value) editorEl.value.innerHTML = '';
    status.value = 'saved'; words.value = 0; savedAt.value = '';
    return;
  }
  loading.value = true;
  try {
    const r = await api.get('/note?path=' + encodeURIComponent(p));
    lastHtml = cleanHtml(r.html || '');
    lastTitle = r.title || defaultTitle();
    share.value = r.share || null;
    status.value = 'saved';
    savedAt.value = fmtTime(r.updated_at);
    words.value = stripTags(lastHtml).length;
    await nextTick();
    if (editorEl.value) editorEl.value.innerHTML = lastHtml;
  } catch (e) {
    status.value = 'error';
  } finally {
    loading.value = false;
  }
}

watch(() => props.path, load, { immediate: true });

function refreshWords() { words.value = stripTags(lastHtml).length; }

function onInput() {
  if (!editorEl.value) return;
  lastHtml = editorEl.value.innerHTML;
  status.value = 'dirty';
  refreshWords();
  scheduleSave();
}

async function saveNow(p, html, title) {
  if (!p) return;
  status.value = 'saving';
  try {
    const r = await api.put('/note', { path: p, html, title: title || defaultTitle() });
    if (p === lastPath) {
      status.value = 'saved';
      savedAt.value = fmtTime(r.updated_at);
    }
    emit('saved', { path: p, updated_at: r.updated_at });
  } catch (e) {
    status.value = 'error';
    throw e;
  }
}
const scheduleSave = debounce(() => {
  if (!lastPath) return;
  saveNow(lastPath, lastHtml, lastTitle).catch(() => {});
}, 900);

// ---- rich text commands ----------------------------------------------------
function rememberSelection() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editorEl.value && editorEl.value.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
}
function restoreSelection() {
  if (!savedRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange);
}
function cmd(name, val = null) {
  if (!editorEl.value) return;
  restoreSelection();
  editorEl.value.focus();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand(name, false, val);
  rememberSelection();
  onInput();
}
function block(tag) { cmd('formatBlock', '<' + tag + '>'); }

function onEditorClick(e) {
  const tag = e.target && e.target.closest ? e.target.closest('.tb-tag') : null;
  if (tag) {
    const n = Number(tag.getAttribute('data-page')) || 1;
    emit('goto-page', n);
  }
}

// ---- images ----------------------------------------------------------------
function pickImage() { if (fileInput.value) fileInput.value.click(); }

function compressImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1400;
      const s = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || 1) * s));
      const h = Math.max(1, Math.round((img.naturalHeight || 1) * s));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    img.src = url;
  });
}

async function insertFiles(files) {
  const list = Array.from(files || []).filter((f) => /^image\//i.test(f.type));
  if (!list.length || !editorEl.value) return;
  imageBusy.value = true;
  for (const f of list) {
    const data = await compressImage(f);
    if (!data) continue;
    cmd('insertHTML', `<img src="${data}" alt="${esc(f.name)}" /><p><br></p>`);
  }
  imageBusy.value = false;
  if (fileInput.value) fileInput.value.value = '';
}

function onPaste(e) {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = Array.from(cd.files || []);
  if (files.some((f) => /^image\//i.test(f.type))) {
    e.preventDefault();
    insertFiles(files);
    return;
  }
  const html = cd.getData('text/html');
  if (html) {
    // Pasting from Word/browsers drags along half their stylesheet; keep only
    // structure and basic formatting.
    e.preventDefault();
    document.execCommand('insertHTML', false, cleanHtml(html));
    onInput();
    return;
  }
  const text = cd.getData('text/plain');
  if (text) {
    e.preventDefault();
    document.execCommand('insertText', false, text);
    onInput();
  }
}

// ---- bookmarks -------------------------------------------------------------
function insertTag(b) {
  const label = b.label || `第 ${b.page} 页`;
  const html = `<span class="tb-tag" contenteditable="false" data-page="${b.page}" data-bm="${b.id}">第 ${b.page} 页 · ${esc(label)}</span>&nbsp;`;
  cmd('insertHTML', html);
  bmOpen.value = false;
}

// ---- preview / export ------------------------------------------------------
function togglePreview() {
  if (!preview.value) rememberSelection();
  preview.value = !preview.value;
  if (!preview.value) nextTick(() => { if (editorEl.value) editorEl.value.innerHTML = lastHtml; });
}

function exportWord() {
  const html = cleanHtml(lastHtml);
  const name = String(props.title || '学习笔记').replace(/[\\/:*?"<>|]/g, '_');
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
  <head><meta charset="utf-8"><title>${esc(name)}</title>
  <style>
    @page { size: A4; margin: 2cm; }
    body { font-family: "宋体", serif; font-size: 12pt; line-height: 1.7; color: #111; }
    h1 { font-size: 16pt; } h2 { font-size: 14pt; } h3 { font-size: 12.5pt; }
    img { max-width: 100%; }
    blockquote { border-left: 2px solid #999; margin: 0; padding-left: 10px; color: #444; }
    .tb-tag { color: #2f6f5e; }
  </style></head>
  <body><h1>${esc(name)}</h1>${html}</body></html>`;
  const blob = new Blob(['﻿', doc], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '.doc';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---- sharing ---------------------------------------------------------------
function shareUrl() {
  if (!share.value) return '';
  try { return new URL(share.value.url, location.href).href; } catch { return share.value.url; }
}

async function openShare() {
  shareErr.value = '';
  copied.value = false;
  if (share.value) {
    shareForm.days = daysLeft(share.value.expires_at);
    shareForm.mode = share.value.mode || 'dynamic';
    shareForm.with_book = !!share.value.with_book;
  }
  shareOpen.value = true;
  if (lastPath && status.value !== 'saved') {
    try { await saveNow(lastPath, lastHtml, lastTitle); } catch { /* shown below */ }
  }
}

function daysLeft(expires) {
  if (!expires) return 0;
  const d = (new Date(String(expires).replace(' ', 'T')) - new Date()) / 86400000;
  if (d > 25) return 30;
  if (d > 10) return 14;
  return 7;
}

async function createShare() {
  shareBusy.value = true;
  shareErr.value = '';
  try {
    await saveNow(lastPath, lastHtml, lastTitle);
    const r = await api.post('/note/share', {
      path: lastPath,
      days: shareForm.days,
      mode: shareForm.mode,
      with_book: shareForm.with_book,
      keep_token: true,
    });
    share.value = {
      token: r.token, url: r.url, with_book: r.with_book, mode: r.mode, expires_at: r.expires_at,
    };
    emit('share-changed', share.value);
  } catch (e) {
    shareErr.value = e.message || '生成分享链接失败';
  } finally {
    shareBusy.value = false;
  }
}

async function closeShare() {
  if (!lastPath) return;
  shareBusy.value = true;
  try {
    await api.del('/note/share?path=' + encodeURIComponent(lastPath));
    share.value = null;
    shareOpen.value = false;
    emit('share-changed', null);
  } catch (e) {
    shareErr.value = e.message || '关闭分享失败';
  } finally {
    shareBusy.value = false;
  }
}

async function copyLink() {
  const ok = await copyText(shareUrl());
  copied.value = ok;
  setTimeout(() => { copied.value = false; }, 1800);
}
function selectLink(e) { e.target.select(); }

onBeforeUnmount(() => {
  if (lastPath && status.value === 'dirty') {
    saveNow(lastPath, lastHtml, lastTitle).catch(() => {});
  }
});
</script>

<template>
  <div class="notecol-inner">
    <div class="note-head">
      <Icon name="text" :size="15" />
      <span class="t" :title="title || '笔记'">笔记</span>
      <button class="icbtn" :class="{ on: preview }" title="预览显示效果" @click="togglePreview">
        <Icon name="book-open" :size="16" />
      </button>
      <button class="icbtn" title="导出为 Word" :disabled="!path" @click="exportWord">
        <Icon name="download" :size="16" />
      </button>
      <button class="icbtn" title="分享笔记" :disabled="!path" @click="openShare">
        <Icon name="share" :size="16" />
      </button>
      <button class="icbtn" title="收起笔记" @click="$emit('collapse')">
        <Icon name="panel-right" :size="16" />
      </button>
    </div>

    <div v-if="!path" class="note-body">
      <div class="empty-tip" style="margin-top:60px">
        先打开一本教材，<br />这里会显示这本书的笔记。
      </div>
    </div>

    <template v-else>
      <div v-show="!preview" class="note-tools" @mousedown="rememberSelection">
        <select v-model="fontFamily" title="字体" @change="cmd('fontName', fontFamily || '')">
          <option v-for="f in FONTS" :key="f" :value="f">{{ f || '默认字体' }}</option>
        </select>
        <select v-model="fontSize" title="字号" @change="cmd('fontSize', fontSize)">
          <option value="2">小</option>
          <option value="3">正常</option>
          <option value="4">大</option>
          <option value="5">特大</option>
          <option value="6">标题</option>
        </select>
        <span class="sep" />
        <button class="icbtn" title="加粗" @click="cmd('bold')"><b>B</b></button>
        <button class="icbtn" title="斜体" @click="cmd('italic')"><i>I</i></button>
        <button class="icbtn" title="下划线" @click="cmd('underline')"><u>U</u></button>
        <button class="icbtn" title="删除线" @click="cmd('strikeThrough')"><s>S</s></button>
        <label class="icbtn colorbtn" title="文字颜色">
          <span class="cdot" :style="{ background: textColor }" />
          <input type="color" v-model="textColor" @change="cmd('foreColor', textColor)" />
        </label>
        <label class="icbtn colorbtn" title="背景高亮">
          <span class="cdot" :style="{ background: markColor }" />
          <input type="color" v-model="markColor" @change="cmd('hiliteColor', markColor)" />
        </label>
        <span class="sep" />
        <button class="icbtn hide-sm" title="一级标题" @click="block('h1')">H1</button>
        <button class="icbtn hide-sm" title="二级标题" @click="block('h2')">H2</button>
        <button class="icbtn hide-sm" title="三级标题" @click="block('h3')">H3</button>
        <button class="icbtn hide-sm" title="正文" @click="block('p')">正文</button>
        <button class="icbtn" title="引用" @click="block('blockquote')"><Icon name="quote" :size="15" /></button>
        <span class="sep" />
        <button class="icbtn" title="无序列表" @click="cmd('insertUnorderedList')">•≡</button>
        <button class="icbtn" title="有序列表" @click="cmd('insertOrderedList')">1≡</button>
        <button class="icbtn" title="插入图片" @click="pickImage"><Icon name="image" :size="16" /></button>
        <div style="position:relative">
          <button class="icbtn" title="插入书签标签" @click="bmOpen = !bmOpen">
            <Icon name="bookmark" :size="16" />
          </button>
          <div v-if="bmOpen" class="bmpop">
            <div class="muted" style="font-size:12px;margin-bottom:6px">点击书签插入到笔记</div>
            <div v-if="!bookmarks.length" class="muted" style="font-size:12px">这本书还没有书签</div>
            <button v-for="b in bookmarks" :key="b.id" class="bmitem" :style="{ borderLeftColor: b.color }"
                    @click="insertTag(b)">
              <span>第 {{ b.page }} 页</span>
              <span class="muted">{{ b.label }}</span>
            </button>
          </div>
        </div>
        <span class="sep" />
        <button class="icbtn" title="撤销" @click="cmd('undo')"><Icon name="undo" :size="15" /></button>
        <button class="icbtn hide-sm" title="重做" @click="cmd('redo')"><Icon name="redo" :size="15" /></button>
        <button class="icbtn hide-sm" title="清除格式" @click="cmd('removeFormat')"><Icon name="eraser" :size="15" /></button>
      </div>

      <div v-show="!preview" class="note-body">
        <div ref="editorEl" class="note-editor" contenteditable="true" spellcheck="false"
             data-ph="在这里记笔记：可以粘贴从 PDF 复制的文字，也可以直接粘贴截图…"
             @input="onInput" @paste="onPaste" @click="onEditorClick"
             @keyup="rememberSelection" @mouseup="rememberSelection" />
        <div v-if="imageBusy" class="muted" style="margin-top:8px;font-size:12px">正在压缩并插入图片…</div>
      </div>

      <div v-if="preview" class="note-body">
        <div class="report-body" v-html="cleanHtml(lastHtml)" />
        <div v-if="!lastHtml" class="empty-tip">还没有内容</div>
      </div>

      <div class="note-status">
        <span v-if="status === 'saving'">正在保存…</span>
        <span v-else-if="status === 'dirty'">未保存</span>
        <span v-else-if="status === 'error'" style="color:var(--danger)">保存失败，请检查连接</span>
        <span v-else>已保存{{ savedAt ? ' · ' + savedAt : '' }}</span>
        <span class="grow" />
        <span v-if="share">已分享</span>
        <span>{{ words }} 字</span>
      </div>
    </template>

    <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="insertFiles($event.target.files)" />

    <div v-if="shareOpen" class="modal-mask" @click.self="shareOpen = false">
      <div class="modal" style="width:min(520px,100%)">
        <h3>分享笔记</h3>
        <div class="notice" style="margin-bottom:12px">
          打开链接的人不用登录就能查看这篇笔记。关闭分享或到期后链接立即失效。
        </div>

        <label class="field" style="margin-bottom:10px">显示方式
          <select v-model="shareForm.mode">
            <option value="dynamic">动态（每次打开都显示最新笔记）</option>
            <option value="static">静态（保存成一份快照，之后修改不影响链接）</option>
          </select>
        </label>
        <label class="field" style="margin-bottom:10px">有效期
          <select v-model.number="shareForm.days">
            <option :value="7">7 天</option>
            <option :value="14">14 天</option>
            <option :value="30">30 天</option>
            <option :value="0">永久</option>
          </select>
        </label>
        <label class="row" style="gap:8px;margin-bottom:6px">
          <input type="checkbox" v-model="shareForm.with_book" />
          <span>附带这本教材（左侧抽屉可展开）</span>
        </label>

        <div v-if="shareErr" class="notice err" style="margin-top:10px">{{ shareErr }}</div>

        <div v-if="share" style="margin-top:14px">
          <div class="muted" style="font-size:12px;margin-bottom:4px">
            分享链接 · {{ share.expires_at ? '到期 ' + share.expires_at : '永久有效' }}
          </div>
          <div class="share-link">
            <input type="text" readonly :value="shareUrl()" @focus="selectLink" />
            <button class="btn small" @click="copyLink">{{ copied ? '已复制' : '复制' }}</button>
            <a class="btn small" :href="shareUrl()" target="_blank" rel="noopener">打开</a>
          </div>
          <div class="row" style="margin-top:10px">
            <button class="btn small danger" :disabled="shareBusy" @click="closeShare">关闭分享</button>
            <span class="grow" />
            <button class="btn small primary" :disabled="shareBusy" @click="createShare">
              {{ shareBusy ? '处理中…' : '更新链接设置' }}
            </button>
          </div>
        </div>
        <div v-else class="acts">
          <button class="btn" @click="shareOpen = false">取消</button>
          <button class="btn primary" :disabled="shareBusy" @click="createShare">
            {{ shareBusy ? '生成中…' : '生成分享链接' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.colorbtn { position: relative; padding: 0 5px; }
.colorbtn .cdot { width: 14px; height: 14px; border-radius: 4px; border: 1px solid rgba(0,0,0,.2); display: block; }
.colorbtn input[type="color"] { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; border: none; padding: 0; }
.bmpop {
  position: absolute; top: 34px; left: 0; z-index: 40; width: 260px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: var(--shadow); padding: 10px; max-height: 280px; overflow: auto;
  display: flex; flex-direction: column; gap: 5px;
}
.bmitem {
  display: flex; align-items: center; gap: 8px; text-align: left;
  background: var(--bg2); border: none; border-left: 3px solid; border-radius: 6px;
  padding: 6px 8px; font-size: 12.5px; color: var(--text);
}
.bmitem .muted { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
</style>
