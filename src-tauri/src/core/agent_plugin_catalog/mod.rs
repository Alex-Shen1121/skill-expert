//! 从 Agent 官方状态生成只读插件目录投影。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(debug_assertions)]
mod acceptance;
mod codex;
mod codex_cli;
mod manifest;

pub use codex_cli::{
    get_codex_cli_configuration, reset_codex_cli_path, save_codex_cli_path,
    validate_codex_cli_path, CodexCliConfiguration, CodexCliFactStatus, CodexCliFacts,
    CodexCliResolutionSource, CODEX_CLI_PATH_SETTING_KEY,
};

/// 首版支持读取插件目录的 Agent。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPluginAgent {
    Codex,
}

/// 不会因展示名称相同而合并的 Agent 插件身份。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
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

/// 插件认证策略只表达可能发生认证的阶段，不代表已经授权。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPluginAuthPolicy {
    OnInstall,
    OnUse,
    None,
}

/// 插件内置 Skill 的安全展示摘要。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentPluginSkill {
    pub name: String,
    pub description: Option<String>,
}

/// manifest 补充资料的可信读取程度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPluginDetailsCompleteness {
    Complete,
    Incomplete,
}

/// 不包含底层路径、命令输出或秘密值的详情降级原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPluginDetailsIssue {
    PluginRootUnavailable,
    ManifestMissing,
    ManifestInvalid,
    ManifestIncompatible,
    ResourceRejected,
    ComponentUnreadable,
}

/// 默认折叠展示的收敛技术信息。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct AgentPluginTechnicalDetails {
    pub source_type: Option<String>,
    pub location: Option<String>,
}

/// manifest 只能补充的展示资料和明确声明的插件内置能力。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentPluginDetails {
    pub description: Option<String>,
    pub developer: Option<String>,
    pub category: Option<String>,
    pub default_prompts: Vec<String>,
    pub declared_capabilities: Vec<String>,
    pub skills: Vec<AgentPluginSkill>,
    pub mcp_servers: Vec<String>,
    pub hook_events: Vec<String>,
    pub connectors: Vec<String>,
    pub browser_extensions: Vec<String>,
    pub custom_ui: Vec<String>,
    pub icon_data_url: Option<String>,
    pub icon_url: Option<String>,
    pub screenshot_data_urls: Vec<String>,
    pub completeness: AgentPluginDetailsCompleteness,
    pub issues: Vec<AgentPluginDetailsIssue>,
    pub technical: AgentPluginTechnicalDetails,
}

impl Default for AgentPluginDetails {
    fn default() -> Self {
        Self {
            description: None,
            developer: None,
            category: None,
            default_prompts: Vec::new(),
            declared_capabilities: Vec::new(),
            skills: Vec::new(),
            mcp_servers: Vec::new(),
            hook_events: Vec::new(),
            connectors: Vec::new(),
            browser_extensions: Vec::new(),
            custom_ui: Vec::new(),
            icon_data_url: None,
            icon_url: None,
            screenshot_data_urls: Vec::new(),
            completeness: AgentPluginDetailsCompleteness::Incomplete,
            issues: vec![AgentPluginDetailsIssue::PluginRootUnavailable],
            technical: AgentPluginTechnicalDetails::default(),
        }
    }
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
    pub auth_policy: Option<AgentPluginAuthPolicy>,
    pub details: AgentPluginDetails,
}

/// 插件目录读取失败的稳定分类；不会包含未经清理的命令输出。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPluginCatalogErrorKind {
    CliUnavailable,
    ConfiguredPathInvalid,
    CliNotRunnable,
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

/// 一次读取的插件状态投影。失败分支不保留旧集合冒充当前状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "read_status", rename_all = "snake_case")]
pub enum AgentPluginProjection {
    Ready {
        agent: AgentPluginAgent,
        refreshed_at_unix_ms: u64,
        installed_complete: bool,
        available_complete: bool,
        installed: Vec<AgentPluginSummary>,
        available: Vec<AgentPluginSummary>,
    },
    Error {
        agent: AgentPluginAgent,
        refreshed_at_unix_ms: u64,
        error: AgentPluginCatalogError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "read_status", rename_all = "snake_case")]
