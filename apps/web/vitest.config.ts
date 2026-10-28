import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../../packages/shared/src/modules.js';

export default defineConfig({
  plugins: [react()],
  // The unit tests see every optional module built in, as the browser tests do (HF_ALL_MODULES=1).
  define: { __HF_MODULES__: JSON.stringify(MODULES) },
  resolve: { alias: { '@hf/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
  },
});
