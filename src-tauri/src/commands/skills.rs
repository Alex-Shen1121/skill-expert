use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, State};
use walkdir::WalkDir;

#[cfg(test)]
use std::sync::Mutex;

use crate::core::{
    audit_log::AuditDraft,
    central_repo,
    error::AppError,
    git_fetcher,
    install_cancel::InstallCancelRegistry,
    installer, path_guard,
    repo_lock::RepoLock,
    scanner,
    skill_metadata::{self, is_valid_skill_dir},
    skill_store::{SkillRecord, SkillStore, SkillTargetRecord},
    sync_engine, sync_metadata,
    timing::should_log_first_or_slow,
};

#[derive(Debug, Serialize)]
pub struct UpdateSkillResult {
    pub skill: ManagedSkillDto,
    /// Whether the skill's file content actually changed.
    /// False when a monorepo commit didn't touch this skill's subdirectory.
    pub content_changed: bool,
    /// What the update would remove, when it declined because of it (#256).
    /// Non-empty means **nothing was changed**: show these and call again with
    /// `approved_removals` set to `removal_approval` if the user accepts.
    ///
    /// Empty on every ordinary update, including approved ones.
    pub pending_removals: Vec<PendingRemoval>,
    /// Identifies exactly what `pending_removals` describes. Passing it back
    /// approves *that* list against *that* revision and nothing else — if the
    /// remote moves on, or the skill writes another file while the dialog is
    /// open, the approval no longer matches and the user is asked again.
    pub removal_approval: Option<String>,
}

/// Stands in for a revision when binding a re-import's approval: there is no
/// remote to move on, but the removal set still has to be bound.
const REIMPORT_APPROVAL_DOMAIN: &str = "reimport";

/// Result of re-importing a local skill from its source path.
#[derive(Debug, Serialize)]
pub struct ReimportSkillResult {
    pub skill: ManagedSkillDto,
    /// Non-empty means **nothing was changed** — see [`UpdateSkillResult`].
    pub pending_removals: Vec<PendingRemoval>,
    /// Approves exactly `pending_removals` — see [`UpdateSkillResult`].
    pub removal_approval: Option<String>,
}

enum UpdateOutcome {
    Applied {
        content_changed: bool,
    },
    /// Declined, having changed nothing.
    Held {
        pending: Vec<PendingRemoval>,
        approval: String,
    },
}

/// Everything a replacement would take away — from the library and from every
/// copy-mode deployment of this skill.
///
/// `staged` is the tree about to be installed, or `None` when the library keeps
/// what it already has. Even then the deployments are torn down and rebuilt from
/// it, which loses files just as effectively, so they are always checked.
///
/// Compared against the *staged* tree rather than the source it came from: the
/// installer drops `.git` and every symlink, so anything else would report a
/// path as surviving that the swap goes on to remove.
pub(crate) fn pending_removals_for(
    store: &SkillStore,
    skill: &SkillRecord,
    staged: Option<&Path>,
) -> Result<Vec<PendingRemoval>, AppError> {
    let library = Path::new(&skill.central_path);
    let mut pending = Vec::new();

    if let Some(staged) = staged {
        for path in crate::core::removals::removed_paths(library, staged).map_err(AppError::io)? {
            pending.push(PendingRemoval {
                location: LIBRARY_LOCATION.to_string(),
                path,
            });
        }
    }

    let effective_new = staged.unwrap_or(library);
    for target in store
        .get_targets_for_skill(&skill.id)
        .map_err(AppError::db)?
    {
        if target.mode != "copy" {
            continue;
        }
        for path in
            crate::core::removals::removed_paths(Path::new(&target.target_path), effective_new)
                .map_err(AppError::io)?
        {
            pending.push(PendingRemoval {
                location: target.tool.clone(),
                path,
            });
        }
    }
    Ok(pending)
}

/// A stable name for one exact set of removals at one exact revision.
fn removal_approval_token(revision: &str, pending: &[PendingRemoval]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(revision.as_bytes());
    let mut rows: Vec<String> = pending
        .iter()
        .map(|p| format!("{}\u{0}{}", p.location, p.path))
        .collect();
    rows.sort();
    for row in rows {
        hasher.update(row.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())
}

/// Removes a staged directory unless the swap claimed it.
struct StagedPathGuard<'a> {
    path: &'a Path,
    armed: std::cell::Cell<bool>,
}

impl<'a> StagedPathGuard<'a> {
    fn new(path: &'a Path, armed: bool) -> Self {
        Self {
            path,
            armed: std::cell::Cell::new(armed),
        }
    }

    /// The swap has taken ownership of it; there is nothing left to clean.
    fn release(&self) {
        self.armed.set(false);
    }
}

impl Drop for StagedPathGuard<'_> {
    fn drop(&mut self) {
        if self.armed.get() {
            // Declining an update must leave nothing behind — a stray
            // `.name.staged-<uuid>` inside the library is picked up by the
            // metadata rebuild scan as a skill of its own.
            let _ = remove_path_if_exists(self.path);
        }
    }
}

pub use crate::core::pending_removal::{PendingRemoval, LIBRARY_LOCATION};
pub use crate::skill_update_batch::PrefetchedRemote;
use crate::skill_update_batch::{
    self, is_checkable_update_skill, skill_update_batch_cancel_key, BatchUpdateExecution,
    CheckedSkillState, ForegroundCheckBatch, RemoteKey, RemoteSkillContent, ResolvedRemote,
    SkillUpdateCheckAdapter,
};
pub use crate::skill_update_batch::{
    BatchUpdateSkillItemResult, BatchUpdateSkillsResult, CheckSkillUpdateItemResult,
    CheckSkillUpdatesBatchResult, SkillUpdateBatchPhase, SkillUpdateBatchProgress,
    SkillUpdateBatchProgressStatus, DEFAULT_CHECK_CONCURRENCY, DEFAULT_UPDATE_CONCURRENCY,
    SKILL_UPDATE_BATCH_PROGRESS_EVENT,
};

#[cfg(test)]
use crate::skill_update_batch::CheckSkillUpdatesBatch;

#[derive(Debug, Serialize)]
pub struct BatchDeleteSkillsResult {
    pub deleted: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ManagedSkillDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub source_ref_resolved: Option<String>,
    pub source_subpath: Option<String>,
    pub source_branch: Option<String>,
    pub source_revision: Option<String>,
    pub remote_revision: Option<String>,
    pub update_status: String,
    pub last_checked_at: Option<i64>,
    pub last_check_error: Option<String>,
    pub central_path: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: String,
    pub targets: Vec<TargetDto>,
    pub preset_ids: Vec<String>,
    pub tags: Vec<String>,
    pub can_check_update: bool,
}

#[derive(Debug, Serialize)]
pub struct TargetDto {
    pub id: String,
    pub skill_id: String,
    pub tool: String,
    pub target_path: String,
    pub mode: String,
    pub status: String,
    pub synced_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct SkillDocumentDto {
    pub skill_id: String,
    pub filename: String,
    pub content: String,
    pub central_path: String,
}

/// Whole-directory diff between the central copy (`original`) and the source
/// (`updated`), covering the same file scope that drives the update badge so
/// the diff can never come back empty while the badge says "update available".
#[derive(Debug, Serialize)]
pub struct SkillSourceDiffDto {
    pub skill_id: String,
    pub source_label: String,
    pub revision: String,
    pub entries: Vec<SkillSourceDiffEntryDto>,
}

#[derive(Debug, Serialize)]
pub struct SkillSourceDiffEntryDto {
    pub relative_path: String,
    /// "added" | "removed" | "modified"
    pub status: String,
    /// "text" | "binary" | "too_large" | "permission_only"
    pub content_kind: String,
    /// Present only when `content_kind == "text"`.
    pub original_text: Option<String>,
    pub updated_text: Option<String>,
    pub executable_before: bool,
    pub executable_after: bool,
}

#[derive(Debug, Clone)]
pub struct InstallSourceMetadata {
    pub source_type: String,
    pub source_ref: Option<String>,
    pub source_ref_resolved: Option<String>,
    pub source_subpath: Option<String>,
    pub source_branch: Option<String>,
    pub source_revision: Option<String>,
    pub remote_revision: Option<String>,
    pub update_status: String,
}

#[derive(Debug, Clone)]
pub struct GitSkillSource {
    pub clone_url: String,
    pub branch: Option<String>,
    pub subpath: Option<String>,
    pub locator_skill_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct GitSkillPreview {
    /// Path relative to the resolved scan root, using `/` separators. Stable key.
    pub rel_path: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct GitPreviewResult {
    pub temp_dir: String,
    pub skills: Vec<GitSkillPreview>,
}

#[derive(Debug, serde::Deserialize)]
pub struct SkillInstallItem {
    pub rel_path: String,
    pub name: String,
}

struct CancelRegistrationGuard {
    registry: Arc<InstallCancelRegistry>,
    key: String,
}

impl CancelRegistrationGuard {
    fn new(registry: Arc<InstallCancelRegistry>, key: String) -> Self {
        Self { registry, key }
    }
}

impl Drop for CancelRegistrationGuard {
    fn drop(&mut self) {
        self.registry.remove(&self.key);
    }
}

static GET_MANAGED_SKILLS_FIRST_CALL: AtomicBool = AtomicBool::new(true);

#[tauri::command]
pub async fn get_managed_skills(
    store: State<'_, Arc<SkillStore>>,
) -> Result<Vec<ManagedSkillDto>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        let skills = store.get_all_skills().map_err(AppError::db)?;
        let all_targets = store.get_all_targets().map_err(AppError::db)?;
        let tags_map = store.get_tags_map().map_err(AppError::db)?;
        let count = skills.len();
        let dtos: Vec<ManagedSkillDto> = skills
            .into_iter()
            .map(|skill| managed_skill_to_dto(&store, skill, &all_targets, &tags_map))
            .collect();
        let elapsed_ms = start.elapsed().as_millis();
        if should_log_first_or_slow(&GET_MANAGED_SKILLS_FIRST_CALL, elapsed_ms, 100) {
            log::info!("get_managed_skills: {count} skills in {elapsed_ms} ms");
        }
        Ok(dtos)
    })
    .await?
}

#[tauri::command]
pub async fn get_skills_for_preset(
    preset_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<Vec<ManagedSkillDto>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skills = store
            .get_skills_for_scenario(&preset_id)
            .map_err(AppError::db)?;
        let all_targets = store.get_all_targets().map_err(AppError::db)?;
        let tags_map = store.get_tags_map().map_err(AppError::db)?;

        Ok(skills
            .into_iter()
            .map(|skill| managed_skill_to_dto(&store, skill, &all_targets, &tags_map))
            .collect())
    })
    .await?
}

#[tauri::command]
pub async fn open_skill_browser(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
    browser: State<'_, Arc<crate::core::skill_browser::SkillBrowser>>,
) -> Result<crate::core::skill_browser::BrowserIndex, AppError> {
    let store = store.inner().clone();
    let browser = browser.inner().clone();
    tauri::async_runtime::spawn_blocking(move || browser.open(&store, &skill_id)).await?
}

#[tauri::command]
pub async fn read_skill_browser_file(
    skill_id: String,
    session_id: String,
    relative_path: String,
    side: Option<String>,
    browser: State<'_, Arc<crate::core::skill_browser::SkillBrowser>>,
) -> Result<crate::core::skill_browser::FilePreview, AppError> {
    let browser = browser.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        browser.read_side(
            &skill_id,
            &session_id,
            &relative_path,
            side.as_deref().unwrap_or("local"),
        )
    })
    .await?
}

#[tauri::command]
pub async fn prepare_skill_browser_source(
    skill_id: String,
    session_id: String,
    browser: State<'_, Arc<crate::core::skill_browser::SkillBrowser>>,
) -> Result<crate::core::skill_browser::SourceIndex, AppError> {
    let browser = browser.inner().clone();
    tauri::async_runtime::spawn_blocking(move || browser.prepare_source(&skill_id, &session_id))
        .await?
}

#[tauri::command]
pub async fn get_skill_browser_diff(
    skill_id: String,
    session_id: String,
    browser: State<'_, Arc<crate::core::skill_browser::SkillBrowser>>,
) -> Result<crate::core::skill_browser::BrowserDiff, AppError> {
    let browser = browser.inner().clone();
    tauri::async_runtime::spawn_blocking(move || browser.source_diff(&skill_id, &session_id))
        .await?
}

#[tauri::command]
pub async fn close_skill_browser(
    skill_id: String,
    session_id: String,
    browser: State<'_, Arc<crate::core::skill_browser::SkillBrowser>>,
) -> Result<(), AppError> {
    browser.close(&skill_id, &session_id)
}

#[tauri::command]
pub async fn get_skill_document(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<SkillDocumentDto, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        let (filename, content) = read_skill_document_from_dir(Path::new(&skill.central_path))?;

        Ok(SkillDocumentDto {
            skill_id,
            filename,
            content,
            central_path: skill.central_path,
        })
    })
    .await?
}

fn read_skill_document_from_dir(dir: &Path) -> Result<(String, String), AppError> {
    let candidates = [
        "SKILL.md",
        "skill.md",
        "CLAUDE.md",
        "claude.md",
        "README.md",
        "readme.md",
    ];

    for name in &candidates {
        let path = dir.join(name);
        if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            return Ok((name.to_string(), content));
        }
    }

    for e in WalkDir::new(dir).max_depth(4).into_iter().flatten() {
        let fname = e.file_name().to_string_lossy();
        if candidates.contains(&fname.as_ref()) {
            let content = std::fs::read_to_string(e.path())?;
            return Ok((fname.to_string(), content));
        }
    }

    Err(AppError::not_found("No documentation file found"))
}

#[tauri::command]
pub async fn delete_managed_skill(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = delete_managed_skills_by_ids(&store, std::slice::from_ref(&skill_id))?;
        if result.deleted == 0 {
            return Err(AppError::not_found("Skill not found"));
        }
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn delete_managed_skills(
    skill_ids: Vec<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<BatchDeleteSkillsResult, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || delete_managed_skills_by_ids(&store, &skill_ids))
        .await?
}

pub fn delete_managed_skills_by_ids(
    store: &SkillStore,
    skill_ids: &[String],
) -> Result<BatchDeleteSkillsResult, AppError> {
    sync_metadata::with_repo_lock("delete skills", || {
        let mut deleted = 0;
        let mut failed = Vec::new();

        for skill_id in skill_ids {
            let Some(skill) = store.get_skill_by_id(skill_id)? else {
                store.log_audit(
                    AuditDraft::new("remove")
                        .skill(skill_id.clone(), "")
                        .fail("not found"),
                );
                failed.push(skill_id.clone());
                continue;
            };

            let targets = store.get_targets_for_skill(skill_id)?;
            for target in &targets {
                let target_path = PathBuf::from(&target.target_path);
                sync_engine::remove_target(&target_path).ok();
            }

            let central = PathBuf::from(&skill.central_path);
            if central.exists() {
                std::fs::remove_dir_all(&central).ok();
            }

            store.delete_skill(skill_id)?;
            store.log_audit(
                AuditDraft::new("remove")
                    .skill(skill_id.clone(), skill.name.clone())
                    .ok(),
            );
            deleted += 1;
        }

        if deleted > 0 {
            sync_metadata::write_all_from_db_unlocked(store)?;
        }

        Ok(BatchDeleteSkillsResult { deleted, failed })
    })
    .map_err(AppError::db)
}

/// Append an audit log entry summarising an install attempt.
/// `source_label` is short text identifying the source (e.g. "local", "git", "skillssh").
fn log_install_outcome(
    store: &SkillStore,
    source_label: &str,
    outcome: Result<&(String, String), &AppError>,
) {
    let draft = AuditDraft::new("install").detail(source_label);
    let draft = match outcome {
        Ok((id, name)) => draft.skill(id.clone(), name.clone()).ok(),
        Err(e) => draft.fail(e.to_string()),
    };
    store.log_audit(draft);
}

fn log_update_outcome(
    store: &SkillStore,
    skill_id: &str,
    source_label: &str,
    outcome: Result<&UpdateSkillResult, &AppError>,
) {
    let mut draft = AuditDraft::new("update").detail(source_label);
    match outcome {
        Ok(result) if !result.pending_removals.is_empty() => {
            // Held back, not applied. Recording it as a successful "unchanged"
            // would make the audit trail disagree with what actually happened.
            draft = draft
                .skill(result.skill.id.clone(), result.skill.name.clone())
                .detail(format!(
                    "{source_label}; held back — would remove {} path(s)",
                    result.pending_removals.len()
                ))
                .ok();
        }
        Ok(result) => {
            draft = draft
                .skill(result.skill.id.clone(), result.skill.name.clone())
                .detail(if result.content_changed {
                    format!("{source_label}; content changed")
                } else {
                    format!("{source_label}; unchanged")
                })
                .ok();
        }
        Err(e) => {
            let name = store
                .get_skill_by_id(skill_id)
                .ok()
                .flatten()
                .map(|s| s.name)
                .unwrap_or_default();
            draft = draft.skill(skill_id.to_string(), name).fail(e.to_string());
        }
    }
    store.log_audit(draft);
}

fn log_reimport_outcome(
    store: &SkillStore,
    skill_id: &str,
    outcome: Result<&ReimportSkillResult, &AppError>,
) {
    let mut draft = AuditDraft::new("update").detail("local");
    match outcome {
        Ok(result) if !result.pending_removals.is_empty() => {
            draft = draft
                .skill(result.skill.id.clone(), result.skill.name.clone())
                .detail(format!(
                    "local; held back — would remove {} path(s)",
                    result.pending_removals.len()
                ))
                .ok();
        }
        Ok(result) => {
            draft = draft
                .skill(result.skill.id.clone(), result.skill.name.clone())
                .ok();
        }
        Err(e) => {
            let name = store
                .get_skill_by_id(skill_id)
                .ok()
                .flatten()
                .map(|s| s.name)
                .unwrap_or_default();
            draft = draft.skill(skill_id.to_string(), name).fail(e.to_string());
        }
    }
    store.log_audit(draft);
}

#[tauri::command]
pub async fn install_local(
    source_path: String,
    name: Option<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = (|| -> Result<(String, String), AppError> {
            let path = PathBuf::from(&source_path);
            let metadata = InstallSourceMetadata {
                source_type: "local".to_string(),
                source_ref: Some(source_path.clone()),
                source_ref_resolved: None,
                source_subpath: None,
                source_branch: None,
                source_revision: None,
                remote_revision: None,
                update_status: "local_only".to_string(),
            };
            let _lock =
                RepoLock::acquire_foreground("install local skill").map_err(AppError::db)?;
            let result =
                installer::install_from_local(&path, name.as_deref()).map_err(AppError::io)?;
            let skill_name = result.name.clone();
            // Install only adds the skill to the central library; preset
            // membership is an explicit action (see issue #213).
            let skill_id = store_installed_skill_unlocked(&store, &result, &metadata, None)?;
            Ok((skill_id, skill_name))
        })();
        log_install_outcome(&store, "local", outcome.as_ref());
        outcome.map(|_| ())
    })
    .await?
}

#[tauri::command]
pub async fn install_git(
    repo_url: String,
    name: Option<String>,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    let registry = cancel_registry.inner().clone();
    let cancel_key = repo_url.clone();
    let cancel = registry.register(&cancel_key);
    let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key);

    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let emit_progress = |phase: &str| {
            app_handle
                .emit(
                    "install-progress",
                    serde_json::json!({
                        "skill_id": repo_url,
                        "phase": phase,
                    }),
                )
                .ok();
        };

        let outcome = (|| -> Result<(String, String), AppError> {
            git_fetcher::validate_git_url(&repo_url).map_err(AppError::git)?;
            emit_progress("cloning");
            let parsed = git_fetcher::parse_git_source_resolved(&repo_url, proxy_url.as_deref());
            let app_for_progress = app_handle.clone();
            let url_for_progress = repo_url.clone();
            let progress_cb: git_fetcher::ProgressCallback = Box::new(move |msg: &str| {
                app_for_progress
                    .emit(
                        "install-progress",
                        serde_json::json!({
                            "skill_id": url_for_progress,
                            "phase": "cloning",
                            "detail": msg,
                        }),
                    )
                    .ok();
            });
            let temp_dir = git_fetcher::clone_repo_ref_with_progress(
                &parsed.clone_url,
                parsed.branch.as_deref(),
                Some(&cancel),
                proxy_url.as_deref(),
                Some(progress_cb),
            )
            .map_err(AppError::classify_git_error)?;

            emit_progress("installing");
            let install_result = (|| -> Result<(String, String), AppError> {
                let _lock =
                    RepoLock::acquire_foreground("install git skill").map_err(AppError::db)?;
                let skill_dir = resolve_skill_dir(&temp_dir, parsed.subpath.as_deref(), None)?;
                let revision = git_fetcher::get_head_revision(&temp_dir).map_err(AppError::git)?;
                let result = installer::install_from_git_dir(&skill_dir, name.as_deref())
                    .map_err(AppError::io)?;
                let metadata = InstallSourceMetadata {
                    source_type: "git".to_string(),
                    source_ref: Some(parsed.original_url.clone()),
                    source_ref_resolved: Some(parsed.clone_url.clone()),
                    source_subpath: git_fetcher::relative_subpath(&temp_dir, &skill_dir),
                    source_branch: parsed.branch.clone(),
                    source_revision: Some(revision.clone()),
                    remote_revision: Some(revision),
                    update_status: "up_to_date".to_string(),
                };
                let skill_name = result.name.clone();
                let skill_id = store_installed_skill_unlocked(&store, &result, &metadata, None)?;
                Ok((skill_id, skill_name))
            })();

            git_fetcher::cleanup_temp(&temp_dir);
            install_result
        })();

        log_install_outcome(&store, "git", outcome.as_ref());
        outcome?;

        emit_progress("done");
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn install_from_skillssh(
    source: String,
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    let registry = cancel_registry.inner().clone();
    let cancel_key_owned = format!("{}/{}", source, skill_id);
    let cancel = registry.register(&cancel_key_owned);
    let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key_owned);

    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let skill_key = format!("{}/{}", source, skill_id);
        let emit_progress = |phase: &str| {
            app_handle
                .emit(
                    "install-progress",
                    serde_json::json!({
                        "skill_id": skill_key,
                        "phase": phase,
                    }),
                )
                .ok();
        };

        let outcome = (|| -> Result<(String, String), AppError> {
            emit_progress("cloning");
            let repo_url = format!("https://github.com/{}.git", source);
            let app_for_progress = app_handle.clone();
            let skill_key_for_progress = skill_key.clone();
            let progress_cb: git_fetcher::ProgressCallback = Box::new(move |msg: &str| {
                app_for_progress
                    .emit(
                        "install-progress",
                        serde_json::json!({
                            "skill_id": skill_key_for_progress,
                            "phase": "cloning",
                            "detail": msg,
                        }),
                    )
                    .ok();
            });
            let temp_dir = git_fetcher::clone_repo_ref_with_progress(
                &repo_url,
                None,
                Some(&cancel),
                proxy_url.as_deref(),
                Some(progress_cb),
            )
            .map_err(AppError::classify_git_error)?;

            emit_progress("installing");
            let install_result = (|| -> Result<(String, String), AppError> {
                let _lock =
                    RepoLock::acquire_foreground("install skillssh skill").map_err(AppError::db)?;
                let skill_dir = resolve_skill_dir(&temp_dir, None, Some(&skill_id))?;
                let revision = git_fetcher::get_head_revision(&temp_dir).map_err(AppError::git)?;
                let source_ref = format!("{}/{}", source, skill_id);
                let (install_name, destination) =
                    resolve_skillssh_install_target(&store, &source_ref, &skill_id)?;
                let result = installer::install_skill_dir_to_destination(
                    &skill_dir,
                    &install_name,
                    &destination,
                )
                .map_err(AppError::io)?;
                let metadata = InstallSourceMetadata {
                    source_type: "skillssh".to_string(),
                    source_ref: Some(source_ref),
                    source_ref_resolved: Some(repo_url.clone()),
                    source_subpath: git_fetcher::relative_subpath(&temp_dir, &skill_dir),
                    source_branch: None,
                    source_revision: Some(revision.clone()),
                    remote_revision: Some(revision),
                    update_status: "up_to_date".to_string(),
                };
                let skill_name = result.name.clone();
                let new_id = store_installed_skill_unlocked(&store, &result, &metadata, None)?;
                Ok((new_id, skill_name))
            })();

            git_fetcher::cleanup_temp(&temp_dir);
            install_result
        })();

        log_install_outcome(&store, "skillssh", outcome.as_ref());
        outcome?;

        emit_progress("done");
        Ok(())
    })
    .await?
}

