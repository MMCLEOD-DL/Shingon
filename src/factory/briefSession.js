// src/factory/briefSession.js — durable brief session state and verbatim notes intake (Plan 7, Task 6).
// No locking here: the CLI handler holds lockProject(dir, 'brief') around every call.
import { statSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, writeFileAtomic, createFileExclusive } from './fsAtomic.js';
import { briefPaths, renderBrief } from './brief.js';

export const NOTES_FILE_MAX = 100_000;

export function importNotes(projectDir, notesFile, { now = new Date() } = {}) {
  const abs = path.resolve(notesFile);
  let st;
  try { st = statSync(abs); } catch { throw new Error(`There is no notes file at ${abs}.`); }
  if (st.isDirectory()) throw new Error(`${abs} is a folder, not a notes file.`);
  if (!st.isFile()) throw new Error(`${abs} is not a notes file.`);
  if (st.size > NOTES_FILE_MAX) {
    throw new Error(`The notes file is too big (${Math.ceil(st.size / 1024)} KB; the limit is ${Math.floor(NOTES_FILE_MAX / 1024)} KB). Split it or trim it.`);
  }
  const bytes = readFileSync(abs);
  if (bytes.includes(0)) throw new Error(`${abs} does not look like text (it has binary data in it).`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    throw new Error(`${abs} is not UTF-8 text. Save it as UTF-8 and try again.`);
  }
  if (!text.trim()) throw new Error('The notes file is empty.');

  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const base = path.basename(abs).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'notes.txt';
  for (let n = 1; n <= 9; n++) {
    const name = `notes/${stamp}-${n === 1 ? '' : `${n}-`}${base}`;
    try {
      createFileExclusive(path.join(projectDir, name), bytes, { mode: 0o600 });
      return { name, bytes: bytes.length };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Too many notes files were added in the same second. Wait a moment and try again.');
}

export function readNotes(projectDir, names) {
  return names.map((name) => {
    if (typeof name !== 'string' || !/^notes\/[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
      throw new Error(`"${name}" is not one of this project's notes files.`);
    }
    return { name, text: readFileSync(path.join(projectDir, name), 'utf8') };
  });
}

export function newSession({ slug, mode, baseVersion = null, notes, now = new Date() }) {
  return {
    schema: 1, slug, mode, baseVersion, notes, stage: 'draft', draft: null, pending: [], answers: [],
    changeRequests: [], problems: [], attempts: 0, rounds: 0, costUsd: 0, approving: null,
    startedAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function sessionProblem(s, slug) {
  if (!isObj(s)) return 'it is not a saved session';
  if (s.schema !== 1) return 'it was saved by a different version';
  if (s.slug !== slug) return `it belongs to ${s.slug}`;
  if (!['draft', 'questions', 'approve'].includes(s.stage)) return `unknown stage "${s.stage}"`;
  if (!['new', 'revise'].includes(s.mode)) return `unknown mode "${s.mode}"`;
  for (const k of ['notes', 'pending', 'answers', 'changeRequests', 'problems']) {
    if (!Array.isArray(s[k])) return `${k} is missing`;
  }
  for (const k of ['attempts', 'rounds', 'costUsd']) {
    if (!Number.isFinite(s[k])) return `${k} is missing`;
  }
  if (s.draft !== null && !isObj(s.draft)) return 'the draft is damaged';
  if (s.approving !== null && !(isObj(s.approving) && Number.isInteger(s.approving.version))) return 'the approval marker is damaged';
  return null;
}

export function loadSession(projectDir, slug) {
  const file = briefPaths(projectDir).session;
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let s;
  let why;
  try { s = JSON.parse(raw); why = sessionProblem(s, slug); } catch { why = 'it is not valid JSON'; }
  if (why) {
    throw new Error(`The unfinished brief for ${slug} could not be read (${why}). Run conductor brief ${slug} --discard-draft to start again.`);
  }
  return s;
}

export function saveSession(projectDir, session, { now = new Date() } = {}) {
  const paths = briefPaths(projectDir);
  session.updatedAt = now.toISOString();
  writeJsonAtomic(paths.session, session);
  if (session.draft) writeFileAtomic(paths.draftMd, renderBrief(session.draft));
}

export function discardSession(projectDir) {
  const paths = briefPaths(projectDir);
  rmSync(paths.session, { force: true });
  rmSync(paths.draftMd, { force: true });
}
