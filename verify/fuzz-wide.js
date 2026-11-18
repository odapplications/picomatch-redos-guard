// node verify/fuzz-wide.js <picomatch dir> [budgetMs]
// ReDoS fuzz over extglobs built from slashes, globstars next to slashes and
// bracket classes ([a], [!a], [\W], [\D], [\S], [^/]), and also tries
// brackets/groups followed by a bare + or * (not only extglobs).
// Each pattern runs in a worker with a hard time budget.
'use strict';
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os');

if (!isMainThread) {
  const pm = require(workerData.dir);
  parentPort.on('message', ({ pattern, inputs }) => {
    const t = Date.now();
    for (const input of inputs) {
      for (const opts of [{}, { windows: true }, { dot: true }, { bash: true }]) {
        try { pm.isMatch(input, pattern, opts); } catch (e) { /* invalid pattern: fine */ }
      }
    }
    parentPort.postMessage(Date.now() - t);
  });
  return;
}

const dir = require('path').resolve(process.argv[2]);
const budget = Number(process.argv[3] || 300);

const atoms = ['a', '*', '**', '?', '/', '**/', '/**', '.', ' ', '[a]', '[!a]', '[\\W]', '[\\D]', '[\\S]', '[^/]', '\\*'];
const bodies = new Set();
const gen = (cur, depth) => {
  if (cur.length) bodies.add(cur.join(''));
  if (depth === 0) return;
  for (const t of atoms) gen([...cur, t], depth - 1);
};
gen([], 3);

const ops = ['+', '*', '?', '@', '!'];
const patterns = new Set();
for (const b of bodies) {
  for (const op of ['+', '*']) {
    patterns.add(`${op}(${b})`);
    patterns.add(`${op}(${b})b`);
    patterns.add(`${op}(a|${b})`);
  }
  patterns.add(`x${b}+y`);
  patterns.add(`@(+(${b}))b`);
  patterns.add(`!(+(${b}))`);
}
const small = ['a', '*', 'a*', '*a', '**/a', 'a/**', '[a]*', '!(a)', 'a|b', '*|a', '[\\W]'];
for (const o1 of ops) for (const o2 of ops) for (const b of small) {
  patterns.add(`${o1}(${o2}(${b}))`);
  patterns.add(`${o1}(${o2}(${b})|a)`);
  patterns.add(`${o1}(${o2}(${b}))b`);
  patterns.add(`**/${o1}(${o2}(${b}))`);
}

const inputsFor = pattern => {
  const lits = [...new Set(pattern.replace(/[()|+@!?*"\\[\]^]/g, '').split(''))].join('') || 'a';
  const unit = (lits + 'a').slice(0, 3);
  const out = [];
  for (const end of ['!', '/', '\n', 'x']) {
    out.push('a'.repeat(300) + end);
    out.push(unit.repeat(100) + end);
    out.push((unit + '/').repeat(60) + end);
    out.push('a/'.repeat(150) + end);
  }
  out.push('[!]'.repeat(100) + 'x', 'a' + '[!]'.repeat(100) + 'x', '/'.repeat(300) + 'x', 'W, '.repeat(100) + '/x');
  return out;
};

const list = [...patterns];
const slow = [];
let next = 0;

const runOne = () => new Promise(resolve => {
  const spawn = () => new Worker(__filename, { workerData: { dir } });
  let w = spawn();
  const step = () => {
    if (next >= list.length) { w.terminate(); return resolve(); }
    const pattern = list[next++];
    const timer = setTimeout(() => {
      slow.push(pattern);
      w.terminate();
      w = spawn();
      step();
    }, budget);
    w.once('message', () => {
      clearTimeout(timer);
      step();
    });
    w.postMessage({ pattern, inputs: inputsFor(pattern) });
  };
  step();
});

(async () => {
  const n = Math.max(2, Math.min(8, os.cpus().length - 1));
  const t = Date.now();
  await Promise.all(Array.from({ length: n }, runOne));
  console.log(`${list.length} patterns x ${inputsFor('a').length} inputs x 4 option sets, budget ${budget}ms: ${slow.length} slow (${Math.round((Date.now() - t) / 1000)} s)`);
  if (slow.length) console.log(slow.slice(0, 80).join('\n'));
  if (slow.length) process.exitCode = 1;
})();
