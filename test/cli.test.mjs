// node --test test/cli.test.mjs   (run `node verify/prepare.mjs` first: it
// downloads the official picomatch 4.0.7 and 2.3.2 that these tests copy around)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'picomatch-guard.mjs');
const WORK = path.join(ROOT, 'verify', '.work');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'patches', 'manifest.json'), 'utf8'));
const VERSIONS = Object.keys(MANIFEST.versions);
const { hasExponentialBacktracking } = require(path.join(ROOT, 'lib', 'ambiguity.js'));

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const official = v => path.join(WORK, `official-${v}`);

for (const v of VERSIONS) {
  if (!fs.existsSync(path.join(official(v), 'package.json'))) {
    throw new Error(`verify/.work/official-${v} is missing: run "node verify/prepare.mjs" first`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picomatch-guard-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

// A project folder with official picomatch copies at the given node_modules paths.
function project(layout) {
  const dir = path.join(tmp, `p${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t","version":"1.0.0","private":true}');
  for (const [rel, version] of Object.entries(layout)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(official(version.replace(/^fake:/, '').split('@')[0]), target, { recursive: true });
    if (version.includes('@')) {
      // fake:4.0.7@4.0.6 -> copy 4.0.7, relabel it 4.0.6
      const pkgFile = path.join(target, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      pkg.version = version.split('@')[1];
      fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    }
  }
  return dir;
}

function cli(dir, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args, '--root', dir], {
    encoding: 'utf8',
    env: { ...process.env, PICOMATCH_GUARD_OFFLINE: '1' },
    timeout: 120000
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const parseOf = (dir, rel) => path.join(dir, rel, 'lib', 'parse.js');

test('manifest hashes match the files in patches/', () => {
  for (const [v, e] of Object.entries(MANIFEST.versions)) {
    assert.equal(sha256(path.join(ROOT, 'patches', e.patched)), e.patchedSha256, `${v} patched`);
    assert.equal(sha256(path.join(ROOT, 'patches', e.official)), e.officialSha256, `${v} official`);
    assert.equal(sha256(path.join(official(v), 'lib', 'parse.js')), e.officialSha256, `${v} npm tarball`);
  }
});

test('the patch only adds lines to the official parse.js', () => {
  for (const e of Object.values(MANIFEST.versions)) {
    const before = fs.readFileSync(path.join(ROOT, 'patches', e.official), 'utf8').split('\n');
    const after = fs.readFileSync(path.join(ROOT, 'patches', e.patched), 'utf8').split('\n');
    let i = 0;
    for (const line of after) if (i < before.length && line === before[i]) i++;
    assert.equal(i, before.length, 'every official line survives, in order');
  }
});

test('apply patches npm, nested, scoped and pnpm layouts, and is idempotent', () => {
  const layout = {
    'node_modules/picomatch': '2.3.2',
    'node_modules/a/node_modules/picomatch': '4.0.7',
    'node_modules/@scope/b/node_modules/picomatch': '4.0.7',
    'node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch': '4.0.7'
  };
  const dir = project(layout);
  const first = cli(dir, 'apply');
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /patched 4 copies/);
  for (const [rel, v] of Object.entries(layout)) assert.equal(sha256(parseOf(dir, rel)), MANIFEST.versions[v].patchedSha256, rel);
  const second = cli(dir, 'apply');
  assert.equal(second.code, 0);
  assert.match(second.out, /4 of 4 installed copies patched; nothing to do/);
  const status = cli(dir, 'status');
  assert.equal((status.out.match(/ patched /g) || []).length, 4, status.out);
});

test('apply leaves a modified file alone, warns, and still exits 0', () => {
  const dir = project({ 'node_modules/picomatch': '4.0.7' });
  const file = parseOf(dir, 'node_modules/picomatch');
  fs.appendFileSync(file, '\n// local edit\n');
  const before = sha256(file);
  const res = cli(dir, 'apply');
  assert.equal(res.code, 0);
  assert.match(res.out, /neither the official nor the patched file; left untouched/);
  assert.equal(sha256(file), before);
});

test('apply reports an unsupported version without touching it', () => {
  const dir = project({ 'node_modules/picomatch': 'fake:4.0.7@4.0.6' });
  const file = parseOf(dir, 'node_modules/picomatch');
  const before = sha256(file);
  const res = cli(dir, 'apply');
  assert.equal(res.code, 0);
  assert.match(res.out, /4\.0\.6 .* is not covered .* update it to 4\.0\.7/);
  assert.equal(sha256(file), before);
});

test('apply exits 0 in a project without node_modules', () => {
  const dir = project({});
  const res = cli(dir, 'apply');
  assert.equal(res.code, 0);
  assert.match(res.out, /no picomatch installed/);
});

test('apply does not write through a hard link (pnpm store)', () => {
  const dir = project({ 'node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch': '4.0.7' });
  const file = parseOf(dir, 'node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch');
  const store = path.join(dir, 'store-parse.js');
  fs.renameSync(file, store);
  fs.linkSync(store, file);
  assert.equal(cli(dir, 'apply').code, 0);
  assert.equal(sha256(file), MANIFEST.versions['4.0.7'].patchedSha256);
  assert.equal(sha256(store), MANIFEST.versions['4.0.7'].officialSha256, 'the store copy is unchanged');
});

test('restore puts the official file back', () => {
  const dir = project({ 'node_modules/picomatch': '2.3.2', 'node_modules/a/node_modules/picomatch': '4.0.7' });
  cli(dir, 'apply');
  const res = cli(dir, 'restore');
  assert.equal(res.code, 0, res.out);
  assert.equal(sha256(parseOf(dir, 'node_modules/picomatch')), MANIFEST.versions['2.3.2'].officialSha256);
  assert.equal(sha256(parseOf(dir, 'node_modules/a/node_modules/picomatch')), MANIFEST.versions['4.0.7'].officialSha256);
});

test('selftest passes on patched copies', () => {
  const dir = project({ 'node_modules/picomatch': '2.3.2', 'node_modules/a/node_modules/picomatch': '4.0.7' });
  cli(dir, 'apply');
  const res = cli(dir, 'selftest');
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /all checks passed/);
  assert.equal((res.out.match(/24\/24 attacks finished/g) || []).length, 2, res.out);
});

test('selftest fails on an official copy (the attacks really hang it)', () => {
  const dir = project({ 'node_modules/picomatch': '4.0.7' });
  const res = cli(dir, 'selftest');
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /did not finish \(time limit\)/);
});

test('patched copies return at once on attacks and match ordinary globs as before', () => {
  for (const v of VERSIONS) {
    const dir = project({ 'node_modules/picomatch': v });
    cli(dir, 'apply');
    const pm = require(path.join(dir, 'node_modules', 'picomatch'));
    const orig = require(official(v));
    const t = Date.now();
    assert.equal(pm.isMatch('a'.repeat(5000) + '/', '+(*a)'), false);
    assert.equal(pm.isMatch('a/'.repeat(2500) + 'a', '+(**/a)b'), false);
    assert.ok(Date.now() - t < 2000, 'attacks finish quickly');
    for (const [s, p] of [['src/app/page.tsx', 'src/**/*.{ts,tsx}'], ['x/foo.spec.ts', '**/?(*.)+(spec|test).[jt]s?(x)'], ['a/b/c.jsx', '**/*.+(js|jsx)']]) {
      assert.equal(pm.isMatch(s, p), orig.isMatch(s, p), `${p} vs ${s}`);
      assert.equal(pm.makeRe(p).source, orig.makeRe(p).source, p);
    }
  }
});

test('the npm package contains exactly the expected files', () => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(res.status, 0, res.stderr);
  const files = JSON.parse(res.stdout.slice(res.stdout.indexOf('[')))[0].files.map(f => f.path).sort();
  assert.deepEqual(files, [
    'LICENSE', 'README.md', 'bin/picomatch-guard.mjs', 'lib/ambiguity.js', 'package.json',
    'patches/2.3.2/parse.js', 'patches/4.0.7/parse.js', 'patches/manifest.json',
    'patches/official/2.3.2/parse.js', 'patches/official/4.0.7/parse.js', 'patches/picomatch-redos-guard.diff'
  ]);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {}, 'no runtime dependencies');
  assert.equal(pkg.scripts?.install ?? pkg.scripts?.postinstall ?? pkg.scripts?.preinstall, undefined, 'no install scripts of its own');
});

// --- the analyzer on its own -------------------------------------------------

const exponential = [
  '(a|a)+', '(?:a|aa)+', '(a*)*', '(a+)+', '(?:[^/]*?a)+', '(?:a|[ab])+', '(?:ab*|b)+',
  '(?:a[^/]*?|b)*', '^(?:(?=.)(?:[^/]*?)+)$', '(\\w+\\s?)+$', '(x+x+)+y', '(?:ab|abab)+',
  '(?:W[^/]*?, [^/]*?)*', '(?:(?!f)[^/]*?)*', '(?:a|a[^/])+', '(.*a){2,}', '(?:[^\\\\/]*?a)+',
  '(?:\\[\\W\\]|[\\W])+', '(?:\\[\\S\\]|[\\S])+', '(?!(?:(?:a)+)+)b', '(?<=(a+)+)b',
  '(?:a(?:|)b)+', '(?:a(?:|)(?:|)b)+', '(?:a(?:|b?)c)+', '(?:a(?:(?=b)|)b)+',
  '(?:(?:a?)+b)+', '(?:(?:|a){2})+',
  '(?:[^\\W]|a)+', '(?:[^\\D]|1)+', '(?:[^\\S]| )+', '(?:[^\\Wb]|a)+',
  '(?:\\012|\\n)+', '(?:[\\1]|\\x01)+', '(?:[\\c1]|\\x11)+',
  '^(ab)(?:\\1?ab)+$', '(?:(a)\\1|aa)+', '(?:(a)(?:\\1|a))+',
  'a)+' // unparseable: treated as unsafe
];
const exponentialWithFlags = [
  ['(?:.|\\n)+x', 's'], ['(?:[\\u0100-\\u2000]|S)+', 'iu'], ['(?:\\u212A|k)+', 'iu'], ['(?:[a-z]|K)+', 'i'],
  ['(?:\\[!\\Wb\\]|[!\\Wb])+', 'i'], ['(?:[!\\Wb]|B)+', 'i'], ['(?:A|a)+', 'i'], ['(?:\\p{L}|a)+', 'u'],
  ['(?:\\u{61}|a)+', 'u'], ['(?:\\uD83D\\uDE00|\\u{1F600})+', 'u'], ['(?:\u{1F600}|\\uD83D\\uDE00)+', '']
];
const safe = [
  '(?:js|jsx)+', '(?:of|oof(?:o)+)*', 'a*b*', '(?:ab)+', '[^/]*?\\.js', '(?:a|b)+', '(?:spec|test)',
  '^(?:(?!\\.)(?=.)[^/]*?\\.js\\/?)$', '(?:f|of(?:o)+)*', '(?:x(?:a|aa))+', 'a+', '[ab]+',
  '(?:a[^/])+', '(?:[^/]*?\\/)+', '(?:a|b|c)*d', '^(?:(?=.)a*)$', '(?:A|a)+', '(?:\\[\\w\\]|[\\w])+',
  '(?:\\[\\d\\]|[\\d])+', '(?:(?:a)+b)+', '[]+', '(?:a){3}',
  '(?:a?)+', '(?:a(?:)?b)+', '(?:a(?:)*b)+', '(?:a(?:b?)?c)+', '(?:.|\\n)+x', '(?:[^\\Wa]|a)+',
  '(\\w)(?:\\1)+', '([^/]*?)\\/(\\1)+\\/(\\1)+'
];

test('analyzer flags exponentially ambiguous regexes', () => {
  for (const s of exponential) assert.equal(hasExponentialBacktracking(s), true, s);
  for (const [s, f] of exponentialWithFlags) assert.equal(hasExponentialBacktracking(s, f), true, `${s} /${f}`);
});

test('analyzer does not flag safe regexes', () => {
  for (const s of safe) assert.equal(hasExponentialBacktracking(s), false, s);
});
