const assert = require('node:assert/strict');
const s = require('./solution.cjs');
assert.equal(s.addTwo(3), 5);
assert.equal(s.addTwo(0), 2);
