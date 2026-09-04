use super::AgentPluginSummary;
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Debug, Serialize)]
pub(super) struct IdentityEvidence {
    pub(super) raw_installed: usize,
    pub(super) raw_available: usize,
    pub(super) projected_installed: usize,
    pub(super) projected_available: usize,
    pub(super) raw_identities_sha256: String,
    pub(super) projected_identities_sha256: String,
    pub(super) raw_installed_identities_sha256: String,
    pub(super) projected_installed_identities_sha256: String,
    pub(super) raw_available_identities_sha256: String,
    pub(super) projected_available_identities_sha256: String,
    pub(super) installed_identities_match: bool,
    pub(super) available_identities_match: bool,
    pub(super) identities_match: bool,
}

pub(super) fn build_identity_evidence(
    stdout: &[u8],
    installed: &[AgentPluginSummary],
    available: &[AgentPluginSummary],
) -> Result<IdentityEvidence> {
    let value: Value = serde_json::from_slice(stdout).context("无法解析验收 CLI 快照")?;
    let mut raw_installed = raw_identities(&value, "installed")?;
    let mut raw_available = raw_identities(&value, "available")?;
    raw_installed.sort();
    raw_available.sort();
    let mut raw_all = raw_installed.clone();
    raw_all.extend(raw_available.clone());
    raw_all.sort();

    let mut projected_installed = projected_identities(installed);
    let mut projected_available = projected_identities(available);
    projected_installed.sort();
    projected_available.sort();
    let mut projected_all = projected_installed.clone();
    projected_all.extend(projected_available.clone());
    projected_all.sort();

    Ok(IdentityEvidence {
        raw_installed: raw_installed.len(),
        raw_available: raw_available.len(),
        projected_installed: projected_installed.len(),
        projected_available: projected_available.len(),
        raw_identities_sha256: hash_rows(&raw_all),
        projected_identities_sha256: hash_rows(&projected_all),
        raw_installed_identities_sha256: hash_rows(&raw_installed),
        projected_installed_identities_sha256: hash_rows(&projected_installed),
        raw_available_identities_sha256: hash_rows(&raw_available),
        projected_available_identities_sha256: hash_rows(&projected_available),
        installed_identities_match: raw_installed == projected_installed,
        available_identities_match: raw_available == projected_available,
        identities_match: raw_installed == projected_installed
            && raw_available == projected_available,
    })
}

pub(super) fn record_identity_evidence(
    stdout: &[u8],
    installed: &[AgentPluginSummary],
    available: &[AgentPluginSummary],
) -> Result<()> {
    let Some(root) = std::env::var_os("SKILL_EXPERT_ACCEPTANCE_ROOT") else {
        return Ok(());
    };
    let root = PathBuf::from(root);
    anyhow::ensure!(root.is_absolute(), "验收状态根必须是绝对路径");
    let evidence = build_identity_evidence(stdout, installed, available)?;
    let directory = root.join("evidence");
    std::fs::create_dir_all(&directory)?;
    let target = directory.join("plugin-projection.json");
    let staged = directory.join(".plugin-projection.json.staged");
    std::fs::write(&staged, serde_json::to_vec_pretty(&evidence)?)?;
    std::fs::rename(&staged, &target)?;
    Ok(())
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
