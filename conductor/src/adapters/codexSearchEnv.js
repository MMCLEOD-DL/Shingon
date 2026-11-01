import path from 'node:path';
import { statSync } from 'node:fs';

const regularFile = file => { try { return statSync(file).isFile(); } catch { return false; } };

// The operator selected this native installation. Add only its verified adjacent
// tool folder, never a cwd-relative guess or a package found by walking the disk.
export function codexSearchEnv(bin, env, { platform = process.platform, isFile = regularFile } = {}) {
  const out = { ...env };
  const win = platform === 'win32';
  const paths = win ? path.win32 : path.posix;
  const delimiter = win ? ';' : ':';
  if (typeof bin !== 'string' || !paths.isAbsolute(bin)) return out;
  const name = win ? paths.basename(bin).toLowerCase() : paths.basename(bin);
  if (name !== (win ? 'codex.exe' : 'codex')) return out;
  const parentName = paths.basename(paths.dirname(bin)).toLowerCase();
  if (!['bin', 'codex'].includes(parentName)) return out;
  const helperDir = paths.join(paths.dirname(paths.dirname(bin)), 'codex-path');
  if (helperDir.includes(delimiter) || !isFile(paths.join(helperDir, win ? 'rg.exe' : 'rg'))) return out;

  // Node's Windows spawn treats env keys case-insensitively and selects the first
  // sorted spelling if duplicates exist. Keep that effective value, with one key.
  const keys = win ? Object.keys(out).filter(key => key.toLowerCase() === 'path').sort() : ['PATH'];
  const key = keys[0] ?? 'Path';
  const previous = out[key] ?? '';
  const canonical = part => {
    const normalized = paths.normalize(win ? part.replace(/^"(.*)"$/, '$1') : part);
    return win ? normalized.toLowerCase() : normalized;
  };
  const remaining = previous ? previous.split(delimiter).filter(part => canonical(part) !== canonical(helperDir)) : [];
  if (win) for (const duplicate of keys) delete out[duplicate];
  out[key] = [helperDir, ...remaining].join(delimiter);
  return out;
}
