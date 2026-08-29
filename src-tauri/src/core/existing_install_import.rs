use anyhow::{Context, Result};
use fs2::FileExt;
use rusqlite::{backup::Backup, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const UPSTREAM_DATABASE_FILE: &str = "skills-manager.db";
const TARGET_DATABASE_FILE: &str = "skill-expert.db";
const IMPORT_RECEIPT_FILE: &str = ".skill-expert-existing-install-import.json";

const PROCESS_LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const PROCESS_LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessLockMode {
    Shared,
    Exclusive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessCallerRole {
    Gui,
    Cli,
}

impl ProcessLockMode {
    fn name(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Exclusive => "exclusive",
        }
    }
}

#[derive(Debug)]
struct ProcessLifetimeLock {
    file: File,
    mode: Mutex<ProcessLockMode>,
}

// The file lives in config rather than the movable library. Normal GUI/CLI
// processes retain a shared guard so Tauri's secondary-instance path and safe
// SQLite readers can coexist. A restart with a fixed Pending import waits for
// an exclusive guard, then downgrades before the database opens.
static PROCESS_LIFETIME_LOCK: OnceLock<std::result::Result<ProcessLifetimeLock, String>> =
    OnceLock::new();

fn process_lock_path() -> Result<PathBuf> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let config_dir = dirs::config_dir().unwrap_or_else(|| home_dir.join(".config"));
    Ok(config_dir.join("skill-expert").join("process.lock"))
}

fn open_process_lock_file(path: &Path) -> Result<File> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("process lock path has no parent directory"))?;
    fs::create_dir_all(parent)?;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("failed to open process lock at {}", path.display()))
}

fn try_lock_file(file: &File, mode: ProcessLockMode) -> std::io::Result<()> {
    match mode {
        ProcessLockMode::Shared => FileExt::try_lock_shared(file),
        ProcessLockMode::Exclusive => FileExt::try_lock_exclusive(file),
    }
}

#[cfg(test)]
fn try_acquire_process_lock_at(path: &Path, mode: ProcessLockMode) -> Result<File> {
    let file = open_process_lock_file(path)?;
    try_lock_file(&file, mode).with_context(|| {
        format!(
            "failed to acquire {} Agent 技能管家 process lock at {}",
            mode.name(),
            path.display()
        )
    })?;
    Ok(file)
}

#[cfg(test)]
fn acquire_process_lock_at(path: &Path, mode: ProcessLockMode, timeout: Duration) -> Result<File> {
    let file = open_process_lock_file(path)?;
    let started = Instant::now();
    loop {
        match try_lock_file(&file, mode) {
            Ok(()) => return Ok(file),
            Err(err) if started.elapsed() >= timeout => {
                return Err(err).with_context(|| {
                    format!(
                        "timed out after {} ms waiting for {} Agent 技能管家 process lock at {}",
                        timeout.as_millis(),
                        mode.name(),
                        path.display()
                    )
                });
            }
            Err(_) => std::thread::sleep(PROCESS_LOCK_RETRY_INTERVAL),
        }
    }
}

fn import_state_file_path() -> Result<PathBuf> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let config_dir = dirs::config_dir().unwrap_or_else(|| home_dir.join(".config"));
    Ok(config_dir
        .join("skill-expert")
        .join("existing-installation-import.json"))
}

fn read_regular_control_file(path: &Path, label: &str) -> Result<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(err)
                .with_context(|| format!("failed to inspect {label} {}", path.display()))
        }
    };
    anyhow::ensure!(
        !metadata_is_symlink_or_reparse(&metadata) && metadata.file_type().is_file(),
        "{label} {} must be a regular file without symlink or reparse indirection",
        path.display()
    );
    fs::read(path)
        .map(Some)
        .with_context(|| format!("failed to read {label} {}", path.display()))
}

fn fixed_import_state_is_pending_at(path: &Path) -> bool {
    read_regular_control_file(path, "existing-installation import state")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_slice::<ImportStateFile>(&raw).ok())
        .is_some_and(|state| matches!(state, ImportStateFile::Pending { .. }))
}

fn acquire_startup_process_lock_at(
    lock_path: &Path,
    state_path: &Path,
    caller: ProcessCallerRole,
    timeout: Duration,
) -> Result<ProcessLifetimeLock> {
    let file = open_process_lock_file(lock_path)?;
    let started = Instant::now();
    loop {
        // Re-read on every retry. If another restart completes the Pending
        // import while we wait, this process can switch to shared mode and
        // continue instead of timing out behind the first process's downgrade.
        let mode =
            if caller == ProcessCallerRole::Gui && fixed_import_state_is_pending_at(state_path) {
                ProcessLockMode::Exclusive
            } else {
                ProcessLockMode::Shared
            };
        match try_lock_file(&file, mode) {
            Ok(()) => {
                // The CLI never owns import recovery. Re-read after acquiring
                // shared to close the check/lock race: an already-fixed
                // Pending marker must be left byte-for-byte for a GUI restart.
                // If Pending is created just after this check, our process-
                // lifetime shared guard still prevents GUI activation until
                // this short-lived CLI process exits.
                if caller == ProcessCallerRole::Cli && fixed_import_state_is_pending_at(state_path)
                {
                    FileExt::unlock(&file).context("无法释放 CLI 启动阶段的临时进程锁")?;
                    anyhow::bail!(
                        "a pending import must be completed by restarting Agent 技能管家 via the GUI before using the CLI"
                    );
                }
                return Ok(ProcessLifetimeLock {
                    file,
                    mode: Mutex::new(mode),
                });
            }
            Err(err) if started.elapsed() >= timeout => {
                return Err(err).with_context(|| {
                    format!(
                        "timed out after {} ms waiting for {} Agent 技能管家 process lock at {}",
                        timeout.as_millis(),
                        mode.name(),
                        lock_path.display()
                    )
                });
            }
            Err(_) => std::thread::sleep(PROCESS_LOCK_RETRY_INTERVAL),
        }
    }
}

pub(crate) fn acquire_process_lifetime_lock(caller: ProcessCallerRole) -> Result<bool> {
    let lock_path = process_lock_path()?;
    let state_path = import_state_file_path()?;
    let guard = match PROCESS_LIFETIME_LOCK.get_or_init(|| {
        acquire_startup_process_lock_at(&lock_path, &state_path, caller, PROCESS_LOCK_WAIT_TIMEOUT)
            .map_err(|err| format!("{err:#}"))
    }) {
        Ok(guard) => guard,
        Err(message) => anyhow::bail!(message.clone()),
    };
    if caller == ProcessCallerRole::Cli && fixed_import_state_is_pending_at(&state_path) {
        anyhow::bail!(
            "a pending import must be completed by restarting Agent 技能管家 via the GUI before using the CLI"
        );
    }
    Ok(*guard.mode.lock().unwrap_or_else(|err| err.into_inner()) == ProcessLockMode::Exclusive)
}

#[cfg(test)]
fn acquire_process_lock_once(
    cell: &OnceLock<std::result::Result<ProcessLifetimeLock, String>>,
    path: &Path,
    mode: ProcessLockMode,
    timeout: Duration,
) -> Result<()> {
    match cell.get_or_init(|| {
        acquire_process_lock_at(path, mode, timeout)
            .map(|file| ProcessLifetimeLock {
                file,
                mode: Mutex::new(mode),
            })
            .map_err(|err| format!("{err:#}"))
    }) {
        Ok(_guard) => Ok(()),
        Err(message) => anyhow::bail!(message.clone()),
    }
}

fn downgrade_process_lock_once_to_shared(
    cell: &OnceLock<std::result::Result<ProcessLifetimeLock, String>>,
    timeout: Duration,
) -> Result<()> {
    let guard = match cell.get() {
        Some(Ok(guard)) => guard,
        Some(Err(message)) => anyhow::bail!(message.clone()),
        None => anyhow::bail!("Agent 技能管家 process lock has not been acquired"),
    };
    let mut mode = guard.mode.lock().unwrap_or_else(|err| err.into_inner());
    if *mode == ProcessLockMode::Shared {
        return Ok(());
    }

    FileExt::unlock(&guard.file)?;
    let started = Instant::now();
    loop {
        match FileExt::try_lock_shared(&guard.file) {
            Ok(()) => {
                *mode = ProcessLockMode::Shared;
                return Ok(());
            }
            Err(err) if started.elapsed() >= timeout => {
                return Err(err)
                    .context("timed out downgrading Agent 技能管家 process lock to shared");
            }
            Err(_) => std::thread::sleep(PROCESS_LOCK_RETRY_INTERVAL),
        }
    }
}

pub(crate) fn downgrade_process_lifetime_lock_to_shared(caller: ProcessCallerRole) -> Result<()> {
    anyhow::ensure!(
        caller == ProcessCallerRole::Gui,
        "only the Agent 技能管家 GUI may downgrade an exclusive import lock"
    );
    downgrade_process_lock_once_to_shared(&PROCESS_LIFETIME_LOCK, PROCESS_LOCK_WAIT_TIMEOUT)
}

#[derive(Debug, Clone)]
struct ImportEnvironment {
    home_dir: PathBuf,
    upstream_config_file: PathBuf,
    target_base: PathBuf,
    state_file: PathBuf,
}

