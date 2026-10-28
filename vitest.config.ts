import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { projects: ['packages/shared', 'modules/ocr', 'modules/pdf-export', 'modules/xlsx-export', 'apps/server', 'apps/web', 'ops', 'scripts', 'deploy'] },
});
