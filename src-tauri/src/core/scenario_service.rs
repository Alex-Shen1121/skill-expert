use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

use super::{
    central_repo, content_hash,
    error::{AppError, TargetConflictDetail},
    skill_store::{ScenarioRecord, SkillStore, SkillTargetRecord},
    sync_engine, sync_metadata, tool_adapters, tool_service,
};

#[derive(Debug, Clone)]
pub struct ScenarioSyncTarget {
    pub skill_id: String,
    pub skill_name: String,
    pub tool: String,
    pub source: PathBuf,
    pub target: PathBuf,
    pub mode: sync_engine::SyncMode,
    /// Current content hash of the central skill source, copied from
    /// `SkillRecord.content_hash`. Compared against the previously
    /// synced `SkillTargetRecord.source_hash` to skip redundant
    /// Copy-mode resyncs at startup (issue #153).
    pub source_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncPreviewTarget {
    pub skill_id: String,
    pub skill_name: String,
    pub tool: String,
    pub target_path: String,
    pub mode: String,
}

pub fn ensure_scenario_exists(store: &SkillStore, scenario_id: &str) -> Result<(), AppError> {
    let exists = store
        .get_all_scenarios()
        .map_err(AppError::db)?
        .iter()
        .any(|s| s.id == scenario_id);
    if !exists {
        return Err(AppError::not_found("Scenario not found"));
    }
    Ok(())
}

pub fn enabled_installed_adapters_for_scenario_skill(
    store: &SkillStore,
    scenario_id: &str,
    skill_id: &str,
) -> Result<Vec<tool_adapters::ToolAdapter>, AppError> {
    let adapters = tool_adapters::enabled_installed_adapters(store)?;
    let adapter_keys: Vec<String> = adapters.iter().map(|a| a.key.clone()).collect();

    store
        .ensure_scenario_skill_tool_defaults(scenario_id, skill_id, &adapter_keys)
        .map_err(AppError::db)?;

    let enabled = store
        .get_enabled_tools_for_scenario_skill(scenario_id, skill_id)
        .map_err(AppError::db)?;
    let enabled_set: HashSet<String> = enabled.into_iter().collect();

    Ok(adapters
        .into_iter()
        .filter(|adapter| enabled_set.contains(&adapter.key))
        .collect())
}

pub fn collect_scenario_sync_targets(
    store: &SkillStore,
    scenario_id: &str,
) -> Result<Vec<ScenarioSyncTarget>, AppError> {
    let skills = store
        .get_skills_for_scenario(scenario_id)
        .map_err(AppError::db)?;
    let configured_mode = store.get_setting("sync_mode").map_err(AppError::db)?;
    let existing_targets = store.get_all_targets().map_err(AppError::db)?;
    let mut targets = Vec::new();

    for skill in &skills {
        let source = PathBuf::from(&skill.central_path);
        let target_name = sync_engine::target_dir_name(&source, &skill.name);
        let adapters =
            enabled_installed_adapters_for_scenario_skill(store, scenario_id, &skill.id)?;
        for adapter in &adapters {
            let target = deployment_target(adapter, &target_name, &skill.id, &existing_targets);
            let mode = sync_engine::sync_mode_for_tool(&adapter.key, configured_mode.as_deref());
            targets.push(ScenarioSyncTarget {
                skill_id: skill.id.clone(),
                skill_name: skill.name.clone(),
                tool: adapter.key.clone(),
                source: source.clone(),
                target,
                mode,
                source_hash: skill.content_hash.clone(),
            });
        }
    }

    Ok(targets)
}

fn deployment_target(
    adapter: &tool_adapters::ToolAdapter,
    target_name: &str,
    skill_id: &str,
    existing_targets: &[SkillTargetRecord],
) -> PathBuf {
    let root = adapter.skills_dir();
    existing_targets
        .iter()
        .find(|target| target.skill_id == skill_id && target.tool == adapter.key)
        .map(|target| PathBuf::from(&target.target_path))
        .filter(|path| is_skill_path_within_root(path, &root))
        .unwrap_or_else(|| root.join(target_name))
}

fn is_skill_path_within_root(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|relative| {
        !relative.as_os_str().is_empty()
            && relative
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)))
    })
}

pub fn preview_scenario_sync(
    store: &SkillStore,
    scenario_id: &str,
) -> Result<Vec<SyncPreviewTarget>, AppError> {
    collect_scenario_sync_targets(store, scenario_id).map(|targets| {
        targets
            .into_iter()
            .map(|target| SyncPreviewTarget {
                skill_id: target.skill_id,
                skill_name: target.skill_name,
                tool: target.tool,
                target_path: target.target.to_string_lossy().to_string(),
                mode: target.mode.as_str().to_string(),
            })
            .collect()
    })
}

/// Decide which `SyncMode` `is_target_current` should compare against, or
/// `None` if the existing target's mode is incompatible with the desired
/// mode and the skip path must be refused.
///
/// Returns `Some(existing)` when both modes match exactly. Also returns
/// `Some(Copy)` when the existing record is `"copy"` but the desired
/// mode is `Symlink` — this is the Windows fallback case (issue #153):
/// `symlink_dir()` failed on a prior run and we landed in copy mode, so
/// every subsequent startup would re-attempt symlink, fail again, and
/// trigger a full recursive copy. Treating the existing copy as
/// compatible lets the hash gate skip when the source hasn't changed.
///
/// The reverse direction (existing `"symlink"`, desired `Copy`) returns
/// `None` because the user actively changed the `sync_mode` setting and
/// the on-disk symlink doesn't reflect that intent.
fn skip_check_mode(
    existing_mode: &str,
    desired: sync_engine::SyncMode,
) -> Option<sync_engine::SyncMode> {
    match (existing_mode, desired) {
        ("symlink", sync_engine::SyncMode::Symlink) => Some(sync_engine::SyncMode::Symlink),
        ("copy", sync_engine::SyncMode::Copy) => Some(sync_engine::SyncMode::Copy),
        ("copy", sync_engine::SyncMode::Symlink) => Some(sync_engine::SyncMode::Copy),
        _ => None,
    }
}

/// A rename only, so nothing is copied half-way; across volumes it fails and
/// the caller keeps the copy where it is.
fn move_into_kept_copies(path: &Path, tool: &str) -> std::io::Result<PathBuf> {
    let root = central_repo::base_dir()
        .join("kept-copies")
        .join(single_dir_name(tool));
    std::fs::create_dir_all(&root)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    let mut kept = root.join(&name);
    let mut n = 2;
    // `symlink_metadata`, not `exists`: a dangling link still takes the name.
    while std::fs::symlink_metadata(&kept).is_ok() {
        kept = root.join(format!("{name}-{n}"));
        n += 1;
    }
    std::fs::rename(path, &kept)?;
    Ok(kept)
}

/// A tool key as one directory name. Custom keys reach here unchecked from
/// the CLI, so a key like `../skills` must not lead outside `kept-copies/`.
fn single_dir_name(key: &str) -> String {
    let name: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.is_empty() {
        "tool".to_string()
    } else {
        name
    }
}

/// Whether the deployment recorded at exactly this path is still current, so a
/// resync can leave it alone: a link to the source, or a real directory copied
/// from the library's current content hash (#153).
///
/// [`sync_engine::sync_skill`] rewrites a recorded copy wholesale. Only the
/// startup and preset sync asked this first, so every other resync (a preset
/// applied from the PresetBar, a batch deploy, the sync after an install, an
/// update that changed no content) deleted whatever had been written into the
/// agent's copy although the library had not changed. Skipping never deletes
/// anything, so every resync can ask.
///
/// Only the calling tool's own row counts. Rows of other tools sharing the
/// directory are history of their own deployments, and the removal paths rely
/// on their disagreeing to keep a directory whose owner is unclear. A copy
/// replaced by a file or a foreign link is not current, so `sync_skill` still
/// gets to refuse whatever replaced it.
pub(crate) fn recorded_target_is_current(
    record: Option<&SkillTargetRecord>,
    source: &Path,
    target: &Path,
    desired: sync_engine::SyncMode,
    library_hash: Option<&str>,
) -> bool {
    let Some(record) = record.filter(|record| record.status == "ok") else {
        return false;
    };
    let Some(check_mode) = skip_check_mode(&record.mode, desired) else {
        return false;
    };
    // A link to the source serves the library's content too; anything else
    // in place of the copy goes to `sync_skill`, which refuses it.
    if matches!(check_mode, sync_engine::SyncMode::Copy)
        && !matches!(
            sync_engine::classify_target(target, Some(source)),
            Ok(sync_engine::TargetState::RealDir | sync_engine::TargetState::LinkToSource)
        )
    {
        return false;
    }
    sync_engine::is_target_current(
        source,
        target,
        check_mode,
        record.source_hash.as_deref(),
        library_hash,
    )
}

/// A key identifying the *directory entry* a target path names, used to spot
/// two rows that claim one object under different spellings.
///
/// The parent is canonicalized (resolving `..` and symlinked ancestors) and the
/// final component re-attached verbatim — deliberately NOT `canonicalize()` on
/// the whole path, which follows the final symlink and would collapse every
/// agent's link into the one library directory they all point at, making
/// distinct deployments look like the same object.
///
/// Known gap: on a case-insensitive filesystem two spellings of the final
/// component still key differently. That is the same lexical assumption the
/// rest of this module makes about `target_path`. It is not harmless
/// everywhere: in the batch deploy, a contradicting row spelled with a
/// different case is not pooled, so the remaining rows can authorize a
/// replacement the contradiction should have blocked (pre-existing, H review
/// item 5). Outside the batch, rows of other agents only ever adopt, so there
/// the gap costs a refusal or an extra row, never a deletion.
pub(crate) fn ownership_key(path: &Path, memo: &mut HashMap<PathBuf, PathBuf>) -> PathBuf {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return path.to_path_buf();
    };
    // Rows share a handful of skills directories, so memoizing the parent keeps
    // this to a few syscalls no matter how large the library is.
    let canonical_parent = match memo.get(parent) {
        Some(cached) => cached.clone(),
        None => {
            let resolved = parent
                .canonicalize()
                .unwrap_or_else(|_| parent.to_path_buf());
            memo.insert(parent.to_path_buf(), resolved.clone());
            resolved
        }
    };
    canonical_parent.join(name)
}

/// What our records say we put at each target path, pooled across every row
/// that names it — the one ownership judgment every deploy path asks.
///
/// Ownership belongs to the path, not to the `(skill, tool)` pair. When several
/// agents share a skills directory, a row for any of them is evidence about the
/// object there; otherwise the agent without its own row refuses a directory we
/// demonstrably wrote for its neighbour (#363 review, cluster 37 A5). The
/// evidence is narrow on purpose:
///
/// - Every row naming the object must agree on the mode. Contradictory rows
///   mean we do not know what we put there, so they vouch for nothing —
///   taking whichever came first would let a stale `copy` row authorize
///   deleting a real directory that replaced our link.
/// - Every row naming the object must belong to the skill being deployed. A
///   row of another skill on the same path is that skill's deployment, not
///   evidence for this one.
///
/// Rows are pooled from the whole table, not just the pairs being deployed:
/// `skill_targets` is unique on `(skill_id, tool)`, not on `target_path`, so a
/// row nobody selected can still be a claim on the same object. They are keyed
/// by directory entry rather than by path string, so a row spelled differently
/// (symlinked ancestor, `..`) still counts as evidence about the same object.
struct PathEvidence {
    memo: HashMap<PathBuf, PathBuf>,
    /// `(skill_id, tool, mode)` of every row, by the directory entry it names.
    rows: HashMap<PathBuf, Vec<(String, String, String)>>,
    /// What this run itself wrote, as `(skill_id, mode)`. It outranks the
    /// rows: they describe the previous deployment, this describes what is on
    /// disk right now, and preferring them would make the second agent on a
    /// shared path refuse the directory the first one just created after a
    /// mode change.
    written: HashMap<PathBuf, (String, String)>,
}

