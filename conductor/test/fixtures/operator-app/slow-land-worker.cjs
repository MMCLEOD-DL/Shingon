// Deliberately separate source mutation and result delivery to reproduce P3-1.
const { execFileSync } = require('node:child_process');
if (process.argv.includes('--operator-worker')) {
  let repo, crash;
  process.on('message', msg => {
    if (msg.type === 'start') {
      repo = msg.repoDir; crash = msg.request === 'crash-after-approval';
      process.send({ type: 'question', id: 'slow-result', kind: 'result',
        payload: { summary: 'Synthetic slow landing', diff: '+x', tests: { ran: true, passed: true, code: 0 } },
        evidence: { commit: 'a'.repeat(40), diffId: 'x', testReportIds: [] } });
    }
    if (msg.type === 'answer' && msg.value === true) {
      execFileSync('git', ['-C', repo, 'branch', 'conductor/landed']);
      if (crash) process.exit(1);
      setTimeout(() => {
        process.send({ type: 'finished', outcome: { status: 'landed', branch: 'conductor/landed' } });
        process.disconnect();
      }, 300);
    }
  });
  process.on('disconnect', () => process.exit(0));
}