pub enum AgentPluginDetailsProjection {
    Ready {
        identity: AgentPluginIdentity,
        details: Box<AgentPluginDetails>,
    },
    Error {
        identity: AgentPluginIdentity,
        error: AgentPluginCatalogError,
    },
}

#[derive(Debug)]
struct CatalogCommandOutput {
    stdout: Vec<u8>,
}

trait CatalogAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError>;

    fn read_installed(&self) -> Option<Result<Vec<u8>, AgentPluginCatalogError>> {
        None
    }
}

/// 按 Agent 生成当前内存态插件状态投影的唯一公开行为接口。
pub fn get_agent_plugin_projection(
    agent: AgentPluginAgent,
    configured_cli_path: Option<&str>,
) -> AgentPluginProjection {
    let adapter = codex::CodexCatalogAdapter::from_configured_path(configured_cli_path);
    get_agent_plugin_projection_with_adapter(agent, &adapter)
}

/// 按身份读取单个插件的完整详情；失败只影响当前详情面板。
pub fn get_agent_plugin_details(
    identity: AgentPluginIdentity,
    configured_cli_path: Option<&str>,
) -> AgentPluginDetailsProjection {
    let result = codex::read_plugin_details(configured_cli_path, &identity)
        .and_then(|response| parse_app_server_details(&identity, &response));
    match result {
        Ok(details) => AgentPluginDetailsProjection::Ready {
            identity,
            details: Box::new(details),
        },
        Err(error) => AgentPluginDetailsProjection::Error { identity, error },
    }
}

fn get_agent_plugin_projection_with_adapter(
    agent: AgentPluginAgent,
    adapter: &dyn CatalogAdapter,
) -> AgentPluginProjection {
    let refreshed_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default();
    let cli = adapter.read().and_then(|output| {
        parse_projection(agent, &output.stdout)
            .map(|(installed, available)| (output.stdout, installed, available))
    });
    let app_server = adapter.read_installed().map(|result| {
        result.and_then(|response| {
            parse_app_server_installed(agent, &response)
                .map(|(installed, complete)| (response, installed, complete))
        })
    });
    let result = match (cli, app_server) {
        (
            Ok((catalog, cli_installed, available)),
            Some(Ok((installed_response, mut installed, installed_complete))),
        ) => {
            supplement_matching_local_details(&mut installed, &cli_installed);
            if !installed_complete {
                append_missing_identities(&mut installed, cli_installed);
            }
            Ok((
                installed,
                available,
                installed_complete,
                true,
                Some(catalog),
                Some(installed_response),
            ))
        }
        (Ok((catalog, installed, available)), Some(Err(_))) => {
            Ok((installed, available, false, true, Some(catalog), None))
        }
        (Ok((catalog, installed, available)), None) => {
            Ok((installed, available, true, true, Some(catalog), None))
        }
        (Err(_), Some(Ok((installed_response, installed, installed_complete)))) => Ok((
            installed,
            Vec::new(),
            installed_complete,
            false,
            None,
            Some(installed_response),
        )),
        (Err(error), Some(Err(_)) | None) => Err(error),
    };

    match result {
        Ok((
            installed,
            available,
            installed_complete,
            available_complete,
            catalog_evidence,
            installed_evidence,
        )) => {
            #[cfg(debug_assertions)]
            if let Some(catalog) = catalog_evidence.as_deref() {
                if let Err(error) = acceptance::record_identity_evidence(
                    catalog,
                    installed_evidence.as_deref(),
                    &installed,
                    &available,
                ) {
                    log::warn!("插件验收身份摘要未写入：{error}");
                }
            }
            AgentPluginProjection::Ready {
                agent,
                refreshed_at_unix_ms,
                installed_complete,
                available_complete,
                installed,
                available,
            }
        }
        Err(error) => AgentPluginProjection::Error {
            agent,
            refreshed_at_unix_ms,
            error,
        },
    }
}

fn supplement_matching_local_details(
    installed: &mut [AgentPluginSummary],
    local: &[AgentPluginSummary],
) {
    for plugin in installed {
        if plugin.details.technical.source_type.as_deref() == Some("remote") {
            continue;
        }
        if let Some(local) = local
            .iter()
            .find(|candidate| candidate.identity == plugin.identity)
        {
            plugin.details = local.details.clone();
        }
    }
}

