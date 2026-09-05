#[cfg(test)]
use super::codex_cli::CodexCliResolutionSource;
use super::{
    catalog_error,
    codex_cli::{
        allowed_environment, resolve_codex_cli, revalidate_resolved_codex_cli,
        run_codex_catalog_command, CodexCliEnvironment, CodexCliResolutionError, ResolvedCodexCli,
    },
    AgentPluginCatalogError, AgentPluginCatalogErrorKind, AgentPluginIdentity, CatalogAdapter,
    CatalogCommandOutput,
};
use crate::core::process_runner::{run_json_rpc_exchange, ProcessError, ProcessRequest};
use serde_json::Value;
use std::ffi::OsString;
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

pub(super) fn read_plugin_details(
    configured_cli_path: Option<&str>,
    identity: &AgentPluginIdentity,
) -> Result<Vec<u8>, AgentPluginCatalogError> {
    let suffix = format!("@{}", identity.marketplace_name);
    let plugin_name = identity
        .plugin_id
        .strip_suffix(&suffix)
        .filter(|name| !name.is_empty())
        .ok_or_else(super::contract_incompatible)?;
    let adapter = CodexCatalogAdapter::from_configured_path(configured_cli_path);
    let resolved = adapter.resolved()?;
    run_app_server_method(
        &resolved.path,
        "plugin/read",
        serde_json::json!({
            "remoteMarketplaceName": identity.marketplace_name,
            "pluginName": plugin_name
        }),
    )
}

impl CatalogAdapter for CodexCatalogAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
        let resolved = self.resolved()?;
        let output = run_codex_catalog_command(&resolved.path).map_err(classify_process_error)?;
        classify_completed_output(
            output.status.success(),
            output.status.code(),
            output.stdout,
            &output.stderr,
        )
    }

    fn read_installed(&self) -> Option<Result<Vec<u8>, AgentPluginCatalogError>> {
        Some(self.resolved().and_then(|resolved| {
            run_app_server_method(&resolved.path, "plugin/installed", serde_json::json!({}))
        }))
    }
}

impl CodexCatalogAdapter {
    fn resolved(&self) -> Result<&ResolvedCodexCli, AgentPluginCatalogError> {
        let resolved = self
            .resolution
            .as_ref()
            .map_err(|error| catalog_error(resolution_error_kind(*error), None))?;
        revalidate_resolved_codex_cli(resolved)
            .map_err(|error| catalog_error(resolution_error_kind(error), None))?;
        Ok(resolved)
    }
}

pub(super) fn run_app_server_method(
    executable: &std::path::Path,
    method: &str,
    params: Value,
) -> Result<Vec<u8>, AgentPluginCatalogError> {
    let process = ProcessRequest::new(
        executable,
        ["app-server", "--stdio"]
            .into_iter()
            .map(OsString::from)
            .collect(),
        allowed_environment(),
    );
    let initialize = serde_json::json!({
        "jsonrpc":"2.0",
        "id":1,
        "method":"initialize",
        "params":{
            "clientInfo":{
                "name":"agent-skills-manager",
                "title":"Agent 技能管家",
                "version":env!("CARGO_PKG_VERSION")
            },
            "capabilities":null
        }
    });
    let initialized = serde_json::json!({
        "jsonrpc":"2.0",
        "method":"initialized",
        "params":{}
    });
    let request = serde_json::json!({
        "jsonrpc":"2.0",
        "id":2,
        "method":method,
        "params":params
    });
    let response = run_json_rpc_exchange(&process, &initialize, &initialized, &request, None)
        .map_err(classify_process_error)?;
    let response: Value = serde_json::from_slice(&response)
        .map_err(|_| catalog_error(AgentPluginCatalogErrorKind::InvalidJson, None))?;
    if let Some(error) = response.get("error") {
        let unsupported = error.get("code").and_then(Value::as_i64) == Some(-32601);
        return Err(catalog_error(
            if unsupported {
                AgentPluginCatalogErrorKind::CommandUnsupported
            } else {
                AgentPluginCatalogErrorKind::CommandFailed
            },
            None,
        ));
    }
    serde_json::to_vec(
        response
            .get("result")
            .ok_or_else(super::contract_incompatible)?,
    )
    .map_err(|_| catalog_error(AgentPluginCatalogErrorKind::Internal, None))
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
