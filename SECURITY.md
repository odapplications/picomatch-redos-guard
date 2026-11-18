# Security policy

## Reporting a problem

Please report privately through GitHub: on this repository's **Security** tab,
choose **Report a vulnerability**. The report reaches only the maintainers, and
we can work on a fix in a private fork before anything is public.

Especially welcome:

- a glob that still backtracks exponentially on a guarded copy of picomatch
  4.0.7 or 2.3.2: include the pattern, the options and a slow input;
- `picomatch-guard` writing anything other than the files in `patches/`, or
  writing to a file whose hash it did not check;
- anything in the release process (`.github/workflows/release.yml`) that could
  publish code that did not pass CI.

A glob that is slow but not exponential (for example quadratic) is outside the
guard's scope, but feel free to open a normal issue about it.

## Supported versions

Only the latest release on npm gets fixes. A fix ships as a new version
through the release workflow, with npm provenance.

## How releases are protected

- **`main` changes only through pull requests**, and the "CI passed" check must
  succeed: tests on Linux, Windows and macOS with Node 18 to 24, the full
  verification in `verify/`, and picomatch's own test suite with the upstream
  patch applied.
- **Releases are published by GitHub Actions** through npm trusted publishing:
  - no npm token exists in the repository or in CI;
  - every version carries a provenance statement linking it to the exact
    commit and workflow run.
- **The published tarball is attached to the matching GitHub Release**, so
  anyone can compare the two.
- **Workflow actions are pinned to commit hashes**, and Dependabot proposes
  updates as pull requests that must pass CI like any other change.
