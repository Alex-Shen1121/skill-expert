#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const expectedName = 'Skill Expert';
const expectedIdentifier = 'com.codingshen.skill-expert';
const expectedRepository = 'Alex-Shen1121/skill-expert';
const expectedUpdaterEndpoint = `https://github.com/${expectedRepository}/releases/latest/download/latest.json`;
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

const packageJson = readJson('package.json');
const tauriConfig = readJson('src-tauri/tauri.conf.json');

expect('desktop product name', tauriConfig.productName === expectedName, `expected ${expectedName}`);
expect(
  'desktop bundle identifier',
  tauriConfig.identifier === expectedIdentifier,
  `expected ${expectedIdentifier}`,
);
expect(
  'desktop version',
  tauriConfig.version === packageJson.version,
  `expected ${packageJson.version}, found ${tauriConfig.version}`,
);
expect(
  'window title',
  tauriConfig.app?.windows?.every((window) => window.title === expectedName),
  `every window must use ${expectedName}`,
);
expect(
  'updater endpoint',
  JSON.stringify(tauriConfig.plugins?.updater?.endpoints) === JSON.stringify([expectedUpdaterEndpoint]),
  `expected only ${expectedUpdaterEndpoint}`,
);

for (const locale of ['en', 'zh', 'zh-TW']) {
  const messages = readJson(`src/i18n/${locale}.json`);
  expect(`${locale} app name`, messages.app?.name === expectedName, `expected ${expectedName}`);
  expect(
    `${locale} settings version`,
    messages.settings?.version === `${expectedName} ${packageJson.version}`,
    `expected ${expectedName} ${packageJson.version}`,
  );
  expect(
    `${locale} legacy desktop brand`,
    !JSON.stringify(messages).includes('Skills Manager'),
    'found Skills Manager in user-visible messages',
  );
}

const updateCommand = read('src-tauri/src/commands/settings.rs');
const desktopShell = read('src-tauri/src/lib.rs');
const documentShell = read('index.html');
const settingsView = read('src/views/Settings.tsx');
const backupView = read('src/views/Backup.tsx');
expect(
  'document title',
  documentShell.includes(`<title>${expectedName}</title>`),
  `expected ${expectedName}`,
);
expect(
  'tray identity',
  desktopShell.includes(`"${expectedName}"`) && desktopShell.includes(`"Open ${expectedName}"`),
  `tray menu must use ${expectedName}`,
);
expect(
  'diagnostics identity',
  settingsView.includes(`auto-collected by ${expectedName}`),
  `diagnostics must use ${expectedName}`,
);
expect(
  'backup identity',
  backupView.includes('description=Skill%20Expert%20Backup') &&
    !backupView.includes('description=Skills%20Manager%20Backup'),
  `backup UI must use ${expectedName}`,
);
expect(
  'update API repository',
  updateCommand.includes(`https://api.github.com/repos/${expectedRepository}/releases/latest`),
  `expected ${expectedRepository}`,
);
expect(
  'settings repository link',
  settingsView.includes(`https://github.com/${expectedRepository}`),
  `expected ${expectedRepository}`,
);
expect(
  'upstream update isolation',
  !`${updateCommand}\n${settingsView}`.includes('xingkongliang/skills-manager'),
  'found upstream update repository',
);

const centralRepo = read('src-tauri/src/core/central_repo.rs');
const repoLock = read('src-tauri/src/core/repo_lock.rs');
const credentials = read('src-tauri/src/core/git_credentials.rs');
expect('default central library', centralRepo.includes('".skill-expert"'), 'missing .skill-expert');
expect('default config namespace', centralRepo.includes('"skill-expert"'), 'missing skill-expert');
expect('default database', centralRepo.includes('"skill-expert.db"'), 'missing skill-expert.db');
expect(
  'no implicit legacy import',
  !centralRepo.includes('.agent-skills'),
  'desktop startup must not read or move a legacy installation',
);
expect('repository lock', repoLock.includes('".skill-expert.lock"'), 'missing .skill-expert.lock');
expect(
  'keyring namespace',
  credentials.includes('"skill-expert-git-backup"'),
  'missing skill-expert-git-backup',
);

const browserStorage = [
  read('src/components/Sidebar.tsx'),
  read('src/context/AppContext.tsx'),
  read('src/views/ProjectDetail.tsx'),
].join('\n');
expect(
  'WebView local storage namespace',
  !browserStorage.includes('"skills-manager') && browserStorage.includes('skill-expert'),
  'legacy desktop storage key remains',
);

if (failures.length > 0) {
  console.error('Desktop identity check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Desktop identity check passed for ${expectedName} ${packageJson.version} (${expectedIdentifier}).`,
);
