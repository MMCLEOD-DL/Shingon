import { test, expect } from '@playwright/test';
import { MODULES } from '@hf/shared';
import { appPathsFor } from '../src/appPaths.js';
import { PAGES } from './pages.js';

// The browser tests build the app with every module on (HF_ALL_MODULES=1), so every module's pages must be in the registry too.
test('every app path has at least one page in the screenshot registry', () => {
  const covered = new Set<string>(PAGES.map((p) => p.route));
  const missing = appPathsFor(MODULES).map((p) => p.path).filter((p) => p !== '/' && !covered.has(p));
  expect(missing, 'Add these pages to apps/web/e2e/pages.ts').toEqual([]);
});
