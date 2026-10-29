// Feature requests built by code from the brief, and the fixed first step ("Acceptance tests") of each feature run.
import { clip } from '../text.js';
import { testTag } from './acceptance.js';
import { OUTBOUND_SERVICES } from './outbound.js';

export const REQUEST_BUDGET = 7000; // prompts.js clips every request at 8000; stay well inside it

export const BUILDING_ON_RULES = `Foundation rules. This app is built on the Highland foundation: read docs/BUILDING-ON.md before you start and copy the notes feature.
- Shared schemas in packages/shared/src/schemas.ts with z.strictObject; build the update schema from a base with no defaults.
- One table per record type with owner_id and team_id set from the signed-in actor, never from the request; then npm -w @hf/server run db:generate and commit the migration.
- An actor-first repository: every query filters with visibleTo; not seen means 404, seen but not allowed means 403; validate list cursors; no audit row for a change that changes nothing.
- Routes only through defineRoute with a permission; new permissions go in PERMISSIONS in packages/shared/src/access.ts. Never add a role.
- Audit in the same transaction, recording field names only.
- Crossing cases by hand in apps/server/test/crossing/cases.ts (EXPECTED_ROLES typed by hand, forbiddenFields, paginate), a resource seeder in apps/server/test/crossing/resources/, and oracle.ts updated by hand when visibility changes.
- Pages from the house components in apps/web/src/ui, a route in routes.tsx, an APP_PATHS entry, a PAGES entry in apps/web/e2e/pages.ts, and a NAV entry if it belongs in the menu.
- A demo seeder in apps/server/src/seed/seeders/ using ctx.faker.
- Money in whole pence with the rounding rule written as a test; dates stored in UTC and shown in Europe/London.
- Never edit foundation.json, the crossing harness (harness.ts, world.ts, report.ts), the licence check, the lint or test configs, or the verify script. Never skip or focus a test.
- npm run verify is the test command and must pass when the feature is finished.`;

export function briefFeatureOf(brief, id) {
  return (brief.features ?? []).find((f) => f.id === id) ?? null;
}

// Found by the example's stable id, never its position.
export function exampleById(brief, id) {
  for (const feature of brief.features ?? []) {
    const example = (feature.acceptance ?? []).find((e) => e?.id === id);
    if (example) return { feature, example };
  }
  return null;
}

const sentence = (e) => `Given ${clip(e.given, 300)}, when ${clip(e.when, 300)}, then ${clip(e.then, 300)}`;

function exampleLines(brief, ids) {
  return ids.flatMap((id) => {
    const found = exampleById(brief, id);
    return found ? [`- ${testTag(id)} ${sentence(found.example)}`] : [];
  });
}

const HOSTING = { 'client-box': "the client's own box" };

function policyLine(brief) {
  const p = brief.policy ?? {};
  const hosting = HOSTING[p.hosting] ?? 'a server the operator runs';
  const outbound = (p.outbound ?? []).map((id) => `${OUTBOUND_SERVICES[id]?.label ?? id} (${id})`);
  const where = outbound.length ? `data may go only to ${outbound.join(', ')}` : 'data goes nowhere outside the app (no outside services)';
  const country = { uk: 'the UK', 'uk-eu': 'the UK or EU' }[p.residency] ?? 'any country';
  return `Data policy: hosting on ${hosting}; ${where}; data stays in ${country}.`;
}

const CLIPPED_NOTE = '\n(clipped)';

// A fix unit's instructions come from check output, the council or the operator, not from the split that
// checked every feature's request against the budget, so they are clipped to the room the rest of the request
// leaves (render, measure, clip) rather than refused: a refusal there would fail every run of the build.
export function featureRequest({ brief, units, index }) {
  const unit = units[index];
  const text = renderRequest({ brief, units, index, instructions: unit.instructions });
  if (text.length <= REQUEST_BUDGET) return text;
  if (unit.kind === 'fix') {
    const instructions = String(unit.instructions ?? '');
    const rest = text.length - instructions.length;
    // clip() adds a marker line of its own; shrink until the whole request fits.
    for (let room = REQUEST_BUDGET - rest - CLIPPED_NOTE.length; room > 0; room -= 40) {
      const clipped = renderRequest({ brief, units, index, instructions: `${clip(instructions, room)}${CLIPPED_NOTE}` });
      if (clipped.length <= REQUEST_BUDGET) return clipped;
    }
  }
  throw Object.assign(new Error(`the request for "${unit.id}" is ${text.length} characters (the limit is ${REQUEST_BUDGET}); make its instructions shorter or split it`), { code: 'too-long' });
}

function renderRequest({ brief, units, index, instructions }) {
  const unit = units[index];
  const blocks = [];
  blocks.push(`Build step ${index + 1} of ${units.length} for ${brief.client}: ${unit.title} (${unit.id})`);
  blocks.push(`About the app: ${clip(brief.purpose, 600)}`);
  blocks.push(['People who use it (each maps to a foundation role):',
    ...(brief.roles ?? []).map((r) => `- ${r.name} → ${r.mapsTo}: ${clip(r.whatTheyDo, 160)}`)].join('\n'));
  blocks.push(`What to build in this step:\n${instructions}`);
  const covered = (unit.covers ?? []).map((id) => briefFeatureOf(brief, id)).filter(Boolean);
  if ((unit.covers ?? []).length) {
    blocks.push(["From the client's brief:", ...covered.flatMap((f) => [
      `- ${f.title} (${f.id}): ${clip(f.story, 700)}`,
      `  Used by: ${(f.roles ?? []).join(', ')}. Records: ${(f.data ?? []).join(', ')}.`,
    ])].join('\n'));
  }
  if ((unit.acceptance ?? []).length) {
    blocks.push(['Worked examples (each must become a test whose name contains its tag; step 1 writes them):',
      ...exampleLines(brief, unit.acceptance)].join('\n'));
  }
  const before = units.slice(0, index).map((u) => u.id);
  const after = units.slice(index + 1).map((u) => u.id);
  blocks.push(`Already built (read the code, do not rebuild): ${before.join(', ') || 'nothing yet'}\nComing later (do not build now): ${after.join(', ') || 'nothing'}`);
  blocks.push(policyLine(brief));
  blocks.push(BUILDING_ON_RULES);
  return blocks.join('\n\n');
}

export function acceptanceStep({ brief, unit }) {
  const ids = unit.acceptance ?? [];
  if (!ids.length) return null;
  const lines = exampleLines(brief, ids);
  const instructions = `Write the acceptance tests for "${unit.title}" and nothing else: one test per worked example below, with its tag in square brackets in the test's name, for example it('${testTag(ids[0])} …'). Server behaviour goes in apps/server/test/${unit.id}/ as integration tests against the API, like apps/server/test/notes.test.ts; pure calculations may be unit tests beside them. Use the exact values from the examples (money in whole pence). Do not write any feature code. Do not skip, focus or mark any test as todo. These tests are expected to FAIL now, because the feature does not exist yet; the later steps make them pass.
Reviewer: do not block because these tests fail. Block if an example is missing or encoded wrongly, if a tag is missing, or if anything other than tests was changed.
Examples:
${lines.join('\n')}`;
  return { title: 'Acceptance tests', instructions };
}
