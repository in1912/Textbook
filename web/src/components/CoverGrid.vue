<script setup>
import { nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { api, thumbUrl, fileUrl } from '../api.js';
import { isExerciseName } from '../util.js';

const props = defineProps({
  path: { type: String, default: '' },
  title: { type: String, default: '' },
  refreshNonce: { type: Number, default: 0 },
});
const emit = defineEmits(['open']);

const items = ref([]);
const loading = ref(false);
const error = ref('');
const truncated = ref(false);

async function load() {
  loading.value = true;
  error.value = '';
  items.value = [];
  try {
    const r = await api.get('/covers?path=' + encodeURIComponent(props.path || '') + '&limit=600');
    items.value = r.items || [];
    truncated.value = !!r.truncated;
    nextTick(prewarm);
  } catch (e) {
    error.value = e.data && e.data.error === 'no_root'
      ? '尚未设置教材根目录，请到「设置」选择。'
      : (e.message || '读取失败');
  } finally {
    loading.value = false;
  }
}

// The grid is the default view, so the first screenful of covers is fetched
// ahead of the user's scroll instead of waiting for <img loading=lazy>.
let prewarmRun = 0;
function prewarm() {
  const run = ++prewarmRun;
  const list = items.value.filter((x) => x.thumb).slice(0, 60);
  let i = 0;
  const step = () => {
    if (run !== prewarmRun) return;
    for (let k = 0; k < 6 && i < list.length; k++, i++) {
      const img = new Image();
      img.src = thumbUrl(list[i].path);
    }
    if (i < list.length) setTimeout(step, 120);
  };
  step();
}

watch(() => [props.path, props.refreshNonce], load, { immediate: true });

function open(item) { emit('open', item); }
</script>

<template>
  <section class="covers">
    <div class="covers-head">
      <h3>{{ title || '全部教材' }}</h3>
      <span class="chip">{{ items.length }} 本</span>
      <span v-if="truncated" class="chip">仅显示前 600 本</span>
      <span class="grow" />
      <span class="crumb">点击封面直接打开</span>
    </div>

    <div v-if="loading" class="empty-tip">正在读取目录…</div>
    <div v-else-if="error" class="empty-tip">{{ error }}</div>
    <div v-else-if="!items.length" class="empty-tip">
      这个目录及其子目录下没有可显示的教材。<br />
      可以到「设置」里勾选更多文件类型，或检查根目录是否选对。
    </div>
    <div v-else class="cover-grid">
      <div v-for="it in items" :key="it.path" class="cover" role="button" tabindex="0"
           @click="open(it)" @keydown.enter="open(it)">
        <div class="imgwrap">
          <img v-if="it.thumb" :src="thumbUrl(it.path)" :alt="it.title" loading="lazy" decoding="async" />
          <div v-else class="ph">
            <Icon name="book" :size="30" />
            <span>{{ it.title }}</span>
          </div>
          <a class="cover-dl" v-if="isExerciseName(it.title)" :href="fileUrl(it.path)" :download="it.name"
             title="下载打印" @click.stop>
            <Icon name="download" :size="14" />
          </a>
        </div>
        <div class="cap" :title="it.title">{{ it.title }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cover { position: relative; }
.cover-dl {
  position: absolute; right: 6px; bottom: 6px; width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center; border-radius: 7px;
  background: rgba(255, 255, 255, .9); color: #333; border: 1px solid rgba(0, 0, 0, .1);
  opacity: 0; transition: opacity .15s ease;
}
html.dark .cover-dl { background: rgba(28, 31, 36, .92); color: #e8e8e2; }
.cover:hover .cover-dl { opacity: 1; }
@media (hover: none) { .cover-dl { opacity: 1; } }
</style>
