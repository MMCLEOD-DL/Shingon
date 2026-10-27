import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { saveApprovedBrief } from '../src/factory/brief.js';
import { FACTORY_COMMANDS } from '../src/cli/factory.js';
import { newSession, saveSession } from '../src/factory/briefSession.js';
import { approvedBrief } from './helpers/briefFixtures.js';

import { tmp, runMain, envFor } from './helpers/factoryCli.js';

// Plans 8, 10 and 11 add entries, so this checks Plan 7's four by name, never the whole table.
test('FACTORY_COMMANDS holds the Plan 7 handlers', () => {
  for (const k of ['project-new', 'project-list', 'project-show', 'brief']) assert.equal(typeof FACTORY_COMMANDS[k], 'function', k);
  assert.equal(Object.hasOwn(FACTORY_COMMANDS, 'run'), false, 'ordinary runs still go through the git-repo path');
});

test('a handler that returns null falls through to the ordinary path (Contract 7 §7.11)', async () => {
  FACTORY_COMMANDS.runs = async () => null;            // stand-in for Plan 8's resume handler
  try {
    const r = await runMain(['runs'], { env: envFor(tmp()) });
    assert.equal(r.code, 64);
    assert.match(r.out, /git repository/, 'main carried on to its usual "inside a git repository" check');
  } finally { delete FACTORY_COMMANDS.runs; }
});

test('ctx.config is the loaded config when it has participants, else null (Contract 7 §7.11)', async () => {
  const seen = [];
  const orig = FACTORY_COMMANDS['project-list'];
  FACTORY_COMMANDS['project-list'] = async (cli, ctx) => { seen.push(ctx); return orig(cli, ctx); };
  try {
    const cfg = path.join(tmp(), 'c.json');
    writeFileSync(cfg, JSON.stringify({ factory: { operatorName: 'Malcolm' } }));
    await runMain(['project', 'list', '--config', cfg], { env: envFor(tmp()) });
    writeFileSync(cfg, JSON.stringify({ participants: [], factory: { operatorName: 'Malcolm' } }));
    await runMain(['project', 'list', '--config', cfg], { env: envFor(tmp()) });
  } finally { FACTORY_COMMANDS['project-list'] = orig; }
  assert.equal(seen[0].config, null);
  assert.deepEqual(seen[1].config.participants, []);
  assert.equal(seen[1].factory.operatorName, 'Malcolm');
  for (const k of ['cwd', 'env', 'stdin', 'stdout', 'isTTY', 'onSignal', 'exit', 'factory', 'config', 'deps']) assert.ok(k in seen[1], k);
});

test('project new / list / show work outside a git repository, without a config', async () => {
  const root = path.join(tmp(), 'projects');
  const env = envFor(root);
  const none = await runMain(['project', 'list'], { env });
  assert.equal(none.code, 0);
  assert.match(none.out, /No projects yet\. Make one with: conductor project new "<client name>"/);

  const made = await runMain(['project', 'new', 'Thistle Joinery Ltd', '--slug', 'thistle'], { env });
  assert.equal(made.code, 0, made.out);
  assert.match(made.out, /Made project thistle for "Thistle Joinery Ltd" in .*projects\/thistle\nNext: conductor brief thistle --notes <your meeting notes>/);
  const dup = await runMain(['project', 'new', 'Thistle', '--slug', 'thistle'], { env });
  assert.equal(dup.code, 1);
  assert.match(dup.out, /A project called thistle already exists/);

  await runMain(['project', 'new', 'Acme'], { env });
  const dir = path.join(root, 'thistle');
  saveSession(dir, newSession({ slug: 'thistle', mode: 'new', notes: [], now: new Date('2026-10-27T10:00:00Z') }));
  let list = await runMain(['project', 'list'], { env });
  assert.match(list.out, /acme +Acme +briefing +no brief yet/);
  assert.match(list.out, /thistle +Thistle Joinery Ltd +briefing +brief unfinished \(run: conductor brief thistle\)/);

  saveApprovedBrief(dir, approvedBrief());
  list = await runMain(['project', 'list'], { env });
  assert.match(list.out, /thistle +Thistle Joinery Ltd +briefing +brief v1 approved 27 October 2026; a new version is unfinished/);

  const show = await runMain(['project', 'show', 'thistle'], { env });
  assert.equal(show.code, 0);
  for (const re of [/^Thistle Joinery Ltd \(thistle\)$/m, /^Folder: .*projects\/thistle$/m, /^Status: briefing$/m, /^Created: \d{1,2} [A-Z][a-z]+ \d{4}$/m,
    /^Foundation: not chosen yet \(set when the app is first built\)$/m, /^Approved build: none yet$/m, /^Brief: version 1, approved by Malcolm on 27 October 2026$/m,
    /^ {2}Read it: .*brief-v1\.md$/m, /^Unfinished brief: waiting at the first draft\. Carry on with: conductor brief thistle$/m]) assert.match(show.out, re);
  const missing = await runMain(['project', 'show', 'nope'], { env });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /There is no project called "nope"/);
  const bad = await runMain(['project', 'show', '../etc'], { env });
  assert.equal(bad.code, 64);
  assert.match(bad.out, /is not a usable folder name/);
});

test('a bad factory section in the config is a plain usage error', async () => {
  const cfg = path.join(tmp(), 'c.json');
  writeFileSync(cfg, JSON.stringify({ participants: [], factory: { projectsRoot: 'relative' } }));
  const env = { ...process.env, XDG_CONFIG_HOME: tmp(), HOME: tmp() };
  delete env.CONDUCTOR_PROJECTS_ROOT;
  const r = await runMain(['project', 'list', '--config', cfg], { env });
  assert.equal(r.code, 64);
  assert.match(r.out, /Conductor could not read its config: factory\.projectsRoot must be a full path/);
  const gone = await runMain(['project', 'list', '--config', '/nope/c.json'], { env });
  assert.equal(gone.code, 64);
  assert.match(gone.out, /No config file at \/nope\/c\.json/);
});
