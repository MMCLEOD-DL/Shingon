// src/council/project.js
// Turns the hook's arguments (index A1) into the context a project council round needs:
// the build folder, the client, the foundation pin from project.json (or, for a foundation upgrade, the release Plan 8
// passes in change mode), and Plan 8's checks (or null).
import path from 'node:path';

export async function projectContext(args, { loadProject, ids } = {}) {
  loadProject ??= (await import('../factory/projects.js')).loadProject;
  ids ??= await import('../factory/ids.js');
  const { projectDir, appDir, sha, brief, runId, slug } = args;
  if (!ids.SLUG_RE.test(String(slug))) throw new Error(`The project name "${slug}" cannot be used in a folder name.`);
  if (!ids.RUN_ID_RE.test(String(runId))) throw new Error(`The run id "${runId}" cannot be used in a folder name.`);
  const project = await loadProject(projectDir);
  // Plan 8 in change mode passes the foundation release a foundation upgrade brings in: its tag and commit replace
  // project.json's (which still names the old release until the upgrade is approved); the repo stays project.json's.
  const pinned = project.foundation ?? {};
  const given = args.foundation;
  const f = given && typeof given === 'object' && !Array.isArray(given) && typeof given.tag === 'string' && typeof given.commit === 'string'
    ? { repo: pinned.repo, tag: given.tag, commit: given.commit }
    : pinned;
  return {
    slug, runId, projectDir, appDir, sha,
    buildDir: path.join(projectDir, 'builds', runId),
    brief,
    policy: args.policy ?? brief?.policy ?? null,
    client: project.client ?? brief?.client ?? null,
    foundation: { repo: f.repo, tag: f.tag, commit: f.commit },
    checks: args.checks ?? null,
    problem: null,
  };
}
