# Task 7: Interpreter for client apps

On a project build each member's interpreter needs more than Plan 5 gave it:
- the approved **brief**, rendered by Plan 7's `renderBrief` (Correctness checks coverage against it; Legal checks the data policy);
- the **data policy**, as plain lines;
- the member's own **measurements** (`ToolRun.context`): Correctness's coverage table, Design's page list, Reliability's step list;
- **screenshot paths** Design can open (`ToolRun.attach`, index Ruling 10). The screenshots already sit in the council workspace, which is the interpreter's working folder, so the prompt lists at most 40 relative paths, phone shots first. Nothing is copied.

Members stay independent. Context and attachments come only from that member's own ToolRuns.

With no brief, no context and no attachments, the prompt is **exactly** the Plan 5 prompt (Review Focus 2).

Plan 5's `FOCUS` gains `design` and `reliability`. `legal` and `correctness` get a project addition that is used only when a brief is present. The house visual system that Design judges against is the foundation's, from `/root/highland-foundation/docs/BUILDING-ON.md` ("Making it theirs", "Adding a feature"):
- pages built from the house components (`PageHeader`, `ResponsiveList`, `FormCard`, `EmptyState`, `ConfirmAction`, `FileDropzone`, `ErrorNotice`);
- one ten-shade palette from `theme.ts`;
- the system font stack (no web fonts);
- every button and field big enough to tap on a phone;
- nothing scrolls sideways;
- phone pages look finished enough to charge for.

**Files:**
- Modify: `src/prompts.js` (`FOCUS`, `FOCUS_PROJECT`, `POLICY_LINES`, `councilMember`), `src/council/interpret.js` (`interpretMember`)
- Test: `test/prompts.test.js` (append), `test/council-interpret.test.js` (append)

**Interfaces:**
- Consumes: Plan 5's `councilMember`, `interpretMember`, `callAgent`; `git`.
- Produces:
  - `prompts.councilMember({ member, label, request, plan, diff, base, tests, items, notes, briefText = null, policy = null, context = [], attachments = [] }) -> string`;
  - `interpretMember(ctx, { member, label, findings, notes, input, context = [], attach = [] })` passes `attachments = orderShots(attach)`: at most 40 paths, those containing `mobile` first, then by name;
  - `orderShots(paths) -> string[]` (exported from `src/council/interpret.js`).
  - `CouncilInput.briefText` (string | null) and `CouncilInput.policy` are read by `interpretMember` (Task 12 fills them).
  - `POLICY_LINES(policy) -> string` in `src/prompts.js`: `Hosting: the client's own box` / `a server the operator runs`; `Outside services allowed: none` or the list; `Data may be kept: in the UK` / `in the UK or EU` / `anywhere`; `Retention: <text>`; `Backups go to: <backupDestination>`; `Operator remote access: agreed`.

- [ ] **Step 1: Write the failing tests**

Append to `test/prompts.test.js`:

```js
test('councilMember with no brief is exactly the Plan 5 prompt', () => {
  const base = { member: 'legal', label: 'Legal', request: 'r', plan: null, diff: 'd', base: 'abc', tests: null, items: [], notes: [] };
  assert.equal(councilMember({ ...base, briefText: null, policy: null, context: [], attachments: [] }), councilMember(base));
  assert.doesNotMatch(councilMember(base), /brief|data policy|Screenshots/i);
});

test('councilMember on a project: brief, policy, measurements and screenshots', () => {
  const p = councilMember({ member: 'design', label: 'Design', request: 'Build the Acme app', plan: null, diff: 'd', base: 'abc', tests: null, items: [], notes: [],
    briefText: '# Acme Ltd\n\nMileage claims…', policy: { hosting: 'client-box', outbound: [], residency: 'uk', retention: { text: 'six years', days: 2190 }, backupDestination: 'client-nas', operatorAccess: true },
    context: ['Pages checked: 13 at desktop and phone width.'], attachments: ['reports/screenshots/notes-mobile-chromium.png'] });
  assert.match(p, /The client's approved brief:\n# Acme Ltd/);
  assert.match(p, /The client's data policy:\nHosting: the client's own box\nOutside services allowed: none\nData may be kept: in the UK\nRetention: six years\nBackups go to: client-nas\nOperator remote access: agreed/);
  assert.match(p, /What the checks measured:\n- Pages checked: 13 at desktop and phone width\./);
  assert.match(p, /Screenshots you can open \(read them, do not change them\):\n- reports\/screenshots\/notes-mobile-chromium\.png/);
  assert.match(p, /PageHeader, ResponsiveList, FormCard, EmptyState, ConfirmAction, FileDropzone, ErrorNotice/);
  assert.match(p, /A problem you see only in a screenshot can be a warning, never blocking/);
});

test('Reliability and the project versions of Legal and Correctness say what to look for', () => {
  const at = (member, briefText) => councilMember({ member, label: member, request: 'r', plan: null, diff: '', base: 'a', tests: null, items: [], notes: [], briefText });
  assert.match(at('reliability', 'b'), /backup, restore, alerts and updates/);
  assert.match(at('legal', 'b'), /outside services, residency, retention and personal data against the data policy and UK GDPR basics/);
  assert.match(at('correctness', 'b'), /every feature and worked example in the brief/);
  assert.doesNotMatch(at('legal', null), /UK GDPR/);
});
```

Append to `test/council-interpret.test.js`:
- `orderShots` puts phone shots first and keeps 40 of 45 paths;
- `interpretMember` with `attach: ['reports/screenshots/a-desktop-chromium.png', 'reports/screenshots/a-mobile-chromium.png']` and `context: ['x']`, plus a fake reviewer that records its prompt. The prompt lists the mobile path before the desktop path, and contains `What the checks measured:\n- x`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/prompts.test.js test/council-interpret.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `FOCUS.design`: `Judge the screenshots of every page, at desktop and phone width, against the house visual system: <the bullets above, as one paragraph>. The page checks (sideways scrolling, buttons too small to tap, script errors, a page that does not load) are facts. The accessibility results are measurements. A problem you see only in a screenshot can be a warning, never blocking. Flag clunky flows (too many steps, unclear labels, nothing that says what to do next).`
- `FOCUS.reliability`: `Check the reliability test of the deployed app: deploy, backup, restore, alerts and updates (an update that fails must undo itself). A failed step is a fact: explain what it means for the client's data and what to fix.`
- `FOCUS_PROJECT.legal` (appended when `briefText`): `Also check the app's outside services, residency, retention and personal data against the data policy and UK GDPR basics. A destination the policy does not allow is blocking unless it is a false alarm (a link in a comment, an example address): say why if you set it aside. Retention and personal-data concerns are warnings or notes.`
- `FOCUS_PROJECT.correctness`: `Also check every feature and worked example in the brief is built and proven by a passing test, and look for untested paths around money (totals, VAT, rounding, pence) and permissions (who may see, edit or approve).`
- Sections, inserted after the request/plan block, each only when present: `The client's approved brief:\n${show(briefText, 8000)}`, `The client's data policy:\n${POLICY_LINES(policy)}`. Then, after the tool items: `What the checks measured:\n- …` and `Screenshots you can open (read them, do not change them):\n- …`.
- `interpretMember`: pass `briefText: input.briefText ?? null`, `policy: input.policy ?? null`, `context` and `attachments: orderShots(attach)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS, including every existing prompt and interpreter test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.js src/council/interpret.js test/prompts.test.js test/council-interpret.test.js
git commit -m "feat(council): brief, data policy, measurements and screenshots in the interpreter prompt for client apps"
```
