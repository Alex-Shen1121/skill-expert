use super::{
    catalog_error, AgentPluginCatalogError, AgentPluginCatalogErrorKind, CatalogAdapter,
    CatalogCommandOutput,
};
use crate::core::process_runner::{run_process, ProcessError, ProcessRequest};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub(super) struct CodexCatalogAdapter {
    executable: Option<PathBuf>,
}

impl CodexCatalogAdapter {
    pub(super) fn from_environment() -> Self {
        Self {
            executable: resolve_codex_executable(),
        }
    }

    #[cfg(test)]
    pub(super) fn with_executable(executable: PathBuf) -> Self {
        Self {
            executable: Some(executable),
        }
    }
}

impl CatalogAdapter for CodexCatalogAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
        let executable = self.executable.as_ref().ok_or_else(cli_unavailable)?;
        let request = ProcessRequest::new(
            executable,
            ["plugin", "list", "--available", "--json"]
                .into_iter()
                .map(OsString::from)
                .collect(),
            allowed_environment(),
        );
        let output = run_process(&request, None).map_err(classify_process_error)?;
        classify_completed_output(
            output.status.success(),
            output.status.code(),
            output.stdout,
            &output.stderr,
        )
    }
}

fn resolve_codex_executable() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(executable_candidates)
        .find(|candidate| is_executable_file(candidate))
}

fn executable_candidates(directory: PathBuf) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let extensions = std::env::var_os("PATHEXT")
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
        vec![directory.join("codex")]
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn allowed_environment() -> Vec<(OsString, OsString)> {
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

pub(super) fn classify_process_error(error: ProcessError) -> AgentPluginCatalogError {
    match error {
        ProcessError::SpawnFailed(_) => cli_unavailable(),
        ProcessError::TimedOut { .. } => catalog_error(AgentPluginCatalogErrorKind::TimedOut, None),
        _ => catalog_error(AgentPluginCatalogErrorKind::Internal, None),
    }
}

pub(super) fn classify_completed_output(
    success: bool,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: &[u8],
) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
    if success {
        return Ok(CatalogCommandOutput { stdout });
    }
    let stderr = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let unsupported = stderr.contains("unrecognized subcommand")
        || stderr.contains("unknown command")
        || stderr.contains("unexpected argument");
    let kind = if unsupported {
        AgentPluginCatalogErrorKind::CommandUnsupported
    } else {
        AgentPluginCatalogErrorKind::CommandFailed
    };
    Err(catalog_error(kind, exit_code))
}

fn cli_unavailable() -> AgentPluginCatalogError {
    catalog_error(AgentPluginCatalogErrorKind::CliUnavailable, None)
}
