// Stands in for the alert channel during the smoke test: appends each POSTed JSON body as one line to the alert log.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
const LOG = process.env.HF_SMOKE_ALERT_LOG ?? '/tmp/hf-smoke-alerts.log';
const HOST = process.env.HF_SMOKE_CATCHER_HOST ?? '0.0.0.0';
createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    if (req.method === 'POST') {
      try { appendFileSync(LOG, `${JSON.stringify(JSON.parse(body))}\n`); } catch { appendFileSync(LOG, `${JSON.stringify({ unreadable: body.slice(0, 200) })}\n`); }
    }
    res.writeHead(204).end();
  });
}).listen(8099, HOST, () => { console.log(`Alert catcher listening on ${HOST}:8099, writing to ${LOG}`); });
