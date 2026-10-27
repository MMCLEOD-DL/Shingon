// src/plan.js
// Tolerates CRLF line endings and an empty block (which then fails as "not valid JSON").
const JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi;

export function extractJson(text) {
  const blocks = [...text.matchAll(JSON_FENCE)];
  if (blocks.length) return blocks[blocks.length - 1][1];
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[') ? t : null;
}

export function parsePlan(text, { maxChunks = 12 } = {}) {
  const raw = extractJson(typeof text === 'string' ? text : '');
  if (raw == null) return { ok: false, error: 'no ```json plan block found in the reply' };

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `plan block is not valid JSON (${e.message})` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'plan JSON must be an object' };

  const chunks = Array.isArray(obj.chunks) ? obj.chunks : [];
  if (chunks.length === 0) return { ok: false, error: 'plan has no chunks' };
  if (chunks.length > maxChunks) return { ok: false, error: `plan has ${chunks.length} chunks (max ${maxChunks}); merge or drop some` };

  const out = [];
  for (const [i, c] of chunks.entries()) {
    const title = typeof c?.title === 'string' ? c.title.trim() : '';
    const instructions = typeof c?.instructions === 'string' ? c.instructions.trim() : '';
    if (!title || !instructions) return { ok: false, error: `chunk ${i + 1} is missing a title or instructions` };
    out.push({ title, instructions });
  }
  return { ok: true, plan: { summary: typeof obj.summary === 'string' ? obj.summary.trim() : '', chunks: out } };
}
