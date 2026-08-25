#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  for (const required of ['app', 'archive', 'cli']) {
    if (!options[required]) throw new Error(`missing required --${required} path`);
  }
  return options;
}

function runCodesign(args) {
  return spawnSync('codesign', args, { encoding: 'utf8' });
}

export function verifyAdHocSignature(label, artifactPath) {
  const verification = runCodesign([
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    artifactPath,
  ]);
  if (verification.status !== 0) {
    throw new Error(
      `${label} failed strict code-signature verification: ${verification.stderr.trim()}`,
    );
  }

  const inspection = runCodesign(['-dvvv', artifactPath]);
  const signingDetails = `${inspection.stdout}${inspection.stderr}`;
  if (inspection.status !== 0 || !/^Signature=adhoc$/m.test(signingDetails)) {
    throw new Error(`${label} is not signed with the required ad-hoc identity`);
  }
  if (!/^TeamIdentifier=not set$/m.test(signingDetails)) {
    throw new Error(`${label} unexpectedly carries a signing team identity`);
  }

  console.log(`${label}: valid ad-hoc signature`);
}

export function verifyUpdaterArchive(archivePath) {
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-expert-updater-app-'));
  try {
    const extraction = spawnSync('tar', ['-xzf', archivePath, '-C', extractionRoot], {
      encoding: 'utf8',
    });
    if (extraction.status !== 0) {
      throw new Error(`unable to extract updater archive: ${extraction.stderr.trim()}`);
    }
    const appBundles = fs
      .readdirSync(extractionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    if (appBundles.length !== 1) {
      throw new Error(
        `updater archive must contain exactly one top-level .app, found ${appBundles.length}`,
      );
    }
    verifyAdHocSignature(
      'updater archive app',
      path.join(extractionRoot, appBundles[0].name),
    );
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function main() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS ad-hoc verification requires a macOS runner with codesign');
  }
  const options = parseArguments(process.argv.slice(2));
  verifyAdHocSignature('built app', options.app);
  verifyUpdaterArchive(options.archive);
  verifyAdHocSignature('CLI', options.cli);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
