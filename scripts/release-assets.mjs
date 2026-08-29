#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCommandOptions } from './command-options.mjs';
import {
  expectedPackageAssets,
  expectedUpdaterArtifact,
  expectedUpdaterSignatureAssets,
} from './package-assets.mjs';
import { parseProductVersion } from './product-version.mjs';

const targets = ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64'];
const generatedAssets = ['SHA256SUMS', 'build-provenance.json', 'latest.json'];
const updaterPlatforms = {
  'darwin-aarch64': 'macos-arm64',
  'darwin-x86_64': 'macos-x64',
  'linux-x86_64': 'linux-x64',
  'windows-x86_64': 'windows-x64',
};

function requireVersion(version) {
  if (!parseProductVersion(version)) {
    throw new Error(`版本必须是稳定的 x.y.z，实际为 ${version ?? '缺失'}`);
  }
}

function requireDirectory(directory) {
  if (!directory) throw new Error('缺少 --directory');
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) throw new Error(`资产目录不是文件夹：${directory}`);
}

function requireRegularFile(directory, filename) {
  const filePath = path.join(directory, filename);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`发布资产不是普通文件：${filename}`);
  return filePath;
}

export function expectedReleaseAssets(version, { includeGenerated = true } = {}) {
  requireVersion(version);
  const platformAssets = targets
    .flatMap((target) => expectedPackageAssets(version, target))
    .filter((filename) => !filename.startsWith('skill-expert-cli-'))
    .filter((filename) => !filename.endsWith('.sig'));
  return [...platformAssets, ...(includeGenerated ? generatedAssets : [])].sort();
}

export function expectedDraftOnlyAssets(version) {
  requireVersion(version);
  return targets
    .flatMap((target) => expectedUpdaterSignatureAssets(version, target))
    .sort();
}

export function createUpdaterMetadata(directory, version, pubDate) {
  requireVersion(version);
  requireDirectory(directory);
  if (typeof pubDate !== 'string' || Number.isNaN(Date.parse(pubDate))) {
    throw new Error(`pub-date 必须是有效时间，实际为 ${pubDate ?? '缺失'}`);
  }

  const downloadRoot =
    `https://github.com/Alex-Shen1121/skill-expert/releases/download/v${version}`;
  const platforms = {};
  for (const [platform, target] of Object.entries(updaterPlatforms)) {
    const artifact = expectedUpdaterArtifact(version, target);
    const signatureFile = `${artifact}.sig`;
    const signature = fs.readFileSync(requireRegularFile(directory, signatureFile), 'utf8').trim();
    if (!signature) throw new Error(`Updater 签名为空：${signatureFile}`);
    requireRegularFile(directory, artifact);
    platforms[platform] = {
      signature,
      url: `${downloadRoot}/${artifact}`,
    };
  }

  const metadata = {
    version,
    notes: `Agent 技能管家 v${version}`,
    pub_date: pubDate,
    platforms,
  };
  fs.writeFileSync(path.join(directory, 'latest.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export function createReleaseChecksums(directory, version) {
  requireVersion(version);
  requireDirectory(directory);
  const files = [
    ...expectedReleaseAssets(version, { includeGenerated: false }),
    'latest.json',
  ].sort();
  const lines = files.map((filename) => {
    const digest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(requireRegularFile(directory, filename)))
      .digest('hex');
    return `${digest}  ${filename}`;
  });
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return lines;
}

export function verifyReleaseInventory(directory, version) {
  requireVersion(version);
  requireDirectory(directory);
  const expected = expectedReleaseAssets(version);
  const actual = fs.readdirSync(directory).sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((filename) => !actualSet.has(filename));
  const unexpected = actual.filter((filename) => !expectedSet.has(filename));
  for (const filename of expected) {
    if (actualSet.has(filename) && !fs.statSync(path.join(directory, filename)).isFile()) {
      unexpected.push(`${filename}（不是普通文件）`);
    }
  }
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`缺少：${missing.join('、')}`);
    if (unexpected.length > 0) details.push(`意外：${unexpected.join('、')}`);
    throw new Error(`正式发布资产清单不匹配：${details.join('；')}`);
  }
  return expected;
}

function main() {
  try {
    const { command, options } = parseCommandOptions(process.argv.slice(2));
    if (command === 'expected') {
      console.log(expectedReleaseAssets(options.version).join('\n'));
      return;
    }
    if (command === 'draft-only') {
      console.log(expectedDraftOnlyAssets(options.version).join('\n'));
      return;
    }
    if (command === 'metadata') {
      const metadata = createUpdaterMetadata(
        options.directory,
        options.version,
        options['pub-date'],
      );
      console.log(`已生成 ${Object.keys(metadata.platforms).length} 平台的 latest.json。`);
      return;
    }
    if (command === 'checksums') {
      const lines = createReleaseChecksums(options.directory, options.version);
      console.log(`已生成 ${lines.length} 个正式资产的 SHA256SUMS。`);
      return;
    }
    if (command === 'verify') {
      const inventory = verifyReleaseInventory(options.directory, options.version);
      console.log(`正式发布精确资产清单验证通过（${inventory.length} 个文件）。`);
      return;
    }
    throw new Error(
      '用法：release-assets.mjs <expected|draft-only|metadata|checksums|verify> --version x.y.z --directory 路径',
    );
  } catch (error) {
    console.error(`正式发布资产处理失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
