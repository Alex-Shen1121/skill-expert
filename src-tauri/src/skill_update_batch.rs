use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::core::{
    error::AppError,
    pending_removal::PendingRemoval,
    skill_store::{SkillRecord, SkillStore},
};

pub const SKILL_UPDATE_BATCH_PROGRESS_EVENT: &str = "skill-update-batch-progress";
pub const DEFAULT_CHECK_CONCURRENCY: usize = 8;
pub const DEFAULT_UPDATE_CONCURRENCY: usize = 4;
const FOREGROUND_BATCH_CHECK_CONCURRENCY_KEY: &str = "foreground_batch_check_concurrency";
const FOREGROUND_BATCH_UPDATE_CONCURRENCY_KEY: &str = "foreground_batch_update_concurrency";

#[derive(Debug, Serialize)]
pub struct BatchUpdateSkillsResult {
    pub batch_id: Option<String>,
    pub stopped: bool,
    pub refreshed: usize,
    pub unchanged: usize,
    pub failed: Vec<String>,
    /// 因可能删除文件而保持原样的 Skill 名称。
    pub held_back: Vec<String>,
    pub items: Vec<BatchUpdateSkillItemResult>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillUpdateBatchPhase {
    Check,
    Update,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillUpdateBatchProgressStatus {
    Waiting,
    Checking,
    Updating,
    Updated,
    Unchanged,
    NeedsConfirmation,
    UpToDate,
    UpdateAvailable,
    Unknown,
    LocalOnly,
    SourceMissing,
    NotStarted,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SkillUpdateBatchProgress {
    pub batch_id: String,
    pub skill_id: String,
    pub phase: SkillUpdateBatchPhase,
    pub status: SkillUpdateBatchProgressStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CheckSkillUpdateItemResult {
    pub skill_id: String,
    pub name: String,
    pub source_type: String,
    pub status: SkillUpdateBatchProgressStatus,
    pub error: Option<String>,
    pub last_checked_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CheckSkillUpdatesBatchResult {
    pub batch_id: String,
    pub stopped: bool,
    pub skipped: usize,
    pub items: Vec<CheckSkillUpdateItemResult>,
}

#[derive(Debug, Serialize)]
pub struct BatchUpdateSkillItemResult {
    pub skill_id: String,
    pub name: String,
    pub source_type: String,
    pub status: SkillUpdateBatchProgressStatus,
    pub error: Option<String>,
    pub pending_removals: Vec<PendingRemoval>,
    pub removal_approval: Option<String>,
}

pub(crate) enum BatchUpdateExecution {
    Updated,
    Unchanged,
    NeedsConfirmation {
        pending_removals: Vec<PendingRemoval>,
        removal_approval: Option<String>,
    },
}

/// 一次检查批次的完整输入。并发数在构造时已经形成快照。
pub(crate) struct CheckSkillUpdatesBatch<'a> {
    pub batch_id: &'a str,
    pub force_check: bool,
    pub concurrency: usize,
    pub requested_skill_ids: Option<&'a [String]>,
    pub stop: &'a AtomicBool,
}

pub(crate) struct ForegroundCheckBatch<'a> {
    pub batch_id: &'a str,
    pub force_check: bool,
    pub requested_skill_ids: Option<&'a [String]>,
    pub stop: &'a AtomicBool,
}

pub(crate) struct CheckedSkillState {
    pub update_status: String,
    pub last_check_error: Option<String>,
    pub last_checked_at: Option<i64>,
}

/// 批次协调器唯一需要了解的 Skill 检查适配器。
pub(crate) trait SkillUpdateCheckAdapter {
    fn remote_key(&self, skill: &SkillRecord, force_check: bool) -> Option<RemoteKey>;

    fn apply_check(
        &self,
        skill: &SkillRecord,
        force_check: bool,
        prefetched: Option<PrefetchedRemote>,
    ) -> Result<CheckedSkillState, String>;
}

/// 一个批次内只解析一次的远端身份；Skill 子目录不参与身份。
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct RemoteKey {
    pub clone_url: String,
    pub branch: Option<String>,
}

impl RemoteKey {
    pub(crate) fn new(clone_url: String, branch: Option<String>) -> Self {
        Self {
            clone_url: crate::core::git_fetcher::canonicalize_clone_url(&clone_url),
            branch,
        }
    }

    pub(crate) fn matches(&self, clone_url: &str, branch: Option<&str>) -> bool {
        self.clone_url == crate::core::git_fetcher::canonicalize_clone_url(clone_url)
            && self.branch.as_deref() == branch
    }
}

/// 一个 Skill 在共享远端快照中的内容身份。
#[derive(Clone)]
pub(crate) struct RemoteSkillContent {
    pub(crate) source_subpath: Option<String>,
    pub(crate) locator_skill_id: Option<String>,
    pub(crate) content_hash: Result<String, String>,
}

/// 一个仓库与分支只准备一次的远端内容快照结果。
#[derive(Clone)]
pub(crate) struct ResolvedRemote {
    pub(crate) revision: String,
    pub(crate) skills: Arc<HashMap<String, RemoteSkillContent>>,
}

/// 在仓库锁外解析并绑定到远端身份的结果。
#[derive(Clone)]
pub struct PrefetchedRemote {
    pub(crate) key: RemoteKey,
    pub(crate) result: Result<ResolvedRemote, String>,
}

pub(crate) fn prefetched_remote(
    key: RemoteKey,
    result: Result<ResolvedRemote, String>,
) -> PrefetchedRemote {
    PrefetchedRemote { key, result }
}

pub(crate) fn skill_update_batch_cancel_key(batch_id: &str) -> String {
    format!("skill-update-batch:{batch_id}")
}

fn foreground_batch_concurrency(store: &SkillStore, key: &str, fallback: usize) -> usize {
    match store.get_setting(key) {
        Ok(Some(value)) => match value.trim() {
            "1" => 1,
            "4" => 4,
            "8" => 8,
            _ => fallback,
        },
        Ok(None) => fallback,
        Err(err) => {
            log::warn!("读取前台批处理并发设置失败，使用默认值 {fallback}：{err}");
            fallback
        }
    }
}

pub(crate) fn is_checkable_update_skill(skill: &SkillRecord) -> bool {
    match skill.source_type.as_str() {
        "git" | "skillssh" => true,
        "local" | "import" => skill
            .source_ref
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .is_some_and(|path| Path::new(path).exists()),
        _ => false,
    }
}

fn collect_remote_skill_ids<A: SkillUpdateCheckAdapter>(
    skills: &[SkillRecord],
    force_check: bool,
    adapter: &A,
) -> HashMap<RemoteKey, Vec<String>> {
    let mut remote_skill_ids = HashMap::new();
    for skill in skills {
        if !matches!(skill.source_type.as_str(), "git" | "skillssh") {
            continue;
        }
        if let Some(key) = adapter.remote_key(skill, force_check) {
            remote_skill_ids
                .entry(key)
                .or_insert_with(Vec::new)
                .push(skill.id.clone());
        }
    }
    remote_skill_ids
}

fn prefetched_remote_for_skill<A: SkillUpdateCheckAdapter>(
    adapter: &A,
    skill: &SkillRecord,
    force_check: bool,
    remote_results: &HashMap<RemoteKey, Result<ResolvedRemote, String>>,
) -> Option<PrefetchedRemote> {
    if !matches!(skill.source_type.as_str(), "git" | "skillssh") {
        return None;
    }
    adapter.remote_key(skill, force_check).and_then(|key| {
        remote_results
            .get(&key)
            .cloned()
            .map(|result| PrefetchedRemote { key, result })
    })
}

fn apply_prefetched_skill_check<A: SkillUpdateCheckAdapter>(
    adapter: &A,
    skill: &SkillRecord,
    force_check: bool,
    remote_results: &HashMap<RemoteKey, Result<ResolvedRemote, String>>,
) -> Result<CheckedSkillState, String> {
    let prefetched = prefetched_remote_for_skill(adapter, skill, force_check, remote_results);
    adapter.apply_check(skill, force_check, prefetched)
}

fn check_progress_status(
    status: &str,
    error: Option<String>,
) -> (SkillUpdateBatchProgressStatus, Option<String>) {
    match status {
        "up_to_date" => (SkillUpdateBatchProgressStatus::UpToDate, None),
        "update_available" => (SkillUpdateBatchProgressStatus::UpdateAvailable, None),
        "unknown" => (SkillUpdateBatchProgressStatus::Unknown, None),
        "local_only" => (SkillUpdateBatchProgressStatus::LocalOnly, None),
        "source_missing" => (SkillUpdateBatchProgressStatus::SourceMissing, error),
        "error" => (SkillUpdateBatchProgressStatus::Error, error),
        other => (
            SkillUpdateBatchProgressStatus::Error,
            error.or_else(|| Some(format!("Unexpected update status: {other}"))),
        ),
    }
}

fn emit_progress<E>(
    emit: &E,
    batch_id: &str,
    skill_id: &str,
    phase: SkillUpdateBatchPhase,
    status: SkillUpdateBatchProgressStatus,
    error: Option<String>,
) where
    E: Fn(SkillUpdateBatchProgress) + Sync,
{
    emit(SkillUpdateBatchProgress {
        batch_id: batch_id.to_string(),
        skill_id: skill_id.to_string(),
        phase,
        status,
        error,
    });
}

/// 保留无前台窗口调用的既有全库检查语义。
pub(crate) fn check_background<R, A>(
    store: &SkillStore,
    adapter: &A,
    force_check: bool,
    resolve: R,
) -> Result<(), AppError>
where
    R: Fn(&RemoteKey, &[String]) -> Result<ResolvedRemote, String> + Sync,
    A: SkillUpdateCheckAdapter,
{
    let skills = store.get_all_skills().map_err(AppError::db)?;
    let remote_skill_ids = collect_remote_skill_ids(&skills, force_check, adapter);
    let remote_results = resolve_concurrent_with_progress(
        remote_skill_ids.keys().cloned().collect(),
        DEFAULT_CHECK_CONCURRENCY,
        None,
        |key| {
            resolve(
                key,
                remote_skill_ids.get(key).map(Vec::as_slice).unwrap_or(&[]),
            )
        },
        |_| {},
    );

    let mut failed = Vec::new();
    for skill in &skills {
        if let Err(message) =
            apply_prefetched_skill_check(adapter, skill, force_check, &remote_results)
        {
            log::warn!("check all: {} failed: {}", skill.id, message);
            failed.push(format!("{}: {}", skill.id, message));
        }
    }

    if failed.is_empty() {
        Ok(())
    } else {
        Err(AppError::internal(format!(
            "Failed to check {} skill(s): {}",
            failed.len(),
            failed.join("; ")
        )))
    }
}

/// 检查批次的公开协调 seam：去重远端、受限并发、逐项写回、停止与失败隔离。
fn check<R, E, A>(
    store: &SkillStore,
    adapter: &A,
    batch: CheckSkillUpdatesBatch<'_>,
    resolve: R,
    emit: E,
) -> Result<CheckSkillUpdatesBatchResult, AppError>
where
    R: Fn(&RemoteKey, &[String]) -> Result<ResolvedRemote, String> + Sync,
    E: Fn(SkillUpdateBatchProgress) + Sync,
    A: SkillUpdateCheckAdapter,
{
    let CheckSkillUpdatesBatch {
        batch_id,
        force_check,
        concurrency,
        requested_skill_ids,
        stop,
    } = batch;
    let all_skills = store.get_all_skills().map_err(AppError::db)?;
    let requested: Option<HashSet<&str>> =
        requested_skill_ids.map(|ids| ids.iter().map(String::as_str).collect());
    let mut skills: Vec<SkillRecord> = all_skills
        .iter()
        .filter(|skill| {
            is_checkable_update_skill(skill)
                && match requested.as_ref() {
                    Some(ids) => ids.contains(skill.id.as_str()),
                    None => true,
                }
        })
        .cloned()
        .collect();
    skills.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });
    let skipped = if requested.is_some() {
        requested_skill_ids
            .map_or(0, |ids| ids.len())
            .saturating_sub(skills.len())
    } else {
        all_skills.len().saturating_sub(skills.len())
    };

    for skill in &skills {
        emit_progress(
            &emit,
            batch_id,
            &skill.id,
            SkillUpdateBatchPhase::Check,
            SkillUpdateBatchProgressStatus::Waiting,
            None,
        );
    }

    let remote_skill_ids = collect_remote_skill_ids(&skills, force_check, adapter);
    let remote_scheduled: HashSet<String> = remote_skill_ids
        .values()
        .flat_map(|ids| ids.iter().cloned())
        .collect();
    let remote_results = resolve_concurrent_with_progress(
        remote_skill_ids.keys().cloned().collect(),
        concurrency,
        Some(stop),
        |key| {
            resolve(
                key,
                remote_skill_ids.get(key).map(Vec::as_slice).unwrap_or(&[]),
            )
        },
        |key| {
            if let Some(skill_ids) = remote_skill_ids.get(key) {
                for skill_id in skill_ids {
                    emit_progress(
                        &emit,
                        batch_id,
                        skill_id,
                        SkillUpdateBatchPhase::Check,
                        SkillUpdateBatchProgressStatus::Checking,
                        None,
                    );
                }
            }
        },
    );

    let mut items = Vec::with_capacity(skills.len());
    for skill in &skills {
        let remote_was_started =
            prefetched_remote_for_skill(adapter, skill, force_check, &remote_results).is_some();
        if (remote_scheduled.contains(&skill.id) && !remote_was_started)
            || (!remote_scheduled.contains(&skill.id)
                && stop.load(std::sync::atomic::Ordering::SeqCst))
        {
            emit_progress(
                &emit,
                batch_id,
                &skill.id,
                SkillUpdateBatchPhase::Check,
                SkillUpdateBatchProgressStatus::NotStarted,
                None,
            );
            items.push(CheckSkillUpdateItemResult {
                skill_id: skill.id.clone(),
                name: skill.name.clone(),
                source_type: skill.source_type.clone(),
                status: SkillUpdateBatchProgressStatus::NotStarted,
                error: None,
                last_checked_at: skill.last_checked_at,
            });
            continue;
        }
        if !remote_scheduled.contains(&skill.id) {
            emit_progress(
                &emit,
                batch_id,
                &skill.id,
                SkillUpdateBatchPhase::Check,
                SkillUpdateBatchProgressStatus::Checking,
                None,
            );
        }
        let checked = apply_prefetched_skill_check(adapter, skill, force_check, &remote_results);
        let (status, error, last_checked_at) = match checked {
            Ok(dto) => {
                let last_checked_at = dto.last_checked_at;
                let (status, error) =
                    check_progress_status(&dto.update_status, dto.last_check_error);
                (status, error, last_checked_at)
            }
            Err(message) => {
                log::warn!("前台 Skill 检查批次：{} 失败：{}", skill.id, message);
                (
                    SkillUpdateBatchProgressStatus::Error,
                    Some(message),
                    skill.last_checked_at,
                )
            }
        };
        emit_progress(
            &emit,
            batch_id,
            &skill.id,
            SkillUpdateBatchPhase::Check,
            status,
            error.clone(),
        );
        items.push(CheckSkillUpdateItemResult {
            skill_id: skill.id.clone(),
            name: skill.name.clone(),
            source_type: skill.source_type.clone(),
            status,
            error,
            last_checked_at,
        });
    }

    Ok(CheckSkillUpdatesBatchResult {
        batch_id: batch_id.to_string(),
        stopped: stop.load(std::sync::atomic::Ordering::SeqCst),
        skipped,
        items,
    })
}

/// 协调器 seam：显式固定一次批次的并发快照。
pub(crate) fn check_with_concurrency<R, E, A>(
    store: &SkillStore,
    adapter: &A,
    batch: CheckSkillUpdatesBatch<'_>,
    resolve: R,
    emit: E,
) -> Result<CheckSkillUpdatesBatchResult, AppError>
where
    R: Fn(&RemoteKey, &[String]) -> Result<ResolvedRemote, String> + Sync,
    E: Fn(SkillUpdateBatchProgress) + Sync,
    A: SkillUpdateCheckAdapter,
{
    check(store, adapter, batch, resolve, emit)
}

/// 从持久化设置读取一次并发数，然后进入同一个检查协调 seam。
pub(crate) fn check_with_preferences<R, E, A>(
    store: &SkillStore,
    adapter: &A,
    batch: ForegroundCheckBatch<'_>,
    resolve: R,
    emit: E,
) -> Result<CheckSkillUpdatesBatchResult, AppError>
where
    R: Fn(&RemoteKey, &[String]) -> Result<ResolvedRemote, String> + Sync,
    E: Fn(SkillUpdateBatchProgress) + Sync,
    A: SkillUpdateCheckAdapter,
{
    let ForegroundCheckBatch {
        batch_id,
        force_check,
        requested_skill_ids,
        stop,
    } = batch;
    let concurrency = foreground_batch_concurrency(
        store,
        FOREGROUND_BATCH_CHECK_CONCURRENCY_KEY,
        DEFAULT_CHECK_CONCURRENCY,
    );
    check_with_concurrency(
        store,
        adapter,
        CheckSkillUpdatesBatch {
            batch_id,
            force_check,
            concurrency,
            requested_skill_ids,
            stop,
        },
        resolve,
        emit,
    )
}

fn resolve_concurrent_with_progress<T, F, P>(
    remotes: Vec<RemoteKey>,
    concurrency: usize,
    stop: Option<&AtomicBool>,
    resolve: F,
    on_start: P,
) -> HashMap<RemoteKey, Result<T, String>>
where
    T: Send,
    F: Fn(&RemoteKey) -> Result<T, String> + Sync,
    P: Fn(&RemoteKey) + Sync,
{
    use std::sync::atomic::{AtomicUsize, Ordering};

    let next = AtomicUsize::new(0);
    let results: Mutex<HashMap<RemoteKey, Result<T, String>>> =
        Mutex::new(HashMap::with_capacity(remotes.len()));
    let worker_count = concurrency.max(1).min(remotes.len().max(1));

    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| loop {
                if matches!(stop, Some(token) if token.load(Ordering::SeqCst)) {
                    break;
                }
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(key) = remotes.get(index) else {
                    break;
                };
                if matches!(stop, Some(token) if token.load(Ordering::SeqCst)) {
                    break;
                }
                on_start(key);
                let resolved = resolve(key);
                if let Ok(mut map) = results.lock() {
                    map.insert(key.clone(), resolved);
                }
            });
        }
    });

    results.into_inner().unwrap_or_default()
}

