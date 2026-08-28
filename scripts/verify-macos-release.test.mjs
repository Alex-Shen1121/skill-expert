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
const verifier = path.join(repositoryRoot, 'scripts/verify-macos-release.mjs');
const version = '1.2.3';

function createAssets(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-macos-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets');
  const imageSource = path.join(root, 'image-source');
  const app = path.join(imageSource, 'Agent 技能管家.app');
  const contents = path.join(app, 'Contents');
  const executable = path.join(contents, 'MacOS', 'skill-expert');
  const cli = path.join(root, 'skill-expert-cli');
  const cliSource = path.join(root, 'skill-expert-cli.c');
  const archive = path.join(root, 'Agent 技能管家.app.tar.gz');
  const dmg = path.join(root, 'Agent 技能管家.dmg');

  mkdirSync(path.dirname(executable), { recursive: true });
  mkdirSync(assets);
  copyFileSync('/usr/bin/true', executable);
  chmodSync(executable, 0o755);
  writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>skill-expert</string>
  <key>CFBundleIdentifier</key><string>com.codingshen.skill-expert.fixture</string>
  <key>CFBundleName</key><string>Agent 技能管家</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`,
  );
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]);
  writeFileSync(
    cliSource,
    `#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("skill-expert-cli ${version}");
    return 0;
  }
  return 2;
}
`,
  );
  execFileSync('clang', [cliSource, '-o', cli]);
  execFileSync('codesign', ['--force', '--sign', '-', cli]);
  execFileSync('tar', ['-czf', archive, '-C', imageSource, path.basename(app)]);
  execFileSync('hdiutil', [
    'create',
    '-quiet',
    '-fs',
    'HFS+',
    '-volname',
    'Agent 技能管家测试',
    '-srcfolder',
    imageSource,
    dmg,
  ]);

  for (const target of ['macos-arm64', 'macos-x64']) {
    copyFileSync(archive, path.join(assets, `skill-expert-v${version}-${target}.app.tar.gz`));
    copyFileSync(dmg, path.join(assets, `skill-expert-v${version}-${target}.dmg`));
    copyFileSync(cli, path.join(assets, `skill-expert-cli-v${version}-${target}`));
  }
  return assets;
}

test(
  '从下载的两个 macOS 正式包回验 archive、DMG 与 CLI 的 ad-hoc 签名和版本',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const directory = createAssets(t);
    const result = spawnSync(
      process.execPath,
      [verifier, '--version', version, '--directory', directory],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /macos-arm64.*Updater archive.*验证通过/s);
    assert.match(result.stdout, /macos-arm64.*DMG.*验证通过/s);
    assert.match(result.stdout, /macos-x64.*CLI.*验证通过/s);
    assert.doesNotMatch(result.stdout + result.stderr, /spctl|notari[sz]/i);
  },
);

test(
  '下载后的 CLI 实际版本错误时拒绝公开',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const directory = createAssets(t);
    const cli = path.join(directory, `skill-expert-cli-v${version}-macos-x64`);
    const source = path.join(path.dirname(directory), 'wrong-version.c');
    writeFileSync(
      source,
      '#include <stdio.h>\nint main(void) { puts("skill-expert-cli 9.9.9"); return 0; }\n',
    );
    execFileSync('clang', [source, '-o', cli]);
    execFileSync('codesign', ['--force', '--sign', '-', cli]);
    const result = spawnSync(
      process.execPath,
      [verifier, '--version', version, '--directory', directory],
      { encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLI 版本不匹配/);
  },
);

test(
  '下载后的 CLI 签名被移除时拒绝公开',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const directory = createAssets(t);
    const cli = path.join(directory, `skill-expert-cli-v${version}-macos-x64`);
    execFileSync('codesign', ['--remove-signature', cli]);
    const result = spawnSync(
      process.execPath,
      [verifier, '--version', version, '--directory', directory],
      { encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /macos-x64 CLI.*签名验证失败/);
  },
);
