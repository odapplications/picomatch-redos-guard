// node verify/prepare.mjs
// Downloads the official picomatch 4.0.7 and 2.3.2 tarballs from npm, checks
// them against the integrity in patches/manifest.json, and builds a patched copy
// of each next to it:
//   verify/.work/official-<version>/   untouched package
//   verify/.work/patched-<version>/    same package with patches/<version>/parse.js
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCHES = path.join(HERE, '..', 'patches');
const WORK = path.join(HERE, '.work');
const manifest = JSON.parse(fs.readFileSync(path.join(PATCHES, 'manifest.json'), 'utf8'));
const sha = (algo, buf, enc) => createHash(algo).update(buf).digest(enc);
const npm = argv => execFileSync('npm', argv, { cwd: WORK, encoding: 'utf8', shell: process.platform === 'win32' });

fs.mkdirSync(WORK, { recursive: true });
for (const [version, entry] of Object.entries(manifest.versions)) {
  const [info] = JSON.parse(npm(['pack', `picomatch@${version}`, '--json', '--silent']));
  const tgz = path.join(WORK, info.filename);
  const integrity = `sha512-${sha('sha512', fs.readFileSync(tgz), 'base64')}`;
  if (integrity !== entry.officialTarballIntegrity) throw new Error(`picomatch@${version}: tarball integrity ${integrity} does not match the manifest`);
  for (const kind of ['official', 'patched']) {
    const dir = path.join(WORK, `${kind}-${version}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // Relative paths: GNU tar reads "C:\..." as a remote host.
    execFileSync('tar', ['-xzf', info.filename, '-C', path.basename(dir), '--strip-components=1'], { cwd: WORK });
  }
  const officialParse = path.join(WORK, `official-${version}`, 'lib', 'parse.js');
  if (sha('sha256', fs.readFileSync(officialParse), 'hex') !== entry.officialSha256) throw new Error(`picomatch@${version}: lib/parse.js does not match the manifest`);
  if (sha('sha256', fs.readFileSync(path.join(PATCHES, entry.official)), 'hex') !== entry.officialSha256) throw new Error(`patches/${entry.official} does not match the manifest`);
  fs.copyFileSync(path.join(PATCHES, entry.patched), path.join(WORK, `patched-${version}`, 'lib', 'parse.js'));
  fs.rmSync(tgz);
  console.log(`picomatch@${version}: tarball and lib/parse.js verified; official and patched copies in verify/.work/`);
}
