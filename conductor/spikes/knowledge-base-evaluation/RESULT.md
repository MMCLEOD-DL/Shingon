# Knowledge-base evaluation spike — result

**Status:** RUN on 30 October 2026, cloud Linux, PostgreSQL 16.15, Python 3.13.17. Keyword retrieval only.

Run: `pip install -r requirements.txt && bash run.sh`. It needs PostgreSQL 16 server binaries and LibreOffice. It starts a throwaway cluster on a Unix socket, generates the synthetic corpus, writes `results/results.json`, and deletes everything else.

- **21/21** permission, sync and deletion checks passed. There were **0 unauthorised results** in three sweeps of every question as every credential.
- **Retrieval:** 17/25 correct (keyword), and 21/25 with superseded sources demoted. The misses are paraphrases, which need hybrid retrieval, and abstention, which needs a calibrated reranker.
- **Not run here:** hybrid/vector retrieval, reranking, OCR, answer generation and live connectors. Model and extension downloads are blocked by this environment's network policy.

Analysis and limitations: [`conductor/docs/knowledge-base/evaluation.md`](../../docs/knowledge-base/evaluation.md).
