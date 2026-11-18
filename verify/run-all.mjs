// node verify/run-all.mjs [--official]
// Runs every check in this folder against the copies verify/prepare.mjs built.
// --official also fuzzes the untouched copies, to show how many patterns hang
// them (slow: thousands of patterns each wait out the time budget).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, '.work');
const versions = ['4.0.7', '2.3.2'];
if (!versions.every(v => fs.existsSync(path.join(WORK, `patched-${v}`)))) {
  console.error('Run "node verify/prepare.mjs" first.');
  process.exit(1);
}
const budget = process.env.FUZZ_BUDGET_MS || '500'; // CI uses a larger budget: shared runners are slower
const run = (title, script, ...argv) => {
  console.log(`\n== ${title}`);
  const res = spawnSync(process.execPath, [path.join(HERE, script), ...argv], { stdio: 'inherit' });
  // The OFFICIAL fuzz runs are expected to find hanging patterns; they do not fail the run.
  if (res.status !== 0 && !title.includes('OFFICIAL')) process.exitCode = 1;
};
const dir = (kind, v) => path.join(WORK, `${kind}-${v}`);
const analyzer = path.join(HERE, '..', 'lib', 'ambiguity.js');

for (const v of versions) {
  run(`${v}: ordinary globs, official vs patched`, 'differential.js', dir('official', v), dir('patched', v));
  run(`${v}: wide fuzz, patched`, 'fuzz-wide.js', dir('patched', v), budget);
  run(`${v}: targeted fuzz, patched`, 'fuzz-targeted.js', dir('patched', v), budget);
  if (process.argv.includes('--official')) {
    run(`${v}: wide fuzz, OFFICIAL`, 'fuzz-wide.js', dir('official', v), budget);
    run(`${v}: targeted fuzz, OFFICIAL`, 'fuzz-targeted.js', dir('official', v), budget);
  }
}
run('analyzer soundness audit', 'soundness.js', analyzer);
run('analyzer backreference fuzz', 'backref-fuzz.js', analyzer);
