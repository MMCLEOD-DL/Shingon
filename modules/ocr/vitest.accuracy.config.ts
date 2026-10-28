import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/** `npm run test:ocr`: the receipt corpus through the local engine and the extraction (Ruling 2). Reports go to `reports/`. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: { '@hf/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  test: {
    include: ['test/**/*.accuracy.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