/// What [`PathEvidence`] says about one target, for one `(skill, tool)` pair.
#[derive(Debug, PartialEq, Eq)]
enum Evidence {
    /// This agent's own row for this skill, or this run's own write: may
    /// replace what it recorded.
    Own(String),
    /// Only other agents' rows for this skill. Outside a user-initiated batch
    /// these may adopt an identical copy, never replace one: the other agent's
    /// own skip check is what preserves edits made in its copy, and borrowing
    /// its row to rewrite the directory would undo that (H review, item 1).
    Borrowed(String),
    /// Nothing vouches for the object.
    Unvouched,
}

impl Evidence {
    /// Both tiers, for the batch deploy: the user selected these pairs and
    /// confirmed the batch, so any agreeing row authorizes replacement.
    fn any_mode(&self) -> Option<&str> {
        match self {
            Evidence::Own(mode) | Evidence::Borrowed(mode) => Some(mode),
            Evidence::Unvouched => None,
        }
    }
}

impl PathEvidence {
    fn new(rows: &[SkillTargetRecord]) -> Self {
        let mut memo = HashMap::new();
        let mut by_key: HashMap<PathBuf, Vec<(String, String, String)>> = HashMap::new();
        for row in rows {
            let key = ownership_key(Path::new(&row.target_path), &mut memo);
            by_key.entry(key).or_default().push((
                row.skill_id.clone(),
                row.tool.clone(),
                row.mode.clone(),
            ));
        }
        Self {
            memo,
            rows: by_key,
            written: HashMap::new(),
        }
    }

    fn judge(&mut self, skill_id: &str, tool: &str, target: &Path) -> Evidence {
        let key = ownership_key(target, &mut self.memo);
        if let Some((writer, mode)) = self.written.get(&key) {
            return if writer == skill_id {
                Evidence::Own(mode.clone())
            } else {
                Evidence::Unvouched
            };
        }
        let Some(rows) = self.rows.get(&key) else {
            return Evidence::Unvouched;
        };
        let Some((_, _, first_mode)) = rows.first() else {
            return Evidence::Unvouched;
        };
        if !rows
            .iter()
            .all(|(owner, _, mode)| owner == skill_id && mode == first_mode)
        {
            return Evidence::Unvouched;
        }
        if rows.iter().any(|(_, row_tool, _)| row_tool == tool) {
            Evidence::Own(first_mode.clone())
        } else {
            Evidence::Borrowed(first_mode.clone())
        }
    }

    fn wrote(&mut self, skill_id: &str, target: &Path, mode: sync_engine::SyncMode) {
        let key = ownership_key(target, &mut self.memo);
        self.written
            .insert(key, (skill_id.to_string(), mode.as_str().to_string()));
    }

    fn has_written(&mut self, target: &Path) -> bool {
        let key = ownership_key(target, &mut self.memo);
        self.written.contains_key(&key)
    }

    /// Another skill was written there earlier in this run. A dry run has to
    /// treat that path as occupied, because the real run will find it so.
    fn written_by_other_skill(&mut self, skill_id: &str, target: &Path) -> bool {
        let key = ownership_key(target, &mut self.memo);
        self.written
            .get(&key)
            .is_some_and(|(writer, _)| writer != skill_id)
    }
}

/// What a deploy outside the batch does with [`PathEvidence::judge`]'s answer.
enum DeployStep {
    /// Write, replacing only what this recorded mode authorizes (`None`:
    /// nothing of the user's may be destroyed).
    Write(Option<String>),
    /// The directory already holds exactly the library's content and another
    /// agent sharing it recorded it: add this agent's row, touch nothing.
    Adopt(String),
}

fn deploy_step(evidence: Evidence, source: &Path, target: &Path) -> DeployStep {
    match evidence {
        Evidence::Own(mode) => DeployStep::Write(Some(mode)),
        Evidence::Borrowed(mode) if copy_matches_library(&mode, source, target) => {
            DeployStep::Adopt(mode)
        }
        // A link to the source, or nothing at all, is still written: neither
        // destroys anything. Anything else is refused, as it always was.
        Evidence::Borrowed(_) | Evidence::Unvouched => DeployStep::Write(None),
    }
}

/// Whether a borrowed copy-mode directory holds exactly the library's content,
/// compared the way the stranded-skill backfill does (`hash_directory` on both
/// sides, failing closed).
///
/// The hash skips `.gitignore`, caches and the like, so equal hashes do not
/// prove the copy is unedited (#593). That is acceptable here only because
/// adopting writes nothing: a wrong answer adds a row, it never deletes.
fn copy_matches_library(mode: &str, source: &Path, target: &Path) -> bool {
    mode == "copy"
        && matches!(
            sync_engine::classify_target(target, Some(source)),
            Ok(sync_engine::TargetState::RealDir)
        )
        && source.is_dir()
        && matches!(
            (
                content_hash::hash_directory(target),
                content_hash::hash_directory(source),
            ),
            (Ok(deployed), Ok(library)) if deployed == library
        )
}

/// The row recording an adopted directory: nothing was written, so its mode
/// is the borrowed evidence's and its hash the library's it was compared to.
fn adopted_target_record(
    skill_id: &str,
    tool: &str,
    target: &Path,
    mode: String,
    source_hash: Option<String>,
) -> SkillTargetRecord {
    SkillTargetRecord {
        id: uuid::Uuid::new_v4().to_string(),
        skill_id: skill_id.to_string(),
        tool: tool.to_string(),
        target_path: target.to_string_lossy().to_string(),
        mode,
        status: "ok".to_string(),
        synced_at: Some(chrono::Utc::now().timestamp_millis()),
        last_error: None,
        source_hash,
    }
}

/// Authorization for a deployment write: a `skill_targets` row claiming this
/// exact path lets us replace what it recorded, otherwise we may only write
/// where nothing of the user's would be destroyed (#363).
fn replace_policy(recorded_mode: Option<&str>) -> sync_engine::ReplacePolicy<'_> {
    match recorded_mode {
        Some(mode) => sync_engine::ReplacePolicy::Recorded { mode },
        None => sync_engine::ReplacePolicy::NoClobber,
    }
}

/// 因目标不属于本应用而被拒绝写入的单个路径。
///
/// 保留路径与原因的结构，CLI 才能准确指出冲突位置，而不是解析一段文案。
#[derive(Debug, Clone, Serialize)]
pub struct TargetConflict {
    pub target: PathBuf,
    pub reason: String,
}

impl fmt::Display for TargetConflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&sync_engine::refusal_message(&self.target, &self.reason))
    }
}

