import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sources of the workspaces the server uses.
    alias: [
      { find: /^@hf\/shared$/, replacement: at('../../packages/shared/src/index.ts') },
      { find: /^@hf\/shared\/app-profile-file$/, replacement: at('../../packages/shared/src/appProfileFile.ts') },
      { find: /^@hf\/ocr$/, replacement: at('../../modules/ocr/src/index.ts') },
      { find: /^@hf\/pdf-export$/, replacement: at('../../modules/pdf-export/src/index.ts') },
      { find: /^@hf\/xlsx-export$/, replacement: at('../../modules/xlsx-export/src/index.ts') },
    ],
  },
  test: {
    pool: 'forks',
    testTimeout: 20000,
    include: ['test/**/*.test.ts'],
  },
});
