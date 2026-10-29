// IPC fixture, not an alternative production engine.
if (process.argv.includes('--operator-worker')) {
process.on('message', msg => {
  if (msg.type === 'start') {
    process.send({ type: 'event', event: { type: 'start' } });
    process.send({ type: 'question', id: 'test-decision', kind: 'result',
      payload: { summary: '<script>untrusted</script>', diff: '+synthetic change', tests: { ran: true, passed: true, code: 0 } },
      evidence: { commit: 'a'.repeat(40), diffId: 'fixture-diff', testReportIds: ['fixture-tests'] } });
  }
  if (msg.type === 'answer') {
    process.send({ type: 'finished', outcome: { status: msg.value === true ? 'landed' : 'rejected', branch: msg.value === true ? 'conductor/synthetic' : undefined } });
    process.disconnect();
  }
});
process.on('disconnect', () => process.exit(0));

}
