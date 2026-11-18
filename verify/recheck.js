// Independent cross-check with recheck (https://makenowjust-labs.github.io/recheck/),
// a separate ReDoS checker. Every distinct regex the PATCHED copies produce for the
// two fuzz corpora under 5 option sets is checked; each one recheck calls
// exponential is then run in V8 with recheck's own attack string and a set of
// generic hostile inputs, 2 s limit each.
//
//   npm install --no-save recheck@4.6.2
//   node verify/prepare.mjs
//   node verify/recheck.js [--limit N]      (full run: about 150,000 regexes, hours)
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const { check } = require('recheck');

const WORK = path.join(__dirname, '.work');
const copies = ['4.0.7', '2.3.2'].map(v => require(path.join(WORK, `patched-${v}`)));
const limitAt = process.argv.indexOf('--limit');
const limit = limitAt > 0 ? Number(process.argv[limitAt + 1]) : Infinity;

// The pattern generators of fuzz-wide.js and fuzz-targeted.js.
const patterns = new Set();
const addFrom = (atoms, shapes) => {
  const bodies = new Set();
  const gen = (cur, depth) => {
    if (cur.length) bodies.add(cur.join(''));
    if (depth === 0) return;
    for (const t of atoms) gen([...cur, t], depth - 1);
  };
  gen([], 3);
  for (const b of bodies) for (const s of shapes) patterns.add(s(b));
};
addFrom(['a', '*', '**', '?', '/', '**/', '/**', '.', ' ', '[a]', '[!a]', '[\\W]', '[\\D]', '[\\S]', '[^/]', '\\*'],
  [b => `+(${b})`, b => `*(${b})`, b => `+(${b})b`, b => `*(${b})b`, b => `+(a|${b})`, b => `*(a|${b})`, b => `x${b}+y`, b => `@(+(${b}))b`, b => `!(+(${b}))`]);
addFrom(['a', '*', '**/', '?', '[!\\W]', '[^\\W]', '[!\\D]', '[!\\S]', '[!\\Wb]', '[\\W]', '@(|)', '?(a)', '@(a|)', '[a]'],
  [b => `+(${b})`, b => `*(${b})`, b => `+(${b})b`, b => `+(a|${b})`, b => `+(${b}|)`, b => `+(|${b})b`, b => `@(+(${b}))b`]);

const optionSets = [{}, { windows: true }, { dot: true }, { bash: true }, { nocase: true }];
const items = new Map();
for (const p of patterns) for (const o of optionSets) for (const pm of copies) {
  let re;
  try { re = pm.makeRe(p, o); } catch (e) { continue; }
  const key = `${re.flags}\u0000${re.source}`;
  if (!items.has(key)) items.set(key, { source: re.source, flags: re.flags, pattern: p, opts: o });
}
const todo = [...items.values()].slice(0, limit);
console.log(`${patterns.size} patterns x ${optionSets.length} option sets -> ${items.size} distinct regexes; checking ${todo.length}`);

const probe = `
const re = new RegExp(process.argv[1], process.argv[2]);
const attack = process.argv[3];
if (attack) re.test(attack);
const units = ['a','aa','ab','a1','1','A','B','[!!B]','[!]','!','a!','/','a/',' ','x'];
for (const u of units) for (const e of ['!','/','\\n','b','c','a','\\u0000']) for (const n of [16, 32, 48]) re.test(u.repeat(n) + e);
`;

(async () => {
  const tally = {};
  const flagged = [];
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const it = todo[i++];
      let r;
      try { r = await check(it.source, it.flags, { timeout: 10000 }); } catch (e) { r = { status: 'unknown' }; }
      const verdict = r.status === 'vulnerable' ? r.complexity.type : r.status;
      tally[verdict] = (tally[verdict] || 0) + 1;
      if (verdict === 'exponential') flagged.push({ ...it, attack: r.attack && r.attack.string });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  console.log('recheck verdicts:', JSON.stringify(tally));
  let hangs = 0;
  for (const f of flagged) {
    const res = spawnSync(process.execPath, ['-e', probe, f.source, f.flags, f.attack || ''], { timeout: 2000 });
    const hung = Boolean(res.error);
    if (hung) hangs++;
    console.log(`  ${hung ? 'HANGS V8' : 'finishes'}  ${f.pattern} ${JSON.stringify(f.opts)}  /${f.source}/${f.flags}`);
  }
  console.log(`${flagged.length} called exponential by recheck; ${hangs} of them hang V8`);
  process.exit(hangs ? 1 : 0);
})();
