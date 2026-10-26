import path from 'node:path';
import { test, expect } from '@playwright/test';
import { SHOTS_DIR, authFile, loadFixtures, type Fixtures } from './fixtures.js';
import { PAGES, resolvePath, resolveReady } from './pages.js';

let fx: Fixtures;
test.beforeAll(async () => { fx = await loadFixtures(); });

for (const p of PAGES) {
  test(`${p.name} works at this width`, async ({ browser }, info) => {
    const ctx = await browser.newContext({ ...info.project.use, storageState: p.as === 'anon' ? undefined : authFile(p.as) });
    try {
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => { errors.push(e.message); });
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        // A signed-out visitor is asked "who are you?" first and the answer is 401. The browser logs that as an error; it is the app working.
        // WebKit may report an empty location, so a "status of 401" message with no URL is accepted too (signed-out pages only).
        // TODO(build machine): confirm this against the real WebKit run.
        const where = m.location().url;
        if (p.as === 'anon' && m.text().includes('status of 401') && (where === '' || where.endsWith('/api/me'))) return;
        errors.push(m.text());
      });
      await page.goto(resolvePath(p, fx));
      await expect(page.getByRole('heading', { name: resolveReady(p, fx), exact: true }).first()).toBeVisible();
      // Let lists, avatars and photos finish loading before the picture is taken.
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(1);
      if (info.project.use.isMobile) {
        const small = await page.locator('main button:visible, main a[role="button"]:visible, main input:visible, header button:visible, nav a:visible').evaluateAll(
          (els) => els.filter((e) => e.getBoundingClientRect().height < 36).map((e) => e.outerHTML.slice(0, 80)));
        expect(small, 'buttons and fields too small to tap').toEqual([]);
      }
      expect(errors, 'script errors on the page').toEqual([]);
      await page.screenshot({ path: path.join(SHOTS_DIR, `${p.name}-${info.project.name}.png`), fullPage: true });
    } finally {
      await ctx.close();
    }
  });
}
