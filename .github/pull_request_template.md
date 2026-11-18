## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `node verify/prepare.mjs && node --test test/cli.test.mjs` passes locally
- [ ] Analyzer changes: `node verify/run-all.mjs` passes, and a test or verify case reproduces what was wrong before the fix
- [ ] Patch file changes: `patches/manifest.json` hashes updated, and the official files still match npm (`verify/prepare.mjs` checks this)
- [ ] No new runtime dependencies, no install scripts in this package
- [ ] Releasing? Bump `version` in `package.json` in this PR; merging publishes it
