// node verify/fuzz-targeted.js <picomatch dir> [budgetMs]
// Targets the shapes the guard's first revision missed: negated escape classes
// ([!\W], [^\W], [!\D], [!\S]), empty branches (+(a|), @(|)), optional pieces,
// and combinations with globstars and slashes. Same worker/budget harness as fuzz-wide.js.
'use strict';
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os');

if (!isMainThread) {
  const pm = require(workerData.dir);
  parentPort.on('message', ({ pattern, inputs }) => {
    for (const input of inputs) {
      for (const opts of [{}, { windows: true }, { dot: true }, { bash: true }, { nocase: true }]) {
        try { pm.isMatch(input, pattern, opts); } catch (e) { /* invalid pattern: fine */ }
      }
    }
    parentPort.postMessage(0);
  });
  return;
}

const dir = require('path').resolve(process.argv[2]);
const budget = Number(process.argv[3] || 500);

const atoms = ['a', '*', '**/', '?', '[!\\W]', '[^\\W]', '[!\\D]', '[!\\S]', '[!\\Wb]', '[\\W]', '@(|)', '?(a)', '@(a|)', '[a]'];
const bodies = new Set();
const gen = (cur, depth) => {
  if (cur.length) bodies.add(cur.join(''));
  if (depth === 0) return;
  for (const t of atoms) gen([...cur, t], depth - 1);
};
gen([], 3);
const patterns = new Set();
for (const b of bodies) {
  for (const op of ['+', '*']) {
    patterns.add(`${op}(${b})`);
    patterns.add(`${op}(${b})b`);
    patterns.add(`${op}(a|${b})`);
    patterns.add(`${op}(${b}|)`);
    patterns.add(`${op}(|${b})b`);
  }
  patterns.add(`@(+(${b}))b`);
}

const inputsFor = () => {
  const out = [];
  for (const unit of ['a', '1', ' ', 'ab', 'a1', 'a/', '/a', 'a ', '!']) {
    for (const end of ['!', '/', '\n', 'b!', '\u0000']) out.push(unit.repeat(40) + end);
  }
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
    const timer = setTimeout(() => { slow.push(pattern); w.terminate(); w = spawn(); step(); }, budget);
    w.once('message', () => { clearTimeout(timer); step(); });
    w.postMessage({ pattern, inputs: inputsFor() });
  };
  step();
});
(async () => {
  const n = Math.max(2, Math.min(8, os.cpus().length - 1));
  const t = Date.now();
  await Promise.all(Array.from({ length: n }, runOne));
  console.log(`${list.length} patterns x ${inputsFor().length} inputs x 5 option sets, budget ${budget}ms: ${slow.length} slow (${Math.round((Date.now() - t) / 1000)} s)`);
  if (slow.length) console.log(slow.slice(0, 40).join('\n'));
})();
