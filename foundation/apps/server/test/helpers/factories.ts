import type { Role } from '@hf/shared';
import type { Db } from '../../src/db/client.js';
import { hashPassword } from '../../src/auth/password.js';
import { teams, users } from '../../src/db/schema/index.js';

const DEFAULT_PASSWORD = 'correct horse battery';
let counter = 0;
// scrypt is deliberately slow, so test users with the same password share one hash.
const hashes = new Map<string, Promise<string>>();
const hashOnce = (pw: string) => {
  let h = hashes.get(pw);
  if (!h) hashes.set(pw, (h = hashPassword(pw)));
  return h;
};

export async function makeTeam(db: Db, name: string): Promise<{ id: string }> {
  const [row] = await db.insert(teams).values({ name }).returning({ id: teams.id });
  return row!;
}

export async function makeUser(
  db: Db,
  opts: { role: Role; teamId?: string | null; email?: string; name?: string; password?: string | null; disabled?: boolean },
): Promise<{ id: string; email: string; password: string }> {
  const n = ++counter;
  const email = (opts.email ?? `user-${String(n)}@hf.test`).trim().toLowerCase();
  const password = opts.password === undefined ? DEFAULT_PASSWORD : opts.password;
  const [row] = await db.insert(users).values({
    email,
    name: opts.name ?? `User ${String(n)}`,
    role: opts.role,
    teamId: opts.teamId ?? null,
    passwordHash: password === null ? null : await hashOnce(password),
    disabledAt: opts.disabled ? new Date() : null,
  }).returning({ id: users.id });
  return { id: row!.id, email, password: password ?? DEFAULT_PASSWORD };
}
