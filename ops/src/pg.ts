import pg from 'pg';

export type PgEnv = Record<'PGHOST' | 'PGPORT' | 'PGUSER' | 'PGPASSWORD' | 'PGDATABASE', string>;

/** The database address as the libpq variables pg_dump and pg_restore read, so the password never goes on a command line. */
export function pgEnv(databaseUrl: string): PgEnv {
  const u = new URL(databaseUrl);
  return {
    PGHOST: decodeURIComponent(u.hostname.replace(/^\[|\]$/g, '')) || 'localhost',
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username),
  };
}

/** A single connection (not from the pool) to `database`, or to the one in the address when not given. */
export async function connect(databaseUrl: string, database?: string): Promise<pg.Client> {
  const e = pgEnv(databaseUrl);
  const c = new pg.Client({
    host: e.PGHOST, port: Number(e.PGPORT), user: e.PGUSER, password: e.PGPASSWORD, database: database ?? e.PGDATABASE,
    connectionTimeoutMillis: 30_000,
  });
  // An error on an idle client would otherwise crash the process; the next query reports it instead.
  c.on('error', () => undefined);
  await c.connect();
  return c;
}

/** Names that are safe to put in CREATE/DROP DATABASE, which cannot take a bind parameter. */
export const DB_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** A quoted identifier for a table name read from the catalogue. */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
