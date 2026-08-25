#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FORMAT = 'skill-expert-updater-recovery/v1';
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`应使用 --name value 参数，实际为 ${flag ?? '空值'}`);
    }
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function requireOptions(options, names, command) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length > 0) {
    throw new Error(`${command} 需要 ${missing.map((name) => `--${name}`).join('、')}`);
  }
}

function assertRestricted(filePath, label) {
  if (process.platform === 'win32') return;
  const permissions = fs.statSync(filePath).mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    throw new Error(`${label}不能允许组用户或其他用户读写：${filePath}`);
  }
}

function readSecret(filePath, label) {
  assertRestricted(filePath, label);
  const value = fs.readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
  if (value.length === 0) throw new Error(`${label}为空`);
  return value;
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT_OPTIONS);
}

function decodeCanonicalBase64(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function publishBackupNoReplace(temporaryPath, outputPath) {
  try {
    fs.linkSync(temporaryPath, outputPath);
    fs.unlinkSync(temporaryPath);
    return;
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`恢复备份已存在：${outputPath}`);
    }
    const lockFallbackCodes = new Set([
      'EINVAL',
      'ENOTSUP',
      'EOPNOTSUPP',
      'EPERM',
      'EXDEV',
    ]);
    if (!lockFallbackCodes.has(error.code)) throw error;
  }

  const publicationLock = `${outputPath}.publish-lock`;
  try {
    fs.mkdirSync(publicationLock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`恢复备份正在发布：${outputPath}`);
    }
    throw error;
  }
  try {
    if (fs.existsSync(outputPath)) {
      throw new Error(`恢复备份已存在：${outputPath}`);
    }
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmdirSync(publicationLock);
  }
}

function writeBackupAtomically(outputPath, contents) {
  if (fs.existsSync(outputPath)) {
    throw new Error(`恢复备份已存在：${outputPath}`);
  }
  const parentDirectory = path.dirname(outputPath);
  const temporaryPath = path.join(
    parentDirectory,
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporaryPath, 0o600);
    publishBackupNoReplace(temporaryPath, outputPath);
    if (process.platform !== 'win32') {
      const directoryDescriptor = fs.openSync(parentDirectory, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

function createBackup(options) {
  requireOptions(
    options,
    [
      'private-key',
      'public-key',
      'signing-password-file',
      'recovery-passphrase-file',
      'output',
    ],
    'create',
  );
  assertRestricted(options['private-key'], 'Updater 私钥');
  const privateKey = fs.readFileSync(options['private-key'], 'utf8');
  const publicKey = fs.readFileSync(options['public-key'], 'utf8').replace(/\r?\n$/, '');
  const signingPassword = readSecret(
    options['signing-password-file'],
    'Updater 签名密码',
  );
  const recoveryPassphrase = readSecret(
    options['recovery-passphrase-file'],
    '恢复口令',
  );
  if (privateKey.length === 0 || publicKey.length === 0) {
    throw new Error('Updater 密钥材料为空');
  }
  if (recoveryPassphrase.length < 32) {
    throw new Error('恢复口令必须至少包含 32 个字符');
  }

  const payload = Buffer.from(
    JSON.stringify({
      format: FORMAT,
      product: 'Skill Expert',
      privateKey,
      publicKey,
      signingPassword,
    }),
  );
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    deriveKey(recoveryPassphrase, salt),
    iv,
    { authTagLength: 16 },
  );
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const envelope = {
    format: FORMAT,
    kdf: {
      name: 'scrypt',
      salt: salt.toString('base64'),
      N: SCRYPT_OPTIONS.N,
      r: SCRYPT_OPTIONS.r,
      p: SCRYPT_OPTIONS.p,
    },
    cipher: {
      name: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    },
    ciphertext: ciphertext.toString('base64'),
  };

  writeBackupAtomically(options.output, `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(`已创建加密 Updater 恢复包：${options.output}`);
}

function decryptBackup(options) {
  const recoveryPassphrase = readSecret(
    options['recovery-passphrase-file'],
    '恢复口令',
  );
  const envelope = JSON.parse(fs.readFileSync(options.backup, 'utf8'));
  if (
    envelope.format !== FORMAT ||
    envelope.kdf?.name !== 'scrypt' ||
    envelope.cipher?.name !== 'aes-256-gcm' ||
    envelope.kdf.N !== SCRYPT_OPTIONS.N ||
    envelope.kdf.r !== SCRYPT_OPTIONS.r ||
    envelope.kdf.p !== SCRYPT_OPTIONS.p
  ) {
    throw new Error('Updater 恢复包不受支持或格式错误');
  }

  const salt = decodeCanonicalBase64(envelope.kdf.salt);
  const iv = decodeCanonicalBase64(envelope.cipher.iv);
  const authTag = decodeCanonicalBase64(envelope.cipher.authTag);
  const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
  if (
    salt?.length !== 16 ||
    iv?.length !== 12 ||
    authTag?.length !== 16 ||
    !ciphertext ||
    ciphertext.length === 0
  ) {
    throw new Error('Updater 恢复包不受支持或格式错误');
  }

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveKey(recoveryPassphrase, salt),
      iv,
      { authTagLength: 16 },
    );
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (
      payload.format !== FORMAT ||
      payload.product !== 'Skill Expert' ||
      typeof payload.privateKey !== 'string' ||
      typeof payload.publicKey !== 'string' ||
      typeof payload.signingPassword !== 'string'
    ) {
      throw new Error('载荷无效');
    }
    return payload;
  } catch {
    throw new Error('无法解密或认证 Updater 恢复包');
  }
}

function writeRestricted(filePath, contents) {
  fs.writeFileSync(filePath, contents, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function restoreBackup(options) {
  requireOptions(
    options,
    ['backup', 'recovery-passphrase-file', 'output-directory'],
    'restore',
  );
  const payload = decryptBackup(options);
  const outputDirectory = options['output-directory'];
  if (fs.existsSync(outputDirectory)) {
    throw new Error(`恢复输出目录已存在：${outputDirectory}`);
  }
  const parentDirectory = path.dirname(outputDirectory);
  const stagingDirectory = fs.mkdtempSync(
    path.join(parentDirectory, `.${path.basename(outputDirectory)}.restore-`),
  );
  try {
    fs.chmodSync(stagingDirectory, 0o700);
    writeRestricted(
      path.join(stagingDirectory, 'skill-expert-updater.key'),
      payload.privateKey,
    );
    writeRestricted(
      path.join(stagingDirectory, 'skill-expert-updater.key.pub'),
      payload.publicKey,
    );
    writeRestricted(
      path.join(stagingDirectory, 'skill-expert-updater.password'),
      payload.signingPassword,
    );
    if (fs.existsSync(outputDirectory)) {
      throw new Error(`恢复输出目录已存在：${outputDirectory}`);
    }
    fs.renameSync(stagingDirectory, outputDirectory);
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  console.log(`已恢复 Updater 材料：${options['output-directory']}`);
}

function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'create') return createBackup(options);
  if (command === 'restore') return restoreBackup(options);
  throw new Error(
    '用法：updater-key-recovery.mjs <create|restore> --name value ...',
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