/// Clone a git repo and return a preview list of skills found, without installing.
/// The caller must follow up with `confirm_git_install` using the returned `temp_dir`.
#[tauri::command]
pub async fn preview_git_install(
    repo_url: String,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
    app_handle: tauri::AppHandle,
) -> Result<GitPreviewResult, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.get_setting("proxy_url").ok().flatten();
    let registry = cancel_registry.inner().clone();
    let cancel_key = repo_url.clone();
    let cancel = registry.register(&cancel_key);
    let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key);

    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        app_handle
            .emit(
                "install-progress",
                serde_json::json!({
                    "skill_id": repo_url,
                    "phase": "cloning",
                }),
            )
            .ok();

        let parsed = git_fetcher::parse_git_source_resolved(&repo_url, proxy_url.as_deref());
        let app_for_progress = app_handle.clone();
        let url_for_progress = repo_url.clone();
        let progress_cb: git_fetcher::ProgressCallback = Box::new(move |msg: &str| {
            app_for_progress
                .emit(
                    "install-progress",
                    serde_json::json!({
                        "skill_id": url_for_progress,
                        "phase": "cloning",
                        "detail": msg,
                    }),
                )
                .ok();
        });
        let temp_dir = git_fetcher::clone_repo_ref_with_progress(
            &parsed.clone_url,
            parsed.branch.as_deref(),
            Some(&cancel),
            proxy_url.as_deref(),
            Some(progress_cb),
        )
        .map_err(AppError::classify_git_error)?;

        let build_preview = || -> Result<GitPreviewResult, AppError> {
            let skill_dir = resolve_skill_dir(&temp_dir, parsed.subpath.as_deref(), None)?;
            let dirs = collect_git_skill_dirs(&skill_dir);

            let skills: Vec<GitSkillPreview> = dirs
                .iter()
                .map(|dir| {
                    let meta = skill_metadata::parse_skill_md(dir);
                    let rel_path = skill_rel_key(&skill_dir, dir);
                    let basename = dir
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| rel_path.clone());
                    let name = meta
                        .name
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| basename.clone());
                    GitSkillPreview {
                        rel_path,
                        name,
                        description: meta.description,
                    }
                })
                .collect();

            Ok(GitPreviewResult {
                temp_dir: temp_dir.to_string_lossy().to_string(),
                skills,
            })
        };

        build_preview().inspect_err(|_e| {
            git_fetcher::cleanup_temp(&temp_dir);
        })
    })
    .await?
}

/// Install selected skills from a previously cloned temp directory.
#[tauri::command]
pub async fn confirm_git_install(
    repo_url: String,
    temp_dir: String,
    items: Vec<SkillInstallItem>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    tauri::async_runtime::spawn_blocking(move || {
        let temp_path = validate_clone_temp_path(&temp_dir)?;

        let result: Result<(), AppError> = (|| {
            if items.is_empty() {
                return Ok(());
            }

            let parsed = git_fetcher::parse_git_source_resolved(&repo_url, proxy_url.as_deref());
            let skill_dir = resolve_skill_dir(&temp_path, parsed.subpath.as_deref(), None)?;
            let all_dirs = collect_git_skill_dirs(&skill_dir);
            let revision = git_fetcher::get_head_revision(&temp_path).map_err(AppError::git)?;
            let _lock =
                RepoLock::acquire_foreground("confirm git install").map_err(AppError::db)?;

            for dir in &all_dirs {
                let rel_key = skill_rel_key(&skill_dir, dir);
                let item = match items.iter().find(|i| i.rel_path == rel_key) {
                    Some(i) => i,
                    None => continue,
                };
                let custom_name = item.name.trim();
                let install_name = if custom_name.is_empty() {
                    None
                } else {
                    Some(custom_name)
                };
                let result =
                    installer::install_from_git_dir(dir, install_name).map_err(AppError::io)?;
                let subpath = git_fetcher::relative_subpath(&temp_path, dir);
                let metadata = InstallSourceMetadata {
                    source_type: "git".to_string(),
                    source_ref: Some(repo_url.clone()),
                    source_ref_resolved: Some(parsed.clone_url.clone()),
                    source_subpath: subpath,
                    source_branch: parsed.branch.clone(),
                    source_revision: Some(revision.clone()),
                    remote_revision: Some(revision.clone()),
                    update_status: "up_to_date".to_string(),
                };
                store_installed_skill_unlocked(&store, &result, &metadata, None)?;
            }
            Ok(())
        })();

        // Always clean up temp directory, regardless of success or failure.
        git_fetcher::cleanup_temp(&temp_path);
        result
    })
    .await?
}

/// Clean up temp directory from a cancelled preview session.
#[tauri::command]
pub async fn cancel_git_preview(temp_dir: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(temp_path) = validate_clone_temp_path(&temp_dir) {
            git_fetcher::cleanup_temp(&temp_path);
        }
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn check_skill_update(
    skill_id: String,
    force: Option<bool>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<ManagedSkillDto, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    tauri::async_runtime::spawn_blocking(move || {
        let force = force.unwrap_or(false);
        // Resolve first, take the lock second. Holding it across `ls-remote`
        // meant one check of a slow remote could occupy the repository for the
        // whole round-trip and fail every concurrent operation (#315).
        let prefetched = prefetch_skill_remote(&store, &skill_id, force, proxy_url.as_deref());
        let _lock = RepoLock::acquire_foreground("check skill update").map_err(AppError::db)?;
        check_skill_update_internal_with_remote(&store, &skill_id, force, prefetched)
    })
    .await?
}

struct StoredSkillUpdateCheckAdapter<'a> {
    store: &'a SkillStore,
}

impl SkillUpdateCheckAdapter for StoredSkillUpdateCheckAdapter<'_> {
    fn remote_key(&self, skill: &SkillRecord, force_check: bool) -> Option<RemoteKey> {
        if !matches!(skill.source_type.as_str(), "git" | "skillssh") {
            return None;
        }
        match should_skip_update_check(self.store, skill, force_check) {
            Ok(true) => return None,
            Ok(false) => {}
            Err(err) => log::warn!(
                "Skill 检查批次：{} 的跳过判断失败，将继续检查：{}",
                skill.id,
                err.message
            ),
        }
        let source = git_source_from_skill(skill).ok()?;
        Some(RemoteKey::new(source.clone_url, source.branch))
    }

    fn apply_check(
        &self,
        skill: &SkillRecord,
        force_check: bool,
        prefetched: Option<PrefetchedRemote>,
    ) -> Result<CheckedSkillState, String> {
        let _lock = RepoLock::acquire("check skill update").map_err(|err| err.to_string())?;
        let checked =
            check_skill_update_internal_with_remote(self.store, &skill.id, force_check, prefetched)
                .map_err(|err| err.message)?;
        Ok(CheckedSkillState {
            update_status: checked.update_status,
            last_check_error: checked.last_check_error,
            last_checked_at: checked.last_checked_at,
        })
    }
}

#[tauri::command]
pub async fn check_all_skill_updates(
    force: Option<bool>,
    batch_id: Option<String>,
    app: tauri::AppHandle,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
) -> Result<CheckSkillUpdatesBatchResult, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    let foreground_batch_id = batch_id.filter(|value| !value.trim().is_empty());
    let registry = cancel_registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let force_check = force.unwrap_or(false);
        if let Some(batch_id) = foreground_batch_id {
            let cancel_key = skill_update_batch_cancel_key(&batch_id);
            let stop = registry.register_or_get(&cancel_key);
            let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key);
            run_foreground_skill_update_checks(
                &store,
                &batch_id,
                force_check,
                None,
                &stop,
                proxy_url.as_deref(),
                &app,
            )
        } else {
            let adapter = StoredSkillUpdateCheckAdapter { store: &store };
            skill_update_batch::check_background(
                &store,
                &adapter,
                force_check,
                |key, skill_ids| {
                    resolve_remote_content_for_check(
                        &store,
                        key,
                        skill_ids,
                        proxy_url.as_deref(),
                        None,
                    )
                },
            )?;
            Ok(CheckSkillUpdatesBatchResult {
                batch_id: uuid::Uuid::now_v7().to_string(),
                stopped: false,
                skipped: 0,
                items: Vec::new(),
            })
        }
    })
    .await?
}

#[tauri::command]
pub async fn retry_failed_skill_update_checks(
    skill_ids: Vec<String>,
    batch_id: String,
    app: tauri::AppHandle,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
) -> Result<CheckSkillUpdatesBatchResult, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    let registry = cancel_registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cancel_key = skill_update_batch_cancel_key(&batch_id);
        let stop = registry.register_or_get(&cancel_key);
        let _cancel_guard = CancelRegistrationGuard::new(registry, cancel_key);
        run_foreground_skill_update_checks(
            &store,
            &batch_id,
            true,
            Some(&skill_ids),
            &stop,
            proxy_url.as_deref(),
            &app,
        )
    })
    .await?
}

fn run_foreground_skill_update_checks(
    store: &SkillStore,
    batch_id: &str,
    force_check: bool,
    requested_skill_ids: Option<&[String]>,
    stop: &Arc<AtomicBool>,
    proxy_url: Option<&str>,
    app: &tauri::AppHandle,
) -> Result<CheckSkillUpdatesBatchResult, AppError> {
    let adapter = StoredSkillUpdateCheckAdapter { store };
    skill_update_batch::check_with_preferences(
        store,
        &adapter,
        ForegroundCheckBatch {
            batch_id,
            force_check,
            requested_skill_ids,
            stop: stop.as_ref(),
        },
        |key, skill_ids| {
            resolve_remote_content_for_check(store, key, skill_ids, proxy_url, Some(stop))
        },
        |event| {
            if let Err(err) = app.emit(SKILL_UPDATE_BATCH_PROGRESS_EVENT, event) {
                log::warn!("前台 Skill 检查：发送进度事件失败：{err}");
            }
        },
    )
}

/// 在中央仓库锁外解析一份仓库快照，并从同一个 checkout 计算全部指定 Skill 的有效内容哈希。
/// 远端修订已经对齐且存在持久化来源哈希时，可以完全跳过快照。
fn resolve_remote_content_for_check(
    store: &SkillStore,
    key: &RemoteKey,
    skill_ids: &[String],
    proxy_url: Option<&str>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<ResolvedRemote, String> {
    let remote_revision = git_fetcher::resolve_remote_revision_with_cancel(
        &key.clone_url,
        key.branch.as_deref(),
        proxy_url,
        cancel,
    )
    .map_err(|err| err.to_string())?;

    let mut requested = Vec::with_capacity(skill_ids.len());
    let mut needs_snapshot = false;
    for skill_id in skill_ids {
        let skill = store
            .get_skill_by_id(skill_id)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| format!("未找到 Skill：{skill_id}"))?;
        let source = git_source_from_skill(&skill).map_err(|err| err.message)?;
        let aligned_hash = store
            .get_skill_source_content_hash(skill_id)
            .map_err(|err| err.to_string())?;
        if !key.matches(&source.clone_url, source.branch.as_deref())
            || skill.source_ref_resolved.as_deref() != Some(source.clone_url.as_str())
            || skill.source_subpath.as_deref() != source.subpath.as_deref()
            || skill.source_branch.as_deref() != source.branch.as_deref()
            || skill.source_revision.as_deref() != Some(remote_revision.as_str())
            || aligned_hash.is_none()
        {
            needs_snapshot = true;
        }
        requested.push((skill, source, aligned_hash));
    }

    if !needs_snapshot {
        let skills = requested
            .into_iter()
            .map(|(skill, source, aligned_hash)| {
                (
                    skill.id,
                    RemoteSkillContent {
                        source_subpath: source.subpath,
                        locator_skill_id: source.locator_skill_id,
                        content_hash: Ok(aligned_hash.expect("已确认存在已对齐内容哈希")),
                    },
                )
            })
            .collect();
        return Ok(ResolvedRemote {
            revision: remote_revision,
            skills: Arc::new(skills),
        });
    }

    let temp_dir =
        git_fetcher::clone_repo_ref(&key.clone_url, key.branch.as_deref(), cancel, proxy_url)
            .map_err(|err| err.to_string())?;
    let result = (|| {
        // 分支可能在 ls-remote 与 clone 之间移动。所有哈希都绑定到实际落盘的修订，
        // 避免任何 Skill 记录混合快照。
        let snapshot_revision =
            git_fetcher::get_head_revision(&temp_dir).map_err(|err| err.to_string())?;
        let mut skills = HashMap::with_capacity(requested.len());
        for (skill, source, _) in requested {
            let content_hash = if !key.matches(&source.clone_url, source.branch.as_deref()) {
                Err("Skill 来源在检查期间发生变化，请重新检查".to_string())
            } else {
                resolve_skill_dir(
                    &temp_dir,
                    source.subpath.as_deref(),
                    source.locator_skill_id.as_deref(),
                )
                .and_then(|dir| {
                    crate::core::content_hash::hash_directory(&dir).map_err(AppError::io)
                })
                .map_err(|err| err.message)
            };
            skills.insert(
                skill.id,
                RemoteSkillContent {
                    source_subpath: source.subpath,
                    locator_skill_id: source.locator_skill_id,
                    content_hash,
                },
            );
        }
        Ok(ResolvedRemote {
            revision: snapshot_revision,
            skills: Arc::new(skills),
        })
    })();
    git_fetcher::cleanup_temp(&temp_dir);
    result
}

/// 在调用方取得中央仓库锁之前，准备一个 Skill 的远端修订与有效内容哈希。
/// 所有持锁的更新检查路径都经过这里；如果把缓慢的 `ls-remote` 或内容快照放在锁内，
/// 无关的前台操作会再次触发 20 秒 "repository is busy" 失败（#315）。
///
/// 本地 Skill、仍处于检查 TTL 内的 Skill 或无法解析的来源返回 `None`，
/// 后续持锁检查也不会联网。
pub fn prefetch_skill_remote(
    store: &SkillStore,
    skill_id: &str,
    force: bool,
    proxy_url: Option<&str>,
) -> Option<PrefetchedRemote> {
    let skill = store.get_skill_by_id(skill_id).ok().flatten()?;
    if !matches!(skill.source_type.as_str(), "git" | "skillssh") {
        return None;
    }
    if should_skip_update_check(store, &skill, force).unwrap_or(false) {
        return None;
    }
    let source = git_source_from_skill(&skill).ok()?;
    let key = RemoteKey::new(source.clone_url, source.branch);
    let result = resolve_remote_content_for_check(
        store,
        &key,
        std::slice::from_ref(&skill.id),
        proxy_url,
        None,
    );
    Some(skill_update_batch::prefetched_remote(key, result))
}

/// Update one skill.
///
/// `approved_removals` carries back `removal_approval` from a call that
/// declined. The first call from the UI passes `None`; if it comes back with
/// `pending_removals`, the user is shown exactly what would disappear and only
/// then is it called again with that token.
#[tauri::command]
pub async fn update_skill(
    skill_id: String,
    approved_removals: Option<String>,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
) -> Result<UpdateSkillResult, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    let registry = cancel_registry.inner().clone();
    let cancel_key = format!("update:{}", skill_id);
    let cancel = registry.register(&cancel_key);
    let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key);

    tauri::async_runtime::spawn_blocking(move || {
        let outcome = update_git_skill_internal(
            &store,
            &skill_id,
            proxy_url.as_deref(),
            Some(&cancel),
            approved_removals.as_deref(),
        );
        log_update_outcome(&store, &skill_id, "git", outcome.as_ref());
        outcome
    })
    .await?
}

#[tauri::command]
pub async fn reimport_local_skill(
    skill_id: String,
    approved_removals: Option<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<ReimportSkillResult, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome =
            reimport_local_skill_internal(&store, &skill_id, approved_removals.as_deref());
        log_reimport_outcome(&store, &skill_id, outcome.as_ref());
        outcome
    })
    .await?
}

fn execute_batch_update(
    store: &SkillStore,
    skill: &SkillRecord,
    proxy_url: Option<&str>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<BatchUpdateExecution, String> {
    match skill.source_type.as_str() {
        "git" | "skillssh" => {
            let outcome = update_git_skill_internal(store, &skill.id, proxy_url, cancel, None);
            log_update_outcome(store, &skill.id, "git", outcome.as_ref());
            match outcome {
                Ok(result) if !result.pending_removals.is_empty() => {
                    Ok(BatchUpdateExecution::NeedsConfirmation {
                        pending_removals: result.pending_removals,
                        removal_approval: result.removal_approval,
                    })
                }
                Ok(result) if result.content_changed => Ok(BatchUpdateExecution::Updated),
                Ok(_) => Ok(BatchUpdateExecution::Unchanged),
                Err(err) => Err(err.message),
            }
        }
        "local" | "import" => {
            let outcome = reimport_local_skill_internal(store, &skill.id, None);
            log_reimport_outcome(store, &skill.id, outcome.as_ref());
            match outcome {
                Ok(result) if !result.pending_removals.is_empty() => {
                    Ok(BatchUpdateExecution::NeedsConfirmation {
                        pending_removals: result.pending_removals,
                        removal_approval: result.removal_approval,
                    })
                }
                Ok(_) => Ok(BatchUpdateExecution::Updated),
                Err(err) => Err(err.message),
            }
        }
        _ => Err("来源类型不支持刷新".to_string()),
    }
}

#[tauri::command]
pub async fn batch_update_skills(
    skill_ids: Vec<String>,
    batch_id: Option<String>,
    app: tauri::AppHandle,
    store: State<'_, Arc<SkillStore>>,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
) -> Result<BatchUpdateSkillsResult, AppError> {
    let store = store.inner().clone();
    let proxy_url = store.proxy_url();
    let registry = cancel_registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(batch_id) = batch_id.filter(|value| !value.trim().is_empty()) {
            let cancel_key = skill_update_batch_cancel_key(&batch_id);
            let stop = registry.register_or_get(&cancel_key);
            let _cancel_guard = CancelRegistrationGuard::new(registry.clone(), cancel_key);
            return skill_update_batch::update_with_preferences(
                &store,
                &batch_id,
                skill_ids,
                &stop,
                |skill| execute_batch_update(&store, skill, proxy_url.as_deref(), Some(&stop)),
                |event| {
                    if let Err(err) = app.emit(SKILL_UPDATE_BATCH_PROGRESS_EVENT, event) {
                        log::warn!("全部更新：发送进度事件失败：{err}");
                    }
                },
            );
        }

        let mut refreshed = 0usize;
        let mut unchanged = 0usize;
        let mut failed = Vec::new();
        let mut held_back = Vec::new();

        for skill_id in skill_ids {
            let skill = match store.get_skill_by_id(&skill_id).map_err(AppError::db)? {
                Some(skill) => skill,
                None => {
                    failed.push(format!("{skill_id}: 未找到 Skill"));
                    continue;
                }
            };
            match execute_batch_update(&store, &skill, proxy_url.as_deref(), None) {
                Ok(BatchUpdateExecution::Updated) => refreshed += 1,
                Ok(BatchUpdateExecution::Unchanged) => unchanged += 1,
                Ok(BatchUpdateExecution::NeedsConfirmation { .. }) => {
                    held_back.push(skill.name.clone());
                }
                Err(message) => failed.push(format!("{}: {message}", skill.name)),
            }
        }

        Ok(BatchUpdateSkillsResult {
            batch_id: None,
            stopped: false,
            refreshed,
            unchanged,
            failed,
            held_back,
            items: Vec::new(),
        })
    })
    .await?
}

#[tauri::command]
pub async fn stop_skill_update_batch(
    batch_id: String,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
) -> Result<bool, AppError> {
    cancel_registry.cancel_or_register(&skill_update_batch_cancel_key(&batch_id));
    Ok(true)
}

#[tauri::command]
/// Re-point a local skill at a different source directory.
///
/// `approved_removals` behaves as on the update paths: choosing a new source is
/// not a statement about discarding what the library has accumulated, so a
/// replacement that would take files away stops and reports them first.
pub async fn relink_local_skill_source(
    skill_id: String,
    source_path: String,
    approved_removals: Option<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<ReimportSkillResult, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        if !matches!(skill.source_type.as_str(), "local" | "import") {
            return Err(AppError::invalid_input(
                "Only local skills can relink source paths",
            ));
        }

        let path = PathBuf::from(&source_path);
        if !path.exists() {
            return Err(AppError::not_found("Selected source path does not exist"));
        }
        if !is_valid_skill_dir(&path) {
            return Err(AppError::invalid_input(
                "Selected source path is not a valid skill directory",
            ));
        }

        store
            .update_skill_update_status(&skill_id, "updating")
            .map_err(AppError::db)?;

        let result = (|| -> Result<(Vec<PendingRemoval>, Option<String>), AppError> {
            let _lock = RepoLock::acquire_foreground("relink local skill").map_err(AppError::db)?;
            let staged_path = staged_path_for(&skill.central_path);
            let install_result = installer::install_from_local_to_destination(
                &path,
                Some(&skill.name),
                &staged_path,
            )
            .inspect_err(|_| {
                let _ = remove_path_if_exists(&staged_path);
            })
            .map_err(AppError::io)?;
            let staged_guard = StagedPathGuard::new(&staged_path, true);

            // Picking a new source says which source to follow. It does not say
            // to discard whatever has accumulated in the library since — same
            // replacement, same guard.
            let pending = pending_removals_for(&store, &skill, Some(&staged_path))?;
            let approval = removal_approval_token(&source_path, &pending);
            if !pending.is_empty() && approved_removals.as_deref() != Some(approval.as_str()) {
                // Put back exactly what was there. Hardcoding a status loses
                // `source_missing` — the only state relink is reachable from —
                // so declining would hide the Relink and Detach buttons on the
                // next refresh, and `check_state` would also clear the recorded
                // error and check time that nothing here has re-established.
                store
                    .update_skill_update_status(&skill.id, &skill.update_status)
                    .map_err(AppError::db)?;
                return Ok((pending, Some(approval)));
            }

            swap_skill_directory(&staged_path, Path::new(&skill.central_path))?;
            staged_guard.release();
            store
                .update_skill_after_reinstall(
                    &skill.id,
                    &skill.name,
                    install_result.description.as_deref(),
                    &skill.source_type,
                    Some(&source_path),
                    None,
                    None,
                    None,
                    None,
                    None,
                    Some(&install_result.content_hash),
                    "local_only",
                )
                .map_err(AppError::db)?;
            resync_copy_targets(&store, &skill.id)?;
            sync_metadata::write_all_from_db_unlocked(&store).map_err(AppError::db)?;
            Ok((Vec::new(), None))
        })();

        match result {
            Ok((pending_removals, removal_approval)) => Ok(ReimportSkillResult {
                skill: managed_skill_by_id(&store, &skill_id)?,
                pending_removals,
                removal_approval,
            }),
            Err(e) => {
                let _ = store.update_skill_check_state(&skill_id, None, "error", Some(&e.message));
                Err(e)
            }
        }
    })
    .await?
}

