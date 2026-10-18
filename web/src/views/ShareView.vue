<script setup>
import { onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import PdfViewer from '../components/PdfViewer.vue';
import { api, shareFileUrl, shareThumbUrl } from '../api.js';
import { cleanHtml, fmtTime } from '../util.js';

const props = defineProps({ token: { type: String, required: true } });

const data = ref(null);
const loading = ref(true);
const error = ref('');
const drawer = ref(false);
const pdfOpen = ref(false);
const dark = ref(document.documentElement.classList.contains('dark'));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.get('/pub/' + encodeURIComponent(props.token));
  } catch (e) {
    error.value = e.data && e.data.message ? e.data.message : '链接已失效或已关闭';
    data.value = null;
  } finally {
    loading.value = false;
  }
}

function toggleTheme() {
  dark.value = !dark.value;
  document.documentElement.classList.toggle('dark', dark.value);
}

onMounted(load);
watch(() => props.token, load);
</script>

<template>
  <div class="share-shell">
    <div class="share-top">
      <button v-if="data && data.with_book" class="icbtn" title="展开教材" @click="drawer = true">
        <Icon name="panel-left" :size="17" />
      </button>
      <Icon v-else name="book-open" :size="18" />
      <span class="t">{{ data ? data.title : '学习笔记' }}</span>
      <span v-if="data" class="chip">{{ data.with_book ? '含教材' : '仅笔记' }}</span>
      <span v-if="data && data.expires_at" class="chip">到期 {{ fmtTime(data.expires_at) }}</span>
      <button class="icbtn" :title="dark ? '白天模式' : '夜间模式'" @click="toggleTheme">
        <Icon :name="dark ? 'sun' : 'moon'" :size="17" />
      </button>
    </div>

    <div v-if="loading" class="empty-tip">正在打开…</div>
    <div v-else-if="error" class="empty-tip">
      <Icon name="x" :size="26" />
      <p>{{ error }}</p>
    </div>
    <template v-else-if="data">
      <div class="share-body">
        <div class="muted" style="font-size:12px;margin-bottom:14px">
          分享于 {{ fmtTime(data.updated_at) }} · 来自全科教材
        </div>
        <div class="report-body" v-html="cleanHtml(data.html)" />
        <div v-if="!data.html" class="empty-tip">这篇笔记还没有内容</div>
      </div>

      <div v-if="drawer" class="modal-mask" style="background:rgba(10,14,12,.35);justify-content:flex-start;padding:0" @click.self="drawer = false">
        <div class="share-drawer">
          <div class="row" style="margin-bottom:12px">
            <Icon name="book" :size="16" />
            <strong style="font-size:14px">教材</strong>
            <span class="grow" />
            <button class="icbtn" @click="drawer = false"><Icon name="x" :size="16" /></button>
          </div>
          <div style="border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg2)">
            <img :src="shareThumbUrl(token)" alt="教材封面" style="width:100%;display:block"
                 @error="$event.target.style.display='none'" />
          </div>
          <div style="margin:10px 0 6px;font-size:13px;color:var(--text2)">{{ data.book && data.book.title }}</div>
          <button class="btn primary" style="width:100%" @click="pdfOpen = true; drawer = false">
            <Icon name="book-open" :size="15" />打开教材
          </button>
          <div class="hint" style="margin-top:10px">教材由分享者附带，只读显示，批注不会显示在分享页。</div>
        </div>
      </div>

      <div v-if="pdfOpen" style="position:fixed;inset:0;z-index:150;background:var(--bg);display:flex;flex-direction:column">
        <PdfViewer :src="shareFileUrl(token)" :title="data.book && data.book.title" read-only show-close
                   @close="pdfOpen = false" />
      </div>
    </template>
  </div>
</template>
