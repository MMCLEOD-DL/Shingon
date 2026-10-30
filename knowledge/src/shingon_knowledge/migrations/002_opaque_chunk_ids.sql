-- Opaque chunk ids on the wire (Codex retrieval-contract review, decision 1). The serial chunks.id stays internal:
-- its gaps would reveal ingestion volume to callers whose ACLs differ. Two version-4 UUIDs give 244 random bits from
-- PostgreSQL's strong random source. A chunk keeps its id for the life of that chunk version; a new version gets new
-- chunks and new ids. Opacity never replaces the ACL check: every lookup by id re-authorises.
ALTER TABLE chunks ADD COLUMN public_id text NOT NULL DEFAULT translate(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
CREATE UNIQUE INDEX chunks_public_id ON chunks (public_id);