#[tauri::command]
pub async fn detach_local_skill_source(
    skill_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<ManagedSkillDto, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let skill = store
            .get_skill_by_id(&skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill not found"))?;

        if !matches!(skill.source_type.as_str(), "local" | "import") {
            return Err(AppError::invalid_input(
                "Only local skills can detach source paths",
            ));
        }

        {
            let _lock = RepoLock::acquire_foreground("detach local skill").map_err(AppError::db)?;
            store
                .update_skill_after_reinstall(
                    &skill.id,
                    &skill.name,
                    skill.description.as_deref(),
                    &skill.source_type,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    skill.content_hash.as_deref(),
                    "local_only",
                )
                .map_err(AppError::db)?;
            sync_metadata::write_all_from_db_unlocked(&store).map_err(AppError::db)?;
        }

        managed_skill_by_id(&store, &skill_id)
    })
    .await?
}

fn managed_skill_to_dto(
    store: &SkillStore,
    skill: SkillRecord,
    all_targets: &[SkillTargetRecord],
    tags_map: &std::collections::HashMap<String, Vec<String>>,
) -> ManagedSkillDto {
    let can_check_update = is_checkable_update_skill(&skill);
    let targets = all_targets
        .iter()
        .filter(|target| target.skill_id == skill.id)
        .map(|target| TargetDto {
            id: target.id.clone(),
            skill_id: target.skill_id.clone(),
            tool: target.tool.clone(),
            target_path: target.target_path.clone(),
            mode: target.mode.clone(),
            status: target.status.clone(),
            synced_at: target.synced_at,
        })
        .collect();

    let preset_ids = store.get_scenarios_for_skill(&skill.id).unwrap_or_default();
    let tags = tags_map.get(&skill.id).cloned().unwrap_or_default();

    // Prefer description from SKILL.md so the list view reflects edits made
    // directly on disk (file watcher emits a change event; this read serves
    // the fresh value). Keep `name` on the DB value to avoid drift with
    // sync target directory names.
    let description = skill_metadata::parse_skill_md(Path::new(&skill.central_path))
        .description
        .filter(|s| !s.trim().is_empty())
        .or(skill.description);

    ManagedSkillDto {
        id: skill.id,
        name: skill.name,
        description,
        source_type: skill.source_type,
        source_ref: skill.source_ref,
        source_ref_resolved: skill.source_ref_resolved,
        source_subpath: skill.source_subpath,
        source_branch: skill.source_branch,
        source_revision: skill.source_revision,
        remote_revision: skill.remote_revision,
        update_status: skill.update_status,
        last_checked_at: skill.last_checked_at,
        last_check_error: skill.last_check_error,
        central_path: skill.central_path,
        enabled: skill.enabled,
        created_at: skill.created_at,
        updated_at: skill.updated_at,
        status: skill.status,
        targets,
        preset_ids,
        tags,
        can_check_update,
    }
}

pub fn managed_skill_by_id(
    store: &SkillStore,
    skill_id: &str,
) -> Result<ManagedSkillDto, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;
    let all_targets = store.get_all_targets().map_err(AppError::db)?;
    let tags_map = store.get_tags_map().map_err(AppError::db)?;
    Ok(managed_skill_to_dto(store, skill, &all_targets, &tags_map))
}

/// 判断来源有效内容是否会改变中央技能库当前真实内容。
fn source_differs_from_current_central(
    central_path: &Path,
    source_hash: &str,
) -> Result<bool, AppError> {
    let central_hash =
        crate::core::content_hash::hash_directory(central_path).map_err(AppError::io)?;
    Ok(central_hash != source_hash)
}

/// Update an installed git-sourced skill.
///
/// `approved_removals` carries back the token from a previous call that
/// declined, approving exactly the list it reported at exactly that revision.
/// Without it — or with a stale one — an update that would take away files the
/// new version does not have stops and reports them instead, having changed
/// nothing. See [`crate::core::removals`].
///
/// Unattended callers pass `None` and simply do not update: nobody is there to
/// be asked, and applying anyway is what #256 was.
pub fn update_git_skill_internal(
    store: &SkillStore,
    skill_id: &str,
    proxy_url: Option<&str>,
    cancel: Option<&Arc<AtomicBool>>,
    approved_removals: Option<&str>,
) -> Result<UpdateSkillResult, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;

    if !matches!(skill.source_type.as_str(), "git" | "skillssh") {
        return Err(AppError::invalid_input(
            "Only git-based skills can be updated",
        ));
    }

    let git_source = git_source_from_skill(&skill)?;
    git_fetcher::validate_git_url(&git_source.clone_url).map_err(AppError::git)?;
    let remote_revision = git_fetcher::resolve_remote_revision_with_cancel(
        &git_source.clone_url,
        git_source.branch.as_deref(),
        proxy_url,
        cancel,
    )
    .map_err(|e| {
        let message = e.to_string();
        let _ = store.update_skill_check_state(
            skill_id,
            skill.remote_revision.as_deref(),
            "error",
            Some(&message),
        );
        AppError::git(message)
    })?;

    store
        .update_skill_update_status(skill_id, "updating")
        .map_err(AppError::db)?;

    let temp_dir = git_fetcher::clone_repo_ref(
        &git_source.clone_url,
        git_source.branch.as_deref(),
        cancel,
        proxy_url,
    )
    .map_err(AppError::classify_git_error)?;
    let update_result = (|| -> Result<UpdateOutcome, AppError> {
        git_fetcher::checkout_revision(&temp_dir, &remote_revision).map_err(AppError::git)?;
        let skill_dir = resolve_skill_dir(
            &temp_dir,
            git_source.subpath.as_deref(),
            git_source.locator_skill_id.as_deref(),
        )?;

        let new_hash =
            crate::core::content_hash::hash_directory(&skill_dir).map_err(AppError::io)?;
        let source_subpath = git_fetcher::relative_subpath(&temp_dir, &skill_dir);
        let _lock = RepoLock::acquire_foreground("update installed skill").map_err(AppError::db)?;
        let content_changed =
            source_differs_from_current_central(Path::new(&skill.central_path), &new_hash)?;

        // Stage first, then compare. The tree that lands in the library is the
        // installer's output, not the raw checkout — it drops `.git` and every
        // symlink — so comparing against the checkout would report a path as
        // surviving that the swap then removes.
        let staged_path = staged_path_for(&skill.central_path);
        let install_result = if content_changed {
            Some(
                installer::install_skill_dir_to_destination(&skill_dir, &skill.name, &staged_path)
                    .inspect_err(|_| {
                        let _ = remove_path_if_exists(&staged_path);
                    })
                    .map_err(AppError::io)?,
            )
        } else {
            None
        };
        let staged_guard = StagedPathGuard::new(&staged_path, install_result.is_some());

        let pending = pending_removals_for(
            store,
            &skill,
            install_result.is_some().then_some(staged_path.as_path()),
        )?;

        // 一次确认只回答一个精确问题：是否批准当前修订与当前展示的列表。对话框打开期间，
        // push 或改变列表的文件都会要求重新确认。新版本要删除的目录只算一个条目，因此
        // 之后在该目录内部创建文件不会改变列表；批准 `outputs/` 等于批准整个子树。
        // 扫描到实际删除之间不能再缩小窗口：仓库锁会阻止 Agent 技能管家写入这些目录，
        // 但不能阻止 Agent 进程。若要进一步收紧，必须在扫描前冻结目录，而不是再次扫描。
        let approval = removal_approval_token(&remote_revision, &pending);
        if !pending.is_empty() && approved_removals != Some(approval.as_str()) {
            // Declining is not a failure: nothing was touched and the update is
            // still waiting. Clear the `updating` marker here, inside the lock,
            // rather than after releasing it — doing it later lets a concurrent
            // update overwrite the state, and swallowing the error would leave
            // the skill showing "updating" forever.
            store
                .update_skill_check_state(
                    &skill.id,
                    Some(&remote_revision),
                    "update_available",
                    None,
                )
                .map_err(AppError::db)?;
            return Ok(UpdateOutcome::Held { pending, approval });
        }

        if let Some(install_result) = install_result {
            swap_skill_directory(&staged_path, Path::new(&skill.central_path))?;
            // Only now is it the library's. Releasing before the swap left the
            // staged directory behind whenever its first rename failed.
            staged_guard.release();

            store
                .update_skill_source_metadata(
                    &skill.id,
                    Some(&git_source.clone_url),
                    source_subpath.as_deref(),
                    git_source.branch.as_deref(),
                    Some(&remote_revision),
                )
                .map_err(AppError::db)?;
            store
                .update_skill_after_install(
                    &skill.id,
                    &skill.name,
                    install_result.description.as_deref(),
                    Some(&remote_revision),
                    Some(&remote_revision),
                    Some(&install_result.content_hash),
                    "up_to_date",
                )
                .map_err(AppError::db)?;
            store
                .set_skill_source_content_hash(&skill.id, Some(&install_result.content_hash))
                .map_err(AppError::db)?;
            resync_copy_targets(store, &skill.id)?;
            sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;
        } else {
            store
                .update_skill_source_metadata(
                    &skill.id,
                    Some(&git_source.clone_url),
                    source_subpath.as_deref(),
                    git_source.branch.as_deref(),
                    Some(&remote_revision),
                )
                .map_err(AppError::db)?;
            store
                .update_skill_content_alignment(&skill.id, &remote_revision, &new_hash, &new_hash)
                .map_err(AppError::db)?;
            resync_copy_targets(store, &skill.id)?;
            sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;
        }
        Ok(UpdateOutcome::Applied { content_changed })
    })();
    git_fetcher::cleanup_temp(&temp_dir);

    match update_result {
        Ok(outcome) => {
            let (content_changed, pending_removals, removal_approval) = match outcome {
                UpdateOutcome::Applied { content_changed } => (content_changed, Vec::new(), None),
                UpdateOutcome::Held { pending, approval } => (false, pending, Some(approval)),
            };
            let skill = managed_skill_by_id(store, skill_id)?;
            Ok(UpdateSkillResult {
                skill,
                content_changed,
                pending_removals,
                removal_approval,
            })
        }
        Err(e) => {
            let _ = store.update_skill_check_state(
                skill_id,
                Some(&remote_revision),
                "error",
                Some(&e.message),
            );
            Err(e)
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SetSourceResult {
    pub skill_id: String,
    pub name: String,
    /// Source type before the change (`local`, `import`, `git`, `skillssh`).
    pub previous_source_type: String,
    pub previous_source_ref: Option<String>,
    pub clone_url: String,
    pub subpath: Option<String>,
    pub branch: Option<String>,
    pub revision: String,
    /// Whether the new source's content differs from the hash recorded for the
    /// library copy. False means the re-point is metadata-only — no file is
    /// rewritten. Compared against the recorded hash, not a fresh hash of the
    /// central directory, so hand-edits made after install do not count as a
    /// difference (and are left in place, since no file work runs).
    pub content_changed: bool,
    pub dry_run: bool,
}

/// Resolve the skill directory inside a fresh checkout, strictly.
///
/// Unlike [`resolve_skill_dir`], an explicit subpath that does not land on a
/// valid skill directory inside `repo_dir` is an error rather than a silent
/// fallback to repo-wide discovery. Re-pointing establishes a *new* source of
/// truth for an already-installed skill, so guessing is worse than failing: a
/// typo would otherwise install some unrelated directory — or the whole repo —
/// over the existing central copy.
fn resolve_repoint_skill_dir(repo_dir: &Path, subpath: Option<&str>) -> Result<PathBuf, AppError> {
    let Some(subpath) = subpath else {
        return if is_valid_skill_dir(repo_dir) {
            Ok(repo_dir.to_path_buf())
        } else {
            Err(AppError::invalid_input(
                "Repository root is not a skill directory (no SKILL.md); pass --subpath",
            ))
        };
    };

    // `Path::join` returns the argument verbatim when it is absolute, and `..`
    // segments climb out, so the candidate must be checked before it is used.
    // `is_path_safe` canonicalizes both sides, which also catches symlinks that
    // point outside the checkout.
    let candidate = repo_dir.join(subpath);
    if !path_guard::is_path_safe(repo_dir, &candidate) {
        return Err(AppError::invalid_input(format!(
            "Subpath '{subpath}' resolves outside the repository"
        )));
    }
    if !candidate.is_dir() {
        return Err(AppError::not_found(format!(
            "Subpath '{subpath}' does not exist in the repository"
        )));
    }
    if !is_valid_skill_dir(&candidate) {
        return Err(AppError::invalid_input(format!(
            "Subpath '{subpath}' is not a skill directory (no SKILL.md)"
        )));
    }
    Ok(candidate)
}

/// Re-point an installed skill at a git source **in place**.
///
/// The skill row is updated by id, so the skill id, tags, preset membership and
/// deployment targets all survive. This is the only safe way to convert a
/// `local` skill to a `git` one: `install` reuses a central directory only when
/// the content hash matches exactly (see `installer::unique_skill_dest`) and
/// otherwise silently allocates `<name>-2`, while `remove` + `install` drops the
/// id and everything keyed to it.
///
/// When the new source's content differs from the current central copy the
/// command refuses unless `force` is set. Re-pointing is not an update: the
/// remote is not yet known to be the authoritative copy, so overwriting local
/// content that may exist nowhere else has to be a deliberate choice.
#[allow(clippy::too_many_arguments)]
pub fn set_git_source_internal(
    store: &SkillStore,
    skill_id: &str,
    git_url: &str,
    subpath: Option<&str>,
    branch: Option<&str>,
    proxy_url: Option<&str>,
    force: bool,
    dry_run: bool,
) -> Result<SetSourceResult, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;

    // Validate before parsing: resolving a GitHub tree URL runs `ls-remote`, so
    // an unvalidated URL would reach the network first. `install` validates its
    // raw input the same way.
    git_fetcher::validate_git_url(git_url).map_err(AppError::git)?;
    let parsed = git_fetcher::parse_git_source_resolved(git_url, proxy_url);

    // An explicit flag wins over whatever the URL encodes. `--subpath ""` is the
    // caller saying "the skill is at the repo root", which is distinct from
    // omitting the flag and letting the URL decide.
    let branch = branch.map(str::to_string).or_else(|| parsed.branch.clone());
    let subpath = match subpath {
        Some("") => None,
        Some(value) => Some(value.to_string()),
        None => parsed.subpath.clone(),
    };

    let remote_revision =
        git_fetcher::resolve_remote_revision(&parsed.clone_url, branch.as_deref(), proxy_url)
            .map_err(|e| AppError::git(e.to_string()))?;

    let temp_dir =
        git_fetcher::clone_repo_ref(&parsed.clone_url, branch.as_deref(), None, proxy_url)
            .map_err(AppError::classify_git_error)?;

    // Nothing before this point has written to the store, so a failure during
    // the network phase leaves no state to unwind — in particular the skill is
    // never left stuck in `updating`.
    let marked_updating = std::cell::Cell::new(false);
    let source_committed = std::cell::Cell::new(false);
    let outcome = (|| -> Result<(String, bool), AppError> {
        git_fetcher::checkout_revision(&temp_dir, &remote_revision).map_err(AppError::git)?;
        let skill_dir = resolve_repoint_skill_dir(&temp_dir, subpath.as_deref())?;
        let resolved_subpath = git_fetcher::relative_subpath(&temp_dir, &skill_dir);

        let new_hash =
            crate::core::content_hash::hash_directory(&skill_dir).map_err(AppError::io)?;
        let content_changed = skill.content_hash.as_deref() != Some(new_hash.as_str());

        // Report before refusing: inspecting a skill whose content differs is
        // exactly what --dry-run is for, so it must not need --force to run.
        if dry_run {
            return Ok((resolved_subpath.unwrap_or_default(), content_changed));
        }
        if content_changed && !force {
            return Err(AppError::invalid_input(
                "New source content differs from the current library copy; \
                 re-run with --dry-run to inspect, or --force to overwrite",
            ));
        }

        let _lock = RepoLock::acquire_foreground("set skill source").map_err(AppError::db)?;

        // The clone happened outside the lock, so the skill may have been
        // removed or re-pointed meanwhile. Re-read and refuse to apply a
        // decision made against a stale snapshot.
        let current = store
            .get_skill_by_id(skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill was removed while fetching the source"))?;
        if current.central_path != skill.central_path
            || current.content_hash != skill.content_hash
            || current.source_type != skill.source_type
            || current.source_ref != skill.source_ref
        {
            return Err(AppError::invalid_input(
                "Skill changed while fetching the source; re-run the command",
            ));
        }

        store
            .update_skill_update_status(skill_id, "updating")
            .map_err(AppError::db)?;
        marked_updating.set(true);

        // Identical content needs no file work — swapping would rewrite the
        // central copy for a metadata-only change, and `installer` does not
        // copy exactly the set of files `content_hash` covers, so the rewrite
        // could alter files while still reporting `content_changed: false`.
        let description = if content_changed {
            let staged_path = staged_path_for(&skill.central_path);
            let install_result =
                installer::install_skill_dir_to_destination(&skill_dir, &skill.name, &staged_path)
                    .inspect_err(|_| {
                        let _ = std::fs::remove_dir_all(&staged_path);
                    })
                    .map_err(AppError::io)?;
            swap_skill_directory(&staged_path, Path::new(&skill.central_path))?;
            install_result.description
        } else {
            skill.description.clone()
        };

        store
            .update_skill_after_reinstall(
                &skill.id,
                &skill.name,
                description.as_deref(),
                "git",
                Some(&parsed.original_url),
                Some(&parsed.clone_url),
                resolved_subpath.as_deref(),
                branch.as_deref(),
                Some(&remote_revision),
                Some(&remote_revision),
                Some(&new_hash),
                "up_to_date",
            )
            .map_err(AppError::db)?;
        source_committed.set(true);
        resync_copy_targets(store, &skill.id)?;
        sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;
        Ok((resolved_subpath.unwrap_or_default(), content_changed))
    })();

    git_fetcher::cleanup_temp(&temp_dir);

    match outcome {
        Ok((resolved_subpath, content_changed)) => Ok(SetSourceResult {
            skill_id: skill.id,
            name: skill.name,
            previous_source_type: skill.source_type,
            previous_source_ref: skill.source_ref,
            clone_url: parsed.clone_url,
            subpath: (!resolved_subpath.is_empty()).then_some(resolved_subpath),
            branch,
            revision: remote_revision,
            content_changed,
            dry_run,
        }),
        Err(e) => {
            // Only clear `updating` if this call actually set it. A refusal
            // (bad subpath, content differs without --force) touched nothing,
            // so marking the skill as errored would be a lie.
            //
            // `update_skill_check_state` always writes the revision column, so
            // it has to be given the one that matches whichever source the row
            // now describes: the new source's revision once the re-point
            // committed, otherwise the revision the old source already had.
            // Passing the newly resolved revision unconditionally would file a
            // commit from the new repo under a skill still pointing at the old
            // one; passing None would blank a revision that is still valid.
            if marked_updating.get() {
                let revision = if source_committed.get() {
                    Some(remote_revision.as_str())
                } else {
                    skill.remote_revision.as_deref()
                };
                let _ =
                    store.update_skill_check_state(skill_id, revision, "error", Some(&e.message));
            }
            Err(e)
        }
    }
}

/// Re-import a local skill from its recorded source path.
///
/// `approved_removals` mirrors the git path: without it — or with one that no
/// longer matches the recomputed list — a re-import that would take away files
/// the source does not have stops and reports them.
pub fn reimport_local_skill_internal(
    store: &SkillStore,
    skill_id: &str,
    approved_removals: Option<&str>,
) -> Result<ReimportSkillResult, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;

    if !matches!(skill.source_type.as_str(), "local" | "import") {
        return Err(AppError::invalid_input(
            "Only local skills can be reimported",
        ));
    }

    let source_path = skill
        .source_ref
        .clone()
        .ok_or_else(|| AppError::not_found("Local skill is missing its original source path"))?;
    let path = PathBuf::from(&source_path);
    if !path.exists() {
        store
            .update_skill_check_state(
                &skill.id,
                None,
                "source_missing",
                Some("Original source path no longer exists"),
            )
            .map_err(AppError::db)?;
        return Err(AppError::not_found("Original source path no longer exists"));
    }

    store
        .update_skill_update_status(skill_id, "updating")
        .map_err(AppError::db)?;

    let result = (|| -> Result<(Vec<PendingRemoval>, Option<String>), AppError> {
        let _lock = RepoLock::acquire_foreground("reimport local skill").map_err(AppError::db)?;
        let staged_path = staged_path_for(&skill.central_path);
        let install_result =
            installer::install_from_local_to_destination(&path, Some(&skill.name), &staged_path)
                .inspect_err(|_| {
                    let _ = remove_path_if_exists(&staged_path);
                })
                .map_err(AppError::io)?;
        let staged_guard = StagedPathGuard::new(&staged_path, true);

        // Same replacement, same guard. Re-importing is explicit about the
        // *source*, not about discarding whatever has accumulated in the
        // library since — and for a local skill the "update" button runs this,
        // so leaving it uncovered would guard one path and not its twin.
        let pending = pending_removals_for(store, &skill, Some(&staged_path))?;
        // Bound to the set itself, not to a constant. A constant would match on
        // the approving call no matter what the recomputed list said, so a file
        // written while the dialog was open would be deleted having never been
        // shown — which is the whole failure this is here to prevent.
        let approval = removal_approval_token(REIMPORT_APPROVAL_DOMAIN, &pending);
        if !pending.is_empty() && approved_removals != Some(approval.as_str()) {
            // Restore the status this started from rather than asserting one:
            // declining changed nothing, so nothing about the skill's state
            // should read differently afterwards.
            store
                .update_skill_update_status(&skill.id, &skill.update_status)
                .map_err(AppError::db)?;
            return Ok((pending, Some(approval)));
        }

        swap_skill_directory(&staged_path, Path::new(&skill.central_path))?;
        // Only now is it the library's; before this the guard still owns it.
        staged_guard.release();
        store
            .update_skill_after_install(
                &skill.id,
                &skill.name,
                install_result.description.as_deref(),
                None,
                None,
                Some(&install_result.content_hash),
                "local_only",
            )
            .map_err(AppError::db)?;
        resync_copy_targets(store, &skill.id)?;
        sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;
        Ok((Vec::new(), None))
    })();

    match result {
        Ok((pending_removals, removal_approval)) => Ok(ReimportSkillResult {
            skill: managed_skill_by_id(store, skill_id)?,
            pending_removals,
            removal_approval,
        }),
        Err(e) => {
            let _ = store.update_skill_check_state(skill_id, None, "error", Some(&e.message));
            Err(e)
        }
    }
}

pub fn store_installed_skill_unlocked(
    store: &SkillStore,
    result: &installer::InstallResult,
    metadata: &InstallSourceMetadata,
    active_scenario_id: Option<&str>,
) -> Result<String, AppError> {
    let now = chrono::Utc::now().timestamp_millis();
    let central_path = result.central_path.to_string_lossy().to_string();

    if let Some(existing) = store
        .get_skill_by_central_path(&central_path)
        .map_err(AppError::db)?
    {
        store
            .update_skill_after_reinstall(
                &existing.id,
                &result.name,
                result.description.as_deref(),
                &metadata.source_type,
                metadata.source_ref.as_deref(),
                metadata.source_ref_resolved.as_deref(),
                metadata.source_subpath.as_deref(),
                metadata.source_branch.as_deref(),
                metadata.source_revision.as_deref(),
                metadata.remote_revision.as_deref(),
                Some(&result.content_hash),
                &metadata.update_status,
            )
            .map_err(AppError::db)?;
        if let Some(scenario_id) = active_scenario_id {
            store
                .add_skill_to_scenario(scenario_id, &existing.id)
                .map_err(AppError::db)?;
        }
        sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;

        if let Some(scenario_id) = active_scenario_id {
            if let Err(e) =
                super::presets::sync_skill_to_active_preset(store, scenario_id, &existing.id)
            {
                log::warn!("Failed to sync reinstalled skill to preset: {e}");
            }
        }

        return Ok(existing.id);
    }

    let id = uuid::Uuid::new_v4().to_string();

    let record = SkillRecord {
        id: id.clone(),
        name: result.name.clone(),
        description: result.description.clone(),
        source_type: metadata.source_type.clone(),
        source_ref: metadata.source_ref.clone(),
        source_ref_resolved: metadata.source_ref_resolved.clone(),
        source_subpath: metadata.source_subpath.clone(),
        source_branch: metadata.source_branch.clone(),
        source_revision: metadata.source_revision.clone(),
        remote_revision: metadata.remote_revision.clone(),
        central_path,
        content_hash: Some(result.content_hash.clone()),
        enabled: true,
        created_at: now,
        updated_at: now,
        status: "ok".to_string(),
        update_status: metadata.update_status.clone(),
        last_checked_at: Some(now),
        last_check_error: None,
    };

    store.insert_skill(&record).map_err(AppError::db)?;
    if metadata.source_revision.is_some() {
        store
            .set_skill_source_content_hash(&id, Some(&result.content_hash))
            .map_err(AppError::db)?;
    }
    if let Some(scenario_id) = active_scenario_id {
        store
            .add_skill_to_scenario(scenario_id, &id)
            .map_err(AppError::db)?;
    }
    sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;

    if let Some(scenario_id) = active_scenario_id {
        if let Err(e) = super::presets::sync_skill_to_active_preset(store, scenario_id, &id) {
            log::warn!("Failed to sync newly installed skill to preset: {e}");
        }
    }

    Ok(id)
}

/// Check one skill end to end: resolve its remote, then write the status.
///
/// The caller must **not** hold the central-repo lock — the resolution here is
/// a network call. Paths that need the lock take it around
/// [`check_skill_update_internal_with_remote`] only, after prefetching.
pub fn check_skill_update_internal(
    store: &SkillStore,
    skill_id: &str,
    force: bool,
    proxy_url: Option<&str>,
) -> Result<ManagedSkillDto, AppError> {
    let prefetched = prefetch_skill_remote(store, skill_id, force, proxy_url);
    check_skill_update_internal_with_remote(store, skill_id, force, prefetched)
}

/// Write one skill's update status from an already-resolved remote revision.
///
/// This never touches the network — [`prefetch_skill_remote`] does that off the
/// central-repo lock, and callers hold the lock only for this write. A git
/// skill whose `prefetched` is missing or points at a remote the skill no
/// longer uses is left untouched for the next round.
pub fn check_skill_update_internal_with_remote(
    store: &SkillStore,
    skill_id: &str,
    force: bool,
    prefetched: Option<PrefetchedRemote>,
) -> Result<ManagedSkillDto, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;

    if should_skip_update_check(store, &skill, force)? {
        return managed_skill_by_id(store, skill_id);
    }

    match skill.source_type.as_str() {
        "git" | "skillssh" => {
            let git_source = git_source_from_skill(&skill)?;
            let metadata_updated = skill.source_ref_resolved.as_deref()
                != Some(git_source.clone_url.as_str())
                || skill.source_subpath.as_deref() != git_source.subpath.as_deref()
                || skill.source_branch.as_deref() != git_source.branch.as_deref();
            if metadata_updated {
                store
                    .update_skill_source_metadata(
                        &skill.id,
                        Some(&git_source.clone_url),
                        git_source.subpath.as_deref(),
                        git_source.branch.as_deref(),
                        skill.source_revision.as_deref(),
                    )
                    .map_err(AppError::db)?;
            }

            // Apply the revision resolved off the lock — but only if the skill
            // still points at the remote it was resolved for. A reinstall keeps
            // the row and repoints its source, so a stale prefetch would record
            // a status computed against the wrong remote.
            //
            // When nothing usable was prefetched, skip the skill instead of
            // resolving here: every caller of this function holds the
            // central-repo lock, and a network call under that lock is the
            // 20s "busy" failure the off-lock split exists to remove (#315).
            // The next round picks the skill up.
            let Some(remote_result) = prefetched
                .filter(|prefetched| {
                    prefetched
                        .key
                        .matches(&git_source.clone_url, git_source.branch.as_deref())
                })
                .map(|prefetched| prefetched.result)
            else {
                log::debug!(
                    "check update: no usable prefetched remote for {}, skipping this round",
                    skill.id
                );
                return managed_skill_by_id(store, skill_id);
            };
            match remote_result {
                Ok(resolved) => {
                    let Some(remote_skill) = resolved.skills.get(&skill.id) else {
                        log::debug!("更新检查：预取远端结果未包含 {}，本轮跳过", skill.id);
                        return managed_skill_by_id(store, skill_id);
                    };
                    if remote_skill.source_subpath.as_deref() != git_source.subpath.as_deref()
                        || remote_skill.locator_skill_id.as_deref()
                            != git_source.locator_skill_id.as_deref()
                    {
                        log::debug!(
                            "更新检查：{} 的来源位置在预取后发生变化，本轮跳过",
                            skill.id
                        );
                        return managed_skill_by_id(store, skill_id);
                    }
                    let source_hash = match &remote_skill.content_hash {
                        Ok(hash) => hash,
                        Err(message) => {
                            store
                                .update_skill_check_state(
                                    &skill.id,
                                    Some(&resolved.revision),
                                    "error",
                                    Some(message),
                                )
                                .map_err(AppError::db)?;
                            return Err(AppError::git(message.clone()));
                        }
                    };
                    let central_hash =
                        crate::core::content_hash::hash_directory(Path::new(&skill.central_path))
                            .map_err(AppError::io)?;
                    if central_hash == *source_hash {
                        store
                            .update_skill_content_alignment(
                                &skill.id,
                                &resolved.revision,
                                source_hash,
                                &central_hash,
                            )
                            .map_err(AppError::db)?;
                    } else {
                        store
                            .update_skill_content_check_state(
                                &skill.id,
                                Some(&resolved.revision),
                                &central_hash,
                                "update_available",
                            )
                            .map_err(AppError::db)?;
                    }
                }
                Err(message) => {
                    store
                        .update_skill_check_state(
                            &skill.id,
                            skill.remote_revision.as_deref(),
                            "error",
                            Some(&message),
                        )
                        .map_err(AppError::db)?;
                    return Err(AppError::git(message));
                }
            }
        }
        "local" | "import" => {
            let mut central_hash = None;
            let (status, error): (&str, Option<String>) = match skill.source_ref.as_deref() {
                Some(path) => {
                    let source_path = Path::new(path);
                    if !source_path.exists() {
                        (
                            "source_missing",
                            Some("Original source path no longer exists".to_string()),
                        )
                    } else if skill.content_hash.is_none() {
                        ("local_only", None)
                    } else {
                        match installer::hash_local_source(source_path) {
                            Ok(live_hash) => match crate::core::content_hash::hash_directory(
                                Path::new(&skill.central_path),
                            ) {
                                Ok(current_hash) => {
                                    let status = if current_hash == live_hash {
                                        "up_to_date"
                                    } else {
                                        "update_available"
                                    };
                                    central_hash = Some(current_hash);
                                    (status, None)
                                }
                                Err(err) => ("error", Some(err.to_string())),
                            },
                            Err(err) => ("error", Some(err.to_string())),
                        }
                    }
                }
                None => ("local_only", None),
            };
            if let (Some(hash), None) = (central_hash.as_deref(), error.as_deref()) {
                store
                    .update_skill_content_check_state(&skill.id, None, hash, status)
                    .map_err(AppError::db)?;
            } else {
                store
                    .update_skill_check_state(&skill.id, None, status, error.as_deref())
                    .map_err(AppError::db)?;
            }
        }
        _ => {
            store
                .update_skill_check_state(&skill.id, None, "unknown", None)
                .map_err(AppError::db)?;
        }
    }

    managed_skill_by_id(store, skill_id)
}

