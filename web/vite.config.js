import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// pdf.js 4.x calls Promise.withResolvers() from inside its worker too. The
// worker is loaded as an ES module, so the polyfill in index.html (main thread)
// cannot reach it. Prepend the same shim to the emitted worker asset.
const WORKER_SHIM = '/*tb-withresolvers*/if(typeof Promise.withResolvers!=="function"){Promise.withResolvers=function(){var e,n,t=new Promise(function(t,r){e=t;n=r});return{promise:t,resolve:e,reject:n}}}\n';
function pdfWorkerWithResolvers() {
  return {
    name: 'pdf-worker-withresolvers',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== 'asset' || !/pdf\.worker.*\.mjs$/.test(item.fileName)) continue;
        const src = typeof item.source === 'string'
          ? item.source
          : Buffer.from(item.source).toString('utf8');
        if (src.includes('/*tb-withresolvers*/')) continue;
        item.source = WORKER_SHIM + src;
      }
    },
  };
}

// The textbook SPA is embedded by the workbench at /textbook/index.html and can
// later be served standalone. Relative asset paths make both cases work without
// rewriting, including behind the fnOS gateway prefix (/app/<name>/).
export default defineConfig({
  plugins: [vue(), pdfWorkerWithResolvers()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
