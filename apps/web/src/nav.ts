import { IconHistory, IconNotes, IconUser, IconUsers, IconUsersGroup, type TablerIcon } from '@tabler/icons-react';
import { can, type Permission, type Role } from '@hf/shared';

export interface NavItem { label: string; to: string; icon: TablerIcon; permission?: Permission }

// Client apps add their own areas here; the shell and the role filtering stay as they are.
export const NAV: NavItem[] = [
  { label: 'Notes', to: '/notes', icon: IconNotes, permission: 'notes:read' },
  { label: 'People', to: '/admin/users', icon: IconUsers, permission: 'users:list' },
  { label: 'Teams', to: '/admin/teams', icon: IconUsersGroup, permission: 'teams:manage' },
  { label: 'Activity log', to: '/admin/audit', icon: IconHistory, permission: 'audit:read' },
  { label: 'Profile', to: '/profile', icon: IconUser },
];

/** Presentation only: the server decides what each role may really do. */
export function navFor(role: Role): typeof NAV {
  return NAV.filter((n) => n.permission === undefined || can(role, n.permission));
}
