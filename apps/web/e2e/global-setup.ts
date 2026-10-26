import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request } from '@playwright/test';
import type { UserView } from '@hf/shared';
import { ADMIN_EMAIL, AUTH_DIR, BASE_URL, DEMO_PASSWORD, MANAGER_EMAIL, SHOTS_DIR, authFile, pickMember, type Role } from './fixtures.js';
import { PAGES } from './pages.js';

const PROJECTS = ['desktop-chromium', 'mobile-chromium', 'mobile-webkit'] as const;

async function signInOnce(email: string, role: Role): Promise<void> {
  // The server only accepts changes that come from its own address, which a browser adds by itself.
  const api = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
  try {
    const res = await api.post('/api/auth/sign-in', { data: { email, password: DEMO_PASSWORD } });
    if (!res.ok()) throw new Error(`Signing in as ${role} failed with ${String(res.status())}.`);
    await api.storageState({ path: authFile(role) });
  } finally {
    await api.dispose();
  }
}

/** Width and height in pixels, read from the PNG header. */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function writeManifest(): Promise<void> {
  const files = (await readdir(SHOTS_DIR).catch(() => [] as string[])).filter((f) => f.endsWith('.png')).sort();
  const manifest = [];
  for (const file of files) {
    const project = PROJECTS.find((p) => file.endsWith(`-${p}.png`));
    const name = project ? file.slice(0, -`-${project}.png`.length) : undefined;
    const page = PAGES.find((p) => p.name === name);
    if (!project || !page) continue;
    manifest.push({ page: page.name, path: page.route, project, ...pngSize(await readFile(path.join(SHOTS_DIR, file))), file });
  }
  await writeFile(path.join(SHOTS_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Signs in once per role and saves the browser state. Returns the teardown, which writes the screenshot manifest. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await rm(AUTH_DIR, { recursive: true, force: true });
  await mkdir(AUTH_DIR, { recursive: true });
  await rm(SHOTS_DIR, { recursive: true, force: true });
  await mkdir(SHOTS_DIR, { recursive: true });

  await signInOnce(ADMIN_EMAIL, 'admin');
  await signInOnce(MANAGER_EMAIL, 'manager');
  // The first Operations member is found through the API as the admin, using the sign-in just saved.
  const lookup = await request.newContext({ baseURL: BASE_URL, storageState: authFile('admin') });
  let member: UserView;
  try {
    const res = await lookup.get('/api/users');
    member = pickMember(((await res.json()) as { users: UserView[] }).users);
  } finally {
    await lookup.dispose();
  }
  await signInOnce(member.email, 'member');

  return writeManifest;
}
