import { test, expect } from 'vitest';
import { AppProfileSchema, DEFAULT_PROFILE, MODULES } from '../src/modules.js';

test('the default profile turns nothing on and lets nothing out', () => {
  expect(DEFAULT_PROFILE).toEqual({ schema: 1, modules: [], policy: { outbound: [], residency: 'uk' } });
  expect(MODULES).toEqual(['ocr', 'pdf-export', 'xlsx-export', 'scheduled-jobs']);
});
test('unknown modules, keys and odd outbound ids are refused', () => {
  expect(AppProfileSchema.safeParse({ ...DEFAULT_PROFILE, modules: ['payments'] }).success).toBe(false);
  expect(AppProfileSchema.safeParse({ ...DEFAULT_PROFILE, extra: 1 }).success).toBe(false);
  expect(AppProfileSchema.safeParse({ ...DEFAULT_PROFILE, policy: { outbound: ['Azure OCR'], residency: 'uk' } }).success).toBe(false);
  expect(AppProfileSchema.safeParse({ ...DEFAULT_PROFILE, policy: { outbound: ['azure-document-intelligence'], residency: 'uk' } }).success).toBe(true);
});
