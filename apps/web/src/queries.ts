import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateNoteInput, InviteInput, NoteView, TeamView, UpdateNoteInput, UpdateUserInput, UserView } from '@hf/shared';
import { api } from './api.js';

export interface AuditEntry {
  id: number;
  at: string;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
}
export interface AuditFilters { action?: string; actorId?: string }

export const keys = {
  notes: ['notes'] as const,
  note: (id: string) => ['note', id] as const,
  users: ['users'] as const,
  teams: ['teams'] as const,
  audit: (filters: AuditFilters = {}) => ['audit', filters] as const,
};

const NOTES_PAGE = 20;
const AUDIT_PAGE = 50;

export function useNotes() {
  return useInfiniteQuery({
    queryKey: keys.notes,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<{ notes: NoteView[]; nextCursor: string | null }>('GET', `/api/notes?limit=${String(NOTES_PAGE)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useNote(id: string) {
  return useQuery({ queryKey: keys.note(id), queryFn: async () => (await api<{ note: NoteView }>('GET', `/api/notes/${encodeURIComponent(id)}`)).note });
}

export function useUsers() {
  return useQuery({ queryKey: keys.users, queryFn: async () => (await api<{ users: UserView[] }>('GET', '/api/users')).users });
}

export function useTeams(enabled = true) {
  return useQuery({ queryKey: keys.teams, enabled, queryFn: async () => (await api<{ teams: TeamView[] }>('GET', '/api/teams')).teams });
}

export function useAudit(filters: AuditFilters = {}) {
  return useInfiniteQuery({
    queryKey: keys.audit(filters),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(AUDIT_PAGE) });
      if (filters.action) q.set('action', filters.action);
      if (filters.actorId) q.set('actorId', filters.actorId);
      if (pageParam !== null) q.set('before', String(pageParam));
      return api<{ entries: AuditEntry[]; nextBefore: number | null }>('GET', `/api/audit?${q.toString()}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
}

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateNoteInput) => (await api<{ note: NoteView }>('POST', '/api/notes', input)).note,
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: keys.notes }); },
  });
}

export function useUpdateNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateNoteInput) => (await api<{ note: NoteView }>('PATCH', `/api/notes/${encodeURIComponent(id)}`, input)).note,
    onSuccess: async (note) => {
      qc.setQueryData(keys.note(id), note);
      await qc.invalidateQueries({ queryKey: keys.notes });
    },
  });
}

export function useDeleteNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('DELETE', `/api/notes/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      qc.removeQueries({ queryKey: keys.note(id) });
      await qc.invalidateQueries({ queryKey: keys.notes });
    },
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: InviteInput) => (await api<{ user: UserView }>('POST', '/api/users/invite', input)).user,
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: keys.users }), qc.invalidateQueries({ queryKey: ['audit'] })]); },
  });
}

export function useUpdateUser(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateUserInput) => (await api<{ user: UserView }>('PATCH', `/api/users/${encodeURIComponent(id)}`, input)).user,
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: keys.users }), qc.invalidateQueries({ queryKey: ['audit'] })]); },
  });
}

export function useResendInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('POST', `/api/users/${encodeURIComponent(id)}/resend-invite`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['audit'] }); },
  });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => (await api<{ team: TeamView }>('POST', '/api/teams', { name })).team,
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: keys.teams }), qc.invalidateQueries({ queryKey: ['audit'] })]); },
  });
}
