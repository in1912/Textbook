<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { fmtNum, fmtTime, mdToHtml } from '../util.js';

const state = inject('appState');
const settings = computed(() => state.settings || {});
const reports = ref([]);
const usage = ref(null);
const current = ref(null);
const busy = ref(false);
const error = ref('');
const elapsed = ref(0);
let timer = null;

async function loadReports() {
  try {
    const r = await api.get('/ai/reports?limit=50');
    reports.value = r.items || [];
  } catch { reports.value = []; }
}
async function loadUsage() {
  try { usage.value = await api.get('/ai/usage'); } catch { usage.value = null; }
}

onMounted(() => { loadReports(); loadUsage(); });

function startTimer() {
  elapsed.value = 0;
  clearInterval(timer);
  timer = setInterval(() => { elapsed.value += 1; }, 1000);
}
function stopTimer() { clearInterval(timer); timer = null; }

async function analyze(scope) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  current.value = null;
  startTimer();
  try {
    const body = { scope };
    if (scope === 'pdf') body.path = state.book.path;
    const r = await api.post('/ai/analyze', body);
    current.value = { id: r.id, content: r.content, tokens: r.tokens, model: r.model, created_at: null };
    await Promise.all([loadReports(), loadUsage()]);
  } catch (e) {
    error.value = e.message || '分析失败';
  } finally {
    stopTimer();
    busy.value = false;
  }
}

async function openReport(item) {
  error.value = '';
  try {
    const r = await api.get('/ai/report/' + item.id);
    current.value = r;
  } catch (e) { error.value = e.message || '读取失败'; }
}

async function removeReport(item) {
  if (!window.confirm('删除这份分析报告？')) return;
  try {
    await api.del('/ai/report/' + item.id);
    if (current.value && current.value.id === item.id) current.value = null;
    await loadReports();
  } catch (e) { error.value = e.message || '删除失败'; }
}

const profileText = computed(() => {
  const s = settings.value;
  const bits = [
    s.student_name ? `学生：${s.student_name}` : '',
    s.grade ? `年级：${s.grade}` : '',
    s.academic_year ? `学年：${s.academic_year}` : '',
    s.intro ? `备注：${s.intro}` : '',
  ].filter(Boolean);
  return bits.join(' · ') || '还没有填写学生信息，可以到「设置」补充，分析会更准确。';
});
</script>

<template>
  <div class="panel">
    <div class="panel-inner">
      <div class="row wrap" style="margin-bottom:12px">
        <h2 style="margin:0;font-size:18px">AI 学习分析</h2>
        <span class="grow" />
        <span v-if="usage" class="chip">累计 {{ fmtNum(usage.total_tokens) }} tokens · {{ usage.calls }} 次</span>
      </div>

      <div class="card">
        <h3>分析依据</h3>
        <div class="notice">{{ profileText }}</div>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn primary" :disabled="busy" @click="analyze('all')">
            <Icon name="sparkles" :size="15" />分析我的全部笔记
          </button>
          <button class="btn" :disabled="busy || !state.book.path" @click="analyze('pdf')">
            <Icon name="book" :size="15" />只分析当前教材
          </button>
          <span v-if="state.book.path" class="muted" style="font-size:12.5px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            当前：{{ state.book.title }}
          </span>
        </div>
        <div v-if="busy" class="hint" style="margin-top:10px">
          正在分析…已等待 {{ elapsed }} 秒。模型分析整本笔记通常需要几十秒，请不要关闭页面。
        </div>
        <div v-if="error" class="notice err" style="margin-top:10px">{{ error }}</div>
      </div>

      <div v-if="current" class="card">
        <div class="row" style="margin-bottom:8px">
          <h3 style="margin:0">分析报告</h3>
          <span class="grow" />
          <span v-if="current.tokens" class="chip">{{ fmtNum(current.tokens) }} tokens</span>
          <span v-if="current.created_at" class="chip">{{ fmtTime(current.created_at) }}</span>
        </div>
        <div class="report-body" v-html="mdToHtml(current.content)" />
      </div>

      <div class="card">
        <div class="row" style="margin-bottom:10px">
          <h3 style="margin:0">历史分析</h3>
          <span class="grow" />
          <button class="icbtn" title="刷新" @click="loadReports"><Icon name="refresh" :size="15" /></button>
        </div>
        <div v-if="!reports.length" class="muted" style="font-size:13px">还没有分析记录。跑一次分析后会保存在这里。</div>
        <table v-else class="list">
          <thead>
            <tr><th style="width:130px">时间</th><th>摘要</th><th style="width:90px">范围</th><th style="width:80px">tokens</th><th style="width:50px"></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in reports" :key="r.id" style="cursor:pointer" @click="openReport(r)">
              <td class="mono muted">{{ fmtTime(r.created_at) }}</td>
              <td class="preview">{{ r.preview }}</td>
              <td class="muted">{{ r.scope === 'pdf' ? '单本' : '全部' }}</td>
              <td class="mono">{{ fmtNum(r.tokens) }}</td>
              <td>
                <button class="icbtn" title="删除" @click.stop="removeReport(r)">
                  <Icon name="trash" :size="14" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="notice">
        AI 分析会读取你最近更新的笔记正文（最多 20 篇）和学生信息，输出掌握情况与学习建议。报告只保存在你的账号下。
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview {
  max-width: 560px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text2);
}
</style>
