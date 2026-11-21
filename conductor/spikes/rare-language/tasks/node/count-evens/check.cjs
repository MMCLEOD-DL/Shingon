const assert = require('node:assert/strict');
const s = require('./solution.cjs');
assert.equal(s.countEvens([1, 2, 3, 4]), 2);
assert.equal(s.countEvens([]), 0);
assert.equal(s.countEvens([0]), 1);
