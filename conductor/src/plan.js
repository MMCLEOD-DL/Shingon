// src/plan.js
// Tolerates CRLF line endings and an empty block (which then fails as "not valid JSON").
const JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi;

export function extractJson(text) {
  const blocks = [...text.matchAll(JSON_FENCE)];
  if (blocks.length) return blocks[blocks.length - 1][1];
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[') ? t : null;
}

const MAX_CHECK = 500;
const MAX_FILES = 50;
const MAX_PATH = 300;

function validFiles(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_FILES) return null;
  const out = [];
  for (const f of v) {
    const p = typeof f === 'string' ? f.trim() : '';
    if (!p || p.length > MAX_PATH || p.startsWith('/') || p.split(/[\\/]/).includes('..')) return null;
    out.push(p);
  }
  return out;
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
    const chunk = { title, instructions };
    if (c.check !== undefined) {
      const check = typeof c.check === 'string' ? c.check.trim() : '';
      if (!check || check.length > MAX_CHECK) return { ok: false, error: `chunk ${i + 1} has an invalid check (a non-empty string of at most ${MAX_CHECK} characters)` };
      chunk.check = check;
    }
    if (c.files !== undefined) {
      const files = validFiles(c.files);
      if (!files) return { ok: false, error: `chunk ${i + 1} has invalid files (1 to ${MAX_FILES} relative paths, no leading / and no .. segment)` };
      chunk.files = files;
    }
    out.push(chunk);
  }
  return { ok: true, plan: { summary: typeof obj.summary === 'string' ? obj.summary.trim() : '', chunks: out } };
}
