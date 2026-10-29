// Written into .council/ by Conductor's council. Runs axe-core (injected from Conductor's own copy,
// never added to the app) over every page in the app's screenshot registry and records the violations.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { PAGES, resolvePath, resolveReady } from '../apps/web/e2e/pages.js';
import { authFile, loadFixtures, type Fixtures } from '../apps/web/e2e/fixtures.js';

interface AxeNode { target?: unknown[] }
interface AxeViolation { id: string; impact?: string | null; help: string; nodes: AxeNode[] }

let fx: Fixtures;
test.beforeAll(async () => { fx = await loadFixtures(); });

for (const p of PAGES) {
  test(`${p.name} is scanned for accessibility problems`, async ({ browser }, info) => {
    const ctx = await browser.newContext({ ...info.project.use, bypassCSP: true, storageState: p.as === 'anon' ? undefined : authFile(p.as) });
    try {
      const page = await ctx.newPage();
      await page.goto(resolvePath(p, fx));
      await expect(page.getByRole('heading', { name: resolveReady(p, fx), exact: true }).first()).toBeVisible();
      await page.addScriptTag({ path: process.env['HF_COUNCIL_AXE'] });
      const found = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: AxeViolation[] }> } }).axe;
        const r = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, help: v.help, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(' ') ?? null }));
      });
      const out = process.env['HF_COUNCIL_OUT'] ?? path.join(import.meta.dirname, 'out');
      mkdirSync(out, { recursive: true });
      appendFileSync(path.join(out, 'a11y.jsonl'), `${JSON.stringify({ page: p.name, project: info.project.name, violations: found })}\n`);
    } finally {
      await ctx.close();
    }
  });
}
