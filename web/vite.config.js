import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The textbook SPA is embedded by the workbench at /textbook/index.html and can
// later be served standalone. Relative asset paths make both cases work without
// rewriting, including behind the fnOS gateway prefix (/app/<name>/).
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
