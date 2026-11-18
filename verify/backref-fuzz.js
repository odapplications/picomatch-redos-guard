// node verify/backref-fuzz.js lib/ambiguity.js
// Random regexes with a capture and backreferences inside a loop, checked in V8
// for each captured value. A regex that hangs but is not flagged is a MISS.
const { spawn } = require('child_process');
const { hasExponentialBacktracking } = require(require("path").resolve(process.argv[2]));

const atoms = ['a', 'b', '\\1', '\\1\\1', '(?:\\1|a)', '(?:a|\\1)', '(?:\\1|)', 'a?', '\\1?', '(?:\\1|b)', '(?:\\1a|a\\1)', '[ab]'];
const bodies = new Set();
for (const x of atoms) {
  bodies.add(x);
  for (const y of atoms) {
    bodies.add(x + y);
    bodies.add(`(?:${x}|${y})`);
    for (const z of ['a', 'b', '\\1']) bodies.add(x + y + z);
  }
}
const captures = ['', 'a', 'aa', 'ab', 'b'];
const jobs = [];
for (const body of bodies) {
  if (!body.includes('\\1')) continue;
  for (const w of captures) {
    for (const loop of ['+', '*']) jobs.push({ src: `^(${w})(?:${body})${loop}$`, w });
  }
}

const probe = `
const re = new RegExp(process.argv[1]);
const w = process.argv[2];
const units = ['a', 'b', 'aa', 'ab', 'ba', w, w + 'a', 'a' + w, w + w, w + 'b'].filter(Boolean);
for (const u of units) for (const e of ['!', 'c']) re.test(w + u.repeat(26) + e);
`;

let next = 0;
const misses = [];
let hangs = 0;
let flaggedSafe = 0;
const one = () => new Promise(resolve => {
  if (next >= jobs.length) return resolve(false);
  const { src, w } = jobs[next++];
  const c = spawn(process.execPath, ['-e', probe, src, w]);
  const timer = setTimeout(() => c.kill(), 2000);
  c.on('exit', code => {
    clearTimeout(timer);
    const hung = code !== 0;
    const flagged = hasExponentialBacktracking(src);
    if (hung) hangs++;
    if (hung && !flagged) misses.push(src);
    if (!hung && flagged) flaggedSafe++;
    resolve(true);
  });
});
(async () => {
  await Promise.all(Array.from({ length: 8 }, async () => { while (await one()); }));
  console.log(`${jobs.length} backreference regexes: ${hangs} hang in V8, ${misses.length} of those NOT flagged (misses), ${flaggedSafe} flagged but finished with these inputs`);
  for (const m of misses.slice(0, 30)) console.log('   MISS', m);
})();
