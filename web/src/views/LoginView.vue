<script setup>
import { ref } from 'vue';
import Icon from '../components/Icon.vue';
import { BASE_PREFIX } from '../api.js';

const emit = defineEmits(['logged-in']);
const username = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
const dark = ref(document.documentElement.classList.contains('dark'));

async function submit() {
  if (busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    const res = await fetch(BASE_PREFIX + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      error.value = (data && data.message) || '登录失败';
      return;
    }
    try { localStorage.setItem('wb_token', data.token); } catch { /* private mode */ }
    emit('logged-in');
  } catch (e) {
    error.value = '无法连接服务器';
  } finally {
    busy.value = false;
  }
}

function toggleTheme() {
  dark.value = !dark.value;
  document.documentElement.classList.toggle('dark', dark.value);
  try { localStorage.setItem('tb_theme', dark.value ? 'dark' : 'light'); } catch { /* ignore */ }
}
</script>

<template>
  <div class="login-page">
    <button class="icbtn login-theme" :title="dark ? '白天模式' : '夜间模式'" @click="toggleTheme">
      <Icon :name="dark ? 'sun' : 'moon'" :size="17" />
    </button>
    <form class="login-card" @submit.prevent="submit">
      <div class="login-brand">
        <Icon name="book-open" :size="26" />
        <div>
          <div class="login-title">全科教材</div>
          <div class="login-sub">Textbook · 登录后使用自己的笔记与批注</div>
        </div>
      </div>

      <label class="field">账号
        <input type="text" v-model="username" autocomplete="username" autofocus />
      </label>
      <label class="field">密码
        <input type="password" v-model="password" autocomplete="current-password" />
      </label>

      <div v-if="error" class="notice err" style="margin-top:10px">{{ error }}</div>

      <button class="btn primary login-submit" type="submit" :disabled="busy || !username || !password">
        {{ busy ? '登录中…' : '登录' }}
      </button>

      <div class="hint" style="margin-top:14px">
        首次部署的初始管理员账号与密码写在服务器 <code>data/initial-admin.txt</code>，
        登录后请到「用户管理」修改密码并删除该文件。
      </div>
    </form>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100%; display: flex; align-items: center; justify-content: center;
  background: var(--bg); padding: 20px; position: relative;
}
.login-card {
  width: min(380px, 100%); background: var(--panel); border: 1px solid var(--line);
  border-radius: 16px; padding: 26px 24px 22px; box-shadow: var(--shadow);
  display: flex; flex-direction: column; gap: 12px;
}
.login-brand { display: flex; align-items: center; gap: 12px; color: var(--accent); margin-bottom: 6px; }
.login-title { font-size: 18px; font-weight: 700; color: var(--text); letter-spacing: .5px; }
.login-sub { font-size: 12px; color: var(--mut); margin-top: 2px; }
.login-submit { height: 38px; margin-top: 6px; }
.login-theme { position: absolute; top: 16px; right: 16px; }
</style>
