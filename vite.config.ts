import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// UI dev server runs on UI_PORT (default 5174). Daemon (Fastify + WS)
// runs on PORT (default 5175). Both are env-overridable so multi-target
// installs can give each (UI, daemon) pair its own pair of ports — e.g.
// 5174/5175 for the 'default' target, 5184/5185 for a second target.
const DAEMON_PORT = Number(process.env.PORT ?? 5175);
const UI_PORT = Number(process.env.UI_PORT ?? 5174);
export default defineConfig({
  plugins: [react()],
  server: {
    port: UI_PORT,
    host: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${DAEMON_PORT}`, changeOrigin: true },
      '/ws':  { target: `ws://127.0.0.1:${DAEMON_PORT}`, ws: true },
    },
  },
  build: { outDir: 'dist/ui' },
});
