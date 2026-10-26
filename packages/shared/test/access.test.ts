import { test, expect } from 'vitest';
import { PERMISSIONS, ROLES, can } from '../src/access.js';

test('only admins manage users, teams and read the audit log', () => {
  for (const p of ['users:manage', 'teams:manage', 'audit:read'] as const) {
    expect(ROLES.filter((r) => can(r, p))).toEqual(['admin']);
  }
});
test('every permission names known roles only', () => {
  for (const roles of Object.values(PERMISSIONS)) for (const r of roles) expect(ROLES).toContain(r);
});
test('unknown roles get nothing', () => {
  expect(can('owner' as never, 'self:manage')).toBe(false);
});
