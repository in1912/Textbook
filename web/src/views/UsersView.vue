<script setup>
import { onMounted, reactive, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { BASE_PREFIX, api, token } from '../api.js';
import { fmtNum, fmtTime } from '../util.js';

const items = ref([]);
const caps = ref({ manage_users: false, admin: false });
const error = ref('');
const busy = ref(false);

const createForm = reactive({ username: '', display_name: '', password: '', role: 'user' });
const editing = ref(null);
const editForm = reactive({ display_name: '', role: 'user', disabled: false, password: '' });
const msg = ref('');

async function load() {
  error.value = '';
  try {
    caps.value = await api.get('/capabilities');
  } catch { /* keep defaults */ }
  try {
    const r = await api.get('/users');
    items.value = r.items || [];
  } catch (e) {
    error.value = e.status === 403 ? '只有管理员可以查看用户与用量。' : (e.message || '读取失败');
  }
}
onMounted(load);

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

function flash(t) { msg.value = t; setTimeout(() => { msg.value = ''; }, 2600); }

async function createUser() {
  busy.value = true;
  try {
    await adminFetch('/users', { method: 'POST', body: { ...createForm } });
    createForm.username = ''; createForm.display_name = ''; createForm.password = ''; createForm.role = 'user';
    flash('用户已创建');
    await load();
  } catch (e) { error.value = e.message || '创建失败'; }
  finally { busy.value = false; }
}

function startEdit(u) {
  editing.value = u;
  editForm.display_name = u.name || u.username;
  editForm.role = u.role || 'user';
  editForm.disabled = !!u.disabled;
  editForm.password = '';
}
async function saveEdit() {
  if (!editing.value) return;
  busy.value = true;
  try {
    const body = { display_name: editForm.display_name, role: editForm.role, disabled: editForm.disabled };
    if (editForm.password) body.password = editForm.password;
    await adminFetch('/users/' + editing.value.id, { method: 'PUT', body });
    editing.value = null;
    flash('用户已更新');
    await load();
  } catch (e) { error.value = e.message || '保存失败'; }
  finally { busy.value = false; }
}
async function removeUser(u) {
  if (!window.confirm(`删除用户「${u.name || u.username}」？其笔记和用量记录会保留在数据库中。`)) return;
  try {
    await adminFetch('/users/' + u.id, { method: 'DELETE' });
    flash('用户已删除');
    await load();
  } catch (e) { error.value = e.message || '删除失败'; }
}
</script>

<template>
  <div class="panel">
    <div class="panel-inner">
      <div class="row wrap" style="margin-bottom:14px">
        <h2 style="margin:0;font-size:18px">用户管理</h2>
        <span class="grow" />
        <span v-if="msg" class="chip" style="color:var(--accent)">{{ msg }}</span>
        <button class="icbtn" title="刷新" @click="load"><Icon name="refresh" :size="16" /></button>
      </div>

      <div v-if="error" class="notice err" style="margin-bottom:12px">{{ error }}</div>

      <div class="card">
        <h3>用户与 AI 用量</h3>
        <div v-if="!items.length" class="muted" style="font-size:13px">没有数据</div>
        <table v-else class="list">
          <thead>
            <tr>
              <th>用户</th><th>账号</th><th style="width:80px">角色</th>
              <th style="width:80px">笔记</th><th style="width:110px">累计 tokens</th>
              <th style="width:80px">调用</th><th style="width:140px">最近使用</th>
              <th v-if="caps.manage_users" style="width:100px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in items" :key="u.id">
              <td>
                {{ u.name || u.username }}
                <span v-if="u.disabled" class="chip" style="margin-left:6px;color:var(--danger)">已停用</span>
              </td>
              <td class="muted">{{ u.username }}</td>
              <td>{{ u.role === 'admin' ? '管理员' : '用户' }}</td>
              <td class="mono">{{ u.notes }}</td>
              <td class="mono">{{ fmtNum(u.total_tokens) }}</td>
              <td class="mono">{{ u.calls }}</td>
              <td class="muted mono">{{ fmtTime(u.updated_at) || '—' }}</td>
              <td v-if="caps.manage_users">
                <button class="icbtn" title="编辑" @click="startEdit(u)"><Icon name="settings" :size="14" /></button>
                <button class="icbtn" title="删除" @click="removeUser(u)"><Icon name="trash" :size="14" /></button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="hint">累计 tokens 只统计「AI分析」调用；没有返回用量计费的接口不会被估算。</div>
      </div>

      <div v-if="caps.manage_users" class="card">
        <h3>新建用户</h3>
        <div class="grid2">
          <label class="field">账号
            <input type="text" v-model="createForm.username" placeholder="登录名，字母/数字" autocomplete="off" />
          </label>
          <label class="field">显示名称
            <input type="text" v-model="createForm.display_name" placeholder="学生姓名或昵称" />
          </label>
          <label class="field">初始密码
            <input type="password" v-model="createForm.password" autocomplete="new-password" />
          </label>
          <label class="field">角色
            <select v-model="createForm.role">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </label>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" :disabled="busy || !createForm.username || !createForm.password" @click="createUser">
            <Icon name="plus" :size="15" />创建用户
          </button>
        </div>
      </div>

      <div v-if="editing" class="modal-mask" @click.self="editing = null">
        <div class="modal">
          <h3>编辑用户 · {{ editing.username }}</h3>
          <label class="field" style="margin-bottom:10px">显示名称
            <input type="text" v-model="editForm.display_name" />
          </label>
          <label class="field" style="margin-bottom:10px">角色
            <select v-model="editForm.role">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          <label class="field" style="margin-bottom:10px">重置密码（留空不改）
            <input type="password" v-model="editForm.password" autocomplete="new-password" />
          </label>
          <label class="row" style="gap:8px;margin-bottom:6px">
            <input type="checkbox" v-model="editForm.disabled" />
            <span>停用这个账号（不能登录）</span>
          </label>
          <div class="acts">
            <button class="btn" @click="editing = null">取消</button>
            <button class="btn primary" :disabled="busy" @click="saveEdit">保存</button>
          </div>
        </div>
      </div>

      <div class="notice">
        每位用户只看到自己的笔记、批注和书签；教材目录与 AI 报告按账号隔离。管理员可以查看全站用户与 AI 用量。
      </div>
    </div>
  </div>
</template>
