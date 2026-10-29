import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@hf/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  test: {
    // The corpus accuracy run is slow; it runs on its own with `npm run test:ocr`.
    exclude: [...configDefaults.exclude, '**/*.accuracy.test.ts'],
  },
});
