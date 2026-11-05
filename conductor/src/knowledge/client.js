// Conductor's read-only client for the company knowledge service (retrieval contract v1,
// conductor/docs/knowledge-base/retrieval-contract.md). K8 slice 2: nothing in the engine imports this yet.
//
// It speaks only to a loopback or private-network service, with a project-scoped read token, and accepts only
// responses in the contract's shapes. Anything else is an error: evidence is optional, so a caller drops it rather
// than guessing. The token never appears in an error message or a returned value.
//
// The transport is node:http/https on a fresh agent per request, never global fetch or the global agent: with
// NODE_USE_ENV_PROXY those route through HTTP(S)_PROXY, which would hand the bearer token to a proxy (Codex review
// of PR96, P1). A redirect is never followed.

import http from 'node:http';
import https from 'node:https';

export const KB_BASE_PATH = '/kb/v1';
export const MAX_BODY_BYTES = 64 * 1024; // contract §3: a response body is at most 64 KB
export const MAX_RESULTS = 20;
export const MAX_EXCERPT = 1200;
const TOKEN = /^kb1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/; // knowledge/src/shingon_knowledge/auth.py TOKEN
const VIEW_REVISION = /^[0-9a-f]{64}$/;
const CHUNK_ID = /^[A-Za-z0-9_-]{22,128}$/;
const DESTINATIONS = new Set(['local-model', 'claude-subscription', 'codex-subscription']);
const APP_DESTINATION = /^foundation-app:[a-z0-9][a-z0-9-]{0,63}$/;
const EVIDENCE = new Set(['strong', 'weak', 'none']);
const KINDS = new Set(['reference', 'client-runtime']);

export class KbError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'KbError';
    Object.assign(this, { code, status, retryable });
  }
}

const fail = (what) => { throw new KbError('bad-response', `The knowledge service sent an invalid response (${what}).`); };

