import tseslint from 'typescript-eslint';

const ROUTE_SELECTOR =
  'CallExpression[callee.object.name=/^(app|fastify|instance|server)$/][callee.property.name=/^(get|post|put|patch|delete|head|options|all|route)$/]';

export default tseslint.config(
  { ignores: ['**/dist/**', 'apps/web/e2e/**/*.png', '**/node_modules/**', '**/vitest.config.ts', 'vitest.config.ts', 'eslint.config.js', '**/*.cjs'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/http/route.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: ROUTE_SELECTOR,
          message: 'Register routes with defineRoute (src/http/route.ts), not directly on the Fastify instance.',
        },
      ],
    },
  },
  {
    // Tests read untyped JSON replies and assert on rows they know exist.
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // fetch stubs are async to return a Promise, as the real fetch does.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