/// Sync every desired target, returning the ownership refusals rather than
/// failing on them.
///
/// Refusals are *reported*, not thrown, because whether one should abort the
/// operation depends entirely on the caller: a user typing `skills sync` needs
/// an error, while app startup must not be prevented from launching by a
/// name collision in an agent directory. Returning the list lets each caller
/// state that policy; an early `Err` here made startup panic (#363).
#[derive(Debug, Clone, Serialize)]
pub struct DeploymentTarget {
    pub skill_id: String,
    pub tool: String,
    pub target_path: String,
    pub outcome: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeploymentIssue {
    pub stage: &'static str,
    pub code: &'static str,
    pub tool: Option<String>,
    pub target_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeploymentReport {
    pub scope: &'static str,
    pub operation: &'static str,
    pub state: String,
    pub reason: Option<String>,
    pub total: Option<usize>,
    pub targets: Vec<DeploymentTarget>,
    pub issues: Vec<DeploymentIssue>,
}

impl DeploymentReport {
    pub fn not_run(reason: &str) -> Self {
        Self {
            scope: "global",
            operation: "sync",
            state: "not_run".into(),
            reason: Some(reason.into()),
            total: Some(0),
            targets: vec![],
            issues: vec![],
        }
    }
    pub fn unknown(error: impl fmt::Display) -> Self {
        Self {
            scope: "global",
            operation: "sync",
            state: "unknown".into(),
            reason: None,
            total: None,
            targets: vec![],
            issues: vec![DeploymentIssue {
                stage: "coordination",
                code: "RESULT_UNKNOWN",
                tool: None,
                target_path: None,
                message: error.to_string(),
            }],
        }
    }
    pub fn issue(
        &mut self,
        stage: &'static str,
        code: &'static str,
        tool: Option<&str>,
        path: Option<&str>,
        message: impl fmt::Display,
    ) {
        self.issues.push(DeploymentIssue {
            stage,
            code,
            tool: tool.map(str::to_string),
            target_path: path.map(str::to_string),
            message: message.to_string(),
        });
    }
    pub fn complete(&self) -> bool {
        self.state == "complete" || self.state == "not_run"
    }
    pub fn require_complete(&self) -> Result<(), AppError> {
        if self.complete() {
            return Ok(());
        }
        Err(AppError::deployment_incomplete(self.clone()))
    }
    fn finish(&mut self) {
        if self.total.is_none() || self.targets.iter().any(|t| t.outcome == "unconfirmed") {
            self.state = "unknown".into();
            return;
        }
        let completed = self
            .targets
            .iter()
            .filter(|t| matches!(t.outcome.as_str(), "committed" | "already_current"))
            .count();
        self.state = if completed == self.targets.len() && self.issues.is_empty() {
            "complete"
        } else if completed > 0 {
            "partial"
        } else {
            "failed"
        }
        .into();
    }
}

pub fn sync_desired_targets_report(
    store: &SkillStore,
    desired_targets: &[ScenarioSyncTarget],
) -> DeploymentReport {
    let _deployment = match store.deployment_lock("sync targets") {
        Ok(lock) => lock,
        Err(error) => return DeploymentReport::unknown(error),
    };
    let config = match store.tool_config() {
        Ok(config) => config,
        Err(error) => return DeploymentReport::unknown(error),
    };
    let adapters = tool_adapters::adapters_from_config(&config);
    let existing = match store.get_all_targets() {
        Ok(rows) => rows,
        Err(error) => return DeploymentReport::unknown(error),
    };
    if desired_targets.is_empty() {
        return DeploymentReport::not_run("empty");
    }
    let mut report = DeploymentReport::not_run("empty");
    report.reason = None;
    report.total = Some(desired_targets.len());
    let mut evidence = PathEvidence::new(&existing);
    for desired in desired_targets {
        let mut result = DeploymentTarget {
            skill_id: desired.skill_id.clone(),
            tool: desired.tool.clone(),
            target_path: desired.target.to_string_lossy().into_owned(),
            outcome: "not_attempted".into(),
            message: None,
        };
        let current = adapters.iter().find(|a| a.key == desired.tool);
        if config.disabled.contains(&desired.tool)
            || !current.is_some_and(|a| {
                a.is_installed()
                    && deployment_target(
                        a,
                        &sync_engine::target_dir_name(&desired.source, &desired.skill_name),
                        &desired.skill_id,
                        &existing,
                    ) == desired.target
            })
        {
            result.message = Some(
                "Agent identity, enabled state or path changed; refresh before retrying".into(),
            );
            report.targets.push(result);
            continue;
        }
        let old = existing
            .iter()
            .find(|t| t.skill_id == desired.skill_id && t.tool == desired.tool);
        let source_hash = match super::content_hash::hash_directory(&desired.source) {
            Ok(hash) => hash,
            Err(error) => {
                result.outcome = "failed".into();
                result.message = Some(error.to_string());
                report.targets.push(result);
                continue;
            }
        };
        if recorded_target_is_current(
            old.filter(|t| Path::new(&t.target_path) == desired.target),
            &desired.source,
            &desired.target,
            desired.mode,
            Some(&source_hash),
        ) {
            result.outcome = "already_current".into();
            report.targets.push(result);
            continue;
        }
        let step = deploy_step(
            evidence.judge(&desired.skill_id, &desired.tool, &desired.target),
            &desired.source,
            &desired.target,
        );
        let adopted = matches!(step, DeployStep::Adopt(_));
        let recorded_mode = match step {
            DeployStep::Adopt(mode) => Some(mode),
            DeployStep::Write(mode) => mode.filter(|_| {
                evidence.has_written(&desired.target)
                    || old.is_some_and(|t| {
                        Path::new(&t.target_path) == desired.target
                            && recorded_target_matches_source(t, &desired.source)
                    })
            }),
        };
        let deployed = if adopted {
            Ok(sync_engine::SyncMode::Copy)
        } else {
            sync_engine::sync_skill(
                &desired.source,
                &desired.target,
                desired.mode,
                replace_policy(recorded_mode.as_deref()),
            )
        };
        match deployed {
            Ok(mode) => {
                if !adopted {
                    evidence.wrote(&desired.skill_id, &desired.target, mode);
                }
                let row = adopted_target_record(
                    &desired.skill_id,
                    &desired.tool,
                    &desired.target,
                    mode.as_str().into(),
                    Some(source_hash),
                );
                match store.insert_target(&row) {
                    Ok(()) => {
                        result.outcome = "committed".into();
                        if let Some(old) =
                            old.filter(|t| Path::new(&t.target_path) != desired.target)
                        {
                            let legacy_shared = existing.iter().any(|t| {
                                t.tool == "kimi"
                                    && Path::new(&t.target_path)
                                        .parent()
                                        .is_some_and(|p| p.ends_with(".config/agents/skills"))
                                    && entry_identity(Path::new(&t.target_path)).ok()
                                        == entry_identity(Path::new(&old.target_path)).ok()
                            });
                            match if legacy_shared {
                                Ok("shared".to_string())
                            } else {
                                preserve_or_remove_target(store, old, true)
                            } {
                                Ok(reason) if reason == "shared" => {
                                    result.message = Some(format!(
                                        "Old shared target preserved: {}",
                                        old.target_path
                                    ))
                                }
                                Ok(reason)
                                    if reason != "removed"
                                        && reason != "absent"
                                        && reason != "kept_copy" =>
                                {
                                    report.issue(
                                        "retire_old_target",
                                        "TARGET_PRESERVED",
                                        Some(&old.tool),
                                        Some(&old.target_path),
                                        reason,
                                    )
                                }
                                Err(error) => report.issue(
                                    "retire_old_target",
                                    "CLEANUP_FAILED",
                                    Some(&old.tool),
                                    Some(&old.target_path),
                                    error,
                                ),
                                _ => {}
                            }
                        }
                    }
                    Err(error) => {
                        result.outcome = "unconfirmed".into();
                        result.message = Some(format!(
                            "Files may have changed; target record not confirmed: {error}"
                        ));
                    }
                }
            }
            Err(error) => {
                result.outcome = if error.is::<sync_engine::ReplaceRefused>() {
                    "refused"
                } else {
                    "failed"
                }
                .into();
                result.message = Some(error.to_string());
            }
        }
        report.targets.push(result);
    }
    report.finish();
    report
}

pub fn sync_desired_targets(
    store: &SkillStore,
    targets: &[ScenarioSyncTarget],
) -> Result<Vec<TargetConflict>, AppError> {
    let report = sync_desired_targets_report(store, targets);
    if report.targets.iter().all(|t| {
        matches!(
            t.outcome.as_str(),
            "committed" | "already_current" | "refused"
        )
    }) && report.issues.is_empty()
    {
        return Ok(report
            .targets
            .into_iter()
            .filter(|t| t.outcome == "refused")
            .map(|t| TargetConflict {
                target: PathBuf::from(t.target_path),
                reason: t.message.unwrap_or_default(),
            })
            .collect());
    }
    report.require_complete()?;
    Ok(vec![])
}

pub fn entry_identity(path: &Path) -> Result<PathBuf, AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::invalid_input("Unknown target parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| AppError::invalid_input("Unknown target name"))?;
    let identity = parent.canonicalize().map_err(AppError::io)?.join(name);
    #[cfg(any(target_os = "macos", windows))]
    let identity = PathBuf::from(identity.to_string_lossy().to_lowercase());
    Ok(identity)
}

pub fn recorded_target_matches_source(target: &SkillTargetRecord, source: &Path) -> bool {
    let path = Path::new(&target.target_path);
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    match target.mode.as_str() {
        "symlink" => {
            metadata.file_type().is_symlink() && sync_engine::symlink_points_to(path, source)
        }
        "copy" => {
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && target.source_hash.as_ref().is_some_and(|hash| {
                    super::content_hash::hash_directory(path).is_ok_and(|actual| &actual == hash)
                })
        }
        _ => false,
    }
}

/// Return a preservation reason without discarding the row on I/O failure.
pub fn preserve_or_remove_target(
    store: &SkillStore,
    target: &SkillTargetRecord,
    keep_copy: bool,
) -> Result<String, AppError> {
    let path = Path::new(&target.target_path);
    let all = store.get_all_targets().map_err(AppError::db)?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("absent".into()),
        Err(error) => return Err(AppError::io(error)),
    };
    let identity = match entry_identity(path) {
        Ok(key) => key,
        Err(_) => return Ok("unknown_identity".into()),
    };
    for other in all.iter().filter(|other| other.id != target.id) {
        match entry_identity(Path::new(&other.target_path)) {
            Ok(other) if other == identity => return Ok("shared".into()),
            Err(_) => return Ok("unknown_references".into()),
            _ => {}
        }
    }
    let source = store
        .get_skill_by_id(&target.skill_id)
        .map_err(AppError::db)?;
    let Some(source) = source else {
        return Ok("unknown_source".into());
    };
    let owned = match target.mode.as_str() {
        "symlink" => {
            metadata.file_type().is_symlink()
                && sync_engine::symlink_points_to(path, Path::new(&source.central_path))
        }
        "copy" => {
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && target.source_hash.as_ref().is_some_and(|hash| {
                    super::content_hash::hash_directory(path).is_ok_and(|actual| &actual == hash)
                })
        }
        _ => false,
    };
    if !owned {
        return Ok("foreign_or_unconfirmed".into());
    }
    if keep_copy && target.mode == "copy" {
        let kept = move_into_kept_copies(path, &target.tool).map_err(AppError::io)?;
        log::warn!("旧部署副本已保留到 {}", kept.display());
        return Ok("kept_copy".into());
    }
    sync_engine::remove_recorded_target(path, &target.mode).map_err(AppError::io)?;
    Ok("removed".into())
}

pub fn remove_targets(
    store: &SkillStore,
    targets: &[SkillTargetRecord],
) -> Result<DeploymentReport, AppError> {
    let _deployment = store.deployment_lock("remove targets")?;
    store.tool_config()?;
    // Inspect and act before revoking any claims, so contradictory/shared rows
    // in this same batch remain protection evidence throughout the file phase.
    let outcomes = targets
        .iter()
        .map(|target| preserve_or_remove_target(store, target, false))
        .collect::<Vec<_>>();
    let mut report = DeploymentReport::not_run("empty");
    report.operation = "remove";
    for (target, outcome) in targets.iter().zip(outcomes) {
        let (status, message) = match outcome {
            Ok(reason) => match store.delete_target(&target.skill_id, &target.tool) {
                Ok(()) => ("committed", Some(reason)),
                Err(error) => ("unconfirmed", Some(error.to_string())),
            },
            Err(error) => ("failed", Some(error.to_string())),
        };
        report.targets.push(DeploymentTarget {
            skill_id: target.skill_id.clone(),
            tool: target.tool.clone(),
            target_path: target.target_path.clone(),
            outcome: status.into(),
            message,
        });
    }
    if !report.targets.is_empty() {
        report.total = Some(report.targets.len());
        report.reason = None;
        report.finish();
    }
    Ok(report)
}

pub fn remove_tool_targets(store: &SkillStore, tool: &str) -> Result<DeploymentReport, AppError> {
    let _deployment = store.deployment_lock("remove Agent targets")?;
    let targets = store
        .get_all_targets()
        .map_err(AppError::db)?
        .into_iter()
        .filter(|t| t.tool == tool)
        .collect::<Vec<_>>();
    remove_targets(store, &targets)
}

/// Preview the ownership decisions made by `sync_desired_targets` without changing targets.
pub fn preflight_scenario_sync_targets(
    store: &SkillStore,
    desired_targets: &[ScenarioSyncTarget],
) -> Result<(), AppError> {
    let mut evidence = PathEvidence::new(&store.get_all_targets().map_err(AppError::db)?);
    let mut conflicts = Vec::new();
    for desired in desired_targets {
        // The real run will find another skill's deployment here even though
        // the disk does not show it yet.
        if evidence.written_by_other_skill(&desired.skill_id, &desired.target) {
            conflicts.push(TargetConflictDetail {
                path: desired.target.display().to_string(),
                reason: sync_engine::ReplacePolicy::NoClobber.describe().to_string(),
            });
            continue;
        }
        let recorded_mode = match deploy_step(
            evidence.judge(&desired.skill_id, &desired.tool, &desired.target),
            &desired.source,
            &desired.target,
        ) {
            DeployStep::Write(mode) => mode,
            DeployStep::Adopt(_) => continue,
        };
        match sync_engine::preflight_replace(
            &desired.source,
            &desired.target,
            desired.mode,
            replace_policy(recorded_mode.as_deref()),
        ) {
            Ok(()) => evidence.wrote(&desired.skill_id, &desired.target, desired.mode),
            Err(error) => match error.downcast_ref::<sync_engine::ReplaceRefused>() {
                Some(refused) => conflicts.push(TargetConflictDetail {
                    path: refused.target.display().to_string(),
                    reason: refused.reason.to_string(),
                }),
                None => return Err(AppError::io(error)),
            },
        }
    }
    if conflicts.is_empty() {
        Ok(())
    } else {
        Err(AppError::target_conflict(
            format!(
                "Refusing to sync: {} target(s) would overwrite content that is not ours. Nothing was changed.",
                conflicts.len()
            ),
            conflicts,
        ))
    }
}

/// Turn reported refusals into the error a user-initiated command should show.
/// Deliberately says only that these targets were skipped — everything else in
/// the operation did apply, so claiming "nothing happened" would be false.
pub fn refusals_to_error(refusals: Vec<TargetConflict>) -> Result<(), AppError> {
    if refusals.is_empty() {
        return Ok(());
    }
    let summary = format!(
        "有 {} 个 Skill 因目标路径不属于 Agent 技能管家而跳过；这些路径中的内容保持不变，\
         其余操作已完成。{}",
        refusals.len(),
        refusals
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("；")
    );
    Err(AppError::target_conflict(
        summary,
        refusals
            .into_iter()
            .map(|conflict| TargetConflictDetail {
                path: conflict.target.display().to_string(),
                reason: conflict.reason,
            })
            .collect(),
    ))
}

pub fn unsync_obsolete_scenario_targets(
    store: &SkillStore,
    old_scenario_id: &str,
    desired_targets: &[ScenarioSyncTarget],
) -> Result<(), AppError> {
    let _deployment = store.deployment_lock("remove obsolete targets")?;
    let ids = store
        .get_skill_ids_for_scenario(old_scenario_id)
        .map_err(AppError::db)?;
    let targets = store
        .get_all_targets()
        .map_err(AppError::db)?
        .into_iter()
        .filter(|target| {
            ids.contains(&target.skill_id)
                && !desired_targets.iter().any(|desired| {
                    desired.skill_id == target.skill_id
                        && desired.tool == target.tool
                        && desired.target == Path::new(&target.target_path)
                })
        })
        .collect::<Vec<_>>();
    remove_targets(store, &targets)?.require_complete()
}

pub fn unsync_scenario_skills(store: &SkillStore, scenario_id: &str) -> Result<(), AppError> {
    let _deployment = store.deployment_lock("remove Preset targets")?;
    let ids = store
        .get_skill_ids_for_scenario(scenario_id)
        .map_err(AppError::db)?;
    let targets = store
        .get_all_targets()
        .map_err(AppError::db)?
        .into_iter()
        .filter(|target| ids.contains(&target.skill_id))
        .collect::<Vec<_>>();
    remove_targets(store, &targets)?.require_complete()
}

pub fn sync_scenario_skills(
    store: &SkillStore,
    scenario_id: &str,
) -> Result<Vec<TargetConflict>, AppError> {
    let _deployment = store.deployment_lock("sync_scenario_skills")?;
    let desired_targets = collect_scenario_sync_targets(store, scenario_id)?;
    sync_desired_targets_report(store, &desired_targets).require_complete()?;
    Ok(vec![])
}

pub fn apply_scenario_to_default(
    store: &SkillStore,
    scenario_id: &str,
) -> Result<Vec<TargetConflict>, AppError> {
    let _deployment = store.deployment_lock("apply_scenario_to_default")?;
    ensure_scenario_exists(store, scenario_id)?;
    let desired_targets = collect_scenario_sync_targets(store, scenario_id)?;

    if let Some(old_id) = store.get_active_scenario_id().map_err(AppError::db)? {
        if old_id != scenario_id {
            unsync_obsolete_scenario_targets(store, &old_id, &desired_targets)?;
        }
    }

    store
        .set_active_scenario(scenario_id)
        .map_err(AppError::db)?;
    sync_desired_targets_report(store, &desired_targets).require_complete()?;
    Ok(vec![])
}

pub fn sync_skill_to_active_scenario(
    store: &SkillStore,
    scenario_id: &str,
    skill_id: &str,
) -> Result<(), AppError> {
    let _deployment = store.deployment_lock("sync active skill")?;
    if store
        .get_active_scenario_id()
        .map_err(AppError::db)?
        .as_deref()
        != Some(scenario_id)
    {
        return Ok(());
    }
    let targets = collect_scenario_sync_targets(store, scenario_id)?
        .into_iter()
        .filter(|t| t.skill_id == skill_id)
        .collect::<Vec<_>>();
    sync_desired_targets_report(store, &targets).require_complete()
}

pub fn ensure_default_startup_scenario(store: &SkillStore) -> Result<(), AppError> {
    let mut scenarios = store.get_all_scenarios().map_err(AppError::db)?;
    if scenarios.is_empty() {
        let now = chrono::Utc::now().timestamp_millis();
        let default_scenario = ScenarioRecord {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Default".to_string(),
            description: Some("Default startup scenario".to_string()),
            icon: None,
            sort_order: 0,
            created_at: now,
            updated_at: now,
        };
        store
            .insert_scenario(&default_scenario)
            .map_err(AppError::db)?;
        scenarios.push(default_scenario);
    }

    // Startup restores whatever preset was last active; there is no separate
    // "default startup preset" setting to override it.
    let current_active = store.get_active_scenario_id().map_err(AppError::db)?;

    let desired_active = current_active
        .clone()
        .filter(|id| scenarios.iter().any(|scenario| scenario.id == *id))
        .unwrap_or_else(|| scenarios[0].id.clone());

    if current_active.as_deref() != Some(desired_active.as_str()) {
        if let Some(old_active) = current_active.as_deref() {
            unsync_scenario_skills(store, old_active)?;
        }
        store
            .set_active_scenario(&desired_active)
            .map_err(AppError::db)?;
    }

    // Startup policy: a collision must never stop the app from launching. The
    // colliding skill simply is not deployed, its content is untouched, and the
    // workspace view shows it as not synced.
    let desired = collect_scenario_sync_targets(store, &desired_active)?;
    let report = sync_desired_targets_report(store, &desired);
    if !report.complete() {
        log::warn!("Startup deployment incomplete: {:?}", report);
    }
    Ok(())
}

pub fn ensure_cli_scenario_state(store: &SkillStore) -> Result<(), AppError> {
    let mut scenarios = store.get_all_scenarios().map_err(AppError::db)?;
    if scenarios.is_empty() {
        let now = chrono::Utc::now().timestamp_millis();
        let default_scenario = ScenarioRecord {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Default".to_string(),
            description: Some("Default startup scenario".to_string()),
            icon: None,
            sort_order: 0,
            created_at: now,
            updated_at: now,
        };
        store
            .insert_scenario(&default_scenario)
            .map_err(AppError::db)?;
        scenarios.push(default_scenario);
    }

    let current_active = store.get_active_scenario_id().map_err(AppError::db)?;
    if current_active
        .as_deref()
        .is_some_and(|id| scenarios.iter().any(|scenario| scenario.id == id))
    {
        return Ok(());
    }

    store
        .set_active_scenario(&scenarios[0].id)
        .map_err(AppError::db)
}

pub fn restore_all_skills_sync_included(store: &SkillStore) -> Result<bool, AppError> {
    let mut changed = false;
    for skill in store.get_all_skills().map_err(AppError::db)? {
        if !skill.enabled {
            store
                .update_skill_enabled(&skill.id, true)
                .map_err(AppError::db)?;
            changed = true;
        }
    }
    Ok(changed)
}

pub fn sync_active_scenario_to_tool_report(store: &SkillStore, tool_key: &str) -> DeploymentReport {
    let work = || -> Result<DeploymentReport, AppError> {
        let _deployment = store.deployment_lock("register Agent coordination")?;
        let config = store.tool_config()?;
        if config.disabled.iter().any(|key| key == tool_key) {
            return Ok(DeploymentReport::not_run("disabled"));
        }
        let Some(active) = store.get_active_scenario_id().map_err(AppError::db)? else {
            return Ok(DeploymentReport::not_run("no_active_preset"));
        };
        let targets = collect_scenario_sync_targets(store, &active)?;
        if targets.is_empty() {
            return Ok(DeploymentReport::not_run("empty"));
        }
        let selected: HashSet<_> = targets
            .iter()
            .filter(|t| t.tool == tool_key)
            .map(|t| t.skill_id.clone())
            .collect();
        if selected.is_empty() {
            return Ok(DeploymentReport::not_run("not_selected"));
        }
        let targets = targets
            .into_iter()
            .filter(|t| selected.contains(&t.skill_id))
            .collect::<Vec<_>>();
        Ok(sync_desired_targets_report(store, &targets))
    };
    work().unwrap_or_else(DeploymentReport::unknown)
}

pub fn sync_active_scenario_to_tool(store: &SkillStore, tool_key: &str) -> Result<(), AppError> {
    sync_active_scenario_to_tool_report(store, tool_key).require_complete()
}

/// Why a caller is writing to an agent's skills directory.
///
/// Adoption and stranded-target repair legitimately write over an existing
/// real directory that has no `skill_targets` row — that directory is the very
/// thing the user asked us to take over. Ordinary deployment must never do
/// that, so the two intents cannot share a code path (#363).
#[derive(Debug, Clone, Copy)]
pub enum DeployIntent<'a> {
    /// Ordinary deployment: replace only what our own records vouch for.
    Managed,
    /// The user explicitly asked us to take over this scanned skill path.
    AdoptExisting(&'a Path),
}

/// Re-point every `source_ref` that names `target` at the referring skill's own
/// central copy, ahead of an adoption that replaces `target` with a managed
/// deployment (#425).
///
/// An adopted directory stops being an independent copy the moment the
/// adoption runs: it becomes a link to (or copy of) central that can be
/// removed at any time — by the agent's own skill management cleaning up what
/// it does not recognize, or by a later undeploy. A skill whose `source_ref`
/// still names that directory then fails its update check with
/// `source_missing` forever, even though the central copy is intact.
///
/// The central copy always exists while the skill row does, so re-pointing
/// keeps the source resolvable; the content-hash comparison against it keeps
/// reporting `up_to_date`. Matching is by exact string or canonicalized path,
/// because import records can spell the same directory with mixed separators
/// than the deployment target computed from the adapter.
pub(crate) fn detach_source_refs_from_adoption_target(
    store: &SkillStore,
    target: &Path,
) -> Result<(), AppError> {
    let target_str = target.to_string_lossy().into_owned();
    // `canonicalize` resolves through symlinks, but a symlinked target is only
    // unlinked by the replacement below (`remove_classified_target` treats
    // LinkToSource/ForeignLink as `remove_link`) -- whatever it pointed at
    // survives untouched. Resolving through the link would re-point the
    // source_ref of a directory that is still on disk and still the user's
    // source of truth, and the update check would then compare central to
    // itself forever. An exact string match still applies: if the source_ref
    // *is* the link path, that link really is going away.
    let target_canonical = if std::fs::symlink_metadata(target)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        None
    } else {
        std::fs::canonicalize(target).ok()
    };
    for skill in store.get_all_skills().map_err(AppError::db)? {
        let Some(source_ref) = skill.source_ref.as_deref() else {
            continue;
        };
        // Already re-pointed by a previous adoption — nothing to do.
        if source_ref == skill.central_path {
            continue;
        }
        let points_at_target = source_ref == target_str
            || target_canonical.as_ref().is_some_and(|canonical| {
                std::fs::canonicalize(source_ref).is_ok_and(|source| &source == canonical)
            });
        if points_at_target {
            store
                .update_skill_source_ref(&skill.id, &skill.central_path)
                .map_err(AppError::db)?;
            log::info!(
                "adoption: re-pointed source_ref of skill '{}' at its central copy; \
                 the adopted agent directory is now a deployment, not a source (#425)",
                skill.name
            );
        }
    }
    Ok(())
}

