// node verify/differential.js <official dir> <patched dir>
// Proves the patch changes nothing for globs without extglob syntax: every
// generated pattern must compile to the identical regex source under every
// option set. Also compares a list of real-world globs (Tailwind, ESLint,
// tsconfig, fast-glob/chokidar style ignores) including some with extglobs,
// and prints any of those that differ.
'use strict';
const path = require('path');
const orig = require(path.resolve(process.argv[2]));
const pat = require(path.resolve(process.argv[3]));

const optionSets = [
  {}, { dot: true }, { windows: true }, { bash: true }, { nocase: true },
  { capture: true }, { contains: true }, { noextglob: true }, { nobrace: true },
  { posix: true }, { strictSlashes: true }, { noglobstar: true }, { regex: true },
  { dot: true, windows: true }, { fastpaths: false }
];

const atoms = ['a', 'b', '*', '**', '/', '.', '?', '[ab]', '[!a]', '{a,b}', '{1..3}', '!', '\\*', 'js', ',', '-', ' ', '$', '^', '+', '@'];
const pats = new Set();
const gen = (cur, depth) => {
  if (cur.length) pats.add(cur.join(''));
  if (depth === 0) return;
  for (const t of atoms) gen([...cur, t], depth - 1);
};
gen([], 4);

const src = (m, p, o) => {
  try { return m.makeRe(p, o).source; } catch (e) { return `ERR:${e.message}`; }
};

let compared = 0;
const diffs = [];
for (const p of pats) {
  if (p.includes('(')) continue; // extglob syntax: handled separately
  for (const o of optionSets) {
    compared++;
    const a = src(orig, p, o);
    const b = src(pat, p, o);
    if (a !== b) diffs.push({ p, o, a, b });
  }
}
console.log(`no-extglob corpus: ${compared} pattern/option pairs compared, ${diffs.length} differ`);
for (const d of diffs.slice(0, 20)) console.log(JSON.stringify(d));

const realWorld = [
  './src/pages/**/*.{js,ts,jsx,tsx,mdx}', './src/components/**/*.{js,ts,jsx,tsx,mdx}', './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  '**/*.ts', '**/*.tsx', 'next-env.d.ts', '.next/types/**/*.ts', 'node_modules', '**/node_modules/**', '**/.git/**',
  '**/*.d.ts', '**/*.{js,mjs,cjs}', '!**/*.test.ts', 'src/**/!(*.test).ts', '**/@(pages|app)/**', '**/*.+(js|jsx)',
  '**/?(*.)+(spec|test).[jt]s?(x)', '**/__tests__/**/*.[jt]s?(x)', 'pages/**/*.{js,jsx,ts,tsx}', 'app/**/*.{js,jsx,ts,tsx}',
  '**/.*', '**/*.css', '{src,app}/**', 'src/**/[A-Z]*.tsx', '**/*.min.js', '*.config.{js,ts,mjs}', '**/dist/**'
];
const rwDiffs = [];
for (const p of realWorld) for (const o of optionSets) {
  const a = src(orig, p, o);
  const b = src(pat, p, o);
  if (a !== b) rwDiffs.push(`${p} ${JSON.stringify(o)}\n    orig: ${a}\n    new:  ${b}`);
}
console.log(`real-world globs: ${realWorld.length * optionSets.length} pairs compared, ${rwDiffs.length} differ`);
for (const d of rwDiffs) console.log('  ' + d);
