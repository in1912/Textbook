<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import ColorPicker from './ColorPicker.vue';

const props = defineProps({
  tool: { type: String, default: 'select' },
  color: { type: String, default: '#e11d48' },
  width: { type: Number, default: 2 },
  alpha: { type: Number, default: 1 },
  page: { type: Number, default: 1 },
  pages: { type: Number, default: 0 },
  bookmarks: { type: Array, default: () => [] },
  canUndo: { type: Boolean, default: false },
  canRedo: { type: Boolean, default: false },
});
const emit = defineEmits([
  'update:tool', 'update:color', 'update:alpha', 'goto-page', 'undo', 'redo',
  'add-bookmark', 'goto-bookmark', 'delete-bookmark',
]);

const TOOLS = [
  { k: 'select', icon: 'text', label: '选择/复制文字' },
  { k: 'pencil', icon: 'pencil', label: '铅笔' },
  { k: 'ballpoint', icon: 'pen', label: '圆珠笔' },
  { k: 'crayon', icon: 'crayon', label: '蜡笔' },
  { k: 'marker', icon: 'marker', label: '马克笔' },
  { k: 'highlighter', icon: 'highlighter', label: '浅色记号笔（盖住字也看得见）' },
  { k: 'line', icon: 'line', label: '直线' },
  { k: 'circle', icon: 'circle', label: '圈选' },
  { k: 'eraser', icon: 'eraser', label: '橡皮' },
];

const pageInput = ref('');
watch(() => props.page, (p) => { pageInput.value = String(p || 1); }, { immediate: true });

const colorOpen = ref(false);
const bmOpen = ref(false);
const bmLabel = ref('');
const bmColor = ref('#f59e0b');
const BM_COLORS = ['#f59e0b', '#ef4444', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899'];
const barEl = ref(null);

function setTool(k) {
  emit('update:tool', k);
  if (k === 'select' || k === 'eraser') { colorOpen.value = false; }
}
function gotoPage(v) {
  const n = Math.max(1, Math.min(props.pages || 1, Math.floor(Number(v) || 1)));
  pageInput.value = String(n);
  emit('goto-page', n);
}
function onPageInput() {
  gotoPage(pageInput.value);
}
function step(d) { gotoPage((props.page || 1) + d); }

function addBookmark() {
  const label = String(bmLabel.value || '').trim() || `第 ${props.page} 页`;
  emit('add-bookmark', { page: props.page, label, color: bmColor.value });
  bmLabel.value = '';
}

// The bar scrolls horizontally on narrow screens (overflow:auto), which would
// clip a popover laid out above it. Teleport the popovers to <body> and anchor
// them to the bar with fixed coordinates instead.
const popStyle = ref({});
const popOpen = computed(() => colorOpen.value || bmOpen.value);
function placePopover() {
  const el = barEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 20);
  const left = Math.max(10, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 10));
  popStyle.value = {
    position: 'fixed',
    left: left + 'px',
    bottom: (window.innerHeight - r.top + 8) + 'px',
    width: width + 'px',
    transform: 'none',
  };
}
function onViewportChange() { if (popOpen.value) placePopover(); }

function onDocDown(e) {
  if (!barEl.value) return;
  const inBar = barEl.value.contains(e.target);
  const inPop = e.target && e.target.closest && e.target.closest('.popover');
  if (!inBar && !inPop) { colorOpen.value = false; bmOpen.value = false; }
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocDown, true);
  window.addEventListener('resize', onViewportChange);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true);
  window.removeEventListener('resize', onViewportChange);
});
watch(popOpen, (v) => { if (v) nextTick(placePopover); });

function toggleColor() { colorOpen.value = !colorOpen.value; bmOpen.value = false; placePopover(); }
function toggleBm() { bmOpen.value = !bmOpen.value; colorOpen.value = false; placePopover(); }
</script>

