import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// UI dev server runs on 5174. Daemon (Fastify + WS) runs on 5175.
// Vite proxies /api and /ws to the daemon so the UI can be served
// from a single origin in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5175', changeOrigin: true },
      '/ws':  { target: 'ws://127.0.0.1:5175', ws: true },
    },
  },
  build: { outDir: 'dist/ui' },
});
