import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const api = 'http://127.0.0.1:8787';
const guidePath = fileURLToPath(new URL('./src/agent-guide.md', import.meta.url));
const readGuide = () => readFileSync(guidePath, 'utf8');
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Agents usually fetch the console URL without running JavaScript, so the
 * signed-out page (the agent guide plus the sign-in link) is also written into
 * index.html, where React replaces it on mount. The guide is published as
 * `/llms.txt` too, for fetch tools that summarize HTML instead of returning it.
 */
function agentGuide(): Plugin {
  return {
    name: 'agent-guide',
    transformIndexHtml: (html) =>
      html.replace(
        '<!--agent-guide-->',
        `<div data-static><p><a href="/auth/github/login?redirect=%2F">Sign in with GitHub</a></p>` +
          `<pre><code>${escapeHtml(readGuide())}</code></pre></div>`,
      ),
    configureServer(server) {
      server.middlewares.use('/llms.txt', (_req, res) => {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(readGuide());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'llms.txt', source: readGuide() });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss(), agentGuide()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/v1': { target: api, changeOrigin: false }, '/auth': { target: api, changeOrigin: false } },
  },
});
