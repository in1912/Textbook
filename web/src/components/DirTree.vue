<script setup>
import { computed, onMounted, provide, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import TreeNode from './TreeNode.vue';
import { api } from '../api.js';

defineOptions({ name: 'DirTree' });

const props = defineProps({
  lastPdf: { type: String, default: '' },
  defaultExpand: { type: Array, default: () => [] },
  show54: { type: Boolean, default: false },
  selected: { type: String, default: '' },
  refreshNonce: { type: Number, default: 0 },
});
const emit = defineEmits(['select-dir', 'open-file', 'loaded', 'error', 'close', 'collapse']);

const nodes = reactive({});
const loading = reactive({});
const errs = reactive({});
const open = reactive(new Set());
const otherOpen = reactive(new Set());
const loaded = ref(false);
const rootError = ref('');

const rootNodes = computed(() => (nodes[''] || []).filter((n) => !(n.stage54 && !props.show54)));

const ctx = {
  nodes, loading, errs, open, otherOpen,
  selected: computed(() => props.selected),
  selectDir: (node) => emit('select-dir', node),
  openFile: (node) => emit('open-file', node),
  toggleOpen,
};
provide('treeCtx', ctx);

async function load(path, force = false) {
  if (!force && nodes[path]) return;
  loading[path] = true;
  errs[path] = '';
  try {
    const d = await api.get('/tree?path=' + encodeURIComponent(path));
    nodes[path] = d.nodes || [];
    if (path === '') rootError.value = '';
  } catch (e) {
    const msg = e.data && e.data.error === 'no_root' ? '尚未设置教材根目录，请到「设置」选择。'
      : (e.message || '目录载入失败');
    errs[path] = msg;
    if (path === '') { rootError.value = msg; emit('error', msg); }
  } finally {
    loading[path] = false;
  }
}

async function ensureOpen(path) {
  open.add(path);
  await load(path);
}
async function toggleOpen(path) {
  if (open.has(path)) { open.delete(path); return; }
  await ensureOpen(path);
}

// Expand down to the folder of the last opened PDF. The PDFs themselves are
// leaves, so only the intermediate folders are opened.
async function expandTo(rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  if (parts.length < 2) return;
  for (let i = 1; i < parts.length; i++) {
    await ensureOpen(parts.slice(0, i).join('/'));
  }
}

async function expandDefaults() {
  const list = Array.isArray(props.defaultExpand) ? props.defaultExpand : [];
  const roots = nodes[''] || [];
  for (const item of list) {
    const key = String(item || '').trim();
    if (!key) continue;
    if (roots.some((n) => n.path === key)) await ensureOpen(key);
    else {
      const hit = roots.find((n) => n.name === key || n.title === key);
      if (hit) await ensureOpen(hit.path);
    }
  }
}

async function boot() {
  open.clear();
  otherOpen.clear();
  Object.keys(nodes).forEach((k) => { delete nodes[k]; });
  rootError.value = '';
  loaded.value = false;
  await load('', true);
  loaded.value = true;
  await expandDefaults();
  if (props.lastPdf) await expandTo(props.lastPdf);
  emit('loaded');
}

async function refresh() {
  try { await api.post('/refresh'); } catch { /* still reload below */ }
  await boot();
}

onMounted(boot);
watch(() => props.refreshNonce, boot);
watch(() => props.lastPdf, (v) => { if (v) expandTo(v); });

defineExpose({ refresh, boot });
</script>

<template>
  <aside class="dircol">
    <div class="dircol-head">
      <Icon name="folder-open" :size="15" />
      <span>目录</span>
      <span class="grow" />
      <button class="icbtn" title="刷新目录" @click="refresh"><Icon name="refresh" :size="15" /></button>
      <button class="icbtn desktop-only" title="收起目录" @click="$emit('collapse')">
        <Icon name="panel-left" :size="15" />
      </button>
      <button class="icbtn mobile-only" title="收起目录" @click="$emit('close')"><Icon name="x" :size="15" /></button>
    </div>
    <div class="dirbody">
      <div v-if="rootError" class="tree-empty">{{ rootError }}</div>
      <template v-else>
        <TreeNode v-for="n in rootNodes" :key="n.path" :node="n" :level="0" />
        <div v-if="loaded && !rootNodes.length" class="tree-empty">
          根目录下没有找到 PDF 教材。可以点右上角刷新，或到「设置」检查目录与文件类型。
        </div>
      </template>
    </div>
  </aside>
</template>
