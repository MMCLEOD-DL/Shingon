// src/factory/config.js — the factory section of the config (Contract 7 §7.1).
// Later plans extend factoryConfig with their own sections; unknown keys are left alone.
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

export const DEFAULT_PROJECTS_ROOT = '~/highland-projects';

function safeUserName() {
  try { return userInfo().username; } catch { return ''; }
}

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

export function factoryConfig(config, { env = process.env, home = homedir(), user = safeUserName() } = {}) {
  const section = config?.factory ?? {};
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error('the config\'s "factory" section must be an object');
  }
  const rawRoot = env.CONDUCTOR_PROJECTS_ROOT || section.projectsRoot || DEFAULT_PROJECTS_ROOT;
  const projectsRoot = typeof rawRoot === 'string' ? expandHome(rawRoot, home) : rawRoot;
  if (typeof projectsRoot !== 'string' || !path.isAbsolute(projectsRoot)) {
    throw new Error(`factory.projectsRoot must be a full path (starting with / or ~), but the config has ${JSON.stringify(rawRoot)}`);
  }
  let operatorName;
  if (section.operatorName === undefined) {
    operatorName = user || 'operator';
  } else {
    const n = section.operatorName;
    if (typeof n !== 'string' || n.trim() === '' || n.length > 80) {
      throw new Error('factory.operatorName must be text (your name, as it should appear on approved briefs)');
    }
    operatorName = n;
  }
  return { projectsRoot, operatorName };
}
