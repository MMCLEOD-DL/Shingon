import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built assets are served by the Conductor service from operator-web/dist on its own origin.
// The service serves only /assets/* and index.html, with a strict CSP (script-src 'self'): no inline
// scripts, no CDN, no source maps. There is deliberately no dev proxy: the browser must not reach the
// service from a second origin (interface.md, "Bootstrap in Claude's UI").
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false, modulePreload: { polyfill: false } },
  test: { environment: 'jsdom', include: ['tests/**/*.spec.{js,jsx}'], setupFiles: ['tests/setup.js'] },
});
