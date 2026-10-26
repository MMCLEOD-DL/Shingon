import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateNoteInput, NoteListQuery, UpdateNoteInput } from '@hf/shared';
import { defineRoute } from '../http/route.js';
import { notFound, unauthorized } from '../http/errors.js';
import type { Storage } from '../files/storage.js';
import { createNote, deleteNote, getNote, listNotes, updateNote } from './repo.js';

const IdParams = z.strictObject({ id: z.uuid() });
const NoQuery = z.strictObject({});

export function registerNoteRoutes(app: FastifyInstance, storage: Storage, now?: () => Date): void {
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
      const note = await createNote(db, actor, req.body, req.ip, now?.());
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
    schema: { params: IdParams, body: UpdateNoteInput },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      return { note: await updateNote(db, storage, actor, req.params.id, req.body, req.ip, now?.()) };
    },
  });

  defineRoute(app, {
    method: 'DELETE',
    url: '/api/notes/:id',
    access: { permission: 'notes:delete' },
    schema: { params: IdParams, query: NoQuery },
    async handler(req, reply, { actor, db }) {
      if (!actor) throw unauthorized();
      await deleteNote(db, storage, actor, req.params.id, req.ip);
      return reply.code(204).send();
    },
  });
}
