const assert = require('node:assert/strict');
const s = require('./solution.cjs');
assert.equal(s.sumList([1, 2, 3]), 6);
assert.equal(s.sumList([]), 0);
