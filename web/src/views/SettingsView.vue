<script setup>
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import SslPanel from '../components/SslPanel.vue';
import { BASE_PREFIX, api, token } from '../api.js';
import { flushPendingCrash } from '../crashlog.js';

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
    if (!caps.value.embedded) { loadCrashes(); loadMe(); }
    if (!caps.value.embedded && caps.value.admin) await loadUpgrade();
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

// ---- standalone system upgrade --------------------------------------------
// Hidden in the embedded (workbench) copy: the workbench upgrades itself.
const up = reactive({
  version: '', disk_version: '', dist_ok: true, max_upload_mb: 64,
  restart_pending: false, restart_suppressed: false,
  backup_count: 0, backups: [], history: [],
});
const upFile = ref(null);
const upInput = ref(null);
const upPlan = ref(null);
const upToken = ref('');
const upBusy = ref('');
const upMsg = ref('');
const upErr = ref('');
const upPoll = ref('');
let upTimer = null;

async function upgradeFetch(path, opts = {}) {
  const t = token();
  const url = BASE_PREFIX + '/api/admin/upgrade' + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

async function loadUpgrade() {
  try { Object.assign(up, await upgradeFetch('/status')); }
  catch { /* server predates the upgrade feature */ }
}

function pickUpgrade(e) {
  const f = (e.target.files && e.target.files[0]) || null;
  upFile.value = f;
  upPlan.value = null;
  upToken.value = '';
  upMsg.value = '';
  upErr.value = '';
  upPoll.value = '';
}

async function runPreflight() {
  if (!upFile.value) return;
  upBusy.value = 'preflight';
  upPlan.value = null; upToken.value = '';
  upMsg.value = ''; upErr.value = ''; upPoll.value = '';
  try {
    const r = await upgradeFetch('/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: upFile.value,
    });
    upPlan.value = r.plan;
    upToken.value = r.token;
  } catch (e) {
    upErr.value = e.message || '预检失败';
  } finally {
    upBusy.value = '';
  }
}

async function doApply(allowDep) {
  upBusy.value = 'apply';
  upErr.value = ''; upMsg.value = '';
  try {
    const r = await upgradeFetch('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: upToken.value, allow_dep_change: !!allowDep }),
    });
    upPlan.value = null;
    upToken.value = '';
    upMsg.value = `升级完成：v${r.version.from || '?'} → v${r.version.to}，写入 ${r.files_written.total} 个文件`
      + (r.backup_dir ? '，可回滚备份已保存' : '');
    if (r.restart === 'scheduled') {
      upPoll.value = `正在等待 v${r.version.to} 启动…`;
      waitForVersion(r.version.to);
    } else if (r.restart === 'suppressed') {
      upMsg.value += '（调试模式：进程没有重启，手动重启后新代码才生效）';
    }
    loadUpgrade();
  } catch (e) {
    if (e.status === 409 && e.data && e.data.error === 'DEP_CHANGED' && !allowDep) {
      if (confirm(e.message + '\n\n依赖已经在服务器上安装好了，仍要继续吗？')) {
        await doApply(true);
        return;
      }
    }
    upErr.value = e.message || '升级失败';
  } finally {
    if (upBusy.value === 'apply') upBusy.value = '';
  }
}

async function applyUpgrade() {
  if (!upPlan.value || !upToken.value) return;
  const p = upPlan.value;
  const n = p.summary.add + p.summary.overwrite;
  const tail = p.restart_required ? '，随后服务会自动重启（几秒内打不开）' : '';
  if (!confirm(`确认从 ${p.version.current || '当前版本'} 升级到 ${p.manifest.version}？\n将写入 ${n} 个文件${tail}。`)) return;
  await doApply(false);
}