pub fn sync_single_skill_to_tool(
    store: &SkillStore,
    skill_id: &str,
    tool: &str,
    intent: DeployIntent<'_>,
) -> Result<(), AppError> {
    let _deployment = store.deployment_lock("sync_single_skill_to_tool")?;
    let adapter = tool_adapters::find_adapter_with_store(store, tool)?
        .ok_or_else(|| AppError::not_found(format!("Unknown tool: {}", tool)))?;

    if !adapter.is_installed() {
        return Err(AppError::not_found(format!(
            "{} is not installed",
            adapter.display_name
        )));
    }

    if tool_service::get_disabled_tools(store)?.contains(&tool.to_string()) {
        return Err(AppError::invalid_input(format!(
            "{} is disabled",
            adapter.display_name
        )));
    }

    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;

    let source = PathBuf::from(&skill.central_path);
    let existing_targets = store.get_targets_for_skill(skill_id).unwrap_or_default();
    let target = match intent {
        DeployIntent::AdoptExisting(path) => {
            let root = adapter.skills_dir();
            if !is_skill_path_within_root(path, &root) {
                return Err(AppError::invalid_input(
                    "Skill path is outside the agent skills directory",
                ));
            }
            path.to_path_buf()
        }
        DeployIntent::Managed => deployment_target(
            &adapter,
            &sync_engine::target_dir_name(&source, &skill.name),
            skill_id,
            &existing_targets,
        ),
    };
    let configured_mode = store.get_setting("sync_mode").map_err(AppError::db)?;
    let mode = sync_engine::sync_mode_for_tool(tool, configured_mode.as_deref());
    if matches!(intent, DeployIntent::Managed) {
        return sync_desired_targets_report(
            store,
            &[ScenarioSyncTarget {
                skill_id: skill_id.into(),
                skill_name: skill.name.clone(),
                tool: tool.into(),
                source,
                target,
                mode,
                source_hash: skill.content_hash.clone(),
            }],
        )
        .require_complete();
    }
    detach_source_refs_from_adoption_target(store, &target)?;
    let policy = sync_engine::ReplacePolicy::UserConfirmed;
    let actual_mode =
        sync_engine::sync_skill(&source, &target, mode, policy).map_err(AppError::io)?;

    let now = chrono::Utc::now().timestamp_millis();
    let target_record = SkillTargetRecord {
        id: uuid::Uuid::new_v4().to_string(),
        skill_id: skill_id.to_string(),
        tool: tool.to_string(),
        target_path: target.to_string_lossy().to_string(),
        mode: actual_mode.as_str().to_string(),
        status: "ok".to_string(),
        synced_at: Some(now),
        last_error: None,
        source_hash: skill.content_hash.clone(),
    };

    store.insert_target(&target_record).map_err(AppError::db)?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub enum BatchApplyMode {
    Add,
    Remove,
}

/// Record a deploy or removal of `skill_ids × tool_keys` in the active
/// preset's per-agent toggles, which the startup sync deploys from. Skills
/// outside the active preset are skipped; the active preset never changes.
/// Every launch reindexes the toggles from the sync metadata, so each changed
/// member's file is rewritten as well (#549).
pub fn set_active_preset_tool_toggles(
    store: &SkillStore,
    skill_ids: &[String],
    tool_keys: &[String],
    enabled: bool,
) -> Result<(), AppError> {
    let Ok(Some(active_id)) = store.get_active_scenario_id() else {
        return Ok(());
    };
    let members = store
        .get_skill_ids_for_scenario(&active_id)
        .map_err(AppError::db)?;
    let skill_ids: Vec<&String> = skill_ids.iter().filter(|id| members.contains(id)).collect();
    if skill_ids.is_empty() || tool_keys.is_empty() {
        return Ok(());
    }
    let adapter_keys: Vec<String> = tool_adapters::enabled_installed_adapters(store)?
        .iter()
        .map(|a| a.key.clone())
        .collect();
    sync_metadata::with_repo_lock("set skill tool toggle", || {
        for skill_id in skill_ids {
            store.ensure_scenario_skill_tool_defaults(&active_id, skill_id, &adapter_keys)?;
            for tool in tool_keys {
                store.set_scenario_skill_tool_enabled(&active_id, skill_id, tool, enabled)?;
            }
            sync_metadata::write_scenario_skill_unlocked(store, &active_id, skill_id)?;
        }
        Ok(())
    })
    .map_err(AppError::db)
}

/// Apply a batch of `(skill_id × tool_key)` pairs in either Add or Remove mode
/// without changing `active_scenario_id`.
///
/// This is the tray-side preset apply primitive, also behind the CLI's
/// `presets deploy/undeploy` and `skills deploy/undeploy`. It also turns the
/// pairs on (Add) or off (Remove) in the active preset's toggles, for skills
/// in that preset. The startup sync deploys the active preset from those
/// toggles: one left on brought a removed skill back at the next launch, and
/// one left off kept a deployed skill out of the preview and out of the
/// startup repair (#549). The toggles go first, so a busy repo lock fails the
/// batch before any file changes, and a pair that then fails to deploy is
/// retried by the startup sync.
///
/// Remove mode handles shared physical paths: a `target_path` may be referenced
/// by multiple `(skill_id, tool)` records when several tools resolve to the same
/// skills directory. The filesystem path is only removed when no remaining
/// `skill_targets` row references it after the batch deletions, so removing one
/// preset's tools never wipes another tool's still-active files.
pub fn apply_skills_to_tools(
    store: &SkillStore,
    skill_ids: &[String],
    tool_keys: &[String],
    mode: BatchApplyMode,
) -> Result<(), AppError> {
    let _deployment = store.deployment_lock("apply_skills_to_tools")?;
    if skill_ids.is_empty() || tool_keys.is_empty() {
        return Ok(());
    }

    let add = matches!(mode, BatchApplyMode::Add);
    set_active_preset_tool_toggles(store, skill_ids, tool_keys, add)?;
    match mode {
        BatchApplyMode::Add => apply_add(store, skill_ids, tool_keys, false),
        BatchApplyMode::Remove => apply_remove(store, skill_ids, tool_keys),
    }
}

/// Check the same targets and ownership rules as batch deployment without writing.
pub fn preflight_add_skills_to_tools(
    store: &SkillStore,
    skill_ids: &[String],
    tool_keys: &[String],
) -> Result<(), AppError> {
    if skill_ids.is_empty() || tool_keys.is_empty() {
        return Ok(());
    }
    apply_add(store, skill_ids, tool_keys, true)
}

fn apply_add(
    store: &SkillStore,
    skill_ids: &[String],
    tool_keys: &[String],
    preflight_only: bool,
) -> Result<(), AppError> {
    let configured_mode = store.get_setting("sync_mode").map_err(AppError::db)?;
    let disabled = tool_service::get_disabled_tools(store)?;

    let mut adapters: HashMap<String, tool_adapters::ToolAdapter> = HashMap::new();
    for key in tool_keys {
        if disabled.contains(key) {
            log::debug!("apply_skills_to_tools: skipping disabled tool {key}");
            continue;
        }
        let Some(adapter) = tool_adapters::find_adapter_with_store(store, key)? else {
            log::warn!("apply_skills_to_tools: unknown tool {key}");
            continue;
        };
        if !adapter.is_installed() {
            log::debug!(
                "apply_skills_to_tools: skipping uninstalled tool {} ({key})",
                adapter.display_name
            );
            continue;
        }
        adapters.insert(key.clone(), adapter);
    }

    // Plan every pair up front, then refuse the whole batch if any one of them
    // would destroy something (#363, expectation 4). Not a rollback — a
    // finished copy cannot be undone — but nothing is written until every pair
    // has been judged.
    struct PlannedPair {
        skill: crate::core::skill_store::SkillRecord,
        tool_key: String,
        source: PathBuf,
        target: PathBuf,
        mode: sync_engine::SyncMode,
    }

    let existing_targets = store.get_all_targets().map_err(AppError::db)?;
    let mut plan: Vec<PlannedPair> = Vec::new();
    for skill_id in skill_ids {
        let skill = store
            .get_skill_by_id(skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found(format!("Skill not found: {skill_id}")))?;
        let source = PathBuf::from(&skill.central_path);
        let target_name = sync_engine::target_dir_name(&source, &skill.name);
        for (tool_key, adapter) in &adapters {
            plan.push(PlannedPair {
                skill: skill.clone(),
                tool_key: tool_key.clone(),
                mode: sync_engine::sync_mode_for_tool(tool_key, configured_mode.as_deref()),
                source: source.clone(),
                target: deployment_target(adapter, &target_name, skill_id, &existing_targets),
            });
        }
    }

    // Two skills whose central directories share a basename resolve to the
    // same deployment path (`target_dir_name` uses the basename only), so the
    // second would silently overwrite the first. Neither is the user's data,
    // but the result is a target whose contents don't match its record.
    // 两个库内 Skill 规划到同一路径属于命名冲突，不应被误报为用户目录所有权冲突。
    let mut duplicate_targets: Vec<String> = Vec::new();
    let mut conflicts: Vec<TargetConflictDetail> = Vec::new();
    let mut probe_errors: Vec<String> = Vec::new();
    // Keyed on skill id, not name: names are not unique, and two distinct
    // skills that happen to share one would otherwise slip through as "the
    // same skill" and silently overwrite each other.
    let mut planned_paths: HashMap<&Path, (&str, &str)> = HashMap::new();
    for pair in &plan {
        let entry = (pair.skill.id.as_str(), pair.skill.name.as_str());
        if let Some((first_id, first_name)) = planned_paths.insert(pair.target.as_path(), entry) {
            if first_id != pair.skill.id {
                duplicate_targets.push(format!(
                    "{} — skills \"{}\" and \"{}\" both deploy here",
                    pair.target.display(),
                    first_name,
                    pair.skill.name
                ));
            }
        }
    }
    if !duplicate_targets.is_empty() {
        return Err(AppError::invalid_input(format!(
            "拒绝部署：有 {} 个目标路径同时被两个不同的 Skill 占用，未写入任何内容。{}",
            duplicate_targets.len(),
            duplicate_targets.join("；")
        )));
    }
    // Ownership belongs to the path, not to the (skill, tool) pair. When two
    // agents share a skills directory, a row for either one vouches for the
    // object there, so evidence is pooled per path before judging — otherwise
    // the pair without its own row would refuse a target we demonstrably own.
    // Pool the distinct recorded modes per path, then keep the evidence only
    // when they agree. Contradictory rows must refuse, exactly as in the
    // removal path — taking whichever one came first would let a stale `copy`
    // row authorize deleting a real directory, and HashMap order is not even
    // deterministic about which one that is.
    // Pooled from every existing row that lands on a planned path, not just
    // from the pairs in this batch: `skill_targets` is unique on
    // `(skill_id, tool)`, not on `target_path`, so a row we did not select can
    // still be a claim on the same object — and a contradictory one.
    // Keyed by directory entry rather than by path string, so a row spelled
    // differently (symlinked ancestor, `..`) but naming the same object still
    // counts as evidence about it.
    let mut key_memo: HashMap<PathBuf, PathBuf> = HashMap::new();
    let planned_keys: HashSet<PathBuf> = plan
        .iter()
        .map(|pair| ownership_key(&pair.target, &mut key_memo))
        .collect();
    let mut modes_by_key: HashMap<PathBuf, HashSet<&str>> = HashMap::new();
    for row in &existing_targets {
        let key = ownership_key(Path::new(row.target_path.as_str()), &mut key_memo);
        if planned_keys.contains(&key) {
            modes_by_key
                .entry(key)
                .or_default()
                .insert(row.mode.as_str());
        }
    }

    // Shared skills directories: a row of another agent on the same path
    // vouches for it, see `PathEvidence`.
    let mut evidence = PathEvidence::new(&existing_targets);
    let mut preflighted: HashSet<&Path> = HashSet::new();
    for pair in &plan {
        if !preflighted.insert(pair.target.as_path()) {
            continue;
        }
        if let Err(e) = sync_engine::preflight_replace(
            &pair.source,
            &pair.target,
            pair.mode,
            replace_policy(
                evidence
                    .judge(&pair.skill.id, &pair.tool_key, &pair.target)
                    .any_mode(),
            ),
        ) {
            match e.downcast_ref::<sync_engine::ReplaceRefused>() {
                Some(refused) => conflicts.push(TargetConflictDetail {
                    path: refused.target.display().to_string(),
                    reason: refused.reason.to_string(),
                }),
                None => probe_errors.push(format!("{}：{e}", pair.target.display())),
            }
        }
    }
    if !probe_errors.is_empty() {
        return Err(AppError::io(format!(
            "拒绝部署：有 {} 个目标无法检查，未写入任何内容。{}",
            probe_errors.len(),
            probe_errors.join("；")
        )));
    }
    if !conflicts.is_empty() {
        let summary = format!(
            "拒绝部署：{} / {} 个目标会覆盖不属于 Agent 技能管家的内容，未写入任何内容。{}",
            conflicts.len(),
            plan.len(),
            conflicts
                .iter()
                .map(|conflict| sync_engine::refusal_message(
                    Path::new(&conflict.path),
                    &conflict.reason
                ))
                .collect::<Vec<_>>()
                .join("；")
        );
        return Err(AppError::target_conflict(summary, conflicts));
    }

    if preflight_only {
        return Ok(());
    }

    let desired = plan
        .into_iter()
        .map(|pair| ScenarioSyncTarget {
            skill_id: pair.skill.id,
            skill_name: pair.skill.name,
            tool: pair.tool_key,
            source: pair.source,
            target: pair.target,
            mode: pair.mode,
            source_hash: pair.skill.content_hash,
        })
        .collect::<Vec<_>>();
    sync_desired_targets_report(store, &desired).require_complete()
}

fn apply_remove(
    store: &SkillStore,
    skill_ids: &[String],
    tool_keys: &[String],
) -> Result<(), AppError> {
    let targets = store
        .get_all_targets()
        .map_err(AppError::db)?
        .into_iter()
        .filter(|t| skill_ids.contains(&t.skill_id) && tool_keys.contains(&t.tool))
        .collect::<Vec<_>>();
    remove_targets(store, &targets)?.require_complete()
}

#[cfg(test)]
mod sync_desired_targets_tests {
    use super::*;
    use crate::core::central_repo;
    use crate::core::skill_store::{ScenarioRecord, SkillRecord, SkillStore, SkillTargetRecord};
    use crate::core::tool_adapters::CustomToolDef;
    use std::fs;
    use tempfile::tempdir;

    /// Two adapters can point at the same skills directory — `amp` and
    /// `replit` both deploy to `~/.config/agents/skills`, and `kimi` did too
    /// until it moved to `~/.kimi-code/skills` (#270). When one of them is
    /// retargeted, its stale record must be dropped, but the directory the
    /// others are still deployed to must survive: it is their live
    /// deployment, not this tool's leftover.
    #[test]
    fn retargeting_one_tool_keeps_a_directory_another_tool_still_claims() {
        let _lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("repo");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&base.join("test.db")).unwrap();

        let source = central_repo::skills_dir().join("skill-a");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "real source").unwrap();

        // The shared deployment both tools were synced to.
        let shared = tmp.path().join("shared-agents").join("skill-a");
        fs::create_dir_all(&shared).unwrap();
        fs::write(shared.join("SKILL.md"), "real source").unwrap();

        // Where the retargeted tool is moving to.
        let moved = tmp.path().join("kimi-code").join("skill-a");
        store
            .set_setting(
                "custom_tool_paths",
                &serde_json::json!({
                    "amp": shared.parent().unwrap(),
                    "kimi": moved.parent().unwrap(),
                })
                .to_string(),
            )
            .unwrap();

        let skill = SkillRecord {
            id: "skill-a".to_string(),
            name: "skill-a".to_string(),
            description: None,
            source_type: "import".to_string(),
            source_ref: Some(source.to_string_lossy().to_string()),
            source_ref_resolved: None,
            source_subpath: None,
            source_branch: None,
            source_revision: None,
            remote_revision: None,
            central_path: source.to_string_lossy().to_string(),
            content_hash: Some("h1".to_string()),
            enabled: true,
            created_at: 1,
            updated_at: 1,
            status: "ok".to_string(),
            update_status: "local_only".to_string(),
            last_checked_at: None,
            last_check_error: None,
        };
        store.insert_skill(&skill).unwrap();

        for (id, tool) in [("target-amp", "amp"), ("target-kimi", "kimi")] {
            store
                .insert_target(&SkillTargetRecord {
                    id: id.to_string(),
                    skill_id: "skill-a".to_string(),
                    tool: tool.to_string(),
                    target_path: shared.to_string_lossy().to_string(),
                    mode: "copy".to_string(),
                    status: "ok".to_string(),
                    synced_at: Some(1),
                    last_error: None,
                    source_hash: Some("h1".to_string()),
                })
                .unwrap();
        }

        // Adapter order puts amp before kimi, so amp is skipped as current
        // before kimi reaches its retarget branch.
        let desired = vec![
            ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "amp".to_string(),
                source: source.clone(),
                target: shared.clone(),
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            },
            ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "kimi".to_string(),
                source: source.clone(),
                target: moved.clone(),
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            },
        ];

        sync_desired_targets(&store, &desired).unwrap();

        assert!(
            shared.join("SKILL.md").exists(),
            "amp's live deployment was deleted while retargeting kimi"
        );
        assert!(
            moved.join("SKILL.md").exists(),
            "kimi was not deployed to its new path"
        );

        central_repo::set_test_base_dir_override(None);
    }

    /// Kept copies land under `kept-copies/`, whatever the tool key looks
    /// like, and never on top of an earlier one, dangling links included.
    #[test]
    fn kept_copies_stay_inside_kept_copies_and_never_collide() {
        let _lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let library = tmp.path().join("library");
        central_repo::set_test_base_dir_override(Some(library.clone()));
        let make_copy = |dir: &str| {
            let path = tmp.path().join(dir).join("skill-a");
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("notes.md"), dir).unwrap();
            path
        };

        // A CLI-created key with path syntax in it.
        let first = make_copy("agent-1");
        move_into_kept_copies(&first, "../skills").unwrap();
        let kept_root = library.join("kept-copies").join("___skills");
        assert_eq!(
            fs::read_to_string(kept_root.join("skill-a/notes.md")).unwrap(),
            "agent-1"
        );
        assert!(!library.join("skills").exists(), "escaped kept-copies/");

        #[cfg(unix)]
        std::os::unix::fs::symlink(tmp.path().join("gone"), kept_root.join("skill-a-2")).unwrap();
        let second = make_copy("agent-2");
        move_into_kept_copies(&second, "../skills").unwrap();
        assert!(!second.exists(), "the second copy was not moved");
        let landed = if cfg!(unix) { "skill-a-3" } else { "skill-a-2" };
        assert_eq!(
            fs::read_to_string(kept_root.join(landed).join("notes.md")).unwrap(),
            "agent-2"
        );

        central_repo::set_test_base_dir_override(None);
    }

    /// Startup must survive a collision. `ensure_default_startup_scenario`
    /// reaches this function through `sync_scenario_skills`, and its caller
    /// chain ends at `initialize_store().expect(...)` in lib.rs — so returning
    /// `Err` for an ownership refusal panicked the desktop app on launch under
    /// exactly the condition #363 exists to handle. The refusal must come back
    /// as data, with the user's directory untouched.
    fn sync_configured_targets(
        store: &SkillStore,
        desired: &[ScenarioSyncTarget],
    ) -> Result<Vec<TargetConflict>, AppError> {
        store.update_tool_config(|config| {
            for target in desired {
                let root = target
                    .target
                    .parent()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                if tool_adapters::find_adapter(&target.tool).is_some() {
                    config.paths.insert(target.tool.clone(), root);
                } else if let Some(custom) =
                    config.customs.iter_mut().find(|c| c.key == target.tool)
                {
                    custom.skills_dir = root;
                } else {
                    config.customs.push(tool_adapters::CustomToolDef {
                        key: target.tool.clone(),
                        display_name: target.tool.clone(),
                        skills_dir: root,
                        project_relative_skills_dir: None,
                        category: Default::default(),
                    });
                }
            }
            Ok(())
        })?;
        super::sync_desired_targets(store, desired)
    }

    #[test]
    fn ownership_refusal_is_reported_not_returned_as_error() {
        let _lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("repo");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&base.join("test.db")).unwrap();

        let source = central_repo::skills_dir().join("skill-a");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "real source").unwrap();

        // An unmanaged directory sitting exactly where we want to deploy.
        let target = tmp.path().join("agent-skills").join("skill-a");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("unmanaged.txt"), "DO_NOT_OVERWRITE").unwrap();

        let desired = vec![ScenarioSyncTarget {
            skill_id: "skill-a".to_string(),
            skill_name: "skill-a".to_string(),
            tool: "claude-code".to_string(),
            source,
            target: target.clone(),
            mode: sync_engine::SyncMode::Symlink,
            source_hash: Some("h1".to_string()),
        }];

        let refusals = sync_configured_targets(&store, &desired)
            .expect("a refusal must not surface as Err: that panics app startup");
        assert_eq!(refusals.len(), 1, "{refusals:?}");
        assert!(
            refusals[0].to_string().contains("Refusing to replace"),
            "{refusals:?}"
        );
        assert_eq!(refusals[0].target, target);

        let err = refusals_to_error(refusals).expect_err("调用方应收到结构化冲突错误");
        assert_eq!(err.kind, crate::core::error::ErrorKind::TargetConflict);
        let details = err.details.expect("冲突错误必须包含路径详情");
        assert_eq!(details.conflicts.len(), 1);
        assert_eq!(details.conflicts[0].path, target.display().to_string());
        assert_eq!(
            fs::read_to_string(target.join("unmanaged.txt")).unwrap(),
            "DO_NOT_OVERWRITE"
        );

        central_repo::set_test_base_dir_override(None);
    }

    #[test]
    fn retargeting_deploys_the_new_path_without_deleting_the_previous_path() {
        let _lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("repo");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&base.join("test.db")).unwrap();

        let source = central_repo::skills_dir().join("skill-a");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "center source").unwrap();
        let old_target = tmp
            .path()
            .join(".config")
            .join("agents")
            .join("skills")
            .join("skill-a");
        fs::create_dir_all(&old_target).unwrap();
        fs::write(old_target.join("SKILL.md"), "old deployment").unwrap();
        let new_target = tmp.path().join("kimi-code").join("skill-a");

        store
            .insert_skill(&SkillRecord {
                id: "skill-a".to_string(),
                name: "skill-a".to_string(),
                description: None,
                source_type: "import".to_string(),
                source_ref: Some(source.to_string_lossy().to_string()),
                source_ref_resolved: None,
                source_subpath: None,
                source_branch: None,
                source_revision: None,
                remote_revision: None,
                central_path: source.to_string_lossy().to_string(),
                content_hash: Some("h1".to_string()),
                enabled: true,
                created_at: 1,
                updated_at: 1,
                status: "ok".to_string(),
                update_status: "local_only".to_string(),
                last_checked_at: None,
                last_check_error: None,
            })
            .unwrap();
        store
            .insert_target(&SkillTargetRecord {
                id: "target-kimi".to_string(),
                skill_id: "skill-a".to_string(),
                tool: "kimi".to_string(),
                target_path: old_target.to_string_lossy().to_string(),
                mode: "copy".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: Some("h1".to_string()),
            })
            .unwrap();
        sync_configured_targets(
            &store,
            &[ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "kimi".to_string(),
                source,
                target: new_target.clone(),
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            }],
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(old_target.join("SKILL.md")).unwrap(),
            "old deployment"
        );
        assert_eq!(
            fs::read_to_string(new_target.join("SKILL.md")).unwrap(),
            "center source"
        );
        let targets = store.get_targets_for_skill("skill-a").unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].target_path, new_target.to_string_lossy());

        central_repo::set_test_base_dir_override(None);
    }

    #[test]
    fn single_skill_retargeting_preserves_the_previous_path() {
        let tmp = tempdir().unwrap();
        let store = SkillStore::new(&tmp.path().join("test.db")).unwrap();
        let source = tmp.path().join("center").join("skill-a");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "center source").unwrap();
        let old_target = tmp.path().join("legacy-agent").join("skill-a");
        fs::create_dir_all(&old_target).unwrap();
        fs::write(old_target.join("SKILL.md"), "old deployment").unwrap();
        let new_base = tmp.path().join("new-agent");
        let new_target = new_base.join("skill-a");

        store
            .set_setting(
                "custom_tools",
                &serde_json::to_string(&vec![CustomToolDef {
                    key: "test_agent".to_string(),
                    display_name: "Test Agent".to_string(),
                    skills_dir: new_base.to_string_lossy().to_string(),
                    project_relative_skills_dir: None,
                    category: Default::default(),
                }])
                .unwrap(),
            )
            .unwrap();
        let disabled: Vec<String> = tool_adapters::default_tool_adapters()
            .into_iter()
            .map(|adapter| adapter.key)
            .collect();
        store
            .set_setting("disabled_tools", &serde_json::to_string(&disabled).unwrap())
            .unwrap();
        store.set_setting("sync_mode", "copy").unwrap();
        store
            .insert_scenario(&ScenarioRecord {
                id: "active".to_string(),
                name: "Active".to_string(),
                description: None,
                icon: None,
                sort_order: 0,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        store.set_active_scenario("active").unwrap();
        store
            .insert_skill(&SkillRecord {
                id: "skill-a".to_string(),
                name: "skill-a".to_string(),
                description: None,
                source_type: "import".to_string(),
                source_ref: Some(source.to_string_lossy().to_string()),
                source_ref_resolved: None,
                source_subpath: None,
                source_branch: None,
                source_revision: None,
                remote_revision: None,
                central_path: source.to_string_lossy().to_string(),
                content_hash: Some("h1".to_string()),
                enabled: true,
                created_at: 1,
                updated_at: 1,
                status: "ok".to_string(),
                update_status: "local_only".to_string(),
                last_checked_at: None,
                last_check_error: None,
            })
            .unwrap();
        store.add_skill_to_scenario("active", "skill-a").unwrap();
        store
            .insert_target(&SkillTargetRecord {
                id: "target-old".to_string(),
                skill_id: "skill-a".to_string(),
                tool: "test_agent".to_string(),
                target_path: old_target.to_string_lossy().to_string(),
                mode: "copy".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: Some("h1".to_string()),
            })
            .unwrap();
        store
            .insert_target(&SkillTargetRecord {
                id: "target-other".to_string(),
                skill_id: "skill-a".to_string(),
                tool: "other_agent".to_string(),
                target_path: old_target.to_string_lossy().to_string(),
                mode: "copy".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: Some("h1".to_string()),
            })
            .unwrap();

        sync_skill_to_active_scenario(&store, "active", "skill-a").unwrap();

        assert_eq!(
            fs::read_to_string(old_target.join("SKILL.md")).unwrap(),
            "old deployment"
        );
        assert_eq!(
            fs::read_to_string(new_target.join("SKILL.md")).unwrap(),
            "center source"
        );
        let targets = store.get_targets_for_skill("skill-a").unwrap();
        assert_eq!(targets.len(), 2);
        assert!(targets.iter().any(|target| {
            target.tool == "test_agent" && target.target_path == new_target.to_string_lossy()
        }));
        assert!(targets.iter().any(|target| {
            target.tool == "other_agent" && target.target_path == old_target.to_string_lossy()
        }));
    }

    #[test]
    fn ordinary_unshared_retargeting_removes_the_previous_managed_path() {
        let tmp = tempdir().unwrap();
        let store = SkillStore::new(&tmp.path().join("test.db")).unwrap();
        let source = tmp.path().join("center").join("skill-a");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "center source").unwrap();
        let old_target = tmp.path().join("old-agent").join("skill-a");
        fs::create_dir_all(&old_target).unwrap();
        fs::write(old_target.join("SKILL.md"), "old deployment").unwrap();
        let new_target = tmp.path().join("new-agent").join("skill-a");
        store
            .insert_skill(&SkillRecord {
                id: "skill-a".to_string(),
                name: "skill-a".to_string(),
                description: None,
                source_type: "import".to_string(),
                source_ref: Some(source.to_string_lossy().to_string()),
                source_ref_resolved: None,
                source_subpath: None,
                source_branch: None,
                source_revision: None,
                remote_revision: None,
                central_path: source.to_string_lossy().to_string(),
                content_hash: Some("h1".to_string()),
                enabled: true,
                created_at: 1,
                updated_at: 1,
                status: "ok".to_string(),
                update_status: "local_only".to_string(),
                last_checked_at: None,
                last_check_error: None,
            })
            .unwrap();
        store
            .insert_target(&SkillTargetRecord {
                id: "target-old".to_string(),
                skill_id: "skill-a".to_string(),
                tool: "ordinary_agent".to_string(),
                target_path: old_target.to_string_lossy().to_string(),
                mode: "copy".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: Some(crate::core::content_hash::hash_directory(&old_target).unwrap()),
            })
            .unwrap();

        sync_configured_targets(
            &store,
            &[ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "ordinary_agent".to_string(),
                source,
                target: new_target.clone(),
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            }],
        )
        .unwrap();

        assert!(!old_target.exists());
        assert_eq!(
            fs::read_to_string(new_target.join("SKILL.md")).unwrap(),
            "center source"
        );
    }

    #[test]
    fn shared_path_is_removed_when_every_claimant_retargets_in_the_same_sync() {
        let tmp = tempdir().unwrap();
        let store = SkillStore::new(&tmp.path().join("test.db")).unwrap();
        let source = tmp.path().join("center").join("skill-a");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "center source").unwrap();
        let old_target = tmp.path().join("shared-old").join("skill-a");
        fs::create_dir_all(&old_target).unwrap();
        fs::write(old_target.join("SKILL.md"), "old deployment").unwrap();
        store
            .insert_skill(&SkillRecord {
                id: "skill-a".to_string(),
                name: "skill-a".to_string(),
                description: None,
                source_type: "import".to_string(),
                source_ref: Some(source.to_string_lossy().to_string()),
                source_ref_resolved: None,
                source_subpath: None,
                source_branch: None,
                source_revision: None,
                remote_revision: None,
                central_path: source.to_string_lossy().to_string(),
                content_hash: Some("h1".to_string()),
                enabled: true,
                created_at: 1,
                updated_at: 1,
                status: "ok".to_string(),
                update_status: "local_only".to_string(),
                last_checked_at: None,
                last_check_error: None,
            })
            .unwrap();
        for (id, tool) in [("target-a", "agent_a"), ("target-b", "agent_b")] {
            store
                .insert_target(&SkillTargetRecord {
                    id: id.to_string(),
                    skill_id: "skill-a".to_string(),
                    tool: tool.to_string(),
                    target_path: old_target.to_string_lossy().to_string(),
                    mode: "copy".to_string(),
                    status: "ok".to_string(),
                    synced_at: Some(1),
                    last_error: None,
                    source_hash: Some(
                        crate::core::content_hash::hash_directory(&old_target).unwrap(),
                    ),
                })
                .unwrap();
        }
        let desired = [
            ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "agent_a".to_string(),
                source: source.clone(),
                target: tmp.path().join("new-a").join("skill-a"),
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            },
            ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "agent_b".to_string(),
                source,
                target: tmp.path().join("new-b").join("skill-a"),
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            },
        ];

        sync_configured_targets(&store, &desired).unwrap();

        assert!(!old_target.exists());
        let targets = store.get_targets_for_skill("skill-a").unwrap();
        assert_eq!(targets.len(), 2);
        assert!(targets
            .iter()
            .all(|target| target.target_path != old_target.to_string_lossy()));
    }

    #[test]
    fn legacy_kimi_path_is_preserved_when_every_shared_claimant_retargets() {
        let tmp = tempdir().unwrap();
        let store = SkillStore::new(&tmp.path().join("test.db")).unwrap();
        let source = tmp.path().join("center").join("skill-a");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "center source").unwrap();
        let old_target = tmp
            .path()
            .join(".config")
            .join("agents")
            .join("skills")
            .join("skill-a");
        fs::create_dir_all(&old_target).unwrap();
        fs::write(old_target.join("SKILL.md"), "old deployment").unwrap();
        store
            .insert_skill(&SkillRecord {
                id: "skill-a".to_string(),
                name: "skill-a".to_string(),
                description: None,
                source_type: "import".to_string(),
                source_ref: Some(source.to_string_lossy().to_string()),
                source_ref_resolved: None,
                source_subpath: None,
                source_branch: None,
                source_revision: None,
                remote_revision: None,
                central_path: source.to_string_lossy().to_string(),
                content_hash: Some("h1".to_string()),
                enabled: true,
                created_at: 1,
                updated_at: 1,
                status: "ok".to_string(),
                update_status: "local_only".to_string(),
                last_checked_at: None,
                last_check_error: None,
            })
            .unwrap();
        for (id, tool) in [("target-kimi", "kimi"), ("target-other", "ordinary_agent")] {
            store
                .insert_target(&SkillTargetRecord {
                    id: id.to_string(),
                    skill_id: "skill-a".to_string(),
                    tool: tool.to_string(),
                    target_path: old_target.to_string_lossy().to_string(),
                    mode: "copy".to_string(),
                    status: "ok".to_string(),
                    synced_at: Some(1),
                    last_error: None,
                    source_hash: Some("h1".to_string()),
                })
                .unwrap();
        }
        let desired = [
            ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "kimi".to_string(),
                source: source.clone(),
                target: tmp.path().join("new-kimi").join("skill-a"),
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            },
            ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "ordinary_agent".to_string(),
                source,
                target: tmp.path().join("new-other").join("skill-a"),
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            },
        ];

        sync_configured_targets(&store, &desired).unwrap();

        assert_eq!(
            fs::read_to_string(old_target.join("SKILL.md")).unwrap(),
            "old deployment"
        );
    }

    #[test]
    fn failed_retarget_keeps_the_old_shared_deployment_and_record() {
        let tmp = tempdir().unwrap();
        let store = SkillStore::new(&tmp.path().join("test.db")).unwrap();
        let source = tmp.path().join("center").join("skill-a");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "center source").unwrap();
        let old_target = tmp.path().join("shared-old").join("skill-a");
        fs::create_dir_all(&old_target).unwrap();
        fs::write(old_target.join("SKILL.md"), "old deployment").unwrap();
        let blocked_target = tmp.path().join("blocked").join("skill-a");
        fs::create_dir_all(&blocked_target).unwrap();
        fs::write(blocked_target.join("unmanaged.txt"), "user content").unwrap();
        store
            .insert_skill(&SkillRecord {
                id: "skill-a".to_string(),
                name: "skill-a".to_string(),
                description: None,
                source_type: "import".to_string(),
                source_ref: Some(source.to_string_lossy().to_string()),
                source_ref_resolved: None,
                source_subpath: None,
                source_branch: None,
                source_revision: None,
                remote_revision: None,
                central_path: source.to_string_lossy().to_string(),
                content_hash: Some("h1".to_string()),
                enabled: true,
                created_at: 1,
                updated_at: 1,
                status: "ok".to_string(),
                update_status: "local_only".to_string(),
                last_checked_at: None,
                last_check_error: None,
            })
            .unwrap();
        for (id, tool) in [("target-a", "agent_a"), ("target-b", "agent_b")] {
            store
                .insert_target(&SkillTargetRecord {
                    id: id.to_string(),
                    skill_id: "skill-a".to_string(),
                    tool: tool.to_string(),
                    target_path: old_target.to_string_lossy().to_string(),
                    mode: "copy".to_string(),
                    status: "ok".to_string(),
                    synced_at: Some(1),
                    last_error: None,
                    source_hash: Some("h1".to_string()),
                })
                .unwrap();
        }
        let desired = [
            ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "agent_a".to_string(),
                source: source.clone(),
                target: tmp.path().join("new-a").join("skill-a"),
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            },
            ScenarioSyncTarget {
                skill_id: "skill-a".to_string(),
                skill_name: "skill-a".to_string(),
                tool: "agent_b".to_string(),
                source,
                target: blocked_target,
                mode: sync_engine::SyncMode::Copy,
                source_hash: Some("h1".to_string()),
            },
        ];

        let refusals = sync_configured_targets(&store, &desired).unwrap();

        assert_eq!(refusals.len(), 1);
        assert_eq!(
            fs::read_to_string(old_target.join("SKILL.md")).unwrap(),
            "old deployment"
        );
        let targets = store.get_targets_for_skill("skill-a").unwrap();
        assert!(targets.iter().any(|target| {
            target.tool == "agent_b" && target.target_path == old_target.to_string_lossy()
        }));
    }

    /// Issue #153 regression: when the existing target was written in
    /// Copy mode (Windows symlink fallback) but the configured mode is
    /// Symlink, and the source content hash hasn't changed, the sync
    /// must be skipped. Prior to the fix the mode-equality guard would
    /// reject the skip branch and re-attempt the full recursive copy
    /// every startup.
    #[test]
    fn copy_fallback_target_with_matching_hash_is_skipped() {
        let _lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("repo");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&base.join("test.db")).unwrap();

        // Real source dir with one file (the central skill).
        let source = central_repo::skills_dir().join("skill-a");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("MARKER.txt"), "do not wipe me").unwrap();
        let hash = crate::core::content_hash::hash_directory(&source).unwrap();

        // Pre-existing target dir with a marker file that would be wiped
        // by copy_dir_recursive's pre-clean step if a re-sync ran.
        let target = tmp.path().join("agent-skills").join("skill-a");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("MARKER.txt"), "do not wipe me").unwrap();

        // DB rows: skill content_hash = "h1"; existing target also at "h1",
        // mode "copy" (i.e. previously fell back from Symlink).
        let skill = SkillRecord {
            id: "skill-a".to_string(),
            name: "skill-a".to_string(),
            description: None,
            source_type: "import".to_string(),
            source_ref: Some(source.to_string_lossy().to_string()),
            source_ref_resolved: None,
            source_subpath: None,
            source_branch: None,
            source_revision: None,
            remote_revision: None,
            central_path: source.to_string_lossy().to_string(),
            content_hash: Some(hash.clone()),
            enabled: true,
            created_at: 1,
            updated_at: 1,
            status: "ok".to_string(),
            update_status: "local_only".to_string(),
            last_checked_at: None,
            last_check_error: None,
        };
        store.insert_skill(&skill).unwrap();

        store
            .insert_target(&SkillTargetRecord {
                id: "target-1".to_string(),
                skill_id: "skill-a".to_string(),
                tool: "claude-code".to_string(),
                target_path: target.to_string_lossy().to_string(),
                mode: "copy".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: Some(hash.clone()),
            })
            .unwrap();

        // Desired target: same source/target/hash but Symlink mode
        // (the configured default that originally fell back to Copy).
        let desired = vec![ScenarioSyncTarget {
            skill_id: "skill-a".to_string(),
            skill_name: "skill-a".to_string(),
            tool: "claude-code".to_string(),
            source: source.clone(),
            target: target.clone(),
            mode: sync_engine::SyncMode::Symlink,
            source_hash: Some(hash.clone()),
        }];

        sync_configured_targets(&store, &desired).unwrap();

        // The marker file proves no re-sync ran (a real re-sync would
        // have called copy_dir_recursive after wiping the target).
        assert!(
            target.join("MARKER.txt").exists(),
            "target dir was wiped — skip did not fire"
        );
        // The skill's actual SKILL.md should NOT have been copied in,
        // because we skipped the sync entirely.
        assert!(
            !target.join("SKILL.md").exists(),
            "SKILL.md appeared — sync ran instead of skipping"
        );

        central_repo::set_test_base_dir_override(None);
    }

    /// Companion: if the target has been manually deleted, even with a
    /// matching hash, we must NOT skip — the user's agent dir is
    /// otherwise left broken.
    #[test]
    fn deleted_target_with_matching_hash_forces_resync() {
        let _lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("repo");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&base.join("test.db")).unwrap();

        let source = central_repo::skills_dir().join("skill-b");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "real source").unwrap();

        // Target path that does NOT exist on disk.
        let target = tmp.path().join("agent-skills").join("skill-b");

        let skill = SkillRecord {
            id: "skill-b".to_string(),
            name: "skill-b".to_string(),
            description: None,
            source_type: "import".to_string(),
            source_ref: Some(source.to_string_lossy().to_string()),
            source_ref_resolved: None,
            source_subpath: None,
            source_branch: None,
            source_revision: None,
            remote_revision: None,
            central_path: source.to_string_lossy().to_string(),
            content_hash: Some("h1".to_string()),
            enabled: true,
            created_at: 1,
            updated_at: 1,
            status: "ok".to_string(),
            update_status: "local_only".to_string(),
            last_checked_at: None,
            last_check_error: None,
        };
        store.insert_skill(&skill).unwrap();

        store
            .insert_target(&SkillTargetRecord {
                id: "target-2".to_string(),
                skill_id: "skill-b".to_string(),
                tool: "claude-code".to_string(),
                target_path: target.to_string_lossy().to_string(),
                mode: "copy".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: Some("h1".to_string()),
            })
            .unwrap();

        let desired = vec![ScenarioSyncTarget {
            skill_id: "skill-b".to_string(),
            skill_name: "skill-b".to_string(),
            tool: "claude-code".to_string(),
            source: source.clone(),
            target: target.clone(),
            mode: sync_engine::SyncMode::Copy,
            source_hash: Some("h1".to_string()),
        }];

        sync_configured_targets(&store, &desired).unwrap();

        // Sync must have run — target should now exist with the source content.
        assert!(
            target.join("SKILL.md").exists(),
            "missing target was not re-synced"
        );

        central_repo::set_test_base_dir_override(None);
    }

    /// `canonicalize` resolves through symlinks, but the replacement that
    /// follows an adoption does not: a symlinked target is only unlinked, so
    /// whatever it pointed at survives. Re-pointing on the resolved path would
    /// silently orphan a directory that is still on disk and still the user's
    /// source of truth -- later edits in it would never be seen again (#425).
    #[cfg(unix)]
    #[test]
    fn a_symlinked_adoption_target_does_not_detach_the_directory_it_points_at() {
        let _lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("repo");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&base.join("test.db")).unwrap();

        let central = central_repo::skills_dir().join("jira");
        fs::create_dir_all(&central).unwrap();
        fs::write(central.join("SKILL.md"), "central copy").unwrap();

        // The folder the skill was imported from: still the user's source.
        let import_src = tmp.path().join("claude").join("skills").join("jira");
        fs::create_dir_all(&import_src).unwrap();
        fs::write(import_src.join("SKILL.md"), "user copy").unwrap();

        // Another agent's skills dir holds a symlink to that same folder.
        let link = tmp.path().join("duo").join("skills").join("jira");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&import_src, &link).unwrap();

        store
            .insert_skill(&SkillRecord {
                id: "jira".to_string(),
                name: "jira".to_string(),
                description: None,
                source_type: "import".to_string(),
                source_ref: Some(import_src.to_string_lossy().to_string()),
                source_ref_resolved: None,
                source_subpath: None,
                source_branch: None,
                source_revision: None,
                remote_revision: None,
                central_path: central.to_string_lossy().to_string(),
                content_hash: Some("h1".to_string()),
                enabled: true,
                created_at: 1,
                updated_at: 1,
                status: "ok".to_string(),
                update_status: "local_only".to_string(),
                last_checked_at: None,
                last_check_error: None,
            })
            .unwrap();

        // Adopting the link must leave the pointee's source_ref alone.
        detach_source_refs_from_adoption_target(&store, &link).unwrap();
        let after = store.get_skill_by_id("jira").unwrap().unwrap();
        assert_eq!(
            after.source_ref.as_deref(),
            Some(import_src.to_string_lossy().as_ref()),
            "a symlinked target detached the real directory it points at"
        );

        // But adopting the real directory still detaches it: that one is
        // about to be replaced by a deployment.
        detach_source_refs_from_adoption_target(&store, &import_src).unwrap();
        let after = store.get_skill_by_id("jira").unwrap().unwrap();
        assert_eq!(
            after.source_ref.as_deref(),
            Some(central.to_string_lossy().as_ref()),
            "adopting the real source dir no longer re-points source_ref"
        );

        central_repo::set_test_base_dir_override(None);
    }
}

