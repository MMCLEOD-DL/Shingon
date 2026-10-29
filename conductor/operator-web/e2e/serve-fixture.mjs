// Starts the real operator service with a deterministic fixture worker, for e2e/journey.mjs only.
// Run as its own process so the journey can kill it abruptly (SIGKILL) and start it again on the
// same data directory and port. Prints one JSON line: {"origin": "...", "bootstrapToken": "..."}.
//
//   node e2e/serve-fixture.mjs --service <conductor dir> --data <dir> --config <file> --ui <dist> --worker <file> [--port N]
import { parseArgs } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: {
  service: { type: 'string' }, data: { type: 'string' }, config: { type: 'string' },
  ui: { type: 'string' }, worker: { type: 'string' }, port: { type: 'string', default: '0' },
} });
const { createAppServer } = await import(pathToFileURL(path.join(values.service, 'src', 'service', 'server.js')).href);
const app = await createAppServer({ dataDir: values.data, configFile: values.config, port: Number(values.port), uiDir: values.ui, workerFile: values.worker });
process.stdout.write(`${JSON.stringify({ origin: app.origin, bootstrapToken: app.bootstrapToken })}\n`);
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
