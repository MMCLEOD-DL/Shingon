import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@hf/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  test: {
    pool: 'forks',
    testTimeout: 20000,
    include: ['test/**/*.test.ts'],
  },
});
