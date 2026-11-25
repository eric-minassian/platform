import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { preferencesScript } from '@ui-sdk/core';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { colorScheme } from './src/lib/color-scheme.ts';

// The local API (`pnpm api:dev` or `pnpm web:demo`); another port when worktrees run side by side.
const api = process.env.PLATFORM_DEV_API ?? 'http://127.0.0.1:8787';
// Under `plat dev`, the port it picked; it waits for exactly that one.
const platDevPort = Number(process.env.PLATFORM_DEV_WEB_PORT) || undefined;
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

/** Applies the saved color scheme as the page loads, before the app's JavaScript, so a dark choice never flashes light. */
function colorSchemeScript(): Plugin {
  return {
    name: 'color-scheme-script',
    transformIndexHtml: () => [
      { tag: 'script', children: preferencesScript([colorScheme]), injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss(), agentGuide(), colorSchemeScript()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      output: {
        // Libraries change far less often than the console: their own chunks stay cached across deploys.
        codeSplitting: {
          groups: [
            { name: 'effect', test: /[\\/]node_modules[\\/](effect|@effect)[\\/]/ },
            {
              name: 'charts',
              test: /[\\/]node_modules[\\/](@tanstack[\\/]charts|d3-[a-z-]+|internmap)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: platDevPort ?? 5173,
    strictPort: platDevPort !== undefined,
    proxy: { '/v1': { target: api, changeOrigin: false }, '/auth': { target: api, changeOrigin: false } },
  },
});
