// Zero-dependency client for the few Proxmox VE API calls the proxmox provider needs.
// TLS is always verified (caFile or the system store); plain http is allowed only to 127.0.0.1
// (the test stub). The token secret is never logged and is stripped from every error.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { redact, REDACTED } from '../../secrets.js';

export class PveError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PveError';
    this.status = status;
  }
}

const CA_HINT = ' Set factory.machines.proxmox.caFile to the Proxmox CA certificate (/etc/pve/pve-root-ca.pem on the Proxmox host).';
const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|HOSTNAME_MISMATCH/;

export function nodeRequest({ method, url, headers, body, ca, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = { method, headers, timeout: timeoutMs };
    if (u.protocol === 'https:' && ca) opts.ca = ca;
    const fail = (err) => {
      const reason = err?.message || String(err);
      const cert = CERT_CODES.test(err?.code || '') || /certificate/i.test(reason);
      reject(new PveError(0, `Conductor could not reach Proxmox at ${u.host}: ${reason}.${cert ? CA_HINT : ''}`));
    };
    const req = lib.request(u, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('the request timed out')));
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

export function createPveClient({
  apiUrl, tokenId, secret, caFile = null, request = nodeRequest,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, timeoutMs = 30000,
} = {}) {
  let base;
  try { base = new URL(apiUrl); } catch { throw new PveError(0, `The Proxmox address must start with https:// (got ${apiUrl})`); }
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && base.hostname === '127.0.0.1'))) {
    throw new PveError(0, `The Proxmox address must start with https:// (got ${apiUrl})`);
  }
  if (!secret || typeof secret !== 'string') {
    throw new PveError(0, 'The Proxmox API token secret is missing. Put it in the environment variable named by factory.machines.proxmox.tokenEnv.');
  }
  const ca = caFile ? fs.readFileSync(caFile) : undefined;
  const origin = base.origin;

  const clean = (s) => {
    let out = String(s);
    if (secret) out = out.replaceAll(secret, REDACTED);
    return redact(out);
  };
  const fail = (status, message) => new PveError(status, clean(message));

  async function call(method, path, form) {
    const headers = { Authorization: `PVEAPIToken=${tokenId}=${secret}`, Accept: 'application/json' };
    let body;
    if (form !== undefined) {
      body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    let res;
    try {
      res = await request({ method, url: `${origin}/api2/json${path}`, headers, body, ca, timeoutMs });
    } catch (e) {
      throw e instanceof PveError ? fail(e.status, e.message) : fail(0, `Conductor could not reach Proxmox at ${base.host}: ${e?.message || e}.`);
    }
    const { status } = res;
    if (status >= 200 && status < 300) {
      try { return JSON.parse(res.body).data ?? null; } catch { throw fail(status, 'Proxmox sent a reply Conductor could not read.'); }
    }
    if (status === 401) throw fail(401, 'Proxmox refused the API token (check its id and secret).');
    if (status === 403) throw fail(403, `Proxmox did not allow that: the factory's API token has no rights for ${method} ${path}. Check the token's rights on the pool.`);
    let detail = '';
    try {
      const j = JSON.parse(res.body);
      const e = j.message ?? j.errors;
      detail = typeof e === 'string' ? e : e ? JSON.stringify(e) : '';
    } catch { detail = String(res.body || ''); }
    detail = detail.split('\n')[0].slice(0, 300);
    throw fail(status, `Proxmox answered with an error (${status}): ${detail}.`);
  }

  async function waitTask(node, upid, { timeoutMs: limit = 300000, intervalMs = 2000 } = {}) {
    const start = now();
    for (;;) {
      const st = await call('GET', `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
      if (st?.status === 'stopped') {
        if (st.exitstatus === 'OK') return st;
        throw fail(500, `The Proxmox task did not finish properly: ${st.exitstatus}.`);
      }
      if (now() - start >= limit) throw fail(0, `The Proxmox task did not finish within ${Math.round(limit / 1000)} seconds.`);
      await sleep(intervalMs);
    }
  }

  return {
    get: (p) => call('GET', p),
    post: (p, form = {}) => call('POST', p, form),
    put: (p, form = {}) => call('PUT', p, form),
    del: (p) => call('DELETE', p),
    waitTask,
  };
}
