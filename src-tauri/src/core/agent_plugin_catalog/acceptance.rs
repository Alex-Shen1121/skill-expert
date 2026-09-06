use super::AgentPluginSummary;
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Debug, Serialize)]
pub(super) struct IdentityCollectionEvidence {
    pub(super) raw_count: usize,
    pub(super) projected_count: usize,
    pub(super) raw_sha256: String,
    pub(super) projected_sha256: String,
    pub(super) identities_match: bool,
}

#[derive(Debug, Serialize)]
pub(super) struct IdentityEvidence {
    pub(super) installed_source: &'static str,
    pub(super) installed: IdentityCollectionEvidence,
    pub(super) available: IdentityCollectionEvidence,
    pub(super) all_collections_match: bool,
    pub(super) github_projected: bool,
    pub(super) vercel_projected: bool,
}

pub(super) fn build_identity_evidence(
    catalog_stdout: &[u8],
    installed_response: Option<&[u8]>,
    installed: &[AgentPluginSummary],
    available: &[AgentPluginSummary],
) -> Result<IdentityEvidence> {
    let value: Value = serde_json::from_slice(catalog_stdout).context("无法解析验收 CLI 快照")?;
    let (mut raw_installed, installed_source) = match installed_response {
        Some(response) => (app_server_installed_identities(response)?, "app_server"),
        None => (raw_identities(&value, "installed")?, "cli"),
    };
    let mut raw_available = raw_identities(&value, "available")?;
    raw_installed.sort();
    raw_available.sort();
    let mut projected_installed = projected_identities(installed);
    let mut projected_available = projected_identities(available);
    projected_installed.sort();
    projected_available.sort();
    let installed = compare_identity_collection(&raw_installed, &projected_installed);
    let available = compare_identity_collection(&raw_available, &projected_available);
    let all_collections_match = installed.identities_match && available.identities_match;
    let github_projected = projected_contains(&projected_installed, "github@openai-curated-remote");
    let vercel_projected = projected_contains(&projected_installed, "vercel@openai-curated-remote");

    Ok(IdentityEvidence {
        installed_source,
        installed,
        available,
        all_collections_match,
        github_projected,
        vercel_projected,
    })
}

fn projected_contains(rows: &[String], plugin_id: &str) -> bool {
    rows.iter()
        .any(|row| row.ends_with(&format!("\0{plugin_id}")))
}

fn compare_identity_collection(raw: &[String], projected: &[String]) -> IdentityCollectionEvidence {
    IdentityCollectionEvidence {
        raw_count: raw.len(),
        projected_count: projected.len(),
        raw_sha256: hash_rows(raw),
        projected_sha256: hash_rows(projected),
        identities_match: raw == projected,
    }
}

pub(super) fn record_identity_evidence(
    catalog_stdout: &[u8],
    installed_response: Option<&[u8]>,
    installed: &[AgentPluginSummary],
    available: &[AgentPluginSummary],
) -> Result<()> {
    let Some(root) = std::env::var_os("SKILL_EXPERT_ACCEPTANCE_ROOT") else {
        return Ok(());
    };
    let root = PathBuf::from(root);
    anyhow::ensure!(root.is_absolute(), "验收状态根必须是绝对路径");
    let evidence =
        build_identity_evidence(catalog_stdout, installed_response, installed, available)?;
    let directory = root.join("evidence");
    std::fs::create_dir_all(&directory)?;
    let target = directory.join("plugin-projection.json");
    let staged = directory.join(".plugin-projection.json.staged");
    std::fs::write(&staged, serde_json::to_vec_pretty(&evidence)?)?;
    std::fs::rename(&staged, &target)?;
    Ok(())
}

fn app_server_installed_identities(response: &[u8]) -> Result<Vec<String>> {
    let value: Value = serde_json::from_slice(response).context("无法解析验收 App Server 快照")?;
    let marketplaces = value
        .get("marketplaces")
        .and_then(Value::as_array)
        .context("App Server 快照缺少 Marketplace")?;
    let mut identities = Vec::new();
    for marketplace in marketplaces {
        let marketplace_name = marketplace
            .get("name")
            .and_then(Value::as_str)
            .context("App Server 快照缺少 Marketplace 名称")?;
        for plugin in marketplace
            .get("plugins")
            .and_then(Value::as_array)
            .context("App Server 快照缺少插件集合")?
        {
            let plugin_id = plugin
                .get("id")
                .and_then(Value::as_str)
                .context("App Server 快照缺少插件 ID")?;
            identities.push(format!("codex\0{marketplace_name}\0{plugin_id}"));
        }
    }
    Ok(identities)
}

fn raw_identities(value: &Value, field: &str) -> Result<Vec<String>> {
    let entries = value
        .get(field)
        .and_then(Value::as_array)
        .with_context(|| format!("CLI 快照缺少 {field}"))?;
    entries
        .iter()
        .map(|entry| {
            let marketplace = entry
                .get("marketplaceName")
                .and_then(Value::as_str)
                .context("CLI 快照缺少 Marketplace")?;
            let plugin_id = entry
                .get("pluginId")
                .and_then(Value::as_str)
                .context("CLI 快照缺少插件 ID")?;
            Ok(format!("codex\0{marketplace}\0{plugin_id}"))
        })
        .collect()
}

fn projected_identities(plugins: &[AgentPluginSummary]) -> Vec<String> {
    plugins
        .iter()
        .map(|plugin| {
            format!(
                "codex\0{}\0{}",
                plugin.identity.marketplace_name, plugin.identity.plugin_id
            )
        })
        .collect()
}

fn hash_rows(rows: &[String]) -> String {
    let mut hasher = Sha256::new();
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            hasher.update(b"\n");
        }
        hasher.update(row.as_bytes());
    }
    hex::encode(hasher.finalize())
}