fn append_missing_identities(
    installed: &mut Vec<AgentPluginSummary>,
    fallback: Vec<AgentPluginSummary>,
) {
    let mut identities = installed
        .iter()
        .map(|plugin| plugin.identity.clone())
        .collect::<HashSet<_>>();
    installed.extend(
        fallback
            .into_iter()
            .filter(|plugin| identities.insert(plugin.identity.clone())),
    );
}

fn parse_app_server_installed(
    agent: AgentPluginAgent,
    response: &[u8],
) -> Result<(Vec<AgentPluginSummary>, bool), AgentPluginCatalogError> {
    let value: Value = serde_json::from_slice(response)
        .map_err(|_| catalog_error(AgentPluginCatalogErrorKind::InvalidJson, None))?;
    let object = value.as_object().ok_or_else(contract_incompatible)?;
    let marketplaces = required_array(object, "marketplaces")?;
    let load_errors = required_array(object, "marketplaceLoadErrors")?;
    let mut identities = HashSet::new();
    let mut installed = Vec::new();

    for marketplace in marketplaces {
        let marketplace = marketplace.as_object().ok_or_else(contract_incompatible)?;
        let marketplace_name = required_non_empty_string(marketplace, "name")?;
        for plugin in required_array(marketplace, "plugins")? {
            let plugin = plugin.as_object().ok_or_else(contract_incompatible)?;
            if !required_bool(plugin, "installed")? {
                return Err(contract_incompatible());
            }
            let enabled = required_bool(plugin, "enabled")?;
            let identity = AgentPluginIdentity {
                agent,
                marketplace_name: marketplace_name.clone(),
                plugin_id: required_non_empty_string(plugin, "id")?,
            };
            if !identities.insert(identity.clone()) {
                return Err(contract_incompatible());
            }
            let plugin_name = required_non_empty_string(plugin, "name")?;
            let interface = optional_object(plugin, "interface")?;
            let display_name = interface
                .map(|value| optional_non_empty_string(value, "displayName"))
                .transpose()?
                .flatten()
                .unwrap_or(plugin_name);
            let source_type = plugin
                .get("source")
                .and_then(Value::as_object)
                .and_then(|source| source.get("type"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(contract_incompatible)?;
            let details = app_server_summary_details(interface, source_type)?;
            installed.push(AgentPluginSummary {
                identity,
                display_name,
                version: optional_string(plugin, "localVersion")?
                    .or(optional_string(plugin, "version")?),
                install_status: if enabled {
                    AgentPluginInstallStatus::InstalledEnabled
                } else {
                    AgentPluginInstallStatus::InstalledDisabled
                },
                update_available: None,
                install_policy: optional_string(plugin, "installPolicy")?,
                auth_policy: parse_auth_policy(plugin),
                details,
            });
        }
    }
    Ok((installed, load_errors.is_empty()))
}

fn app_server_summary_details(
    interface: Option<&Map<String, Value>>,
    source_type: String,
) -> Result<AgentPluginDetails, AgentPluginCatalogError> {
    let description = match interface {
        Some(interface) => optional_non_empty_string(interface, "longDescription")?
            .or(optional_non_empty_string(interface, "shortDescription")?),
        None => None,
    };
    let developer = interface
        .map(|value| optional_non_empty_string(value, "developerName"))
        .transpose()?
        .flatten();
    let category = interface
        .map(|value| optional_non_empty_string(value, "category"))
        .transpose()?
        .flatten();
    let default_prompts = interface
        .map(|value| optional_string_array(value, "defaultPrompt"))
        .transpose()?
        .flatten()
        .unwrap_or_default();
    let declared_capabilities = interface
        .map(|value| optional_string_array(value, "capabilities"))
        .transpose()?
        .flatten()
        .unwrap_or_default();
    let icon_url = interface
        .map(|value| {
            optional_https_url(value, "composerIconUrl")?
                .map_or_else(|| optional_https_url(value, "logoUrl"), |url| Ok(Some(url)))
        })
        .transpose()?
        .flatten();

    Ok(AgentPluginDetails {
        description,
        developer,
        category,
        default_prompts,
        declared_capabilities,
        icon_url,
        issues: vec![AgentPluginDetailsIssue::ComponentUnreadable],
        technical: AgentPluginTechnicalDetails {
            source_type: Some(source_type),
            location: None,
        },
        ..AgentPluginDetails::default()
    })
}

fn parse_app_server_details(
    identity: &AgentPluginIdentity,
    response: &[u8],
) -> Result<AgentPluginDetails, AgentPluginCatalogError> {
    let value: Value = serde_json::from_slice(response)
        .map_err(|_| catalog_error(AgentPluginCatalogErrorKind::InvalidJson, None))?;
    let root = value.as_object().ok_or_else(contract_incompatible)?;
    let plugin = root
        .get("plugin")
        .and_then(Value::as_object)
        .ok_or_else(contract_incompatible)?;
    if required_non_empty_string(plugin, "marketplaceName")? != identity.marketplace_name {
        return Err(contract_incompatible());
    }
    let summary = plugin
        .get("summary")
        .and_then(Value::as_object)
        .ok_or_else(contract_incompatible)?;
    if required_non_empty_string(summary, "id")? != identity.plugin_id {
        return Err(contract_incompatible());
    }
    let source_type = summary
        .get("source")
        .and_then(Value::as_object)
        .and_then(|source| source.get("type"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(contract_incompatible)?;
    let interface = optional_object(summary, "interface")?;
    let mut details = app_server_summary_details(interface, source_type)?;
    details.description = optional_non_empty_string(plugin, "description")?.or(details.description);
    details.skills = required_array(plugin, "skills")?
        .iter()
        .map(|skill| {
            let skill = skill.as_object().ok_or_else(contract_incompatible)?;
            Ok(AgentPluginSkill {
                name: required_non_empty_string(skill, "name")?,
                description: optional_non_empty_string(skill, "description")?,
            })
        })
        .collect::<Result<_, AgentPluginCatalogError>>()?;
    details.hook_events = required_array(plugin, "hooks")?
        .iter()
        .map(|hook| {
            hook.as_object()
                .ok_or_else(contract_incompatible)
                .and_then(|hook| required_non_empty_string(hook, "eventName"))
        })
        .collect::<Result<_, _>>()?;
    details.connectors = required_array(plugin, "apps")?
        .iter()
        .map(|app| {
            app.as_object()
                .ok_or_else(contract_incompatible)
                .and_then(|app| required_non_empty_string(app, "name"))
        })
        .collect::<Result<_, _>>()?;
    details.mcp_servers = required_array(plugin, "mcpServers")?
        .iter()
        .map(|server| {
            server
                .as_str()
                .filter(|server| !server.trim().is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(contract_incompatible)
        })
        .collect::<Result<_, _>>()?;
    details.completeness = AgentPluginDetailsCompleteness::Complete;
    details.issues.clear();
    Ok(details)
}

fn optional_object<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<Option<&'a Map<String, Value>>, AgentPluginCatalogError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(value)) => Ok(Some(value)),
        Some(_) => Err(contract_incompatible()),
    }
}

fn optional_non_empty_string(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, AgentPluginCatalogError> {
    Ok(optional_string(object, field)?.filter(|value| !value.trim().is_empty()))
}

fn optional_string_array(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<Vec<String>>, AgentPluginCatalogError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(ToOwned::to_owned)
                    .ok_or_else(contract_incompatible)
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(contract_incompatible()),
    }
}

fn optional_https_url(
    object: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, AgentPluginCatalogError> {
    Ok(optional_non_empty_string(object, field)?.filter(|value| value.starts_with("https://")))
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
            let cli_display_name = optional_string(object, "name")?
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| identity.plugin_id.clone());
            let (display_name, details) = manifest::enrich_from_manifest(object, cli_display_name);
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
                auth_policy: parse_auth_policy(object),
                details,
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

fn parse_auth_policy(object: &Map<String, Value>) -> Option<AgentPluginAuthPolicy> {
    match object.get("authPolicy").and_then(Value::as_str) {
        Some("ON_INSTALL") => Some(AgentPluginAuthPolicy::OnInstall),
        Some("ON_USE") => Some(AgentPluginAuthPolicy::OnUse),
        Some("NONE") => Some(AgentPluginAuthPolicy::None),
        _ => None,
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

fn validate_catalog_contract(stdout: &[u8]) -> Result<(), AgentPluginCatalogError> {
    parse_projection(AgentPluginAgent::Codex, stdout).map(|_| ())
}

#[cfg(test)]
mod tests;
