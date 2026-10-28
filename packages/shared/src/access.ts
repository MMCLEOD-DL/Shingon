export const ROLES = ['admin', 'manager', 'member'] as const;
export type Role = (typeof ROLES)[number];

// Who may do what. Client apps extend it, they do not rewrite the model.
export const PERMISSIONS = {
  'self:manage': ['admin', 'manager', 'member'],
  'users:list': ['admin', 'manager'],
  'users:manage': ['admin'],
  'teams:list': ['admin', 'manager'],
  'teams:manage': ['admin'],
  'audit:read': ['admin'],
  'files:upload': ['admin', 'manager', 'member'],
  'files:read': ['admin', 'manager', 'member'],
  'notes:create': ['admin', 'manager', 'member'],
  'notes:read': ['admin', 'manager', 'member'],
  'notes:update': ['admin', 'manager', 'member'],
  'notes:delete': ['admin', 'manager', 'member'],
  // Receipt readings (OCR module). Who may see or confirm a given reading follows its file: the item rules, not the role.
  'readings:read': ['admin', 'manager', 'member'],
  'readings:confirm': ['admin', 'manager', 'member'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, perm: Permission): boolean {
  // An unknown permission name is refused, never an error.
  return (PERMISSIONS as Record<string, readonly Role[] | undefined>)[perm]?.includes(role) ?? false;
}
