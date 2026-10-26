import path from 'node:path';
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { DEMO_PASSWORD, authFile, loadFixtures, type Fixtures, type Role } from './fixtures.js';
import { latestMailTo } from './mail.js';

// The two projects run side by side against one database, so every journey that changes anything uses its own project's accounts.
// Never change the admin, ops.manager@demo.test or the first Operations member: the page gate uses their stored sign-ins.
test.describe.configure({ mode: 'serial' });

const PHOTO = path.resolve(import.meta.dirname, '../../server/test/fixtures/files/tiny.jpg');
const NEW_PASSWORD = 'a fresh long password';
const flowEmail = (info: TestInfo): string => `flow.${info.project.name}@demo.test`;
const inviteeEmail = (info: TestInfo): string => `invitee+${info.project.name}@demo.test`;

let fx: Fixtures;
test.beforeAll(async () => { fx = await loadFixtures(); });

async function signInThroughForm(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/notes$/);
}

async function asRole(browser: Browser, info: TestInfo, role: Role): Promise<Page> {
  const ctx = await browser.newContext({ ...info.project.use, storageState: authFile(role) });
  return ctx.newPage();
}

const linkIn = (text: string, route: string): string => {
  const m = new RegExp(`https?://\\S+${route}#\\S+`).exec(text);
  if (!m) throw new Error(`The mail has no ${route} link.`);
  return m[0];
};

test('a member creates a note with a photo', async ({ page }, info) => {
  const title = `Taxi receipt (${info.project.name})`;
  await signInThroughForm(page, flowEmail(info), DEMO_PASSWORD);
  await page.getByRole('link', { name: 'New note' }).click();
  await expect(page.getByRole('heading', { name: 'New note', exact: true })).toBeVisible();
  await page.getByLabel('Title').fill(title);
  await page.getByTestId('file-input').setInputFiles(PHOTO);
  await expect(page.getByText('tiny.jpg')).toBeVisible();
  await page.getByRole('button', { name: 'Save note' }).click();

  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('img[src*="/api/files/"]').first()).toBeVisible();

  await page.goto('/notes');
  // The first row (desktop table) or first card (phone) on the page is the new note.
  const first = page.locator('main tbody tr, main [role="button"]').first();
  await expect(first).toContainText(title);
  const newest = await page.request.get('/api/notes?limit=1');
  expect(((await newest.json()) as { notes: { title: string }[] }).notes[0]?.title, 'the new note is listed first').toBe(title);

  await page.getByRole('button', { name: 'Your account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});

test('forgot and reset the password', async ({ page }, info) => {
  const email = flowEmail(info);
  const before = Date.now();
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();

  const mail = await latestMailTo(email, { after: before });
  expect(mail.subject).toBe('Reset your Highland App password');
  await page.goto(linkIn(mail.text, '/reset-password'));
  await expect(page.getByRole('heading', { name: 'Choose a new password', exact: true })).toBeVisible();
  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await signInThroughForm(page, email, NEW_PASSWORD);
});

test('an admin invites someone who accepts', async ({ browser }, info) => {
  const email = inviteeEmail(info);
  const name = `Invitee ${info.project.name}`;
  const admin = await asRole(browser, info, 'admin');
  const before = Date.now();
  await admin.goto('/admin/users');
  await expect(admin.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Invite someone' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('combobox', { name: 'Role' }).click();
  await admin.getByRole('option', { name: 'Member' }).click();
  await dialog.getByRole('combobox', { name: 'Team' }).click();
  await admin.getByRole('option', { name: 'Sales' }).click();
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(dialog).toBeHidden();
  const person = admin.locator('tr, [role="button"]').filter({ hasText: name });
  await expect(person.getByText('Invite sent')).toBeVisible();

  const mail = await latestMailTo(email, { after: before });
  expect(mail.subject).toContain('invited you to Highland App');

  // The invited person opens the link in a browser of their own.
  const guestCtx = await browser.newContext({ ...info.project.use });
  const guest = await guestCtx.newPage();
  await guest.goto(linkIn(mail.text, '/accept-invite'));
  await guest.getByLabel('New password').fill(NEW_PASSWORD);
  await guest.getByRole('button', { name: 'Set new password' }).click();
  await expect(guest).toHaveURL(/\/notes$/);
  await expect(guest.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
  await guestCtx.close();

  await admin.reload();
  await expect(admin.locator('tr, [role="button"]').filter({ hasText: name }).first()).toBeVisible();
  await expect(admin.locator('tr, [role="button"]').filter({ hasText: name }).getByText('Invite sent')).toHaveCount(0);
  await admin.context().close();
});

test('a manager can look but not change, and cannot see another team', async ({ browser }, info) => {
  const manager = await asRole(browser, info, 'manager');
  await manager.goto(`/notes/${fx.memberNoteWithPhoto}`);
  await expect(manager.getByRole('heading', { name: fx.memberNoteTitle, exact: true })).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(manager.getByRole('button', { name: 'Delete' })).toHaveCount(0);

  await manager.goto(`/notes/${fx.salesNoteId}`);
  await expect(manager.getByText("We couldn't find that.")).toBeVisible();
  await manager.context().close();
});

test('phone navigation opens, navigates and closes', async ({ browser }, info) => {
  test.skip(!info.project.use.isMobile, 'The burger menu only exists on a phone.');
  const page = await asRole(browser, info, 'member');
  await page.goto('/notes');
  const nav = page.getByRole('navigation', { name: 'Main menu' });
  const profile = nav.getByRole('link', { name: 'Profile' });
  // A closed menu slides off the left edge rather than disappearing, so "not visible" means "not on the screen".
  await expect(profile).not.toBeInViewport();
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await expect(profile).toBeInViewport();
  await profile.click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', { name: 'Your profile', exact: true })).toBeVisible();
  await expect(profile).not.toBeInViewport();
  await page.context().close();
});
