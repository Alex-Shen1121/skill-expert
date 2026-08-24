import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recoveryTool = path.join(repositoryRoot, 'scripts/updater-key-recovery.mjs');

function writeRestricted(filePath, contents) {
  writeFileSync(filePath, contents, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

test('creates an encrypted restricted backup and restores every updater credential', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-updater-recovery-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const privateKeyPath = path.join(fixtureRoot, 'updater.key');
  const publicKeyPath = path.join(fixtureRoot, 'updater.key.pub');
  const signingPasswordPath = path.join(fixtureRoot, 'signing-password');
  const recoveryPassphrasePath = path.join(fixtureRoot, 'recovery-passphrase');
  const backupPath = path.join(fixtureRoot, 'skill-expert-updater-recovery.json');
  const restoreDirectory = path.join(fixtureRoot, 'restored');
  const privateKey = 'fixture-private-key-material';
  const publicKey = 'fixture-public-key-material';
  const signingPassword = 'fixture-signing-password';

  writeRestricted(privateKeyPath, privateKey);
  writeRestricted(publicKeyPath, publicKey);
  writeRestricted(signingPasswordPath, `${signingPassword}\n`);
  writeRestricted(recoveryPassphrasePath, 'fixture-recovery-passphrase-at-least-32-characters\n');

  const create = spawnSync(
    process.execPath,
    [
      recoveryTool,
      'create',
      '--private-key',
      privateKeyPath,
      '--public-key',
      publicKeyPath,
      '--signing-password-file',
      signingPasswordPath,
      '--recovery-passphrase-file',
      recoveryPassphrasePath,
      '--output',
      backupPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(create.status, 0, create.stderr);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  const encryptedBackup = readFileSync(backupPath, 'utf8');
  assert.doesNotMatch(encryptedBackup, new RegExp(privateKey));
  assert.doesNotMatch(encryptedBackup, new RegExp(signingPassword));

  const restore = spawnSync(
    process.execPath,
    [
      recoveryTool,
      'restore',
      '--backup',
      backupPath,
      '--recovery-passphrase-file',
      recoveryPassphrasePath,
      '--output-directory',
      restoreDirectory,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(statSync(restoreDirectory).mode & 0o777, 0o700);

  const restoredPrivateKey = path.join(restoreDirectory, 'skill-expert-updater.key');
  const restoredPublicKey = path.join(restoreDirectory, 'skill-expert-updater.key.pub');
  const restoredPassword = path.join(restoreDirectory, 'skill-expert-updater.password');
  assert.equal(readFileSync(restoredPrivateKey, 'utf8'), privateKey);
  assert.equal(readFileSync(restoredPublicKey, 'utf8'), publicKey);
  assert.equal(readFileSync(restoredPassword, 'utf8'), signingPassword);
  for (const restoredPath of [restoredPrivateKey, restoredPublicKey, restoredPassword]) {
    assert.equal(statSync(restoredPath).mode & 0o777, 0o600);
  }
});

test('rejects a wrong recovery passphrase without creating restored files', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-updater-recovery-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const privateKeyPath = path.join(fixtureRoot, 'updater.key');
  const publicKeyPath = path.join(fixtureRoot, 'updater.key.pub');
  const signingPasswordPath = path.join(fixtureRoot, 'signing-password');
  const recoveryPassphrasePath = path.join(fixtureRoot, 'recovery-passphrase');
  const wrongPassphrasePath = path.join(fixtureRoot, 'wrong-recovery-passphrase');
  const backupPath = path.join(fixtureRoot, 'skill-expert-updater-recovery.json');
  const restoreDirectory = path.join(fixtureRoot, 'restored');

  writeRestricted(privateKeyPath, 'fixture-private-key-material');
  writeRestricted(publicKeyPath, 'fixture-public-key-material');
  writeRestricted(signingPasswordPath, 'fixture-signing-password\n');
  writeRestricted(recoveryPassphrasePath, 'correct-recovery-passphrase-at-least-32-characters\n');
  writeRestricted(wrongPassphrasePath, 'incorrect-recovery-passphrase-at-least-32-characters\n');

  const create = spawnSync(
    process.execPath,
    [
      recoveryTool,
      'create',
      '--private-key',
      privateKeyPath,
      '--public-key',
      publicKeyPath,
      '--signing-password-file',
      signingPasswordPath,
      '--recovery-passphrase-file',
      recoveryPassphrasePath,
      '--output',
      backupPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(create.status, 0, create.stderr);

  const restore = spawnSync(
    process.execPath,
    [
      recoveryTool,
      'restore',
      '--backup',
      backupPath,
      '--recovery-passphrase-file',
      wrongPassphrasePath,
      '--output-directory',
      restoreDirectory,
    ],
    { encoding: 'utf8' },
  );

  assert.notEqual(restore.status, 0, 'a wrong passphrase must fail authentication');
  assert.match(restore.stderr, /unable to decrypt or authenticate/);
  assert.throws(() => statSync(restoreDirectory), /ENOENT/);
});

test('rejects a truncated AES-GCM authentication tag', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-updater-recovery-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const privateKeyPath = path.join(fixtureRoot, 'updater.key');
  const publicKeyPath = path.join(fixtureRoot, 'updater.key.pub');
  const signingPasswordPath = path.join(fixtureRoot, 'signing-password');
  const recoveryPassphrasePath = path.join(fixtureRoot, 'recovery-passphrase');
  const backupPath = path.join(fixtureRoot, 'skill-expert-updater-recovery.json');
  const truncatedBackupPath = path.join(fixtureRoot, 'truncated-recovery.json');
  const restoreDirectory = path.join(fixtureRoot, 'restored');

  writeRestricted(privateKeyPath, 'fixture-private-key-material');
  writeRestricted(publicKeyPath, 'fixture-public-key-material');
  writeRestricted(signingPasswordPath, 'fixture-signing-password\n');
  writeRestricted(recoveryPassphrasePath, 'correct-recovery-passphrase-at-least-32-characters\n');

  const create = spawnSync(
    process.execPath,
    [
      recoveryTool,
      'create',
      '--private-key',
      privateKeyPath,
      '--public-key',
      publicKeyPath,
      '--signing-password-file',
      signingPasswordPath,
      '--recovery-passphrase-file',
      recoveryPassphrasePath,
      '--output',
      backupPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(create.status, 0, create.stderr);

  const envelope = JSON.parse(readFileSync(backupPath, 'utf8'));
  envelope.cipher.authTag = Buffer.from(envelope.cipher.authTag, 'base64')
    .subarray(0, 4)
    .toString('base64');
  writeRestricted(truncatedBackupPath, `${JSON.stringify(envelope, null, 2)}\n`);

  const restore = spawnSync(
    process.execPath,
    [
      recoveryTool,
      'restore',
      '--backup',
      truncatedBackupPath,
      '--recovery-passphrase-file',
      recoveryPassphrasePath,
      '--output-directory',
      restoreDirectory,
    ],
    { encoding: 'utf8' },
  );

  assert.notEqual(restore.status, 0, 'a truncated GCM tag must fail');
  assert.match(restore.stderr, /unsupported or malformed|unable to decrypt or authenticate/);
  assert.throws(() => statSync(restoreDirectory), /ENOENT/);
});
