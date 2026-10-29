-- Knowledge service schema v1 (K2). Ported from conductor/spikes/knowledge-base-evaluation/kb.py.
-- Permission columns live on every chunk, so the ACL predicate is part of the candidate query itself:
-- unauthorised chunks are never ranked, counted, cached or excerpted (retrieval-contract.md §1, §3).

CREATE TABLE tenants (
  id text PRIMARY KEY,
  index_generation bigint NOT NULL DEFAULT 0
);

CREATE TABLE principals (
  tenant_id text NOT NULL REFERENCES tenants,
  id text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE group_members (
  tenant_id text NOT NULL,
  group_id text NOT NULL,
  principal_id text NOT NULL,
  PRIMARY KEY (tenant_id, group_id, principal_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES principals (tenant_id, id)
);

CREATE TABLE collections (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants,
  kind text NOT NULL CHECK (kind IN ('reference', 'client-runtime')),
  destinations text[] NOT NULL
);

CREATE TABLE sources (
  id bigserial PRIMARY KEY,
  collection_id text NOT NULL REFERENCES collections,
  key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deleted', 'failed')),
  current_version int,
  superseded_by text,
  acl_all boolean NOT NULL,
  acl_groups text[] NOT NULL,
  acl_principals text[] NOT NULL,
  UNIQUE (collection_id, key)
);

CREATE TABLE versions (
  source_id bigint NOT NULL REFERENCES sources,
  n int NOT NULL,
  sha256 text NOT NULL,
  original_path text,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, n)
);

CREATE TABLE chunks (
  id bigserial PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES sources,
  version int NOT NULL,
  tenant_id text NOT NULL,
  collection_id text NOT NULL,
  title text NOT NULL,
  text text NOT NULL,
  locator jsonb NOT NULL,
  acl_all boolean NOT NULL,
  acl_groups text[] NOT NULL,
  acl_principals text[] NOT NULL,
  instruction_like boolean NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || text)) STORED
);
CREATE INDEX chunks_tsv ON chunks USING gin (tsv);
CREATE INDEX chunks_scope ON chunks (tenant_id, collection_id);
CREATE INDEX chunks_source ON chunks (source_id);

CREATE TABLE import_events (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  collection_id text,
  key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('added', 'updated', 'unchanged', 'deleted', 'failed', 'acl')),
  message text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

-- Query text is stored only as a hash: a query can contain personal data (retrieval-contract.md §8).
CREATE TABLE audit (
  id bigserial PRIMARY KEY,
  credential text NOT NULL,
  principal text,
  collections text[],
  result_sources bigint[],
  query_sha256 text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
