#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRealRoot = fs.realpathSync(repositoryRoot);
const configPath = path.join(repositoryRoot, 'src-tauri/tauri.conf.json');
const backupFilename = 'skill-expert-updater-recovery.json';
const repository = 'Alex-Shen1121/skill-expert';
const unprovisionedPublicKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEEzQzAwMTQ3Nzc3ODNEODUKUldTRlBYaDNSd0hBbzFGYzFkaXZqOFgvTTZIdTNkQjU1S3l2NmpNdXQ3TVNWdmNnckhwUEJiRUcK';

function parseArguments(argv) {
  const options = { plan: false, execute: false, interactive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--plan' || flag === '--execute' || flag === '--interactive') {
      options[flag.slice(2)] = true;
      continue;
    }
    if (
      flag === '--backup-directory' ||
      flag === '--recovery-passphrase-file' ||
      flag === '--confirm-product'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} 需要一个值`);
      }
      options[flag.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${flag}`);
  }
  return options;
}

function assertRestricted(filePath, label) {
  if (process.platform === 'win32') return;
  const permissions = fs.statSync(filePath).mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    throw new Error(`${label}不能允许组用户或其他用户访问：${filePath}`);
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function validateInputs(options) {
  if (options.plan === options.execute) {
    throw new Error('--plan 和 --execute 必须且只能选择一个');
  }
  const missing = ['backup-directory', 'recovery-passphrase-file'].filter(
    (name) => !options[name],
  );
  if (missing.length > 0) {
    throw new Error(`配置需要 ${missing.map((name) => `--${name}`).join('、')}`);
  }
  if (options.execute && options['confirm-product'] !== 'Skill Expert') {
    throw new Error('--execute 需要 --confirm-product "Skill Expert"');
  }

  const requestedBackupDirectory = path.resolve(options['backup-directory']);
  const requestedPassphraseFile = path.resolve(options['recovery-passphrase-file']);
  if (!fs.statSync(requestedBackupDirectory).isDirectory()) {
    throw new Error(`备份路径不是目录：${requestedBackupDirectory}`);
  }
  if (!fs.statSync(requestedPassphraseFile).isFile()) {
    throw new Error(`恢复口令路径不是文件：${requestedPassphraseFile}`);
  }
  const backupDirectory = fs.realpathSync(requestedBackupDirectory);
  const passphraseFile = fs.realpathSync(requestedPassphraseFile);
  if (
    isInside(repositoryRealRoot, backupDirectory) ||
    isInside(repositoryRealRoot, passphraseFile)
  ) {
    throw new Error('备份和恢复口令路径必须位于仓库之外');
  }
  assertRestricted(backupDirectory, '备份目录');
  assertRestricted(passphraseFile, '恢复口令文件');
  const passphrase = fs.readFileSync(passphraseFile, 'utf8').replace(/\r?\n$/, '');
  if (passphrase.length < 32) {
    throw new Error('恢复口令必须至少包含 32 个字符');
  }
  const backupPath = path.join(backupDirectory, backupFilename);
  const backupExists = fs.existsSync(backupPath);
  if (backupExists) {
    const backupStatus = fs.lstatSync(backupPath);
    if (!backupStatus.isFile() || backupStatus.isSymbolicLink()) {
      throw new Error(`已有恢复备份必须是普通文件：${backupPath}`);
    }
    assertRestricted(backupPath, '已有恢复备份');
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.plugins?.updater?.pubkey !== unprovisionedPublicKey) {
    throw new Error('Skill Expert Updater 信任根已经配置或发生了偏移');
  }
  return { backupDirectory, passphraseFile, backupPath, backupExists };
}

async function collectInteractiveOptions() {
  if (!process.stdin.isTTY) {
    const [backupDirectory = '', passphraseFile = '', confirmation = ''] = fs
      .readFileSync(0, 'utf8')
      .split(/\r?\n/);
    console.log('这会一次性配置 Skill Expert 产品，不是终端用户设置。');
    console.log('加密离线备份目录：');
    console.log('恢复口令文件：');
    const paths = validateInputs({
      plan: true,
      execute: false,
      interactive: true,
      'backup-directory': backupDirectory,
      'recovery-passphrase-file': passphraseFile,
    });
    printPlan(paths);
    console.log('输入 "确认配置 SKILL EXPERT" 执行该计划：');
    if (confirmation !== '确认配置 SKILL EXPERT') {
      console.log('已取消，未进行任何更改。');
      return null;
    }
    return paths;
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('这会一次性配置 Skill Expert 产品，不是终端用户设置。');
    const backupDirectory = await terminal.question('加密离线备份目录：');
    const passphraseFile = await terminal.question('恢复口令文件：');
    const options = {
      plan: true,
      execute: false,
      interactive: true,
      'backup-directory': backupDirectory,
      'recovery-passphrase-file': passphraseFile,
    };
    const paths = validateInputs(options);
    printPlan(paths);
    const confirmation = await terminal.question(
      '输入 "确认配置 SKILL EXPERT" 执行该计划：',
    );
    if (confirmation !== '确认配置 SKILL EXPERT') {
      console.log('已取消，未进行任何更改。');
      return null;
    }
    return paths;
  } finally {
    terminal.close();
  }
}

function printPlan(paths) {
  console.log('Skill Expert Updater 一次性产品配置计划');
  if (paths.backupExists) {
    console.log(`- 从现有加密离线备份继续：${paths.backupPath}`);
  } else {
    console.log(`- 创建加密离线备份：${paths.backupPath}`);
  }
  console.log('- 必要时创建 GitHub release Environment');
  console.log('- 设置 TAURI_SIGNING_PRIVATE_KEY 和 TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  console.log('- 使用签名 canary 验证恢复后的密钥对');
  console.log('- 只替换 src-tauri/tauri.conf.json 中的 Updater 公钥');
}

function runCommand(command, args, options = {}) {
  const { sensitive = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    ...spawnOptions,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (sensitive) {
      throw new Error('包含秘密材料的外部命令失败，相关输出已隐藏；可使用同一备份路径重试');
    }
    const detail = result.stderr?.trim() || result.stdout?.trim() || '没有诊断输出';
    throw new Error(`外部命令失败：${detail}`);
  }
  return result;
}

function writeRestricted(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
}

function writeConfigAtomically(config) {
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o644,
      flag: 'wx',
    });
    fs.renameSync(temporaryPath, configPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function publicKeyIdentifier(publicKey) {
  const decoded = Buffer.from(publicKey, 'base64').toString('utf8');
  const match = /^untrusted comment: minisign public key: ([0-9A-F]{16})$/m.exec(decoded);
  if (!match) throw new Error('生成的 Updater 公钥没有有效的密钥标识');
  return match[1];
}

function provision(paths) {
  const workingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'skill-expert-updater-provision-'),
  );
  if (process.platform !== 'win32') fs.chmodSync(workingDirectory, 0o700);
  const privateKeyPath = path.join(workingDirectory, 'skill-expert-updater.key');
  const publicKeyPath = `${privateKeyPath}.pub`;
  const signingPasswordPath = path.join(workingDirectory, 'signing-password');
  const restoredDirectory = path.join(workingDirectory, 'restored');
  const canaryPath = path.join(workingDirectory, 'recovery-canary.txt');
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

  try {
    if (!paths.backupExists) {
      const generatedSigningPassword = crypto.randomBytes(48).toString('base64url');
      writeRestricted(signingPasswordPath, generatedSigningPassword);
      runCommand(
        npxCommand,
        [
          'tauri',
          'signer',
          'generate',
          '--ci',
          '--password',
          generatedSigningPassword,
          '--write-keys',
          privateKeyPath,
        ],
        { sensitive: true },
      );
      if (process.platform !== 'win32') {
        fs.chmodSync(privateKeyPath, 0o600);
        fs.chmodSync(publicKeyPath, 0o600);
      }

      runCommand(process.execPath, [
        path.join(repositoryRoot, 'scripts/updater-key-recovery.mjs'),
        'create',
        '--private-key',
        privateKeyPath,
        '--public-key',
        publicKeyPath,
        '--signing-password-file',
        signingPasswordPath,
        '--recovery-passphrase-file',
        paths.passphraseFile,
        '--output',
        paths.backupPath,
      ]);
    }
    runCommand(process.execPath, [
      path.join(repositoryRoot, 'scripts/updater-key-recovery.mjs'),
      'restore',
      '--backup',
      paths.backupPath,
      '--recovery-passphrase-file',
      paths.passphraseFile,
      '--output-directory',
      restoredDirectory,
    ]);

    fs.writeFileSync(canaryPath, 'Skill Expert updater recovery canary\n');
    const restoredPrivateKey = path.join(restoredDirectory, 'skill-expert-updater.key');
    const restoredPublicKey = path.join(restoredDirectory, 'skill-expert-updater.key.pub');
    const restoredPassword = path.join(restoredDirectory, 'skill-expert-updater.password');
    runCommand(
      npxCommand,
      ['tauri', 'signer', 'sign', canaryPath],
      {
        sensitive: true,
        env: {
          ...process.env,
          TAURI_SIGNING_PRIVATE_KEY_PATH: restoredPrivateKey,
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: fs.readFileSync(restoredPassword, 'utf8'),
        },
      },
    );
    runCommand(process.execPath, [
      path.join(repositoryRoot, 'scripts/verify-updater-signature.mjs'),
      '--file',
      canaryPath,
      '--signature',
      `${canaryPath}.sig`,
      '--public-key',
      restoredPublicKey,
    ]);

    const privateKey = fs.readFileSync(restoredPrivateKey, 'utf8');
    const publicKey = fs.readFileSync(restoredPublicKey, 'utf8').replace(/\r?\n$/, '');
    const signingPassword = fs.readFileSync(restoredPassword, 'utf8');
    runCommand('gh', [
      'api',
      '--method',
      'PUT',
      `repos/${repository}/environments/release`,
      '--silent',
    ]);
    runCommand(
      'gh',
      ['secret', 'set', 'TAURI_SIGNING_PRIVATE_KEY', '--env', 'release', '--repo', repository],
      { input: privateKey, sensitive: true },
    );
    runCommand(
      'gh',
      [
        'secret',
        'set',
        'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
        '--env',
        'release',
        '--repo',
        repository,
      ],
      { input: signingPassword, sensitive: true },
    );
    const secretList = runCommand('gh', [
      'secret',
      'list',
      '--env',
      'release',
      '--repo',
      repository,
      '--json',
      'name',
    ]);
    const secretNames = new Set(JSON.parse(secretList.stdout).map((secret) => secret.name));
    for (const requiredSecret of [
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    ]) {
      if (!secretNames.has(requiredSecret)) {
        throw new Error(`release Environment 缺少 ${requiredSecret}`);
      }
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.plugins.updater.pubkey = publicKey;
    writeConfigAtomically(config);
    runCommand(process.execPath, [
      path.join(repositoryRoot, 'scripts/check-updater-trust.mjs'),
      '--require-production',
    ]);

    const backupChecksum = crypto
      .createHash('sha256')
      .update(fs.readFileSync(paths.backupPath))
      .digest('hex');
    console.log('已使用恢复后的 Updater 密钥验证恢复 canary。');
    console.log('Skill Expert 生产信任根已配置。');
    console.log(`公钥标识：${publicKeyIdentifier(publicKey)}`);
    console.log(`加密备份：${paths.backupPath}`);
    console.log(`加密备份 SHA-256：${backupChecksum}`);
    console.log(
      'GitHub release Environment Secrets：TAURI_SIGNING_PRIVATE_KEY、TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    );
  } finally {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const options = parseArguments(argumentsList);
  if (argumentsList.length === 0 || options.interactive) {
    if (argumentsList.length > 0 && argumentsList.some((argument) => argument !== '--interactive')) {
      throw new Error('--interactive 不能与其他参数组合使用');
    }
    if (!process.stdin.isTTY && !options.interactive) {
      throw new Error('请在交互终端中运行，或使用 --plan/--execute 明确提供路径');
    }
    const paths = await collectInteractiveOptions();
    if (paths) provision(paths);
    return;
  }
  const paths = validateInputs(options);
  printPlan(paths);
  if (options.plan) {
    console.log('未进行任何更改。');
    return;
  }
  provision(paths);
}

try {
  await main();
} catch (error) {
  console.error(`Updater 配置失败：${error.message}`);
  process.exitCode = 1;
}
