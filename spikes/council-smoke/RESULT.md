# Council smoke — result

**Status:** NOT YET RUN (operator runs `! bash spikes/council-smoke/run-council-smoke.sh`)

## Run
- Date:
- `doctor` council section (✓/✗ per tool):
- Outcome (exit code / branch):
- Council rounds used / fix steps:
- Elapsed, and frontier cost shown:

## Observations
- Did Security block the new eval(), and did the fix step remove it? (If the model or the step reviewer avoided eval in the first place, note that: the council then had nothing to block.)
- Did the old eval() in old.js and the old GPL dependency show as "already there" warnings, with no fix step for them?
- If the model also edited old.js, did its old eval() line still show as "already there"?
- Did the council report at the gate read like a consultant's note, not a scanner dump?
- Was the status line clear while the council ran (which member, which round)?
- Any "Checks that did not run"? Were the reasons clear?

## Operator follow-ups (outside the code)
- Install the council tools on the machine that runs Conductor: `pipx install semgrep`; the Gitleaks
  release binary; optionally `pipx install scancode-toolkit` (slow; changed files only). npm is already there.
- Semgrep `p/default` downloads its rules from semgrep.dev on each run. No code is uploaded, and metrics
  are off. To run fully offline, save the rules to a local file and set `councilSemgrepConfig`.
- `npm audit` sends package names and versions (not code) to registry.npmjs.org.
- Gitleaks 8.19+ prefers `gitleaks dir`. Check that the installed version still accepts
  `detect --no-git --source .` (the smoke's doctor plus a run shows it).
- Licence rule (spec §5a): check it with a solicitor before the first contract. Decide per client
  project which licences, if any, go in `councilAcceptLicences`.
- Operator Questions: the plan's defaults were kept (decided): problems that were already there,
  including an old GPL or unlicensed dependency, only warn on ordinary repos; the permissive/copyleft
  licence list stands; and a package with no licence may be accepted per project with `name@version`.
- Cost: each council round adds one reviewer call for Correctness, plus one each for Security
  and Legal when their tools found something. That is at most 4 rounds.
- Packaging for others is still out of scope: **notify the operator before going live as a product**.
