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
      throw new Error(`expected --name value arguments, found ${flag ?? 'nothing'}`);
    }
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function requireOptions(options, names, command) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length > 0) {
    throw new Error(`${command} requires ${missing.map((name) => `--${name}`).join(', ')}`);
  }
}

function assertRestricted(filePath, label) {
  if (process.platform === 'win32') return;
  const permissions = fs.statSync(filePath).mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    throw new Error(`${label} must not be readable or writable by group/others: ${filePath}`);
  }
}

function readSecret(filePath, label) {
  assertRestricted(filePath, label);
  const value = fs.readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
  if (value.length === 0) throw new Error(`${label} is empty`);
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
  assertRestricted(options['private-key'], 'updater private key');
  const privateKey = fs.readFileSync(options['private-key'], 'utf8');
  const publicKey = fs.readFileSync(options['public-key'], 'utf8').replace(/\r?\n$/, '');
  const signingPassword = readSecret(
    options['signing-password-file'],
    'updater signing password',
  );
  const recoveryPassphrase = readSecret(
    options['recovery-passphrase-file'],
    'recovery passphrase',
  );
  if (privateKey.length === 0 || publicKey.length === 0) {
    throw new Error('updater key material is empty');
  }
  if (recoveryPassphrase.length < 32) {
    throw new Error('recovery passphrase must contain at least 32 characters');
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

  fs.writeFileSync(options.output, `${JSON.stringify(envelope, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(options.output, 0o600);
  console.log(`Encrypted updater recovery bundle created: ${options.output}`);
}

function decryptBackup(options) {
  const recoveryPassphrase = readSecret(
    options['recovery-passphrase-file'],
    'recovery passphrase',
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
    throw new Error('unsupported or malformed updater recovery bundle');
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
    throw new Error('unsupported or malformed updater recovery bundle');
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
      throw new Error('invalid payload');
    }
    return payload;
  } catch {
    throw new Error('unable to decrypt or authenticate updater recovery bundle');
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
    throw new Error(`restore output directory already exists: ${outputDirectory}`);
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
      throw new Error(`restore output directory already exists: ${outputDirectory}`);
    }
    fs.renameSync(stagingDirectory, outputDirectory);
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  console.log(`Updater recovery material restored: ${options['output-directory']}`);
}

function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'create') return createBackup(options);
  if (command === 'restore') return restoreBackup(options);
  throw new Error(
    'usage: updater-key-recovery.mjs <create|restore> --name value ...',
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
