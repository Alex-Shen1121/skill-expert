#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { checkVersionConsistency } from './check-version-consistency.mjs';

const root = process.cwd();
const args = process.argv.slice(2);

const releaseArg = args[0];
const dryRun = args[1] === '--dry-run';

if (!releaseArg) {
  console.error('Usage: npm run release:prepare -- <patch|minor|major> [--dry-run]');
  process.exit(1);
}

if (args.length > 2 || (args.length === 2 && !dryRun) || releaseArg.startsWith('--')) {
  console.error('Arguments must match: patch|minor|major [--dry-run]');
  process.exit(1);
}

if (!['patch', 'minor', 'major'].includes(releaseArg)) {
  console.error('Release type must be one of: patch, minor, major.');
  process.exit(1);
}

const dateStr = new Date().toISOString().slice(0, 10);

const packagePath = path.join(root, 'package.json');
const packageLockPath = path.join(root, 'package-lock.json');
const tauriConfPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(root, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(root, 'src-tauri', 'Cargo.lock');
const enI18nPath = path.join(root, 'src', 'i18n', 'en.json');
const zhI18nPath = path.join(root, 'src', 'i18n', 'zh.json');
const zhTwI18nPath = path.join(root, 'src', 'i18n', 'zh-TW.json');
const changelogPath = path.join(root, 'CHANGELOG.md');
const changelogZhPath = path.join(root, 'CHANGELOG-zh.md');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseSemver(version) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function bumpVersion(current, releaseType) {
  const parsed = parseSemver(current);
  if (!parsed) {
    throw new Error(`Current package version is not SemVer: ${current}`);
  }

  if (releaseType === 'patch') {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
  if (releaseType === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  if (releaseType === 'major') {
    return `${parsed.major + 1}.0.0`;
  }

  throw new Error(`Invalid release type: ${releaseType}`);
}

function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (leftParts[key] !== rightParts[key]) return leftParts[key] - rightParts[key];
  }
  return 0;
}

function updateSettingsVersion(i18nObj, nextVersion, fileLabel) {
  if (!i18nObj.settings || typeof i18nObj.settings.version !== 'string') {
    throw new Error(`Missing settings.version in ${fileLabel}`);
  }
  i18nObj.settings.version = i18nObj.settings.version.replace(/\d+\.\d+\.\d+/, nextVersion);
}

function updateCargoPackageVersion(cargoToml, nextVersion) {
  const packageStart = cargoToml.indexOf('[package]');
  if (packageStart === -1) {
    throw new Error('Missing [package] in src-tauri/Cargo.toml');
  }
  const nextSection = cargoToml.indexOf('\n[', packageStart + '[package]'.length);
  const packageEnd = nextSection === -1 ? cargoToml.length : nextSection;
  const packageSection = cargoToml.slice(packageStart, packageEnd);
  if (!/^version = "[^"]+"$/m.test(packageSection)) {
    throw new Error('Missing package version in src-tauri/Cargo.toml');
  }
  const updatedSection = packageSection.replace(
    /^version = "[^"]+"$/m,
    `version = "${nextVersion}"`,
  );
  return `${cargoToml.slice(0, packageStart)}${updatedSection}${cargoToml.slice(packageEnd)}`;
}

function updateCargoLockVersion(cargoLock, nextVersion) {
  const packagePattern = /(\[\[package\]\]\nname = "skill-expert"\nversion = ")[^"]+("\n)/;
  if (!packagePattern.test(cargoLock)) {
    throw new Error('Missing skill-expert package entry in src-tauri/Cargo.lock');
  }
  return cargoLock.replace(
    packagePattern,
    (_match, prefix, suffix) => `${prefix}${nextVersion}${suffix}`,
  );
}

function promoteUnreleased(changelog, nextVersion, { zh = false } = {}) {
  const fileLabel = zh ? 'CHANGELOG-zh.md' : 'CHANGELOG.md';
  const escapedVersion = nextVersion.replaceAll('.', '\\.');
  if (new RegExp(`^## \\[${escapedVersion}\\](?:\\s+-|\\s*$)`, 'm').test(changelog)) {
    throw new Error(`Target heading ## [${nextVersion}] already exists in ${fileLabel}`);
  }
  const unreleasedMatch = /^## \[Unreleased\]\s*$/m.exec(changelog);
  if (!unreleasedMatch) {
    throw new Error(`Missing ## [Unreleased] heading in ${fileLabel}`);
  }

  const bodyStart = unreleasedMatch.index + unreleasedMatch[0].length;
  const nextHeadingMatch = /^## \[[^\]]+\](?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$/m.exec(
    changelog.slice(bodyStart),
  );
  if (!nextHeadingMatch) {
    throw new Error(`Missing released version heading in ${fileLabel}`);
  }

  const nextHeadingStart = bodyStart + nextHeadingMatch.index;
  const notes = changelog.slice(bodyStart, nextHeadingStart).trim();
  if (!/^-[ \t]+\S/m.test(notes)) {
    throw new Error(`${fileLabel} Unreleased must contain at least one non-empty bullet`);
  }
  const prefix = changelog.slice(0, unreleasedMatch.index);
  const history = changelog.slice(nextHeadingStart).trimStart();
  const sections = zh
    ? ['### 发布概览', '-', '', '### 用户可见更新', '-', '', '### 开发者与治理更新', '-']
    : ['### Release Overview', '-', '', '### User-facing', '-', '', '### Developer & Governance', '-'];
  const template = ['## [Unreleased]', '', ...sections].join('\n');

  return `${prefix}${template}\n\n## [${nextVersion}] - ${dateStr}\n\n${notes}\n\n${history}`;
}

