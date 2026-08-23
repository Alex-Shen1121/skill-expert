#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function readJson(root, relativePath) {
  const filePath = path.join(root, relativePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function packageMetadataFromCargoToml(content) {
  const lines = content.split(/\r?\n/);
  const packageStart = lines.findIndex((line) => line.trim() === '[package]');
  if (packageStart === -1) return null;
  const nextSectionOffset = lines
    .slice(packageStart + 1)
    .findIndex((line) => /^\[[^\]]+\]\s*$/.test(line.trim()));
  const packageEnd = nextSectionOffset === -1 ? lines.length : packageStart + 1 + nextSectionOffset;
  const packageSection = lines.slice(packageStart + 1, packageEnd).join('\n');

  const name = packageSection.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  return name && version ? { name, version } : null;
}

function packageVersionFromCargoLock(content, packageName) {
  for (const block of content.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (name !== packageName) continue;
    return block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? null;
  }
  return null;
}

function translatedVersion(value) {
  if (typeof value !== 'string') return null;
  return value.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
}

function firstChangelogVersion(content) {
  return content.match(/^## \[(\d+\.\d+\.\d+)\](?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$/m)?.[1] ?? null;
}

function compare(mismatches, label, actual, expected) {
  if (actual !== expected) {
    mismatches.push(`${label}: expected ${expected}, found ${actual ?? 'missing'}`);
  }
}

export function checkVersionConsistency(root = process.cwd()) {
  const mismatches = [];
  const packageJson = readJson(root, 'package.json');
  const version = packageJson.version;

  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    return {
      version,
      mismatches: [`package.json: expected a stable x.y.z version, found ${version ?? 'missing'}`],
    };
  }

  const packageLock = readJson(root, 'package-lock.json');
  compare(mismatches, 'package-lock.json root version', packageLock.version, version);
  compare(mismatches, 'package-lock.json workspace version', packageLock.packages?.['']?.version, version);

  const cargoMetadata = packageMetadataFromCargoToml(readText(root, 'src-tauri/Cargo.toml'));
  if (!cargoMetadata) {
    mismatches.push('src-tauri/Cargo.toml: missing [package] name or version');
  } else {
    compare(mismatches, 'src-tauri/Cargo.toml package version', cargoMetadata.version, version);
    compare(
      mismatches,
      `src-tauri/Cargo.lock package ${cargoMetadata.name}`,
      packageVersionFromCargoLock(readText(root, 'src-tauri/Cargo.lock'), cargoMetadata.name),
      version,
    );
  }

  compare(
    mismatches,
    'src-tauri/tauri.conf.json version',
    readJson(root, 'src-tauri/tauri.conf.json').version,
    version,
  );

  for (const locale of ['en', 'zh', 'zh-TW']) {
    compare(
      mismatches,
      `src/i18n/${locale}.json settings.version`,
      translatedVersion(readJson(root, `src/i18n/${locale}.json`).settings?.version),
      version,
    );
  }

  for (const changelog of ['CHANGELOG.md', 'CHANGELOG-zh.md']) {
    compare(mismatches, `${changelog} latest release`, firstChangelogVersion(readText(root, changelog)), version);
  }

  return { version, mismatches };
}

function main() {
  try {
    const { version, mismatches } = checkVersionConsistency();
    if (mismatches.length > 0) {
      console.error('Version consistency check failed:');
      for (const mismatch of mismatches) console.error(`- ${mismatch}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Version consistency check passed for ${version}.`);
  } catch (error) {
    console.error(`Version consistency check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
