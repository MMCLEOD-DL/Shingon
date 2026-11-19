// IPC fixture, not an alternative production engine.
if (process.argv.includes('--operator-worker')) {
process.on('message', msg => {
  if (msg.type === 'start') {
    process.send({ type: 'event', event: { type: 'start' } });
    if (msg.request === 'synthetic step gate events') {
      for (const event of [
        { type: 'gate', index: 0, attempt: 1, of: 2, result: 'failed', failedStage: 'types', excerpt: 'error TS2322\u001b[31m SYNTHETIC_GATE_SECRET', raw: 'unselected-private-field' },
        { type: 'gate', index: 0, attempt: 2, of: 2, result: 'passed', failedStage: null, excerpt: null },
        { type: 'scope-flag', index: 0, outside: ['src/b.js', 'SYNTHETIC_GATE_SECRET\u001b[31m.js'] },
        { type: 'protected-path', index: 1, participant: 'local', files: ['foundation.json'] },
        { type: 'gate', index: -1, attempt: 'bad', of: 1.5, result: 'unknown', failedStage: {}, excerpt: 7 },
        { type: 'scope-flag', index: 2, outside: Array.from({ length: 120 }, (_, i) => `${i}-` + 'x'.repeat(600)) },
        { type: 'gate', index: 3, attempt: 1, of: 1, result: 'failed', failedStage: 'x'.repeat(400), excerpt: 'x'.repeat(2990) + 'SYNTHETIC_GATE_SECRET' + 'x'.repeat(7000) },
      ]) process.send({ type: 'event', event: { ...event, detail: 'unselected-private-field' } });
    }
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
