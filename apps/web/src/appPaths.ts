import type { Permission } from '@hf/shared';

export interface AppPath { path: string; auth: 'public' | 'signed-in'; permission?: Permission }

/** The single list of pages. Task 14's page registry is checked against it, so a page cannot exist without being listed here. */
export const APP_PATHS: AppPath[] = [
  { path: '/', auth: 'signed-in' },
  { path: '/sign-in', auth: 'public' },
  { path: '/forgot-password', auth: 'public' },
  { path: '/reset-password', auth: 'public' },
  { path: '/accept-invite', auth: 'public' },
  { path: '/profile', auth: 'signed-in' },
  { path: '/notes', auth: 'signed-in' },
  { path: '/notes/new', auth: 'signed-in' },
  { path: '/notes/:id', auth: 'signed-in' },
  { path: '/admin/users', auth: 'signed-in', permission: 'users:list' },
  { path: '/admin/teams', auth: 'signed-in', permission: 'teams:manage' },
  { path: '/admin/audit', auth: 'signed-in', permission: 'audit:read' },
];
