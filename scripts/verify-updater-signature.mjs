#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { verifyUpdaterSignature } from './updater-signature.mjs';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`expected --name value arguments, found ${flag ?? 'nothing'}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.file || !options.signature || !options['public-key']) {
    throw new Error(
      'usage: verify-updater-signature.mjs --file artifact --signature artifact.sig --public-key updater.pub',
    );
  }
  verifyUpdaterSignature({
    artifact: fs.readFileSync(options.file),
    signatureValue: fs.readFileSync(options.signature, 'utf8'),
    publicKeyValue: fs.readFileSync(options['public-key'], 'utf8'),
    expectedFileName: path.basename(options.file),
  });
  console.log(`Updater signature verified: ${path.basename(options.file)}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
