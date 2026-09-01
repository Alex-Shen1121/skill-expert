#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const expectedCommand = 'skill-expert-cli';
const expectedPackage = 'skill-expert';
const expectedCliProduct = 'Skill Expert';
const expectedDesktopName = 'Agent 技能管家';
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
const cliBridgePath = 'src-tauri/src/core/cli_bridge.rs';
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

expect('CLI 桥接源码', exists(cliBridgePath), `缺少 ${cliBridgePath}`);
if (exists(cliBridgePath)) {
  const bridgeSource = read(cliBridgePath);
  expect(
    'CLI 桥接命令身份',
    bridgeSource.includes('"skill-expert-cli"') &&
      bridgeSource.includes('"skill-expert-cli.exe"') &&
      !bridgeSource.includes(legacyCommand),
    `CLI 桥接必须只发布 ${expectedCommand}`,
  );
  expect(
    'CLI 桥接固定目录',
    bridgeSource.includes('central_repo::home_base_dir().join("bin")'),
    `CLI 桥接必须位于 ${expectedStateRoot}/bin`,
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
const releaseVerifiers = [
  'scripts/verify-macos-release.mjs',
  'scripts/verify-linux-release.mjs',
  'scripts/verify-windows-release.ps1',
];
expect(
  '正式发布仅构建 CLI',
  releaseWorkflow.includes(`--bin ${expectedCommand}`) &&
    releaseWorkflow.includes('verify-macos-adhoc.mjs'),
  `正式工作流必须继续构建并验证 ${expectedCommand}，但不得上传独立 CLI`,
);
for (const verifier of releaseVerifiers) {
  expect(
    `正式公开资产回验器 ${verifier}`,
    releaseWorkflow.includes(path.basename(verifier)) && !read(verifier).includes(expectedCommand),
    `正式工作流必须调用 ${verifier}，且公开资产回验器不得要求 ${expectedCommand}`,
  );
}
expect(
  'release product identity',
  releaseWorkflow.includes(expectedDesktopName) && !releaseWorkflow.includes(legacyProduct),
  `release workflow must use ${expectedDesktopName}, not ${legacyProduct}`,
);
expect(
  'macOS bundle path',
  read('scripts/verify-macos-release.mjs').includes("'Agent 技能管家.app'"),
  'release verifier must require the Agent 技能管家.app bundle',
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
const manageSkillReferencePaths = [
  'skills/manage-skills/references/install-update.md',
  'skills/manage-skills/references/deploy-organize.md',
  'skills/manage-skills/references/adopt-remove.md',
];
for (const relativePath of manageSkillReferencePaths) {
  expect('manage-skills 渐进披露参考', exists(relativePath), `缺少 ${relativePath}`);
}
const manageSkillCorpus = [
  manageSkill,
  ...manageSkillReferencePaths.filter(exists).map(read),
].join('\n');
expect(
  'manage-skills trigger description',
  /^description: Use when /m.test(manageSkill),
  'description must state only when the skill applies',
);
expect(
  'manage-skills product identity',
  manageSkill.includes(expectedCliProduct) && !manageSkill.includes('Skills Manager'),
  'skill body exposes the legacy product name',
);
expect(
  'manage-skills default library',
  manageSkill.includes(`${expectedStateRoot}/skills/`) && !manageSkill.includes(legacyStateRoot),
  'skill body uses the wrong default library',
);
expect(
  'manage-skills CLI 桥接协议',
  manageSkill.includes('$HOME/.skill-expert/bin') &&
    manageSkill.includes('BRIDGE_BROKEN') &&
    manageSkill.includes('TARGET_CONFLICT'),
  'manage-skills 必须先校验固定 CLI 桥接并处理结构化目标冲突',
);
expect(
  'manage-skills 来源修正命令',
  manageSkillCorpus.includes('skills set-source') && manageSkillCorpus.includes('--dry-run'),
  'manage-skills 必须使用 set-source 原地修正来源',
);
expect(
  'manage-skills Windows CLI 解析',
  manageSkill.includes('PowerShell') &&
    manageSkill.includes('Get-Command skill-expert-cli') &&
    manageSkill.includes('skill-expert-cli.exe'),
  'manage-skills 必须同时提供 PowerShell 桥接解析',
);
expect(
  'manage-skills 冲突收编闭环',
  manageSkillCorpus.includes('`adopt` 单独执行不会解除冲突') &&
    manageSkillCorpus.includes('synced=false'),
  'manage-skills 必须说明收编不会认领原冲突路径',
);
expect(
  'manage-skills 更新覆盖边界',
  manageSkillCorpus.includes('远端新版本仍包含同名文件') &&
    manageSkillCorpus.includes('内容却会覆盖本地编辑'),
  'manage-skills 必须说明 held_back_removals 不保护同名文件编辑',
);

const managementSkillModule = read('src/lib/agentSkillsManagement.ts');
const managementSkillSource = managementSkillModule.match(
  /export const MANAGEMENT_SKILL_SOURCE\s*=\s*["']([^"']+)["']/,
)?.[1];
expect(
  '管理 Skill 独立仓库来源',
  managementSkillSource ===
    'https://github.com/Alex-Shen1121/skill-expert/tree/main/skills/manage-skills',
  '管理 Skill 权威模块必须指向独立仓库的固定子路径',
);
expect(
  '管理 Skill 可信安装封装',
  managementSkillModule.includes('api.installGit(MANAGEMENT_SKILL_SOURCE)') &&
    !managementSkillModule.includes('xingkongliang/skills-manager'),
  '管理 Skill 安装必须复用已验证的独立来源常量',
);

const setupCard = read('src/components/AgentControlSetupCard.tsx');
expect(
  '首页管理 Skill 入口接线',
  setupCard.includes('ensureTrustedManagementSkill') &&
    setupCard.includes('isTrustedManagementSkill') &&
    setupCard.includes('from "../lib/agentSkillsManagement"'),
  '首页设置入口必须通过权威模块校验并安装管理 Skill',
);

if (failures.length > 0) {
  console.error('CLI identity check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`CLI identity check passed for ${expectedCommand}.`);