#[cfg(test)]
mod skip_check_mode_tests {
    use super::skip_check_mode;
    use super::sync_engine::SyncMode;

    #[test]
    fn matching_modes_are_compatible() {
        assert!(matches!(
            skip_check_mode("symlink", SyncMode::Symlink),
            Some(SyncMode::Symlink)
        ));
        assert!(matches!(
            skip_check_mode("copy", SyncMode::Copy),
            Some(SyncMode::Copy)
        ));
    }

    #[test]
    fn copy_existing_with_symlink_desired_treated_as_copy() {
        // Windows fallback case (issue #153): record says copy because
        // symlink_dir failed previously. We accept that and let the hash
        // gate decide freshness, instead of re-attempting symlink and
        // triggering a full recopy on every startup.
        assert!(matches!(
            skip_check_mode("copy", SyncMode::Symlink),
            Some(SyncMode::Copy)
        ));
    }

    #[test]
    fn symlink_existing_with_copy_desired_is_incompatible() {
        // User flipped sync_mode setting from symlink to copy — the
        // on-disk symlink no longer reflects intent, must resync.
        assert!(skip_check_mode("symlink", SyncMode::Copy).is_none());
    }

    #[test]
    fn unknown_existing_mode_is_incompatible() {
        assert!(skip_check_mode("garbage", SyncMode::Symlink).is_none());
        assert!(skip_check_mode("", SyncMode::Copy).is_none());
    }
}

