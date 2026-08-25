#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const targetContracts = {
  'macos-arm64': {
    artifacts: [
      ['bundle/macos', '.app.tar.gz', '.app.tar.gz'],
      ['bundle/macos', '.app.tar.gz.sig', '.app.tar.gz.sig'],
      ['bundle/dmg', '.dmg', '.dmg'],
    ],
    cliSuffix: '',
  },
  'macos-x64': {
    artifacts: [
      ['bundle/macos', '.app.tar.gz', '.app.tar.gz'],
      ['bundle/macos', '.app.tar.gz.sig', '.app.tar.gz.sig'],
      ['bundle/dmg', '.dmg', '.dmg'],
    ],
    cliSuffix: '',
  },
  'windows-x64': {
    artifacts: [
      ['bundle/nsis', '-setup.exe', '-setup.exe'],
      ['bundle/nsis', '-setup.exe.sig', '-setup.exe.sig'],
      ['bundle/msi', '.msi', '.msi'],
      ['bundle/msi', '.msi.sig', '.msi.sig'],
    ],
    cliSuffix: '.exe',
  },
  'linux-x64': {
    artifacts: [
      ['bundle/appimage', '.AppImage', '.AppImage'],
      ['bundle/appimage', '.AppImage.sig', '.AppImage.sig'],
      ['bundle/deb', '.deb', '.deb'],
      ['bundle/rpm', '.rpm', '.rpm'],
    ],
    cliSuffix: '',
  },
};

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

function contractFor(version, target) {
  if (!VERSION_PATTERN.test(version ?? '')) {
    throw new Error(`version must be a stable x.y.z value, found ${version ?? 'missing'}`);
  }
  const contract = targetContracts[target];
  if (!contract) {
    throw new Error(`unsupported candidate target: ${target ?? 'missing'}`);
  }
  return contract;
}

export function expectedCandidateAssets(version, target) {
  const contract = contractFor(version, target);
  const desktopPrefix = `skill-expert-v${version}-${target}`;
  return [
    `skill-expert-cli-v${version}-${target}${contract.cliSuffix}`,
    ...contract.artifacts.map(([, , targetSuffix]) => `${desktopPrefix}${targetSuffix}`),
  ].sort();
}

function findUniqueArtifact(buildRoot, relativeDirectory, suffix) {
  const directory = path.join(buildRoot, relativeDirectory);
  const matches = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.join(directory, entry.name));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${suffix} artifact in ${directory}, found ${matches.length}`,
    );
  }
  return matches[0];
}

export function stageCandidateAssets(buildRoot, directory, version, target) {
  const contract = contractFor(version, target);
  fs.mkdirSync(directory, { recursive: true });
  const existing = fs.readdirSync(directory);
  if (existing.length > 0) {
    throw new Error(`candidate staging directory must be empty: ${directory}`);
  }

  const desktopPrefix = `skill-expert-v${version}-${target}`;
  const copies = contract.artifacts.map(([sourceDirectory, sourceSuffix, targetSuffix]) => [
    findUniqueArtifact(buildRoot, sourceDirectory, sourceSuffix),
    path.join(directory, `${desktopPrefix}${targetSuffix}`),
  ]);
  const cliName = `skill-expert-cli${contract.cliSuffix}`;
  const cliPath = path.join(buildRoot, cliName);
  if (!fs.statSync(cliPath).isFile()) throw new Error(`CLI artifact is not a file: ${cliPath}`);
  copies.push([
    cliPath,
    path.join(directory, `skill-expert-cli-v${version}-${target}${contract.cliSuffix}`),
  ]);

  for (const [source, destination] of copies) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode);
  }
  return verifyCandidateAssets(directory, version, target);
}

export function verifyCandidateAssets(directory, version, target) {
  const expected = expectedCandidateAssets(version, target);
  const actual = fs.readdirSync(directory).sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((filename) => !actualSet.has(filename));
  const unexpected = actual.filter((filename) => !expectedSet.has(filename));

  for (const filename of expected) {
    if (actualSet.has(filename) && !fs.statSync(path.join(directory, filename)).isFile()) {
      unexpected.push(`${filename} (not a file)`);
    }
  }

  if (missing.length > 0 || unexpected.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(', ')}`);
    if (unexpected.length > 0) details.push(`unexpected: ${unexpected.join(', ')}`);
    throw new Error(`candidate asset inventory mismatch for ${target}: ${details.join('; ')}`);
  }

  return expected;
}

function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'expected') {
    console.log(expectedCandidateAssets(options.version, options.target).join('\n'));
    return;
  }
  if (command === 'verify') {
    if (!options.directory) throw new Error('verify requires --directory');
    const inventory = verifyCandidateAssets(options.directory, options.version, options.target);
    console.log(
      `exact candidate asset inventory verified for ${options.target} (${inventory.length} files).`,
    );
    return;
  }
  if (command === 'stage') {
    if (!options['build-root'] || !options.directory) {
      throw new Error('stage requires --build-root and --directory');
    }
    const inventory = stageCandidateAssets(
      options['build-root'],
      options.directory,
      options.version,
      options.target,
    );
    console.log(`staged exact candidate asset inventory for ${options.target} (${inventory.length} files).`);
    return;
  }
  throw new Error(
    `usage: candidate-assets.mjs <expected|verify|stage> --version x.y.z --target <target>`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
