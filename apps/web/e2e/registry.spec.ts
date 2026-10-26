import { test, expect } from '@playwright/test';
import { APP_PATHS } from '../src/appPaths.js';
import { PAGES } from './pages.js';

test('every app path has at least one page in the screenshot registry', () => {
  const covered = new Set<string>(PAGES.map((p) => p.route));
  const missing = APP_PATHS.map((p) => p.path).filter((p) => p !== '/' && !covered.has(p));
  expect(missing, 'Add these pages to apps/web/e2e/pages.ts').toEqual([]);
});
