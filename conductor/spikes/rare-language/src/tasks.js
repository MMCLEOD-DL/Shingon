// A task is a folder: task.json (id, title, prompt), the tests file, and optionally a reference solution.
// The file names come from the language adapter, so the same task format serves every language. An optional wrong
// solution (wrong + the solution's extension) compiles but fails the tests: Stage 0 uses it to prove the checker
// really runs the tests. Line endings are read as LF whatever the checkout did, since some compilers refuse CR.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const toLf = (s) => s.replace(/\r\n?/g, '\n');
const readLf = (file) => toLf(readFileSync(file, 'utf8'));

export function loadTasks(dir, { solutionFile, testsFile }) {
  if (!existsSync(dir)) throw new Error(`No task folder at ${dir}.`);
  const tasks = [];
  for (const name of readdirSync(dir).sort()) {
    const folder = path.join(dir, name);
    if (!statSync(folder).isDirectory()) continue;
    const metaFile = path.join(folder, 'task.json');
    if (!existsSync(metaFile)) throw new Error(`Task ${name} has no task.json.`);
    let meta;
    try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch (e) { throw new Error(`Task ${name}: task.json is not valid JSON (${e.message}).`); }
    if (meta.id !== name || !ID_RE.test(meta.id)) throw new Error(`Task ${name}: its id must match the folder name and use a-z, 0-9 and -.`);
    if (typeof meta.prompt !== 'string' || meta.prompt.trim() === '') throw new Error(`Task ${name} has no prompt.`);
    const testsPath = path.join(folder, testsFile);
    if (!existsSync(testsPath)) throw new Error(`Task ${name} has no ${testsFile}.`);
    const solutionPath = path.join(folder, solutionFile);
    const wrongPath = path.join(folder, `wrong${path.extname(solutionFile)}`);
    tasks.push({
      id: meta.id,
      title: typeof meta.title === 'string' ? meta.title : meta.id,
      prompt: meta.prompt.trim(),
      tests: readLf(testsPath),
      reference: existsSync(solutionPath) ? readLf(solutionPath) : null,
      wrong: existsSync(wrongPath) ? readLf(wrongPath) : null,
    });
  }
  if (tasks.length === 0) throw new Error(`No tasks in ${dir}.`);
  return tasks;
}
