import assert from 'node:assert/strict';
import { isAllowed } from '../../../../../../foundation/scripts/check-licences.ts';
assert.equal(isAllowed('MIT'), true);
assert.equal(isAllowed('MPL-2.0'), false);
console.log('PASS existing licence gate: MIT allowed; MPL-2.0 requires an exception');
