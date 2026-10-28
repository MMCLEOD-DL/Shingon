/// <reference types="node" />
/**
 * Reads app-profile.json from disk (Node only, so it is a separate entry point the web bundle never loads).
 * The server, ops and the web build all read the profile through this one function.
 */
import { readFileSync } from 'node:fs';
import { parseAppProfile, type AppProfileResult } from './modules.js';

/** A missing file gives the default profile; any other read failure is a plain problem. */
export function readAppProfile(file: string): AppProfileResult {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return parseAppProfile(null);
    return { ok: false, problems: [`app-profile.json could not be opened (${code ?? 'unknown error'}). Check that the file exists and can be read.`] };
  }
  return parseAppProfile(text);
}