function main() {
  const { mismatches } = checkVersionConsistency(root);
  if (mismatches.length > 0) {
    throw new Error(`Current version contract has drifted:\n- ${mismatches.join('\n- ')}`);
  }

  const pkg = readJson(packagePath);
  const packageLock = readJson(packageLockPath);
  const tauriConf = readJson(tauriConfPath);
  const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
  const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
  const en = readJson(enI18nPath);
  const zh = readJson(zhI18nPath);
  const zhTw = readJson(zhTwI18nPath);
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const changelogZh = fs.readFileSync(changelogZhPath, 'utf8');

  const currentVersion = pkg.version;
  const nextVersion = bumpVersion(currentVersion, releaseArg);
  const tagName = `v${nextVersion}`;
  const tagCheck = spawnSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' });
  if (tagCheck.status !== 0) {
    throw new Error(`Unable to inspect Git tags: ${tagCheck.stderr.trim()}`);
  }
  const tagNames = new Set(tagCheck.stdout.split(/\r?\n/).filter(Boolean));
  const originCheck = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (originCheck.status === 0) {
    const remoteTagCheck = spawnSync('git', ['ls-remote', '--tags', '--refs', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (remoteTagCheck.status !== 0) {
      throw new Error(`Unable to inspect origin tags: ${remoteTagCheck.stderr.trim()}`);
    }
    for (const line of remoteTagCheck.stdout.split(/\r?\n/)) {
      const tag = line.match(/\srefs\/tags\/(v\d+\.\d+\.\d+)$/)?.[1];
      if (tag) tagNames.add(tag);
    }
  }
  const stableTags = [...tagNames]
    .map((tag) => ({ tag, version: tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1] }))
    .filter(({ version }) => version);
  if (stableTags.some(({ tag }) => tag === tagName)) {
    throw new Error(`Tag ${tagName} already exists`);
  }
  const latestTag = stableTags.sort((left, right) => compareSemver(right.version, left.version))[0];
  if (latestTag && compareSemver(nextVersion, latestTag.version) <= 0) {
    throw new Error(
      `Target version ${nextVersion} must be newer than existing tag ${latestTag.tag}`,
    );
  }

  pkg.version = nextVersion;
  packageLock.version = nextVersion;
  packageLock.packages[''].version = nextVersion;
  tauriConf.version = nextVersion;
  const nextCargoToml = updateCargoPackageVersion(cargoToml, nextVersion);
  const nextCargoLock = updateCargoLockVersion(cargoLock, nextVersion);
  updateSettingsVersion(en, nextVersion, 'src/i18n/en.json');
  updateSettingsVersion(zh, nextVersion, 'src/i18n/zh.json');
  updateSettingsVersion(zhTw, nextVersion, 'src/i18n/zh-TW.json');
  const nextChangelog = promoteUnreleased(changelog, nextVersion);
  const nextChangelogZh = promoteUnreleased(changelogZh, nextVersion, { zh: true });

  if (dryRun) {
    console.log(`[dry-run] ${currentVersion} -> ${nextVersion}`);
    return;
  }

  writeJson(packagePath, pkg);
  writeJson(packageLockPath, packageLock);
  writeJson(tauriConfPath, tauriConf);
  fs.writeFileSync(cargoTomlPath, nextCargoToml);
  fs.writeFileSync(cargoLockPath, nextCargoLock);
  writeJson(enI18nPath, en);
  writeJson(zhI18nPath, zh);
  writeJson(zhTwI18nPath, zhTw);
  fs.writeFileSync(changelogPath, nextChangelog);
  fs.writeFileSync(changelogZhPath, nextChangelogZh);

  console.log(`Prepared release ${nextVersion}`);
  console.log('Updated:');
  console.log('- CHANGELOG.md');
  console.log('- CHANGELOG-zh.md');
  console.log('- package.json');
  console.log('- package-lock.json');
  console.log('- src-tauri/tauri.conf.json');
  console.log('- src-tauri/Cargo.toml');
  console.log('- src-tauri/Cargo.lock');
  console.log('- src/i18n/en.json');
  console.log('- src/i18n/zh.json');
  console.log('- src/i18n/zh-TW.json');
}

main();
