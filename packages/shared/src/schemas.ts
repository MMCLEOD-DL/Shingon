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

export interface FileView {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
  ownerId: string;
}

/** The upload limit in words for people: whole megabytes, for example "15 MB" (kilobytes below 1 MB). Shared by the server message and the dropzone. */
export function formatLimit(bytes: number): string {
  if (bytes < 1048576) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${String(Math.round(bytes / 1048576))} MB`;
}

// Notes: the example feature every client resource copies. One base with NO defaults, because in Zod 4 `.partial()` keeps field
// defaults: building the update from the create schema would make `PATCH { title }` wipe the body and detach the photo.
const NoteFields = z.strictObject({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10000),
  attachmentId: z.uuid().nullable(), // null detaches
});
export const CreateNoteInput = NoteFields.extend({
  body: NoteFields.shape.body.default(''),
  attachmentId: NoteFields.shape.attachmentId.default(null),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;
/** No defaults: an absent field means "leave it alone". */
export const UpdateNoteInput = NoteFields.partial();
export type UpdateNoteInput = z.infer<typeof UpdateNoteInput>;
export const NoteListQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type NoteListQuery = z.infer<typeof NoteListQuery>;

export interface NoteView {
  id: string;
  title: string;
  body: string;
  ownerId: string;
  ownerName: string;
  teamId: string | null;
  attachment: FileView | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}
