import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repositoryRoot, 'scripts/download-draft-release-assets.sh');

function createFixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-expert-draft-download-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const binDirectory = path.join(temporaryRoot, 'bin');
  const runnerTemp = path.join(temporaryRoot, 'runner-temp');
  const outputDirectory = path.join(temporaryRoot, 'release-assets');
  fs.mkdirSync(binDirectory);
  fs.mkdirSync(runnerTemp);

  const ghPath = path.join(binDirectory, 'gh');
  fs.writeFileSync(ghPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"releases/assets/123"* ]]; then
  printf '真实字节'
else
  printf '[]'
fi
`);
  fs.chmodSync(ghPath, 0o755);

  const jqPath = path.join(binDirectory, 'jq');
  fs.writeFileSync(jqPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"| length"* ]]; then
  printf '1\\r\\n'
else
  printf '%s\\r\\n' "$ASSET_ROW"
fi
`);
  fs.chmodSync(jqPath, 0o755);

  return {
    outputDirectory,
    temporaryRoot,
    run(assetRow) {
      return spawnSync('bash', [scriptPath, outputDirectory], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ASSET_ROW: assetRow,
          PATH: `${binDirectory}:${process.env.PATH}`,
          GH_TOKEN: 'test-token',
          REPO: 'Alex-Shen1121/skill-expert',
          RUNNER_TEMP: runnerTemp,
          TAG: 'v1.0.2',
        },
      });
    },
  };
}

test('Windows jq 的 CRLF 不会进入下载后的 Draft 资产文件名', (t) => {
  const fixture = createFixture(t);
  const result = fixture.run('123\tskill-expert-cli-v1.0.2-windows-x64.exe');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(fixture.outputDirectory), [
    'skill-expert-cli-v1.0.2-windows-x64.exe',
  ]);
  assert.equal(
    fs.readFileSync(
      path.join(fixture.outputDirectory, 'skill-expert-cli-v1.0.2-windows-x64.exe'),
      'utf8',
    ),
    '真实字节',
  );
});

test('拒绝可能在 Windows runner 上逃出下载目录的反斜杠资产名', (t) => {
  const fixture = createFixture(t);
  const outsidePath = path.join(fixture.temporaryRoot, 'outside.txt');
  fs.writeFileSync(outsidePath, '不得覆盖');

  const result = fixture.run('123\t..\\outside.txt');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Draft 包含不安全资产名/);
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), '不得覆盖');
});
