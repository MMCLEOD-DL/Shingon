import type { ModuleName, Permission } from '@hf/shared';

/** A page of the app. `module`: the page exists only when that optional module is built in (Plan 12 Ruling 7). */
export interface AppPath { path: string; auth: 'public' | 'signed-in'; permission?: Permission; module?: ModuleName }

/**
 * The optional modules built into this web app: vite.config.ts sets __HF_MODULES__ from app-profile.json at build time
 * (every module with HF_ALL_MODULES=1). Outside a Vite build (Playwright's own process) nothing is defined, so none.
 */
export const BUILT_MODULES: readonly ModuleName[] = typeof __HF_MODULES__ === 'undefined' ? [] : __HF_MODULES__;

/** Whether a page, route or menu entry belongs in a build with these modules. */
export const inBuild = (item: { module?: ModuleName }, modules: readonly ModuleName[]): boolean =>
  item.module === undefined || modules.includes(item.module);

const ALL_APP_PATHS: AppPath[] = [
  { path: '/', auth: 'signed-in' },
  { path: '/sign-in', auth: 'public' },
  { path: '/forgot-password', auth: 'public' },
  { path: '/reset-password', auth: 'public' },
  { path: '/accept-invite', auth: 'public' },
  { path: '/profile', auth: 'signed-in' },
  { path: '/notes', auth: 'signed-in' },
  { path: '/notes/new', auth: 'signed-in' },
  { path: '/notes/:id', auth: 'signed-in' },
  { path: '/receipts/new', auth: 'signed-in', module: 'ocr' },
  { path: '/receipts/:id', auth: 'signed-in', module: 'ocr' },
  { path: '/admin/users', auth: 'signed-in', permission: 'users:list' },
  { path: '/admin/teams', auth: 'signed-in', permission: 'teams:manage' },
  { path: '/admin/audit', auth: 'signed-in', permission: 'audit:read' },
];

/** The pages of a build with these modules. */
export const appPathsFor = (modules: readonly ModuleName[]): AppPath[] => ALL_APP_PATHS.filter((p) => inBuild(p, modules));

/** The single list of pages in this build. Task 14's page registry is checked against it, so a page cannot exist without being listed here. */
export const APP_PATHS: AppPath[] = appPathsFor(BUILT_MODULES);
