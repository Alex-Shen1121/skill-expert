import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(repositoryRoot, 'scripts/verify-macos-adhoc.mjs');

function createSignedFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-macos-adhoc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Skill Expert.app');
  const contents = path.join(app, 'Contents');
  const executable = path.join(contents, 'MacOS', 'Skill Expert');
  const cli = path.join(root, 'skill-expert-cli');
  const archive = path.join(root, 'Skill Expert.app.tar.gz');

  mkdirSync(path.dirname(executable), { recursive: true });
  copyFileSync('/usr/bin/true', executable);
  chmodSync(executable, 0o755);
  writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Skill Expert</string>
  <key>CFBundleIdentifier</key><string>com.codingshen.skill-expert.fixture</string>
  <key>CFBundleName</key><string>Skill Expert</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.2.3</string>
</dict></plist>
`,
  );
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]);

  copyFileSync('/usr/bin/true', cli);
  chmodSync(cli, 0o755);
  execFileSync('codesign', ['--force', '--sign', '-', cli]);
  execFileSync('tar', ['-czf', archive, '-C', root, path.basename(app)]);

  return { app, archive, cli, root };
}

test(
  'verifies ad-hoc signatures on the built app, updater archive app, and CLI',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const fixture = createSignedFixture(t);
    const result = spawnSync(
      process.execPath,
      [
        verifier,
        '--app',
        fixture.app,
        '--archive',
        fixture.archive,
        '--cli',
        fixture.cli,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /built app: valid ad-hoc signature/);
    assert.match(result.stdout, /updater archive app: valid ad-hoc signature/);
    assert.match(result.stdout, /CLI: valid ad-hoc signature/);
    assert.doesNotMatch(result.stdout + result.stderr, /spctl|notari[sz]/i);
  },
);

test(
  'rejects a CLI after its ad-hoc signature is removed',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const fixture = createSignedFixture(t);
    execFileSync('codesign', ['--remove-signature', fixture.cli]);
    const result = spawnSync(
      process.execPath,
      [
        verifier,
        '--app',
        fixture.app,
        '--archive',
        fixture.archive,
        '--cli',
        fixture.cli,
      ],
      { encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLI failed strict code-signature verification/);
  },
);
