use super::{codex, validate_catalog_contract, AgentPluginCatalogErrorKind};
use crate::core::process_runner::{run_process, ProcessError, ProcessOutput, ProcessRequest};
use crate::core::skill_store::SkillStore;
use anyhow::Result;
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexCliResolutionSource {
    Explicit,
    Environment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ResolvedCodexCli {
    pub(super) path: PathBuf,
    pub(super) source: CodexCliResolutionSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CodexCliResolutionError {
    Unavailable,
    ConfiguredPathInvalid,
    NotRunnable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexCliFactStatus {
    Confirmed,
    Unavailable,
    Unchecked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CodexCliFacts {
    pub configuration_directory: CodexCliFactStatus,
    pub executable_resolution: CodexCliFactStatus,
    pub command_runtime: CodexCliFactStatus,
    pub plugin_json_contract: CodexCliFactStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CodexCliConfiguration {
    pub resolution_source: CodexCliResolutionSource,
    pub configured_path: Option<String>,
    pub facts: CodexCliFacts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentPluginCatalogErrorKind>,
}

pub const CODEX_CLI_PATH_SETTING_KEY: &str = "codex_cli_path";

pub(super) struct CodexCliProbeOutput {
    success: bool,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

pub(super) trait CodexCliProbe {
    fn run_catalog(&self, executable: &Path) -> Result<CodexCliProbeOutput, ProcessError>;
}

struct ProcessCodexCliProbe;

const CODEX_CATALOG_ARGUMENTS: [&str; 4] = ["plugin", "list", "--available", "--json"];

pub(super) fn run_codex_catalog_command(executable: &Path) -> Result<ProcessOutput, ProcessError> {
    let request = ProcessRequest::new(
        executable,
        CODEX_CATALOG_ARGUMENTS
            .into_iter()
            .map(OsString::from)
            .collect(),
        allowed_environment(),
    );
    run_process(&request, None)
}

impl CodexCliProbe for ProcessCodexCliProbe {
    fn run_catalog(&self, executable: &Path) -> Result<CodexCliProbeOutput, ProcessError> {
        let output = run_codex_catalog_command(executable)?;
        Ok(CodexCliProbeOutput {
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

#[derive(Debug, Clone)]
pub(super) struct CodexCliEnvironment {
    path: Option<OsString>,
    path_extensions: Option<OsString>,
    codex_home: Option<OsString>,
    home: Option<OsString>,
    user_profile: Option<OsString>,
}

impl CodexCliEnvironment {
    pub(super) fn capture() -> Self {
        Self {
            path: std::env::var_os("PATH"),
            path_extensions: std::env::var_os("PATHEXT"),
            codex_home: std::env::var_os("CODEX_HOME"),
            home: std::env::var_os("HOME"),
            user_profile: std::env::var_os("USERPROFILE"),
        }
    }

    #[cfg(test)]
    fn empty() -> Self {
        Self {
            path: None,
            path_extensions: None,
            codex_home: None,
            home: None,
            user_profile: None,
        }
    }
}

pub(super) fn inspect_codex_cli_configuration(
    configured_path: Option<&str>,
    environment: &CodexCliEnvironment,
) -> CodexCliConfiguration {
    let configured_path = configured_path
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let resolution_source = if configured_path.is_some() {
        CodexCliResolutionSource::Explicit
    } else {
        CodexCliResolutionSource::Environment
    };
    let configuration_directory =
        if resolve_configuration_directory(environment).is_some_and(|path| path.is_dir()) {
            CodexCliFactStatus::Confirmed
        } else {
            CodexCliFactStatus::Unavailable
        };
    let (executable_resolution, command_runtime, error) =
        match resolve_codex_cli(configured_path, environment) {
            Ok(_) => (
                CodexCliFactStatus::Confirmed,
                CodexCliFactStatus::Unchecked,
                None,
            ),
            Err(CodexCliResolutionError::ConfiguredPathInvalid) => (
                CodexCliFactStatus::Unavailable,
                CodexCliFactStatus::Unavailable,
                Some(AgentPluginCatalogErrorKind::ConfiguredPathInvalid),
            ),
            Err(CodexCliResolutionError::NotRunnable) => (
                CodexCliFactStatus::Confirmed,
                CodexCliFactStatus::Unavailable,
                Some(AgentPluginCatalogErrorKind::CliNotRunnable),
            ),
            Err(CodexCliResolutionError::Unavailable) => (
                CodexCliFactStatus::Unavailable,
                CodexCliFactStatus::Unavailable,
                Some(AgentPluginCatalogErrorKind::CliUnavailable),
            ),
        };
    CodexCliConfiguration {
        resolution_source,
        configured_path: configured_path.map(ToOwned::to_owned),
        facts: CodexCliFacts {
            configuration_directory,
            executable_resolution,
            command_runtime,
            plugin_json_contract: CodexCliFactStatus::Unchecked,
        },
        error,
    }
}

pub(super) fn validate_codex_cli_path_with(
    path: &str,
    environment: &CodexCliEnvironment,
    probe: &dyn CodexCliProbe,
) -> CodexCliConfiguration {
    if path.trim().is_empty() {
        let mut configuration = inspect_codex_cli_configuration(None, environment);
        configuration.resolution_source = CodexCliResolutionSource::Explicit;
        configuration.configured_path = Some(String::new());
        configuration.facts.executable_resolution = CodexCliFactStatus::Unavailable;
        configuration.facts.command_runtime = CodexCliFactStatus::Unavailable;
        configuration.error = Some(AgentPluginCatalogErrorKind::ConfiguredPathInvalid);
        return configuration;
    }
    let mut configuration = inspect_codex_cli_configuration(Some(path), environment);
    let Ok(resolved) = resolve_codex_cli(Some(path), environment) else {
        return configuration;
    };

    match probe.run_catalog(&resolved.path) {
        Ok(output) => {
            configuration.facts.command_runtime = CodexCliFactStatus::Confirmed;
            match codex::classify_completed_output(
                output.success,
                output.exit_code,
                output.stdout,
                &output.stderr,
            ) {
                Ok(command_output) => match validate_catalog_contract(&command_output.stdout) {
                    Ok(()) => {
                        configuration.facts.plugin_json_contract = CodexCliFactStatus::Confirmed;
                        configuration.error = None;
                    }
                    Err(error) => {
                        configuration.facts.plugin_json_contract = CodexCliFactStatus::Unavailable;
                        configuration.error = Some(error.kind);
                    }
                },
                Err(error) => {
                    configuration.facts.plugin_json_contract = match error.kind {
                        AgentPluginCatalogErrorKind::CommandUnsupported => {
                            CodexCliFactStatus::Unavailable
                        }
                        _ => CodexCliFactStatus::Unchecked,
                    };
                    configuration.error = Some(error.kind);
                }
            }
        }
        Err(ProcessError::SpawnFailed(_)) => {
            configuration.facts.command_runtime = CodexCliFactStatus::Unavailable;
            configuration.error = Some(AgentPluginCatalogErrorKind::CliNotRunnable);
        }
        Err(ProcessError::TimedOut { .. }) => {
            configuration.facts.command_runtime = CodexCliFactStatus::Confirmed;
            configuration.error = Some(AgentPluginCatalogErrorKind::TimedOut);
        }
        Err(_) => {
            configuration.facts.command_runtime = CodexCliFactStatus::Confirmed;
            configuration.error = Some(AgentPluginCatalogErrorKind::Internal);
        }
    }
    configuration
}

pub(super) fn save_codex_cli_path_with(
    store: &SkillStore,
    path: &str,
    environment: &CodexCliEnvironment,
    probe: &dyn CodexCliProbe,
) -> Result<CodexCliConfiguration> {
    let configuration = validate_codex_cli_path_with(path, environment, probe);
    if configuration.error.is_none() {
        let rechecked = inspect_codex_cli_configuration(Some(path), environment);
        if rechecked.error.is_some() {
            return Ok(rechecked);
        }
        store.set_setting(CODEX_CLI_PATH_SETTING_KEY, path.trim())?;
    }
    Ok(configuration)
}

pub(super) fn reset_codex_cli_path_with_environment(
    store: &SkillStore,
    environment: &CodexCliEnvironment,
) -> Result<CodexCliConfiguration> {
    store.set_setting(CODEX_CLI_PATH_SETTING_KEY, "")?;
    Ok(inspect_codex_cli_configuration(None, environment))
}

pub fn get_codex_cli_configuration(store: &SkillStore) -> Result<CodexCliConfiguration> {
    let configured_path = store.get_setting(CODEX_CLI_PATH_SETTING_KEY)?;
    Ok(inspect_codex_cli_configuration(
        configured_path.as_deref(),
        &CodexCliEnvironment::capture(),
    ))
}

pub fn validate_codex_cli_path(path: &str) -> CodexCliConfiguration {
    validate_codex_cli_path_with(path, &CodexCliEnvironment::capture(), &ProcessCodexCliProbe)
}

pub fn save_codex_cli_path(store: &SkillStore, path: &str) -> Result<CodexCliConfiguration> {
    save_codex_cli_path_with(
        store,
        path,
        &CodexCliEnvironment::capture(),
        &ProcessCodexCliProbe,
    )
}

pub fn reset_codex_cli_path(store: &SkillStore) -> Result<CodexCliConfiguration> {
    reset_codex_cli_path_with_environment(store, &CodexCliEnvironment::capture())
}

fn resolve_configuration_directory(environment: &CodexCliEnvironment) -> Option<PathBuf> {
    environment
        .codex_home
        .as_ref()
        .map(PathBuf::from)
        .or_else(|| {
            environment
                .home
                .as_ref()
                .or(environment.user_profile.as_ref())
                .map(|home| PathBuf::from(home).join(".codex"))
        })
}

pub(super) fn resolve_codex_cli(
    configured_path: Option<&str>,
    environment: &CodexCliEnvironment,
) -> Result<ResolvedCodexCli, CodexCliResolutionError> {
    if let Some(path) = configured_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let path = PathBuf::from(path);
        validate_explicit_path(&path)?;
        return Ok(ResolvedCodexCli {
            path,
            source: CodexCliResolutionSource::Explicit,
        });
    }

    let executable = environment
        .path
        .as_ref()
        .into_iter()
        .flat_map(|path| std::env::split_paths(path))
        .chain(user_installation_directory(environment))
        .flat_map(|directory| {
            executable_candidates(directory, environment.path_extensions.as_ref())
        })
        .find(|candidate| is_executable_file(candidate))
        .ok_or(CodexCliResolutionError::Unavailable)?;
    Ok(ResolvedCodexCli {
        path: executable,
        source: CodexCliResolutionSource::Environment,
    })
}

fn user_installation_directory(environment: &CodexCliEnvironment) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        // Finder 启动的桌面进程可能没有用户安装目录，仍优先保留 PATH 的选择。
        environment
            .home
            .as_ref()
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .map(|home| home.join(".local/bin"))
    }
    #[cfg(not(unix))]
    {
        let _ = environment;
        None
    }
}

fn validate_explicit_path(path: &Path) -> Result<(), CodexCliResolutionError> {
    if !path.is_absolute() {
        return Err(CodexCliResolutionError::ConfiguredPathInvalid);
    }
    let metadata = path
        .metadata()
        .map_err(|_| CodexCliResolutionError::ConfiguredPathInvalid)?;
    if !metadata.is_file() {
        return Err(CodexCliResolutionError::ConfiguredPathInvalid);
    }
    if !has_executable_permission(&metadata) {
        return Err(CodexCliResolutionError::NotRunnable);
    }
    Ok(())
}

pub(super) fn revalidate_resolved_codex_cli(
    resolved: &ResolvedCodexCli,
) -> Result<(), CodexCliResolutionError> {
    match validate_explicit_path(&resolved.path) {
        Ok(()) => Ok(()),
        Err(error) if resolved.source == CodexCliResolutionSource::Explicit => Err(error),
        Err(_) => Err(CodexCliResolutionError::Unavailable),
    }
}

fn is_executable_file(path: &Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.is_file() && has_executable_permission(&metadata))
        .unwrap_or(false)
}

#[cfg(unix)]
fn has_executable_permission(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_executable_permission(_metadata: &std::fs::Metadata) -> bool {
    true
}

fn executable_candidates(directory: PathBuf, path_extensions: Option<&OsString>) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let extensions = path_extensions
            .map(|value| {
                value
                    .to_string_lossy()
                    .split(';')
                    .filter(|extension| !extension.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|extensions| !extensions.is_empty())
            .unwrap_or_else(|| vec![".COM".into(), ".EXE".into()]);
        let mut candidates = Vec::with_capacity(extensions.len() + 1);
        candidates.push(directory.join("codex"));
        candidates.extend(
            extensions
                .into_iter()
                .map(|extension| directory.join(format!("codex{extension}"))),
        );
        candidates
    }
    #[cfg(not(windows))]
    {
        let _ = path_extensions;
        vec![directory.join("codex")]
    }
}

pub(super) fn allowed_environment() -> Vec<(OsString, OsString)> {
    const KEYS: &[&str] = &[
        "HOME",
        "PATH",
        "PATHEXT",
        "USERPROFILE",
        "CODEX_HOME",
        "XDG_CONFIG_HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "SYSTEMROOT",
        "TMPDIR",
        "TMP",
        "TEMP",
    ];
    KEYS.iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

#[cfg(test)]
mod tests;