/** True for loopback, RFC 1918 and IPv6 unique-local hosts (address syntax only: a private host can still forward elsewhere). */
export function privateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 unique local, fc00::/7
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = v4.slice(1, 3).map(Number);
  if (v4.slice(1).some((x) => Number(x) > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The service's origin, if it is an http(s) URL on a loopback or private-network host; throws otherwise. */
export function checkKbUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new KbError('config', 'The knowledge service URL is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new KbError('config', 'The knowledge service URL must use http or https.');
  if (url.username || url.password) throw new KbError('config', 'The knowledge service URL must not contain credentials.');
  if (url.search || url.hash || !['', '/'].includes(url.pathname)) throw new KbError('config', 'The knowledge service URL must be an origin only, with no path or query.');
  if (!privateHost(url.hostname)) throw new KbError('config', 'The knowledge service must be on this machine or a private network.');
  return url.origin;
}

const text = (v, what, max = Infinity) => { if (typeof v !== 'string' || !v || v.length > max) fail(what); return v; };
const positive = (v, what) => { if (!Number.isSafeInteger(v) || v < 1) fail(what); return v; };

function locator(loc, what) {
  if (!loc || typeof loc !== 'object' || Array.isArray(loc)) fail(what);
  const out = {};
  for (const k of ['page', 'slide']) { if (loc[k] !== null) positive(loc[k], `${what}.${k}`); out[k] = loc[k]; }
  for (const k of ['sheet', 'cellRange']) { if (loc[k] !== null) text(loc[k], `${what}.${k}`); out[k] = loc[k]; }
  if (loc.sectionPath !== null && !(Array.isArray(loc.sectionPath) && loc.sectionPath.every((s) => typeof s === 'string' && s))) fail(`${what}.sectionPath`);
  out.sectionPath = loc.sectionPath === null ? null : [...loc.sectionPath];
  return out;
}

function destinations(list, what) {
  if (!Array.isArray(list)) fail(what);
  for (const d of list) if (!DESTINATIONS.has(d) && !(typeof d === 'string' && APP_DESTINATION.test(d))) fail(what);
  return [...list];
}

/** A `GET /collections` body reduced to what Conductor uses, or a bad-response error. */
export function parseCollections(body) {
  if (!body || typeof body !== 'object') fail('collections body');
  if (!VIEW_REVISION.test(body.viewRevision ?? '')) fail('viewRevision');
  if (!Array.isArray(body.collections)) fail('collections');
  const seen = new Set();
  const collections = body.collections.map((c, i) => {
    const id = text(c?.collectionId, `collections[${i}].collectionId`);
    if (seen.has(id)) fail('duplicate collection');
    seen.add(id);
    if (!KINDS.has(c.kind)) fail(`collections[${i}].kind`);
    return { collectionId: id, kind: c.kind, destinations: destinations(c.destinations, `collections[${i}].destinations`) };
  });
  return { viewRevision: body.viewRevision, collections };
}

/** A `POST /search` body reduced to what Conductor uses, or a bad-response error. */
export function parseSearch(body) {
  if (!body || typeof body !== 'object') fail('search body');
  if (!VIEW_REVISION.test(body.viewRevision ?? '')) fail('viewRevision');
  if (!EVIDENCE.has(body.evidence)) fail('evidence');
  if (!Array.isArray(body.results) || body.results.length > MAX_RESULTS) fail('results');
  if (body.evidence !== 'none' && body.results.length === 0) fail('evidence without results');
  const results = body.results.map((r, i) => {
    const w = `results[${i}]`;
    if (!r || typeof r !== 'object') fail(w);
    if (!CHUNK_ID.test(r.chunkId ?? '')) fail(`${w}.chunkId`);
    if (r.scores?.rank !== i + 1) fail(`${w}.scores.rank`);
    if (typeof r.flags?.instructionLike !== 'boolean') fail(`${w}.flags.instructionLike`);
    return {
      chunkId: r.chunkId,
      collectionId: text(r.collectionId, `${w}.collectionId`),
      documentId: text(r.documentId, `${w}.documentId`),
      versionId: positive(r.versionId, `${w}.versionId`),
      title: text(r.title, `${w}.title`),
      excerpt: text(r.excerpt, `${w}.excerpt`, MAX_EXCERPT),
      locator: locator(r.locator, `${w}.locator`),
      instructionLike: r.flags.instructionLike,
    };
  });
  return { viewRevision: body.viewRevision, evidence: body.evidence, results };
}

// One request, directly to the origin. Resolves { status, text } or rejects with a KbError.
function send({ url, method, headers, body, timeoutMs }) {
  const mod = url.protocol === 'https:' ? https : http;
  const agent = new mod.Agent({ keepAlive: false }); // never the (possibly proxy-aware) global agent
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); agent.destroy(); fn(value); } };
    const tooLarge = () => new KbError('too-large', 'The knowledge service response is too large.');
    const req = mod.request(url, { method, headers, agent }, (res) => {
      if (Number(res.headers['content-length']) > MAX_BODY_BYTES) { req.destroy(); done(reject, tooLarge()); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(); done(reject, tooLarge()); } else chunks.push(c);
      });
      res.on('end', () => {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { done(reject, new KbError('bad-response', 'The knowledge service sent an invalid response (not UTF-8).')); return; }
        done(resolve, { status: res.statusCode, text });
      });
      res.on('error', () => done(reject, new KbError('unreachable', 'The knowledge service could not be reached.', { retryable: true })));
    });
    const timer = setTimeout(() => { req.destroy(); done(reject, new KbError('timeout', 'The knowledge service did not answer in time.', { retryable: true })); }, timeoutMs);
    req.on('error', () => done(reject, new KbError('unreachable', 'The knowledge service could not be reached.', { retryable: true })));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * A client for one service and one project token. `token` is the value itself (the caller reads it from the
 * environment variable the config names); it is used only in the Authorization header.
 */
export function createKbClient({ url, token, timeoutMs = 5000 } = {}) {
  const origin = checkKbUrl(url);
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new KbError('config', 'The knowledge service token is missing or not in the expected format.');

  async function call(method, path, body) {
    const payload = body ? JSON.stringify(body) : undefined;
    const { status, text } = await send({
      url: new URL(`${origin}${KB_BASE_PATH}${path}`), method, timeoutMs, body: payload,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    });
    if (status >= 300 && status < 400) throw new KbError('redirect', 'The knowledge service answered with a redirect, which is never followed.', { status });
    let data;
    try { data = JSON.parse(text); } catch { fail('not JSON'); }
    if (status < 200 || status >= 300) {
      const e = data?.error;
      const code = typeof e?.code === 'string' && /^[a-z-]{1,40}$/.test(e.code) ? e.code : 'unknown';
      // The service's fixed wording for its own code; never echo arbitrary text back as a message.
      throw new KbError(code, `The knowledge service refused the request (${code}).`, { status, retryable: e?.retryable === true });
    }
    return data;
  }

  return {
    origin,
    collections: async () => parseCollections(await call('GET', '/collections')),
    search: async ({ query, collections, limit = 8 }) => {
      if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new KbError('bad-request', 'A search needs a query of 1 to 1000 characters.');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new KbError('bad-request', `A search limit is 1 to ${MAX_RESULTS}.`);
      const body = { query, mode: 'keyword', limit, ...(collections?.length ? { collections: [...collections] } : {}) };
      return parseSearch(await call('POST', '/search', body));
    },
  };
}
