#!/usr/bin/env node
// Enforces the greppable parts of the UI spec ("UI 风格规范" in AGENTS.md):
// arbitrary radii, in-between font sizes, and hard-coded hex colours in class
// names. Each rule's message names the fix; exceptions carry their reason here.
import fs from 'node:fs';
import path from 'node:path';

// Agent icon cells are spec'd at rounded-[4px]. Nothing else gets an arbitrary radius.
const AGENT_ICON_CELLS = new Set([
  'src/components/AddSkillsSheet.tsx',
  'src/components/AgentControlSetupCard.tsx',
  'src/components/AgentToggleSection.tsx',
  'src/components/BatchSyncAgentDialog.tsx',
  'src/components/ProjectAgentDots.tsx',
  'src/components/SkillProjectsSection.tsx',
  'src/components/SyncDots.tsx',
]);

const RULES = [
  {
    pattern: /\brounded(?:-[a-z]{1,2})?-\[[^\]\s]+\]/g,
    allowed: (file, match) =>
      (match === 'rounded-[4px]' && AGENT_ICON_CELLS.has(file)) ||
      // The welcome dialog's oversized radius is deliberate.
      (match === 'rounded-[28px]' && file === 'src/components/HelpDialog.tsx'),
    fix: 'use the radius scale: rounded-xl (cards, panels, dialogs), rounded-lg (buttons, inputs), '
      + 'rounded-md (icon buttons, segments, menu items), rounded-full (pills, tags, badges)',
  },
  {
    pattern: /\btext-\[\d+\.\d+px\]/g,
    allowed: () => false,
    fix: 'use a font-size step: text-[17px] page title, text-[14px] card title, text-[13px] body, '
      + 'text-[12px] secondary, text-[11px] pill',
  },
  {
    pattern: /\[[^\]\s"'`]*#[0-9a-fA-F]{3,8}\b[^\]\s"'`]*\]/g,
    // GitHub's diff palette: each light value is paired with a dark: value,
    // and no token covers added/removed line backgrounds.
    allowed: (file) => file === 'src/components/DocumentDiffViewer.tsx',
    fix: 'use a token class (bg-surface, text-muted, border-border-subtle, text-accent, ...) '
      + 'or the amber/emerald/rose palette with a dark: variant',
  },
];

const files = fs
  .readdirSync('src', { recursive: true })
  .map((entry) => path.join('src', entry).split(path.sep).join('/'))
  .filter((file) => /\.(tsx?|css)$/.test(file));

const violations = [];
for (const file of files) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    for (const rule of RULES) {
      for (const [match] of line.matchAll(rule.pattern)) {
        if (!rule.allowed(file, match)) {
          violations.push(`${file}:${index + 1}: ${match} — ${rule.fix}`);
        }
      }
    }
  });
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  console.error(`\n${violations.length} UI spec violation(s).`);
  process.exit(1);
}
console.log(`UI spec check passed (${files.length} files).`);