/// 更新批次的公开协调 seam：受限并发、停止调度、失败隔离与结构化汇总。
fn update<U, E>(
    store: &SkillStore,
    batch_id: &str,
    skill_ids: Vec<String>,
    concurrency: usize,
    stop: &AtomicBool,
    update_skill: U,
    emit: E,
) -> Result<BatchUpdateSkillsResult, AppError>
where
    U: Fn(&SkillRecord) -> Result<BatchUpdateExecution, String> + Sync,
    E: Fn(SkillUpdateBatchProgress) + Sync,
{
    use std::sync::atomic::{AtomicUsize, Ordering};

    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    let mut items = Vec::new();
    for skill_id in skill_ids {
        if !seen.insert(skill_id.clone()) {
            continue;
        }
        match store.get_skill_by_id(&skill_id).map_err(AppError::db)? {
            Some(skill) => skills.push(skill),
            None => items.push(BatchUpdateSkillItemResult {
                skill_id: skill_id.clone(),
                name: skill_id,
                source_type: String::new(),
                status: SkillUpdateBatchProgressStatus::Error,
                error: Some("未找到 Skill".to_string()),
                pending_removals: Vec::new(),
                removal_approval: None,
            }),
        }
    }
    skills.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });

    for skill in &skills {
        emit_progress(
            &emit,
            batch_id,
            &skill.id,
            SkillUpdateBatchPhase::Update,
            SkillUpdateBatchProgressStatus::Waiting,
            None,
        );
    }

    let next = AtomicUsize::new(0);
    let completed = Mutex::new(Vec::<BatchUpdateSkillItemResult>::with_capacity(
        skills.len(),
    ));
    let worker_count = concurrency.max(1).min(skills.len().max(1));
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(skill) = skills.get(index) else {
                    break;
                };
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                emit_progress(
                    &emit,
                    batch_id,
                    &skill.id,
                    SkillUpdateBatchPhase::Update,
                    SkillUpdateBatchProgressStatus::Updating,
                    None,
                );
                let (status, error, pending_removals, removal_approval) = match update_skill(skill)
                {
                    Ok(BatchUpdateExecution::Updated) => (
                        SkillUpdateBatchProgressStatus::Updated,
                        None,
                        Vec::new(),
                        None,
                    ),
                    Ok(BatchUpdateExecution::Unchanged) => (
                        SkillUpdateBatchProgressStatus::Unchanged,
                        None,
                        Vec::new(),
                        None,
                    ),
                    Ok(BatchUpdateExecution::NeedsConfirmation {
                        pending_removals,
                        removal_approval,
                    }) => (
                        SkillUpdateBatchProgressStatus::NeedsConfirmation,
                        None,
                        pending_removals,
                        removal_approval,
                    ),
                    Err(message) => (
                        SkillUpdateBatchProgressStatus::Error,
                        Some(message),
                        Vec::new(),
                        None,
                    ),
                };
                emit_progress(
                    &emit,
                    batch_id,
                    &skill.id,
                    SkillUpdateBatchPhase::Update,
                    status,
                    error.clone(),
                );
                completed.lock().unwrap().push(BatchUpdateSkillItemResult {
                    skill_id: skill.id.clone(),
                    name: skill.name.clone(),
                    source_type: skill.source_type.clone(),
                    status,
                    error,
                    pending_removals,
                    removal_approval,
                });
            });
        }
    });
    items.extend(completed.into_inner().unwrap_or_default());
    let completed_ids: HashSet<String> = items.iter().map(|item| item.skill_id.clone()).collect();
    for skill in &skills {
        if completed_ids.contains(&skill.id) {
            continue;
        }
        emit_progress(
            &emit,
            batch_id,
            &skill.id,
            SkillUpdateBatchPhase::Update,
            SkillUpdateBatchProgressStatus::NotStarted,
            None,
        );
        items.push(BatchUpdateSkillItemResult {
            skill_id: skill.id.clone(),
            name: skill.name.clone(),
            source_type: skill.source_type.clone(),
            status: SkillUpdateBatchProgressStatus::NotStarted,
            error: None,
            pending_removals: Vec::new(),
            removal_approval: None,
        });
    }
    items.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.skill_id.cmp(&right.skill_id))
    });

    let refreshed = items
        .iter()
        .filter(|item| item.status == SkillUpdateBatchProgressStatus::Updated)
        .count();
    let unchanged = items
        .iter()
        .filter(|item| item.status == SkillUpdateBatchProgressStatus::Unchanged)
        .count();
    let failed = items
        .iter()
        .filter(|item| item.status == SkillUpdateBatchProgressStatus::Error)
        .map(|item| {
            format!(
                "{}: {}",
                item.name,
                item.error.as_deref().unwrap_or("未知错误")
            )
        })
        .collect();
    let held_back = items
        .iter()
        .filter(|item| item.status == SkillUpdateBatchProgressStatus::NeedsConfirmation)
        .map(|item| item.name.clone())
        .collect();

    Ok(BatchUpdateSkillsResult {
        batch_id: Some(batch_id.to_string()),
        stopped: stop.load(Ordering::SeqCst),
        refreshed,
        unchanged,
        failed,
        held_back,
        items,
    })
}

