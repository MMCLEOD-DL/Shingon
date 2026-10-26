import { z } from 'zod';
import { ROLES, type Role } from './access.js';

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
  teamName: string | null;
  disabled: boolean;
  activated: boolean;
}
export interface TeamView { id: string; name: string }

// strictObject: unknown keys are refused, so a member cannot slip in { role: 'admin' } (mass assignment).
export const UpdateUserInput = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(ROLES).optional(),
  teamId: z.uuid().nullable().optional(),
  disabled: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInput>;

export const UpdateMeInput = z.strictObject({ name: z.string().trim().min(1).max(100) });
export type UpdateMeInput = z.infer<typeof UpdateMeInput>;

export const CreateTeamInput = z.strictObject({ name: z.string().trim().min(1).max(80) });
export type CreateTeamInput = z.infer<typeof CreateTeamInput>;

export const InviteInput = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  name: z.string().trim().min(1).max(100),
  role: z.enum(ROLES),
  teamId: z.uuid().nullable(),
});
export type InviteInput = z.infer<typeof InviteInput>;
