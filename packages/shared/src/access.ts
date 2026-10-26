export const ROLES = ['admin', 'manager', 'member'] as const;
export type Role = (typeof ROLES)[number];

// Who may do what. Task 4 adds the rest of the table; client apps extend it, they do not rewrite the model.
export const PERMISSIONS = {
  'self:manage': ['admin', 'manager', 'member'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, perm: Permission): boolean {
  // An unknown permission name is refused, never an error.
  return (PERMISSIONS as Record<string, readonly Role[] | undefined>)[perm]?.includes(role) ?? false;
}
