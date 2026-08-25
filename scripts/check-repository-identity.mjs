#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const expectedRepository = 'Alex-Shen1121/skill-expert';
const expectedProduct = 'Skill Expert';
const expectedPackage = 'skill-expert';
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function expect(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`);
}

const currentPublicSurfaces = [
  '.codex/environments/environment.toml',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/workflows/release.yml',
  'CONTRIBUTING.md',
  'README.md',
  'README.zh-CN.md',
  'docs/agents/issue-tracker.md',
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/src/commands/settings.rs',
  'src-tauri/tauri.conf.json',
  'src/views/Settings.tsx',
];

const forbiddenPublicIdentity = [
  ['legacy product name', 'Skills Manager'],
  ['legacy fork repository', 'Alex-Shen1121/skills-manager'],
  ['upstream repository', 'xingkongliang/skills-manager'],
  ['upstream website', 'skillsmanager.dev'],
  ['legacy backup repository', 'skills-manager-backup'],
  ['legacy app asset', 'skills-manager.app'],
  ['legacy keyring identity', 'skills-manager-git-backup'],
];

for (const relativePath of currentPublicSurfaces) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    failures.push(`${relativePath}: required public identity surface is missing`);
    continue;
  }
  const contents = read(relativePath);
  const normalizedContents = contents.toLowerCase();
  for (const [label, forbidden] of forbiddenPublicIdentity) {
    expect(
      `${relativePath} ${label}`,
      !normalizedContents.includes(forbidden.toLowerCase()),
      `found ${forbidden}`,
    );
  }
}

for (const relativePath of ['assets/star-history.svg', '.github/FUNDING.yml']) {
  if (!fs.existsSync(path.join(root, relativePath))) continue;
  const contents = read(relativePath);
  expect(
    `${relativePath} upstream owner`,
    !contents.includes('xingkongliang') && !contents.toLowerCase().includes('jaytl'),
    'found an upstream owner or funding identity',
  );
}

const readme = read('README.md');
const readmeZh = read('README.zh-CN.md');
const approvedPublishedImageAssets = new Set([
  'assets/icon.png',
  'assets/diagram-concept-map.png',
]);
const publishedImageAssets = new Set();

function addPublishedImageAsset(source) {
  const normalized = source.trim().replace(/^<|>$/g, '');
  if (normalized && !normalized.startsWith('#')) {
    publishedImageAssets.add(normalized);
  }
}

function collectPublishedImageAssets(contents) {
  for (const match of contents.matchAll(/<img\s+[^>]*src=["']([^"']+)["']/gi)) {
    addPublishedImageAsset(match[1]);
  }
  for (const match of contents.matchAll(
    /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
  )) {
    addPublishedImageAsset(match[1] ?? match[2]);
  }

  const referenceDefinitions = new Map();
  for (const match of contents.matchAll(
    /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^\s\n]+))/gm,
  )) {
    const label = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
    referenceDefinitions.set(label, match[2] ?? match[3]);
  }
  for (const match of contents.matchAll(/!\[([^\]\n]*)\]\[([^\]\n]*)\]/g)) {
    const label = (match[2] || match[1]).trim().toLowerCase().replace(/\s+/g, ' ');
    const source = referenceDefinitions.get(label);
    if (source) addPublishedImageAsset(source);
  }
  for (const match of contents.matchAll(/!\[([^\]\n]+)\](?!\s*(?:\(|\[))/g)) {
    const label = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
    const source = referenceDefinitions.get(label);
    if (source) addPublishedImageAsset(source);
  }
}

for (const [relativePath, contents] of [
  ['README.md', readme],
  ['README.zh-CN.md', readmeZh],
]) {
  collectPublishedImageAssets(contents);
  expect(
    `${relativePath} product heading`,
    contents.includes(`<h1 align="center">${expectedProduct}</h1>`),
    `expected ${expectedProduct}`,
  );
  expect(
    `${relativePath} canonical repository`,
    contents.includes(`https://github.com/${expectedRepository}`),
    `missing ${expectedRepository}`,
  );
  expect(
    `${relativePath} backup repository`,
    contents.includes('skill-expert-backup'),
    'missing skill-expert-backup',
  );
}
expect(
  'README published image assets',
  publishedImageAssets.size === approvedPublishedImageAssets.size &&
    [...publishedImageAssets].every((asset) => approvedPublishedImageAssets.has(asset)),
  `expected only ${[...approvedPublishedImageAssets].join(', ')}, found ${[
    ...publishedImageAssets,
  ].join(', ')}`,
);

