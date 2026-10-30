-- Credentials the HTTP layer accepts (K6; retrieval-contract.md §2). Only a hash of each token's secret is stored, so
-- a copy of the database cannot be used to call the service. An app credential also has a key its server signs
-- short-lived user assertions with; that key is stored as issued, because the service must check the signatures.
CREATE TABLE credentials (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('project', 'app')),
  tenant_id text NOT NULL REFERENCES tenants,
  collections text[] NOT NULL,
  secret_sha256 text NOT NULL,
  assertion_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((kind = 'app') = (assertion_key IS NOT NULL))
);

-- Each assertion nonce is accepted once, until its assertion expires (§2 (d)).
CREATE TABLE assertion_nonces (
  credential_id text NOT NULL REFERENCES credentials,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (credential_id, nonce)
);
