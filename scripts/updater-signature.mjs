import crypto from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeCanonicalBase64(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

function decodeEnvelope(value, label, expectedLines) {
  const normalized = typeof value === 'string' ? value.trim() : value;
  const envelope = decodeCanonicalBase64(normalized, label);
  const text = envelope.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(envelope) || !text.endsWith('\n')) {
    throw new Error(`${label} has a malformed Minisign envelope`);
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== expectedLines) {
    throw new Error(`${label} has a malformed Minisign envelope`);
  }
  return lines;
}

function decodePublicKey(value) {
  const lines = decodeEnvelope(value, 'updater public key', 2);
  const comment = /^untrusted comment: minisign public key: ([0-9A-F]{16})$/.exec(
    lines[0],
  );
  const bytes = decodeCanonicalBase64(lines[1], 'updater public key payload');
  if (bytes.length !== 42 || bytes[0] !== 0x45 || ![0x44, 0x64].includes(bytes[1])) {
    throw new Error('updater public key has an unsupported algorithm or length');
  }
  const keyId = bytes.subarray(2, 10);
  const displayedKeyId = Buffer.from(keyId).reverse().toString('hex').toUpperCase();
  if (comment?.[1] !== displayedKeyId) {
    throw new Error('updater public key ID does not match its payload');
  }
  return { keyId, key: bytes.subarray(10) };
}

function decodeSignature(value, expectedFileName) {
  const lines = decodeEnvelope(value, 'updater signature', 4);
  if (lines[0] !== 'untrusted comment: signature from tauri secret key') {
    throw new Error('updater signature has an unexpected untrusted comment');
  }
  const signaturePayload = decodeCanonicalBase64(
    lines[1],
    'updater signature payload',
  );
  const globalSignature = decodeCanonicalBase64(
    lines[3],
    'updater global signature',
  );
  if (
    signaturePayload.length !== 74 ||
    signaturePayload[0] !== 0x45 ||
    signaturePayload[1] !== 0x44 ||
    globalSignature.length !== 64
  ) {
    throw new Error('updater signature has an unsupported algorithm or length');
  }
  const trustedComment = new RegExp(
    `^trusted comment: timestamp:\\d+\\tfile:${escapeRegExp(expectedFileName)}$`,
  );
  if (!trustedComment.test(lines[2])) {
    throw new Error(`updater signature does not identify ${expectedFileName}`);
  }
  return {
    keyId: signaturePayload.subarray(2, 10),
    signature: signaturePayload.subarray(10),
    trustedComment: lines[2].slice('trusted comment: '.length),
    globalSignature,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function verifyEd25519(data, rawPublicKey, signature) {
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, data, publicKey, signature);
}

export function verifyUpdaterSignature({
  artifact,
  signatureValue,
  publicKeyValue,
  expectedFileName,
}) {
  const publicKey = decodePublicKey(publicKeyValue);
  const signature = decodeSignature(signatureValue, expectedFileName);
  if (!publicKey.keyId.equals(signature.keyId)) {
    throw new Error('updater signature key ID does not match the configured public key');
  }

  const digest = crypto.createHash('blake2b512').update(artifact).digest();
  if (!verifyEd25519(digest, publicKey.key, signature.signature)) {
    throw new Error('updater artifact signature verification failed');
  }
  const globalPayload = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, 'utf8'),
  ]);
  if (!verifyEd25519(globalPayload, publicKey.key, signature.globalSignature)) {
    throw new Error('updater trusted-comment signature verification failed');
  }
}
