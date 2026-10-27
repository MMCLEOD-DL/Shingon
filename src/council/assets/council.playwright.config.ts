// Written into .council/ by Conductor's council. It reuses the app's own Playwright config
// (global set-up, web server, base URL) and, when HF_COUNCIL_AXE is set, adds the two accessibility projects.
import { defineConfig } from '@playwright/test';
import appConfig from '../apps/web/playwright.config.ts';

const here = import.meta.dirname;
const axeProjects = process.env['HF_COUNCIL_AXE']
  ? [
      { name: 'council-a11y-desktop', testDir: here, testMatch: /a11y\.spec\.ts/, use: { browserName: 'chromium' as const, viewport: { width: 1280, height: 800 } } },
      { name: 'council-a11y-phone', testDir: here, testMatch: /a11y\.spec\.ts/, use: { browserName: 'chromium' as const, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
    ]
  : [];

export default defineConfig({
  ...appConfig,
  projects: [...(appConfig.projects ?? []), ...axeProjects],
});
