// IPC fixture, not an alternative production engine.
if (process.argv.includes('--operator-worker')) {
process.on('message', msg => {
  if (msg.type === 'start') {
    process.send({ type: 'event', event: { type: 'start' } });
    if (msg.request === 'synthetic knowledge events') {
      const privateFields = { excerpt: 'private-excerpt', title: 'private-title', token: 'private-token' };
      const report = { type: 'evidence-withheld', participant: 'codex', collectionId: 'standards',
        documentIds: ['logging.md'], allowedDestinations: ['local-model'],
        message: '1 document from standards kept from codex: that collection may go only to local-model. To use it, run this step with an allowed participant.' };
      for (const event of [
        { type: 'evidence-used', count: 2, evidence: 'strong', viewRevision: 'a'.repeat(64) },
        { type: 'evidence-withheld', report: { ...report, ...privateFields } },
        { type: 'evidence-withheld', collectionId: 'unknown', documents: 1, allowedDestinations: [] },
        { type: 'evidence-dropped', reason: 'the run record could not be saved before any evidence was used' },
        { type: 'evidence-stopped', reason: 'policy changed or could not be confirmed' },
        { type: 'evidence-unavailable', reason: 'unreachable' },
      ]) process.send({ type: 'event', event: { ...event, ...privateFields, detail: 'private-detail', message: 'private-message' } });
    }
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
