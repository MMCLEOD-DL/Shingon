import { describe, test, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../pin-apt-key.sh', import.meta.url));
const hasGpg = spawnSync('gpg', ['--version'], { stdio: 'ignore' }).status === 0;

/** Primary-key fingerprints in a keyring file, in order. */
function primaries(home: string, file: string): string[] {
  const out = execFileSync('gpg', ['--homedir', home, '--batch', '--show-keys', '--with-colons', file], { encoding: 'utf8' });
  const fprs: string[] = [];
  let want = false;
  for (const line of out.split('\n')) {
    const f = line.split(':');
    if (f[0] === 'pub') want = true;
    else if (want && f[0] === 'fpr') { fprs.push(f[9]!); want = false; }
  }
  return fprs;
}

describe.runIf(hasGpg)('apt key pinning in the ops image', () => {
  test('a key file with an extra key still yields only the pinned key, and a file without it is refused', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hf-key-'));
    const home = path.join(dir, 'g');
    execFileSync('mkdir', ['-m', '700', home]);
    const gpg = (...args: string[]) => execFileSync('gpg', ['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', ...args], { encoding: 'utf8' });
    try {
      gpg('--quick-gen-key', 'Pinned Vendor <pinned@example.test>', 'ed25519', 'sign', 'never');
      gpg('--quick-gen-key', 'Intruder <intruder@example.test>', 'ed25519', 'sign', 'never');
      const list = gpg('--list-keys', '--with-colons');
      const fprOf = (uid: string): string => {
        const lines = list.split('\n');
        const i = lines.findIndex((l) => l.startsWith('uid:') && l.includes(uid));
        // the fpr line follows its pub line, which comes before the uid
        for (let j = i; j >= 0; j--) if (lines[j]!.startsWith('pub:')) return lines[j + 1]!.split(':')[9]!;
        throw new Error('no key');
      };
      const good = fprOf('pinned@example.test');
      const bad = fprOf('intruder@example.test');
      // The intruder comes first in the file, as a tampered download might arrange it.
      writeFileSync(path.join(dir, 'both.asc'), gpg('--armor', '--export', bad) + gpg('--armor', '--export', good));
      writeFileSync(path.join(dir, 'intruder.asc'), gpg('--armor', '--export', bad));

      const out = path.join(dir, 'pinned.gpg');
      const ok = spawnSync('sh', [script, path.join(dir, 'both.asc'), good, out], { encoding: 'utf8' });
      expect(ok.status, ok.stderr).toBe(0);
      expect(primaries(home, out)).toEqual([good]);

      const out2 = path.join(dir, 'refused.gpg');
      const refused = spawnSync('sh', [script, path.join(dir, 'intruder.asc'), good, out2], { encoding: 'utf8' });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/does not hold the pinned key/);
      expect(existsSync(out2)).toBe(false);
    } finally {
      spawnSync('gpgconf', ['--homedir', home, '--kill', 'all']);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