#[cfg(test)]
mod deployment_receipt_tests {
    use super::*;
    use crate::core::{content_hash, skill_store::SkillRecord, tool_adapters::CustomToolDef};
    use tempfile::tempdir;

    fn fixture(store: &SkillStore, root: &Path) -> (SkillRecord, ScenarioSyncTarget) {
        let source = root.join("center/demo");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "demo").unwrap();
        let skill = SkillRecord {
            id: "demo".into(),
            name: "demo".into(),
            description: None,
            source_type: "local".into(),
            source_ref: None,
            source_ref_resolved: None,
            source_subpath: None,
            source_branch: None,
            source_revision: None,
            remote_revision: None,
            central_path: source.to_string_lossy().into_owned(),
            content_hash: Some(content_hash::hash_directory(&source).unwrap()),
            enabled: true,
            created_at: 0,
            updated_at: 0,
            status: "ok".into(),
            update_status: "local_only".into(),
            last_checked_at: None,
            last_check_error: None,
        };
        store.insert_skill(&skill).unwrap();
        store
            .update_tool_config(|c| {
                c.customs.push(CustomToolDef {
                    key: "own".into(),
                    display_name: "Own".into(),
                    skills_dir: root.join("agent").to_string_lossy().into_owned(),
                    project_relative_skills_dir: None,
                    category: Default::default(),
                });
                Ok(())
            })
            .unwrap();
        let target = ScenarioSyncTarget {
            skill_id: skill.id.clone(),
            skill_name: skill.name.clone(),
            tool: "own".into(),
            source,
            target: root.join("agent/demo"),
            mode: sync_engine::SyncMode::Copy,
            source_hash: skill.content_hash.clone(),
        };
        (skill, target)
    }

    #[test]
    fn file_success_with_record_failure_is_unconfirmed_and_preserves_actual_files() {
        let temp = tempdir().unwrap();
        let db = temp.path().join("test.db");
        let store = SkillStore::new(&db).unwrap();
        let (_, target) = fixture(&store, temp.path());
        rusqlite::Connection::open(&db).unwrap().execute_batch("CREATE TRIGGER reject_target BEFORE INSERT ON skill_targets BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        let report = sync_desired_targets_report(&store, &[target]);
        assert_eq!(report.state, "unknown");
        assert_eq!(report.targets[0].outcome, "unconfirmed");
        assert_eq!(
            std::fs::read_to_string(temp.path().join("agent/demo/SKILL.md")).unwrap(),
            "demo"
        );
        assert!(store.get_all_targets().unwrap().is_empty());
    }

    #[test]
    fn stale_disabled_plan_never_writes_and_bad_config_has_unknown_total() {
        let temp = tempdir().unwrap();
        let store = SkillStore::new(&temp.path().join("test.db")).unwrap();
        let (_, target) = fixture(&store, temp.path());
        store
            .update_tool_config(|c| {
                c.disabled.push("own".into());
                Ok(())
            })
            .unwrap();
        let report = sync_desired_targets_report(&store, std::slice::from_ref(&target));
        assert_eq!(report.targets[0].outcome, "not_attempted");
        assert!(!target.target.exists());
        store.set_setting("custom_tools", "{").unwrap();
        let report = sync_desired_targets_report(&store, &[target]);
        assert_eq!(report.state, "unknown");
        assert_eq!(report.total, None);
    }

    #[test]
    fn replaced_copy_is_not_current_and_is_preserved_on_sync_and_removal() {
        let temp = tempdir().unwrap();
        let store = SkillStore::new(&temp.path().join("test.db")).unwrap();
        let (_, target) = fixture(&store, temp.path());
        assert!(sync_desired_targets_report(&store, std::slice::from_ref(&target)).complete());
        std::fs::write(target.target.join("SKILL.md"), "external replacement").unwrap();
        let report = sync_desired_targets_report(&store, &[target]);
        assert_eq!(report.targets[0].outcome, "refused");
        let removal = remove_tool_targets(&store, "own").unwrap();
        assert!(removal.complete());
        assert_eq!(
            removal.targets[0].message.as_deref(),
            Some("foreign_or_unconfirmed")
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("agent/demo/SKILL.md")).unwrap(),
            "external replacement"
        );
        assert!(store.get_all_targets().unwrap().is_empty());
    }
}
