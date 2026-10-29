import http from 'node:http';
import path from 'node:path';
import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StateStore, ServiceError, requireValue, id } from './state.js';
import { Runs, summary } from './runs.js';
import { acquireLease } from './lease.js';
import { sanitizedSetup, validateSetup, saveSetup } from './config.js';
import { rememberSecret } from '../secrets.js';

const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req) {
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'Use application/json.');
  const parts = []; let size = 0;
  for await (const part of req) { size += part.length; requireValue(size <= 32768, 'Request too large.', 'too-large', 413); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new ServiceError(400, 'invalid-json', 'Provide valid JSON.'); }
}
export async function createAppServer({ dataDir, configFile, port = 4318, uiDir = null, workerFile, probe = null }) {
  requireValue(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid port.');
  const releaseLease = await acquireLease(dataDir);
  let store;
  try { store = new StateStore(dataDir); } catch (e) { await releaseLease(); throw e; }
  const runs = new Runs({ store, dir: dataDir, configFile, ...(workerFile ? { workerFile } : {}) });
  const bootstrapToken = randomBytes(32).toString('hex'), session = randomBytes(32).toString('hex');
  rememberSecret(bootstrapToken); rememberSecret(session);
  let bootstrapUsed = false, origin, closing = false;
  const createdAt = Date.now(), streams = new Set();
  const configStamp = () => { try { const s = statSync(configFile); return `${s.mtimeMs}:${s.size}`; } catch { return null; } };
  const requestTimes = [];
  const server = http.createServer(async (req, res) => {
    const requestId = id();
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      requireValue(!closing, 'Service is stopping.', 'unavailable', 503);
      requireValue(req.headers.host === new URL(origin).host, 'Host refused.', 'forbidden', 403);
      requireValue(!req.headers.origin || req.headers.origin === origin, 'Origin refused.', 'forbidden', 403);
      requireValue(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'Cross-site request refused.', 'forbidden', 403);
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const time = Date.now();
        while (requestTimes[0] < time - 60000) requestTimes.shift();
        requireValue(requestTimes.length < 300, 'Too many requests. Try again shortly.', 'rate-limit', 429); requestTimes.push(time);
        if (!['GET', 'HEAD'].includes(req.method)) requireValue(req.headers.origin === origin, 'A same-origin request is required.', 'forbidden', 403);
        if (req.method === 'POST' && url.pathname === '/api/v1/session') {
          const input = await body(req);
          requireValue(!bootstrapUsed && time - createdAt < 5 * 60000 && same(input?.bootstrapToken, bootstrapToken), 'Bootstrap token expired or invalid. Restart the app to sign in again.', 'unauthorized', 401);
          bootstrapUsed = true;
          res.setHeader('set-cookie', `conductor_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
          return json(200, { authenticated: true });
        }
        const cookies = (req.headers.cookie ?? '').split(';').map(c => c.trim());
        requireValue(cookies.some(c => same(c, `conductor_session=${session}`)), 'Open the app using its local bootstrap link.', 'unauthorized', 401);
        runs.available();
        const p = url.pathname;
        if (req.method === 'GET' && p === '/api/v1/health') return json(200, { ready: true, schema: 1 });
        if (req.method === 'GET' && p === '/api/v1/setup') {
          const setup = sanitizedSetup(configFile);
          const cached = store.data.probeConfigStamp === configStamp() ? store.data.probes : {};
          return json(200, { ...setup, participants: setup.participants.map(p => ({ ...p, ...(cached?.[p.participantId] ?? {}) })) });
        }
        if (req.method === 'POST' && p === '/api/v1/setup/validate') return json(200, validateSetup(await body(req)));
        if (req.method === 'PUT' && p === '/api/v1/setup') { runs.idle(); const result = saveSetup(configFile, await body(req)); store.data.probes = {}; store.save(); return json(200, result); }
        const participant = /^\/api\/v1\/participants\/([\w-]{1,80})\/probe$/.exec(p);
        if (req.method === 'POST' && participant) {
          runs.idle(); const input = await body(req);
          requireValue(['installation', 'authenticated', 'agentic'].includes(input.kind), 'Choose a supported probe kind.');
          requireValue(probe, 'Connection probes are not installed in this service build.', 'not-implemented', 501);
          runs.probing = true;
          try {
            const result = await probe({ configFile, participantId: participant[1], kind: input.kind });
            store.data.probes ??= {}; store.data.probes[participant[1]] = result; store.data.probeConfigStamp = configStamp(); store.save();
            return json(200, result);
          }
          finally { runs.probing = false; }
        }
        if (req.method === 'GET' && p === '/api/v1/repositories') return json(200, { repositories: store.data.repositories });
        if (req.method === 'POST' && p === '/api/v1/repositories') return json(201, await runs.register(await body(req)));
        if (req.method === 'GET' && p === '/api/v1/runs') {
          const offset = Number(url.searchParams.get('cursor') ?? '0');
          requireValue(Number.isInteger(offset) && offset >= 0, 'Invalid cursor.');
          const list = [...store.data.runs].reverse();
          return json(200, { runs: list.slice(offset, offset + 50).map(summary), nextCursor: offset + 50 < list.length ? String(offset + 50) : null });
        }
        if (req.method === 'POST' && p === '/api/v1/runs') return json(202, runs.create(await body(req)));
        const match = /^\/api\/v1\/runs\/([\w-]{1,80})(?:\/(review|events|cancel|resume|recover|decisions)(?:\/([\w-]{1,80}))?)?$/.exec(p);
        if (match) {
          const run = runs.get(match[1]);
          if (req.method === 'GET' && !match[2]) return json(200, { ...summary(run), decision: run.activeDecisionId ? run.decision : null });
          if (req.method === 'GET' && match[2] === 'review') {
            requireValue(run.review, 'No review is available yet.', 'not-found', 404); return json(200, run.review);
          }
          if (req.method === 'GET' && match[2] === 'events') {
            const after = Number(url.searchParams.get('after') ?? '0');
            requireValue(Number.isInteger(after) && after >= 0 && after <= run.lastEventSeq, 'Refresh the run snapshot.', 'resync-required', 409);
            requireValue(streams.size < 8, 'Too many event streams.', 'stream-limit', 429);
            res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
            streams.add(res);
            const write = event => { if (!res.write(`id: ${event.seq}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`)) res.end(); };
            for (const event of run.events.filter(e => e.seq > after)) { if (res.writableEnded) break; write(event); }
            const listener = (runId, event) => { if (runId === run.id && !res.writableEnded) write(event); };
            runs.listeners.add(listener);
            const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.end(); }, 15000);
            res.on('close', () => { clearInterval(heartbeat); streams.delete(res); runs.listeners.delete(listener); });
            return;
          }
          if (req.method === 'POST' && match[2] === 'decisions' && match[3]) return json(200, await runs.answer(run, match[3], await body(req)));
          if (req.method === 'POST' && match[2] === 'cancel') return json(202, runs.cancel(run));
          if (req.method === 'POST' && match[2] === 'resume') return json(202, runs.resume(run));
          if (req.method === 'POST' && match[2] === 'recover') return json(200, runs.recover(run, await body(req)));
        }
        throw new ServiceError(404, 'not-found', 'Endpoint not found.');
      }
      requireValue(req.method === 'GET' || req.method === 'HEAD', 'Method not allowed.', 'method-not-allowed', 405);
      if (!uiDir || !existsSync(path.join(uiDir, 'index.html'))) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Conductor service is running. The operator UI has not been built; see docs/operator-app/setup.md.');
      }
      const root = realpathSync(uiDir);
      let file;
      try {
        const relative = url.pathname.startsWith('/assets/') ? decodeURIComponent(url.pathname).slice(1) : 'index.html';
        file = realpathSync(path.join(root, relative));
      } catch (e) {
        if (e instanceof URIError || ['ENOENT', 'ENOTDIR'].includes(e.code)) throw new ServiceError(404, 'not-found', 'Asset not found.');
        throw e;
      }
      requireValue(file.startsWith(root + path.sep) && statSync(file).isFile(), 'Asset not found.', 'not-found', 404);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      requireValue(types[path.extname(file)], 'Asset type not supported.', 'not-found', 404);
      res.writeHead(200, { 'content-type': types[path.extname(file)] });
      return res.end(req.method === 'HEAD' ? '' : readFileSync(file));
    } catch (e) {
      if (store.poisoned && runs.active) { runs.accepting = false; if (runs.active.child.connected) runs.active.child.disconnect(); }
      if (!res.headersSent) json(e instanceof ServiceError ? e.status : 500,
        { error: { code: e instanceof ServiceError ? e.code : 'internal', message: e instanceof ServiceError ? e.message : 'The operation could not be completed. Check the local configuration and service state.', retryable: false, requestId } });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (e) { await releaseLease(); throw e; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, bootstrapToken, runs, store, async close() {
    if (closing) return;
    closing = true; for (const res of streams) res.end();
    await runs.close();
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await releaseLease();
  } };
}
