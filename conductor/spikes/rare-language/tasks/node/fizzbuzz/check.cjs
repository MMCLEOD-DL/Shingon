const assert = require('node:assert/strict');
const s = require('./solution.cjs');
assert.equal(s.fizzbuzz(15), 'FizzBuzz');
assert.equal(s.fizzbuzz(9), 'Fizz');
assert.equal(s.fizzbuzz(10), 'Buzz');
assert.equal(s.fizzbuzz(7), '7');
