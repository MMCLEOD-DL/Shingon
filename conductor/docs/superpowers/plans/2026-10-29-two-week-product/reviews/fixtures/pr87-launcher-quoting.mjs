// PR87 review (Claude, 5 Nov 2026): does conductor/test/helpers/nativeStubLauncher.cs quote arguments so node.exe reads
// back exactly what the launcher received?  node pr87-launcher-quoting.mjs [--mutate=tail|inner]
// --mutate shows the check can fail: tail = trailing backslashes not doubled; inner = backslashes before " not doubled.
//
// Port of nativeStubLauncher.cs Quote() and a parser following the Windows C runtime's argv rules (what node.exe uses):
// 2n backslashes + " -> n backslashes, toggle quoting; 2n+1 + " -> n backslashes + literal "; other backslashes literal;
// inside quotes, "" -> literal " (UCRT); space/tab outside quotes separate arguments.
const mutate = process.argv.find((a) => a.startsWith('--mutate='))?.slice(9);
const quote = (v) => {
  let o = '"', s = 0;
  for (const c of v) {
    if (c === '\\') { s++; continue; }
    o += '\\'.repeat(c === '"' ? (mutate === 'inner' ? s : s * 2) + 1 : s) + c; s = 0;
  }
  return o + '\\'.repeat(mutate === 'tail' ? s : s * 2) + '"';
};
function parse(line) {
  const out = []; let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '', inq = false;
    for (;;) {
      let n = 0; while (line[i] === '\\') { n++; i++; }
      if (line[i] === '"') {
        arg += '\\'.repeat(n >> 1);
        if (n % 2) { arg += '"'; i++; continue; }
        if (inq && line[i + 1] === '"') { arg += '"'; i += 2; continue; }
        inq = !inq; i++; continue;
      }
      arg += '\\'.repeat(n);
      if (i >= line.length || (!inq && (line[i] === ' ' || line[i] === '\t'))) break;
      arg += line[i++];
    }
    out.push(arg);
  }
  return out;
}
const alphabet = ['a', ' ', '\t', '"', '\\', '\n', '雪', '&', '%', '^'];
let cases = 0;
const fixed = [['', 'plain', 'two words', '雪', 'quote"inside', 'ends in slash\\', '& echo NOT_A_SHELL', 'line\nbreak'], ['\\\\"', '"', '\\', '\\\\', '""', '\\"\\']];
const check = (args) => { cases++; const line = ['C:\\stub.exe.cjs', ...args].map(quote).join(' '); const got = parse(line).slice(1); if (JSON.stringify(got) !== JSON.stringify(args)) { console.log('MISMATCH', JSON.stringify(args), JSON.stringify(got), line); process.exit(1); } };
fixed.forEach(check);
let seed = 42; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (let k = 0; k < 200000; k++) { const args = Array.from({ length: rnd(4) }, () => Array.from({ length: rnd(9) }, () => alphabet[rnd(alphabet.length)]).join('')); check(args); }
console.log(`round-trip ok: ${cases} argument lists`);
