#!/usr/bin/env node
// picomatch-redos-guard: patch installed picomatch copies so that a glob whose
// regex would backtrack exponentially is matched as literal text instead of
// freezing the process. See README.md.
//
//   picomatch-guard apply      patch every installed picomatch 4.0.7 / 2.3.2 (use in postinstall)
//   picomatch-guard status     show each installed copy and whether it is patched
//   picomatch-guard selftest   prove installed copies resist known attacks and still match normally
//   picomatch-guard restore    put the official lib/parse.js back
//
// Options: --root <dir>  project folder (default: the folder npm was run from)
//          --quiet       print only changes and warnings
//
// `apply` replaces lib/parse.js only when it is byte-for-byte the official file
// for that version (sha256 in patches/manifest.json), re-checks the hash after
// writing, never touches the network, and never fails an install.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = path.join(HERE, '..', 'patches');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PATCHES, 'manifest.json'), 'utf8'));
const TAG = '[picomatch-guard]';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const cmd = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--root') || 'status';
const ROOT = path.resolve(option('root') || process.env.INIT_CWD || process.cwd());
const quiet = flag('quiet');
const log = (...m) => console.log(TAG, ...m);

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// --- installed copies -------------------------------------------------------

// Walks node_modules (npm, Yarn classic) and node_modules/.pnpm (pnpm). Symlinks
// are skipped, so a pnpm copy is visited once, at its real location.
function findInstalls() {
  const found = [];
  const seen = new Set();
  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === '.pnpm') {
        for (const store of fs.readdirSync(full, { withFileTypes: true })) {
          if (store.isDirectory()) walk(path.join(full, store.name, 'node_modules'));
        }
        continue;
      }
      if (e.name.startsWith('.')) continue;
      if (e.name.startsWith('@')) {
        walk(full);
        continue;
      }
      if (e.name === 'picomatch' && !seen.has(full)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8'));
          if (pkg.name === 'picomatch') {
            seen.add(full);
            found.push({ dir: full, version: pkg.version });
          }
        } catch {
          /* not a package */
        }
      }
      walk(path.join(full, 'node_modules'));
    }
  };
  walk(path.join(ROOT, 'node_modules'));
  return found;
}

function inspect(install) {
  const entry = MANIFEST.versions[install.version];
  const file = path.join(install.dir, 'lib', 'parse.js');
  const rel = path.relative(ROOT, install.dir).split(path.sep).join('/');
  const base = { ...install, rel, file, entry };
  if (!entry) return { ...base, state: 'unsupported' };
  let hash;
  try {
    hash = sha256(file);
  } catch {
    return { ...base, state: 'missing' };
  }
  if (hash === entry.patchedSha256) return { ...base, state: 'patched' };
  if (hash === entry.officialSha256) return { ...base, state: 'official' };
  return { ...base, state: 'modified' };
}

function writeVerified(target, source, expected) {
  const tmp = `${target}.picomatch-guard-tmp`;
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, target); // replaces the directory entry; a pnpm store hard link is left untouched
  if (sha256(target) !== expected) throw new Error('hash mismatch after write');
}

const unsupportedHint = r => {
  const line = MANIFEST.lines[r.version.split('.')[0]];
  return line
    ? `picomatch ${r.version} at ${r.rel} is not covered (only ${Object.keys(MANIFEST.versions).join(' and ')}); update it to ${line} (npm update picomatch, or an "overrides" entry) and run apply again`
    : `picomatch ${r.version} at ${r.rel} is not covered (only ${Object.keys(MANIFEST.versions).join(' and ')})`;
};

// --- commands ---------------------------------------------------------------

function apply() {
  const results = findInstalls().map(inspect);
  const changed = [];
  const problems = [];
  for (const r of results) {
    if (r.state === 'official') {
      try {
        writeVerified(r.file, path.join(PATCHES, r.entry.patched), r.entry.patchedSha256);
        changed.push(r);
      } catch (err) {
        problems.push(`${r.rel} (${r.version}): could not patch: ${err.message}`);
      }
    } else if (r.state === 'modified') {
      problems.push(`${r.rel} (${r.version}): lib/parse.js is neither the official nor the patched file; left untouched`);
    } else if (r.state === 'missing') {
      problems.push(`${r.rel} (${r.version}): lib/parse.js is missing`);
    } else if (r.state === 'unsupported') {
      problems.push(unsupportedHint(r));
    }
  }
  const patched = results.filter(r => r.state === 'patched').length + changed.length;
  if (changed.length) log(`patched ${changed.length} ${changed.length === 1 ? 'copy' : 'copies'}: ${changed.map(r => `${r.version} at ${r.rel}`).join(', ')}`);
  else if (!quiet) log(results.length ? `${patched} of ${results.length} installed copies patched; nothing to do` : 'no picomatch installed');
  for (const p of problems) log(`WARNING: ${p}`);
}

