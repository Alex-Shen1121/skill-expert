import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provisioner = path.join(repositoryRoot, 'scripts/provision-updater.mjs');
const configPath = path.join(repositoryRoot, 'src-tauri/tauri.conf.json');
const unprovisionedPublicKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEEzQzAwMTQ3Nzc3ODNEODUKUldTRlBYaDNSd0hBbzFGYzFkaXZqOFgvTTZIdTNkQjU1S3l2NmpNdXQ3TVNWdmNnckhwUEJiRUcK';

function createPrivateInputs(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-updater-provision-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupDirectory = path.join(root, 'offline-backup');
  const passphraseFile = path.join(root, 'recovery-passphrase');
  mkdirSync(backupDirectory, { mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  writeFileSync(passphraseFile, 'a'.repeat(48), { mode: 0o600 });
  chmodSync(passphraseFile, 0o600);
  return { backupDirectory, passphraseFile };
}

test('计划模式说明一次性产品配置且不修改仓库', (t) => {
  const { backupDirectory, passphraseFile } = createPrivateInputs(t);
  const configBefore = readFileSync(configPath, 'utf8');

  const result = spawnSync(
    process.execPath,
    [
      provisioner,
      '--plan',
      '--backup-directory',
      backupDirectory,
      '--recovery-passphrase-file',
      passphraseFile,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /一次性产品配置/);
  assert.match(result.stdout, /release Environment/i);
  assert.match(result.stdout, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(result.stdout, /加密离线备份/);
  assert.match(result.stdout, /未进行任何更改/);
  assert.equal(readFileSync(configPath, 'utf8'), configBefore);
});

test('维护者未输入确认短语时交互模式停止且不修改仓库', (t) => {
  const { backupDirectory, passphraseFile } = createPrivateInputs(t);
  const configBefore = readFileSync(configPath, 'utf8');

  const result = spawnSync(process.execPath, [provisioner, '--interactive'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input: `${backupDirectory}\n${passphraseFile}\ncancel\n`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /确认配置 SKILL EXPERT/);
  assert.match(result.stdout, /已取消，未进行任何更改/);
  assert.equal(readFileSync(configPath, 'utf8'), configBefore);
});

test(
  '拒绝通过仓库外符号链接把备份写回仓库',
  { skip: process.platform === 'win32' },
  (t) => {
    const { passphraseFile } = createPrivateInputs(t);
    const insideRepository = mkdtempSync(
      path.join(repositoryRoot, '.updater-provision-inside-'),
    );
    const outsideRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-updater-link-'));
    t.after(() => rmSync(insideRepository, { recursive: true, force: true }));
    t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));
    const linkedBackupDirectory = path.join(outsideRoot, 'offline-backup');
    symlinkSync(insideRepository, linkedBackupDirectory, 'dir');

    const result = spawnSync(
      process.execPath,
      [
        provisioner,
        '--plan',
        '--backup-directory',
        linkedBackupDirectory,
        '--recovery-passphrase-file',
        passphraseFile,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0, '符号链接不能绕过仓库外路径约束');
    assert.match(result.stderr, /必须位于仓库之外/);
  },
);

test('确认执行后配置可恢复密钥且只向 release Environment 发送 Secret', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-updater-execute-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtureRoot = path.join(root, 'repository');
  const scriptsDirectory = path.join(fixtureRoot, 'scripts');
  const fakeBin = path.join(root, 'bin');
  const backupDirectory = path.join(root, 'offline-backup');
  const passphraseFile = path.join(root, 'recovery-passphrase');
  const ghLog = path.join(root, 'gh-calls.log');
  const failureMarker = path.join(root, 'password-secret-failed-once');
  const capturedSecret = path.join(root, 'captured-secret');
  mkdirSync(path.join(fixtureRoot, 'src-tauri'), { recursive: true });
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(fakeBin, { mode: 0o700 });
  mkdirSync(backupDirectory, { mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  writeFileSync(passphraseFile, 'r'.repeat(48), { mode: 0o600 });
  chmodSync(passphraseFile, 0o600);

  for (const filename of [
    'provision-updater.mjs',
    'updater-key-recovery.mjs',
    'updater-signature.mjs',
    'verify-updater-signature.mjs',
    'check-updater-trust.mjs',
  ]) {
    copyFileSync(path.join(repositoryRoot, 'scripts', filename), path.join(scriptsDirectory, filename));
  }
  symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(fixtureRoot, 'node_modules'));
  writeFileSync(
    path.join(fixtureRoot, 'src-tauri/tauri.conf.json'),
    `${JSON.stringify(
      {
        plugins: {
          updater: {
            pubkey: unprovisionedPublicKey,
            endpoints: [
              'https://github.com/Alex-Shen1121/skill-expert/releases/latest/download/latest.json',
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const fakeGh = path.join(fakeBin, 'gh');
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.SKILL_EXPERT_GH_LOG, process.argv.slice(2).join(' ') + '\\n');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8');
if (
  process.argv[2] === 'secret' &&
  process.argv[3] === 'set' &&
  process.argv[4] === 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD' &&
  !fs.existsSync(process.env.SKILL_EXPERT_FAIL_ONCE)
) {
  fs.writeFileSync(process.env.SKILL_EXPERT_FAIL_ONCE, 'failed');
  fs.writeFileSync(process.env.SKILL_EXPERT_CAPTURED_SECRET, input);
  process.stderr.write(input);
  process.exit(1);
}
if (process.argv[2] === 'secret' && process.argv[3] === 'list') {
  process.stdout.write(JSON.stringify([
    { name: 'TAURI_SIGNING_PRIVATE_KEY' },
    { name: 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD' },
  ]));
}
`,
    { mode: 0o700 },
  );
  chmodSync(fakeGh, 0o700);

  const executionArgs = [
    path.join(scriptsDirectory, 'provision-updater.mjs'),
    '--execute',
    '--confirm-product',
    'Skill Expert',
    '--backup-directory',
    backupDirectory,
    '--recovery-passphrase-file',
    passphraseFile,
  ];
  const executionOptions = {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      SKILL_EXPERT_GH_LOG: ghLog,
      SKILL_EXPERT_FAIL_ONCE: failureMarker,
      SKILL_EXPERT_CAPTURED_SECRET: capturedSecret,
    },
  };
  const interrupted = spawnSync(process.execPath, executionArgs, executionOptions);

  assert.notEqual(interrupted.status, 0, '模拟的 Secret 上传中断必须失败');
  assert.equal(
    existsSync(path.join(backupDirectory, 'skill-expert-updater-recovery.json')),
    true,
  );
  const leakedByAdapter = readFileSync(capturedSecret, 'utf8');
  assert.notEqual(leakedByAdapter, '');
  assert.doesNotMatch(
    `${interrupted.stdout}\n${interrupted.stderr}`,
    new RegExp(leakedByAdapter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );

  const result = spawnSync(process.execPath, executionArgs, executionOptions);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /验证恢复 canary/);
  assert.match(result.stdout, /生产信任根已配置/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /r{32}/);
  const configuredKey = JSON.parse(
    readFileSync(path.join(fixtureRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
  ).plugins.updater.pubkey;
  assert.notEqual(configuredKey, unprovisionedPublicKey);
  assert.equal(
    existsSync(path.join(backupDirectory, 'skill-expert-updater-recovery.json')),
    true,
  );
  const ghCalls = readFileSync(ghLog, 'utf8');
  assert.match(ghCalls, /api --method PUT repos\/Alex-Shen1121\/skill-expert\/environments\/release/);
  assert.match(ghCalls, /secret set TAURI_SIGNING_PRIVATE_KEY --env release --repo Alex-Shen1121\/skill-expert/);
  assert.match(ghCalls, /secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release --repo Alex-Shen1121\/skill-expert/);
});
