// Synthetic service host for abrupt-parent tests; never a real worker launcher.
if (process.argv.includes('--synthetic-start-worker-service') && process.send) process.once('message', async options => {
  const { createAppServer } = await import('../../../src/service/server.js');
  const app = await createAppServer({ ...options, port: 0 });
  process.send({ origin: app.origin, bootstrapToken: app.bootstrapToken });
  process.on('disconnect', () => { void app.close(); });
});
