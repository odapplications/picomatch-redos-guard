# Contributing

Thanks for helping. This package rewrites a file inside other people's
`node_modules`, so the bar is: every change is tested, every claim is
reproducible, and the guard never blocks less than it did before.

## Setup

Node 18 or later. There are no dependencies to install.

```sh
node verify/prepare.mjs        # downloads official picomatch 4.0.7 / 2.3.2 from npm, checks integrity
node --test test/cli.test.mjs  # CLI and analyzer tests (about 30 s; one test waits out a real hang)
node verify/run-all.mjs        # fuzzers, differential, soundness audit, backreference fuzz (a few minutes)
```

`npm test` runs the first two.

## How changes get in

1. Open a pull request against `main`. Direct pushes to `main` are blocked for
   everyone.
2. CI must pass. It runs:
   - the tests on Linux, Windows and macOS with Node 18, 20, 22 and 24;
   - all of `verify/`;
   - picomatch's own suite with `upstream/` applied.

   The required check is **CI passed**.
3. A maintainer reviews and merges.

## Rules for the analyzer (`lib/ambiguity.js`)

- **It may block too much, never too little.** Every simplification must
  report *more* ambiguity than the regex really has. A pull request that makes
  it block less needs a proof, plus tests showing that the newly allowed shapes
  don't hang V8.
- **Fixing a miss?** Add the regex to `verify/soundness.js` or to the lists in
  `test/cli.test.mjs` first, and show that it fails before your fix.
- **Keep the copies in sync.** The analyzer code exists in three places:
  - `lib/ambiguity.js`;
  - inside `patches/<version>/parse.js`;
  - in `upstream/`.

  Change all three, and regenerate the manifest hashes (see below).

## Supporting a new picomatch version

1. Download the version with `npm pack picomatch@<version>`, and record the
   tarball's `integrity`.
2. Put its untouched `lib/parse.js` in `patches/official/<version>/`.
3. Build the patched file by adding the analyzer and the final check, exactly
   as in the existing versions. Only add lines; never edit or remove upstream
   ones.
4. Add the version to `patches/manifest.json`, with the sha256 of both files
   and the tarball integrity.
5. Add the version to `verify/prepare.mjs` and `verify/run-all.mjs`, and run
   everything.
6. If picomatch has itself fixed the exponential backtracking in that version,
   don't add it. Say so in the README instead.

## Releasing

Bump `version` in `package.json` in your pull request, following semver
(patch-file or analyzer fixes are a patch or minor release). Once the PR is
merged, the release workflow:

1. runs CI again;
2. publishes to npm through trusted publishing, with provenance;
3. creates the `v<version>` tag and a GitHub Release with the same tarball.

Nobody publishes by hand.

## AI-assisted contributions

They're welcome, under the same rules: every claim in the PR must be backed by
a test or a `verify/` script that CI runs.
