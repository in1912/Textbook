<script setup>
import { computed, inject } from 'vue';
import Icon from './Icon.vue';

defineOptions({ name: 'TreeNode' });

const props = defineProps({
  node: { type: Object, required: true },
  level: { type: Number, default: 0 },
});
const ctx = inject('treeCtx');

const isDir = computed(() => props.node.type === 'dir');
const opened = computed(() => ctx.open.has(props.node.path));

const kids = computed(() => ctx.nodes[props.node.path] || []);
const otherPath = computed(() => props.node.path + '\u0000other');

// Publisher level: 人教版/统编版 stay visible and the rest collapse into one
// "其他版本" row the user can open.
const shown = computed(() => {
  const list = kids.value;
  if (!isDir.value || !list.length) return [];
  const hasGroups = list.some((n) => n.group === 'other');
  if (!hasGroups) return list.map((n) => ({ node: n }));
  const others = list.filter((n) => n.group === 'other');
  const people = list.filter((n) => n.group !== 'other');
  if (!others.length || ctx.otherOpen.has(props.node.path)) {
    if (!ctx.otherOpen.has(props.node.path)) return people.map((n) => ({ node: n }));
    return list.map((n) => ({ node: n }));
  }
  return [
    ...people.map((n) => ({ node: n })),
    { synthetic: true, key: otherPath.value, count: others.length },
  ];
});

// Clicking a folder shows its covers and opens it; only the chevron collapses
// it. Otherwise a folder that boot() auto-expanded would close on first click.
function rowClick() {
  if (!isDir.value) { ctx.openFile(props.node); return; }
  ctx.selectDir(props.node);
  if (!opened.value) ctx.toggleOpen(props.node.path);
}
function arrowClick() {
  if (isDir.value) ctx.toggleOpen(props.node.path);
}
function toggleOther() {
  if (ctx.otherOpen.has(props.node.path)) ctx.otherOpen.delete(props.node.path);
  else ctx.otherOpen.add(props.node.path);
}
</script>

<template>
  <div class="tree-node">
    <div class="tree-row" :class="{ sel: ctx.selected === node.path, 'tree-leaf': !isDir }"
         :style="{ paddingLeft: 4 + level * 14 + 'px' }"
         :title="node.name" @click="rowClick">
      <span class="tw" :class="{ leaf: !isDir }" @click.stop="arrowClick">
        <Icon v-if="isDir" :name="opened ? 'chevron-down' : 'chevron-right'" :size="13" />
      </span>
      <Icon :name="isDir ? (opened ? 'folder-open' : 'folder') : 'file'" :size="15" />
      <span class="nm">{{ node.title || node.name }}</span>
      <span v-if="isDir" class="ct">{{ node.pdf_count }}</span>
    </div>

    <template v-if="isDir && opened">
      <div v-if="ctx.loading[node.path]" class="tree-empty" :style="{ paddingLeft: 28 + level * 14 + 'px' }">载入中…</div>
      <div v-else-if="ctx.errs[node.path]" class="tree-empty" :style="{ paddingLeft: 28 + level * 14 + 'px' }">{{ ctx.errs[node.path] }}</div>
      <template v-for="it in shown" :key="it.key || it.node.path">
        <div v-if="it.synthetic" class="tree-row group-head" :style="{ paddingLeft: 8 + (level + 1) * 14 + 'px' }" @click="toggleOther">
          <span class="tw"><Icon name="chevron-right" :size="13" /></span>
          <Icon name="folder" :size="15" />
          <span class="nm">其他版本</span>
          <span class="ct">{{ it.count }}</span>
        </div>
        <TreeNode v-else :node="it.node" :level="level + 1" />
      </template>
      <div v-if="opened && !kids.length && !ctx.loading[node.path]" class="tree-empty"
           :style="{ paddingLeft: 28 + level * 14 + 'px' }">此文件夹下没有可显示的教材</div>
    </template>
  </div>
</template>
