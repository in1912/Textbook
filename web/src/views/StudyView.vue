<script setup>
import { computed, inject, onMounted, reactive, ref, watch } from 'vue';
import DirTree from '../components/DirTree.vue';
import CoverGrid from '../components/CoverGrid.vue';
import PdfViewer from '../components/PdfViewer.vue';
import NoteEditor from '../components/NoteEditor.vue';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { debounce } from '../util.js';

defineOptions({ name: 'StudyView' });

const state = inject('appState');
const settings = computed(() => state.settings || {});

const dirSel = reactive({ path: '', title: '全部教材' });
const lastState = reactive({ pdf: '', page: 1 });
const lastPdf = ref('');
const bookPath = ref('');
const bookTitle = ref('');
const initialPage = ref(1);
const bookmarks = ref([]);
const notesVisible = ref(false);
const dirOpen = ref(false);
const dirCollapsed = ref(false);
const refreshNonce = ref(0);
const pdfRef = ref(null);
const started = ref(false);
const narrow = () => window.matchMedia('(max-width: 1100px)').matches;

async function init() {
  if (started.value) return;
  started.value = true;
  try {
    const last = await api.get('/last');
    lastState.pdf = last.pdf || '';
    lastState.page = Number(last.page) || 1;
  } catch { /* first run */ }
  lastPdf.value = lastState.pdf;
  if (lastState.pdf) {
    const parts = lastState.pdf.split('/');
    parts.pop();
    dirSel.path = parts.join('/');
    dirSel.title = parts.length ? parts[parts.length - 1] : '全部教材';
  }
}

onMounted(init);
watch(() => state.settings, (s) => { if (s) init(); }, { immediate: true });
watch(() => state.reloadKey, () => {
  refreshNonce.value++;
  if (lastState.pdf && bookPath.value === lastState.pdf) {
    initialPage.value = lastState.page || 1;
  }
});

function onSelectDir(node) {
  closeBook();
  dirSel.path = node.path;
  dirSel.title = node.name;
  if (narrow()) dirOpen.value = false;
}

function onOpenFile(node) {
  if (narrow()) dirOpen.value = false;
  openBook(node);
}

function openBook(node) {
  initialPage.value = (lastState.pdf === node.path ? lastState.page : 1) || 1;
  bookTitle.value = node.title || String(node.name || '').replace(/\.pdf$/i, '');
  bookPath.value = node.path;
  notesVisible.value = true;
  state.book = { path: node.path, title: bookTitle.value, page: initialPage.value };
  loadBookmarks();
  saveLast(node.path, initialPage.value);
  const parts = node.path.split('/');
  parts.pop();
  if (!dirSel.path) { dirSel.path = parts.join('/'); dirSel.title = parts[parts.length - 1] || ''; }
}

function closeBook() {
  bookPath.value = '';
  bookTitle.value = '';
  bookmarks.value = [];
  notesVisible.value = false;
  state.book = { path: '', title: '', page: 1 };
}

const onPage = debounce((p) => {
  if (!bookPath.value) return;
  state.book.page = p;
  saveLast(bookPath.value, p);
}, 700);

const saveLast = debounce((pdf, page) => {
  if (!pdf) return;
  api.put('/last', { pdf, page: Number(page) || 1 }).catch(() => {});
  lastState.pdf = pdf;
  lastState.page = Number(page) || 1;
}, 600);

async function loadBookmarks() {
  if (!bookPath.value) return;
  try {
    const r = await api.get('/bookmarks?path=' + encodeURIComponent(bookPath.value));
    bookmarks.value = r.items || [];
  } catch { bookmarks.value = []; }
}

async function addBookmark(b) {
  if (!bookPath.value) return;
  try {
    await api.post('/bookmarks', { path: bookPath.value, page: b.page, label: b.label, color: b.color });
    await loadBookmarks();
  } catch { /* surfaced by the empty list */ }
}

async function deleteBookmark(b) {
  try {
    await api.del('/bookmarks/' + encodeURIComponent(b.id));
    await loadBookmarks();
  } catch { /* keep the old list */ }
}

function gotoBookmark(b) {
  if (pdfRef.value) pdfRef.value.gotoPage(b.page);
}

function toggleNotes() {
  notesVisible.value = !notesVisible.value;
}

function closeDrawers() {
  dirOpen.value = false;
  notesVisible.value = false;
}

function gotoPageFromNote(n) {
  if (pdfRef.value) pdfRef.value.gotoPage(n);
}
</script>

<template>
  <div class="study" :class="{ 'notes-open': bookPath && notesVisible, 'dir-open': dirOpen, 'dir-collapsed': dirCollapsed }">
    <div class="drawer-mask" @click="closeDrawers" />

    <DirTree
      :last-pdf="lastPdf"
      :default-expand="settings.default_expand || []"
      :show54="!!settings.show54"
      :selected="dirSel.path"
      :refresh-nonce="refreshNonce"
      @select-dir="onSelectDir"
      @open-file="onOpenFile"
      @close="dirOpen = false"
      @collapse="dirCollapsed = true"
    />

    <div class="bookcol">
      <PdfViewer
        v-if="bookPath"
        ref="pdfRef"
        :path="bookPath"
        :title="bookTitle"
        :initial-page="initialPage"
        :bookmarks="bookmarks"
        show-close
        @close="closeBook"
        @page="onPage"
        @add-bookmark="addBookmark"
        @goto-bookmark="gotoBookmark"
        @delete-bookmark="deleteBookmark"
        @toggle-notes="toggleNotes"
      />
      <CoverGrid
        v-else
        :path="dirSel.path"
        :title="dirSel.title"
        :refresh-nonce="refreshNonce"
        @open="openBook"
      />

      <button class="icbtn mob-btn left mobile-only" title="展开目录" @click="dirOpen = true">
        <Icon name="panel-left" :size="18" />
      </button>
      <button v-if="bookPath && !notesVisible" class="icbtn mob-btn right mobile-only"
              title="展开笔记" @click="notesVisible = true">
        <Icon name="panel-right" :size="18" />
      </button>
      <button v-if="bookPath && !notesVisible" class="edge-btn" title="展开笔记" @click="notesVisible = true">
        笔记
      </button>
      <button v-if="dirCollapsed" class="edge-btn left" title="展开目录" @click="dirCollapsed = false">
        目录
      </button>
    </div>

    <div class="notecol">
      <NoteEditor
        :path="bookPath"
        :title="bookTitle"
        :page="state.book.page"
        :bookmarks="bookmarks"
        @goto-page="gotoPageFromNote"
        @collapse="notesVisible = false"
      />
    </div>

    <div v-if="state.settings && !settings.root" class="modal-mask" style="background:transparent;pointer-events:none">
      <div class="notice warn" style="pointer-events:auto;max-width:420px">
        还没有设置教材根目录。请点顶部「设置」选择目录，例如 D:\CC\Textbook\book。
      </div>
    </div>
  </div>
</template>
