<script setup>
import { computed, inject, onMounted, reactive, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { BASE_PREFIX, api, token } from '../api.js';

const state = inject('appState');

const form = reactive({
  root: '',
  student_name: '',
  grade: '',
  academic_year: '',
  intro: '',
  exts: ['.pdf'],
  show54: false,
  default_expand: [],
});
const exts = computed(() => state.optionalExts || []);
const saving = ref(false);
const msg = ref('');
const err = ref('');
const rootNodes = ref([]);

const caps = ref({ ai_config: false, manage_users: false, admin: false });
const ai = reactive({ base_url: '', model: '', api_key: '', has_key: false, key_hint: '' });
const aiSaving = ref(false);
const aiMsg = ref('');
const aiErr = ref('');
const aiTesting = ref(false);

// directory picker
const browseOpen = ref(false);
const bpath = ref('');
const bparent = ref(null);
const bdirs = ref([]);
const bmanual = ref('');
const bBusy = ref(false);
const bErr = ref('');

function fill() {
  const s = state.settings || {};
  form.root = s.root || '';
  form.student_name = s.student_name || '';
  form.grade = s.grade || '';
  form.academic_year = s.academic_year || '';
  form.intro = s.intro || '';
  form.exts = Array.isArray(s.exts) && s.exts.length ? s.exts.slice() : ['.pdf'];
  form.show54 = !!s.show54;
  form.default_expand = Array.isArray(s.default_expand) ? s.default_expand.slice() : [];
}
watch(() => state.settings, fill, { immediate: true });

async function loadRootNodes() {
  try {
    const d = await api.get('/tree?path=');
    rootNodes.value = (d.nodes || []).map((n) => ({ path: n.path, name: n.name }));
  } catch { rootNodes.value = []; }
}
onMounted(async () => {
  loadRootNodes();
  try {
    caps.value = await api.get('/capabilities');
    if (caps.value.ai_config) await loadAi();
  } catch { /* embedded copy has no standalone endpoints */ }
});

function toggleExt(e) {
  const i = form.exts.indexOf(e);
  if (i >= 0) form.exts.splice(i, 1);
  else form.exts.push(e);
}
function toggleExpand(p) {
  const i = form.default_expand.indexOf(p);
  if (i >= 0) form.default_expand.splice(i, 1);
  else form.default_expand.push(p);
}

async function save() {
  saving.value = true;
  msg.value = ''; err.value = '';
  try {
    await api.put('/settings', {
      root: form.root.trim(),
      student_name: form.student_name,
      grade: form.grade,
      academic_year: form.academic_year,
      intro: form.intro,
      exts: form.exts,
      show54: form.show54,
      default_expand: form.default_expand,
    });
    msg.value = '已保存';
    state.reloadKey++;
    setTimeout(() => { msg.value = ''; }, 2600);
  } catch (e) {
    err.value = e.message || '保存失败';
  } finally {
    saving.value = false;
  }
}

// ---- directory picker ------------------------------------------------------
async function openBrowse() {
  browseOpen.value = true;
  bErr.value = '';
  bmanual.value = form.root || '';
  await browse('');
}
async function browse(path) {
  bBusy.value = true; bErr.value = '';
  try {
    const r = await api.get('/browse?path=' + encodeURIComponent(path));
    bpath.value = r.path || '';
    bparent.value = r.parent || null;
    bdirs.value = r.dirs || [];
  } catch (e) {
    bErr.value = e.message || '无法读取目录';
  } finally {
    bBusy.value = false;
  }
}
async function browseManual() {
  const p = bmanual.value.trim();
  if (!p) return;
  await browse(p);
}
function chooseDir(d) { browse(d.path); }
function pickCurrent() {
  if (!bpath.value) return;
  form.root = bpath.value;
  browseOpen.value = false;
}

// ---- standalone AI config --------------------------------------------------
async function adminFetch(path, opts = {}) {
  const t = token();
  const url = BASE_PREFIX + '/api/admin' + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string') {
    init.body = JSON.stringify(opts.body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    e.status = res.status;
    throw e;
  }
  return data;
}

async function loadAi() {
  try {
    const r = await adminFetch('/ai');
    ai.base_url = r.base_url || '';
    ai.model = r.model || '';
    ai.has_key = !!r.has_key;
    ai.key_hint = r.key_hint || '';
  } catch { /* not configured yet */ }
}
async function saveAi() {
  aiSaving.value = true; aiMsg.value = ''; aiErr.value = '';
  try {
    const body = { base_url: ai.base_url.trim(), model: ai.model.trim() };
    if (ai.api_key) body.api_key = ai.api_key;
    const r = await adminFetch('/ai', { method: 'PUT', body });
    ai.has_key = !!r.has_key;
    ai.key_hint = r.key_hint || '';
    ai.api_key = '';
    aiMsg.value = '已保存';
    setTimeout(() => { aiMsg.value = ''; }, 2600);
  } catch (e) {
    aiErr.value = e.message || '保存失败';
  } finally {
    aiSaving.value = false;
  }
}
async function testAi() {
  aiTesting.value = true; aiMsg.value = ''; aiErr.value = '';
  try {
    const r = await adminFetch('/ai/test', { method: 'POST' });
    aiMsg.value = `连接成功${r.model ? '：' + r.model : ''}${r.ms ? '（' + r.ms + 'ms）' : ''}`;
  } catch (e) {
    aiErr.value = e.message || '连接失败';
  } finally {
    aiTesting.value = false;
  }
}
</script>

<template>
  <div class="panel">
    <div class="panel-inner">
      <div class="row" style="margin-bottom:14px">
        <h2 style="margin:0;font-size:18px">设置</h2>
        <span class="grow" />
        <span v-if="msg" class="chip" style="color:var(--accent)">{{ msg }}</span>
        <span v-if="err" class="chip" style="color:var(--danger)">{{ err }}</span>
        <button class="btn primary" :disabled="saving" @click="save">
          <Icon name="check" :size="15" />{{ saving ? '保存中…' : '保存设置' }}
        </button>
      </div>

      <div class="card">
        <h3>教材根目录</h3>
        <div class="row wrap">
          <input type="text" v-model="form.root" placeholder="例如 D:\CC\Textbook\book" style="flex:1;min-width:260px" />
          <button class="btn" @click="openBrowse"><Icon name="folder-open" :size="15" />浏览…</button>
        </div>
        <div class="hint">
          PDF 及所选类型的文件都从这个目录向下查找。Docker 部署时填容器内挂载的路径（例如 <code>/books</code>）。
          <span v-if="state.defaultRoot"> 默认目录：<code>{{ state.defaultRoot }}</code></span>
        </div>
      </div>

      <div class="card">
        <h3>学生信息</h3>
        <div class="grid2">
          <label class="field">学生姓名
            <input type="text" v-model="form.student_name" maxlength="60" placeholder="用于 AI 分析" />
          </label>
          <label class="field">当前年级
            <input type="text" v-model="form.grade" maxlength="60" placeholder="例如 三年级 / 高一" />
          </label>
          <label class="field">默认学年
            <input type="text" v-model="form.academic_year" maxlength="40" placeholder="例如 2026-2027 学年" />
          </label>
        </div>
        <label class="field" style="margin-top:12px">基本情况 / 备注
          <textarea v-model="form.intro" rows="4" maxlength="5000"
                    placeholder="学习习惯、薄弱科目、目标等，AI 分析时会参考这些信息"></textarea>
        </label>
      </div>

      <div class="card">
        <h3>目录显示</h3>
        <div class="hint" style="margin-top:0;margin-bottom:10px">默认只显示 PDF。勾选后，这些类型的文件也会出现在目录里。</div>
        <div class="row wrap" style="gap:14px">
          <label v-for="e in exts" :key="e" class="row" style="gap:6px;font-size:13px">
            <input type="checkbox" :checked="form.exts.includes(e)" @change="toggleExt(e)" />
            <span>{{ e.replace('.', '').toUpperCase() }}</span>
          </label>
        </div>
        <label class="row" style="gap:8px;margin-top:14px;font-size:13px">
          <input type="checkbox" v-model="form.show54" />
          <span>显示「五四学制」目录（默认隐藏）</span>
        </label>
        <div v-if="rootNodes.length" style="margin-top:14px">
          <div class="muted" style="font-size:12.5px;margin-bottom:6px">默认展开的学段目录</div>
          <div class="row wrap" style="gap:12px">
            <label v-for="n in rootNodes" :key="n.path" class="row" style="gap:6px;font-size:13px">
              <input type="checkbox" :checked="form.default_expand.includes(n.path)" @change="toggleExpand(n.path)" />
              <span>{{ n.name }}</span>
            </label>
          </div>
        </div>
      </div>

      <div v-if="caps.ai_config" class="card">
        <h3>AI 配置</h3>
        <div class="hint" style="margin-top:0">
          用于「AI分析」的学习报告。兼容 OpenAI 格式的接口，例如 <code>https://api.example.com/v1</code>。
          密钥只保存在本机数据库里，页面不会回显明文。
        </div>
        <div class="grid2" style="margin-top:12px">
          <label class="field">接口地址（Base URL）
            <input type="text" v-model="ai.base_url" placeholder="https://api.example.com/v1" />
          </label>
          <label class="field">模型名称
            <input type="text" v-model="ai.model" placeholder="例如 gpt-4o-mini / deepseek-chat" />
          </label>
          <label class="field">API Key
            <input type="password" v-model="ai.api_key"
                   :placeholder="ai.has_key ? '已保存 ' + ai.key_hint + '，留空则不修改' : 'sk-…'" />
          </label>
        </div>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn primary" :disabled="aiSaving" @click="saveAi">
            <Icon name="check" :size="15" />{{ aiSaving ? '保存中…' : '保存 AI 配置' }}
          </button>
          <button class="btn" :disabled="aiTesting" @click="testAi">
            <Icon name="refresh" :size="15" />{{ aiTesting ? '测试中…' : '测试连接' }}
          </button>
          <span v-if="aiMsg" class="chip" style="color:var(--accent)">{{ aiMsg }}</span>
          <span v-if="aiErr" class="chip" style="color:var(--danger)">{{ aiErr }}</span>
        </div>
      </div>

      <div class="notice">
        目录排序按 小学 → 初中 → 高中 → 大学、数学/语文/英语优先、人教版优先；同一版本下按年级与上册/中册/下册排列，习题类排在最后。
      </div>
    </div>

    <div v-if="browseOpen" class="modal-mask" @click.self="browseOpen = false">
      <div class="modal" style="width:min(560px,100%)">
        <h3>选择教材根目录</h3>
        <div class="row" style="margin-bottom:10px">
          <button class="btn small" :disabled="!bparent" @click="browse(bparent)">
            <Icon name="arrow-left" :size="14" />上一级
          </button>
          <code style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px">{{ bpath || '选择磁盘 / 根目录' }}</code>
        </div>
        <div class="row" style="margin-bottom:10px;gap:6px">
          <input type="text" v-model="bmanual" placeholder="直接输入路径" style="flex:1" @keydown.enter="browseManual" />
          <button class="btn small" @click="browseManual">打开</button>
        </div>
        <div v-if="bBusy" class="empty-tip" style="margin:20px auto">正在读取…</div>
        <div v-else-if="bErr" class="notice err">{{ bErr }}</div>
        <div v-else class="dirlist">
          <button v-for="d in bdirs" :key="d.path" class="diritem" @click="chooseDir(d)">
            <Icon name="folder" :size="16" />{{ d.name }}
          </button>
          <div v-if="!bdirs.length" class="muted" style="padding:12px;font-size:12.5px">这个目录下没有子目录</div>
        </div>
        <div class="acts">
          <button class="btn" @click="browseOpen = false">取消</button>
          <button class="btn primary" :disabled="!bpath" @click="pickCurrent">选择这个目录</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dirlist { max-height: 300px; overflow: auto; border: 1px solid var(--line); border-radius: 9px; padding: 5px; }
.diritem {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  background: none; border: none; padding: 8px 10px; border-radius: 7px; font-size: 13px;
}
.diritem:hover { background: var(--bg2); }
</style>
