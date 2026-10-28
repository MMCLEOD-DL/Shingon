import { test, expect } from 'vitest';
import { navFor } from '../src/nav.js';

test('members see only their own areas; admins see admin pages', () => {
  expect(navFor('member').map((n) => n.to)).toEqual(['/notes', '/receipts/new', '/profile']);
  expect(navFor('manager').map((n) => n.to)).toEqual(['/notes', '/receipts/new', '/admin/users', '/profile']);
  expect(navFor('admin').map((n) => n.to)).toEqual(['/notes', '/receipts/new', '/admin/users', '/admin/teams', '/admin/audit', '/profile']);
  // Without the ocr module there is no Receipts entry.
  expect(navFor('member', []).map((n) => n.to)).toEqual(['/notes', '/profile']);
});
