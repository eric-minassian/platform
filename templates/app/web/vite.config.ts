import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `plat dev` serves everything on its local router (default :3000) and proxies
// frontend requests here; opening this dev server directly also works because
// API and platform routes are proxied back to the router.
const router = process.env.PLATFORM_DEV_ROUTER ?? 'http://localhost:3000';
// `plat dev` picks a free port for this server and waits for exactly that one,
// so several apps can run side by side.
const port = Number(process.env.PLATFORM_DEV_WEB_PORT ?? 5173);

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port,
    strictPort: true,
    proxy: { '/api': router, '/__platform': router },
  },
});
