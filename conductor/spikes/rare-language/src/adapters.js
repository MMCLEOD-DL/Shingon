// Language adapters. Each one checks one attempt in its own empty folder and returns
// { status, ms, output }, where status is:
//   pass          compiled and every test passed
//   test-fail     compiled, but a test failed
//   compile-fail  did not compile
//   error         the checker itself failed or timed out, so the attempt says nothing about the model
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from './process.js';

export const STATUSES = ['pass', 'test-fail', 'compile-fail', 'error'];

// The stand-in: CommonJS JavaScript checked by this Node. It proves the loop end to end where no Urbit exists.
export function nodeAdapter({ timeoutMs = 30000 } = {}) {
  return {
    name: 'node',
    language: 'JavaScript (CommonJS)',
    solutionFile: 'solution.cjs',
    testsFile: 'check.cjs',
    async check({ code, tests, workDir }) {
      mkdirSync(workDir, { recursive: true });
      writeFileSync(path.join(workDir, 'solution.cjs'), code);
      writeFileSync(path.join(workDir, 'check.cjs'), tests);
      const syntax = await runProcess(process.execPath, ['--check', 'solution.cjs'], { cwd: workDir, timeoutMs });
      if (syntax.timedOut || syntax.spawnError) return { status: 'error', ms: syntax.ms, output: syntax.output };
      if (syntax.code !== 0) return { status: 'compile-fail', ms: syntax.ms, output: syntax.output };
      const run = await runProcess(process.execPath, ['check.cjs'], { cwd: workDir, timeoutMs });
      const ms = syntax.ms + run.ms;
      if (run.timedOut || run.spawnError) return { status: 'error', ms, output: run.output };
      return { status: run.code === 0 ? 'pass' : 'test-fail', ms, output: run.output };
    },
  };
}

// A configured command, for any language with a command-line check. The command gets the attempt's folder, which
// holds the solution and tests under the configured names, and answers with its exit code.
const PLACEHOLDERS = ['{dir}', '{solution}', '{tests}'];

export function commandAdapter(config) {
  const { name, language, solutionFile, testsFile, command, timeoutMs = 300000, exitCodes = {} } = config ?? {};
  const codes = { pass: 0, testFail: 1, compileFail: 2, ...exitCodes };
  for (const [key, value] of [['name', name], ['language', language], ['solutionFile', solutionFile], ['testsFile', testsFile]]) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`The adapter configuration needs "${key}".`);
  }
  for (const file of [solutionFile, testsFile]) {
    if (path.basename(file) !== file || file.startsWith('.')) throw new Error(`"${file}" must be a plain file name.`);
  }
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === 'string' && a !== '')) {
    throw new Error('The adapter configuration needs "command": a list of strings, run without a shell.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('"timeoutMs" must be a positive whole number.');
  const fill = (arg, workDir) => arg
    .replaceAll('{dir}', workDir)
    .replaceAll('{solution}', path.join(workDir, solutionFile))
    .replaceAll('{tests}', path.join(workDir, testsFile));
  return {
    name,
    language,
    solutionFile,
    testsFile,
    placeholders: PLACEHOLDERS,
    async check({ code, tests, workDir }) {
      mkdirSync(workDir, { recursive: true });
      writeFileSync(path.join(workDir, solutionFile), code);
      writeFileSync(path.join(workDir, testsFile), tests);
      const [cmd, ...args] = command.map((a) => fill(a, workDir));
      const r = await runProcess(cmd, args, { cwd: workDir, timeoutMs });
      if (r.timedOut || r.spawnError) return { status: 'error', ms: r.ms, output: r.output };
      const status = r.code === codes.pass ? 'pass'
        : r.code === codes.testFail ? 'test-fail'
          : r.code === codes.compileFail ? 'compile-fail'
            : 'error';
      return { status, ms: r.ms, output: r.output };
    },
  };
}

// --lang is "node" for the stand-in, or the path of a command adapter's JSON configuration.
export function loadAdapter(lang) {
  if (lang === 'node') return nodeAdapter();
  let config;
  try { config = JSON.parse(readFileSync(lang, 'utf8')); } catch (e) { throw new Error(`Could not read the adapter configuration ${lang}: ${e.message}`); }
  return commandAdapter(config);
}