function waitForVersion(target) {
  const started = Date.now();
  clearInterval(upTimer);
  upTimer = setInterval(async () => {
    if (Date.now() - started > 30000) {
      clearInterval(upTimer);
      upPoll.value = '';
      upErr.value = '服务在 30 秒内没有带着新版本上线，请到服务器上查看 Logs/restart-child.log';
      return;
    }
    try {
      const r = await fetch(BASE_PREFIX + '/api/health', { cache: 'no-store' });
      const d = await r.json();
      if (d && d.version === target) {
        clearInterval(upTimer);
        upPoll.value = '';
        upMsg.value = `已升级到 v${target}，页面即将刷新`;
        loadUpgrade();
        setTimeout(() => location.reload(), 900);
      }
    } catch { /* still restarting */ }
  }, 700);
}

onBeforeUnmount(() => clearInterval(upTimer));

function backupUrl(name) {
  return BASE_PREFIX + '/api/admin/upgrade/backups/' + encodeURIComponent(name) + '/download?token=' + encodeURIComponent(token());
}

// ---- crash log -------------------------------------------------------------
const crashes = ref([]);
const crashMsg = ref('');
const crashBusy = ref(false);
const me = ref(null);
const CRASH_LABEL = {
  unclean_exit: '异常退出',
  js_error: '脚本报错',
  render_error: 'PDF 渲染错误',
  memory: '内存',
  other: '其他',
};

async function loadCrashes() {
  crashBusy.value = true;
  try {
    await flushPendingCrash(); // reports queued while logged out
    const r = await api.get('/crashlog?limit=50');
    crashes.value = r.items || [];
  } catch { /* older server */ } finally {
    crashBusy.value = false;
  }
}

async function clearCrashes() {
  if (!crashes.value.length) return;
  if (!confirm('清空自己的全部崩溃日志？此操作不可恢复。')) return;
  crashBusy.value = true;
  crashMsg.value = '';
  try {
    await api.del('/crashlog');
    crashes.value = [];
    crashMsg.value = '已清空';
  } catch (e) {
    crashMsg.value = e.message || '清空失败';
  } finally {
    crashBusy.value = false;
  }
}

function crashDetail(c) {
  let s = c.detail || '';
  try { s = JSON.stringify(JSON.parse(s), null, 2); } catch { /* keep raw */ }
  return s.length > 8000 ? s.slice(0, 8000) + '\n…' : s;
}

async function loadMe() {
  try {
    const r = await fetch(BASE_PREFIX + '/api/auth/me?token=' + encodeURIComponent(token()));
    if (r.ok) me.value = (await r.json()).user;
  } catch { /* embedded copies have no standalone auth */ }
}

