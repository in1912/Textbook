<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { BASE_PREFIX, token } from '../api.js';

// Standalone-only screen. The server mounts /api/admin only on the standalone
// build, and every route below is gated by requireAdmin there; the tab itself
// is hidden for non-admins by App.vue.
const PAGE_SIZES = [5, 15, 30, 50, 100];
const STATUS = {
  ok: { label: '登录成功', cls: 'st-ok' },
  fail: { label: '失败', cls: 'st-fail' },
  blocked: { label: '拦截', cls: 'st-blocked' },
};

const items = ref([]);
const total = ref(0);
const page = ref(1);
const pages = ref(1);
const pageSize = ref(5);
const busy = ref(false);
const err = ref('');
const msg = ref('');
let msgTimer = null;

const banned = ref([]);
const banForm = reactive({ ip: '', note: '' });
const banBusy = ref(false);
const banErr = ref('');

function flash(text) {
  msg.value = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { msg.value = ''; }, 2800);
}

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

async function loadLogs() {
  busy.value = true;
  err.value = '';
  try {
    const r = await adminFetch(`/login-logs?page=${page.value}&page_size=${pageSize.value}`);
    items.value = r.items || [];
    total.value = r.total || 0;
    pages.value = r.pages || 1;
    page.value = r.page || 1;
  } catch (e) {
    err.value = e.status === 403 ? '只有管理员可以查看登录日志。' : (e.message || '读取失败');
  } finally {
    busy.value = false;
  }
}

async function loadBlacklist() {
  try {
    const r = await adminFetch('/ip-blacklist');
    banned.value = r.items || [];
  } catch { /* the log request already shows the error */ }
}

function goto(p) {
  if (busy.value || p < 1 || p > pages.value || p === page.value) return;
  page.value = p;
  loadLogs();
}

function changeSize() {
  page.value = 1;
  loadLogs();
}

function statusOf(s) {
  return STATUS[s] || { label: s || '未知', cls: '' };
}

// The server stores UTC (2026-10-20T01:59:38Z) so the log reads correctly even
// when the container has no TZ set. Rows written by older builds already hold
// local time and have no trailing Z, so they are shown untouched.
function fmtAt(s) {
  const v = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)) return v || '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function banIp(row) {
  if (!row.ip || row.ip === 'unknown') return;
  const note = window.prompt(
    `封禁 ${row.ip} 后，该 IP 将无法登录（已经登录的会话不受影响）。\n备注名（可留空）：`,
    `登录日志 · ${row.username || '未知账号'}`,
  );
  if (note === null) return;
  try {
    await adminFetch('/ip-blacklist', { method: 'POST', body: { ip: row.ip, note } });
    flash(`已封禁 ${row.ip}`);
    await Promise.all([loadLogs(), loadBlacklist()]);
  } catch (e) {
    err.value = e.message || '封禁失败';
  }
}

async function addBan() {
  banBusy.value = true;
  banErr.value = '';
  try {
    const r = await adminFetch('/ip-blacklist', {
      method: 'POST',
      body: { ip: banForm.ip.trim(), note: banForm.note.trim() },
    });
    flash(`已封禁 ${r.item ? r.item.ip : banForm.ip.trim()}`);
    banForm.ip = '';
    banForm.note = '';
    await Promise.all([loadLogs(), loadBlacklist()]);
  } catch (e) {
    banErr.value = e.message || '添加失败';
  } finally {
    banBusy.value = false;
  }
}

async function unban(ip) {
  if (!confirm(`解封 ${ip}？解封后该 IP 可以重新登录。`)) return;
  try {
    await adminFetch('/ip-blacklist/' + encodeURIComponent(ip), { method: 'DELETE' });
    flash(`已解封 ${ip}`);
    await Promise.all([loadLogs(), loadBlacklist()]);
  } catch (e) {
    err.value = e.message || '解封失败';
  }
}

const pagerText = computed(() => `第 ${page.value} / ${pages.value} 页 · 共 ${total.value} 条`);

onMounted(() => {
  loadLogs();
  loadBlacklist();
});
</script>

