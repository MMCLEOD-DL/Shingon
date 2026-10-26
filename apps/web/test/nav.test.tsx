import { test, expect } from 'vitest';
import { navFor } from '../src/nav.js';

test('members see only their own areas; admins see admin pages', () => {
  expect(navFor('member').map((n) => n.to)).toEqual(['/notes', '/profile']);
  expect(navFor('manager').map((n) => n.to)).toEqual(['/notes', '/admin/users', '/profile']);
  expect(navFor('admin').map((n) => n.to)).toEqual(['/notes', '/admin/users', '/admin/teams', '/admin/audit', '/profile']);
});
