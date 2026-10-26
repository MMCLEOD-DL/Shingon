import { test, expect } from 'vitest';
import { canSee, canEdit } from '../src/access/scope.js';

const A = (role: 'admin' | 'manager' | 'member', id: string, teamId: string | null) => ({ id, role, teamId, email: '', name: '' });
const admin = A('admin', 'u0', null), mN = A('manager', 'u1', 'N'), alice = A('member', 'u2', 'N'), mS = A('manager', 'u3', 'S');
const aliceRow = { ownerId: 'u2', teamId: 'N' };

test('visibility: admin all, manager team, member own', () => {
  expect([admin, mN, alice, mS].map((a) => canSee(a, aliceRow))).toEqual([true, true, true, false]);
  expect(canSee(A('member', 'u9', 'N'), aliceRow)).toBe(false);
  expect(canSee(mN, { ownerId: 'u0', teamId: null })).toBe(false);
});
test('edit: owner or admin only; managers view but do not edit', () => {
  expect([admin, mN, alice, mS].map((a) => canEdit(a, aliceRow))).toEqual([true, false, true, false]);
});