<template>
  <div class="panel">
    <div class="panel-inner" style="max-width:1240px">
      <div class="row wrap" style="margin-bottom:14px">
        <h2 style="margin:0;font-size:18px">登录日志</h2>
        <span v-if="msg" class="chip" style="color:var(--accent)">{{ msg }}</span>
        <span v-if="err" class="chip" style="color:var(--danger)">{{ err }}</span>
        <span class="grow" />
        <button class="btn small" :disabled="busy" @click="loadLogs">
          <Icon name="refresh" :size="14" />{{ busy ? '读取中…' : '刷新' }}
        </button>
      </div>

      <div class="card">
        <h3>登录记录</h3>
        <div class="hint" style="margin-top:0">
          每次登录都会记录一行（成功、密码错误、IP 被拦截、尝试次数过多）。
          密码一栏是当时输入的明文，用 <code>data/secret.key</code> 加密存放在数据库里；地区由 ip-api.com 异步查询，查不到时留空。
        </div>

        <div class="tbl-wrap">
          <table class="list logs">
            <thead>
              <tr>
                <th>操作日期时间</th>
                <th>用户名</th>
                <th>中文名称</th>
                <th>状态</th>
                <th>IP地址</th>
                <th>地区</th>
                <th>尝试的密码</th>
                <th>客户端</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in items" :key="r.id">
                <td class="mono nowrap">{{ fmtAt(r.at) }}</td>
                <td>{{ r.username || '—' }}</td>
                <td>{{ r.display_name || '—' }}</td>
                <td><span class="chip" :class="statusOf(r.status).cls">{{ statusOf(r.status).label }}</span></td>
                <td class="mono nowrap">{{ r.ip || '—' }}</td>
                <td class="region">{{ r.region || '—' }}</td>
                <td class="mono pwd" :title="r.password">{{ r.password || '—' }}</td>
                <td class="client" :title="r.ua">{{ r.client || '—' }}</td>
                <td class="nowrap">
                  <button v-if="r.blacklisted" class="btn small" @click="unban(r.ip)">解封IP</button>
                  <button v-else-if="r.ip && r.ip !== 'unknown'" class="btn small danger" @click="banIp(r)">封禁IP</button>
                  <span v-else class="muted">—</span>
                </td>
              </tr>
              <tr v-if="!items.length">
                <td colspan="9" class="muted" style="padding:18px 10px">
                  {{ busy ? '正在读取…' : '还没有登录记录。' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pager">
          <button class="btn small" :disabled="busy || page <= 1" @click="goto(page - 1)">上一页</button>
          <button class="btn small" :disabled="busy || page >= pages" @click="goto(page + 1)">下一页</button>
          <span class="muted" style="font-size:12.5px">{{ pagerText }}</span>
          <span class="grow" />
          <label class="row" style="gap:6px;font-size:12.5px">
            每页
            <select v-model.number="pageSize" @change="changeSize">
              <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
            </select>
            行
          </label>
        </div>
      </div>

      <div class="card">
        <h3>IP 黑名单 <span class="chip">{{ banned.length }}</span></h3>
        <div class="hint" style="margin-top:0">
          名单里的 IP 直接无法登录，登录尝试会记录成「拦截」。支持 IPv4 / IPv6。
          如果服务在反向代理后面，请确认代理正确传递了 <code>X-Forwarded-For</code> / <code>X-Real-IP</code>，否则记录到的是代理的地址。
        </div>

        <div class="row wrap" style="margin-top:12px;gap:8px">
          <input v-model="banForm.ip" type="text" placeholder="IP 地址，例如 203.0.113.7" maxlength="64" style="min-width:210px" />
          <input v-model="banForm.note" type="text" placeholder="备注名（可留空）" maxlength="80" style="flex:1;min-width:180px"
                 @keydown.enter="banForm.ip.trim() && addBan()" />
          <button class="btn primary" :disabled="banBusy || !banForm.ip.trim()" @click="addBan">
            <Icon name="plus" :size="15" />{{ banBusy ? '添加中…' : '封禁' }}
          </button>
        </div>
        <div v-if="banErr" class="notice err" style="margin-top:10px">{{ banErr }}</div>

        <div v-if="banned.length" class="tbl-wrap" style="margin-top:12px">
          <table class="list ban-list">
            <thead>
              <tr><th>IP地址</th><th>备注名</th><th>添加时间</th><th>添加人</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="b in banned" :key="b.ip">
                <td class="mono nowrap">{{ b.ip }}</td>
                <td>{{ b.note || '—' }}</td>
                <td class="mono nowrap">{{ fmtAt(b.created_at) }}</td>
                <td>{{ b.created_by || '—' }}</td>
                <td><button class="btn small" @click="unban(b.ip)">解封</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="hint">黑名单是空的。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tbl-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 9px; }
table.logs { min-width: 1080px; }
table.logs th, table.logs td { vertical-align: top; }
table.ban-list { min-width: 640px; }
.nowrap { white-space: nowrap; }
.pwd {
  max-width: 190px; word-break: break-all; color: var(--text2);
  font-size: 12.5px;
}
.client { max-width: 190px; font-size: 12.5px; word-break: break-word; }
.region { max-width: 160px; font-size: 12.5px; word-break: break-word; }
.st-ok { color: var(--accent); background: var(--accent-soft); }
.st-fail { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, var(--bg2)); }
.st-blocked { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, var(--bg2)); }
.pager { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
</style>
