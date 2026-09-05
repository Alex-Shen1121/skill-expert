#[cfg(test)]
use super::codex_cli::CodexCliResolutionSource;
use super::{
    catalog_error,
    codex_cli::{
        resolve_codex_cli, revalidate_resolved_codex_cli, run_codex_catalog_command,
        CodexCliEnvironment, CodexCliResolutionError, ResolvedCodexCli,
    },
    AgentPluginCatalogError, AgentPluginCatalogErrorKind, CatalogAdapter, CatalogCommandOutput,
};
use crate::core::process_runner::ProcessError;
#[cfg(test)]
use std::path::PathBuf;

pub(super) struct CodexCatalogAdapter {
    resolution: Result<ResolvedCodexCli, CodexCliResolutionError>,
}

impl CodexCatalogAdapter {
    pub(super) fn from_configured_path(configured_path: Option<&str>) -> Self {
        Self {
            resolution: resolve_codex_cli(configured_path, &CodexCliEnvironment::capture()),
        }
    }

    #[cfg(test)]
    pub(super) fn with_executable(executable: PathBuf) -> Self {
        Self {
            resolution: Ok(ResolvedCodexCli {
                path: executable,
                source: CodexCliResolutionSource::Environment,
            }),
        }
    }

    #[cfg(test)]
    pub(super) fn with_explicit_executable(executable: PathBuf) -> Self {
        Self {
            resolution: Ok(ResolvedCodexCli {
                path: executable,
                source: CodexCliResolutionSource::Explicit,
            }),
        }
    }
}

impl CatalogAdapter for CodexCatalogAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
        let resolved = self
            .resolution
            .as_ref()
            .map_err(|error| catalog_error(resolution_error_kind(*error), None))?;
        revalidate_resolved_codex_cli(resolved)
            .map_err(|error| catalog_error(resolution_error_kind(error), None))?;
        let output = run_codex_catalog_command(&resolved.path).map_err(classify_process_error)?;
        classify_completed_output(
            output.status.success(),
            output.status.code(),
            output.stdout,
            &output.stderr,
        )
    }
}

fn resolution_error_kind(error: CodexCliResolutionError) -> AgentPluginCatalogErrorKind {
    match error {
        CodexCliResolutionError::Unavailable => AgentPluginCatalogErrorKind::CliUnavailable,
        CodexCliResolutionError::ConfiguredPathInvalid => {
            AgentPluginCatalogErrorKind::ConfiguredPathInvalid
        }
        CodexCliResolutionError::NotRunnable => AgentPluginCatalogErrorKind::CliNotRunnable,
    }
}

pub(super) fn classify_process_error(error: ProcessError) -> AgentPluginCatalogError {
    match error {
        ProcessError::SpawnFailed(_) => {
            catalog_error(AgentPluginCatalogErrorKind::CliNotRunnable, None)
        }
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