/// 协调器 seam：显式固定一次批次的并发快照。
pub(crate) fn update_with_concurrency<U, E>(
    store: &SkillStore,
    batch_id: &str,
    skill_ids: Vec<String>,
    concurrency: usize,
    stop: &AtomicBool,
    update_skill: U,
    emit: E,
) -> Result<BatchUpdateSkillsResult, AppError>
where
    U: Fn(&SkillRecord) -> Result<BatchUpdateExecution, String> + Sync,
    E: Fn(SkillUpdateBatchProgress) + Sync,
{
    update(
        store,
        batch_id,
        skill_ids,
        concurrency,
        stop,
        update_skill,
        emit,
    )
}

/// 从持久化设置读取一次并发数，然后进入同一个更新协调 seam。
pub(crate) fn update_with_preferences<U, E>(
    store: &SkillStore,
    batch_id: &str,
    skill_ids: Vec<String>,
    stop: &AtomicBool,
    update_skill: U,
    emit: E,
) -> Result<BatchUpdateSkillsResult, AppError>
where
    U: Fn(&SkillRecord) -> Result<BatchUpdateExecution, String> + Sync,
    E: Fn(SkillUpdateBatchProgress) + Sync,
{
    let concurrency = foreground_batch_concurrency(
        store,
        FOREGROUND_BATCH_UPDATE_CONCURRENCY_KEY,
        DEFAULT_UPDATE_CONCURRENCY,
    );
    update_with_concurrency(
        store,
        batch_id,
        skill_ids,
        concurrency,
        stop,
        update_skill,
        emit,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrency_preferences_use_safe_defaults_for_missing_or_invalid_values() {
        let temp = tempfile::tempdir().unwrap();
        let store = SkillStore::new(&temp.path().join("test.db")).unwrap();

        assert_eq!(
            foreground_batch_concurrency(
                &store,
                FOREGROUND_BATCH_CHECK_CONCURRENCY_KEY,
                DEFAULT_CHECK_CONCURRENCY,
            ),
            8
        );
        assert_eq!(
            foreground_batch_concurrency(
                &store,
                FOREGROUND_BATCH_UPDATE_CONCURRENCY_KEY,
                DEFAULT_UPDATE_CONCURRENCY,
            ),
            4
        );

        store
            .set_setting(FOREGROUND_BATCH_CHECK_CONCURRENCY_KEY, "32")
            .unwrap();
        store
            .set_setting(FOREGROUND_BATCH_UPDATE_CONCURRENCY_KEY, "invalid")
            .unwrap();
        assert_eq!(
            foreground_batch_concurrency(
                &store,
                FOREGROUND_BATCH_CHECK_CONCURRENCY_KEY,
                DEFAULT_CHECK_CONCURRENCY,
            ),
            8
        );
        assert_eq!(
            foreground_batch_concurrency(
                &store,
                FOREGROUND_BATCH_UPDATE_CONCURRENCY_KEY,
                DEFAULT_UPDATE_CONCURRENCY,
            ),
            4
        );
    }
}
