import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `plat dev` serves everything on its local router (default :3000) and proxies
// frontend requests here; opening this dev server directly also works because
// API and platform routes are proxied back to the router.
const router = process.env.PLATFORM_DEV_ROUTER ?? 'http://localhost:3000';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': router, '/__platform': router },
  },
});