async function status() {
  const results = findInstalls().map(inspect);
  if (!results.length) log(`no picomatch installed under ${ROOT}`);
  for (const r of results) log(`${r.version.padEnd(7)} ${r.state.padEnd(11)} ${r.rel}`);
  for (const r of results.filter(x => x.state === 'unsupported')) log(`note: ${unsupportedHint(r)}`);
  if (process.env.PICOMATCH_GUARD_OFFLINE === '1') return;
  // Newer picomatch releases (npm registry only; nothing about your project is sent).
  try {
    const res = await fetch('https://registry.npmjs.org/picomatch', {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(3000)
    });
    const versions = Object.keys((await res.json()).versions || {}).filter(v => !v.includes('-'));
    const newer = v => {
      const [a, b] = [v, MANIFEST.lines[v.split('.')[0]]].map(x => x.split('.').map(Number));
      return a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]));
    };
    const fresh = versions.filter(v => MANIFEST.lines[v.split('.')[0]] && newer(v));
    if (fresh.length) log(`new picomatch release(s): ${fresh.join(', ')}. This guard does not cover them yet; check whether they still backtrack exponentially (see README).`);
    else log(`no picomatch release newer than ${Object.values(MANIFEST.lines).join(' / ')}; the guard is current.`);
  } catch (err) {
    log(`(could not check the npm registry: ${err.message}; set PICOMATCH_GUARD_OFFLINE=1 to skip)`);
  }
}

