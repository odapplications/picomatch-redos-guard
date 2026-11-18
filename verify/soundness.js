// Soundness audit: regexes built to exploit each simplification in the analyzer.
// For each: does V8 hang, and does the analyzer flag it? A hang the analyzer does not
// flag is a MISS (unsafe). node verify/soundness.js lib/ambiguity.js
const { spawnSync } = require('child_process');
const { hasExponentialBacktracking } = require(require("path").resolve(process.argv[2]));
const cases = [
  // [label, source, flags, unit, end]
  ['empty alternative', String.raw`^(?:a(?:|)b)+$`, '', 'ab', '!'],
  ['empty alternative 2', String.raw`^(?:a(?:|)(?:|)b)+$`, '', 'ab', '!'],
  ['optional empty group', String.raw`^(?:a(?:)?b)+$`, '', 'ab', '!'],
  ['empty group star', String.raw`^(?:a(?:)*b)+$`, '', 'ab', '!'],
  ['alt with empty and a?', String.raw`^(?:a(?:|b?)c)+$`, '', 'ac', '!'],
  ['nested optional', String.raw`^(?:a(?:b?)?c)+$`, '', 'ac', '!'],
  ['lookahead alternative', String.raw`^(?:a(?:(?=b)|)b)+$`, '', 'ab', '!'],
  ['anchor alternative', String.raw`^(?:a(?:\b|)b)+$`, '', 'ab', '!'],
  ['backreference', String.raw`^(?:(a)\1|aa)+$`, '', 'aa', '!'],
  ['backreference 2', String.raw`^(?:(a)(?:\1|a))+$`, '', 'aa', '!'],
  ['negated escape class', String.raw`^(?:[^\W]|a)+$`, '', 'a', '!'],
  ['nocase s / long s', String.raw`^(?:[^ſ]|S)+$`, 'i', 'S', '!'],
  ['nocase micro', String.raw`^(?:µ|μ)+$`, 'i', 'μ', '!'],
  ['nocase big range', String.raw`^(?:[Ā- ]|S)+$`, 'iu', 'ſ', '!'],
  ['dotAll', String.raw`^(?:.|\n)+x$`, 's', '\n', '!'],
  ['no dotAll (control)', String.raw`^(?:.|\n)+x$`, '', '\n', '!'],
  ['empty first iteration', String.raw`^(?:(?:a?)+b)+$`, '', 'ab', '!'],
  ['empty mandatory iters', String.raw`^(?:(?:|a){2})+$`, '', 'a', '!'],
  ['plain a?+ (control)', String.raw`^(?:a?)+$`, '', 'a', '!'],
  ['octal escape', String.raw`^(?:\012|\n)+$`, '', '\n', '!'],
  ['octal in class', String.raw`^(?:[\1]|\x01)+$`, '', '\x01', '!'],
  ['control in class', String.raw`^(?:[\c1]|\x11)+$`, '', '\x11', '!'],
  ['negated D in class', String.raw`^(?:[^\D]|1)+$`, '', '1', '!'],
  ['two negated members', String.raw`^(?:[\W\D]|a)+$`, '', 'a', '!'],
  ['negated minus member', String.raw`^(?:[^\Wa]|a)+$`, '', 'a', '!'],
  ['nocase legacy', String.raw`^(?:[a-z]|K)+$`, 'i', 'k', '!'],
  ['nocase mixed class', String.raw`^(?:\[!\Wb\]|[!\Wb])+$`, 'i', '[!!B]', 'a'],
  ['nocase mixed class 2', String.raw`^(?:[!\Wb]|B)+$`, 'i', 'B', 'a'],
  ['nocase \\W member', String.raw`^(?:[\Wb]|B)+$`, 'i', 'B', 'a'],
  ['nocase inverted (ctrl)', String.raw`^(?:[^b]|B)+$`, 'i', 'B', 'b'],
  ['nocase kelvin u', String.raw`^(?:K|k)+$`, 'iu', 'k', '!'],
  ['unicode surrogate esc', String.raw`^(?:😀|\u{1F600})+$`, 'u', '\u{1F600}', '!'],
  ['unicode escape', String.raw`^(?:\u{61}|a)+$`, 'u', 'a', '!'],
  ['unicode property', String.raw`^(?:\p{L}|a)+$`, 'u', 'a', '!'],
  ['surrogate pair', '^(?:\u{1F600}|\\uD83D\\uDE00)+$', '', '\u{1F600}', '!'],
  ['unknown group syntax', String.raw`^(?:(?i:a)|a)+$`, '', 'a', '!']
];
let misses = 0;
for (const [label, src, flags, unit, end] of cases) {
  let ok = true;
  try { new RegExp(src, flags); } catch (e) { ok = false; }
  if (!ok) { console.log(`${label.padEnd(24)} (not valid in this Node)`); continue; }
  const c = spawnSync(process.execPath, ['-e', 'const re=new RegExp(process.argv[1],process.argv[2]);const s=process.argv[3].repeat(30)+process.argv[4];const t=Date.now();re.test(s);console.log(Date.now()-t)', src, flags, unit, end], { timeout: 3000, encoding: 'utf8' });
  const hangs = !!c.error;
  const flagged = hasExponentialBacktracking(src, flags);
  const verdict = hangs && !flagged ? 'MISS' : hangs ? 'ok (caught)' : flagged ? 'over-block' : 'ok (safe)';
  if (verdict === 'MISS') misses++;
  console.log(`${label.padEnd(24)} V8: ${(hangs ? 'HANGS' : c.stdout.trim() + ' ms').padEnd(7)} analyzer: ${String(flagged).padEnd(6)} -> ${verdict}`);
}
console.log(`\n${misses} misses`);
