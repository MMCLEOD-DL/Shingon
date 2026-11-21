const assert = require('node:assert/strict');
const s = require('./solution.cjs');
const m = s.wordCount(['a', 'b', 'a']);
assert.equal(m.get('a'), 2);
assert.equal(m.get('b'), 1);
assert.equal(m.get('c'), undefined);