async function logout() {
  if (!confirm('退出登录？')) return;
  try {
    await fetch(BASE_PREFIX + '/api/auth/logout?token=' + encodeURIComponent(token()), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token() },
    });
  } catch { /* the local token is cleared either way */ }
  try { localStorage.removeItem('wb_token'); } catch { /* private mode */ }
  location.reload();
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

      <div v-if="!caps.embedded && caps.admin" class="card">
        <h3>系统升级</h3>
        <div class="hint" style="margin-top:0">
          当前运行版本 <code>{{ up.version || '—' }}</code>
          <span v-if="up.disk_version && up.disk_version !== up.version">；磁盘上是 <code>{{ up.disk_version }}</code>（已写入但进程还没重启）</span>
          <span v-if="up.restart_pending" style="color:var(--danger)">；上次升级的重启没有完成交接，请检查 Logs/restart-child.log</span>
          <br />
          升级包在开发机上用 <code>npm run pack:upgrade</code> 生成（最大 {{ up.max_upload_mb }}MB）。
          升级只写 <code>server/**.js</code>、<code>web/dist/**</code> 和 <code>package.json</code>，不碰 <code>data/</code> 与教材目录。
        </div>

        <div class="row wrap" style="margin-top:12px;gap:8px">
          <input ref="upInput" type="file" accept=".zip,application/zip" style="display:none" @change="pickUpgrade" />
          <button class="btn" @click="upInput && upInput.click()"><Icon name="file" :size="15" />选择升级包</button>
          <span class="muted" style="font-size:12.5px;min-width:160px">
            {{ upFile ? upFile.name + '（' + (upFile.size / 1048576).toFixed(2) + ' MB）' : '未选择文件' }}
          </span>
          <button class="btn primary" :disabled="!upFile || upBusy === 'preflight'" @click="runPreflight">
            <Icon name="search" :size="15" />{{ upBusy === 'preflight' ? '预检中…' : '预检' }}
          </button>
          <span v-if="upMsg" class="chip" style="color:var(--accent)">{{ upMsg }}</span>
          <span v-if="upErr" class="chip" style="color:var(--danger)">{{ upErr }}</span>
          <span v-if="upPoll" class="chip" style="color:var(--accent)">{{ upPoll }}</span>
        </div>

        <div v-if="upPlan" class="notice up-plan">
          <div>
            <b>{{ upPlan.version.current || '当前版本' }} → {{ upPlan.manifest.version }}</b>
            <span class="muted">
              · 新增 {{ upPlan.summary.add }}、覆盖 {{ upPlan.summary.overwrite }}、内容相同跳过 {{ upPlan.summary.skip }}
              · 包 {{ (upPlan.summary.bytes_zip / 1048576).toFixed(2) }} MB
            </span>
          </div>
          <div style="margin-top:4px">
            {{ upPlan.restart_required ? '这个包改了服务端代码，升级后会自动重启（1~3 秒）。' : '只换前端，无需重启。' }}
          </div>
          <ul v-if="upPlan.warnings.length" class="up-warn">
            <li v-for="(w, i) in upPlan.warnings" :key="i">{{ w }}</li>
          </ul>
          <details style="margin-top:6px">
            <summary class="muted" style="font-size:12.5px;cursor:pointer">
              查看将写入的文件（{{ upPlan.summary.add + upPlan.summary.overwrite }} 个）
            </summary>
            <div class="up-files">
              <div v-for="f in upPlan.files.filter((x) => x.action !== 'skip').slice(0, 200)" :key="f.path">
                <span class="chip">{{ f.action === 'add' ? '新增' : '覆盖' }}</span>{{ f.path }}
              </div>
              <div v-if="upPlan.summary.add + upPlan.summary.overwrite > 200" class="muted">
                …只显示前 200 个，共 {{ upPlan.summary.add + upPlan.summary.overwrite }} 个
              </div>
            </div>
          </details>
          <div class="row" style="margin-top:10px">
            <button class="btn primary" :disabled="upBusy === 'apply'" @click="applyUpgrade">
              <Icon name="check" :size="15" />{{ upBusy === 'apply' ? '升级中…' : '应用升级' }}
            </button>
          </div>
        </div>

        <div v-if="up.history.length" style="margin-top:16px">
          <div class="muted" style="font-size:12.5px;margin-bottom:6px">升级记录</div>
          <div class="up-hist">
            <div v-for="(h, i) in up.history" :key="i" class="up-hist-row">
              <span class="muted">{{ h.at }}</span>
              <span>v{{ h.from || '?' }} → v{{ h.to }}</span>
              <span class="muted">新增 {{ h.add }} / 覆盖 {{ h.overwrite }} / 跳过 {{ h.skip }}</span>
              <span :style="{ color: h.ok ? 'var(--accent)' : 'var(--danger)' }">{{ h.ok ? '成功' : '失败' }}</span>
              <span class="muted">{{ { not_needed: '无需重启', scheduled: '已重启', suppressed: '未重启', not_started: '未重启' }[h.restart] || h.restart }}</span>
            </div>
          </div>
        </div>

        <div v-if="up.backups.length" style="margin-top:14px">
          <div class="muted" style="font-size:12.5px;margin-bottom:6px">
            可回滚备份（共 {{ up.backup_count }} 个，下载后按相对路径拷回安装目录并重启即可回滚）
          </div>
          <div v-for="b in up.backups" :key="b.name" class="row" style="gap:10px;font-size:12.5px">
            <a :href="backupUrl(b.name)" class="up-link"><Icon name="download" :size="14" />{{ b.name }}</a>
            <span class="muted">{{ b.files }} 个文件 · {{ (b.bytes / 1048576).toFixed(2) }} MB</span>
          </div>
        </div>
      </div>

      <SslPanel v-if="!caps.embedded && caps.admin" />

      <div v-if="!caps.embedded" class="card">
        <h3>崩溃日志 <span v-if="crashes.length" class="chip">{{ crashes.length }}</span></h3>
        <div class="hint" style="margin-top:0">
          记录页面脚本报错、PDF 渲染失败，以及「上次页面没有正常结束」。
          浏览器进程被系统回收时来不及写日志，所以用每 5 秒一次的心跳和最近操作轨迹来判断：重新打开页面后自动上报，
          记录里带上设备、屏幕、当时在读哪本书、第几页、渲染了几页、估算画布占用。
        </div>
        <div class="row wrap" style="margin-top:10px">
          <button class="btn small" :disabled="crashBusy" @click="loadCrashes">
            <Icon name="refresh" :size="14" />{{ crashBusy ? '读取中…' : '刷新' }}
          </button>
          <button class="btn small danger" :disabled="crashBusy || !crashes.length" @click="clearCrashes">
            <Icon name="trash" :size="14" />清空日志
          </button>
          <span v-if="crashMsg" class="chip">{{ crashMsg }}</span>
        </div>
        <div v-if="!crashes.length" class="hint">暂时没有记录。</div>
        <div v-else class="crash-list">
          <details v-for="c in crashes" :key="c.id" class="crash-item">
            <summary>
              <span class="chip" :class="'crash-kind-' + c.kind">{{ CRASH_LABEL[c.kind] || c.kind }}</span>
              <span class="muted" style="font-size:12px">{{ c.at }}</span>
              <span class="crash-sum">{{ c.summary }}</span>
            </summary>
            <pre class="crash-detail">{{ crashDetail(c) }}</pre>
            <div class="muted" style="font-size:11.5px;word-break:break-all">{{ c.ua }}</div>
          </details>
        </div>
      </div>

      <div class="notice">
        目录排序按 小学 → 初中 → 高中 → 大学、数学/语文/英语优先、人教版优先；同一版本下按年级与上册/中册/下册排列，习题类排在最后。
      </div>

      <div v-if="!caps.embedded" class="card" style="margin-top:14px">
        <h3>账户</h3>
        <div class="row wrap">
          <span v-if="me" class="muted">
            {{ me.username }}<template v-if="me.display_name"> · {{ me.display_name }}</template>
            · {{ me.role === 'admin' ? '管理员' : '普通用户' }}
          </span>
          <span v-else class="muted">已登录</span>
          <span class="grow" />
          <button class="btn danger" @click="logout">
            <Icon name="arrow-left" :size="15" />退出登录
          </button>
        </div>
        <div class="hint">退出后需要重新输入账号密码；笔记、批注和崩溃日志都保存在服务器上。</div>
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
.up-plan { margin-top: 12px; }
.up-warn { margin: 6px 0 0; padding-left: 18px; color: var(--warn, #b45309); font-size: 12.5px; line-height: 1.7; }
.up-files {
  max-height: 220px; overflow: auto; margin-top: 6px; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--bg2);
  font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
.up-files .chip { margin-right: 6px; padding: 0 5px; font-size: 11px; }
.up-hist { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.up-hist-row {
  display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline;
  padding: 6px 10px; font-size: 12.5px; border-top: 1px solid var(--line);
}
.up-hist-row:first-child { border-top: none; }
.up-link { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); text-decoration: none; }
.up-link:hover { text-decoration: underline; }
.crash-list { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.crash-item { border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; }
.crash-item summary {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  cursor: pointer; font-size: 12.5px;
}
.crash-sum { color: var(--text2); word-break: break-all; }
.crash-kind-unclean_exit { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, var(--bg2)); }
.crash-kind-js_error, .crash-kind-render_error { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, var(--bg2)); }
.crash-detail {
  margin: 8px 0 4px; padding: 8px 10px; max-height: 280px; overflow: auto;
  background: var(--bg2); border-radius: 7px; font-size: 11.5px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-all;
}
</style>
