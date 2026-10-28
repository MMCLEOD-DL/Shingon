import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../../packages/shared/src/modules.js';
import { readAppProfile } from '../../packages/shared/src/appProfileFile.js';

// The optional modules this build includes, from the app's own app-profile.json (no file: none).
// HF_ALL_MODULES=1 builds every module in, for the browser tests.
const profile = readAppProfile(fileURLToPath(new URL('../../app-profile.json', import.meta.url)));
if (!profile.ok) throw new Error(`The web app cannot be built:\n- ${profile.problems.join('\n- ')}`);
const modules = process.env['HF_ALL_MODULES'] === '1' ? [...MODULES] : profile.profile.modules;

export default defineConfig({
  plugins: [react()],
  define: { __HF_MODULES__: JSON.stringify(modules) },
  resolve: { alias: { '@hf/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist', sourcemap: false },
});