const packageJson = readJson('package.json');
const tauriConfig = readJson('src-tauri/tauri.conf.json');
const cargoToml = read('src-tauri/Cargo.toml');
expect('npm package identity', packageJson.name === expectedPackage, `expected ${expectedPackage}`);
expect(
  'Cargo package identity',
  new RegExp(`^name = "${expectedPackage}"$`, 'm').test(cargoToml),
  `expected ${expectedPackage}`,
);
expect(
  'Cargo package ownership',
  cargoToml.includes('authors = ["Alex-Shen1121"]'),
  'expected Alex-Shen1121',
);
expect(
  'package metadata links',
  packageJson.homepage === `https://github.com/${expectedRepository}#readme` &&
    packageJson.repository?.type === 'git' &&
    packageJson.repository?.url === `git+https://github.com/${expectedRepository}.git` &&
    packageJson.bugs?.url === `https://github.com/${expectedRepository}/issues` &&
    cargoToml.includes(`homepage = "https://github.com/${expectedRepository}#readme"`) &&
    cargoToml.includes(`repository = "https://github.com/${expectedRepository}"`),
  `expected canonical npm and Cargo links for ${expectedRepository}`,
);
expect(
  'desktop package identity',
  tauriConfig.productName === expectedProduct,
  `expected ${expectedProduct}`,
);

const issueTracker = read('docs/agents/issue-tracker.md');
const issueConfig = read('.github/ISSUE_TEMPLATE/config.yml');
const contributing = fs.existsSync(path.join(root, 'CONTRIBUTING.md'))
  ? read('CONTRIBUTING.md')
  : '';
expect(
  'agent issue tracker repository',
  issueTracker.includes(`目标仓库：\`${expectedRepository}\``),
  `expected ${expectedRepository}`,
);
expect(
  'community support repository',
  issueConfig.includes(`https://github.com/${expectedRepository}/discussions`),
  `expected ${expectedRepository}/discussions`,
);
expect(
  'contribution repository',
  contributing.includes(`https://github.com/${expectedRepository}/issues`) &&
    contributing.includes(`https://github.com/${expectedRepository}/discussions`) &&
    contributing.includes(`https://github.com/${expectedRepository}/pulls`),
  `expected contribution entrypoints for ${expectedRepository}`,
);

const settingsView = read('src/views/Settings.tsx');
const settingsCommand = read('src-tauri/src/commands/settings.rs');
const repositoryUrl = `https://github.com/${expectedRepository}`;
const diagnosticsIssueUrl = `${repositoryUrl}/issues/new?template=bug_report.md`;
const updaterEndpoint = `https://github.com/${expectedRepository}/releases/latest/download/latest.json`;
expect(
  'diagnostics issue destination',
  settingsView.includes(`const GITHUB_URL = "${repositoryUrl}";`) &&
    settingsView.includes(`const REPORT_ISSUE_URL = "${diagnosticsIssueUrl}";`) &&
    settingsView.includes('openUrl(REPORT_ISSUE_URL)'),
  `expected ${diagnosticsIssueUrl}`,
);
expect(
  'release destination',
  settingsView.includes(`const RELEASES_URL = "${repositoryUrl}/releases";`) &&
    settingsView.includes('openUrl(RELEASES_URL)'),
  `expected ${expectedRepository}/releases`,
);
expect(
  'release API repository',
  settingsCommand.includes(`https://api.github.com/repos/${expectedRepository}/releases/latest`),
  `expected ${expectedRepository}`,
);
expect(
  'updater feed repository',
  JSON.stringify(tauriConfig.plugins?.updater?.endpoints) === JSON.stringify([updaterEndpoint]),
  `expected only ${updaterEndpoint}`,
);

const releaseWorkflow = read('.github/workflows/release.yml');
const candidateAssets = read('scripts/candidate-assets.mjs');
const cliAssetContract = '`skill-expert-cli-v${version}-${target}${contract.cliSuffix}`';
expect(
  '正式发布 CLI 资产身份',
  releaseWorkflow.includes('candidate-assets.mjs stage') &&
    candidateAssets.split(cliAssetContract).length - 1 === 2,
  '正式工作流必须通过资产契约生成 skill-expert-cli-v<version>-<target> 资产',
);
expect(
  'desktop release asset identity',
  releaseWorkflow.includes('$BUNDLE_DIR/Skill Expert.app'),
  'missing Skill Expert desktop asset',
);

if (failures.length > 0) {
  console.error('Repository identity check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Repository identity check passed for ${expectedRepository} (${expectedProduct}/${expectedPackage}).`,
);
