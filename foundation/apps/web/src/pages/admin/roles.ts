import { ROLES, type Role } from '@hf/shared';

export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', manager: 'Manager', member: 'Member' };
export const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }));
