import { IconHistory, IconNotes, IconReceipt, IconUser, IconUsers, IconUsersGroup, type TablerIcon } from '@tabler/icons-react';
import { can, type ModuleName, type Permission, type Role } from '@hf/shared';
import { BUILT_MODULES, inBuild } from './appPaths.js';

/** `module`: shown only when that optional module is built in. */
export interface NavItem { label: string; to: string; icon: TablerIcon; permission?: Permission; module?: ModuleName }

// Client apps add their own areas here; the shell and the role filtering stay as they are.
export const NAV: NavItem[] = [
  { label: 'Notes', to: '/notes', icon: IconNotes, permission: 'notes:read' },
  { label: 'Receipts', to: '/receipts/new', icon: IconReceipt, permission: 'readings:read', module: 'ocr' },
  { label: 'People', to: '/admin/users', icon: IconUsers, permission: 'users:list' },
  { label: 'Teams', to: '/admin/teams', icon: IconUsersGroup, permission: 'teams:manage' },
  { label: 'Activity log', to: '/admin/audit', icon: IconHistory, permission: 'audit:read' },
  { label: 'Profile', to: '/profile', icon: IconUser },
];

/** Presentation only: the server decides what each role may really do. */
export function navFor(role: Role, modules: readonly ModuleName[] = BUILT_MODULES): typeof NAV {
  return NAV.filter((n) => inBuild(n, modules) && (n.permission === undefined || can(role, n.permission)));
}
