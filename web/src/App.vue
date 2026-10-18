<script setup>
import { computed, onMounted, provide, reactive, ref, watch } from 'vue';
import Icon from './components/Icon.vue';
import StudyView from './views/StudyView.vue';
import AiView from './views/AiView.vue';
import UsersView from './views/UsersView.vue';
import SettingsView from './views/SettingsView.vue';
import ShareView from './views/ShareView.vue';
import LoginView from './views/LoginView.vue';
import { api } from './api.js';

const shareToken = ref('');
function readHash() {
  const m = String(location.hash || '').match(/^#\/share\/([A-Za-z0-9_-]{10,})/);
  shareToken.value = m ? m[1] : '';
}
readHash();
window.addEventListener('hashchange', readHash);

const state = reactive({
  settings: null,
  optionalExts: [],
  defaultRoot: '',
  rootError: '',
  // the textbook currently open in 教材学习; AI analysis and sharing read it
  book: { path: '', title: '', page: 1 },
  reloadKey: 0,
});
provide('appState', state);

const tab = ref('study');
const tabDefs = [
  { key: 'study', label: '教材学习', icon: 'book-open', comp: StudyView },
  { key: 'ai', label: 'AI分析', icon: 'sparkles', comp: AiView },
  { key: 'users', label: '用户管理', icon: 'users', comp: UsersView },
  { key: 'settings', label: '设置', icon: 'settings', comp: SettingsView },
];
const viewComp = computed(() => (tabDefs.find((t) => t.key === tab.value) || tabDefs[0]).comp);

const loading = ref(true);
const bootError = ref('');
const needLogin = ref(false);
const dark = computed(() => state.settings && state.settings.theme === 'dark');

function applyTheme(theme) {
  const d = theme === 'dark';
  document.documentElement.classList.toggle('dark', d);
  document.documentElement.style.colorScheme = d ? 'dark' : 'light';
}

async function loadSettings() {
  try {
    const r = await api.get('/settings');
    state.settings = r.settings;
    state.optionalExts = r.optional_exts || [];
    state.defaultRoot = r.default_root || '';
    state.rootError = r.root_error || '';
    if (!r.root_ok) state.rootError = r.root_error || '';
    needLogin.value = false;
    bootError.value = '';
    applyTheme(r.settings.theme);
  } catch (e) {
    if (e.status === 401) {
      // Embedded copies live under /textbook/ and rely on the workbench login;
      // the standalone server has its own login screen at the root.
      if (location.pathname.includes('/textbook/')) {
        bootError.value = '登录已失效，请回到工作台重新登录后刷新页面。';
      } else {
        needLogin.value = true;
      }
    } else {
      bootError.value = e.message || '无法连接教材服务';
    }
    applyTheme(localStorage.getItem('tb_theme') || 'light');
  } finally {
    loading.value = false;
  }
}
provide('reloadSettings', loadSettings);

function onLoggedIn() {
  needLogin.value = false;
  loading.value = true;
  loadSettings();
}

async function toggleTheme() {
  const next = dark.value ? 'light' : 'dark';
  if (state.settings) state.settings.theme = next;
  applyTheme(next);
  try { localStorage.setItem('tb_theme', next); } catch { /* private mode */ }
  try { await api.put('/settings', { theme: next }); } catch { /* keep local choice */ }
}

watch(() => state.reloadKey, () => { loadSettings(); });

onMounted(loadSettings);
</script>

<template>
  <div class="shell">
    <ShareView v-if="shareToken" :token="shareToken" />
    <LoginView v-else-if="needLogin" @logged-in="onLoggedIn" />

    <template v-else>
      <header class="topbar">
        <div class="brand">
          <Icon name="book-open" :size="20" />
          <span>全科教材</span>
          <small>Textbook</small>
        </div>
        <nav class="tabs">
          <button v-for="t in tabDefs" :key="t.key" class="tab" :class="{ active: tab === t.key }"
                  @click="tab = t.key">
            <span class="dotmark" />
            <Icon :name="t.icon" :size="15" />
            <span>{{ t.label }}</span>
          </button>
        </nav>
        <div class="spacer" />
        <div class="toolbar-right">
          <button class="icbtn" :title="dark ? '切到白天模式' : '切到夜间模式'" @click="toggleTheme">
            <Icon :name="dark ? 'sun' : 'moon'" :size="17" />
          </button>
        </div>
      </header>

      <main class="main">
        <KeepAlive include="StudyView">
          <component :is="viewComp" :key="tab" />
        </KeepAlive>
      </main>
    </template>

    <div v-if="loading" class="modal-mask">
      <div class="modal" style="width:280px;text-align:center;color:var(--mut)">正在载入…</div>
    </div>
    <div v-else-if="bootError && !shareToken" class="modal-mask">
      <div class="modal" style="width:min(420px,100%)">
        <h3>无法打开教材系统</h3>
        <div class="notice err">{{ bootError }}</div>
        <div class="acts"><button class="btn primary" @click="loadSettings">重试</button></div>
      </div>
    </div>
  </div>
</template>
