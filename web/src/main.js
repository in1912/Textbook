import { createApp } from 'vue';
import App from './App.vue';
import { initCrashLog } from './crashlog.js';
import './style.css';

// Start the heartbeat before mounting so the first paint is covered too.
initCrashLog();
createApp(App).mount('#app');
