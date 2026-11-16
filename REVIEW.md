# Agent 技能管家代码审查

本清单沿用上游审查经验，文中的历史 Issue 和 PR 编号来自上游。当前仓库的身份、版本与发布流程以 `AGENTS.md` 和 `docs/formal-release.md` 为准。

## How to report

- Open with the number of findings. If there is nothing to fix, say
  "No issues to fix" and stop.
- For each finding give the severity, `file:line`, a concrete failure (what
  input or state leads to what wrong result) and how you know: *ran it*,
  *read the source* or *inferred*.
  - **Important**: must change before merge.
  - **Nit**: optional. Three at most.
  - **Pre-existing**: real, but not introduced by this change. Do not count it
    against the author.
- No style findings. `npm run lint` already enforces the UI spec and i18n keys.
- Do not trust the description. Check that the bug exists on `main` and that
  the change fixes it. Claims such as "fixed", "tested" or "root cause" have
  been wrong often enough (#515, #454, #444, #569) that they are the first
  thing to verify.

## How deep to go

Pick the depth from what the diff touches, not from who wrote it or how small
it looks.

**Deep**: the change can delete, overwrite or move files the user owns, takes
or skips a lock, runs git against the user's repository or cache, rewrites
metadata, migrates data, or touches release and CI. In practice, any change to:

| Path | Why it is dangerous |
|---|---|
| `core/sync_engine.rs`, `core/scenario_service.rs`, `core/installer.rs`, `commands/projects.rs`, `commands/skills.rs` (install / update / delete) | Install, update and removal of deployed skills (#363, #435, #554) |
| `core/sync_metadata.rs` | Startup reindex rebuilds the database from metadata: anything written to the DB but not to metadata is gone at the next launch (#553) |
| `core/git_fetcher.rs`, `core/git_backup.rs`, `core/auto_backup.rs`, `core/repo_lock.rs`, `core/git2_engine.rs` | Cache slots, locks, network git, clone and reclone (#429, #515, #519) |
| `core/central_repo.rs`, `core/migrations.rs`, `core/content_hash.rs` | Library location, schema, and the hash that identifies stored content |
| `core/tool_adapters.rs`, when it **changes** an existing adapter's paths | Retargeting removes the old deployments; several adapters can share one directory |
| `.github/workflows/**`, `scripts/prepare-release.mjs`, `src-tauri/tauri.conf.json`, dependency manifests | Release assets: the Homebrew cask and the Scoop Extras manifest fetch assets by name, and `productName` fixes those names; supply chain |

深度审查需要运行受影响子系统的测试；可测试的行为修复应有能证明失败与修复的回归。高风险文件操作和迁移还需独立审查。普通 PR 维持三项轻量门禁，macOS/Windows Rust 测试及安装包验证由用户明确授权后的正式发布工作流执行。

**Standard**: other Rust or frontend logic, and new adapters. Read the whole
diff and run the checks for what changed: `npm run lint` and `npm run build`
for the frontend, `cargo test` for Rust.

**Quick**: docs, README, translation strings, icons, styling. Read it once and
look at whatever checks ran. A docs-only change triggers no workflow, so read
that one by hand.

`cfg(windows)` 变更按深度审查处理；Windows 行为以正式发布工作流中的平台测试为准，本地 macOS 通过不能代替 Windows 验证。

## What goes wrong here

Each of these has already happened in this repository.

1. **Deleting what is not ours.** Ownership or sync-state checks get loosened,
   and a directory with local edits is deleted (#554, #382, #502, #289). A row
   in `skill_targets` says what we deployed in the past, not who owns the disk
   now. Cleanup that acts on such a row goes through
   `sync_engine::remove_recorded_target*`. For copy-mode targets that check
   only asks whether a real directory is there, and `content_hash` skips
   `.gitignore` and caches, so equal hashes do not prove a copy is unedited
   (#593).
2. **Failure reported as success.** `Ok(())` on a refusal, an error chain
   flattened to `[object Object]`, stderr thrown away, a check that could not
   run reported as an update (#378, #328, #363, #529, #582).
3. **Records undone by the next launch.** A write that reaches the database
   but not `sync_metadata` disappears at reindex (#553).
4. **Tests that pass without the fix.** Remove the fix and the test stays
   green (#548, #515, #506, #489). For each new test, name the line that turns
   it red.
5. **Behaviour changes inside a bug fix.** A new default, a changed sort, a
   preset no longer activated (#493, #317, #410, #519). Split them out: they
   need a product decision.
6. **Platform paths.** `/`-joined paths on Windows (#482, #512), a Windows
   spawn without `CREATE_NO_WINDOW` (#413; git spawns get it from
   `git_command()`), `candidate_paths` without a Windows root (#433).
7. **Shared directories.** amp and replit both deploy to
   `~/.config/agents/skills`. Disabling or retargeting one tool must not remove
   another tool's live deployment.
8. **Hash and timestamp semantics.** `content_hash` is recomputed from disk on
   every reindex, so it is not an install baseline. `updated_at` is
   bookkeeping, not content time (#454, #506).
9. **Git cache.** The full and `-sparse` slots are not interchangeable. Every
   git command run on a cache needs a timeout and cancellation (see
   `run_git_watched`), and the slot must be locked first (#515, #519, #429).
10. **Unrelated changes in the diff.** rustfmt churn, lockfile version drift,
    committed screenshots or files under ignored paths, unrelated workflow edits.
    用户可见改动写入双语 `[Unreleased]`；正式发布准备命令负责归档并同步版本。

## Before approving

- "No checks" on a fork PR means CI has not been approved yet. It does not
  mean green.
- A Rust change needs `cargo test`. The frontend build does not compile Rust
  tests (#444).
- `tsc --noEmit` checks no file here, because the root tsconfig only holds
  project references. Use `npm run build`.
- New features and changed defaults need the maintainer's product sign-off.
  Code that is already written is not, by itself, a reason to merge.

## Re-reviews

- After the first round, review what changed since the last review, and do
  not repeat a finding you already posted unless new evidence reopens it.
- When you find one instance of a bug class, ask for every instance to be
  fixed.
- If a PR is still collecting new findings after three rounds, question the
  approach instead of sending a fourth list. An unresolved Important finding
  still blocks the merge.

## When something slips through

When a bug reaches a release, add it here with the layer that should have
caught it.

| Escape | Should have been caught by |
|---|---|
| #378: built-in `deepseek_harness` changed the read side's precedence, write side untested | A test for both setters |
| #413: `cli_bridge` spawned without `CREATE_NO_WINDOW` | Checking every new Windows spawn for the flag |
| #433: adapter judged mergeable, Windows path wrong | Checking path resolution on all three platforms |
| #482: `/`-joined path failed on Windows | Approving Windows CI before merge |
