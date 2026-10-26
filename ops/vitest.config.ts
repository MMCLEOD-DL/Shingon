import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sources, so the server's database code is the same module the test helpers use.
    alias: [
      { find: '@hf/shared', replacement: at('../packages/shared/src/index.ts') },
      { find: /^@hf\/server\/db$/, replacement: at('../apps/server/src/db/client.ts') },
      { find: /^@hf\/server\/db\/schema$/, replacement: at('../apps/server/src/db/schema/index.ts') },
    ],
  },
  test: {
    pool: 'forks',
    testTimeout: 20000,
    include: ['test/**/*.test.ts'],
  },
});
