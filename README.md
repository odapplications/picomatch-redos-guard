# picomatch-redos-guard

[![CI](https://github.com/odapplications/picomatch-redos-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/odapplications/picomatch-redos-guard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/picomatch-redos-guard)](https://www.npmjs.com/package/picomatch-redos-guard)
[![license](https://img.shields.io/npm/l/picomatch-redos-guard)](LICENSE)

**Defence-in-depth hardening for [picomatch](https://github.com/micromatch/picomatch).**
Some glob patterns compile to regular expressions that take exponential time
(ReDoS): one bad pattern and a short string can freeze a Node.js process for
seconds, minutes or longer. This guard patches the installed picomatch so that
such a pattern is matched as literal text instead, the same fallback picomatch
already uses for the risky extglobs it knows about. Every other glob compiles
exactly as before.

> Not affiliated with picomatch or micromatch. This is an independent patch,
> MIT licensed like picomatch itself. The picomatch maintainers consider this
> behaviour expected (see [Is this a vulnerability?](#is-this-a-vulnerability)).

```js
const picomatch = require('picomatch'); // official 4.0.7 or 2.3.2

picomatch.isMatch('a'.repeat(24) + '/', '+(*a)'); //  1.3 s
picomatch.isMatch('a'.repeat(26) + '/', '+(*a)'); //  5.1 s
picomatch.isMatch('a'.repeat(28) + '/', '+(*a)'); // 20.4 s; every 2 more characters is about 4x slower

// with the guard: about 4 ms, and false, for any length
```

## Contents

- [Quick start](#quick-start)
- [Is this a vulnerability?](#is-this-a-vulnerability)
- [Who should use it](#who-should-use-it)
- [How it works](#how-it-works)
- [What changes, and what does not](#what-changes-and-what-does-not)
- [How it was verified](#how-it-was-verified)
- [Limits](#limits)
- [Other ways to use it](#other-ways-to-use-it)
- [Commands](#commands)
- [History](#history)
- [Contributing and releases](#contributing-and-releases)

## Quick start

Supported: picomatch **4.0.7** and **2.3.2**, the latest release of each line
(2.3.2 is what micromatch 4, chokidar 3, fast-glob 3 and anymatch use). Node 18+.
Works with npm, Yarn classic and pnpm.

### Install from npm (recommended)

```sh
npm install picomatch-redos-guard
```

Then add the hooks to your `package.json`:

```json
{
  "scripts": {
    "postinstall": "picomatch-guard apply || exit 0",
    "prebuild": "picomatch-guard apply --quiet || exit 0"
  }
}
```

Or add both entries by hand:

```json
{
  "dependencies": {
    "picomatch-redos-guard": "^1.0.1"
  },
  "scripts": {
    "postinstall": "picomatch-guard apply || exit 0",
    "prebuild": "picomatch-guard apply --quiet || exit 0"
  }
}
```

Then run a plain install:

```sh
npm install                    # downloads the guard, then postinstall patches picomatch
npx picomatch-guard selftest   # optional proof: 24 attacks finish, ordinary globs unchanged
```

From then on, every `npm install` and `npm ci` patches picomatch
automatically, on your machine, in CI and in Docker builds:

- **Docker:** this works even when the image copies only
  `package.json` / `package-lock.json` before `npm ci`, because the guard is
  in `node_modules` by the time `postinstall` runs.
- **Your build log** shows `[picomatch-guard] patched 2 copies: ...`.
- **`prebuild`** is optional. It is a second chance for an install that ran
  with `--ignore-scripts`. Leave it out if your project has no `build` script.

Notes:

- **Your `package-lock.json` pins the exact version and its sha512**, so
  every `npm ci` installs the same bytes.
- **Already have a `postinstall`?** Chain the two commands:
  `"postinstall": "your-existing-command && picomatch-guard apply"`.
- **Keep it in `dependencies`, not `devDependencies`**, if any production
  install skips dev dependencies (`npm ci --omit=dev`, many Docker images).
  Otherwise the `picomatch-guard` command does not exist there. The package
  has no dependencies and is a 62 KB download.
- **`npm install picomatch-redos-guard` doesn't run your own `postinstall`**
  when it adds a single package. Run `npx picomatch-guard apply` once, or a
  plain `npm install` after adding the hooks.
- **Yarn classic and pnpm** work the same way (`yarn add` / `pnpm add`), and
  run the root `postinstall` too.
- **`apply` never fails an install.** It patches a file only when it is
  byte-for-byte the official one (sha256 in `patches/manifest.json`), checks the
  hash again after writing, and leaves anything unexpected alone with a warning.
  It makes no network requests.
- **Older picomatch versions** (for example 4.0.6 or 2.3.1) are reported, not
  patched. Update with `npm update picomatch`, or force a version with an
  [`overrides`](https://docs.npmjs.com/cli/configuring-npm/package-json#overrides)
  entry, then run `npm install` again.

To undo: run `npx picomatch-guard restore`, which puts the official file back
(hash checked). Then remove the two scripts and the dependency.

### Alternative: the GitHub Release file

To avoid the npm registry, point the dependency at the release tarball
instead. It's the same file that's on npm:

```json
"picomatch-redos-guard": "https://github.com/odapplications/picomatch-redos-guard/releases/download/v1.0.1/picomatch-redos-guard-1.0.1.tgz"
```

### Alternative: install from the git repository

```sh
npm install github:odapplications/picomatch-redos-guard#v1.0.1
npx picomatch-guard apply
```

This needs `git` wherever you install, and some slim Docker images lack it.
Add the same `postinstall` script as above.

## Is this a vulnerability?

It depends on who writes your globs, and the honest answer has two sides.

- **The behaviour is real.** The official 4.0.7 and 2.3.2 hang on every
  pattern listed [below](#what-changes-and-what-does-not), and fuzzing finds
  thousands more ([verification](#how-it-was-verified)). It was reported as
  CVE-2026-112366 / GHSA-fc5q-39xc-vjpf, rated high, and about twenty fix PRs
  were opened upstream. None was merged.
- **The advisory was withdrawn on 2026-11-18** at a picomatch contributor's
  request, as "not a security issue". The maintainers' position: globs *are*
  regular expressions, some regular expressions backtrack badly, and the fix
  is to never let untrusted users write globs, just as you would never let them
  write a regex. That is sound advice, and this project agrees with it.

**Withdrawn is not fixed**, though. No picomatch release changes this
behaviour, and `npm audit` no longer mentions it. Patterns don't only come from
users you distrust. They also come from:

- config files and CLI flags in tools that other people run,
- plugins and their options,
- multi-tenant systems, CMS and build settings, file watchers, ignore files,
- code written later by someone who doesn't know about this.

One such pattern is enough to pin a CPU core. The guard makes picomatch
refuse to *produce* a catastrophic regex, so a mistake degrades to "this
pattern matches nothing useful" instead of "the server stopped responding".

## Who should use it

- **Recommended** if any glob can come from outside your own code:
  - user or tenant input;
  - a plugin or third-party config;
  - a CLI tool or service that accepts patterns.
- **Optional, cheap insurance** otherwise. It costs about 3 µs per compiled
  pattern, and results are cached, so a pattern compiled again costs nothing
  extra.
- **Not a substitute** for validating untrusted input. Treat user-supplied
  globs like user-supplied regexes.

## How it works

The patch adds one check at the end of picomatch's `parse()` in
`lib/parse.js`. Lines are only added (754), never removed or changed. See
[`patches/picomatch-redos-guard.diff`](patches/picomatch-redos-guard.diff).

A backtracking engine like V8's takes exponential time on a failing match
**exactly when** the regex has *exponential degree of ambiguity* (EDA). EDA
means some state of the regex can return to itself in two different ways that
read the same text. Each extra repetition of that text then doubles the work.
Whether a given regex has EDA is decidable and fast to check. Weber and Seidl
(1991) showed it holds exactly when the product of the regex's automaton with
itself has a strongly connected component containing both a diagonal pair
`(q, q)` and a non-diagonal pair. This isn't the "star height problem", which
is about the shortest way to *write* a regex, a different question.

[`lib/ambiguity.js`](lib/ambiguity.js) builds the Glushkov (position)
automaton of the regex picomatch generated and runs that test, adapted to
backtracking:

- **Derivation counts:** every edge counts its distinct derivations, so
  `(a+)+` (inner or outer loop) and `(?:a(?:|)b)+` (either empty branch) are
  both seen as two ways round. Empty iterations of an optional repeat aren't
  counted, because JavaScript rejects them.
- **Lookarounds:** every lookaround body is analysed as a regex of its own.
- **Character classes:** computed exactly, including `[^\W]` and `[\W\D]`.
- **Flags:** `i`, `s` and `u` are honoured; case folding follows the spec's
  `Canonicalize`, for each kind of class.
- **Erring toward blocking:** every simplification reports *more* ambiguity,
  never less. Anchors and lookarounds count as empty, `{2,5}` counts as a loop,
  a backreference counts as any text, and a regex it can't parse is treated as
  unsafe.
- **Invalid regexes:** an *invalid* generated regex is left alone, because
  picomatch already turns it into one that matches nothing.

If the regex has EDA, the glob is matched as literal text. You can use the
analyzer on its own, too:

```js
const { hasExponentialBacktracking } = require('picomatch-redos-guard');
hasExponentialBacktracking('^(?:a+)+$');  // true
hasExponentialBacktracking('^(?:a|b)+$'); // false
```

Why check the *output* regex, not the glob syntax? The upstream fix PRs each
targeted particular extglob shapes, and reviewers kept finding shapes that got
past earlier ones:
`+([a]*)b`, `+(@(*a))`, `+(**/a)b`. The problem isn't even limited to
extglobs. `a[\W]+c` compiles to `a(?:\[\W\]|[\W])+c`, and `[` is itself a
non-word character, so `a[!][!][!]...` blows up. Checking the generated regex
covers every route to the problem, including ones nobody has found yet.

## What changes, and what does not

**Only patterns whose regex is exponentially ambiguous change.** Everything
else compiles to a byte-identical regex. These are the patterns from
picomatch's own test suite that change. Every one hangs the official copy on a
matching input:

| Pattern | Options | Official copy on a matching input |
|---|---|---|
| `(a+\|b)+` | `windows` / `bash` | 1.3 s at 29 characters |
| `*(!(f))`, `+(!(f))`, `*(!(foo))` | `windows` | 2.2 to 5.2 s at 29 characters |
| `*(!(f))`, `+(!(f))`, `*(!(foo))` | `bash` + `windows` | 0.6 to 1.5 s at 27 characters |
| `*(a*\|b)` | | 1.2 s at 29 characters |
| `+(*)c` | | 5.3 s at 28 characters |
| `*/*(W*, *)*`, `**/*(W*, *)*` | | 2.5 to 2.7 s at 64 characters |
| `a[\W]+c`, `a[\D]+c` | | 3.1 to 3.6 s at 85 characters |
| `+(+(a))`, `*(+(a))` | `maxExtglobRecursion: 1` | 1.2 s at 29 characters |

Each one roughly doubles per extra character or repeat. `[\w]+` and `[\d]+`
are unchanged, because there `[` cannot be matched by both branches.

- **Opting out:** `maxExtglobRecursion: false` turns the check off for a call,
  as it does for picomatch's existing extglob check.
- **Over-blocking:** the analyzer errs toward blocking, so a rare regex where,
  say, a word boundary rules out one branch, as in `(?:a(?:\b|)b)+`, is
  blocked even though V8 copes. None turned up among common globs.

## How it was verified

All numbers are for both 4.0.7 and 2.3.2, unless marked. The scripts are in
[`verify/`](verify/), and [Reproduce](#reproduce) shows how to run them.

| Check | Official | With the guard |
|---|---|---|
| **Wide fuzz:** 38,659 generated patterns (extglobs, globstars next to slashes, bracket classes) × 20 hostile inputs × 4 option sets | 13,073 hang | **0** |
| **Targeted fuzz:** 32,494 patterns (negated escape classes, empty branches, optional pieces) × 45 inputs × 5 option sets, including `nocase` | 8,900 hang | **0** |
| **Soundness audit:** 35 regexes built to exploit each simplification in the analyzer | 24 hang V8 (Node 22) | **all flagged, 0 misses** |
| **Backreferences:** 6,420 random regexes with captures and backreferences in loops, 5 captured values each | about 2,450 hang V8 (varies slightly with machine speed) | **all flagged, 0 misses** |
| **No change for ordinary globs:** 3,023,400 generated glob/option pairs without extglob syntax | | **byte-identical** |
| **Real-world globs:** 405 glob/option pairs (Tailwind, ESLint, tsconfig, Jest) | | identical except 1 (see below) |
| **picomatch's own test suite** | | only the patterns in the table above change |

- **The one real-world difference** is Jest's default
  `**/?(*.)+(spec|test).[jt]s?(x)` under the unusual `noextglob` option. That
  combination is itself a ReDoS on the official copy: 60 repeats of `a.` take
  minutes.
- **Independent cross-check:** [recheck](https://makenowjust-labs.github.io/recheck/)
  4.6.2, a separate ReDoS checker, was run on all 147,731 distinct regexes the
  guard produces for both fuzz corpora under 5 option sets. It calls 105
  exponential, and **none of them hangs V8**, with recheck's own attack strings
  or with 315 other hostile inputs each.
  - 104 contain `(|)?`, an optional empty group. JavaScript rejects its empty
    iteration, but recheck's model doesn't apply that rule.
  - 1 is a quadratic (`x*/**[!a]+y`). recheck's exact automaton checker agrees
    it's polynomial, and the official copy produces the same regex.
- **Downstream:** on a real Next.js application, the Tailwind 3 build gave
  byte-identical CSS, and an ESLint flat-config run gave identical results
  (911 files, 5,221 messages).
- **Cost:** about 2.8 µs extra per pattern compile. With `nocase`, the first
  pattern with a repeated group builds the case-folding tables once (about
  75 ms). Each new such pattern after that takes about 0.3 to 1 ms.

### Reproduce

```sh
git clone https://github.com/odapplications/picomatch-redos-guard && cd picomatch-redos-guard
node verify/prepare.mjs   # downloads official 4.0.7 and 2.3.2 from npm, checks their integrity, builds patched copies
node verify/run-all.mjs   # differential, both fuzzers, soundness audit, backreference fuzz (a few minutes)
node verify/run-all.mjs --official   # also fuzz the official copies, to count how many patterns hang them (slow)

npm install --no-save recheck@4.6.2
node verify/recheck.js --limit 2000   # the full recheck run (no --limit) takes hours
```

## Limits

- **Exponential only.** Polynomial slowdowns, for example a quadratic
  `[^/]*?...+` pair, grow with input length but don't explode. Many ordinary
  globs such as `*.*` are technically polynomial, and blocking that class would
  break normal matching.
- **Copies bundled inside other packages are not patched**, because they
  aren't separate picomatch folders. Examples:
  - Next.js ships its own picomatch in `next/dist/compiled/picomatch` (used for
    `images.remotePatterns`);
  - `@vercel/nft` and Prettier bundle one too.

  Those are only reachable with patterns from your own config, so keep that
  config plain.
- **Versions:** only 4.0.7 and 2.3.2. Older ones get an upgrade hint, and a
  future release is left alone until this repo adds it. `status` tells you when
  one exists.
- **Not supported:** Yarn Plug'n'Play (no `node_modules`).
- **No formal proof.** The analyzer is checked by the evidence above, not
  formally proven. If you find a glob that still hangs a guarded copy, please
  open an issue with the pattern, options and input.

## Other ways to use it

### Copy the files into your repo

No dependency and no `git` needed at install time:

1. Copy `bin/` and `patches/` into your repo, for example as
   `vendor/picomatch-guard/`.
2. Use `"postinstall": "node vendor/picomatch-guard/bin/picomatch-guard.mjs apply || exit 0"`.
3. Add the same command as `prebuild`, because a Docker build that copies only
   `package.json` before `npm ci` has no `vendor/` folder yet when
   `postinstall` runs.

### One-off, without adding anything

```sh
npx --yes picomatch-redos-guard apply
```

This lasts until the next `npm install` replaces the files.

### Your own picomatch fork

[`upstream/0001-refuse-exponentially-backtracking-regexes.patch`](upstream/0001-refuse-exponentially-backtracking-regexes.patch)
is the same change as a `git am` patch against picomatch master, with 152 new
tests (`test/redos.js`) and the updated existing tests. With it, picomatch's
full suite passes (2,153 tests) and lint is clean. It was submitted as
micromatch/picomatch#275, which was closed when the advisory was withdrawn.

## Commands

| Command | What it does |
|---|---|
| `picomatch-guard apply` | Patch every installed picomatch 4.0.7 / 2.3.2 (for `postinstall`) |
| `picomatch-guard status` | List each copy (patched / official / modified / unsupported) and check npm for newer picomatch releases |
| `picomatch-guard selftest` | Run 24 attacks against every copy and compare 189 ordinary glob/option pairs with the official file |
| `picomatch-guard restore` | Put the official `lib/parse.js` back, hash-checked |

- `--root <dir>` picks the project folder. The default is the folder npm was
  run from.
- `--quiet` prints only changes and warnings.
- `PICOMATCH_GUARD_OFFLINE=1` skips the registry check in `status`. That check
  is its only network request, and it sends nothing about your project.

## History

- **2026-11-17: first revision.** Written while the advisory was live.
- **2026-11-18: second revision.** Cross-checking with recheck, then an audit
  of every simplification in the analyzer, found that the first revision
  missed some shapes:
  - negated escape classes (`+([^\W]|a)`);
  - empty branches (`+(aa@(|))`);
  - case folding over large ranges, and some `u`-flag syntax;
  - under `nocase`, mixed classes like `[!\Wb]`.

  A fuzz of those shapes hung 1,076 patterns on the first revision and 0 on
  this one. Every finding is now part of the tests and the self-test.
- **2026-11-18:** the advisory was withdrawn, and the upstream PR was closed.
  This repo was published so anyone who wants the protection can have it.
- **1.0.2:** the first release published by the release workflow (npm trusted
  publishing, with provenance). No code changes since 1.0.0.

This project was built with AI assistance ([Claude Code](https://claude.com/claude-code)).
Every claim above is backed by a script in [`verify/`](verify/) that you can
run yourself.

## Contributing and releases

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), and report
security problems privately as described in [SECURITY.md](SECURITY.md).

- **`main` only changes through pull requests that pass CI.** CI runs:
  - tests on Linux, Windows and macOS, with Node 18 to 24;
  - every script in `verify/`;
  - picomatch's own suite with the upstream patch applied.
- **Releases are automatic.** A merged pull request that bumps the version in
  `package.json` is tested again, then published to npm by GitHub Actions
  through npm trusted publishing:
  - no npm token is stored anywhere;
  - every version carries a provenance statement linking it to the exact commit
    that built it;
  - the same tarball is attached to the matching GitHub Release.

## License

MIT. The files under `patches/` are picomatch's `lib/parse.js`, official and
patched, © Jon Schlinkert, under picomatch's MIT license. See [LICENSE](LICENSE).
