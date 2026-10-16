use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

use super::{
    error::{AppError, TargetConflictDetail},
    skill_store::{ScenarioRecord, SkillStore, SkillTargetRecord},
    sync_engine, tool_adapters, tool_service,
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
    let mut targets = Vec::new();

    for skill in &skills {
        let source = PathBuf::from(&skill.central_path);
        let target_name = sync_engine::target_dir_name(&source, &skill.name);
        let adapters =
            enabled_installed_adapters_for_scenario_skill(store, scenario_id, &skill.id)?;
        for adapter in &adapters {
            let target = adapter.skills_dir().join(&target_name);
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
/// rest of this module makes about `target_path`, and erring here only costs a
/// refusal, never a deletion.
fn ownership_key(path: &Path, memo: &mut HashMap<PathBuf, PathBuf>) -> PathBuf {
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
    let mut written: HashMap<PathBuf, (PathBuf, String)> = HashMap::new();
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
                    && a.skills_dir().join(sync_engine::target_dir_name(
                        &desired.source,
                        &desired.skill_name,
                    )) == desired.target
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
        let recorded_mode = written
            .get(&desired.target)
            .filter(|(source, _)| source == &desired.source)
            .map(|(_, mode)| mode.as_str())
            .or_else(|| {
                old.filter(|t| {
                    Path::new(&t.target_path) == desired.target
                        && recorded_target_matches_source(t, &desired.source)
                })
                .map(|t| t.mode.as_str())
            });
        if old.is_some_and(|t| {
            Path::new(&t.target_path) == desired.target
                && t.status == "ok"
                && skip_check_mode(&t.mode, desired.mode).is_some_and(|mode| {
                    sync_engine::is_target_current(
                        &desired.source,
                        &desired.target,
                        mode,
                        t.source_hash.as_deref(),
                        Some(&source_hash),
                    )
                })
        }) {
            result.outcome = "already_current".into();
            report.targets.push(result);
            continue;
        }
        match sync_engine::sync_skill(
            &desired.source,
            &desired.target,
            desired.mode,
            replace_policy(recorded_mode),
        ) {
            Ok(mode) => {
                written.insert(
                    desired.target.clone(),
                    (desired.source.clone(), mode.as_str().into()),
                );
                let row = SkillTargetRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    skill_id: desired.skill_id.clone(),
                    tool: desired.tool.clone(),
                    target_path: result.target_path.clone(),
                    mode: mode.as_str().into(),
                    status: "ok".into(),
                    synced_at: Some(chrono::Utc::now().timestamp_millis()),
                    last_error: None,
                    source_hash: Some(source_hash),
                };
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
                                preserve_or_remove_target(store, old)
                            } {
                                Ok(reason) if reason == "shared" => {
                                    result.message = Some(format!(
                                        "Old shared target preserved: {}",
                                        old.target_path
                                    ))
                                }
                                Ok(reason) if reason != "removed" && reason != "absent" => report
                                    .issue(
                                        "retire_old_target",
                                        "TARGET_PRESERVED",
                                        Some(&old.tool),
                                        Some(&old.target_path),
                                        reason,
                                    ),
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
        .map(|target| preserve_or_remove_target(store, target))
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
pub enum DeployIntent {
    /// Ordinary deployment: replace only what our own records vouch for.
    Managed,
    /// The user explicitly asked us to take over whatever is at this path.
    AdoptExisting,
}

pub fn sync_single_skill_to_tool(
    store: &SkillStore,
    skill_id: &str,
    tool: &str,
    intent: DeployIntent,
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
    let target = adapter
        .skills_dir()
        .join(sync_engine::target_dir_name(&source, &skill.name));
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

/// Apply a batch of `(skill_id × tool_key)` pairs in either Add or Remove mode
/// without touching `active_scenario_id` or `scenario_skill_tools` toggles.
///
/// This is the tray-side preset apply primitive. Unlike [`sync_single_skill_to_tool`]
/// (which is wrapped by the `sync_skill_to_tool` Tauri command and carries the
/// implicit active-preset toggle side-effect), this batch is a pure
/// "write/remove files + maintain `skill_targets` rows" operation.
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

    match mode {
        BatchApplyMode::Add => apply_add(store, skill_ids, tool_keys),
        BatchApplyMode::Remove => apply_remove(store, skill_ids, tool_keys),
    }
}

fn apply_add(
    store: &SkillStore,
    skill_ids: &[String],
    tool_keys: &[String],
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
                target: adapter.skills_dir().join(&target_name),
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
    let evidence_by_key: HashMap<&PathBuf, &str> = modes_by_key
        .iter()
        .filter_map(|(key, modes)| {
            let mut it = modes.iter();
            match (it.next(), it.next()) {
                (Some(only), None) => Some((key, *only)),
                _ => None,
            }
        })
        .collect();
    let evidence_for = |target: &Path, memo: &mut HashMap<PathBuf, PathBuf>| -> Option<&str> {
        let key = ownership_key(target, memo);
        evidence_by_key.get(&key).copied()
    };
    let mut preflighted: HashSet<&Path> = HashSet::new();
    for pair in &plan {
        if !preflighted.insert(pair.target.as_path()) {
            continue;
        }
        if let Err(e) = sync_engine::preflight_replace(
            &pair.source,
            &pair.target,
            pair.mode,
            replace_policy(evidence_for(&pair.target, &mut key_memo)),
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
