// src/cli/config.js
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function findConfig({ flag = null, cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  if (flag) {
    const p = path.resolve(cwd, flag);
    if (!existsSync(p)) throw new Error(`No config file at ${p}.`);
    return p;
  }
  const places = [path.join(cwd, 'conductor.json')];
  if (env.XDG_CONFIG_HOME) places.push(path.join(env.XDG_CONFIG_HOME, 'conductor', 'config.json'));
  places.push(path.join(home, '.config', 'conductor', 'config.json'));
  const found = places.find((p) => existsSync(p));
  if (found) return found;
  throw new Error(`No Conductor config found. Looked in:\n${places.map((p) => `  - ${p}`).join('\n')}\n` +
    'Copy config.example.json from the Conductor folder to one of these places and edit it.');
}