function restore() {
  const results = findInstalls().map(inspect);
  let n = 0;
  for (const r of results.filter(x => x.state === 'patched')) {
    try {
      writeVerified(r.file, path.join(PATCHES, r.entry.official), r.entry.officialSha256);
      n++;
      log(`restored the official lib/parse.js: ${r.version} at ${r.rel}`);
    } catch (err) {
      log(`WARNING: ${r.rel}: could not restore: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (!n) log('no patched copies found');
  else log('remove "picomatch-guard apply" from your postinstall script, or the next install patches them again');
}

// Each attack hangs the official 4.0.7 / 2.3.2 for seconds to forever (inputs are
// thousands of characters; the official copies double their time per repeat).
const ATTACKS = [
  ['+(*a)', {}, 'a'.repeat(5000) + '/'],
  ['+(*)c', {}, 'a'.repeat(5000)],
  ['+(a*)', {}, 'a'.repeat(5000) + '/'],
  ['*(a*|b)', {}, 'a'.repeat(5000) + '/'],
  ['+(a|a*a)', {}, 'a'.repeat(5000) + '/'],
  ['(a+|b)+', {}, 'a'.repeat(5000) + '\u0000'],
  ['(a+|b)+', { windows: true }, 'a'.repeat(5000) + '\u0000'],
  ['*(!(f))', { windows: true }, 'a'.repeat(5000) + '/'],
  ['+(!(f))', { windows: true }, 'a'.repeat(5000) + '/'],
  ['*(!(foo))', { bash: true, windows: true }, 'a'.repeat(5000) + '\n'],
  ['*/*(W*, *)*', {}, 'a/' + 'W, '.repeat(2000) + '/x'],
  ['a[\\W]+c', {}, 'a' + '[!]'.repeat(2000) + 'x'],
  ['a[\\D]+c', {}, 'a' + '[!]'.repeat(2000) + 'x'],
  ['!(+(*))', {}, 'a'.repeat(5000) + '/'],
  ['+([a]*)b', {}, 'a'.repeat(5000)],
  ['+(@(*a))', {}, 'a'.repeat(5000) + '/'],
  ['+(**/a)b', {}, 'a/'.repeat(2500) + 'a'],
  ['+(a/**)b', {}, 'a/'.repeat(2500) + 'a'],
  ['@(+(**/a))b', {}, 'a/'.repeat(2500) + 'a'],
  ['+([^\\W]|a)', {}, 'a'.repeat(5000) + '!'],
  ['+(aa@(|))', {}, 'a'.repeat(5000) + '!'],
  ['+(a**/@(|))', {}, 'a'.repeat(5000) + '!'],
  ['+([!\\Wb])', { nocase: true }, '[!!B]'.repeat(1000) + 'a'],
  ['+(+(a))', { maxExtglobRecursion: 1 }, 'a'.repeat(5000) + '!']
];

// Ordinary globs: the patched copy must compile each to exactly the same regex
// as the official file.
const ORDINARY = [
  '*', '**', '*.js', '**/*.js', '**/*.{js,ts,jsx,tsx,mdx}', './src/**/*.{js,ts,jsx,tsx}', 'src/**/!(*.test).ts',
  '!**/node_modules/**', '**/.git/**', '**/*.d.ts', '**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)',
  '**/*.+(js|jsx)', '**/@(pages|app)/**', '[abc]*.md', '[!a]*', 'foo/{bar,baz}/*.txt', '{1..3}.txt', '+(abc)',
  '*(foo|bar)', '@(a|b)', '?(a|b)', '!(*.d).ts', 'a/**/b/**/c', '**/.*', '*.config.{js,ts,mjs}', 'src/**/[A-Z]*.tsx'
];
const OPTION_SETS = [{}, { dot: true }, { windows: true }, { bash: true }, { nocase: true }, { capture: true }, { noextglob: true }];
// The one intended difference: with noextglob, Jest's default testMatch compiles
// to a regex that hangs the official copy (60 repeats of "a." take minutes).
const EXPECTED_DIFFERENCES = ['**/?(*.)+(spec|test).[jt]s?(x) {"noextglob":true}'];

function selftest() {
  const results = findInstalls().map(inspect).filter(r => r.entry);
  if (!results.length) {
    log('no supported picomatch installed');
    return;
  }
  let failed = 0;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'picomatch-guard-'));
  try {
    for (const r of results) {
      // 1. Attacks, in one child process with a time limit; it reports progress per case.
      //    The cases go in on stdin: they are too long for a command line on Windows.
      const attackCode = `const pm=require(process.argv[1]);const list=JSON.parse(require('fs').readFileSync(0,'utf8'));for(let i=0;i<list.length;i++){const[p,o,s]=list[i];pm.isMatch(s,p,o);process.stdout.write(i+'\\n')}`;
      const res = spawnSync(process.execPath, ['-e', attackCode, r.dir], { input: JSON.stringify(ATTACKS), timeout: 20000, encoding: 'utf8' });
      const done = (res.stdout || '').trim().split('\n').filter(Boolean).length;
      if (done < ATTACKS.length) {
        failed++;
        const [p, o] = ATTACKS[done];
        const why = res.error ? (res.error.code === 'ETIMEDOUT' ? 'time limit' : res.error.code || res.error.message) : (res.stderr || '').trim().split('\n')[0];
        log(`FAIL ${r.rel}: ${p} ${JSON.stringify(o)} did not finish (${why})`);
      }
      // 2. Ordinary globs vs the official file, in a temporary copy of this package.
      const official = path.join(work, `official-${r.version}`);
      fs.cpSync(r.dir, official, { recursive: true, dereference: true });
      fs.copyFileSync(path.join(PATCHES, r.entry.official), path.join(official, 'lib', 'parse.js'));
      const cmpCode = `const a=require(process.argv[1]),b=require(process.argv[2]);const bad=[];for(const p of JSON.parse(process.argv[3]))for(const o of JSON.parse(process.argv[4])){const s=m=>{try{return m.makeRe(p,o).source}catch(e){return 'ERR '+e.message}};if(s(a)!==s(b))bad.push(p+' '+JSON.stringify(o))}console.log(JSON.stringify(bad))`;
      const cmp = spawnSync(process.execPath, ['-e', cmpCode, r.dir, official, JSON.stringify(ORDINARY), JSON.stringify(OPTION_SETS)], { encoding: 'utf8', timeout: 20000 });
      let bad;
      try {
        bad = JSON.parse(cmp.stdout);
      } catch {
        bad = [`comparison failed: ${(cmp.stderr || '').split('\n')[0]}`];
      }
      if (r.state === 'patched') bad = bad.filter(b => !EXPECTED_DIFFERENCES.includes(b));
      for (const b of bad) log(`FAIL ${r.rel}: ordinary glob compiles differently: ${b}`);
      failed += bad.length;
      log(`${r.version} ${r.state.padEnd(9)} ${r.rel}: ${Math.min(done, ATTACKS.length)}/${ATTACKS.length} attacks finished, ${ORDINARY.length * OPTION_SETS.length - bad.length}/${ORDINARY.length * OPTION_SETS.length} ordinary glob/option pairs as expected`);
      if (r.state !== 'patched') log(`   (this copy is ${r.state}; run "picomatch-guard apply")`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const unpatched = results.filter(r => r.state !== 'patched').length;
  log(failed ? `${failed} FAILED` : unpatched ? `checks done; ${unpatched} copies are not patched` : 'all checks passed');
  if (failed) process.exitCode = 1;
}

const commands = { apply, status, selftest, restore };
if (!commands[cmd]) {
  console.error(`${TAG} unknown command "${cmd}". Use: ${Object.keys(commands).join(', ')}`);
  process.exitCode = 1;
} else {
  try {
    await commands[cmd]();
  } catch (err) {
    log(`error: ${err.stack || err}`);
    if (cmd !== 'apply') process.exitCode = 1; // never break an install
  }
}
