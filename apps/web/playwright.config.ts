import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '../..');
// Set here, in the main process, before the app and the test workers start, so they all see the same folder.
process.env['HF_E2E_MAIL_DIR'] ??= path.join(tmpdir(), 'hf-e2e-mail');

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } as const;

export default defineConfig({
  testDir: path.join(import.meta.dirname, 'e2e'),
  outputDir: path.join(root, 'test-results'),
  globalSetup: path.join(import.meta.dirname, 'e2e/global-setup.ts'),
  // The journeys run in order inside a project, and the projects share one database, so keep the run modest.
  workers: 3,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4319', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', testMatch: /(responsive|flows|registry)\.spec\.ts/, use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'mobile-chromium', testMatch: /(responsive|flows)\.spec\.ts/, use: { browserName: 'chromium', ...phone } },
    // WebKit is the closest thing to iPhone Safari that runs here; it only runs the page gate.
    { name: 'mobile-webkit', testMatch: /responsive\.spec\.ts/, use: { browserName: 'webkit', ...phone } },
  ],
  webServer: {
    command: 'node --import tsx apps/server/src/e2e-server.ts',
    cwd: root,
    url: 'http://localhost:4319/sign-in',
    reuseExistingServer: false,
    // Playwright's default is to kill the server outright; SIGTERM lets it drop its database and upload folder.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
