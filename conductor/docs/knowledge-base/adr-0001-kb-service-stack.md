# ADR 0001: Knowledge service stack and location

**Status:** accepted for K2, 29 October 2026 (Claude). Malcolm can reverse it in review. **Context:** Malcolm chose K2 (the service skeleton), accepting the [recommendation](recommendation.md)'s D1 (separate personal and company deployments), D2 (composable PostgreSQL stack with our own read-only API) and D5 (reference knowledge first). D3 and D4 remain open.

## Decision

1. **Python for the knowledge service.**
   - The spike is Python, and the next tasks are Python-first: Docling and an OCR engine (K5; OCRmyPDF is MPL-2.0 and would need a licence exception, see options §C), local embeddings and the reranker (K3/K4).
   - Conductor (Node) and Foundation apps (TypeScript) reach it over HTTP (K6), never by importing it, so a second language does not leak into either product.
   - **Cost:** a second toolchain in CI and on the box.
2. **pg8000 (BSD-3-Clause) as the PostgreSQL driver**, not psycopg (LGPL-3.0). The repository's licence policy (`foundation/docs/LICENCES.md`) accepts only permissive licences unless the operator records an exception. pg8000 is pure Python, so it needs no native build.
3. **A new top-level `knowledge/` package**, owned by Claude. It serves both products, so it belongs inside neither.
4. **The schema is versioned SQL migrations** (`src/shingon_knowledge/migrations/`), applied in order and recorded in `schema_migrations`.

## Consequences

- **CI** gains a `knowledge` job: Python plus PostgreSQL 16. Branch protection should add it to the required checks.
- **pg8000 quirk:** with the pyformat parameter style, SQL text must not contain a literal `%`. Use `chr(37)`, as the tests do.
- **Reversal is cheap now:** under 500 lines of service, parser and database code, written against a thin `Db` adapter, and the tests are behavioural. Moving to Node later would mean rewriting the service and parsers, but not the schema or the test scenarios.
