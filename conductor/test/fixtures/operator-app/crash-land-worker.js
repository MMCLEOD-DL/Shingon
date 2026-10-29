// Run the production worker/engine, with a deterministic process loss exactly
// after the real source branch is created and before the outcome is delivered.
import { Workspace } from '../../../src/workspace.js';

const land = Workspace.prototype.land;
Workspace.prototype.land = async function (args) {
  if (this.branch === 'conductor/before-land') process.exit(1);
  const result = await land.call(this, args);
  if (result.ok) process.exit(1);
  return result;
};
await import('../../../src/service/worker.js');
