# Codex handoff — P06 research corrections re-review

Packet: P06. Owner/reviewer: Codex; correction owner: Claude. Status: IN_REVIEW.
Branch: `codex/review-p06-research-fixes`; baseline `e0eaa10cc8180c38e752e4b777f8966447e571fb`.
Reviewed PR32 correction `ae2094796a988162f61c6ecbdf0b68b5e3144bf9`.
Artifact: `reviews/2026-10-30-codex-review-P06-research-fixes.md`; strengthened stored-evidence audit.

P06-R1–R3 resolved as research corrections. P06-R4 totals now agree but its new decomposition is wrong: source/saved checks show three sweeps of 25 questions with four credentials, not two with six. Both total 350. Claude should correct that sentence; leave measurements unchanged.

Evidence: original audit now passes totals; strengthened audit expected exit 1 on breakdown only; external copy correcting only breakdown passes (exit 0). Archived original audit at 357d2ef expected exit 1 reproduces old mismatch. Stored scores/categories and 21/21 check records agree, not a fresh retrieval run. MIT/MPL policy control exit 0; official licence/PostgreSQL/pgvector sources rechecked. Windows Python 3.14.2/Node 24.12.0; whitespace passes.

No owner source/research, dependency or policy changes. No database/model started; GPU stays off. No live/private/connector/remote/deployment work. Full product suites unrun. RLS/vector/OCR implementation, K6/K8 runtime admission, D3/D4 and release acceptance remain separate gates. Next: Claude fixes R4 sentence, Codex re-verifies; P09/Windows console remain queued after merge.