pub(crate) fn should_skip_update_check(
    store: &SkillStore,
    skill: &SkillRecord,
    force: bool,
) -> Result<bool, AppError> {
    if force {
        return Ok(false);
    }

    let ttl_minutes = store
        .get_setting("update_check_ttl_minutes")
        .map_err(AppError::db)?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(60);
    let ttl_ms = ttl_minutes * 60 * 1000;
    let stable_status = !matches!(
        skill.update_status.as_str(),
        "unknown" | "checking" | "updating" | "error"
    );

    Ok(stable_status
        && skill
            .last_checked_at
            .map(|checked| chrono::Utc::now().timestamp_millis() - checked < ttl_ms)
            .unwrap_or(false))
}

pub fn git_source_from_skill(skill: &SkillRecord) -> Result<GitSkillSource, AppError> {
    if let Some(resolved) = &skill.source_ref_resolved {
        return Ok(GitSkillSource {
            clone_url: resolved.clone(),
            branch: skill.source_branch.clone(),
            subpath: skill.source_subpath.clone(),
            locator_skill_id: skill_ssh_id(skill),
        });
    }

    match skill.source_type.as_str() {
        "git" => {
            let source_ref = skill
                .source_ref
                .as_ref()
                .ok_or_else(|| AppError::invalid_input("Git skill is missing its source URL"))?;
            let parsed = git_fetcher::parse_git_source(source_ref);
            Ok(GitSkillSource {
                clone_url: parsed.clone_url,
                // Prefer the branch resolved at install time — it survives
                // slash-branch tree URLs that the sync parse can't disambiguate.
                branch: skill.source_branch.clone().or(parsed.branch),
                subpath: skill.source_subpath.clone().or(parsed.subpath),
                locator_skill_id: None,
            })
        }
        "skillssh" => {
            let source_ref = skill.source_ref.as_ref().ok_or_else(|| {
                AppError::invalid_input("skills.sh skill is missing its source reference")
            })?;
            let (repo_source, fallback_skill_id) = source_ref
                .rsplit_once('/')
                .ok_or_else(|| AppError::invalid_input("Invalid skills.sh source reference"))?;
            Ok(GitSkillSource {
                clone_url: format!("https://github.com/{}.git", repo_source),
                branch: skill.source_branch.clone(),
                subpath: skill.source_subpath.clone(),
                locator_skill_id: Some(fallback_skill_id.to_string()),
            })
        }
        _ => Err(AppError::invalid_input(
            "Skill does not support git-based updates",
        )),
    }
}

fn skill_ssh_id(skill: &SkillRecord) -> Option<String> {
    if skill.source_type != "skillssh" {
        return None;
    }

    skill.source_ref.as_deref().and_then(|source_ref| {
        source_ref
            .rsplit_once('/')
            .map(|(_, skill_id)| skill_id.to_string())
    })
}

/// Return the list of individual skill directories to install from a resolved repo dir.
/// If `skill_dir` is itself a valid skill, returns `[skill_dir]`.
/// Otherwise recursively walks for skill dirs (e.g. `category/<skill>` layouts).
/// Returns an empty Vec when nothing is found — callers must handle that.
pub fn collect_git_skill_dirs(skill_dir: &Path) -> Vec<PathBuf> {
    if is_valid_skill_dir(skill_dir) {
        return vec![skill_dir.to_path_buf()];
    }
    let mut dirs = scanner::collect_skill_dirs(skill_dir);
    dirs.sort();
    dirs
}

/// Stable identifier for a discovered skill within a preview/confirm cycle.
/// Uses forward slashes regardless of platform so the frontend sees consistent keys.
pub fn skill_rel_key(skill_dir: &Path, dir: &Path) -> String {
    let rel = dir.strip_prefix(skill_dir).unwrap_or(dir);
    if rel.as_os_str().is_empty() {
        dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        rel.to_string_lossy().replace('\\', "/")
    }
}

/// Validate and canonicalize a temp directory path used by the git preview/install flow.
/// Returns the canonicalized path if it passes security checks.
pub fn validate_clone_temp_path(temp_dir: &str) -> Result<PathBuf, AppError> {
    let raw_path = PathBuf::from(temp_dir);
    if !raw_path.exists() {
        return Err(AppError::invalid_input(
            "Clone session expired, please try again",
        ));
    }
    // Canonicalize to resolve symlinks and `..` segments before checking prefix.
    let temp_path = raw_path
        .canonicalize()
        .map_err(|_| AppError::invalid_input("Invalid temp directory"))?;

    // Preview confirmation must operate on an isolated checkout, never the repo cache.
    let expected_prefix = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    if temp_path.starts_with(&expected_prefix) {
        let dir_name_str = temp_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if dir_name_str.starts_with(git_fetcher::CLONE_TEMP_PREFIX) {
            return Ok(temp_path);
        }
    }

    Err(AppError::invalid_input("Invalid temp directory"))
}

/// Resolve which directory of a fresh checkout holds the skill.
///
/// Both inputs are attacker-reachable. `subpath` comes from the path segment of
/// a `…/tree/<branch>/<path>` URL the user pasted, and `skill_id` from the part
/// after `@` in a skills.sh shorthand, which `parse_skillssh_shorthand` does not
/// constrain to a single path segment. `Path::join` returns an absolute argument
/// verbatim and `..` segments climb out of the checkout, so both are checked for
/// containment: without that, `install` copies the resolved directory into the
/// library — which for a git-backed library can then be pushed to the user's
/// backup remote.
///
/// A subpath that stays inside the checkout but does not exist is a different
/// case: it is only recoverable when a skills.sh locator can find the skill by
/// id, which is how a skill that moved upstream is picked up again (#278).
/// Without a locator, falling through to repo-wide discovery would install or
/// update whatever that discovery happens to return — in a repository that
/// groups its skills, the entire `skills/` container.
pub fn resolve_skill_dir(
    repo_dir: &Path,
    subpath: Option<&str>,
    skill_id: Option<&str>,
) -> Result<PathBuf, AppError> {
    if let Some(subpath) = subpath {
        let candidate = repo_dir.join(subpath);
        if !path_guard::is_path_safe(repo_dir, &candidate) {
            return Err(AppError::invalid_input(format!(
                "Path '{subpath}' resolves outside the repository"
            )));
        }
        // With a locator to fall back on, the stored path is only taken when it
        // still holds a skill. An upstream reorganization can leave the path
        // occupied by a container or an unrelated directory, and copying that
        // over the installed skill is the same mistake as guessing — let the
        // locator look the skill up at its new home instead.
        let usable = if skill_id.is_some() {
            is_valid_skill_dir(&candidate)
        } else {
            candidate.is_dir()
        };
        if usable {
            return Ok(candidate);
        }
        if skill_id.is_none() {
            return Err(AppError::not_found(format!(
                "Path '{subpath}' does not exist in the repository"
            )));
        }
    }

    // `find_skill_dir` joins the locator id onto the checkout in several places
    // before falling back to a recursive search, so its answer is checked too.
    let resolved = git_fetcher::find_skill_dir(repo_dir, skill_id).map_err(AppError::git)?;
    if !path_guard::is_path_safe(repo_dir, &resolved) {
        return Err(AppError::invalid_input(
            "Resolved skill directory is outside the repository",
        ));
    }
    Ok(resolved)
}

pub fn resolve_skillssh_install_target(
    store: &SkillStore,
    source_ref: &str,
    skill_id: &str,
) -> Result<(String, PathBuf), AppError> {
    if let Some(existing) = store
        .get_skill_by_source_ref("skillssh", source_ref)
        .map_err(AppError::db)?
    {
        return Ok((existing.name, PathBuf::from(existing.central_path)));
    }

    let base_name = skill_id.trim();
    if base_name.is_empty() {
        return Err(AppError::invalid_input("Skill id is empty"));
    }

    let mut attempt = 1;
    loop {
        let candidate_name = if attempt == 1 {
            base_name.to_string()
        } else {
            format!("{base_name}-{attempt}")
        };
        let candidate_path = central_repo::skills_dir().join(&candidate_name);
        let candidate_path_str = candidate_path.to_string_lossy().to_string();
        let occupied = store
            .get_skill_by_central_path(&candidate_path_str)
            .map_err(AppError::db)?
            .is_some();

        if !occupied {
            return Ok((candidate_name, candidate_path));
        }

        attempt += 1;
    }
}

pub fn staged_path_for(central_path: &str) -> PathBuf {
    let path = PathBuf::from(central_path);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    path.with_file_name(format!(".{file_name}.staged-{}", uuid::Uuid::new_v4()))
}

pub fn swap_skill_directory(staged_path: &Path, current_path: &Path) -> Result<(), AppError> {
    let backup_path = current_path.with_file_name(format!(
        ".{}.backup-{}",
        current_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".to_string()),
        uuid::Uuid::new_v4()
    ));

    if current_path.exists() {
        std::fs::rename(current_path, &backup_path)?;
    }

    if let Err(err) = std::fs::rename(staged_path, current_path) {
        if backup_path.exists() {
            let _ = std::fs::rename(&backup_path, current_path);
        }
        let _ = remove_path_if_exists(staged_path);
        return Err(err.into());
    }

    remove_path_if_exists(&backup_path)?;
    Ok(())
}

pub fn resync_copy_targets(store: &SkillStore, skill_id: &str) -> Result<(), AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;
    let source = PathBuf::from(&skill.central_path);
    let targets = store
        .get_targets_for_skill(skill_id)
        .map_err(AppError::db)?;

    for target in targets {
        if target.mode != "copy" {
            continue;
        }

        // Recorded: this walks existing rows, so each path is one we wrote.
        // The row's mode is filtered to "copy" above, and sync_engine still
        // refuses if what is on disk no longer matches that record.
        sync_engine::sync_skill(
            &source,
            Path::new(&target.target_path),
            sync_engine::SyncMode::Copy,
            sync_engine::ReplacePolicy::Recorded {
                mode: target.mode.as_str(),
            },
        )
        .map_err(AppError::io)?;

        let updated_target = SkillTargetRecord {
            synced_at: Some(chrono::Utc::now().timestamp_millis()),
            status: "ok".to_string(),
            last_error: None,
            // Refresh the hash so the startup freshness check (#153)
            // sees this resync as up-to-date instead of stale.
            source_hash: skill.content_hash.clone(),
            ..target
        };
        store.insert_target(&updated_target).map_err(AppError::db)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn get_all_tags(store: State<'_, Arc<SkillStore>>) -> Result<Vec<String>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.get_all_tags().map_err(AppError::db)).await?
}

#[tauri::command]
pub async fn set_skill_tags(
    skill_id: String,
    tags: Vec<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || set_skill_tags_internal(&store, &skill_id, &tags))
        .await?
}

/// Shared implementation for GUI and CLI tag writes. Keeping the DB row and
/// its backup metadata under one repo lock prevents another process from
/// reindexing the half-written state between those two operations.
pub fn set_skill_tags_internal(
    store: &SkillStore,
    skill_id: &str,
    tags: &[String],
) -> Result<(), AppError> {
    let mut normalized = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if !tag.is_empty() && !normalized.iter().any(|existing| existing == tag) {
            normalized.push(tag.to_string());
        }
    }

    sync_metadata::with_repo_lock("set skill tags", || {
        store.set_tags_for_skill(skill_id, &normalized)?;
        sync_metadata::ensure_skill_metadata_unlocked(store, skill_id)
    })
    .map_err(AppError::db)
}

/// Globally rename a tag across all skills (used by the tag filter bar). If the
/// new name already exists, the tags are merged.
#[tauri::command]
pub async fn rename_tag(
    old_name: String,
    new_name: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        rename_tag_internal(&store, &old_name, &new_name).map(|_| ())
    })
    .await?
}

pub fn rename_tag_internal(
    store: &SkillStore,
    old_name: &str,
    new_name: &str,
) -> Result<Vec<String>, AppError> {
    let old_name = old_name.trim();
    let new_name = new_name.trim();
    if old_name.is_empty() || new_name.is_empty() {
        return Err(AppError::invalid_input("Tag name cannot be empty"));
    }
    if new_name == old_name {
        return Ok(Vec::new());
    }
    sync_metadata::with_repo_lock("rename tag", || {
        let affected = store.rename_tag(old_name, new_name)?;
        for skill_id in &affected {
            sync_metadata::ensure_skill_metadata_unlocked(store, skill_id)?;
        }
        Ok(affected)
    })
    .map_err(AppError::db)
}

/// Globally delete a tag from all skills (used by the tag filter bar).
#[tauri::command]
pub async fn delete_tag(name: String, store: State<'_, Arc<SkillStore>>) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || delete_tag_internal(&store, &name).map(|_| ()))
        .await?
}

pub fn delete_tag_internal(store: &SkillStore, name: &str) -> Result<Vec<String>, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::invalid_input("Tag name cannot be empty"));
    }
    sync_metadata::with_repo_lock("delete tag", || {
        let affected = store.delete_tag(name)?;
        for skill_id in &affected {
            sync_metadata::ensure_skill_metadata_unlocked(store, skill_id)?;
        }
        Ok(affected)
    })
    .map_err(AppError::db)
}

#[tauri::command]
pub async fn cancel_install(
    key: String,
    cancel_registry: State<'_, Arc<InstallCancelRegistry>>,
) -> Result<bool, AppError> {
    Ok(cancel_registry.cancel(&key))
}

#[derive(Debug, Serialize)]
pub struct BatchImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn batch_import_folder(
    folder_path: String,
    store: State<'_, Arc<SkillStore>>,
    app_handle: tauri::AppHandle,
) -> Result<BatchImportResult, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;

        let root = PathBuf::from(&folder_path);
        if !root.is_dir() {
            return Err(AppError::invalid_input("Selected path is not a directory"));
        }

        // Collect valid skill subdirectories (depth=1)
        let mut skill_dirs: Vec<PathBuf> = Vec::new();
        let entries = std::fs::read_dir(&root)?;
        for entry in entries.flatten() {
            let path = entry.path();
            if is_valid_skill_dir(&path) {
                skill_dirs.push(path);
            }
        }

        if skill_dirs.is_empty() {
            return Ok(BatchImportResult {
                imported: 0,
                skipped: 0,
                errors: vec![],
            });
        }

        let total = skill_dirs.len();
        let mut imported = 0usize;
        let mut skipped = 0usize;
        let mut errors = Vec::new();

        for (i, dir) in skill_dirs.iter().enumerate() {
            let name = skill_metadata::infer_skill_name(dir);

            app_handle
                .emit(
                    "batch-import-progress",
                    serde_json::json!({
                        "current": i + 1,
                        "total": total,
                        "name": &name,
                    }),
                )
                .ok();

            // Check if already imported by prospective central path
            let prospective_central = central_repo::skills_dir().join(&name);
            let central_str = prospective_central.to_string_lossy().to_string();
            if let Ok(Some(_)) = store.get_skill_by_central_path(&central_str) {
                skipped += 1;
                continue;
            }

            let install_result = (|| -> Result<String, AppError> {
                let _lock =
                    RepoLock::acquire_foreground("batch import skill").map_err(AppError::db)?;
                let result =
                    installer::install_from_local(dir, Some(&name)).map_err(AppError::io)?;
                let metadata = InstallSourceMetadata {
                    source_type: "local".to_string(),
                    source_ref: Some(dir.to_string_lossy().to_string()),
                    source_ref_resolved: None,
                    source_subpath: None,
                    source_branch: None,
                    source_revision: None,
                    remote_revision: None,
                    update_status: "local_only".to_string(),
                };
                store_installed_skill_unlocked(&store, &result, &metadata, None)
            })();

            match install_result {
                Ok(_) => imported += 1,
                Err(e) => errors.push(format!("{}: {}", name, e)),
            }
        }

        Ok(BatchImportResult {
            imported,
            skipped,
            errors,
        })
    })
    .await?
}

