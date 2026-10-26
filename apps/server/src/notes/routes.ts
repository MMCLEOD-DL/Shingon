import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateNoteInput, NoteListQuery, UpdateNoteInput } from '@hf/shared';
import { defineRoute } from '../http/route.js';
import { notFound, unauthorized } from '../http/errors.js';
import type { Storage } from '../files/storage.js';
import { type NoteDeps, createNote, deleteNote, getNote, listNotes, updateNote } from './repo.js';

const IdParams = z.strictObject({ id: z.uuid() });
const NoQuery = z.strictObject({});

export function registerNoteRoutes(app: FastifyInstance, storage: Storage, now?: () => Date): void {
  const deps = (req: { ip: string; log: NoteDeps['log'] }): NoteDeps => ({ ip: req.ip, storage, ...(now ? { now: now() } : {}), ...(req.log ? { log: req.log } : {}) });
  defineRoute(app, {
    method: 'GET',
    url: '/api/notes',
    access: { permission: 'notes:read' },
    schema: { query: NoteListQuery },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      return listNotes(db, actor, req.query);
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/notes',
    access: { permission: 'notes:create' },
    schema: { body: CreateNoteInput },
    async handler(req, reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const note = await createNote(db, actor, req.body, deps(req));
      return reply.code(201).send({ note });
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/notes/:id',
    access: { permission: 'notes:read' },
    schema: { params: IdParams, query: NoQuery },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const note = await getNote(db, actor, req.params.id);
      if (!note) throw notFound();
      return { note };
    },
  });

  defineRoute(app, {
    method: 'PATCH',
    url: '/api/notes/:id',
    access: { permission: 'notes:update' },
    schema: { params: IdParams, query: NoQuery, body: UpdateNoteInput },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      return { note: await updateNote(db, actor, req.params.id, req.body, deps(req)) };
    },
  });

  defineRoute(app, {
    method: 'DELETE',
    url: '/api/notes/:id',
    access: { permission: 'notes:delete' },
    schema: { params: IdParams, query: NoQuery },
    async handler(req, reply, { actor, db }) {
      if (!actor) throw unauthorized();
      await deleteNote(db, actor, req.params.id, deps(req));
      return reply.code(204).send();
    },
  });
}
