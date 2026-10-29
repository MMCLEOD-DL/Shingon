import type { Fixtures } from './fixtures.js';

export interface PageEntry {
  name: string;
  /** The APP_PATHS route this page covers. */
  route: string;
  path: string | ((fx: Fixtures) => string);
  as: 'anon' | 'admin' | 'manager' | 'member';
  /** The accessible heading to wait for. */
  ready: string | ((fx: Fixtures) => string);
}

// The headings are the AuthCard and PageHeader titles in apps/web/src/pages.
export const PAGES = [
  { name: 'sign-in', route: '/sign-in', path: '/sign-in', as: 'anon', ready: 'Sign in' },
  { name: 'forgot-password', route: '/forgot-password', path: '/forgot-password', as: 'anon', ready: 'Forgot your password?' },
  { name: 'reset-password', route: '/reset-password', path: '/reset-password#example', as: 'anon', ready: 'Choose a new password' },
  { name: 'accept-invite', route: '/accept-invite', path: '/accept-invite#example', as: 'anon', ready: 'Set up your account' },
  { name: 'notes', route: '/notes', path: '/notes', as: 'member', ready: 'Notes' },
  { name: 'note-new', route: '/notes/new', path: '/notes/new', as: 'member', ready: 'New note' },
  { name: 'note-view', route: '/notes/:id', path: (fx) => `/notes/${fx.memberNoteWithPhoto}`, as: 'member', ready: (fx) => fx.memberNoteTitle },
  { name: 'note-view-manager', route: '/notes/:id', path: (fx) => `/notes/${fx.memberNoteWithPhoto}`, as: 'manager', ready: (fx) => fx.memberNoteTitle },
  { name: 'receipt-new', route: '/receipts/new', path: '/receipts/new', as: 'member', ready: 'Read a receipt' },
  { name: 'receipt-check', route: '/receipts/:id', path: (fx) => `/receipts/${fx.memberReadingToCheck}`, as: 'member', ready: 'Check the details' },
  { name: 'receipt-confirmed', route: '/receipts/:id', path: (fx) => `/receipts/${fx.memberReadingConfirmed}`, as: 'member', ready: 'Check the details' },
  { name: 'receipt-check-manager', route: '/receipts/:id', path: (fx) => `/receipts/${fx.memberReadingToCheck}`, as: 'manager', ready: 'Check the details' },
  { name: 'profile', route: '/profile', path: '/profile', as: 'member', ready: 'Your profile' },
  { name: 'people', route: '/admin/users', path: '/admin/users', as: 'admin', ready: 'People' },
  { name: 'people-manager', route: '/admin/users', path: '/admin/users', as: 'manager', ready: 'People' },
  { name: 'teams', route: '/admin/teams', path: '/admin/teams', as: 'admin', ready: 'Teams' },
  { name: 'activity', route: '/admin/audit', path: '/admin/audit', as: 'admin', ready: 'Activity log' },
] as const satisfies readonly PageEntry[];

export const resolvePath = (p: PageEntry, fx: Fixtures): string => (typeof p.path === 'function' ? p.path(fx) : p.path);
export const resolveReady = (p: PageEntry, fx: Fixtures): string => (typeof p.ready === 'function' ? p.ready(fx) : p.ready);
