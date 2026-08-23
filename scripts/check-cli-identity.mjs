#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const expectedCommand = 'skill-expert-cli';
const expectedPackage = 'skill-expert';
const expectedProduct = 'Skill Expert';
const legacyCommand = 'skills-manager-cli';
const legacyProduct = 'Skills Manager';
const expectedStateRoot = '~/.skill-expert';
const legacyStateRoot = '~/.skills-manager';
const failures = [];

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function expect(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`);
}

const newCliPath = `src-tauri/src/bin/${expectedCommand}.rs`;
const oldCliPath = `src-tauri/src/bin/${legacyCommand}.rs`;
expect('CLI source name', exists(newCliPath), `missing ${newCliPath}`);
expect('legacy CLI source removed', !exists(oldCliPath), `found ${oldCliPath}`);

if (exists(newCliPath)) {
  const cliSource = read(newCliPath);
  expect(
    'CLI command name',
    cliSource.includes(`#[command(name = "${expectedCommand}")]`),
    `expected clap command ${expectedCommand}`,
  );
  expect(
    'CLI product help',
    cliSource.includes('Skill Expert'),
    'help does not expose the Skill Expert identity',
  );
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const cargoToml = read('src-tauri/Cargo.toml');
const cargoLock = read('src-tauri/Cargo.lock');
expect('npm package identity', packageJson.name === expectedPackage, `expected ${expectedPackage}`);
for (const [script, mode] of [
  ['cli', 'cli'],
  ['cli:build', 'build'],
  ['cli:install', 'install'],
]) {
  expect(
    `npm ${script} entrypoint`,
    packageJson.scripts?.[script] === `node scripts/run-rust-cli.mjs ${mode}`,
    `expected ${script} to invoke the ${expectedCommand} ${mode} mode`,
  );
}
expect(
  'npm lockfile root identity',
  packageLock.name === expectedPackage && packageLock.packages?.['']?.name === expectedPackage,
  `expected both lockfile package names to be ${expectedPackage}`,
);
expect(
  'Cargo package identity',
  new RegExp(`^name = "${expectedPackage}"$`, 'm').test(cargoToml),
  `expected Cargo package ${expectedPackage}`,
);
expect(
  'Cargo lockfile identity',
  cargoLock.includes(`[[package]]\nname = "${expectedPackage}"\nversion = `),
  `expected Cargo.lock package ${expectedPackage}`,
);

const supportedEntrypoints = [
  'scripts/run-rust-cli.mjs',
  'README.md',
  'README.zh-CN.md',
  'skills/manage-skills/SKILL.md',
  '.github/workflows/release.yml',
];

for (const relativePath of supportedEntrypoints) {
  const contents = read(relativePath);
  expect(
    `${relativePath} command`,
    contents.includes(expectedCommand),
    `missing ${expectedCommand}`,
  );
  expect(
    `${relativePath} legacy command`,
    !contents.includes(legacyCommand),
    `found ${legacyCommand}`,
  );
}

const releaseWorkflow = read('.github/workflows/release.yml');
expect(
  'release product identity',
  releaseWorkflow.includes(expectedProduct) && !releaseWorkflow.includes(legacyProduct),
  `release workflow must use ${expectedProduct}, not ${legacyProduct}`,
);
expect(
  'macOS bundle path',
  releaseWorkflow.includes('$BUNDLE_DIR/Skill Expert.app'),
  'release workflow must verify the Skill Expert.app bundle',
);

for (const relativePath of ['README.md', 'README.zh-CN.md', 'skills/manage-skills/SKILL.md']) {
  const contents = read(relativePath);
  expect(
    `${relativePath} external state root`,
    contents.includes(`${expectedStateRoot}/external/`) || relativePath.endsWith('SKILL.md'),
    `missing ${expectedStateRoot}/external/`,
  );
  expect(
    `${relativePath} legacy state root`,
    !contents.includes(legacyStateRoot),
    `found ${legacyStateRoot}`,
  );
}

const manageSkill = read('skills/manage-skills/SKILL.md');
expect(
  'manage-skills trigger description',
  /^description: Use when /m.test(manageSkill),
  'description must state only when the skill applies',
);
expect(
  'manage-skills product identity',
  manageSkill.includes('Skill Expert') && !manageSkill.includes('Skills Manager'),
  'skill body exposes the legacy product name',
);
expect(
  'manage-skills default library',
  manageSkill.includes(`${expectedStateRoot}/skills/`) && !manageSkill.includes(legacyStateRoot),
  'skill body uses the wrong default library',
);

if (failures.length > 0) {
  console.error('CLI identity check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`CLI identity check passed for ${expectedCommand}.`);