fn remove_path_if_exists(path: &Path) -> Result<(), AppError> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tempfile::{tempdir, TempDir};

    const TEST_CHECK_CONCURRENCY_SETTING: &str = "foreground_batch_check_concurrency";
    const TEST_UPDATE_CONCURRENCY_SETTING: &str = "foreground_batch_update_concurrency";

    struct TestRepo {
        _lock: std::sync::MutexGuard<'static, ()>,
        _tmp: TempDir,
        store: SkillStore,
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            central_repo::set_test_base_dir_override(None);
        }
    }

    struct ConcurrencyProbe {
        first_operation_started: AtomicBool,
        in_flight: AtomicUsize,
        peak: AtomicUsize,
        first_wave_target: usize,
        first_wave_arrivals: std::sync::Mutex<usize>,
        first_wave_ready: std::sync::Condvar,
    }

    impl ConcurrencyProbe {
        fn new(first_wave_target: usize) -> Self {
            assert!(first_wave_target > 0);
            Self {
                first_operation_started: AtomicBool::new(false),
                in_flight: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                first_wave_target,
                first_wave_arrivals: std::sync::Mutex::new(0),
                first_wave_ready: std::sync::Condvar::new(),
            }
        }

        fn observe<T>(&self, on_first: impl FnOnce(), output: T) -> T {
            let current = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(current, Ordering::SeqCst);
            if !self.first_operation_started.swap(true, Ordering::SeqCst) {
                on_first();
            }

            let mut arrivals = self.first_wave_arrivals.lock().unwrap();
            if *arrivals < self.first_wave_target {
                *arrivals += 1;
                if *arrivals == self.first_wave_target {
                    self.first_wave_ready.notify_all();
                } else {
                    arrivals = self
                        .first_wave_ready
                        .wait_timeout_while(
                            arrivals,
                            std::time::Duration::from_secs(2),
                            |arrivals| *arrivals < self.first_wave_target,
                        )
                        .unwrap()
                        .0;
                }
            }
            drop(arrivals);
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            output
        }

        fn peak(&self) -> usize {
            self.peak.load(Ordering::SeqCst)
        }
    }

    fn insert_concurrency_skills(
        store: &SkillStore,
        remote_name: &str,
        count: usize,
    ) -> Vec<String> {
        (0..count)
            .map(|index| {
                let skill_id = format!("skill-{index:02}");
                insert_git_skill(
                    store,
                    &skill_id,
                    &format!("https://example.test/{remote_name}-{index}.git"),
                );
                skill_id
            })
            .collect()
    }

    fn test_repo() -> TestRepo {
        let lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("repo");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&base.join("test.db")).unwrap();
        TestRepo {
            _lock: lock,
            _tmp: tmp,
            store,
        }
    }

    fn write_skill_dir(name: &str) -> PathBuf {
        let dir = central_repo::skills_dir().join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
        dir
    }

    fn sample_skill(id: &str, name: &str, central_path: &Path) -> SkillRecord {
        SkillRecord {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            source_type: "import".to_string(),
            source_ref: Some(central_path.to_string_lossy().to_string()),
            source_ref_resolved: None,
            source_subpath: None,
            source_branch: None,
            source_revision: None,
            remote_revision: None,
            central_path: central_path.to_string_lossy().to_string(),
            content_hash: None,
            enabled: true,
            created_at: 1,
            updated_at: 1,
            status: "ok".to_string(),
            update_status: "local_only".to_string(),
            last_checked_at: None,
            last_check_error: None,
        }
    }

    #[test]
    fn skill_browser_cancels_pending_source_when_closed_without_blocking_local() {
        use crate::core::{error::ErrorKind, skill_browser::SkillBrowser};
        use std::net::TcpListener;
        let repo = test_repo();
        let installed = write_skill_dir("cancel-browser");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut skill = sample_skill("cancel-browser", "cancel-browser", &installed);
        skill.source_type = "git".into();
        skill.source_ref = Some(format!(
            "http://{}/pending.git",
            listener.local_addr().unwrap()
        ));
        repo.store.insert_skill(&skill).unwrap();
        let browser = Arc::new(SkillBrowser::default());
        let local = browser.open(&repo.store, &skill.id).unwrap();
        let worker_browser = browser.clone();
        let session = local.session_id.clone();
        let worker =
            std::thread::spawn(move || worker_browser.prepare_source("cancel-browser", &session));
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        let connection = loop {
            if let Ok((connection, _)) = listener.accept() {
                break connection;
            }
            if Instant::now() > deadline {
                browser.close(&skill.id, &local.session_id).unwrap();
                panic!("来源没有连接隔离测试服务器");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert!(browser
            .read(&skill.id, &local.session_id, "SKILL.md")
            .is_ok());
        browser.close(&skill.id, &local.session_id).unwrap();
        let error = worker.join().unwrap().unwrap_err();
        assert_eq!(error.kind, ErrorKind::Cancelled);
        drop(connection);
        assert!(browser
            .prepare_source(&skill.id, &local.session_id)
            .is_err());
        assert!(fs::read_dir(central_repo::cache_dir().join("repos"))
            .unwrap()
            .flatten()
            .all(|entry| !entry.path().is_dir()));
    }

    #[cfg(unix)]
    #[test]
    fn skill_browser_follows_changed_default_branch_through_the_existing_cache() {
        use crate::core::skill_browser::SkillBrowser;
        use std::{os::unix::fs::PermissionsExt, process::Command};
        // 真正的 Git 传输通过隔离 SSH 命令连接本地 upload-pack，URL 不被改写。
        let Ok(remote_path) = std::env::var("SKILL_BROWSER_DEFAULT_FIXTURE") else {
            let fixture = tempfile::tempdir().unwrap();
            let ssh = fixture.path().join("fixture-ssh");
            fs::write(
                &ssh,
                "#!/bin/sh\nexec git-upload-pack \"$SKILL_BROWSER_DEFAULT_FIXTURE/repo\"\n",
            )
            .unwrap();
            fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "commands::skills::tests::skill_browser_follows_changed_default_branch_through_the_existing_cache", "--nocapture"])
                .env("SKILL_BROWSER_DEFAULT_FIXTURE", fixture.path())
                .env("GIT_SSH", &ssh).env_remove("GIT_SSH_COMMAND").env("GIT_SSH_VARIANT", "simple")
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        };
        let repo = test_repo();
        let remote = Path::new(&remote_path).join("repo");
        fs::create_dir(&remote).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&remote)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        git(&["init", "-b", "main"]);
        fs::write(remote.join("SKILL.md"), "# 默认 main").unwrap();
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=测试",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "默认 main",
        ]);
        let main_revision = git(&["rev-parse", "HEAD"]);
        let installed = write_skill_dir("default-browser");
        let mut skill = sample_skill("default-browser", "default-browser", &installed);
        skill.source_type = "git".into();
        skill.source_ref = Some("ssh://skill-browser-default.test/repo".into());
        skill.source_ref_resolved = skill.source_ref.clone();
        repo.store.insert_skill(&skill).unwrap();
        let browser = SkillBrowser::default();
        let first = browser.open(&repo.store, &skill.id).unwrap();
        assert_eq!(
            browser
                .prepare_source(&skill.id, &first.session_id)
                .unwrap()
                .revision,
            main_revision
        );
        let cache = fs::read_dir(central_repo::cache_dir().join("repos"))
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.join(".git").is_dir())
            .unwrap();
        let proof = cache.join(".git/浏览缓存复用证明");
        fs::write(&proof, "缓存必须保留").unwrap();
        git(&["checkout", "-b", "dev"]);
        fs::write(remote.join("SKILL.md"), "# 默认 dev").unwrap();
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=测试",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "默认 dev",
        ]);
        let dev_revision = git(&["rev-parse", "HEAD"]);
        let next = browser.open(&repo.store, &skill.id).unwrap();
        let next_source = browser.prepare_source(&skill.id, &next.session_id).unwrap();
        assert_eq!(fs::read_to_string(&proof).unwrap(), "缓存必须保留");
        assert_eq!(next_source.revision, dev_revision);
        assert_eq!(
            browser
                .read_side(&skill.id, &first.session_id, "SKILL.md", "source")
                .unwrap()
                .text
                .as_deref(),
            Some("# 默认 main")
        );
        assert_eq!(
            browser
                .read_side(&skill.id, &next.session_id, "SKILL.md", "source")
                .unwrap()
                .text
                .as_deref(),
            Some("# 默认 dev")
        );
        let explicit = git_fetcher::clone_repo_ref(
            skill.source_ref.as_deref().unwrap(),
            Some("main"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            git_fetcher::get_head_revision(&explicit).unwrap(),
            main_revision
        );
        assert_eq!(fs::read_to_string(&proof).unwrap(), "缓存必须保留");
        git_fetcher::cleanup_temp(&explicit);
        let default_again =
            git_fetcher::clone_repo_ref(skill.source_ref.as_deref().unwrap(), None, None, None)
                .unwrap();
        assert_eq!(
            git_fetcher::get_head_revision(&default_again).unwrap(),
            dev_revision
        );
        assert_eq!(fs::read_to_string(&proof).unwrap(), "缓存必须保留");
        git_fetcher::cleanup_temp(&default_again);
        browser.close(&skill.id, &first.session_id).unwrap();
        browser.close(&skill.id, &next.session_id).unwrap();
    }

    #[test]
    fn skill_browser_pins_one_git_source_and_cleans_its_checkout() {
        use crate::core::skill_browser::SkillBrowser;
        use std::process::Command;
        // URL 映射只作用于隔离子进程，不修改用户或并行测试的 Git 配置。
        let Ok(remote_path) = std::env::var("SKILL_BROWSER_GIT_FIXTURE") else {
            let remote = tempfile::tempdir().unwrap();
            let result = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "commands::skills::tests::skill_browser_pins_one_git_source_and_cleans_its_checkout", "--nocapture"])
                .env("SKILL_BROWSER_GIT_FIXTURE", remote.path())
                .env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", format!("url.file://{}/.insteadOf", remote.path().display()))
                .env("GIT_CONFIG_VALUE_0", "https://skill-browser.test/")
                .output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        };
        let repo = test_repo();
        let remote = Path::new(&remote_path).join("repo");
        fs::create_dir_all(remote.join("skills/wanted/refs")).unwrap();
        fs::create_dir_all(remote.join("skills/sibling")).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&remote)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        git(&["init", "-b", "main"]);
        fs::write(remote.join("skills/wanted/SKILL.md"), "# 第一版").unwrap();
        fs::write(remote.join("skills/wanted/refs/info.md"), "第一版资料").unwrap();
        fs::write(remote.join("skills/sibling/SKILL.md"), "# 不应展示兄弟技能").unwrap();
        let marker = uuid::Uuid::new_v4().to_string();
        fs::write(remote.join("skills/wanted/.browser-marker"), &marker).unwrap();
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=测试",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "来源第一版",
        ]);
        let first = git(&["rev-parse", "HEAD"]);
        let installed = write_skill_dir("git-browser");
        let mut skill = sample_skill("git-browser", "git-browser", &installed);
        skill.source_type = "git".into();
        skill.source_ref = Some("https://skill-browser.test/repo".into());
        skill.source_branch = Some("main".into());
        skill.source_subpath = Some("skills/wanted".into());
        repo.store.insert_skill(&skill).unwrap();
        let browser = SkillBrowser::default();
        let index = browser.open(&repo.store, &skill.id).unwrap();
        let source = browser
            .prepare_source(&skill.id, &index.session_id)
            .unwrap();
        assert_eq!(source.revision, first);
        assert_eq!(source.index.file_count, 3);
        assert!(!source
            .index
            .entries
            .iter()
            .any(|entry| entry.path.contains("sibling")));
        let checkouts = || -> Vec<PathBuf> {
            fs::read_dir(std::env::temp_dir())
                .unwrap()
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    fs::read_to_string(path.join("skills/wanted/.browser-marker"))
                        .ok()
                        .as_deref()
                        == Some(marker.as_str())
                })
                .collect()
        };
        assert_eq!(checkouts().len(), 1);
        fs::write(remote.join("skills/wanted/SKILL.md"), "# 第二版").unwrap();
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=测试",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "来源第二版",
        ]);
        assert_eq!(
            browser
                .prepare_source(&skill.id, &index.session_id)
                .unwrap()
                .revision,
            first
        );
        assert_eq!(
            browser
                .read_side(&skill.id, &index.session_id, "SKILL.md", "source")
                .unwrap()
                .text
                .as_deref(),
            Some("# 第一版")
        );
        assert_eq!(checkouts().len(), 1);
        let diff = browser.source_diff(&skill.id, &index.session_id).unwrap();
        assert_eq!(diff.revision, first);
        assert_eq!(
            browser
                .read_side(&skill.id, &index.session_id, "SKILL.md", "source")
                .unwrap()
                .text
                .as_deref(),
            Some("# 第一版")
        );
        browser.close(&skill.id, &index.session_id).unwrap();
        assert!(checkouts().is_empty());
        let next = browser.open(&repo.store, &skill.id).unwrap();
        assert_ne!(
            browser
                .prepare_source(&skill.id, &next.session_id)
                .unwrap()
                .revision,
            first
        );
        browser.close(&skill.id, &next.session_id).unwrap();
        assert!(checkouts().is_empty());
        let mut missing = skill.clone();
        missing.id = "missing-browser".into();
        missing.source_subpath = Some("missing-skill".into());
        missing.central_path = write_skill_dir("missing-browser")
            .to_string_lossy()
            .into_owned();
        repo.store.insert_skill(&missing).unwrap();
        let failed = browser.open(&repo.store, &missing.id).unwrap();
        assert!(browser
            .prepare_source(&missing.id, &failed.session_id)
            .is_err());
        assert!(checkouts().is_empty());
        assert!(browser
            .read(&missing.id, &failed.session_id, "SKILL.md")
            .is_ok());
        let mut skills_sh = skill.clone();
        skills_sh.id = "skills-sh-browser".into();
        skills_sh.source_type = "skillssh".into();
        skills_sh.source_ref = Some("owner/repo/wanted".into());
        skills_sh.source_ref_resolved = skill.source_ref.clone();
        skills_sh.source_subpath = Some("old-location".into());
        skills_sh.central_path = write_skill_dir("skills-sh-browser")
            .to_string_lossy()
            .into_owned();
        repo.store.insert_skill(&skills_sh).unwrap();
        let relocated = browser.open(&repo.store, &skills_sh.id).unwrap();
        assert_eq!(
            browser
                .prepare_source(&skills_sh.id, &relocated.session_id)
                .unwrap()
                .index
                .file_count,
            3
        );
        assert_eq!(
            browser
                .read_side(&skills_sh.id, &relocated.session_id, "SKILL.md", "source")
                .unwrap()
                .text
                .as_deref(),
            Some("# 第二版")
        );
        browser.close(&skills_sh.id, &relocated.session_id).unwrap();
        assert!(checkouts().is_empty());
    }

    #[test]
    fn skill_browser_invalidates_changed_source_and_keeps_local_readable() {
        use crate::core::{error::ErrorKind, skill_browser::SkillBrowser};
        let repo = test_repo();
        let installed = write_skill_dir("changing-source");
        let source = tempfile::tempdir().unwrap();
        fs::write(source.path().join("SKILL.md"), "# 旧来源").unwrap();
        fs::create_dir(source.path().join("refs")).unwrap();
        fs::write(source.path().join("refs/other.md"), "旧资料").unwrap();
        let mut skill = sample_skill("changing-source", "changing-source", &installed);
        skill.source_ref = Some(source.path().to_string_lossy().into_owned());
        repo.store.insert_skill(&skill).unwrap();
        let browser = SkillBrowser::default();
        let local = browser.open(&repo.store, &skill.id).unwrap();
        browser
            .prepare_source(&skill.id, &local.session_id)
            .unwrap();
        fs::write(source.path().join("refs/other.md"), "新资料").unwrap();
        fs::write(source.path().join("new.md"), "新增资料").unwrap();
        assert_eq!(
            browser
                .read_side(&skill.id, &local.session_id, "new.md", "source")
                .unwrap_err()
                .kind,
            ErrorKind::StaleSnapshot
        );
        assert_eq!(
            browser
                .read_side(&skill.id, &local.session_id, "SKILL.md", "source")
                .unwrap_err()
                .kind,
            ErrorKind::StaleSnapshot
        );
        assert_eq!(
            browser
                .prepare_source(&skill.id, &local.session_id)
                .unwrap_err()
                .kind,
            ErrorKind::StaleSnapshot
        );
        assert!(browser
            .read(&skill.id, &local.session_id, "SKILL.md")
            .is_ok());
        browser.close(&skill.id, &local.session_id).unwrap();
        let next = browser.open(&repo.store, &skill.id).unwrap();
        browser.prepare_source(&skill.id, &next.session_id).unwrap();
        assert_eq!(
            browser
                .read_side(&skill.id, &next.session_id, "refs/other.md", "source")
                .unwrap()
                .text
                .as_deref(),
            Some("新资料")
        );
    }

    #[test]
    fn skill_browser_compares_the_complete_union_without_changing_effective_content() {
        use crate::core::{content_hash, skill_browser::SkillBrowser};
        let repo = test_repo();
        let installed = write_skill_dir("complete-diff");
        let source = tempfile::tempdir().unwrap();
        fs::write(installed.join("SKILL.md"), "# 同一入口").unwrap();
        fs::write(source.path().join("SKILL.md"), "# 同一入口").unwrap();
        fs::write(installed.join("local.txt"), "安装独有").unwrap();
        fs::write(source.path().join("source.txt"), "来源独有").unwrap();
        fs::write(installed.join(".hidden"), "旧隐藏内容").unwrap();
        fs::write(source.path().join(".hidden"), "新隐藏内容").unwrap();
        fs::create_dir_all(installed.join(".git/objects")).unwrap();
        fs::write(installed.join(".git/objects/cache"), "管理数据").unwrap();
        fs::write(source.path().join("generated.pyc"), "编译缓存").unwrap();
        fs::create_dir(source.path().join("empty")).unwrap();
        let before = content_hash::hash_directory(&installed).unwrap();
        let after = content_hash::hash_directory(source.path()).unwrap();
        let mut skill = sample_skill("complete-diff", "complete-diff", &installed);
        skill.source_ref = Some(source.path().to_string_lossy().into_owned());
        repo.store.insert_skill(&skill).unwrap();
        let browser = SkillBrowser::default();
        let local = browser.open(&repo.store, &skill.id).unwrap();
        let result =
            serde_json::to_value(browser.source_diff(&skill.id, &local.session_id).unwrap())
                .unwrap();
        let paths: Vec<_> = result["index"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert_eq!(
            paths,
            [
                ".git",
                ".git/objects",
                ".git/objects/cache",
                ".hidden",
                "SKILL.md",
                "empty",
                "generated.pyc",
                "local.txt",
                "source.txt"
            ]
        );
        let entries = result["entries"].as_array().unwrap();
        let status =
            |path| entries.iter().find(|entry| entry["path"] == path).unwrap()["status"].clone();
        assert_eq!(status("SKILL.md"), "unchanged");
        assert_eq!(status(".hidden"), "modified");
        assert_eq!(status("local.txt"), "removed");
        assert_eq!(status("source.txt"), "added");
        assert_eq!(status(".git/objects/cache"), "not_compared");
        assert_eq!(status("generated.pyc"), "not_compared");
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry["path"] == "generated.pyc")
                .unwrap()["reason_code"],
            "excluded"
        );
        assert_eq!(status("empty"), serde_json::Value::Null);
        assert_eq!(result["index"]["file_count"], 6);
        assert_eq!(result["index"]["directory_count"], 3);
        assert_eq!(result["changed_file_count"], 3);
        assert_eq!(content_hash::hash_directory(&installed).unwrap(), before);
        assert_eq!(content_hash::hash_directory(source.path()).unwrap(), after);
        assert_eq!(
            repo.store
                .get_skill_by_id(&skill.id)
                .unwrap()
                .unwrap()
                .source_revision,
            skill.source_revision
        );
    }

    #[cfg(unix)]
    #[test]
    fn skill_browser_keeps_read_failures_and_unknown_absence_in_the_diff() {
        use crate::core::{error::ErrorKind, skill_browser::SkillBrowser};
        use std::os::unix::fs::PermissionsExt;
        let repo = test_repo();
        let installed = write_skill_dir("partial-diff");
        let source = tempfile::tempdir().unwrap();
        for root in [&installed, &source.path().to_path_buf()] {
            fs::write(root.join("SKILL.md"), "# 可读的一致正文").unwrap();
            fs::write(root.join("denied.txt"), "不可读正文").unwrap();
            fs::create_dir(root.join("restricted")).unwrap();
            fs::write(root.join("restricted/nested.txt"), "无法判断另一侧是否存在").unwrap();
        }
        fs::set_permissions(
            installed.join("denied.txt"),
            fs::Permissions::from_mode(0o0),
        )
        .unwrap();
        fs::set_permissions(
            installed.join("restricted"),
            fs::Permissions::from_mode(0o0),
        )
        .unwrap();
        fs::write(source.path().join("known-added.txt"), "已确认本地缺失").unwrap();
        let permissions_enforced = fs::read(installed.join("denied.txt")).is_err();
        let mut skill = sample_skill("partial-diff", "partial-diff", &installed);
        skill.source_ref = Some(source.path().to_string_lossy().into_owned());
        repo.store.insert_skill(&skill).unwrap();
        let browser = SkillBrowser::default();
        let local = browser.open(&repo.store, &skill.id).unwrap();
        let result = browser.source_diff(&skill.id, &local.session_id);
        let known_missing = browser.read(&skill.id, &local.session_id, "known-added.txt");
        let missing_read = browser.read(&skill.id, &local.session_id, "restricted/nested.txt");
        fs::set_permissions(
            installed.join("denied.txt"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fs::set_permissions(
            installed.join("restricted"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        if !permissions_enforced {
            eprintln!("当前用户不受权限限制，权限场景未执行");
            return;
        }
        let result = result.unwrap();
        assert!(!result.index.complete);
        assert_eq!(result.changed_file_count, 1);
        assert_eq!(known_missing.unwrap_err().kind, ErrorKind::NotFound);
        assert_eq!(
            result
                .entries
                .iter()
                .find(|entry| entry.path == "known-added.txt")
                .unwrap()
                .status
                .as_deref(),
            Some("added")
        );
        let denied = result
            .entries
            .iter()
            .find(|entry| entry.path == "denied.txt")
            .unwrap();
        assert_eq!(denied.status.as_deref(), Some("uncomparable"));
        assert!(denied.reason.is_some());
        let nested = result
            .entries
            .iter()
            .find(|entry| entry.path == "restricted/nested.txt")
            .unwrap();
        assert_eq!(nested.status.as_deref(), Some("uncomparable"));
        assert_eq!(nested.local_presence, "unknown");
        assert_eq!(nested.source_presence, "present");
        assert_eq!(missing_read.unwrap_err().kind, ErrorKind::UnknownPresence);
        assert_eq!(nested.reason_code.as_deref(), Some("unknown_presence"));
        assert_eq!(
            result
                .entries
                .iter()
                .find(|entry| entry.path == "SKILL.md")
                .unwrap()
                .status
                .as_deref(),
            Some("unchanged")
        );
    }

    #[cfg(unix)]
    #[test]
    fn skill_browser_preserves_source_directory_failure_in_the_union() {
        use crate::core::skill_browser::SkillBrowser;
        use std::os::unix::fs::PermissionsExt;
        let repo = test_repo();
        let installed = write_skill_dir("unreadable-source-directory");
        let source = tempfile::tempdir().unwrap();
        fs::create_dir(installed.join("restricted")).unwrap();
        fs::create_dir(source.path().join("restricted")).unwrap();
        fs::write(
            source.path().join("restricted/hidden.txt"),
            "无法枚举的来源文件",
        )
        .unwrap();
        fs::set_permissions(
            source.path().join("restricted"),
            fs::Permissions::from_mode(0o0),
        )
        .unwrap();
        let permissions_enforced = fs::read_dir(source.path().join("restricted")).is_err();
        let mut skill = sample_skill(
            "unreadable-source-directory",
            "unreadable-source-directory",
            &installed,
        );
        skill.source_ref = Some(source.path().to_string_lossy().into_owned());
        repo.store.insert_skill(&skill).unwrap();
        let browser = SkillBrowser::default();
        let local = browser.open(&repo.store, &skill.id).unwrap();
        let result = browser.source_diff(&skill.id, &local.session_id);
        fs::set_permissions(
            source.path().join("restricted"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        if !permissions_enforced {
            eprintln!("当前用户不受权限限制，权限场景未执行");
            return;
        }
        let result = result.unwrap();
        let comparison = result
            .entries
            .iter()
            .find(|entry| entry.path == "restricted")
            .unwrap();
        assert!(comparison.local.as_ref().unwrap().error.is_none());
        let source_error = comparison.source.as_ref().unwrap().error.as_ref().unwrap();
        let directory = result
            .index
            .entries
            .iter()
            .find(|entry| entry.path == "restricted")
            .unwrap();
        assert_eq!(directory.error.as_ref(), Some(source_error));
        assert!(!result.index.complete);
        assert_eq!(comparison.status, None);
    }

    #[cfg(unix)]
    #[test]
    fn skill_browser_keeps_directory_presence_unknown_under_unreadable_ancestors() {
        use crate::core::skill_browser::SkillBrowser;
        use std::os::unix::fs::PermissionsExt;
        for blocked_side in ["local", "source"] {
            let repo = test_repo();
            let installed = write_skill_dir("unknown-directory");
            let source = tempfile::tempdir().unwrap();
            fs::copy(installed.join("SKILL.md"), source.path().join("SKILL.md")).unwrap();
            for root in [installed.as_path(), source.path()] {
                fs::create_dir_all(root.join("restricted/empty")).unwrap();
                fs::create_dir(root.join("empty")).unwrap();
            }
            let blocked = if blocked_side == "local" {
                installed.join("restricted")
            } else {
                source.path().join("restricted")
            };
            fs::set_permissions(&blocked, fs::Permissions::from_mode(0o0)).unwrap();
            let permissions_enforced = fs::read_dir(&blocked).is_err();
            let mut skill = sample_skill("unknown-directory", "unknown-directory", &installed);
            skill.source_ref = Some(source.path().to_string_lossy().into_owned());
            repo.store.insert_skill(&skill).unwrap();
            let browser = SkillBrowser::default();
            let local = browser.open(&repo.store, &skill.id).unwrap();
            let result = browser.source_diff(&skill.id, &local.session_id);
            fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700)).unwrap();
            if !permissions_enforced {
                eprintln!("当前用户不受权限限制，权限场景未执行");
                continue;
            }
            let result = result.unwrap();
            let descendant = result
                .entries
                .iter()
                .find(|entry| entry.path == "restricted/empty")
                .unwrap();
            let (presence, side) = if blocked_side == "local" {
                (&descendant.local_presence, &descendant.local)
            } else {
                (&descendant.source_presence, &descendant.source)
            };
            assert_eq!(presence, "unknown");
            assert!(side.is_none());
            assert_eq!(descendant.reason_code.as_deref(), Some("unknown_presence"));
            assert!(descendant.reason.is_none());
            assert!(descendant.status.is_none());
            let known_empty = result
                .entries
                .iter()
                .find(|entry| entry.path == "empty")
                .unwrap();
            assert_eq!(known_empty.local_presence, "present");
            assert_eq!(known_empty.source_presence, "present");
            assert!(known_empty.reason_code.is_none());
            assert!(known_empty.status.is_none());
            assert_eq!(result.changed_file_count, 0);
            assert!(!result.index.complete);
        }
    }

    #[cfg(unix)]
    #[test]
    fn skill_browser_compares_execution_bits_nontext_and_type_changes_without_reading_link_targets()
    {
        use crate::core::{
            content_hash,
            skill_browser::{SkillBrowser, MAX_PREVIEW_BYTES},
        };
        use std::os::unix::fs::{symlink, PermissionsExt};
        let repo = test_repo();
        let installed = write_skill_dir("typed-diff");
        let source = tempfile::tempdir().unwrap();
        for root in [&installed, &source.path().to_path_buf()] {
            fs::write(root.join("SKILL.md"), "# 一致").unwrap();
            fs::write(root.join("mode.sh"), "只读，不执行").unwrap();
        }
        fs::set_permissions(installed.join("mode.sh"), fs::Permissions::from_mode(0o744)).unwrap();
        fs::set_permissions(
            source.path().join("mode.sh"),
            fs::Permissions::from_mode(0o654),
        )
        .unwrap();
        assert_ne!(
            content_hash::hash_directory(&installed).unwrap(),
            content_hash::hash_directory(source.path()).unwrap()
        );
        fs::write(installed.join("binary.bin"), [0, 1]).unwrap();
        fs::write(source.path().join("binary.bin"), [0, 2]).unwrap();
        fs::write(installed.join("encoding.txt"), [0xff, 0xfe]).unwrap();
        fs::write(source.path().join("encoding.txt"), [0xff, 0xfe]).unwrap();
        fs::write(
            installed.join("large.txt"),
            vec![b'a'; MAX_PREVIEW_BYTES + 1],
        )
        .unwrap();
        fs::write(
            source.path().join("large.txt"),
            vec![b'b'; MAX_PREVIEW_BYTES + 1],
        )
        .unwrap();
        fs::write(installed.join("file-to-dir"), "原文件").unwrap();
        fs::create_dir(source.path().join("file-to-dir")).unwrap();
        fs::write(source.path().join("file-to-dir/nested.txt"), "目录内新增").unwrap();
        fs::create_dir(installed.join("dir-to-file")).unwrap();
        fs::write(installed.join("dir-to-file/nested.txt"), "目录内删除").unwrap();
        fs::write(source.path().join("dir-to-file"), "来源文件").unwrap();
        fs::write(installed.join("file-to-link"), "原文件").unwrap();
        symlink("/不允许读取的目标", source.path().join("file-to-link")).unwrap();
        symlink("/目标之一", installed.join("link-only")).unwrap();
        symlink("/目标之二", source.path().join("link-only")).unwrap();
        let before = content_hash::hash_directory(&installed).unwrap();
        let after = content_hash::hash_directory(source.path()).unwrap();
        let mut skill = sample_skill("typed-diff", "typed-diff", &installed);
        skill.source_ref = Some(source.path().to_string_lossy().into_owned());
        repo.store.insert_skill(&skill).unwrap();
        let browser = SkillBrowser::default();
        let local = browser.open(&repo.store, &skill.id).unwrap();
        let diff = browser.source_diff(&skill.id, &local.session_id).unwrap();
        let entry = |path| {
            diff.entries
                .iter()
                .find(|entry| entry.path == path)
                .unwrap()
        };
        let mode = entry("mode.sh");
        assert_eq!(mode.status.as_deref(), Some("modified"));
        assert_eq!(
            (
                mode.exec_bits_before,
                mode.exec_bits_after,
                mode.content_changed
            ),
            (Some(0o100), Some(0o010), Some(false))
        );
        for path in [
            "binary.bin",
            "large.txt",
            "file-to-dir",
            "dir-to-file",
            "file-to-link",
        ] {
            assert_eq!(entry(path).status.as_deref(), Some("modified"), "{path}");
        }
        assert_eq!(entry("file-to-dir").local.as_ref().unwrap().kind, "file");
        assert_eq!(
            entry("file-to-dir").source.as_ref().unwrap().kind,
            "directory"
        );
        assert_eq!(
            entry("file-to-dir").reason_code.as_deref(),
            Some("type_changed")
        );
        assert_eq!(
            entry("file-to-dir/nested.txt").status.as_deref(),
            Some("added")
        );
        assert_eq!(
            entry("dir-to-file/nested.txt").status.as_deref(),
            Some("removed")
        );
        assert_eq!(entry("link-only").status.as_deref(), Some("not_compared"));
        assert_eq!(
            entry("link-only").reason_code.as_deref(),
            Some("unsupported_type")
        );
        assert_eq!(entry("encoding.txt").status.as_deref(), Some("unchanged"));
        assert_eq!(diff.changed_file_count, 8);
        for (path, expected) in [
            ("large.txt", "too_large"),
            ("binary.bin", "binary"),
            ("encoding.txt", "unsupported_encoding"),
            ("file-to-link", "symlink"),
        ] {
            let preview = browser
                .read_side(&skill.id, &local.session_id, path, "source")
                .unwrap();
            assert_eq!(preview.kind, expected);
            assert!(preview.text.is_none());
        }
        assert_eq!(content_hash::hash_directory(&installed).unwrap(), before);
        assert_eq!(content_hash::hash_directory(source.path()).unwrap(), after);
    }

    #[test]
    fn skill_browser_browses_original_source_without_changing_installed_content() {
        use crate::core::skill_browser::SkillBrowser;
        let repo = test_repo();
        let installed = write_skill_dir("source-browser");
        let source = tempfile::tempdir().unwrap();
        fs::create_dir_all(source.path().join("refs/deep/empty")).unwrap();
        fs::write(source.path().join("SKILL.md"), "# 原始来源").unwrap();
        fs::write(source.path().join("refs/deep/.hidden"), "来源文件").unwrap();
        let mut skill = sample_skill("source-browser", "source-browser", &installed);
        skill.source_ref = Some(source.path().to_string_lossy().into_owned());
        repo.store.insert_skill(&skill).unwrap();
        let browser = SkillBrowser::default();
        let local = browser.open(&repo.store, &skill.id).unwrap();
        let original = browser
            .prepare_source(&skill.id, &local.session_id)
            .unwrap();
        assert_eq!(original.index.session_id, local.session_id);
        assert!(original
            .index
            .entries
            .iter()
            .any(|entry| entry.path == "refs/deep/empty"));
        assert_eq!(
            browser
                .read_side(&skill.id, &local.session_id, "refs/deep/.hidden", "source")
                .unwrap()
                .text
                .as_deref(),
            Some("来源文件")
        );
        assert!(browser
            .read(&skill.id, &local.session_id, "refs/deep/.hidden")
            .is_err());
        assert_eq!(
            browser
                .prepare_source(&skill.id, &local.session_id)
                .unwrap()
                .revision,
            original.revision
        );
        assert_eq!(
            fs::read_to_string(installed.join("SKILL.md")).unwrap(),
            "---\nname: source-browser\n---\n"
        );
        browser.close(&skill.id, &local.session_id).unwrap();
        assert!(browser
            .prepare_source(&skill.id, &local.session_id)
            .is_err());
    }

    #[test]
    fn skill_browser_lists_the_complete_installed_directory_and_reads_on_demand() {
        use crate::core::skill_browser::SkillBrowser;
        let repo = test_repo();
        let dir = write_skill_dir("complete");
        fs::create_dir_all(dir.join("a/b/c/d/e/empty")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("__pycache__")).unwrap();
        fs::write(dir.join(".gitignore"), "cache").unwrap();
        fs::write(dir.join("a/b/c/d/e/code.py"), "print('只读')\n").unwrap();
        fs::write(dir.join("empty.txt"), "").unwrap();
        repo.store
            .insert_skill(&sample_skill("complete", "complete", &dir))
            .unwrap();
        let browser = SkillBrowser::default();
        let index = browser.open(&repo.store, "complete").unwrap();
        assert!(index.complete);
        assert_eq!(index.entry_path.as_deref(), Some("SKILL.md"));
        assert_eq!(index.file_count, 4);
        assert_eq!(index.directory_count, 8);
        assert!(index
            .entries
            .iter()
            .any(|entry| entry.path == "a/b/c/d/e/empty" && entry.kind == "directory"));
        let preview = browser
            .read("complete", &index.session_id, "a/b/c/d/e/code.py")
            .unwrap();
        assert_eq!(preview.kind, "text");
        assert_eq!(preview.text.as_deref(), Some("print('只读')\n"));
        assert_eq!(
            browser
                .read("complete", &index.session_id, "empty.txt")
                .unwrap()
                .text
                .as_deref(),
            Some("")
        );
        browser.close("complete", &index.session_id).unwrap();
        assert!(browser
            .read("complete", &index.session_id, "SKILL.md")
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn skill_browser_rejects_escape_but_reads_legal_unix_names_without_following_links() {
        use crate::core::skill_browser::SkillBrowser;
        use std::os::unix::{fs::symlink, net::UnixListener};
        let repo = test_repo();
        let dir = write_skill_dir("boundary");
        fs::write(dir.join("合法:文件\\名.txt"), "合法名称").unwrap();
        let outside = repo._tmp.path().join("outside.txt");
        fs::write(&outside, "不能泄露").unwrap();
        symlink(&outside, dir.join("outside-link")).unwrap();
        let _socket = UnixListener::bind(dir.join("socket")).unwrap();
        repo.store
            .insert_skill(&sample_skill("boundary", "boundary", &dir))
            .unwrap();
        let browser = SkillBrowser::default();
        let index = browser.open(&repo.store, "boundary").unwrap();
        assert!(index.complete);
        assert_eq!(
            index
                .entries
                .iter()
                .find(|entry| entry.path == "socket")
                .unwrap()
                .kind,
            "special"
        );
        assert_eq!(
            browser
                .read("boundary", &index.session_id, "合法:文件\\名.txt")
                .unwrap()
                .text
                .as_deref(),
            Some("合法名称")
        );
        let link = browser
            .read("boundary", &index.session_id, "outside-link")
            .unwrap();
        assert_eq!(link.kind, "symlink");
        assert!(link.text.is_none());
        for path in [
            "/etc/passwd",
            "../outside.txt",
            "SKILL.md/../outside.txt",
            "./SKILL.md",
            "outside-link/child",
            "",
        ] {
            assert!(
                browser.read("boundary", &index.session_id, path).is_err(),
                "错误放行：{path}"
            );
        }
        assert!(browser
            .read("other-skill", &index.session_id, "SKILL.md")
            .is_err());
        assert!(browser.open(&repo.store, "not-installed").is_err());
    }

    #[test]
    fn skill_browser_invalidates_changed_files_even_when_size_and_mtime_are_restored() {
        use crate::core::{error::ErrorKind, skill_browser::SkillBrowser};
        let repo = test_repo();
        let dir = write_skill_dir("changed");
        let file = dir.join("SKILL.md");
        let before = fs::metadata(&file).unwrap();
        repo.store
            .insert_skill(&sample_skill("changed", "changed", &dir))
            .unwrap();
        let browser = SkillBrowser::default();
        let index = browser.open(&repo.store, "changed").unwrap();
        fs::write(&file, vec![b'x'; before.len() as usize]).unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(before.modified().unwrap()))
            .unwrap();
        let error = browser
            .read("changed", &index.session_id, "SKILL.md")
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::StaleSnapshot);
        let fresh = browser.open(&repo.store, "changed").unwrap();
        assert_eq!(
            browser
                .read("changed", &fresh.session_id, "SKILL.md")
                .unwrap()
                .text
                .unwrap()
                .len(),
            before.len() as usize
        );
        fs::remove_file(file).unwrap();
        assert_eq!(
            browser
                .read("changed", &fresh.session_id, "SKILL.md")
                .unwrap_err()
                .kind,
            ErrorKind::StaleSnapshot
        );
    }

    #[test]
    fn skill_browser_bounds_preview_and_preserves_nontext_files() {
        use crate::core::skill_browser::SkillBrowser;
        let repo = test_repo();
        let dir = write_skill_dir("bounded");
        fs::write(dir.join("limit.txt"), vec![b'a'; 256 * 1024]).unwrap();
        fs::write(dir.join("over.txt"), vec![b'a'; 256 * 1024 + 1]).unwrap();
        fs::write(dir.join("binary"), [0, 1, 2]).unwrap();
        fs::write(dir.join("encoding"), [0xff, 0xfe]).unwrap();
        fs::File::create(dir.join("large.bin"))
            .unwrap()
            .set_len(128 * 1024 * 1024)
            .unwrap();
        repo.store
            .insert_skill(&sample_skill("bounded", "bounded", &dir))
            .unwrap();
        let browser = SkillBrowser::default();
        let index = browser.open(&repo.store, "bounded").unwrap();
        assert_eq!(
            browser
                .read("bounded", &index.session_id, "limit.txt")
                .unwrap()
                .text
                .unwrap()
                .len(),
            256 * 1024
        );
        for (name, expected) in [
            ("over.txt", "too_large"),
            ("large.bin", "too_large"),
            ("binary", "binary"),
            ("encoding", "unsupported_encoding"),
        ] {
            let preview = browser.read("bounded", &index.session_id, name).unwrap();
            assert_eq!(preview.kind, expected);
            assert!(preview.text.is_none());
        }
        assert_eq!(fs::read(dir.join("binary")).unwrap(), [0, 1, 2]);
        assert_eq!(
            fs::metadata(dir.join("large.bin")).unwrap().len(),
            128 * 1024 * 1024
        );
    }

    #[cfg(unix)]
    #[test]
    fn skill_browser_reports_unreadable_subtrees_and_files_instead_of_empty_content() {
        use crate::core::skill_browser::SkillBrowser;
        use std::os::unix::fs::PermissionsExt;
        let repo = test_repo();
        let dir = write_skill_dir("unreadable");
        fs::create_dir(dir.join("restricted")).unwrap();
        fs::write(dir.join("restricted/secret.txt"), "目录内不可读").unwrap();
        fs::write(dir.join("restricted.txt"), "文件不可读").unwrap();
        fs::set_permissions(dir.join("restricted"), fs::Permissions::from_mode(0o0)).unwrap();
        fs::set_permissions(dir.join("restricted.txt"), fs::Permissions::from_mode(0o0)).unwrap();
        repo.store
            .insert_skill(&sample_skill("unreadable", "unreadable", &dir))
            .unwrap();
        let browser = SkillBrowser::default();
        let index = browser.open(&repo.store, "unreadable").unwrap();
        let read = browser.read("unreadable", &index.session_id, "restricted.txt");
        let permissions_enforced = fs::read(dir.join("restricted.txt")).is_err();
        fs::set_permissions(dir.join("restricted"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(
            dir.join("restricted.txt"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        if !permissions_enforced {
            return;
        }
        assert!(!index.complete);
        assert!(index
            .entries
            .iter()
            .any(|entry| entry.path == "restricted" && entry.error.is_some()));
        assert!(read.is_err());
    }

    #[test]
    fn skill_browser_uses_known_entry_names_and_keeps_other_markdown_browsable() {
        use crate::core::skill_browser::SkillBrowser;
        let repo = test_repo();
        let dir = write_skill_dir("entry");
        fs::remove_file(dir.join("SKILL.md")).unwrap();
        fs::write(dir.join("a-notes.md"), "# 普通笔记").unwrap();
        fs::create_dir(dir.join("docs")).unwrap();
        fs::write(dir.join("docs/SKILL.md"), "# 技能入口").unwrap();
        repo.store
            .insert_skill(&sample_skill("entry", "entry", &dir))
            .unwrap();
        let browser = SkillBrowser::default();
        assert_eq!(
            browser
                .open(&repo.store, "entry")
                .unwrap()
                .entry_path
                .as_deref(),
            Some("docs/SKILL.md")
        );
        fs::remove_file(dir.join("docs/SKILL.md")).unwrap();
        let index = browser.open(&repo.store, "entry").unwrap();
        assert!(index.entry_path.is_none());
        assert_eq!(
            browser
                .read("entry", &index.session_id, "a-notes.md")
                .unwrap()
                .text
                .as_deref(),
            Some("# 普通笔记")
        );
    }

    #[test]
    fn batch_delete_removes_skills_targets_and_stale_metadata_once() {
        let repo = test_repo();
        let skill_one_dir = write_skill_dir("skill-one");
        let skill_two_dir = write_skill_dir("skill-two");
        repo.store
            .insert_skill(&sample_skill("skill-1", "skill-one", &skill_one_dir))
            .unwrap();
        repo.store
            .insert_skill(&sample_skill("skill-2", "skill-two", &skill_two_dir))
            .unwrap();

        let target_dir = repo._tmp.path().join("target-skill-one");
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("SKILL.md"), "# target").unwrap();
        repo.store
            .insert_target(&SkillTargetRecord {
                id: "target-1".to_string(),
                skill_id: "skill-1".to_string(),
                tool: "cursor".to_string(),
                target_path: target_dir.to_string_lossy().to_string(),
                mode: "symlink".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: None,
            })
            .unwrap();

        sync_metadata::write_all_from_db_unlocked(&repo.store).unwrap();
        assert!(sync_metadata::metadata_dir()
            .join("skills/skill-1.json")
            .exists());
        assert!(sync_metadata::metadata_dir()
            .join("skills/skill-2.json")
            .exists());

        let result = delete_managed_skills_by_ids(
            &repo.store,
            &["skill-1".to_string(), "missing-skill".to_string()],
        )
        .unwrap();

        assert_eq!(result.deleted, 1);
        assert_eq!(result.failed, vec!["missing-skill".to_string()]);
        assert!(repo.store.get_skill_by_id("skill-1").unwrap().is_none());
        assert!(repo.store.get_skill_by_id("skill-2").unwrap().is_some());
        assert!(!skill_one_dir.exists());
        assert!(skill_two_dir.exists());
        assert!(!target_dir.exists());
        assert!(!sync_metadata::metadata_dir()
            .join("skills/skill-1.json")
            .exists());
        assert!(sync_metadata::metadata_dir()
            .join("skills/skill-2.json")
            .exists());
    }

    /// The whole point of the preflight: it must see the user's file in the
    /// library *and* the one in an agent's deployed copy, and say which is
    /// which — a bare filename does not tell anyone where to go and rescue it.
    #[test]
    fn the_preflight_covers_the_library_and_every_deployed_copy() {
        let repo = test_repo();
        let central = write_skill_dir("ppt-master");
        fs::create_dir_all(central.join("templates")).unwrap();
        fs::write(central.join("templates/mine.pptx"), "user work").unwrap();
        repo.store
            .insert_skill(&sample_skill("skill-1", "ppt-master", &central))
            .unwrap();

        // A copy-mode deployment the user has also written into.
        let target_dir = repo._tmp.path().join("agent/ppt-master");
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("SKILL.md"), "x").unwrap();
        fs::write(target_dir.join("notes.md"), "notes in the agent copy").unwrap();
        repo.store
            .insert_target(&SkillTargetRecord {
                id: "t1".to_string(),
                skill_id: "skill-1".to_string(),
                tool: "claude_code".to_string(),
                target_path: target_dir.to_string_lossy().to_string(),
                mode: "copy".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: None,
            })
            .unwrap();

        // The new version carries only SKILL.md.
        let staged = repo._tmp.path().join("staged");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("SKILL.md"), "v2").unwrap();

        let skill = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        let pending = pending_removals_for(&repo.store, &skill, Some(&staged)).unwrap();

        let found: Vec<(String, String)> = pending
            .iter()
            .map(|p| (p.location.clone(), p.path.replace('\\', "/")))
            .collect();
        assert!(
            found.contains(&(LIBRARY_LOCATION.to_string(), "templates/".to_string())),
            "the library's own directory must be reported: {found:?}"
        );
        assert!(
            found.contains(&("claude_code".to_string(), "notes.md".to_string())),
            "the agent copy is torn down and rebuilt too: {found:?}"
        );
    }

    /// With no content change nothing is swapped, so the library keeps what it
    /// has — but the deployments are still rebuilt from it, which is its own way
    /// to lose a file.
    #[test]
    fn a_metadata_only_update_still_checks_the_deployed_copies() {
        let repo = test_repo();
        let central = write_skill_dir("stable");
        repo.store
            .insert_skill(&sample_skill("skill-1", "stable", &central))
            .unwrap();

        let target_dir = repo._tmp.path().join("agent/stable");
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("SKILL.md"), "x").unwrap();
        fs::write(target_dir.join("mine.txt"), "only in the agent copy").unwrap();
        repo.store
            .insert_target(&SkillTargetRecord {
                id: "t1".to_string(),
                skill_id: "skill-1".to_string(),
                tool: "cursor".to_string(),
                target_path: target_dir.to_string_lossy().to_string(),
                mode: "copy".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: None,
            })
            .unwrap();

        let skill = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        // `None` staged: the library is unchanged, and is itself the baseline.
        let pending = pending_removals_for(&repo.store, &skill, None).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].location, "cursor");
        assert_eq!(pending[0].path, "mine.txt");
    }

    /// 检查完成后中央技能库仍可能再次被修改；显式更新必须读取点击时的真实内容，
    /// 不能复用检查阶段缓存的数据库哈希。
    #[test]
    fn explicit_update_compares_the_live_central_content() {
        let source = tempdir().unwrap();
        let central = tempdir().unwrap();
        fs::write(source.path().join("SKILL.md"), "来源内容\n").unwrap();
        fs::write(central.path().join("SKILL.md"), "检查后的本地修改\n").unwrap();
        let source_hash = crate::core::content_hash::hash_directory(source.path()).unwrap();

        assert!(source_differs_from_current_central(central.path(), &source_hash).unwrap());
    }

    /// Symlink-mode deployments are not copied over, so they are not at risk and
    /// must not generate noise.
    #[test]
    fn symlink_deployments_are_not_reported() {
        let repo = test_repo();
        let central = write_skill_dir("linked");
        repo.store
            .insert_skill(&sample_skill("skill-1", "linked", &central))
            .unwrap();

        let target_dir = repo._tmp.path().join("agent/linked");
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("whatever.md"), "x").unwrap();
        repo.store
            .insert_target(&SkillTargetRecord {
                id: "t1".to_string(),
                skill_id: "skill-1".to_string(),
                tool: "grok".to_string(),
                target_path: target_dir.to_string_lossy().to_string(),
                mode: "symlink".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: None,
            })
            .unwrap();

        let skill = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        assert!(pending_removals_for(&repo.store, &skill, None)
            .unwrap()
            .is_empty());
    }

    /// An approval answers one exact question: this revision, this list.
    #[test]
    fn an_approval_does_not_carry_to_a_different_revision_or_list() {
        let a = vec![PendingRemoval {
            location: LIBRARY_LOCATION.to_string(),
            path: "templates/mine.pptx".to_string(),
        }];
        let mut b = a.clone();
        b.push(PendingRemoval {
            location: LIBRARY_LOCATION.to_string(),
            path: "templates/another.pptx".to_string(),
        });

        assert_eq!(
            removal_approval_token("rev1", &a),
            removal_approval_token("rev1", &a),
            "the same question must produce the same token"
        );
        assert_ne!(
            removal_approval_token("rev1", &a),
            removal_approval_token("rev2", &a),
            "upstream moved on"
        );
        assert_ne!(
            removal_approval_token("rev1", &a),
            removal_approval_token("rev1", &b),
            "the skill wrote another file while the dialog was open"
        );
    }

    /// Drives the real `reimport_local_skill_internal`, because the bug this
    /// guards against was in the wiring, not the hash: the approval was compared
    /// against a constant, so the recomputed list was never consulted. A test
    /// that only calls the token function twice passes either way.
    #[test]
    fn a_stale_reimport_approval_does_not_authorize_a_grown_list() {
        let repo = test_repo();
        let source = repo._tmp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "---\nname: gen\n---\n").unwrap();

        let central = write_skill_dir("gen");
        fs::write(central.join("mine.txt"), "user work").unwrap();
        let mut record = sample_skill("skill-1", "gen", &central);
        record.source_ref = Some(source.to_string_lossy().to_string());
        repo.store.insert_skill(&record).unwrap();

        // First attempt: held, with a token for the list the user is shown.
        let first = reimport_local_skill_internal(&repo.store, "skill-1", None).unwrap();
        assert_eq!(first.pending_removals.len(), 1);
        let shown = first.removal_approval.clone().unwrap();
        assert!(central.join("mine.txt").is_file(), "nothing may be touched");

        // The skill writes another file while the dialog is open.
        fs::write(central.join("appeared-later.txt"), "also mine").unwrap();

        // The old approval must not cover it.
        let second = reimport_local_skill_internal(&repo.store, "skill-1", Some(&shown)).unwrap();
        assert_eq!(
            second.pending_removals.len(),
            2,
            "the grown list must be shown again, not silently applied"
        );
        assert!(central.join("appeared-later.txt").is_file());
        assert!(central.join("mine.txt").is_file());

        // Approving the list actually shown does go through.
        let approved = second.removal_approval.clone().unwrap();
        let third = reimport_local_skill_internal(&repo.store, "skill-1", Some(&approved)).unwrap();
        assert!(third.pending_removals.is_empty());
        assert!(
            !central.join("mine.txt").exists(),
            "the approved removal applies"
        );
    }

    fn write_skill_at(root: &Path, rel: &str) -> PathBuf {
        let dir = root.join(rel);
        fs::create_dir_all(&dir).unwrap();
        let basename = dir.file_name().unwrap().to_string_lossy().to_string();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {basename}\n---\n"),
        )
        .unwrap();
        dir
    }

    #[test]
    fn collect_git_skill_dirs_finds_nested_categories() {
        // Mirrors mattpocock/skills layout: skills/<category>/<skill>/SKILL.md.
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        write_skill_at(root, "in-progress/foo");
        write_skill_at(root, "in-progress/bar");
        write_skill_at(root, "stable/baz");

        let dirs = collect_git_skill_dirs(root);
        let keys: Vec<String> = dirs.iter().map(|d| skill_rel_key(root, d)).collect();
        assert_eq!(dirs.len(), 3, "should find skills two levels deep");
        assert!(keys.contains(&"in-progress/foo".to_string()));
        assert!(keys.contains(&"in-progress/bar".to_string()));
        assert!(keys.contains(&"stable/baz".to_string()));
    }

    #[test]
    fn collect_git_skill_dirs_returns_self_when_root_is_skill() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("SKILL.md"), "---\nname: x\n---").unwrap();
        let dirs = collect_git_skill_dirs(root);
        assert_eq!(dirs, vec![root.to_path_buf()]);
    }

    #[test]
    fn collect_git_skill_dirs_returns_empty_when_no_skills() {
        // Previously this case returned [skill_dir] as a bogus fallback,
        // which then surfaced a non-skill category dir as installable.
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("empty-category")).unwrap();
        let dirs = collect_git_skill_dirs(root);
        assert!(dirs.is_empty(), "no fallback to scan root when empty");
    }

    #[test]
    fn skill_rel_key_uses_forward_slashes() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("repo");
        let nested = root.join("a").join("b");
        let key = skill_rel_key(&root, &nested);
        assert_eq!(key, "a/b");
    }

    #[test]
    fn skill_rel_key_disambiguates_same_basename_across_categories() {
        // Two skills with the same dir basename in different categories must
        // produce distinct rel keys — that's the point of using rel paths.
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let a_foo = write_skill_at(root, "category-a/foo");
        let b_foo = write_skill_at(root, "category-b/foo");

        let dirs = collect_git_skill_dirs(root);
        assert_eq!(dirs.len(), 2);

        let k_a = skill_rel_key(root, &a_foo);
        let k_b = skill_rel_key(root, &b_foo);
        assert_ne!(k_a, k_b);
        assert_eq!(k_a, "category-a/foo");
        assert_eq!(k_b, "category-b/foo");
    }

    // ── RemoteKey dedup (batch check_all fan-out) ──

    fn source(clone_url: &str, branch: Option<&str>, subpath: Option<&str>) -> GitSkillSource {
        GitSkillSource {
            clone_url: clone_url.to_string(),
            branch: branch.map(str::to_string),
            subpath: subpath.map(str::to_string),
            locator_skill_id: None,
        }
    }

    /// The whole point of keying Phase A by `RemoteKey`: skills installed from
    /// different subdirectories of the same monorepo (same clone_url + branch)
    /// must collapse to one network query, while a different branch stays
    /// distinct. This is what turns 4 `mattpocock/skills` skills into 1
    /// `ls-remote` instead of 4.
    #[test]
    fn remote_key_dedups_by_url_and_branch_ignoring_subpath() {
        let mut per_remote: HashMap<RemoteKey, usize> = HashMap::new();
        let skills = [
            source("https://github.com/mattpocock/skills.git", None, Some("a")),
            source(
                "https://github.com/mattpocock/skills",
                None,
                Some("same-repo"),
            ),
            source("https://github.com/mattpocock/skills.git", None, Some("b")),
            source("https://github.com/mattpocock/skills.git", None, None),
            source("https://github.com/vercel/ai.git", None, None),
            // Same repo, different branch → must NOT collapse with the None-branch group.
            source(
                "https://github.com/mattpocock/skills.git",
                Some("next"),
                None,
            ),
        ];
        for s in skills {
            *per_remote
                .entry(RemoteKey::new(s.clone_url, s.branch))
                .or_insert(0) += 1;
        }

        assert_eq!(per_remote.len(), 3, "distinct remotes to query");
        assert_eq!(
            per_remote
                [&RemoteKey::new("https://github.com/mattpocock/skills.git".to_string(), None,)],
            4,
            "等价 URL 下的四个子路径必须共享一次远端解析"
        );
        assert_eq!(
            per_remote[&RemoteKey::new(
                "https://github.com/mattpocock/skills.git".to_string(),
                Some("next".to_string()),
            )],
            1,
            "a different branch is a separate remote"
        );
    }

    fn remote(url: &str, branch: Option<&str>) -> RemoteKey {
        RemoteKey::new(url.to_string(), branch.map(str::to_string))
    }

    fn resolved_remote_for_skills(
        store: &SkillStore,
        revision: &str,
        skill_ids: &[String],
    ) -> ResolvedRemote {
        let skills = skill_ids
            .iter()
            .map(|skill_id| {
                let skill = store.get_skill_by_id(skill_id).unwrap().unwrap();
                let source = git_source_from_skill(&skill).unwrap();
                let content_hash =
                    crate::core::content_hash::hash_directory(Path::new(&skill.central_path))
                        .unwrap();
                (
                    skill_id.clone(),
                    RemoteSkillContent {
                        source_subpath: source.subpath,
                        locator_skill_id: source.locator_skill_id,
                        content_hash: Ok(content_hash),
                    },
                )
            })
            .collect();
        ResolvedRemote {
            revision: revision.to_string(),
            skills: Arc::new(skills),
        }
    }

    #[test]
    fn check_all_contract_returns_stable_results_and_isolates_failures() {
        let repo = test_repo();
        insert_git_skill(&repo.store, "zeta", "https://example.test/good.git");
        insert_git_skill(&repo.store, "alpha", "https://example.test/bad.git");
        let local_dir = write_skill_dir("local-copy");
        let mut local_copy = sample_skill("local-copy", "local-copy", &local_dir);
        local_copy.source_ref = None;
        repo.store.insert_skill(&local_copy).unwrap();

        let events = Mutex::new(Vec::<SkillUpdateBatchProgress>::new());
        let result = skill_update_batch::check_with_concurrency(
            &repo.store,
            &StoredSkillUpdateCheckAdapter { store: &repo.store },
            CheckSkillUpdatesBatch {
                batch_id: "batch-42",
                force_check: true,
                concurrency: DEFAULT_CHECK_CONCURRENCY,
                requested_skill_ids: None,
                stop: &AtomicBool::new(false),
            },
            |key, skill_ids| {
                if key.clone_url.ends_with("/bad") {
                    Err("远端不可用".to_string())
                } else {
                    Ok(resolved_remote_for_skills(
                        &repo.store,
                        "old-rev",
                        skill_ids,
                    ))
                }
            },
            |event| events.lock().unwrap().push(event),
        )
        .unwrap();

        assert_eq!(result.batch_id, "batch-42");
        assert_eq!(result.skipped, 1);
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| item.skill_id.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "zeta"],
            "逐项结果必须按名称稳定排序"
        );
        assert_eq!(
            result.items[0].status,
            SkillUpdateBatchProgressStatus::Error
        );
        assert_eq!(result.items[0].error.as_deref(), Some("远端不可用"));
        assert_eq!(
            result.items[1].status,
            SkillUpdateBatchProgressStatus::UpToDate
        );
        let serialized = serde_json::to_value(&result).unwrap();
        assert_eq!(serialized["items"][0]["status"], "error");
        assert_eq!(serialized["items"][1]["status"], "up_to_date");

        let events = events.into_inner().unwrap();
        assert!(events.iter().all(|event| event.batch_id == "batch-42"));
        assert!(events.iter().any(|event| {
            event.skill_id == "alpha" && event.status == SkillUpdateBatchProgressStatus::Error
        }));
        assert!(events.iter().any(|event| {
            event.skill_id == "zeta" && event.status == SkillUpdateBatchProgressStatus::UpToDate
        }));
        let serialized_event = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(serialized_event["phase"], "check");
    }

    #[test]
    fn check_all_contract_dedups_remotes_and_uses_default_concurrency_eight() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let repo = test_repo();
        for index in 0..10 {
            let remote_index = if index < 2 { 0 } else { index - 1 };
            insert_git_skill(
                &repo.store,
                &format!("skill-{index:02}"),
                &format!("https://example.test/remote-{remote_index}.git"),
            );
        }

        let calls = Mutex::new(HashMap::<String, usize>::new());
        let in_flight = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let result = skill_update_batch::check_with_concurrency(
            &repo.store,
            &StoredSkillUpdateCheckAdapter { store: &repo.store },
            CheckSkillUpdatesBatch {
                batch_id: "batch-concurrency",
                force_check: true,
                concurrency: DEFAULT_CHECK_CONCURRENCY,
                requested_skill_ids: None,
                stop: &AtomicBool::new(false),
            },
            |key, skill_ids| {
                *calls
                    .lock()
                    .unwrap()
                    .entry(key.clone_url.clone())
                    .or_default() += 1;
                let current = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(20));
                in_flight.fetch_sub(1, Ordering::SeqCst);
                Ok(resolved_remote_for_skills(
                    &repo.store,
                    "old-rev",
                    skill_ids,
                ))
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(DEFAULT_CHECK_CONCURRENCY, 8);
        assert_eq!(result.items.len(), 10);
        let calls = calls.into_inner().unwrap();
        assert_eq!(calls.len(), 9, "十个 Skill 只对应九个不同远端");
        assert_eq!(
            calls["https://example.test/remote-0"], 1,
            "共享远端只解析一次"
        );
        assert!(peak.load(Ordering::SeqCst) <= DEFAULT_CHECK_CONCURRENCY);
        assert!(peak.load(Ordering::SeqCst) >= 2, "不同远端应并发解析");
    }

    /// 同一单仓库中只有一个 Skill 子目录变化时，只能把该 Skill 标记为可更新，
    /// 其余兄弟 Skill 复用同一份快照并保持已是最新。
    #[test]
    fn monorepo_check_marks_only_skills_with_effective_content_changes() {
        let repo = test_repo();
        let remote_url = "https://example.test/monorepo.git";
        insert_git_skill(&repo.store, "changed", remote_url);
        insert_git_skill(&repo.store, "unchanged", remote_url);
        let resolve_calls = std::sync::atomic::AtomicUsize::new(0);

        let result = skill_update_batch::check_with_concurrency(
            &repo.store,
            &StoredSkillUpdateCheckAdapter { store: &repo.store },
            CheckSkillUpdatesBatch {
                batch_id: "monorepo-content",
                force_check: true,
                concurrency: DEFAULT_CHECK_CONCURRENCY,
                requested_skill_ids: None,
                stop: &AtomicBool::new(false),
            },
            |_key, skill_ids| {
                resolve_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                assert_eq!(skill_ids.len(), 2, "同一仓库的两个 Skill 必须共享一次解析");
                let mut remote = resolved_remote_for_skills(&repo.store, "new-rev", skill_ids);
                Arc::make_mut(&mut remote.skills)
                    .get_mut("changed")
                    .unwrap()
                    .content_hash = Ok("changed-source-content".to_string());
                Ok(remote)
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(resolve_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(result.items.len(), 2);
        assert_eq!(result.items[0].skill_id, "changed");
        assert_eq!(
            result.items[0].status,
            SkillUpdateBatchProgressStatus::UpdateAvailable
        );
        assert_eq!(result.items[1].skill_id, "unchanged");
        assert_eq!(
            result.items[1].status,
            SkillUpdateBatchProgressStatus::UpToDate
        );
    }

    #[test]
    fn foreground_check_contract_snapshots_configured_concurrency_one_four_and_eight() {
        for configured in [1usize, 4, 8] {
            let repo = test_repo();
            let skill_ids = insert_concurrency_skills(&repo.store, "check", 12);
            repo.store
                .set_setting(TEST_CHECK_CONCURRENCY_SETTING, &configured.to_string())
                .unwrap();

            let probe = ConcurrencyProbe::new(configured);
            let result = skill_update_batch::check_with_preferences(
                &repo.store,
                &StoredSkillUpdateCheckAdapter { store: &repo.store },
                ForegroundCheckBatch {
                    batch_id: &format!("check-{configured}"),
                    force_check: true,
                    requested_skill_ids: None,
                    stop: &AtomicBool::new(false),
                },
                |_key, skill_ids| {
                    probe.observe(
                        || {
                            // 模拟 Windows 上较慢的设置写入，确保首个 worker 仍计入并发峰值。
                            std::thread::sleep(std::time::Duration::from_millis(60));
                            repo.store
                                .set_setting(TEST_CHECK_CONCURRENCY_SETTING, "8")
                                .unwrap();
                        },
                        Ok(resolved_remote_for_skills(
                            &repo.store,
                            "old-rev",
                            skill_ids,
                        )),
                    )
                },
                |_| {},
            )
            .unwrap();

            assert_eq!(result.items.len(), skill_ids.len());
            assert_eq!(
                probe.peak(),
                configured,
                "前台检查批次必须固定使用启动时读取的并发数"
            );
        }
    }

    #[test]
    fn check_batch_stop_finishes_started_remotes_and_leaves_pending_skills_unstarted() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;

        let repo = test_repo();
        for index in 0..5 {
            insert_git_skill(
                &repo.store,
                &format!("skill-{index}"),
                &format!("https://example.test/check-stop-{index}.git"),
            );
        }
        let stop = AtomicBool::new(false);
        let started = AtomicUsize::new(0);
        let barrier = Barrier::new(2);

        let result = skill_update_batch::check_with_concurrency(
            &repo.store,
            &StoredSkillUpdateCheckAdapter { store: &repo.store },
            CheckSkillUpdatesBatch {
                batch_id: "check-stop",
                force_check: true,
                concurrency: 2,
                requested_skill_ids: None,
                stop: &stop,
            },
            |_key, skill_ids| {
                started.fetch_add(1, Ordering::SeqCst);
                barrier.wait();
                stop.store(true, Ordering::SeqCst);
                Ok(resolved_remote_for_skills(
                    &repo.store,
                    "old-rev",
                    skill_ids,
                ))
            },
            |_| {},
        )
        .unwrap();

        assert!(result.stopped);
        assert_eq!(started.load(Ordering::SeqCst), 2, "停止后不得解析剩余远端");
        assert_eq!(
            result
                .items
                .iter()
                .filter(|item| item.status == SkillUpdateBatchProgressStatus::UpToDate)
                .count(),
            2,
            "已开始的远端检查必须完成并写回结果"
        );
        assert_eq!(
            result
                .items
                .iter()
                .filter(|item| item.status == SkillUpdateBatchProgressStatus::NotStarted)
                .count(),
            3
        );
    }

    #[test]
    fn update_all_contract_uses_default_concurrency_four_and_isolates_each_result() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let repo = test_repo();
        for index in 0..7 {
            insert_git_skill(
                &repo.store,
                &format!("skill-{index}"),
                &format!("https://example.test/update-{index}.git"),
            );
        }
        let skill_ids = (0..7).map(|index| format!("skill-{index}")).collect();
        let in_flight = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let events = Mutex::new(Vec::<SkillUpdateBatchProgress>::new());

        let result = skill_update_batch::update_with_concurrency(
            &repo.store,
            "update-batch-42",
            skill_ids,
            DEFAULT_UPDATE_CONCURRENCY,
            &AtomicBool::new(false),
            |skill| {
                let current = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(20));
                in_flight.fetch_sub(1, Ordering::SeqCst);
                match skill.id.as_str() {
                    "skill-1" => Ok(BatchUpdateExecution::Unchanged),
                    "skill-2" => Ok(BatchUpdateExecution::NeedsConfirmation {
                        pending_removals: vec![PendingRemoval {
                            location: LIBRARY_LOCATION.to_string(),
                            path: "notes.md".to_string(),
                        }],
                        removal_approval: Some("exact-approval".to_string()),
                    }),
                    "skill-3" => Err("远端不可用".to_string()),
                    _ => Ok(BatchUpdateExecution::Updated),
                }
            },
            |event| events.lock().unwrap().push(event),
        )
        .unwrap();

        assert_eq!(DEFAULT_UPDATE_CONCURRENCY, 4);
        assert!(peak.load(Ordering::SeqCst) <= 4);
        assert!(
            peak.load(Ordering::SeqCst) >= 2,
            "前台更新准备阶段应并发执行"
        );
        assert_eq!(result.batch_id.as_deref(), Some("update-batch-42"));
        assert_eq!(result.refreshed, 4);
        assert_eq!(result.unchanged, 1);
        assert_eq!(result.failed, vec!["skill-3: 远端不可用"]);
        assert_eq!(result.held_back, vec!["skill-2"]);
        assert_eq!(result.items.len(), 7);
        assert_eq!(
            result.items[1].status,
            SkillUpdateBatchProgressStatus::Unchanged
        );
        assert_eq!(
            result.items[2].status,
            SkillUpdateBatchProgressStatus::NeedsConfirmation
        );
        assert_eq!(result.items[2].pending_removals[0].path, "notes.md");
        assert_eq!(
            result.items[2].removal_approval.as_deref(),
            Some("exact-approval")
        );
        assert_eq!(
            result.items[3].status,
            SkillUpdateBatchProgressStatus::Error
        );

        let events = events.into_inner().unwrap();
        assert!(events.iter().all(|event| {
            event.batch_id == "update-batch-42" && event.phase == SkillUpdateBatchPhase::Update
        }));
        assert!(events.iter().any(|event| {
            event.skill_id == "skill-2"
                && event.status == SkillUpdateBatchProgressStatus::NeedsConfirmation
        }));
        assert!(events.iter().any(|event| {
            event.skill_id == "skill-3"
                && event.status == SkillUpdateBatchProgressStatus::Error
                && event.error.as_deref() == Some("远端不可用")
        }));
    }

    #[test]
    fn foreground_update_contract_snapshots_configured_concurrency_one_four_and_eight() {
        for configured in [1usize, 4, 8] {
            let repo = test_repo();
            let skill_ids = insert_concurrency_skills(&repo.store, "update", 12);
            repo.store
                .set_setting(TEST_UPDATE_CONCURRENCY_SETTING, &configured.to_string())
                .unwrap();

            let probe = ConcurrencyProbe::new(configured);
            let result = skill_update_batch::update_with_preferences(
                &repo.store,
                &format!("update-{configured}"),
                skill_ids.clone(),
                &AtomicBool::new(false),
                |_skill| {
                    probe.observe(
                        || {
                            repo.store
                                .set_setting(TEST_UPDATE_CONCURRENCY_SETTING, "1")
                                .unwrap();
                        },
                        Ok(BatchUpdateExecution::Updated),
                    )
                },
                |_| {},
            )
            .unwrap();

            assert_eq!(result.items.len(), skill_ids.len());
            assert_eq!(
                probe.peak(),
                configured,
                "前台更新批次必须固定使用启动时读取的并发数"
            );
        }
    }

    #[test]
    fn update_batch_stop_finishes_started_tasks_and_leaves_pending_tasks_unstarted() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;

        let repo = test_repo();
        for index in 0..5 {
            insert_git_skill(
                &repo.store,
                &format!("skill-{index}"),
                &format!("https://example.test/stop-{index}.git"),
            );
        }
        let stop = AtomicBool::new(false);
        let started = AtomicUsize::new(0);
        let barrier = Barrier::new(2);

        let result = skill_update_batch::update_with_concurrency(
            &repo.store,
            "update-stop",
            (0..5).map(|index| format!("skill-{index}")).collect(),
            2,
            &stop,
            |_skill| {
                started.fetch_add(1, Ordering::SeqCst);
                barrier.wait();
                stop.store(true, Ordering::SeqCst);
                Ok(BatchUpdateExecution::Updated)
            },
            |_| {},
        )
        .unwrap();

        assert!(result.stopped);
        assert_eq!(started.load(Ordering::SeqCst), 2, "停止后不得调度剩余任务");
        assert_eq!(
            result
                .items
                .iter()
                .filter(|item| item.status == SkillUpdateBatchProgressStatus::Updated)
                .count(),
            2,
            "已开始任务必须沿安全路径完成"
        );
        assert_eq!(
            result
                .items
                .iter()
                .filter(|item| item.status == SkillUpdateBatchProgressStatus::NotStarted)
                .count(),
            3
        );
    }

    #[test]
    fn retry_batches_execute_only_the_previous_failure_set() {
        let repo = test_repo();
        for id in ["success", "unchanged", "confirm", "failure"] {
            insert_git_skill(
                &repo.store,
                id,
                &format!("https://example.test/retry-{id}.git"),
            );
        }

        let first = skill_update_batch::update_with_concurrency(
            &repo.store,
            "update-first",
            vec![
                "success".to_string(),
                "unchanged".to_string(),
                "confirm".to_string(),
                "failure".to_string(),
            ],
            DEFAULT_UPDATE_CONCURRENCY,
            &AtomicBool::new(false),
            |skill| match skill.id.as_str() {
                "unchanged" => Ok(BatchUpdateExecution::Unchanged),
                "confirm" => Ok(BatchUpdateExecution::NeedsConfirmation {
                    pending_removals: vec![PendingRemoval {
                        location: LIBRARY_LOCATION.to_string(),
                        path: "notes.md".to_string(),
                    }],
                    removal_approval: Some("exact-approval".to_string()),
                }),
                "failure" => Err("远端不可用".to_string()),
                _ => Ok(BatchUpdateExecution::Updated),
            },
            |_| {},
        )
        .unwrap();
        let retry_ids: Vec<String> = first
            .items
            .iter()
            .filter(|item| item.status == SkillUpdateBatchProgressStatus::Error)
            .map(|item| item.skill_id.clone())
            .collect();
        let retried = Mutex::new(Vec::<String>::new());

        let second = skill_update_batch::update_with_concurrency(
            &repo.store,
            "update-retry",
            retry_ids,
            DEFAULT_UPDATE_CONCURRENCY,
            &AtomicBool::new(false),
            |skill| {
                retried.lock().unwrap().push(skill.id.clone());
                Ok(BatchUpdateExecution::Updated)
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(retried.into_inner().unwrap(), vec!["failure"]);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].skill_id, "failure");
        assert_eq!(
            second.items[0].status,
            SkillUpdateBatchProgressStatus::Updated
        );
    }

    #[test]
    fn check_retry_contract_limits_remote_resolution_to_requested_failures() {
        let repo = test_repo();
        insert_git_skill(&repo.store, "failure", "https://example.test/failure.git");
        insert_git_skill(&repo.store, "success", "https://example.test/success.git");
        let requested = vec!["failure".to_string()];
        let resolved = Mutex::new(Vec::<String>::new());

        let result = skill_update_batch::check_with_concurrency(
            &repo.store,
            &StoredSkillUpdateCheckAdapter { store: &repo.store },
            CheckSkillUpdatesBatch {
                batch_id: "check-retry",
                force_check: true,
                concurrency: DEFAULT_CHECK_CONCURRENCY,
                requested_skill_ids: Some(&requested),
                stop: &AtomicBool::new(false),
            },
            |key, skill_ids| {
                resolved.lock().unwrap().push(key.clone_url.clone());
                Ok(resolved_remote_for_skills(
                    &repo.store,
                    "old-rev",
                    skill_ids,
                ))
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(
            resolved.into_inner().unwrap(),
            vec!["https://example.test/failure"]
        );
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].skill_id, "failure");
        assert_eq!(result.skipped, 0);
    }

    #[test]
    fn background_check_still_records_a_source_that_disappeared() {
        let repo = test_repo();
        let central = write_skill_dir("local-source");
        let mut local = sample_skill("local-source", "local-source", &central);
        local.source_ref = Some(
            repo._tmp
                .path()
                .join("已经消失")
                .to_string_lossy()
                .to_string(),
        );
        local.update_status = "up_to_date".to_string();
        repo.store.insert_skill(&local).unwrap();
        assert!(
            !managed_skill_by_id(&repo.store, "local-source")
                .unwrap()
                .can_check_update
        );

        skill_update_batch::check_background(
            &repo.store,
            &StoredSkillUpdateCheckAdapter { store: &repo.store },
            true,
            |_key, _skill_ids| panic!("本地来源不应解析 Git 远端"),
        )
        .unwrap();

        let stored = repo.store.get_skill_by_id("local-source").unwrap().unwrap();
        assert_eq!(stored.update_status, "source_missing");
    }

    #[test]
    fn check_all_contract_preserves_local_only_as_a_non_failure_result() {
        let repo = test_repo();
        let source = write_skill_dir("local-without-baseline");
        let local = sample_skill("local-without-baseline", "local-without-baseline", &source);
        repo.store.insert_skill(&local).unwrap();

        let result = skill_update_batch::check_with_concurrency(
            &repo.store,
            &StoredSkillUpdateCheckAdapter { store: &repo.store },
            CheckSkillUpdatesBatch {
                batch_id: "batch-local",
                force_check: true,
                concurrency: DEFAULT_CHECK_CONCURRENCY,
                requested_skill_ids: None,
                stop: &AtomicBool::new(false),
            },
            |_key, _skill_ids| panic!("本地来源不应解析 Git 远端"),
            |_| {},
        )
        .unwrap();

        assert_eq!(result.items.len(), 1);
        assert_eq!(
            result.items[0].status,
            SkillUpdateBatchProgressStatus::LocalOnly
        );
        assert_eq!(result.items[0].error, None);
    }

    // ── Applying a prefetched remote under the lock ──

    /// A git-backed skill pinned at `old-rev` on `remote_url`.
    fn insert_git_skill(store: &SkillStore, id: &str, remote_url: &str) {
        let dir = write_skill_dir(id);
        let mut skill = sample_skill(id, id, &dir);
        skill.source_type = "git".to_string();
        skill.source_ref = Some(remote_url.to_string());
        skill.source_ref_resolved = Some(remote_url.to_string());
        skill.source_revision = Some("old-rev".to_string());
        skill.update_status = "unknown".to_string();
        store.insert_skill(&skill).unwrap();
    }

    fn prefetch(url: &str, revision: &str, content_hash: &str) -> Option<PrefetchedRemote> {
        let mut skills = HashMap::new();
        skills.insert(
            "skill-1".to_string(),
            RemoteSkillContent {
                source_subpath: None,
                locator_skill_id: None,
                content_hash: Ok(content_hash.to_string()),
            },
        );
        Some(PrefetchedRemote {
            key: remote(url, None),
            result: Ok(ResolvedRemote {
                revision: revision.to_string(),
                skills: Arc::new(skills),
            }),
        })
    }

    /// The happy path: a prefetch resolved for the skill's own remote is applied.
    #[test]
    fn matching_prefetched_remote_is_applied() {
        let repo = test_repo();
        insert_git_skill(&repo.store, "skill-1", "https://example.test/a.git");

        let dto = check_skill_update_internal_with_remote(
            &repo.store,
            "skill-1",
            false,
            prefetch(
                "https://example.test/a.git",
                "new-rev",
                "different-source-hash",
            ),
        )
        .unwrap();

        assert_eq!(dto.update_status, "update_available");
        let stored = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        assert_eq!(stored.source_revision.as_deref(), Some("old-rev"));
        assert_eq!(stored.remote_revision.as_deref(), Some("new-rev"));
    }

    /// 单仓库中的其他目录推动了远端修订，但当前 Skill 的有效内容没有变化时，
    /// 检查应直接推进已对齐修订，不能留下“有可用更新”的假阳性。
    #[test]
    fn matching_prefetched_remote_with_unchanged_content_is_aligned() {
        let repo = test_repo();
        insert_git_skill(&repo.store, "skill-1", "https://example.test/a.git");
        let skill = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        let central_hash =
            crate::core::content_hash::hash_directory(Path::new(&skill.central_path)).unwrap();

        let dto = check_skill_update_internal_with_remote(
            &repo.store,
            "skill-1",
            false,
            prefetch("https://example.test/a.git", "new-rev", &central_hash),
        )
        .unwrap();

        assert_eq!(dto.update_status, "up_to_date");
        let stored = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        assert_eq!(stored.source_revision.as_deref(), Some("new-rev"));
        assert_eq!(stored.remote_revision.as_deref(), Some("new-rev"));
        assert_eq!(
            repo.store
                .get_skill_source_content_hash("skill-1")
                .unwrap()
                .as_deref(),
            Some(central_hash.as_str())
        );
    }

    /// 已对齐修订没有变化，但中央技能库被修改后，必须按真实内容显示来源更新。
    #[test]
    fn central_modification_at_same_remote_revision_is_update_available() {
        let repo = test_repo();
        insert_git_skill(&repo.store, "skill-1", "https://example.test/a.git");
        let skill = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        let original_hash =
            crate::core::content_hash::hash_directory(Path::new(&skill.central_path)).unwrap();
        repo.store
            .update_skill_content_alignment("skill-1", "old-rev", &original_hash, &original_hash)
            .unwrap();
        fs::write(
            Path::new(&skill.central_path).join("SKILL.md"),
            "---\nname: skill-1\n---\n本地修改\n",
        )
        .unwrap();

        let dto = check_skill_update_internal_with_remote(
            &repo.store,
            "skill-1",
            true,
            prefetch("https://example.test/a.git", "old-rev", &original_hash),
        )
        .unwrap();

        assert_eq!(dto.update_status, "update_available");
        let stored = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        assert_eq!(stored.source_revision.as_deref(), Some("old-rev"));
        assert_eq!(stored.remote_revision.as_deref(), Some("old-rev"));
        assert_ne!(stored.content_hash.as_deref(), Some(original_hash.as_str()));
        assert_eq!(
            repo.store
                .get_skill_source_content_hash("skill-1")
                .unwrap()
                .as_deref(),
            Some(original_hash.as_str())
        );
    }

    /// A reinstall between the off-lock resolve and this write keeps the skill's
    /// row but repoints its source. The revision resolved for the *old* remote
    /// must not be recorded against the new one — it would show a fabricated
    /// "up to date"/"update available" for a source it was never read from.
    #[test]
    fn prefetched_remote_for_a_different_source_is_discarded() {
        let repo = test_repo();
        insert_git_skill(&repo.store, "skill-1", "https://example.test/new.git");

        let dto = check_skill_update_internal_with_remote(
            &repo.store,
            "skill-1",
            false,
            prefetch(
                "https://example.test/old.git",
                "rev-of-old-remote",
                "unused-hash",
            ),
        )
        .unwrap();

        assert_eq!(
            dto.update_status, "unknown",
            "status left for the next round"
        );
        let stored = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        assert_eq!(
            stored.remote_revision, None,
            "no revision from a stale remote"
        );
        assert_eq!(stored.last_checked_at, None, "the check did not complete");
    }

    /// A remote that failed to resolve off the lock still has to land as an
    /// `error` status here, not be swallowed as "nothing to apply" — the batch
    /// check counts that error and the card shows the reason.
    #[test]
    fn failed_prefetch_for_the_current_source_records_the_error() {
        let repo = test_repo();
        insert_git_skill(&repo.store, "skill-1", "https://example.test/a.git");

        let err = check_skill_update_internal_with_remote(
            &repo.store,
            "skill-1",
            false,
            Some(PrefetchedRemote {
                key: remote("https://example.test/a.git", None),
                result: Err("could not read from remote".to_string()),
            }),
        )
        .unwrap_err();

        assert!(err.message.contains("could not read from remote"));
        let stored = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        assert_eq!(stored.update_status, "error");
        assert_eq!(
            stored.last_check_error.as_deref(),
            Some("could not read from remote")
        );
    }

    /// Callers hold the central-repo lock across this write, so a git skill with
    /// nothing prefetched must be skipped rather than resolved inline — that
    /// inline call is the lock-held network round-trip behind the 20s "busy"
    /// failures (#315).
    #[test]
    fn missing_prefetch_never_resolves_under_the_lock() {
        let repo = test_repo();
        insert_git_skill(&repo.store, "skill-1", "https://example.test/a.git");

        let dto =
            check_skill_update_internal_with_remote(&repo.store, "skill-1", false, None).unwrap();

        assert_eq!(dto.update_status, "unknown");
        let stored = repo.store.get_skill_by_id("skill-1").unwrap().unwrap();
        assert_eq!(stored.last_checked_at, None, "no network, no write");
    }

    fn write_skill(dir: &Path, name: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: d\n---\nbody\n"),
        )
        .unwrap();
    }

    #[test]
    fn repoint_accepts_a_valid_subpath() {
        let tmp = tempdir().unwrap();
        let repo = tmp.path();
        write_skill(&repo.join("note-manager"), "note-manager");

        let resolved = resolve_repoint_skill_dir(repo, Some("note-manager")).unwrap();
        assert_eq!(resolved, repo.join("note-manager"));
    }

    #[test]
    fn repoint_accepts_repo_root_when_it_is_a_skill() {
        let tmp = tempdir().unwrap();
        write_skill(tmp.path(), "root-skill");

        let resolved = resolve_repoint_skill_dir(tmp.path(), None).unwrap();
        assert_eq!(resolved, tmp.path());
    }

    #[test]
    fn repoint_rejects_repo_root_without_skill_md() {
        let tmp = tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("some-dir")).unwrap();

        let err = resolve_repoint_skill_dir(tmp.path(), None).unwrap_err();
        assert!(
            err.message.contains("not a skill directory"),
            "{}",
            err.message
        );
    }

    #[test]
    fn repoint_rejects_missing_subpath_instead_of_falling_back() {
        let tmp = tempdir().unwrap();
        let repo = tmp.path();
        // A real skill exists elsewhere: the lenient resolver would discover it.
        write_skill(&repo.join("other"), "other");

        let err = resolve_repoint_skill_dir(repo, Some("typo")).unwrap_err();
        assert!(err.message.contains("does not exist"), "{}", err.message);
    }

    #[test]
    fn repoint_rejects_subpath_that_is_not_a_skill_dir() {
        let tmp = tempdir().unwrap();
        let repo = tmp.path();
        fs::create_dir_all(repo.join("docs")).unwrap();

        let err = resolve_repoint_skill_dir(repo, Some("docs")).unwrap_err();
        assert!(
            err.message.contains("not a skill directory"),
            "{}",
            err.message
        );
    }

    #[test]
    fn repoint_rejects_absolute_subpath() {
        let tmp = tempdir().unwrap();
        let outside = tmp.path().join("outside");
        write_skill(&outside, "outside");
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();

        // `Path::join` returns an absolute argument verbatim, so without the
        // guard this would install a directory from outside the checkout.
        let err = resolve_repoint_skill_dir(&repo, Some(outside.to_str().unwrap())).unwrap_err();
        assert!(
            err.message.contains("outside the repository"),
            "{}",
            err.message
        );
    }

    #[test]
    fn repoint_rejects_parent_traversal_subpath() {
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("outside"), "outside");
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();

        let err = resolve_repoint_skill_dir(&repo, Some("../outside")).unwrap_err();
        assert!(
            err.message.contains("outside the repository"),
            "{}",
            err.message
        );
    }

    #[cfg(unix)]
    #[test]
    fn repoint_rejects_symlink_escaping_the_checkout() {
        let tmp = tempdir().unwrap();
        let outside = tmp.path().join("outside");
        write_skill(&outside, "outside");
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("link")).unwrap();

        let err = resolve_repoint_skill_dir(&repo, Some("link")).unwrap_err();
        assert!(
            err.message.contains("outside the repository"),
            "{}",
            err.message
        );
    }

    // ── resolve_skill_dir: install / update / preview resolution ───────────
    //
    // Both inputs reach this from a URL the user pasted. The cases below are
    // the ones that let a crafted or merely wrong URL resolve to something the
    // caller did not ask for.

    #[test]
    fn resolve_accepts_a_subpath_inside_the_checkout() {
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("skills").join("pdf"), "pdf");

        let resolved = resolve_skill_dir(tmp.path(), Some("skills/pdf"), None).unwrap();
        assert_eq!(resolved, tmp.path().join("skills").join("pdf"));
    }

    #[test]
    fn resolve_still_returns_a_container_for_enumeration() {
        // preview/confirm install walk a container to list the skills inside
        // it, so an existing non-skill directory must keep resolving.
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("skills").join("pdf"), "pdf");
        write_skill(&tmp.path().join("skills").join("docx"), "docx");

        let resolved = resolve_skill_dir(tmp.path(), Some("skills"), None).unwrap();
        assert_eq!(resolved, tmp.path().join("skills"));
        // What preview/confirm actually do with that container.
        assert_eq!(collect_git_skill_dirs(&resolved).len(), 2);
    }

    #[test]
    fn resolve_rejects_parent_traversal_with_and_without_a_locator() {
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("outside"), "outside");
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();

        // A locator must not soften the traversal check: the escaping path is
        // refused either way, never quietly ignored in favour of discovery.
        for locator in [None, Some("outside")] {
            let err = resolve_skill_dir(&repo, Some("../outside"), locator).unwrap_err();
            assert!(
                err.message.contains("outside the repository"),
                "locator {locator:?}: {}",
                err.message
            );
        }
    }

    #[test]
    fn resolve_rejects_absolute_subpath() {
        let tmp = tempdir().unwrap();
        let outside = tmp.path().join("outside");
        write_skill(&outside, "outside");
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();

        let err = resolve_skill_dir(&repo, Some(outside.to_str().unwrap()), None).unwrap_err();
        assert!(
            err.message.contains("outside the repository"),
            "{}",
            err.message
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_subpath_symlinked_out_of_the_checkout() {
        let tmp = tempdir().unwrap();
        let outside = tmp.path().join("outside");
        write_skill(&outside, "outside");
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("link")).unwrap();

        let err = resolve_skill_dir(&repo, Some("link"), None).unwrap_err();
        assert!(
            err.message.contains("outside the repository"),
            "{}",
            err.message
        );
    }

    #[test]
    fn resolve_rejects_a_locator_that_escapes_the_checkout() {
        // `owner/repo@../../x` survives parse_skillssh_shorthand, which only
        // checks the owner/repo half, so the locator itself can climb out.
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("outside"), "outside");
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();

        let err = resolve_skill_dir(&repo, None, Some("../outside")).unwrap_err();
        assert!(
            err.message.contains("outside the repository"),
            "{}",
            err.message
        );
    }

    #[test]
    fn resolve_refuses_a_missing_subpath_instead_of_discovering_the_container() {
        // The measured bug: a tree URL naming a directory that does not exist
        // installed the whole `skills/` container as one skill.
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("skills").join("pdf"), "pdf");

        let err = resolve_skill_dir(tmp.path(), Some("artifacts-builder"), None).unwrap_err();
        assert!(err.message.contains("does not exist"), "{}", err.message);
    }

    #[test]
    fn resolve_lets_a_locator_recover_a_skill_that_moved_upstream() {
        // #278's recovery path: the stored subpath is stale because upstream
        // reorganized, and the locator finds the skill at its new home.
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("skills").join("db"), "db");

        let resolved = resolve_skill_dir(tmp.path(), Some("db"), Some("db")).unwrap();
        assert_eq!(resolved, tmp.path().join("skills").join("db"));
    }

    #[test]
    fn resolve_lets_a_locator_override_a_path_that_is_no_longer_the_skill() {
        // The harder half of a reorganization: the stored path still exists,
        // but upstream turned it into a container and moved the skill. Taking
        // the path would copy the container over the installed skill.
        let tmp = tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("db")).unwrap();
        write_skill(&tmp.path().join("db").join("nested"), "nested");
        write_skill(&tmp.path().join("skills").join("db"), "db");

        let resolved = resolve_skill_dir(tmp.path(), Some("db"), Some("db")).unwrap();
        assert_eq!(resolved, tmp.path().join("skills").join("db"));
    }

    #[test]
    fn resolve_errors_when_the_locator_finds_nothing() {
        // Still #278: no match must not fall through to a container or root.
        let tmp = tempdir().unwrap();
        write_skill(&tmp.path().join("skills").join("db"), "db");

        let err = resolve_skill_dir(tmp.path(), Some("gone"), Some("nope-not-here")).unwrap_err();
        assert!(err.message.contains("not found"), "{}", err.message);
    }
}