<template>
  <div class="brushbar" ref="barEl" @pointerdown.stop>
    <button v-for="t in TOOLS" :key="t.k" class="icbtn hide-sm" :class="{ on: tool === t.k }"
            :title="t.label" @click="setTool(t.k)">
      <Icon :name="t.icon" :size="17" />
    </button>

    <span class="sep" />
    <button class="icbtn" title="颜色与透明度" @click="toggleColor">
      <span class="swatch-dot" :style="{ background: color }" />
    </button>
    <button class="icbtn" title="撤销" :disabled="!canUndo" @click="$emit('undo')">
      <Icon name="undo" :size="17" />
    </button>
    <button class="icbtn hide-sm" title="重做" :disabled="!canRedo" @click="$emit('redo')">
      <Icon name="redo" :size="17" />
    </button>

    <span class="sep" />
    <button class="icbtn" :disabled="page <= 1" title="上一页" @click="step(-1)">
      <Icon name="chevron-left" :size="16" />
    </button>
    <input class="pagein" type="number" min="1" :max="pages || 1" :value="pageInput"
           @change="onPageInput" @keydown.enter="onPageInput" aria-label="页码" />
    <span class="muted" style="font-size:11.5px;white-space:nowrap">/ {{ pages || '-' }}</span>
    <button class="icbtn" :disabled="!pages || page >= pages" title="下一页" @click="step(1)">
      <Icon name="chevron-right" :size="16" />
    </button>

    <span class="sep" />
    <button class="icbtn" :class="{ on: bmOpen }" title="书签" @click="toggleBm">
      <Icon name="bookmark" :size="17" />
      <span v-if="bookmarks.length" style="font-size:11px">{{ bookmarks.length }}</span>
    </button>

    <Teleport to="body">
      <div v-if="colorOpen" class="popover" :style="popStyle" @mousedown.stop>
        <ColorPicker :model-value="color" :alpha="alpha" :width="width"
                     @update:model-value="$emit('update:color', $event)"
                     @update:alpha="$emit('update:alpha', $event)" />
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="bmOpen" class="popover bmpop" :style="popStyle" @mousedown.stop>
      <div class="row" style="margin-bottom:8px">
        <Icon name="bookmark" :size="15" />
        <strong style="font-size:12.5px">书签</strong>
        <span class="grow" />
        <span class="muted" style="font-size:11.5px">当前第 {{ page }} 页</span>
      </div>
      <div class="bmform">
        <input v-model="bmLabel" type="text" placeholder="给这一页写个提示（可空）" maxlength="200"
               @keydown.enter="addBookmark" />
        <div class="row" style="margin-top:6px">
          <button v-for="c in BM_COLORS" :key="c" class="quick" :style="{ background: c }"
                  :class="{ on: bmColor === c }" @click="bmColor = c" />
          <span class="grow" />
          <button class="btn small primary" @click="addBookmark">
            <Icon name="plus" :size="13" /> 加到第 {{ page }} 页
          </button>
        </div>
      </div>
      <div v-if="bookmarks.length" class="bmlist">
        <div v-for="b in bookmarks" :key="b.id" class="bmrow" :style="{ borderLeftColor: b.color }"
             @click="$emit('goto-bookmark', b)">
          <div class="bmtext">
            <div class="bmlabel">{{ b.label || '未命名书签' }}</div>
            <div class="muted" style="font-size:11px">第 {{ b.page }} 页</div>
          </div>
          <button class="icbtn" title="删除书签" @click.stop="$emit('delete-bookmark', b)">
            <Icon name="trash" :size="14" />
          </button>
        </div>
      </div>
      <div v-else class="muted" style="font-size:12px;padding:8px 2px">还没有书签。书签会显示成彩色卡片，也可以插入到右侧笔记里。</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.quick { width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(0,0,0,.15); padding: 0; }
.quick.on { outline: 2px solid var(--accent); outline-offset: 1px; }
.bmpop { width: 310px; }
.bmform input { width: 100%; height: 30px; }
.bmlist { margin-top: 8px; max-height: 220px; overflow: auto; display: flex; flex-direction: column; gap: 5px; }
.bmrow {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer;
  border-left: 3px solid; border-radius: 6px; background: var(--bg2);
}
.bmrow:hover { background: var(--panel2); }
.bmtext { flex: 1; min-width: 0; }
.bmlabel { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
