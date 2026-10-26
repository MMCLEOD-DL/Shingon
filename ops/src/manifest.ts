import { stat } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { quoteIdent } from './pg.js';

/** What a backup holds, written next to the dump: exact row counts per table and the uploads listed in the files table. */
export interface Manifest {
  createdAt: string;
  tables: Record<string, number>;
  files: { count: number; bytes: number };
  app: string;
  foundation: string;
}

/** Tables left out of the counts. ops_runs changes during the backup itself. */
const SKIPPED = new Set(['ops_runs']);

/** Exact row counts of every public table, read on `client` (inside the backup's snapshot, or in a restored database). */
export async function countTables(client: pg.ClientBase): Promise<Record<string, number>> {
  const names = await client.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public' order by tablename`);
  const tables: Record<string, number> = {};
  for (const { tablename } of names.rows) {
    if (SKIPPED.has(tablename)) continue;
    const r = await client.query<{ n: string }>(`select count(*)::bigint as n from public.${quoteIdent(tablename)}`);
    tables[tablename] = Number(r.rows[0]?.n ?? 0);
  }
  return tables;
}

async function hasFilesTable(client: pg.ClientBase): Promise<boolean> {
  const r = await client.query<{ t: string | null }>(`select to_regclass('public.files')::text as t`);
  return r.rows[0]?.t != null;
}

/**
 * Builds the manifest on `client`, the connection holding the exported snapshot, so every number describes exactly what
 * pg_dump saves. The file totals come from the files table in that snapshot, not from the uploads folder, which keeps changing.
 */
export async function buildManifest(client: pg.ClientBase, versions: { app: string; foundation: string }): Promise<Manifest> {
  const tables = await countTables(client);
  let files = { count: 0, bytes: 0 };
  if (await hasFilesTable(client)) {
    const r = await client.query<{ c: string; b: string }>(`select count(*)::bigint as c, coalesce(sum(size), 0)::bigint as b from files`);
    files = { count: Number(r.rows[0]?.c ?? 0), bytes: Number(r.rows[0]?.b ?? 0) };
  }
  return { createdAt: new Date().toISOString(), tables, files, app: versions.app, foundation: versions.foundation };
}

/**
 * Checks that every file listed in the restored files table came back under `uploadsRoot` with exactly its size.
 * Objects on disk that the table does not list (uploads after the database snapshot) are ignored. Problems name file ids
 * only, never file names, which may be personal data.
 */
export async function checkRestoredFiles(client: pg.ClientBase, uploadsRoot: string): Promise<{ count: number; bytes: number; problems: string[] }> {
  if (!(await hasFilesTable(client))) return { count: 0, bytes: 0, problems: [] };
  const rows = await client.query<{ id: string; storage_key: string; size: number }>(`select id::text as id, storage_key, size from files order by id`);
  let count = 0;
  let bytes = 0;
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const r of rows.rows) {
    const key = r.storage_key;
    let size: number | undefined;
    try {
      const st = await stat(path.join(uploadsRoot, key.slice(0, 2), key));
      size = st.isFile() ? st.size : undefined;
    } catch {
      size = undefined;
    }
    if (size === undefined) missing.push(r.id);
    else if (size !== r.size) wrong.push(r.id);
    else {
      count++;
      bytes += size;
    }
  }
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`${String(missing.length)} files listed in the backed-up database did not come back (for example ${missing[0] ?? ''}).`);
  if (wrong.length > 0) problems.push(`${String(wrong.length)} restored files have the wrong size (for example ${wrong[0] ?? ''}).`);
  return { count, bytes, problems };
}

const mb = (bytes: number): string => `${String(Math.round(bytes / 1_000_000))} MB`;

/** Compares a restore with its backup record. Tables that exist only after restoring are ignored. */
export function compareManifest(expected: Manifest, actual: Omit<Manifest, 'createdAt' | 'app' | 'foundation'>): string[] {
  const problems: string[] = [];
  for (const [table, n] of Object.entries(expected.tables)) {
    const got = actual.tables[table];
    if (got === undefined) problems.push(`Table ${table} is missing after restoring.`);
    else if (got !== n) problems.push(`Table ${table} has ${String(n)} rows in the backup record but ${String(got)} after restoring.`);
  }
  if (expected.files.count !== actual.files.count || expected.files.bytes !== actual.files.bytes) {
    problems.push(`The backup record lists ${String(expected.files.count)} files (${mb(expected.files.bytes)}) but ${String(actual.files.count)} files (${mb(actual.files.bytes)}) came back.`);
  }
  return problems;
}
