#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCommandOptions } from './command-options.mjs';
import { parseProductVersion } from './product-version.mjs';

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

function contractFor(version, target) {
  if (!parseProductVersion(version)) {
    throw new Error(`版本必须是 x.y.z，实际为 ${version ?? '缺失'}`);
  }
  const contract = targetContracts[target];
  if (!contract) {
    throw new Error(`不支持的打包目标：${target ?? '缺失'}`);
  }
  return contract;
}

export function expectedPackageAssets(version, target) {
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
      `${directory} 中必须恰好有一个 ${suffix} 资产，实际为 ${matches.length} 个`,
    );
  }
  return matches[0];
}

export function stagePackageAssets(buildRoot, directory, version, target) {
  const contract = contractFor(version, target);
  fs.mkdirSync(directory, { recursive: true });
  const existing = fs.readdirSync(directory);
  if (existing.length > 0) {
    throw new Error(`打包暂存目录必须为空：${directory}`);
  }

  const desktopPrefix = `skill-expert-v${version}-${target}`;
  const copies = contract.artifacts.map(([sourceDirectory, sourceSuffix, targetSuffix]) => [
    findUniqueArtifact(buildRoot, sourceDirectory, sourceSuffix),
    path.join(directory, `${desktopPrefix}${targetSuffix}`),
  ]);
  const cliName = `skill-expert-cli${contract.cliSuffix}`;
  const cliPath = path.join(buildRoot, cliName);
  if (!fs.statSync(cliPath).isFile()) throw new Error(`CLI 资产不是文件：${cliPath}`);
  copies.push([
    cliPath,
    path.join(directory, `skill-expert-cli-v${version}-${target}${contract.cliSuffix}`),
  ]);

  for (const [source, destination] of copies) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode);
  }
  return verifyPackageAssets(directory, version, target);
}

export function verifyPackageAssets(directory, version, target) {
  const expected = expectedPackageAssets(version, target);
  const actual = fs.readdirSync(directory).sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((filename) => !actualSet.has(filename));
  const unexpected = actual.filter((filename) => !expectedSet.has(filename));

  for (const filename of expected) {
    if (actualSet.has(filename) && !fs.statSync(path.join(directory, filename)).isFile()) {
      unexpected.push(`${filename}（不是文件）`);
    }
  }

  if (missing.length > 0 || unexpected.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`缺少：${missing.join('、')}`);
    if (unexpected.length > 0) details.push(`意外：${unexpected.join('、')}`);
    throw new Error(`${target} 打包资产清单不匹配：${details.join('；')}`);
  }

  return expected;
}

function main() {
  const { command, options } = parseCommandOptions(process.argv.slice(2));
  if (command === 'expected') {
    console.log(expectedPackageAssets(options.version, options.target).join('\n'));
    return;
  }
  if (command === 'verify') {
    if (!options.directory) throw new Error('verify 需要 --directory');
    const inventory = verifyPackageAssets(options.directory, options.version, options.target);
    console.log(
      `${options.target} 打包资产精确清单验证通过（${inventory.length} 个文件）。`,
    );
    return;
  }
  if (command === 'stage') {
    if (!options['build-root'] || !options.directory) {
      throw new Error('stage 需要 --build-root 和 --directory');
    }
    const inventory = stagePackageAssets(
      options['build-root'],
      options.directory,
      options.version,
      options.target,
    );
    console.log(`已暂存 ${options.target} 打包资产精确清单（${inventory.length} 个文件）。`);
    return;
  }
  throw new Error(
    '用法：package-assets.mjs <expected|verify|stage> --version x.y.z --target <target>',
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
