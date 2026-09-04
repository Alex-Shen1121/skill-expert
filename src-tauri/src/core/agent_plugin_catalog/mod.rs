//! 从 Agent 官方状态生成只读插件目录投影。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

mod codex;

/// 首版支持读取插件目录的 Agent。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPluginAgent {
    Codex,
}

/// 不会因展示名称相同而合并的 Agent 插件身份。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct AgentPluginIdentity {
    pub agent: AgentPluginAgent,
    pub marketplace_name: String,
    pub plugin_id: String,
}

/// 仅由 Agent 官方状态确定的安装状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPluginInstallStatus {
    InstalledEnabled,
    InstalledDisabled,
    Available,
}

/// CLI 能够直接确认的 Agent 插件基础资料。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentPluginSummary {
    pub identity: AgentPluginIdentity,
    pub display_name: String,
    pub version: Option<String>,
    pub install_status: AgentPluginInstallStatus,
    pub update_available: Option<bool>,
    pub install_policy: Option<String>,
    pub auth_policy: Option<String>,
}

/// 插件目录读取失败的稳定分类；不会包含未经清理的命令输出。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPluginCatalogErrorKind {
    CliUnavailable,
    CommandUnsupported,
    TimedOut,
    CommandFailed,
    InvalidJson,
    ContractIncompatible,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentPluginCatalogError {
    pub kind: AgentPluginCatalogErrorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// 一次读取的完整状态投影。失败分支不保留旧集合冒充当前状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "read_status", rename_all = "snake_case")]
pub enum AgentPluginProjection {
    Ready {
        agent: AgentPluginAgent,
        refreshed_at_unix_ms: u64,
        installed: Vec<AgentPluginSummary>,
        available: Vec<AgentPluginSummary>,
    },
    Error {
        agent: AgentPluginAgent,
        refreshed_at_unix_ms: u64,
        error: AgentPluginCatalogError,
    },
}

#[derive(Debug)]
struct CatalogCommandOutput {
    stdout: Vec<u8>,
}

trait CatalogAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError>;
}

/// 按 Agent 生成当前内存态插件状态投影的唯一公开行为接口。
pub fn get_agent_plugin_projection(agent: AgentPluginAgent) -> AgentPluginProjection {
    let adapter = codex::CodexCatalogAdapter::from_environment();
    get_agent_plugin_projection_with_adapter(agent, &adapter)
}

fn get_agent_plugin_projection_with_adapter(
    agent: AgentPluginAgent,
    adapter: &dyn CatalogAdapter,
) -> AgentPluginProjection {
    let refreshed_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default();
    let result = adapter
        .read()
        .and_then(|output| parse_projection(agent, &output.stdout));

    match result {
        Ok((installed, available)) => AgentPluginProjection::Ready {
            agent,
            refreshed_at_unix_ms,
            installed,
            available,
        },
        Err(error) => AgentPluginProjection::Error {
            agent,
            refreshed_at_unix_ms,
            error,
        },
    }
}

fn parse_projection(
    agent: AgentPluginAgent,
    stdout: &[u8],
) -> Result<(Vec<AgentPluginSummary>, Vec<AgentPluginSummary>), AgentPluginCatalogError> {
    let value: Value = serde_json::from_slice(stdout)
        .map_err(|_| catalog_error(AgentPluginCatalogErrorKind::InvalidJson, None))?;
    let object = value.as_object().ok_or_else(contract_incompatible)?;
    let installed_values = required_array(object, "installed")?;
    let available_values = required_array(object, "available")?;
    let mut identities = HashSet::with_capacity(installed_values.len() + available_values.len());
    let installed = parse_collection(agent, installed_values, true, &mut identities)?;
    let available = parse_collection(agent, available_values, false, &mut identities)?;
    Ok((installed, available))
}

fn required_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Vec<Value>, AgentPluginCatalogError> {
    object
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(contract_incompatible)
}

fn parse_collection(
    agent: AgentPluginAgent,
    values: &[Value],
    expected_installed: bool,
    identities: &mut HashSet<AgentPluginIdentity>,
) -> Result<Vec<AgentPluginSummary>, AgentPluginCatalogError> {
    values
        .iter()
        .map(|value| {
            let object = value.as_object().ok_or_else(contract_incompatible)?;
            let plugin_id = required_non_empty_string(object, "pluginId")?;
            let marketplace_name = required_non_empty_string(object, "marketplaceName")?;
            let installed = required_bool(object, "installed")?;
            let enabled = required_bool(object, "enabled")?;
            if installed != expected_installed || (!installed && enabled) {
                return Err(contract_incompatible());
            }
            let identity = AgentPluginIdentity {
                agent,
                marketplace_name,
                plugin_id,
            };
            if !identities.insert(identity.clone()) {
                return Err(contract_incompatible());
            }
            let display_name = optional_string(object, "name")?
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| identity.plugin_id.clone());
            Ok(AgentPluginSummary {
                identity,
                display_name,
                version: optional_string(object, "version")?,
                install_status: match (installed, enabled) {
                    (true, true) => AgentPluginInstallStatus::InstalledEnabled,
                    (true, false) => AgentPluginInstallStatus::InstalledDisabled,
                    (false, false) => AgentPluginInstallStatus::Available,
                    (false, true) => unreachable!("已在上方拒绝不一致状态"),
                },
                update_available: optional_bool(object, "updateAvailable")?,
                install_policy: optional_string(object, "installPolicy")?,
                auth_policy: optional_string(object, "authPolicy")?,
            })
        })
        .collect()
}

fn required_non_empty_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<String, AgentPluginCatalogError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(contract_incompatible)
}

fn required_bool(
    object: &Map<String, Value>,
    field: &str,
) -> Result<bool, AgentPluginCatalogError> {
    object
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(contract_incompatible)
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, AgentPluginCatalogError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(contract_incompatible()),
    }
}

fn optional_bool(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<bool>, AgentPluginCatalogError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(contract_incompatible()),
    }
}

fn catalog_error(
    kind: AgentPluginCatalogErrorKind,
    exit_code: Option<i32>,
) -> AgentPluginCatalogError {
    AgentPluginCatalogError { kind, exit_code }
}

fn contract_incompatible() -> AgentPluginCatalogError {
    catalog_error(AgentPluginCatalogErrorKind::ContractIncompatible, None)
}

#[cfg(test)]
mod tests;