fn production_environment() -> Result<ImportEnvironment> {
    let home_dir =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let config_dir = dirs::config_dir().unwrap_or_else(|| home_dir.join(".config"));
    Ok(ImportEnvironment {
        home_dir,
        upstream_config_file: config_dir.join("skills-manager").join("repo-config.json"),
        target_base: super::central_repo::base_dir(),
        state_file: config_dir
            .join("skill-expert")
            .join("existing-installation-import.json"),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExistingInstallationImportStatus {
    pub state: String,
    pub should_prompt: bool,
    pub source_path: Option<String>,
    pub backup_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct UpstreamRepoConfig {
    repo_path: Option<String>,
    pending_migration_from: Option<String>,
}

#[derive(Debug)]
enum UpstreamConfigState {
    Missing,
    Valid(UpstreamRepoConfig),
    Invalid(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportChoice {
    Fresh,
    Import,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum ImportStateFile {
    Fresh,
    Pending {
        import_id: String,
        source_path: String,
        target_path: String,
        staging_path: String,
        backup_path: String,
    },
    Imported {
        import_id: String,
        source_path: String,
        target_path: String,
        backup_path: Option<String>,
    },
    Failed {
        import_id: String,
        source_path: String,
        target_path: String,
        backup_path: Option<String>,
        error: String,
    },
}

fn inspect_status(environment: &ImportEnvironment) -> Result<ExistingInstallationImportStatus> {
    if let Some(receipt) = read_import_receipt(&environment.target_base)? {
        let backup = sibling_artifact(
            &environment.target_base,
            "pre-import-backup",
            &receipt.import_id,
        )?;
        return Ok(ExistingInstallationImportStatus {
            state: "imported".to_string(),
            should_prompt: false,
            source_path: Some(receipt.source_path),
            backup_path: backup
                .exists()
                .then(|| backup.to_string_lossy().to_string()),
            error: None,
        });
    }
    if let Some(raw) = read_regular_control_file(
        &environment.state_file,
        "existing-installation import state",
    )? {
        let state: ImportStateFile = serde_json::from_slice(&raw)?;
        return Ok(match state {
            ImportStateFile::Fresh => ExistingInstallationImportStatus {
                state: "fresh".to_string(),
                should_prompt: false,
                source_path: None,
                backup_path: None,
                error: None,
            },
            ImportStateFile::Pending {
                source_path,
                backup_path,
                ..
            } => ExistingInstallationImportStatus {
                state: "pending".to_string(),
                should_prompt: false,
                source_path: Some(source_path),
                backup_path: Some(backup_path),
                error: None,
            },
            ImportStateFile::Imported {
                source_path,
                backup_path,
                ..
            } => ExistingInstallationImportStatus {
                state: "imported".to_string(),
                should_prompt: false,
                source_path: Some(source_path),
                backup_path,
                error: None,
            },
            ImportStateFile::Failed {
                source_path,
                backup_path,
                error,
                ..
            } => ExistingInstallationImportStatus {
                state: "failed".to_string(),
                should_prompt: true,
                source_path: Some(source_path),
                backup_path,
                error: Some(error),
            },
        });
    }
    let source = detect_upstream_base(environment)?;
    Ok(match source {
        Some(source) => ExistingInstallationImportStatus {
            state: "prompt".to_string(),
            should_prompt: true,
            source_path: Some(source.to_string_lossy().to_string()),
            backup_path: None,
            error: None,
        },
        None => ExistingInstallationImportStatus {
            state: "not_available".to_string(),
            should_prompt: false,
            source_path: None,
            backup_path: None,
            error: None,
        },
    })
}

pub fn status() -> Result<ExistingInstallationImportStatus> {
    inspect_status(&production_environment()?)
}

pub fn choose(choice: &str, confirmed_source: Option<&str>) -> Result<()> {
    let choice = match choice {
        "fresh" => ImportChoice::Fresh,
        "import" => ImportChoice::Import,
        other => anyhow::bail!("unknown existing-installation import choice: {other}"),
    };
    record_choice(&production_environment()?, choice, confirmed_source)
}

pub(crate) fn process_pending_before_store_open(caller: ProcessCallerRole) -> Result<()> {
    anyhow::ensure!(
        caller == ProcessCallerRole::Gui,
        "only the Agent 技能管家 GUI may process a pending existing-installation import"
    );
    process_pending_import(&production_environment()?)
}

fn process_pending_import(environment: &ImportEnvironment) -> Result<()> {
    let state: ImportStateFile = match read_regular_control_file(
        &environment.state_file,
        "existing-installation import state",
    )? {
        Some(raw) => serde_json::from_slice(&raw)?,
        None => return Ok(()),
    };
    let ImportStateFile::Pending {
        import_id,
        source_path,
        target_path,
        staging_path,
        backup_path,
    } = state
    else {
        return Ok(());
    };

    let pending = match validate_pending_import(
        environment,
        &import_id,
        &source_path,
        &target_path,
        &staging_path,
        &backup_path,
    ) {
        Ok(pending) => pending,
        Err(err) => {
            // None of the untrusted artifact paths has been touched. When the
            // target is absent, retain Pending so every subsequent startup
            // keeps the exclusive recovery gate and refuses an empty database.
            // Otherwise persist a sanitized failure without exposing
            // attacker-controlled backup paths to the UI.
            let error = format!("{err:#}");
            if !environment.target_base.exists() {
                anyhow::bail!(
                    "pending import validation failed; refusing to open an empty target and retaining Pending for the next exclusive attempt: {error}"
                );
            }
            save_state(
                &environment.state_file,
                &ImportStateFile::Failed {
                    import_id: uuid::Uuid::new_v4().to_string(),
                    source_path,
                    target_path: environment.target_base.to_string_lossy().to_string(),
                    backup_path: None,
                    error: error.clone(),
                },
            )?;
            return Ok(());
        }
    };

    if let Err(err) = attempt_pending_import(environment, &pending) {
        let error = format!("{err:#}");
        if !pending.target.exists() && pending.backup.exists() {
            anyhow::bail!(
                "import recovery failed with a recoverable backup still present at {}; refusing to open an empty target and retaining Pending for the next exclusive recovery: {error}",
                pending.backup.display()
            );
        }
        save_state(
            &environment.state_file,
            &ImportStateFile::Failed {
                import_id: pending.import_id.clone(),
                source_path: pending.source.to_string_lossy().to_string(),
                target_path: pending.target.to_string_lossy().to_string(),
                backup_path: pending
                    .backup
                    .exists()
                    .then(|| pending.backup.to_string_lossy().to_string()),
                error: error.clone(),
            },
        )?;
    }
    Ok(())
}

#[derive(Debug)]
struct ValidatedPendingImport {
    import_id: String,
    source: PathBuf,
    target: PathBuf,
    staging: PathBuf,
    backup: PathBuf,
}

fn validate_pending_import(
    environment: &ImportEnvironment,
    import_id: &str,
    source_path: &str,
    target_path: &str,
    staging_path: &str,
    backup_path: &str,
) -> Result<ValidatedPendingImport> {
    // UUID and artifact strings are validated before any mutation. In
    // particular, an invalid ID must never be interpolated into a path that is
    // subsequently removed or renamed.
    validate_import_id(import_id)?;
    let source = PathBuf::from(source_path);
    let target = PathBuf::from(target_path);
    let staging = PathBuf::from(staging_path);
    let backup = PathBuf::from(backup_path);
    for (path, label) in [
        (&source, "pending upstream source"),
        (&target, "pending Agent 技能管家 target"),
        (&staging, "pending import staging artifact"),
        (&backup, "pending import backup artifact"),
    ] {
        validate_absolute_normal_path(path, label)?;
    }
    anyhow::ensure!(
        target == environment.target_base,
        "pending import target no longer matches the configured Agent 技能管家 library"
    );
    anyhow::ensure!(
        staging == sibling_artifact(&target, "import-staging", import_id)?,
        "pending import staging path is not a safe Agent 技能管家 artifact"
    );
    anyhow::ensure!(
        backup == sibling_artifact(&target, "pre-import-backup", import_id)?,
        "pending import backup path is not a safe Agent 技能管家 artifact"
    );
    let resolved_parent = resolve_with_nearest_existing_ancestor(
        target
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Agent 技能管家 target has no parent directory"))?,
    )?;
    for (artifact, label) in [(&staging, "staging"), (&backup, "backup")] {
        let artifact_parent = artifact
            .parent()
            .ok_or_else(|| anyhow::anyhow!("pending {label} artifact has no parent"))?;
        anyhow::ensure!(
            resolve_with_nearest_existing_ancestor(artifact_parent)? == resolved_parent,
            "pending import {label} artifact escapes the Agent 技能管家 target parent"
        );
        if fs::symlink_metadata(artifact).is_ok() {
            reject_symlink_or_reparse_root(artifact, &format!("pending import {label} artifact"))?;
        }
    }
    if fs::symlink_metadata(&target).is_ok() {
        reject_symlink_or_reparse_root(&target, "pending Agent 技能管家 target")?;
    }
    let resolved_source = resolve_with_nearest_existing_ancestor(&source)?;
    let resolved_target = resolve_with_nearest_existing_ancestor(&target)?;
    anyhow::ensure!(
        resolved_source != resolved_target
            && !resolved_target.starts_with(&resolved_source)
            && !resolved_source.starts_with(&resolved_target),
        "upstream source and Agent 技能管家 target must be independent directories"
    );
    Ok(ValidatedPendingImport {
        import_id: import_id.to_string(),
        source,
        target,
        staging,
        backup,
    })
}

fn attempt_pending_import(
    environment: &ImportEnvironment,
    pending: &ValidatedPendingImport,
) -> Result<()> {
    let ValidatedPendingImport {
        import_id,
        source,
        target,
        staging,
        backup,
    } = pending;

    if import_receipt_matches(target, import_id, source)? {
        return save_state(
            &environment.state_file,
            &ImportStateFile::Imported {
                import_id: import_id.clone(),
                source_path: source.to_string_lossy().to_string(),
                target_path: target.to_string_lossy().to_string(),
                backup_path: backup
                    .exists()
                    .then(|| backup.to_string_lossy().to_string()),
            },
        );
    }

    let mut staging_is_ready = completed_staging_matches(staging, import_id, source);
    let source_validation_error = validate_source_and_target(source, target)
        .err()
        .map(|err| format!("{err:#}"));

    // Crash recovery must make its decision before removing staging or opening
    // a new target. A backup with no target means the previous process crossed
    // the target->backup boundary. A complete receipt lets us finish activation;
    // otherwise the only safe action is to restore the original target.
    if backup.exists() {
        if target.exists() {
            anyhow::bail!(
                "recoverable backup already exists at {} while the target is occupied; refusing to overwrite either directory",
                backup.display()
            );
        }
        if staging_is_ready && source_validation_error.is_none() {
            fs::rename(staging, target).with_context(|| {
                format!(
                    "failed to activate completed import staging {}; recoverable backup remains at {}",
                    staging.display(),
                    backup.display()
                )
            })?;
            return save_state(
                &environment.state_file,
                &ImportStateFile::Imported {
                    import_id: import_id.clone(),
                    source_path: source.to_string_lossy().to_string(),
                    target_path: target.to_string_lossy().to_string(),
                    backup_path: Some(backup.to_string_lossy().to_string()),
                },
            );
        }

        fs::rename(backup, target).with_context(|| {
            format!(
                "import staging is incomplete and the recoverable backup at {} could not be restored",
                backup.display()
            )
        })?;
        if let Some(source_error) = source_validation_error {
            anyhow::bail!(
                "restored the previous Agent 技能管家 target from backup because source validation failed: {source_error}"
            );
        }
        anyhow::bail!(
            "import staging was incomplete after a stopped activation; restored the previous Agent 技能管家 target from backup"
        );
    }

    // From this point onward we may copy from the upstream installation. The
    // validation was also required before trusting a completed staging receipt;
    // surface it now when no recovery backup branch consumed it.
    if let Some(source_error) = source_validation_error {
        anyhow::bail!(source_error);
    }

    if staging.exists() && !staging_is_ready {
        fs::remove_dir_all(staging).with_context(|| {
            format!(
                "failed to clear incomplete import staging at {}",
                staging.display()
            )
        })?;
        staging_is_ready = false;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if !staging_is_ready {
        copy_upstream_to_staging(source, staging, target, import_id)?;
    }

    let had_target = target.exists();
    if had_target {
        fs::rename(target, backup).with_context(|| {
            format!(
                "failed to preserve existing Agent 技能管家 data at {}",
                backup.display()
            )
        })?;
    }
    if let Err(err) = fs::rename(staging, target) {
        if had_target {
            let _ = fs::rename(backup, target);
        }
        return Err(err).context("failed to activate the imported Agent 技能管家 library");
    }

    save_state(
        &environment.state_file,
        &ImportStateFile::Imported {
            import_id: import_id.clone(),
            source_path: source.to_string_lossy().to_string(),
            target_path: target.to_string_lossy().to_string(),
            backup_path: had_target.then(|| backup.to_string_lossy().to_string()),
        },
    )
}

fn completed_staging_matches(staging: &Path, import_id: &str, source: &Path) -> bool {
    sqlite_database_is_usable(&staging.join(TARGET_DATABASE_FILE))
        && directory_tree_has_only_regular_files_and_directories(staging)
        && read_import_receipt(staging)
            .ok()
            .flatten()
            .is_some_and(|receipt| {
                receipt.import_id == import_id && Path::new(&receipt.source_path) == source
            })
}

fn directory_tree_has_only_regular_files_and_directories(root: &Path) -> bool {
    walkdir::WalkDir::new(root).into_iter().all(|entry| {
        entry
            .ok()
            .and_then(|entry| fs::symlink_metadata(entry.path()).ok())
            .is_some_and(|metadata| metadata_is_regular_file_or_directory(&metadata))
    })
}

fn copy_upstream_to_staging(
    source: &Path,
    staging: &Path,
    target: &Path,
    import_id: &str,
) -> Result<()> {
    fs::create_dir_all(staging)?;
    for entry in walkdir::WalkDir::new(source).min_depth(1) {
        let entry = entry?;
        let entry_metadata = fs::symlink_metadata(entry.path()).with_context(|| {
            format!(
                "failed to inspect upstream entry {}",
                entry.path().display()
            )
        })?;
        anyhow::ensure!(
            metadata_is_regular_file_or_directory(&entry_metadata),
            "refusing to import {} because every upstream entry must be a regular file or directory without symlink or reparse indirection",
            entry.path().display()
        );
        let relative = entry.path().strip_prefix(source)?;
        if relative.components().count() == 1 {
            let name = relative.to_string_lossy();
            if name == UPSTREAM_DATABASE_FILE
                || name == format!("{UPSTREAM_DATABASE_FILE}-wal")
                || name == format!("{UPSTREAM_DATABASE_FILE}-shm")
            {
                continue;
            }
        }
        let destination = staging.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(destination)?;
        } else {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &destination).with_context(|| {
                format!(
                    "failed to copy upstream file {} to {}",
                    entry.path().display(),
                    destination.display()
                )
            })?;
        }
    }

    let source_connection = Connection::open_with_flags(
        source.join(UPSTREAM_DATABASE_FILE),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let target_database = staging.join(TARGET_DATABASE_FILE);
    if target_database.exists() {
        fs::remove_file(&target_database)?;
    }
    let mut target_connection = Connection::open(&target_database)?;
    let database_backup = Backup::new(&source_connection, &mut target_connection)?;
    database_backup.run_to_completion(64, std::time::Duration::from_millis(5), None)?;
    drop(database_backup);
    rewrite_central_paths(
        &target_connection,
        &source.join("skills"),
        &target.join("skills"),
        &staging.join("skills"),
    )?;
    drop(target_connection);

    fs::write(
        staging.join(IMPORT_RECEIPT_FILE),
        serde_json::to_vec_pretty(&serde_json::json!({
            "import_id": import_id,
            "source_path": source,
        }))?,
    )?;
    Ok(())
}

fn rewrite_central_paths(
    connection: &Connection,
    source_skills: &Path,
    target_skills: &Path,
    staging_skills: &Path,
) -> Result<()> {
    let has_skills_table: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skills')",
        [],
        |row| row.get(0),
    )?;
    if !has_skills_table {
        return Ok(());
    }
    let mut statement = connection.prepare("SELECT id, central_path FROM skills")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut updates = Vec::new();
    for row in rows {
        let (id, central_path) = row?;
        let relative = Path::new(&central_path)
            .strip_prefix(source_skills)
            .with_context(|| {
                format!(
                    "upstream skill {id:?} points outside the upstream skills directory: {central_path}"
                )
            })?;
        anyhow::ensure!(
            relative
                .components()
                .all(|component| matches!(component, Component::Normal(_))),
            "upstream skill {id:?} has a central_path with a non-normal relative component: {central_path}"
        );
        let resolved_source_root = resolve_with_nearest_existing_ancestor(source_skills)?;
        let resolved_source_path =
            resolve_with_nearest_existing_ancestor(Path::new(&central_path))?;
        anyhow::ensure!(
            resolved_source_path.starts_with(&resolved_source_root),
            "upstream skill {id:?} resolves outside the upstream skills directory: {central_path}"
        );
        let staged_candidate = staging_skills.join(relative);
        let resolved_staging_root = resolve_with_nearest_existing_ancestor(staging_skills)?;
        let resolved_staged_candidate = resolve_with_nearest_existing_ancestor(&staged_candidate)?;
        anyhow::ensure!(
            resolved_staged_candidate.starts_with(&resolved_staging_root),
            "upstream skill {id:?} would escape the Agent 技能管家 target: {central_path}"
        );
        updates.push((
            id,
            target_skills.join(relative).to_string_lossy().to_string(),
        ));
    }
    drop(statement);
    for (id, central_path) in updates {
        connection.execute(
            "UPDATE skills SET central_path = ?1 WHERE id = ?2",
            rusqlite::params![central_path, id],
        )?;
    }
    Ok(())
}

fn import_receipt_matches(target: &Path, import_id: &str, source: &Path) -> Result<bool> {
    Ok(read_import_receipt(target)?.is_some_and(|receipt| {
        receipt.import_id == import_id && Path::new(&receipt.source_path) == source
    }))
}

#[derive(Debug, Deserialize)]
struct ImportReceipt {
    import_id: String,
    source_path: String,
}

fn read_import_receipt(target: &Path) -> Result<Option<ImportReceipt>> {
    let path = target.join(IMPORT_RECEIPT_FILE);
    let raw = match read_regular_control_file(&path, "existing-installation import receipt")? {
        Some(raw) => raw,
        None => return Ok(None),
    };
    let receipt: ImportReceipt =
        serde_json::from_slice(&raw).context("existing-installation import receipt is invalid")?;
    validate_import_id(&receipt.import_id)?;
    Ok(Some(receipt))
}

fn record_choice(
    environment: &ImportEnvironment,
    choice: ImportChoice,
    confirmed_source: Option<&str>,
) -> Result<()> {
    match choice {
        ImportChoice::Fresh => {
            anyhow::ensure!(
                confirmed_source.is_none(),
                "starting fresh must not include a confirmed upstream source"
            );
            save_state(&environment.state_file, &ImportStateFile::Fresh)
        }
        ImportChoice::Import => {
            let confirmed_source = normalize_upstream_path(
                confirmed_source.ok_or_else(|| {
                    anyhow::anyhow!("import requires the upstream source displayed to the user")
                })?,
                &environment.home_dir,
            )
            .context("confirmed upstream source is invalid")?;
            validate_source_and_target(&confirmed_source, &environment.target_base)?;

            // A failed retry is bound to the source the user originally
            // approved. Re-running detection here could silently switch from A
            // to a newly configured B between attempts.
            let persisted = match read_regular_control_file(
                &environment.state_file,
                "existing-installation import state",
            )? {
                Some(raw) => Some(serde_json::from_slice::<ImportStateFile>(&raw)?),
                None => None,
            };
            let retry = match persisted {
                Some(ImportStateFile::Pending {
                    import_id,
                    source_path,
                    target_path,
                    staging_path,
                    backup_path,
                }) => {
                    let pending = validate_pending_import(
                        environment,
                        &import_id,
                        &source_path,
                        &target_path,
                        &staging_path,
                        &backup_path,
                    )?;
                    validate_source_and_target(&pending.source, &pending.target)?;
                    ensure_confirmed_source_matches(&confirmed_source, &pending.source)?;
                    return Ok(());
                }
                Some(ImportStateFile::Failed {
                    import_id,
                    source_path,
                    target_path,
                    backup_path,
                    ..
                }) => {
                    validate_import_id(&import_id)?;
                    let failed_target = PathBuf::from(&target_path);
                    validate_absolute_normal_path(&failed_target, "failed import target")?;
                    anyhow::ensure!(
                        failed_target == environment.target_base,
                        "failed import target no longer matches the configured Agent 技能管家 library"
                    );
                    let expected_backup =
                        sibling_artifact(&failed_target, "pre-import-backup", &import_id)?;
                    if let Some(backup_path) = backup_path {
                        anyhow::ensure!(
                            Path::new(&backup_path) == expected_backup,
                            "failed import backup path is not a safe Agent 技能管家 artifact"
                        );
                    }
                    let source = PathBuf::from(source_path);
                    ensure_confirmed_source_matches(&confirmed_source, &source)?;
                    Some((import_id, source))
                }
                _ => None,
            };
            let (import_id, source) = match retry {
                Some(retry) => retry,
                None => {
                    let detected = detect_upstream_base(environment)?.ok_or_else(|| {
                        anyhow::anyhow!("no usable upstream installation was found")
                    })?;
                    ensure_confirmed_source_matches(&confirmed_source, &detected)?;
                    (uuid::Uuid::new_v4().to_string(), confirmed_source.clone())
                }
            };
            validate_source_and_target(&source, &environment.target_base)?;
            let staging = sibling_artifact(&environment.target_base, "import-staging", &import_id)?;
            let backup =
                sibling_artifact(&environment.target_base, "pre-import-backup", &import_id)?;
            save_state(
                &environment.state_file,
                &ImportStateFile::Pending {
                    import_id,
                    source_path: source.to_string_lossy().to_string(),
                    target_path: environment.target_base.to_string_lossy().to_string(),
                    staging_path: staging.to_string_lossy().to_string(),
                    backup_path: backup.to_string_lossy().to_string(),
                },
            )
        }
    }
}

fn ensure_confirmed_source_matches(confirmed: &Path, expected: &Path) -> Result<()> {
    validate_absolute_normal_path(expected, "expected upstream source")?;
    let confirmed_resolved = resolve_with_nearest_existing_ancestor(confirmed)?;
    let expected_resolved = resolve_with_nearest_existing_ancestor(expected)?;
    anyhow::ensure!(
        confirmed_resolved == expected_resolved,
        "confirmed upstream source no longer matches the source displayed to the user"
    );
    Ok(())
}

fn sibling_artifact(target: &Path, role: &str, import_id: &str) -> Result<PathBuf> {
    validate_import_id(import_id)?;
    let parent = target
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Agent 技能管家 target has no parent directory"))?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("Agent 技能管家 target has no safe directory name"))?;
    Ok(parent.join(format!(".{name}.{role}.{import_id}")))
}

fn save_state(path: &Path, state: &ImportStateFile) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("import state file has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".existing-installation-import.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    fs::write(&temp, serde_json::to_vec_pretty(state)?)?;
    match fs::rename(&temp, path) {
        Ok(()) => return Ok(()),
        Err(err) if path.exists() => {
            // Unix rename replaces atomically. Windows does not, so use the
            // narrow fallback there; an activated import is still recoverable
            // from its receipt if the process stops inside this small gap.
            fs::remove_file(path).with_context(|| {
                format!("failed to replace import state after rename error: {err}")
            })?;
        }
        Err(err) => return Err(err.into()),
    }
    fs::rename(&temp, path)?;
    Ok(())
}

fn load_upstream_config_state(path: &Path) -> UpstreamConfigState {
    match read_regular_control_file(path, "upstream config") {
        Ok(Some(raw)) => match serde_json::from_slice::<UpstreamRepoConfig>(&raw) {
            Ok(config) => UpstreamConfigState::Valid(config),
            Err(err) => UpstreamConfigState::Invalid(format!(
                "upstream config {} is invalid: {err}",
                path.display()
            )),
        },
        Ok(None) => UpstreamConfigState::Missing,
        Err(err) => UpstreamConfigState::Invalid(format!(
            "upstream config {} cannot be read: {err}",
            path.display()
        )),
    }
}

fn detect_upstream_base(environment: &ImportEnvironment) -> Result<Option<PathBuf>> {
    let config = match load_upstream_config_state(&environment.upstream_config_file) {
        UpstreamConfigState::Missing => None,
        UpstreamConfigState::Valid(config) => Some(config),
        UpstreamConfigState::Invalid(detail) => anyhow::bail!(detail),
    };

    let mut candidates = Vec::new();
    if let Some(config) = config {
        for raw in [
            config.pending_migration_from.as_deref(),
            config.repo_path.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            candidates.push(
                normalize_upstream_path(raw, &environment.home_dir).with_context(|| {
                    format!("upstream config contains an invalid repository path {raw:?}")
                })?,
            );
        }
    }
    if candidates.is_empty() {
        candidates.push(environment.home_dir.join(".skills-manager"));
    }

    for candidate in candidates {
        if !upstream_database_is_usable(&candidate) {
            continue;
        }
        validate_source_and_target(&candidate, &environment.target_base)?;
        return Ok(Some(candidate));
    }
    Ok(None)
}

fn normalize_upstream_path(raw: &str, home: &Path) -> Result<PathBuf> {
    let trimmed = raw.trim();
    let expanded = if trimmed == "~" {
        home.to_path_buf()
    } else if trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        home.join(&trimmed[2..])
    } else {
        PathBuf::from(trimmed)
    };
    anyhow::ensure!(
        expanded.is_absolute(),
        "upstream repository path is not absolute"
    );
    let mut normalized = PathBuf::new();
    for component in expanded.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

fn upstream_database_is_usable(base: &Path) -> bool {
    sqlite_database_is_usable(&base.join(UPSTREAM_DATABASE_FILE))
}

fn sqlite_database_is_usable(database: &Path) -> bool {
    let Some(metadata) = fs::symlink_metadata(database).ok() else {
        return false;
    };
    if metadata_is_symlink_or_reparse(&metadata) || !metadata.file_type().is_file() {
        return false;
    }
    Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|connection| connection.query_row("PRAGMA schema_version", [], |_| Ok(())))
        .is_ok()
}

fn validate_import_id(import_id: &str) -> Result<uuid::Uuid> {
    let parsed = uuid::Uuid::parse_str(import_id)
        .with_context(|| format!("import ID {import_id:?} is not a valid UUID"))?;
    anyhow::ensure!(
        parsed.hyphenated().to_string() == import_id,
        "import ID must be a canonical lowercase hyphenated UUID"
    );
    Ok(parsed)
}

fn validate_absolute_normal_path(path: &Path, label: &str) -> Result<()> {
    anyhow::ensure!(path.is_absolute(), "{label} must be an absolute path");
    for component in path.components() {
        anyhow::ensure!(
            matches!(
                component,
                Component::Prefix(_) | Component::RootDir | Component::Normal(_)
            ),
            "{label} contains a non-normal path component"
        );
    }
    Ok(())
}

/// Canonicalize an existing path, or canonicalize its nearest existing
/// ancestor and append the still-missing normal components. This catches an
/// absent target beneath a symlink alias instead of falling back to lexical
/// starts_with checks.
fn resolve_with_nearest_existing_ancestor(path: &Path) -> Result<PathBuf> {
    validate_absolute_normal_path(path, "path")?;
    let mut cursor = path;
    let mut missing: Vec<OsString> = Vec::new();
    loop {
        match fs::symlink_metadata(cursor) {
            Ok(_) => {
                let mut resolved = cursor.canonicalize().with_context(|| {
                    format!(
                        "failed to canonicalize existing ancestor {}",
                        cursor.display()
                    )
                })?;
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let name = cursor.file_name().ok_or_else(|| {
                    anyhow::anyhow!("cannot find an existing ancestor for {}", path.display())
                })?;
                missing.push(name.to_os_string());
                cursor = cursor.parent().ok_or_else(|| {
                    anyhow::anyhow!("cannot find an existing ancestor for {}", path.display())
                })?;
            }
            Err(err) => return Err(err.into()),
        }
    }
}

#[cfg(windows)]
fn metadata_is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn metadata_is_regular_file_or_directory(metadata: &fs::Metadata) -> bool {
    !metadata_is_symlink_or_reparse(metadata)
        && (metadata.file_type().is_file() || metadata.file_type().is_dir())
}

fn reject_symlink_or_reparse_root(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect {label} at {}", path.display()))?;
    anyhow::ensure!(
        !metadata_is_symlink_or_reparse(&metadata),
        "refusing {label} {} because its root is a symlink or reparse point",
        path.display()
    );
    Ok(())
}

fn validate_source_and_target(source: &Path, target: &Path) -> Result<()> {
    validate_absolute_normal_path(source, "upstream source")?;
    validate_absolute_normal_path(target, "Agent 技能管家 target")?;
    reject_symlink_or_reparse_root(source, "upstream source")?;
    if fs::symlink_metadata(target).is_ok() {
        reject_symlink_or_reparse_root(target, "Agent 技能管家 target")?;
    }
    anyhow::ensure!(
        upstream_database_is_usable(source),
        "upstream database is no longer usable"
    );
    let resolved_source = resolve_with_nearest_existing_ancestor(source)?;
    let resolved_target = resolve_with_nearest_existing_ancestor(target)?;
    anyhow::ensure!(
        resolved_source != resolved_target
            && !resolved_target.starts_with(&resolved_source)
            && !resolved_source.starts_with(&resolved_target),
        "upstream source and Agent 技能管家 target must be independent directories"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::skill_store::{SkillRecord, SkillStore};
    use rusqlite::Connection;
    use std::fs;

    #[test]
    fn normal_process_lifetime_shared_guards_can_coexist() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("process.lock");

        let first = try_acquire_process_lock_at(&lock_path, ProcessLockMode::Shared).unwrap();
        let second = try_acquire_process_lock_at(&lock_path, ProcessLockMode::Shared)
            .expect("a normal secondary GUI/CLI process must reach its normal startup path");

        drop(first);
        drop(second);
    }

    #[test]
    fn pending_import_exclusive_lock_is_denied_while_a_shared_process_is_alive() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("process.lock");

        let shared = try_acquire_process_lock_at(&lock_path, ProcessLockMode::Shared).unwrap();
        let error =
            try_acquire_process_lock_at(&lock_path, ProcessLockMode::Exclusive).unwrap_err();

        assert!(error.to_string().contains("exclusive"));
        drop(shared);
    }

    #[test]
    fn pending_import_exclusive_lock_waits_for_the_old_process_to_release() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("process.lock");
        let shared = try_acquire_process_lock_at(&lock_path, ProcessLockMode::Shared).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            drop(shared);
        });

        let exclusive = acquire_process_lock_at(
            &lock_path,
            ProcessLockMode::Exclusive,
            std::time::Duration::from_secs(1),
        )
        .expect("pending restart should wait for the exiting GUI within its timeout");

        release.join().unwrap();
        drop(exclusive);
    }

    #[test]
    fn process_lifetime_lock_downgrades_to_shared_before_database_open() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("process.lock");
        let process_cell = OnceLock::new();

        acquire_process_lock_once(
            &process_cell,
            &lock_path,
            ProcessLockMode::Exclusive,
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        downgrade_process_lock_once_to_shared(&process_cell, std::time::Duration::from_secs(1))
            .unwrap();

        try_acquire_process_lock_at(&lock_path, ProcessLockMode::Shared)
            .expect("another normal GUI can coexist after pending processing downgrades the lock");
        assert!(try_acquire_process_lock_at(&lock_path, ProcessLockMode::Exclusive).is_err());
    }

    #[test]
    fn process_lifetime_lock_is_reentrant_for_repo_set_reset_in_one_process() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("process.lock");
        let process_cell = OnceLock::new();

        acquire_process_lock_once(
            &process_cell,
            &lock_path,
            ProcessLockMode::Shared,
            std::time::Duration::ZERO,
        )
        .unwrap();
        acquire_process_lock_once(
            &process_cell,
            &lock_path,
            ProcessLockMode::Exclusive,
            std::time::Duration::ZERO,
        )
        .expect("same-process store reinitialization must reuse the held guard");

        try_acquire_process_lock_at(&lock_path, ProcessLockMode::Shared)
            .expect("same-process reentry must not accidentally upgrade the shared lock");
    }

    #[test]
    fn corrupt_import_state_uses_shared_lock_and_remains_untouched_for_the_error_gate() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("process.lock");
        let state_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("existing-installation-import.json");
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        let corrupt = b"{ not valid import state";
        fs::write(&state_path, corrupt).unwrap();

        let first = acquire_startup_process_lock_at(
            &lock_path,
            &state_path,
            ProcessCallerRole::Gui,
            std::time::Duration::from_millis(100),
        )
        .expect("invalid state is non-actionable and must not request an exclusive import lock");
        let second = acquire_startup_process_lock_at(
            &lock_path,
            &state_path,
            ProcessCallerRole::Gui,
            std::time::Duration::from_millis(100),
        )
        .expect("normal secondary GUI startup remains available for the error gate");

        assert_eq!(*first.mode.lock().unwrap(), ProcessLockMode::Shared);
        assert_eq!(*second.mode.lock().unwrap(), ProcessLockMode::Shared);
        assert_eq!(fs::read(&state_path).unwrap(), corrupt);
    }

    #[test]
    fn syntactically_valid_pending_state_requests_the_exclusive_startup_lock() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("process.lock");
        let environment = test_environment(temp.path());
        let import_id = uuid::Uuid::new_v4().to_string();
        let staging =
            sibling_artifact(&environment.target_base, "import-staging", &import_id).unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: environment
                    .home_dir
                    .join(".skills-manager")
                    .to_string_lossy()
                    .to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        let guard = acquire_startup_process_lock_at(
            &lock_path,
            &environment.state_file,
            ProcessCallerRole::Gui,
            std::time::Duration::from_millis(100),
        )
        .unwrap();

        assert_eq!(*guard.mode.lock().unwrap(), ProcessLockMode::Exclusive);
        assert!(try_acquire_process_lock_at(&lock_path, ProcessLockMode::Shared).is_err());
    }

    #[test]
    fn cli_startup_refuses_a_gui_pending_import_without_mutating_recovery_state() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("process.lock");
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-target.txt"), b"target").unwrap();
        let import_id = uuid::Uuid::new_v4().to_string();
        let staging =
            sibling_artifact(&environment.target_base, "import-staging", &import_id).unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("keep-staging.txt"), b"staging").unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();
        let pending_bytes = fs::read(&environment.state_file).unwrap();

        for _ in 0..100 {
            let error = acquire_startup_process_lock_at(
                &lock_path,
                &environment.state_file,
                ProcessCallerRole::Cli,
                std::time::Duration::from_millis(100),
            )
            .unwrap_err();

            assert!(error.to_string().contains("pending import"));
            assert!(error.to_string().contains("GUI"));
            let exclusive = try_acquire_process_lock_at(&lock_path, ProcessLockMode::Exclusive)
                .expect("a rejected CLI startup must release its temporary shared lock");
            drop(exclusive);
        }
        assert_eq!(fs::read(&environment.state_file).unwrap(), pending_bytes);
        assert_eq!(
            fs::read(environment.target_base.join("keep-target.txt")).unwrap(),
            b"target"
        );
        assert_eq!(
            fs::read(staging.join("keep-staging.txt")).unwrap(),
            b"staging"
        );
    }

    fn test_environment(root: &std::path::Path) -> ImportEnvironment {
        ImportEnvironment {
            home_dir: root.join("home"),
            upstream_config_file: root
                .join("config")
                .join("skills-manager")
                .join("repo-config.json"),
            target_base: root.join("home").join(".skill-expert"),
            state_file: root
                .join("config")
                .join("skill-expert")
                .join("existing-installation-import.json"),
        }
    }

    fn create_upstream_database(base: &std::path::Path) {
        fs::create_dir_all(base).unwrap();
        let connection = Connection::open(base.join("skills-manager.db")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE skills (id TEXT PRIMARY KEY, central_path TEXT NOT NULL);",
            )
            .unwrap();
    }

    #[test]
    fn detects_a_usable_upstream_custom_central_library() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let custom = temp.path().join("custom").join("upstream-library");
        create_upstream_database(&custom);
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({ "repo_path": custom, "pending_migration_from": null }).to_string(),
        )
        .unwrap();

        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "prompt");
        assert!(status.should_prompt);
        assert_eq!(
            status.source_path,
            Some(custom.to_string_lossy().to_string())
        );
    }

    #[test]
    fn initial_import_rejects_a_displayed_source_after_detection_changes() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let source_a = temp.path().join("upstream-a");
        let source_b = temp.path().join("upstream-b");
        create_upstream_database(&source_a);
        create_upstream_database(&source_b);
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({ "repo_path": source_a }).to_string(),
        )
        .unwrap();
        let displayed_source = inspect_status(&environment)
            .unwrap()
            .source_path
            .expect("source A is displayed in the confirmation prompt");

        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({ "repo_path": source_b }).to_string(),
        )
        .unwrap();
        let error =
            record_choice(&environment, ImportChoice::Import, Some(&displayed_source)).unwrap_err();

        assert!(error.to_string().contains("confirmed upstream source"));
        assert!(error.to_string().contains("no longer matches"));
        assert!(
            !environment.state_file.exists(),
            "a stale confirmation for A must never persist a Pending import for B"
        );
    }

    #[test]
    fn initial_import_accepts_the_still_current_displayed_source() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let source_a = temp.path().join("upstream-a");
        create_upstream_database(&source_a);
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({ "repo_path": source_a }).to_string(),
        )
        .unwrap();
        let displayed_source = inspect_status(&environment)
            .unwrap()
            .source_path
            .expect("source A is displayed in the confirmation prompt");

        record_choice(&environment, ImportChoice::Import, Some(&displayed_source)).unwrap();

        let state: ImportStateFile =
            serde_json::from_slice(&fs::read(&environment.state_file).unwrap()).unwrap();
        let ImportStateFile::Pending { source_path, .. } = state else {
            panic!("confirming the current displayed source must persist Pending");
        };
        assert_eq!(source_path, source_a.to_string_lossy());
    }

    #[test]
    #[cfg(unix)]
    fn initial_import_persists_the_normalized_path_that_was_actually_confirmed() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let real_parent = temp.path().join("real-parent");
        let detected_source = real_parent.join("upstream");
        create_upstream_database(&detected_source);
        let alias_parent = temp.path().join("alias-parent");
        symlink(&real_parent, &alias_parent).unwrap();
        let confirmed_source = alias_parent.join("upstream");
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({ "repo_path": detected_source }).to_string(),
        )
        .unwrap();

        record_choice(
            &environment,
            ImportChoice::Import,
            Some(confirmed_source.to_str().unwrap()),
        )
        .unwrap();

        let state: ImportStateFile =
            serde_json::from_slice(&fs::read(&environment.state_file).unwrap()).unwrap();
        let ImportStateFile::Pending { source_path, .. } = state else {
            panic!("a canonically matching confirmation must persist Pending");
        };
        assert_eq!(source_path, confirmed_source.to_string_lossy());
    }

    #[test]
    fn import_requires_a_confirmed_displayed_source() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        create_upstream_database(&environment.home_dir.join(".skills-manager"));

        let error = record_choice(&environment, ImportChoice::Import, None).unwrap_err();

        assert!(error.to_string().contains("requires the upstream source"));
        assert!(!environment.state_file.exists());
    }

    #[test]
    fn fresh_rejects_an_upstream_source_argument() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);

        let error = record_choice(
            &environment,
            ImportChoice::Fresh,
            Some(upstream.to_str().unwrap()),
        )
        .unwrap_err();

        assert!(error.to_string().contains("must not include"));
        assert!(!environment.state_file.exists());
    }

    #[test]
    fn does_not_prompt_without_a_usable_upstream_database() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        fs::create_dir_all(environment.home_dir.join(".skills-manager")).unwrap();
        fs::write(
            environment
                .home_dir
                .join(".skills-manager")
                .join("skills-manager.db"),
            b"not sqlite",
        )
        .unwrap();

        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "not_available");
        assert!(!status.should_prompt);
        assert_eq!(status.source_path, None);
    }

    #[test]
    #[cfg(unix)]
    fn fifo_database_is_rejected_without_waiting_for_a_writer() {
        let temp = tempfile::tempdir().unwrap();
        let fifo = temp.path().join("skills-manager.db");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let (sender, receiver) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            let _ = sender.send(sqlite_database_is_usable(&fifo));
        });

        assert_eq!(
            receiver.recv_timeout(std::time::Duration::from_millis(250)),
            Ok(false),
            "database probing must reject a FIFO from metadata instead of blocking in SQLite"
        );
    }

    #[test]
    #[cfg(unix)]
    fn fifo_import_state_uses_a_shared_startup_lock_without_waiting_for_a_writer() {
        let temp = tempfile::tempdir().unwrap();
        let lock_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("process.lock");
        let state_path = temp
            .path()
            .join("config")
            .join("skill-expert")
            .join("existing-installation-import.json");
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&state_path)
            .status()
            .unwrap()
            .success());
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = acquire_startup_process_lock_at(
                &lock_path,
                &state_path,
                ProcessCallerRole::Gui,
                std::time::Duration::from_millis(100),
            )
            .map(|guard| *guard.mode.lock().unwrap())
            .map_err(|err| format!("{err:#}"));
            let _ = sender.send(result);
        });

        assert_eq!(
            receiver.recv_timeout(std::time::Duration::from_millis(250)),
            Ok(Ok(ProcessLockMode::Shared)),
            "a special import state file is non-actionable for lock selection"
        );
    }

    #[test]
    #[cfg(unix)]
    fn fifo_import_state_status_returns_an_explicit_error_without_blocking() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        fs::create_dir_all(environment.state_file.parent().unwrap()).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&environment.state_file)
            .status()
            .unwrap()
            .success());
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = inspect_status(&environment).map_err(|err| format!("{err:#}"));
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(std::time::Duration::from_millis(250))
            .expect("status metadata preflight must not open the FIFO");
        let error = result.expect_err("a special import state file must be reported");
        assert!(error.contains("import state"));
        assert!(error.contains("regular"));
    }

    #[test]
    #[cfg(unix)]
    fn fifo_upstream_config_status_returns_an_explicit_error_without_blocking() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&environment.upstream_config_file)
            .status()
            .unwrap()
            .success());
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = inspect_status(&environment).map_err(|err| format!("{err:#}"));
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(std::time::Duration::from_millis(250))
            .expect("upstream config metadata preflight must not open the FIFO");
        let error = result.expect_err("a special upstream config file must be reported");
        assert!(error.contains("upstream config"));
        assert!(error.contains("regular"));
    }

    #[test]
    #[cfg(unix)]
    fn fifo_import_receipt_status_returns_an_explicit_error_without_blocking() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        fs::create_dir_all(&environment.target_base).unwrap();
        let receipt = environment.target_base.join(IMPORT_RECEIPT_FILE);
        assert!(std::process::Command::new("mkfifo")
            .arg(&receipt)
            .status()
            .unwrap()
            .success());
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = inspect_status(&environment).map_err(|err| format!("{err:#}"));
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(std::time::Duration::from_millis(250))
            .expect("receipt metadata preflight must not open the FIFO");
        let error = result.expect_err("a special receipt file must be reported");
        assert!(error.contains("receipt"));
        assert!(error.contains("regular"));
    }

    #[test]
    fn pending_legacy_relocation_source_wins_over_the_configured_destination() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let active_source = temp.path().join("custom").join("current-library");
        let future_destination = temp.path().join("custom").join("future-library");
        create_upstream_database(&active_source);
        create_upstream_database(&future_destination);
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({
                "repo_path": future_destination,
                "pending_migration_from": active_source,
            })
            .to_string(),
        )
        .unwrap();

        let status = inspect_status(&environment).unwrap();

        assert_eq!(
            status.source_path,
            Some(active_source.to_string_lossy().to_string()),
            "the old product still runs against pending_migration_from until its own relocation completes"
        );
    }

    #[test]
    fn corrupt_upstream_config_is_an_explicit_error_not_a_default_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        create_upstream_database(&environment.home_dir.join(".skills-manager"));
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        fs::write(&environment.upstream_config_file, b"{ definitely not json").unwrap();

        let error = inspect_status(&environment).unwrap_err();

        assert!(error.to_string().contains("upstream config"));
        assert!(error.to_string().contains("invalid"));
    }

    #[test]
    #[cfg(unix)]
    fn rejects_a_symlink_upstream_root_before_staging_the_choice() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let actual = temp.path().join("actual-upstream");
        create_upstream_database(&actual);
        fs::create_dir_all(&environment.home_dir).unwrap();
        symlink(&actual, environment.home_dir.join(".skills-manager")).unwrap();

        let displayed_source = environment.home_dir.join(".skills-manager");
        let error = record_choice(
            &environment,
            ImportChoice::Import,
            Some(displayed_source.to_str().unwrap()),
        )
        .unwrap_err();

        assert!(error.to_string().contains("symlink"));
        assert!(!environment.state_file.exists());
    }

    #[test]
    #[cfg(unix)]
    fn rejects_an_absent_target_that_resolves_inside_source_through_a_symlink_parent() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let mut environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        let alias = temp.path().join("source-alias");
        symlink(&upstream, &alias).unwrap();
        environment.target_base = alias.join("new-skill-expert-target");

        let error = record_choice(
            &environment,
            ImportChoice::Import,
            Some(upstream.to_str().unwrap()),
        )
        .unwrap_err();

        assert!(error.to_string().contains("independent directories"));
        assert!(!environment.state_file.exists());
    }

    #[test]
    fn start_fresh_choice_is_persisted_and_suppresses_future_prompts() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        let original_database = fs::read(upstream.join("skills-manager.db")).unwrap();

        record_choice(&environment, ImportChoice::Fresh, None).unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "fresh");
        assert!(!status.should_prompt);
        assert!(environment.state_file.is_file());
        assert_eq!(
            fs::read(upstream.join("skills-manager.db")).unwrap(),
            original_database,
            "the declined upstream source remains untouched"
        );
    }

    #[test]
    fn approved_import_is_only_staged_while_the_current_database_is_open() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(&environment.target_base).unwrap();
        let target_store = SkillStore::new(&environment.target_base.join("skill-expert.db"))
            .expect("simulate the current GUI session holding the target database open");
        target_store
            .set_setting("current_session", "still open")
            .unwrap();
        fs::write(
            environment.target_base.join("current-session.txt"),
            b"still open",
        )
        .unwrap();

        record_choice(
            &environment,
            ImportChoice::Import,
            Some(upstream.to_str().unwrap()),
        )
        .unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "pending");
        assert!(!status.should_prompt);
        assert_eq!(
            fs::read(environment.target_base.join("current-session.txt")).unwrap(),
            b"still open",
            "choosing import must not replace the active target before restart"
        );
        assert_eq!(
            target_store.get_setting("current_session").unwrap(),
            Some("still open".to_string()),
            "the open target database remains usable until the GUI restarts"
        );
        assert!(upstream.join("skills-manager.db").is_file());
    }

    #[test]
    fn pending_import_copies_on_restart_keeps_a_backup_and_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        fs::create_dir_all(upstream.join("skills").join("demo")).unwrap();
        fs::write(
            upstream.join("skills").join("demo").join("SKILL.md"),
            b"upstream skill",
        )
        .unwrap();
        let source_skill_path = upstream
            .join("skills")
            .join("demo")
            .to_string_lossy()
            .to_string();
        let source_store = SkillStore::new(&upstream.join("skills-manager.db")).unwrap();
        source_store
            .insert_skill(&SkillRecord {
                id: "demo".to_string(),
                name: "Demo".to_string(),
                description: Some("Imported from upstream".to_string()),
                source_type: "local".to_string(),
                source_ref: None,
                source_ref_resolved: None,
                source_subpath: None,
                source_branch: None,
                source_revision: None,
                remote_revision: None,
                central_path: source_skill_path,
                content_hash: None,
                enabled: true,
                created_at: 1,
                updated_at: 1,
                status: "ok".to_string(),
                update_status: "unknown".to_string(),
                last_checked_at: None,
                last_check_error: None,
            })
            .unwrap();

        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(
            environment.target_base.join("current-session.txt"),
            b"target data",
        )
        .unwrap();
        record_choice(
            &environment,
            ImportChoice::Import,
            Some(upstream.to_str().unwrap()),
        )
        .unwrap();
        let pending_state = fs::read(&environment.state_file).unwrap();
        let pending = inspect_status(&environment).unwrap();
        let backup = PathBuf::from(pending.backup_path.unwrap());

        process_pending_import(&environment).unwrap();

        assert_eq!(
            fs::read(
                environment
                    .target_base
                    .join("skills")
                    .join("demo")
                    .join("SKILL.md"),
            )
            .unwrap(),
            b"upstream skill"
        );
        assert!(environment.target_base.join("skill-expert.db").is_file());
        assert!(!environment.target_base.join("skills-manager.db").exists());
        assert_eq!(
            fs::read(backup.join("current-session.txt")).unwrap(),
            b"target data",
            "existing target data is retained in a recoverable backup"
        );
        assert!(upstream.join("skills-manager.db").is_file());
        assert!(upstream
            .join("skills")
            .join("demo")
            .join("SKILL.md")
            .is_file());

        let imported_store =
            SkillStore::new(&environment.target_base.join("skill-expert.db")).unwrap();
        let imported_path = imported_store
            .get_skill_by_id("demo")
            .unwrap()
            .unwrap()
            .central_path;
        assert_eq!(
            imported_path,
            environment
                .target_base
                .join("skills")
                .join("demo")
                .to_string_lossy()
        );
        drop(imported_store);

        assert_eq!(inspect_status(&environment).unwrap().state, "imported");
        fs::write(&environment.state_file, pending_state).unwrap();
        process_pending_import(&environment).unwrap();
        assert_eq!(inspect_status(&environment).unwrap().state, "imported");
        assert_eq!(
            fs::read(
                environment
                    .target_base
                    .join("skills")
                    .join("demo")
                    .join("SKILL.md"),
            )
            .unwrap(),
            b"upstream skill",
            "a repeated startup is a no-op"
        );
    }

    #[test]
    fn crash_after_backup_rename_activates_a_valid_completed_staging_copy() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(upstream.join("skills").join("demo")).unwrap();
        fs::write(
            upstream.join("skills").join("demo").join("SKILL.md"),
            b"upstream skill",
        )
        .unwrap();
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"old target").unwrap();

        let import_id = uuid::Uuid::new_v4().to_string();
        let staging =
            sibling_artifact(&environment.target_base, "import-staging", &import_id).unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        copy_upstream_to_staging(&upstream, &staging, &environment.target_base, &import_id)
            .unwrap();
        fs::rename(&environment.target_base, &backup).unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        process_pending_import(&environment).unwrap();

        assert_eq!(inspect_status(&environment).unwrap().state, "imported");
        assert_eq!(
            fs::read(
                environment
                    .target_base
                    .join("skills")
                    .join("demo")
                    .join("SKILL.md"),
            )
            .unwrap(),
            b"upstream skill"
        );
        assert_eq!(fs::read(backup.join("keep-me.txt")).unwrap(), b"old target");
    }

    #[test]
    fn crash_after_backup_rename_restores_backup_when_staging_is_not_valid() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"old target").unwrap();

        let import_id = uuid::Uuid::new_v4().to_string();
        let staging =
            sibling_artifact(&environment.target_base, "import-staging", &import_id).unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("partial-copy.txt"), b"incomplete").unwrap();
        fs::rename(&environment.target_base, &backup).unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        process_pending_import(&environment).unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "failed");
        assert!(status.error.unwrap().contains("restored"));
        assert_eq!(
            fs::read(environment.target_base.join("keep-me.txt")).unwrap(),
            b"old target"
        );
        assert!(
            staging.join("partial-copy.txt").exists(),
            "the incomplete staging evidence is retained after the recovery decision"
        );
    }

    #[test]
    fn crash_recovery_restores_backup_when_receipted_staging_database_is_corrupt() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"old target").unwrap();
        let import_id = uuid::Uuid::new_v4().to_string();
        let staging =
            sibling_artifact(&environment.target_base, "import-staging", &import_id).unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        copy_upstream_to_staging(&upstream, &staging, &environment.target_base, &import_id)
            .unwrap();
        fs::write(staging.join(TARGET_DATABASE_FILE), b"not sqlite").unwrap();
        fs::rename(&environment.target_base, &backup).unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        process_pending_import(&environment).unwrap();

        assert_eq!(inspect_status(&environment).unwrap().state, "failed");
        assert_eq!(
            fs::read(environment.target_base.join("keep-me.txt")).unwrap(),
            b"old target"
        );
    }

    #[test]
    #[cfg(unix)]
    fn failed_backup_restore_is_propagated_before_an_empty_target_can_open() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"old target").unwrap();
        let import_id = uuid::Uuid::new_v4().to_string();
        let staging =
            sibling_artifact(&environment.target_base, "import-staging", &import_id).unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("partial-copy.txt"), b"incomplete").unwrap();
        fs::rename(&environment.target_base, &backup).unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();
        let pending_state = fs::read(&environment.state_file).unwrap();
        fs::set_permissions(&environment.home_dir, fs::Permissions::from_mode(0o500)).unwrap();

        let result = process_pending_import(&environment);
        fs::set_permissions(&environment.home_dir, fs::Permissions::from_mode(0o700)).unwrap();
        let error = result.unwrap_err();

        assert!(error
            .to_string()
            .contains("refusing to open an empty target"));
        assert!(!environment.target_base.exists());
        assert!(backup.join("keep-me.txt").exists());
        assert_eq!(
            fs::read(&environment.state_file).unwrap(),
            pending_state,
            "unsafe recovery remains Pending so the next launch still takes the exclusive path"
        );
    }

    #[test]
    #[cfg(unix)]
    fn crash_recovery_restores_backup_instead_of_trusting_a_symlinked_source_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"old target").unwrap();
        let import_id = uuid::Uuid::new_v4().to_string();
        let staging =
            sibling_artifact(&environment.target_base, "import-staging", &import_id).unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        copy_upstream_to_staging(&upstream, &staging, &environment.target_base, &import_id)
            .unwrap();
        fs::rename(&environment.target_base, &backup).unwrap();
        let moved_upstream = environment.home_dir.join("moved-upstream");
        fs::rename(&upstream, &moved_upstream).unwrap();
        symlink(&moved_upstream, &upstream).unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        process_pending_import(&environment).unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "failed");
        assert!(status.error.unwrap().contains("symlink"));
        assert_eq!(
            fs::read(environment.target_base.join("keep-me.txt")).unwrap(),
            b"old target"
        );
    }

    #[test]
    #[cfg(unix)]
    fn crash_recovery_does_not_activate_receipted_staging_with_a_symlink_entry() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"old target").unwrap();
        let import_id = uuid::Uuid::new_v4().to_string();
        let staging =
            sibling_artifact(&environment.target_base, "import-staging", &import_id).unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        copy_upstream_to_staging(&upstream, &staging, &environment.target_base, &import_id)
            .unwrap();
        symlink(&upstream, staging.join("shared-upstream")).unwrap();
        fs::rename(&environment.target_base, &backup).unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        process_pending_import(&environment).unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "failed");
        assert_eq!(
            fs::read(environment.target_base.join("keep-me.txt")).unwrap(),
            b"old target"
        );
        assert!(staging.join("shared-upstream").exists());
    }

    #[test]
    #[cfg(unix)]
    fn crash_recovery_restores_backup_instead_of_activating_a_socket_entry() {
        use std::os::unix::net::UnixListener;

        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"old target").unwrap();
        let import_id = uuid::Uuid::new_v4().to_string();
        let staging =
            sibling_artifact(&environment.target_base, "import-staging", &import_id).unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        copy_upstream_to_staging(&upstream, &staging, &environment.target_base, &import_id)
            .unwrap();
        let short_socket_path = temp.path().join("s.sock");
        let _socket = UnixListener::bind(&short_socket_path).unwrap();
        fs::rename(&short_socket_path, staging.join("unexpected.sock")).unwrap();
        fs::rename(&environment.target_base, &backup).unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        process_pending_import(&environment).unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "failed");
        assert!(status.error.unwrap().contains("restored"));
        assert_eq!(
            fs::read(environment.target_base.join("keep-me.txt")).unwrap(),
            b"old target"
        );
        assert!(staging.join("unexpected.sock").exists());
    }

    #[test]
    #[cfg(unix)]
    fn import_rejects_a_fifo_entry_quickly_and_preserves_the_target() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        let fifo = upstream.join("unexpected.pipe");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"old target").unwrap();
        record_choice(
            &environment,
            ImportChoice::Import,
            Some(upstream.to_str().unwrap()),
        )
        .unwrap();
        let mut writer = std::process::Command::new("/bin/sh")
            .args(["-c", "printf payload > \"$1\"", "fifo-writer"])
            .arg(&fifo)
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();

        process_pending_import(&environment).unwrap();
        if writer.try_wait().unwrap().is_none() {
            writer.kill().unwrap();
        }
        writer.wait().unwrap();
        let status = inspect_status(&environment).unwrap();

        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(status.state, "failed");
        assert!(status.error.unwrap().contains("regular file or directory"));
        assert_eq!(
            fs::read(environment.target_base.join("keep-me.txt")).unwrap(),
            b"old target"
        );
    }

    #[test]
    fn import_rejects_upstream_records_that_would_keep_using_an_external_central_path() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        let external = temp.path().join("shared-outside-upstream").join("skill");
        fs::create_dir_all(&external).unwrap();
        let connection = Connection::open(upstream.join("skills-manager.db")).unwrap();
        connection
            .execute(
                "INSERT INTO skills (id, central_path) VALUES (?1, ?2)",
                rusqlite::params!["external", external.to_string_lossy()],
            )
            .unwrap();
        drop(connection);
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"target data").unwrap();
        record_choice(
            &environment,
            ImportChoice::Import,
            Some(upstream.to_str().unwrap()),
        )
        .unwrap();

        process_pending_import(&environment).unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "failed");
        assert!(status
            .error
            .unwrap()
            .contains("outside the upstream skills directory"));
        assert_eq!(
            fs::read(environment.target_base.join("keep-me.txt")).unwrap(),
            b"target data",
            "an unsafe source record must not replace the current Agent 技能管家 target"
        );
        assert!(external.is_dir(), "the external source remains untouched");
    }

    #[test]
    fn import_rejects_non_normal_relative_central_path_components() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        let traversal = upstream
            .join("skills")
            .join("demo")
            .join("..")
            .join("..")
            .join("outside");
        let connection = Connection::open(upstream.join("skills-manager.db")).unwrap();
        connection
            .execute(
                "INSERT INTO skills (id, central_path) VALUES (?1, ?2)",
                rusqlite::params!["traversal", traversal.to_string_lossy()],
            )
            .unwrap();
        drop(connection);
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"target data").unwrap();
        record_choice(
            &environment,
            ImportChoice::Import,
            Some(upstream.to_str().unwrap()),
        )
        .unwrap();

        process_pending_import(&environment).unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "failed");
        assert!(status.error.unwrap().contains("non-normal"));
        assert_eq!(
            fs::read(environment.target_base.join("keep-me.txt")).unwrap(),
            b"target data"
        );
    }

    #[test]
    fn invalid_import_id_is_rejected_before_any_artifact_is_touched() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        let invalid_id = "not-a-uuid";
        let staging = environment.target_base.parent().unwrap().join(format!(
            ".{}.import-staging.{invalid_id}",
            environment
                .target_base
                .file_name()
                .unwrap()
                .to_string_lossy()
        ));
        let backup = environment.target_base.parent().unwrap().join(format!(
            ".{}.pre-import-backup.{invalid_id}",
            environment
                .target_base
                .file_name()
                .unwrap()
                .to_string_lossy()
        ));
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("must-survive.txt"), b"untouched").unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id: invalid_id.to_string(),
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();
        let original_pending = fs::read(&environment.state_file).unwrap();

        let first_error = process_pending_import(&environment).unwrap_err();
        let second_error = process_pending_import(&environment).unwrap_err();

        for error in [first_error, second_error] {
            assert!(error
                .to_string()
                .contains("refusing to open an empty target"));
        }
        assert_eq!(
            fs::read(&environment.state_file).unwrap(),
            original_pending,
            "both startups retain Pending so neither can downgrade and open an empty database"
        );
        assert_eq!(
            fs::read(staging.join("must-survive.txt")).unwrap(),
            b"untouched"
        );
    }

    #[test]
    fn valid_import_id_cannot_escape_to_a_forged_artifact_path() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(&environment.target_base).unwrap();
        let import_id = uuid::Uuid::new_v4().to_string();
        let forged_staging = temp.path().join("forged-staging");
        fs::create_dir_all(&forged_staging).unwrap();
        fs::write(forged_staging.join("must-survive.txt"), b"untouched").unwrap();
        let backup =
            sibling_artifact(&environment.target_base, "pre-import-backup", &import_id).unwrap();
        save_state(
            &environment.state_file,
            &ImportStateFile::Pending {
                import_id,
                source_path: upstream.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                staging_path: forged_staging.to_string_lossy().to_string(),
                backup_path: backup.to_string_lossy().to_string(),
            },
        )
        .unwrap();

        process_pending_import(&environment).unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "failed");
        assert!(status
            .error
            .unwrap()
            .contains("safe Agent 技能管家 artifact"));
        assert_eq!(
            fs::read(forged_staging.join("must-survive.txt")).unwrap(),
            b"untouched"
        );
        assert_eq!(status.backup_path, None);
    }

    #[test]
    fn failed_retry_reuses_the_exact_persisted_source_instead_of_redetecting() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let source_a = temp.path().join("upstream-a");
        let source_b = temp.path().join("upstream-b");
        create_upstream_database(&source_a);
        create_upstream_database(&source_b);
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({ "repo_path": source_b }).to_string(),
        )
        .unwrap();
        let original_import_id = uuid::Uuid::new_v4().to_string();
        save_state(
            &environment.state_file,
            &ImportStateFile::Failed {
                import_id: original_import_id.clone(),
                source_path: source_a.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                backup_path: None,
                error: "previous attempt failed".to_string(),
            },
        )
        .unwrap();

        record_choice(
            &environment,
            ImportChoice::Import,
            Some(source_a.to_str().unwrap()),
        )
        .unwrap();
        let raw = fs::read(&environment.state_file).unwrap();
        let state: ImportStateFile = serde_json::from_slice(&raw).unwrap();

        let ImportStateFile::Pending {
            import_id,
            source_path,
            ..
        } = state
        else {
            panic!("retry must return to pending state");
        };
        assert_eq!(source_path, source_a.to_string_lossy());
        assert_eq!(
            import_id, original_import_id,
            "retry keeps the original recovery artifact identity"
        );
    }

    #[test]
    fn failed_retry_rejects_confirmation_of_a_different_source() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let source_a = temp.path().join("upstream-a");
        let source_b = temp.path().join("upstream-b");
        create_upstream_database(&source_a);
        create_upstream_database(&source_b);
        let import_id = uuid::Uuid::new_v4().to_string();
        save_state(
            &environment.state_file,
            &ImportStateFile::Failed {
                import_id,
                source_path: source_a.to_string_lossy().to_string(),
                target_path: environment.target_base.to_string_lossy().to_string(),
                backup_path: None,
                error: "previous attempt failed".to_string(),
            },
        )
        .unwrap();
        let original_state = fs::read(&environment.state_file).unwrap();

        let error = record_choice(
            &environment,
            ImportChoice::Import,
            Some(source_b.to_str().unwrap()),
        )
        .unwrap_err();

        assert!(error.to_string().contains("no longer matches"));
        assert_eq!(fs::read(&environment.state_file).unwrap(), original_state);
    }

    #[test]
    fn repeated_import_choice_keeps_the_existing_pending_source_and_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let source_a = temp.path().join("upstream-a");
        let source_b = temp.path().join("upstream-b");
        create_upstream_database(&source_a);
        create_upstream_database(&source_b);
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({ "repo_path": source_a }).to_string(),
        )
        .unwrap();
        record_choice(
            &environment,
            ImportChoice::Import,
            Some(source_a.to_str().unwrap()),
        )
        .unwrap();
        let original_state = fs::read(&environment.state_file).unwrap();

        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({ "repo_path": source_b }).to_string(),
        )
        .unwrap();
        record_choice(
            &environment,
            ImportChoice::Import,
            Some(source_a.to_str().unwrap()),
        )
        .unwrap();

        assert_eq!(
            fs::read(&environment.state_file).unwrap(),
            original_state,
            "a failed restart must not let a second click silently replace approved source A with B"
        );
    }

    #[test]
    fn pending_import_rejects_confirmation_of_a_different_source() {
        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let source_a = temp.path().join("upstream-a");
        let source_b = temp.path().join("upstream-b");
        create_upstream_database(&source_a);
        create_upstream_database(&source_b);
        fs::create_dir_all(environment.upstream_config_file.parent().unwrap()).unwrap();
        fs::write(
            &environment.upstream_config_file,
            serde_json::json!({ "repo_path": source_a }).to_string(),
        )
        .unwrap();
        record_choice(
            &environment,
            ImportChoice::Import,
            Some(source_a.to_str().unwrap()),
        )
        .unwrap();
        let original_state = fs::read(&environment.state_file).unwrap();

        let error = record_choice(
            &environment,
            ImportChoice::Import,
            Some(source_b.to_str().unwrap()),
        )
        .unwrap_err();

        assert!(error.to_string().contains("no longer matches"));
        assert_eq!(fs::read(&environment.state_file).unwrap(), original_state);
    }

    #[test]
    #[cfg(unix)]
    fn failed_import_keeps_the_existing_target_and_reports_a_recoverable_error() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let environment = test_environment(temp.path());
        let upstream = environment.home_dir.join(".skills-manager");
        create_upstream_database(&upstream);
        fs::create_dir_all(upstream.join("skills").join("demo")).unwrap();
        symlink(
            upstream.join("skills"),
            upstream.join("skills").join("demo").join("shared"),
        )
        .unwrap();
        fs::create_dir_all(&environment.target_base).unwrap();
        fs::write(environment.target_base.join("keep-me.txt"), b"target data").unwrap();
        record_choice(
            &environment,
            ImportChoice::Import,
            Some(upstream.to_str().unwrap()),
        )
        .unwrap();

        process_pending_import(&environment).unwrap();
        let status = inspect_status(&environment).unwrap();

        assert_eq!(status.state, "failed");
        assert!(
            status.should_prompt,
            "the user can retry or choose Start Fresh"
        );
        assert!(status.error.unwrap().contains("symlink"));
        assert_eq!(
            fs::read(environment.target_base.join("keep-me.txt")).unwrap(),
            b"target data",
            "a failed preflight leaves the existing target recoverable in place"
        );
        assert!(upstream.join("skills").join("demo").join("shared").exists());
    }
}
