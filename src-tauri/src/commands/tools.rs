use serde::Serialize;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, State};

use crate::core::error::AppError;
use crate::core::scenario_service;
use crate::core::skill_store::SkillStore;
use crate::core::timing::should_log_first_or_slow;
use crate::core::tool_adapters::{self, CustomToolDef, ToolCategory};
use crate::core::tool_service::{
    self, get_disabled_tools, get_tool_order, normalize_project_relative_skills_dir_input,
    normalize_skills_dir_input, set_tool_order, ToolInfo,
};

#[derive(Debug, Serialize)]
pub struct ToolInfoDto {
    pub key: String,
    pub display_name: String,
    pub installed: bool,
    pub skills_dir: String,
    pub enabled: bool,
    pub is_custom: bool,
    pub has_path_override: bool,
    pub project_relative_skills_dir: Option<String>,
    pub has_project_path_override: bool,
    pub category: ToolCategory,
}

fn sync_active_scenario_to_tool(store: &SkillStore, tool_key: &str) -> Result<(), AppError> {
    scenario_service::sync_active_scenario_to_tool(store, tool_key)
}

fn unsync_all_for_tool(store: &SkillStore, tool_key: &str) -> Result<(), AppError> {
    scenario_service::remove_tool_targets(store, tool_key)?.require_complete()
}

fn reconcile_tool_sync_after_path_change(
    store: &SkillStore,
    tool_key: &str,
) -> Result<(), AppError> {
    let disabled = get_disabled_tools(store)?;
    if disabled.contains(&tool_key.to_string()) {
        unsync_all_for_tool(store, tool_key)?;
    } else {
        // 启用中的工具直接尝试新路径；场景同步会在新目标和记录都成功后
        // 才退休旧目标，拒绝或 I/O 失败时继续保留旧部署与旧记录。
        sync_active_scenario_to_tool(store, tool_key)?;
    }
    Ok(())
}

static GET_TOOL_STATUS_FIRST_CALL: AtomicBool = AtomicBool::new(true);

#[tauri::command]
pub async fn get_tool_status(
    store: State<'_, Arc<SkillStore>>,
) -> Result<Vec<ToolInfoDto>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        let infos = tool_service::list_tool_info(&store)?;
        let count = infos.len();
        let result: Vec<ToolInfoDto> = infos
            .into_iter()
            .map(|info: ToolInfo| ToolInfoDto {
                key: info.key,
                display_name: info.display_name,
                installed: info.installed,
                skills_dir: info.skills_dir,
                enabled: info.enabled,
                is_custom: info.is_custom,
                has_path_override: info.has_path_override,
                project_relative_skills_dir: info.project_relative_skills_dir,
                has_project_path_override: info.has_project_path_override,
                category: info.category,
            })
            .collect();
        let elapsed_ms = start.elapsed().as_millis();
        if should_log_first_or_slow(&GET_TOOL_STATUS_FIRST_CALL, elapsed_ms, 100) {
            log::info!("get_tool_status: {count} tools in {elapsed_ms} ms");
        }
        Ok(result)
    })
    .await?
}

fn refresh_tray_menu_best_effort(app: &AppHandle) {
    if let Err(err) = crate::refresh_tray_menu(app) {
        log::warn!("Failed to refresh tray menu after tool mutation: {err}");
    }
}

#[tauri::command]
pub async fn set_tool_enabled(
    app: AppHandle,
    key: String,
    enabled: bool,
    expected_duo: Option<ToolInfo>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _deployment = store.deployment_lock("enable Agent")?;
        if enabled && key == "gitlab_duo" {
            verify_visible_duo(&store, expected_duo.as_ref())?;
        }
        set_tool_enabled_internal(&store, &key, enabled)
    })
    .await?;
    if result.is_ok() {
        refresh_tray_menu_best_effort(&app);
    }
    result
}

fn verify_visible_duo(store: &SkillStore, expected: Option<&ToolInfo>) -> Result<(), AppError> {
    let current = tool_service::list_tool_info(store)?
        .into_iter()
        .find(|t| t.key == "gitlab_duo" && !t.is_custom && !t.enabled);
    if let Some(current) = current {
        if expected != Some(&current) {
            return Err(AppError::stale_snapshot());
        }
    }
    Ok(())
}

/// Shared GUI/CLI implementation for the global agent toggle.
pub fn set_tool_enabled_internal(
    store: &SkillStore,
    key: &str,
    enabled: bool,
) -> Result<(), AppError> {
    let _deployment = store.deployment_lock("set_tool_enabled_internal")?;
    if tool_adapters::find_adapter_with_store(store, key)?.is_none() {
        return Err(AppError::not_found(format!("Unknown agent: {key}")));
    }

    store.update_tool_config(|config| {
        if enabled {
            config.disabled.retain(|item| item != key);
        } else if !config.disabled.iter().any(|item| item == key) {
            config.disabled.push(key.to_string());
        }
        Ok(())
    })?;
    if enabled {
        sync_active_scenario_to_tool(store, key)?;
    } else {
        unsync_all_for_tool(store, key)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_all_tools_enabled(
    app: AppHandle,
    enabled: bool,
    expected_duo: Option<ToolInfo>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _deployment = store.deployment_lock("set_all_tools_enabled")?;
        if enabled {
            verify_visible_duo(&store, expected_duo.as_ref())?;
            store.update_tool_config(|config| {
                config.disabled.clear();
                Ok(())
            })?;
            let report = match store.get_active_scenario_id().map_err(AppError::db)? {
                Some(active_id) => {
                    let desired =
                        scenario_service::collect_scenario_sync_targets(&store, &active_id)?;
                    scenario_service::sync_desired_targets_report(&store, &desired)
                }
                None => scenario_service::DeploymentReport::not_run("no_active_preset"),
            };
            report.require_complete()
        } else {
            let adapters = tool_adapters::all_tool_adapters(&store)?;
            let all_keys: Vec<String> = adapters.iter().map(|a| a.key.clone()).collect();
            for adapter in &adapters {
                unsync_all_for_tool(&store, &adapter.key)?;
            }
            store.update_tool_config(|config| {
                config.disabled = all_keys;
                Ok(())
            })
        }
    })
    .await?;
    if result.is_ok() {
        refresh_tray_menu_best_effort(&app);
    }
    result
}

#[tauri::command]
pub async fn get_tool_order_cmd(
    store: State<'_, Arc<SkillStore>>,
) -> Result<Vec<String>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_tool_order(&store)).await?
}

#[tauri::command]
pub async fn set_tool_order_cmd(
    order: Vec<String>,
    expected: Vec<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || set_tool_order(&store, &order, &expected)).await?
}

/// Whether a built-in adapter claims this key. Resolution consults built-ins
/// before custom tools, so a key that answers `true` here must have its
/// overrides written to the side maps, never onto a custom tool definition.
fn is_builtin_key(key: &str) -> bool {
    tool_adapters::default_tool_adapters()
        .iter()
        .any(|a| a.key == key)
}

/// Store side of [`set_custom_tool_path`], separated so the write can be
/// tested against a real store without a Tauri runtime.
pub(crate) fn apply_tool_skills_dir(
    store: &SkillStore,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    let _deployment = store.deployment_lock("apply_tool_skills_dir")?;
    let key = key.trim().to_string();
    let path = normalize_skills_dir_input(path)?;
    if key.is_empty() || path.is_empty() {
        return Err(AppError::invalid_input("Key and path are required"));
    }

    let old_adapter = tool_adapters::find_adapter_with_store(store, &key)?
        .ok_or_else(|| AppError::not_found(format!("Unknown tool: {key}")))?;
    let old_skills_dir = old_adapter.skills_dir();

    store.update_tool_config(|config| {
        let adapter = tool_adapters::adapters_from_config(config)
            .into_iter()
            .find(|a| a.key == key)
            .ok_or_else(|| AppError::not_found("Agent no longer exists; refresh"))?;
        if adapter.is_custom {
            let custom = config
                .customs
                .iter_mut()
                .find(|c| c.key == key)
                .ok_or_else(|| AppError::not_found("Custom Agent no longer exists"))?;
            custom.skills_dir = path;
        } else {
            config.paths.insert(key.clone(), path);
        }
        Ok(())
    })?;

    let new_adapter = tool_adapters::find_adapter_with_store(store, &key)?
        .ok_or_else(|| AppError::not_found(format!("Unknown tool: {key}")))?;
    if old_skills_dir != new_adapter.skills_dir() {
        reconcile_tool_sync_after_path_change(store, &key)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_custom_tool_path(
    key: String,
    path: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || apply_tool_skills_dir(&store, &key, &path)).await?
}

#[tauri::command]
pub async fn reset_custom_tool_path(
    key: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _deployment = store.deployment_lock("reset_custom_tool_path")?;
        let old_adapter = tool_adapters::find_adapter_with_store(&store, &key)?
            .ok_or_else(|| AppError::not_found(format!("Unknown tool: {key}")))?;
        let old_skills_dir = old_adapter.skills_dir();

        store.update_tool_config(|config| {
            let adapter = tool_adapters::adapters_from_config(config)
                .into_iter()
                .find(|a| a.key == key)
                .ok_or_else(|| AppError::not_found("Unknown Agent"))?;
            if adapter.is_custom {
                return Err(AppError::invalid_input(
                    "Custom Agents have no built-in default",
                ));
            }
            config.paths.remove(&key);
            Ok(())
        })?;

        let new_adapter = tool_adapters::find_adapter_with_store(&store, &key)?
            .ok_or_else(|| AppError::not_found(format!("Unknown tool: {key}")))?;
        if old_skills_dir != new_adapter.skills_dir() {
            reconcile_tool_sync_after_path_change(&store, &key)?;
        }
        Ok(())
    })
    .await?
}

/// Store side of [`set_custom_tool_project_path`], separated so the write can
/// be tested against a real store without a Tauri runtime.
pub(crate) fn apply_tool_project_skills_dir(
    store: &SkillStore,
    key: &str,
    project_relative_skills_dir: Option<&str>,
) -> Result<(), AppError> {
    let _deployment = store.deployment_lock("apply_tool_project_skills_dir")?;
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err(AppError::invalid_input("Key is required"));
    }
    let normalized = normalize_project_relative_skills_dir_input(
        project_relative_skills_dir.unwrap_or_default(),
    )?;

    store.update_tool_config(|config| {
        let adapter = tool_adapters::adapters_from_config(config)
            .into_iter()
            .find(|a| a.key == key)
            .ok_or_else(|| AppError::not_found("Unknown Agent"))?;
        if adapter.is_custom {
            let custom = config
                .customs
                .iter_mut()
                .find(|c| c.key == key)
                .ok_or_else(|| AppError::not_found("Unknown custom Agent"))?;
            custom.project_relative_skills_dir = normalized;
        } else {
            let default = tool_adapters::find_adapter(&key)
                .ok_or_else(|| AppError::not_found("Unknown Agent"))?;
            match normalized {
                Some(path) if path != default.project_relative_skills_dir() => {
                    config.project_paths.insert(key, path);
                }
                _ => {
                    config.project_paths.remove(&key);
                }
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn set_custom_tool_project_path(
    key: String,
    project_relative_skills_dir: Option<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_tool_project_skills_dir(&store, &key, project_relative_skills_dir.as_deref())
    })
    .await?
}

#[tauri::command]
pub async fn reset_custom_tool_project_path(
    key: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _deployment = store.deployment_lock("reset_custom_tool_project_path")?;
        let key = key.trim().to_string();
        if key.is_empty() {
            return Err(AppError::invalid_input("Key is required"));
        }
        store.update_tool_config(|config| {
            let adapter = tool_adapters::adapters_from_config(config)
                .into_iter()
                .find(|a| a.key == key)
                .ok_or_else(|| AppError::not_found("Unknown Agent"))?;
            if adapter.is_custom {
                return Err(AppError::invalid_input(
                    "Custom Agents have no built-in default",
                ));
            }
            config.project_paths.remove(&key);
            Ok(())
        })
    })
    .await?
}

pub fn register_custom_definition(
    store: &SkillStore,
    mut definition: CustomToolDef,
) -> Result<CustomToolDef, AppError> {
    definition.key = definition.key.trim().to_string();
    definition.display_name = definition.display_name.trim().to_string();
    definition.skills_dir = normalize_skills_dir_input(&definition.skills_dir)?;
    definition.project_relative_skills_dir = normalize_project_relative_skills_dir_input(
        definition
            .project_relative_skills_dir
            .as_deref()
            .unwrap_or_default(),
    )?;
    if definition.key.is_empty() || definition.display_name.is_empty() {
        return Err(AppError::invalid_input("Agent key and name are required"));
    }
    store.update_tool_config(|config| {
        if is_builtin_key(&definition.key) || config.customs.iter().any(|c| c.key == definition.key)
        {
            return Err(AppError::invalid_input("Agent key already exists"));
        }
        config.customs.push(definition.clone());
        Ok(definition)
    })
}

#[derive(Serialize)]
pub struct RegistrationQuery {
    state: &'static str,
    tool: Option<ToolInfo>,
}

#[tauri::command]
pub async fn query_custom_tool(
    store: State<'_, Arc<SkillStore>>,
    mut definition: CustomToolDef,
) -> Result<RegistrationQuery, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        definition.key = definition.key.trim().to_string();
        definition.display_name = definition.display_name.trim().to_string();
        definition.skills_dir = normalize_skills_dir_input(&definition.skills_dir)?;
        definition.project_relative_skills_dir = normalize_project_relative_skills_dir_input(
            definition
                .project_relative_skills_dir
                .as_deref()
                .unwrap_or_default(),
        )?;
        let config = store.tool_config()?;
        let tool = tool_service::tool_info_from_config(&config)
            .into_iter()
            .find(|tool| tool.key == definition.key);
        let state = match config
            .customs
            .iter()
            .find(|custom| custom.key == definition.key)
        {
            Some(custom) if *custom == definition => "matches",
            Some(_) => "conflict",
            None if tool.is_some() => "conflict",
            None => "absent",
        };
        Ok(RegistrationQuery { state, tool })
    })
    .await?
}

#[derive(Debug, Serialize)]
pub struct RegistrationReceipt {
    pub registered: bool,
    pub definition: CustomToolDef,
    pub tool: Option<ToolInfo>,
    pub deployment: scenario_service::DeploymentReport,
}

pub fn register_custom_tool(
    store: &SkillStore,
    definition: CustomToolDef,
) -> Result<RegistrationReceipt, AppError> {
    let _deployment = store.deployment_lock("register Agent")?;
    let definition = register_custom_definition(store, definition)?;
    let mut deployment =
        scenario_service::sync_active_scenario_to_tool_report(store, &definition.key);
    let tool = match tool_service::list_tool_info(store) {
        Ok(infos) => infos.into_iter().find(|t| t.key == definition.key),
        Err(error) => {
            deployment.state = "unknown".into();
            deployment.issue(
                "read_tool_info",
                "READ_FAILED",
                Some(&definition.key),
                None,
                error,
            );
            None
        }
    };
    store.log_audit(
        crate::core::audit_log::AuditDraft::new("register_agent")
            .tool(definition.key.clone())
            .ok(),
    );
    Ok(RegistrationReceipt {
        registered: true,
        definition,
        tool,
        deployment,
    })
}

#[tauri::command]
pub async fn add_custom_tool(
    key: String,
    display_name: String,
    skills_dir: String,
    project_relative_skills_dir: Option<String>,
    store: State<'_, Arc<SkillStore>>,
) -> Result<RegistrationReceipt, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        register_custom_tool(
            &store,
            CustomToolDef {
                key,
                display_name,
                skills_dir,
                project_relative_skills_dir,
                category: Default::default(),
            },
        )
    })
    .await?
}

#[derive(Serialize)]
pub struct RemovalReceipt {
    removed: bool,
    next_tool: Option<ToolInfo>,
    deployment: scenario_service::DeploymentReport,
}

#[tauri::command]
pub async fn remove_custom_tool(
    key: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<RemovalReceipt, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || remove_custom_tool_internal(&store, &key)).await?
}

fn remove_custom_tool_internal(store: &SkillStore, key: &str) -> Result<RemovalReceipt, AppError> {
    let key = key.to_string();

    let _deployment = store.deployment_lock("remove_custom_tool")?;
    let config = store.tool_config()?;
    if !tool_adapters::adapters_from_config(&config)
        .iter()
        .any(|c| c.key == key && c.is_custom)
    {
        return Err(AppError::invalid_input("Only custom Agents can be removed"));
    }
    if key == "gitlab_duo" {
        config.validate_builtin_overrides(&key)?;
    }
    let mut deployment = scenario_service::remove_tool_targets(store, &key)?;
    deployment.require_complete()?;
    store.update_tool_config(|current| {
        if *current != config {
            return Err(AppError::invalid_input(
                "Agent configuration changed; refresh and retry",
            ));
        }
        current.customs.retain(|c| c.key != key);
        if key == "gitlab_duo" {
            if !current.disabled.contains(&key) {
                current.disabled.push(key.clone());
            }
        } else {
            current.paths.remove(&key);
            current.project_paths.remove(&key);
            current.disabled.retain(|k| k != &key);
        }
        Ok(())
    })?;
    let next_tool = match tool_service::list_tool_info(store) {
        Ok(infos) => infos.into_iter().find(|t| t.key == key),
        Err(error) => {
            deployment.state = "unknown".into();
            deployment.issue("read_removed_tool", "READ_FAILED", Some(&key), None, error);
            None
        }
    };
    Ok(RemovalReceipt {
        removed: true,
        next_tool,
        deployment,
    })
}

pub fn migrate_legacy_tool_keys(store: &SkillStore) -> Result<(), AppError> {
    tool_service::migrate_legacy_tool_keys(store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::skill_store::{ScenarioRecord, SkillRecord, SkillTargetRecord};
    use std::fs;
    use std::path::PathBuf;
    use tempfile::tempdir;

    /// #378: a user names a custom agent after one that later ships built-in.
    /// The key is derived from the display name, so "DeepSeek Harness" becomes
    /// `deepseek_harness` — and the collision check at creation time only knew
    /// the keys that existed then. Resolution now prefers the built-in, so a
    /// write that landed on the custom definition was stored where nothing
    /// reads it: the save reported success and the path never moved.
    fn store_with_colliding_custom_tool(dir: &std::path::Path, key: &str) -> SkillStore {
        let store = SkillStore::new(&dir.join("test.db")).unwrap();
        let customs = vec![CustomToolDef {
            key: key.to_string(),
            display_name: "DeepSeek Harness".to_string(),
            skills_dir: dir.join("legacy-skills").to_string_lossy().into_owned(),
            project_relative_skills_dir: Some(".old/skills".to_string()),
            category: ToolCategory::Coding,
        }];
        store
            .set_setting("custom_tools", &serde_json::to_string(&customs).unwrap())
            .unwrap();
        store
    }

    #[test]
    fn a_path_edit_survives_a_custom_tool_shadowed_by_a_builtin() {
        let tmp = tempdir().unwrap();
        let store = store_with_colliding_custom_tool(tmp.path(), "deepseek_harness");
        let chosen = tmp.path().join("chosen");

        apply_tool_skills_dir(&store, "deepseek_harness", &chosen.to_string_lossy()).unwrap();

        let adapter = tool_adapters::find_adapter_with_store(&store, "deepseek_harness")
            .unwrap()
            .unwrap();
        assert_eq!(
            adapter.skills_dir(),
            chosen,
            "the edit must be what resolves"
        );
        assert!(adapter.has_path_override());
    }

    #[test]
    fn a_project_path_edit_survives_the_same_shadowing() {
        let tmp = tempdir().unwrap();
        let store = store_with_colliding_custom_tool(tmp.path(), "deepseek_harness");

        apply_tool_project_skills_dir(&store, "deepseek_harness", Some(".mine/skills")).unwrap();

        let adapter = tool_adapters::find_adapter_with_store(&store, "deepseek_harness")
            .unwrap()
            .unwrap();
        assert_eq!(adapter.project_relative_skills_dir(), ".mine/skills");
    }

    /// A genuine custom agent — no built-in claims its key — still keeps both
    /// paths on its own definition, which is where its adapter reads them.
    #[test]
    fn a_real_custom_tool_still_stores_its_paths_on_its_definition() {
        let tmp = tempdir().unwrap();
        let store = store_with_colliding_custom_tool(tmp.path(), "my_own_agent");
        let chosen = tmp.path().join("chosen");

        apply_tool_skills_dir(&store, "my_own_agent", &chosen.to_string_lossy()).unwrap();
        apply_tool_project_skills_dir(&store, "my_own_agent", Some(".mine/skills")).unwrap();

        let customs = tool_service::get_custom_tools(&store).unwrap();
        let custom = customs.iter().find(|c| c.key == "my_own_agent").unwrap();
        assert_eq!(std::path::Path::new(&custom.skills_dir), chosen);
        assert_eq!(
            custom.project_relative_skills_dir.as_deref(),
            Some(".mine/skills")
        );

        let adapter = tool_adapters::find_adapter_with_store(&store, "my_own_agent")
            .unwrap()
            .unwrap();
        assert_eq!(adapter.skills_dir(), chosen);
        assert_eq!(adapter.project_relative_skills_dir(), ".mine/skills");
    }

    fn sample_skill(id: &str, name: &str, central_path: &std::path::Path) -> SkillRecord {
        SkillRecord {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            source_type: "import".to_string(),
            source_ref: Some(central_path.to_string_lossy().to_string()),
            source_ref_resolved: None,
            source_subpath: None,
            source_branch: None,
            source_revision: None,
            remote_revision: None,
            central_path: central_path.to_string_lossy().to_string(),
            content_hash: None,
            enabled: true,
            created_at: 1,
            updated_at: 1,
            status: "ok".to_string(),
            update_status: "local_only".to_string(),
            last_checked_at: None,
            last_check_error: None,
        }
    }

    fn sample_scenario(id: &str, name: &str) -> ScenarioRecord {
        ScenarioRecord {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            icon: None,
            sort_order: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn write_skill_dir(base: &std::path::Path, dir_name: &str, marker: &str) -> PathBuf {
        let dir = base.join(dir_name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {dir_name}\n---\n"),
        )
        .unwrap();
        fs::write(dir.join("unique.txt"), marker).unwrap();
        dir
    }

    fn configure_single_custom_tool(store: &SkillStore, target_base: &std::path::Path) {
        let custom_tools = vec![CustomToolDef {
            key: "test_agent".to_string(),
            display_name: "Test Agent".to_string(),
            skills_dir: target_base.to_string_lossy().to_string(),
            project_relative_skills_dir: None,
            category: Default::default(),
        }];
        store
            .set_setting(
                "custom_tools",
                &serde_json::to_string(&custom_tools).unwrap(),
            )
            .unwrap();
        let disabled_builtin_tools: Vec<String> = tool_adapters::default_tool_adapters()
            .into_iter()
            .map(|adapter| adapter.key)
            .collect();
        store
            .set_setting(
                "disabled_tools",
                &serde_json::to_string(&disabled_builtin_tools).unwrap(),
            )
            .unwrap();
        store.set_setting("sync_mode", "copy").unwrap();
    }

    #[test]
    fn active_scenario_tool_sync_keeps_duplicate_skill_names_separate() {
        let tmp = tempdir().unwrap();
        let store = SkillStore::new(&tmp.path().join("test.db")).unwrap();
        let source_base = tmp.path().join("central");
        let target_base = tmp.path().join("agent-skills");
        fs::create_dir_all(&source_base).unwrap();
        fs::create_dir_all(&target_base).unwrap();
        configure_single_custom_tool(&store, &target_base);

        store
            .insert_scenario(&sample_scenario("active", "Active"))
            .unwrap();
        store.set_active_scenario("active").unwrap();

        let first_dir = write_skill_dir(&source_base, "skill123", "first");
        let second_dir = write_skill_dir(&source_base, "skill123-2", "second");
        store
            .insert_skill(&sample_skill("first", "skill123", &first_dir))
            .unwrap();
        store
            .insert_skill(&sample_skill("second", "skill123", &second_dir))
            .unwrap();
        store.add_skill_to_scenario("active", "first").unwrap();
        store.add_skill_to_scenario("active", "second").unwrap();

        sync_active_scenario_to_tool(&store, "test_agent").unwrap();

        assert_eq!(
            fs::read_to_string(target_base.join("skill123/unique.txt")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(target_base.join("skill123-2/unique.txt")).unwrap(),
            "second"
        );
        let targets = store.get_all_targets().unwrap();
        assert!(targets.iter().any(|target| {
            target.skill_id == "first" && target.target_path.ends_with("skill123")
        }));
        assert!(targets.iter().any(|target| {
            target.skill_id == "second" && target.target_path.ends_with("skill123-2")
        }));
    }

    #[test]
    fn changing_a_tool_path_preserves_a_target_still_claimed_by_another_tool() {
        let tmp = tempdir().unwrap();
        let store = SkillStore::new(&tmp.path().join("test.db")).unwrap();
        let source = write_skill_dir(&tmp.path().join("center"), "skill-a", "center");
        let old_base = tmp.path().join("shared-agent");
        let shared_target = old_base.join("skill-a");
        fs::create_dir_all(&shared_target).unwrap();
        fs::write(shared_target.join("SKILL.md"), "shared deployment").unwrap();
        configure_single_custom_tool(&store, &old_base);
        let mut disabled: Vec<String> = tool_adapters::default_tool_adapters()
            .into_iter()
            .map(|adapter| adapter.key)
            .collect();
        disabled.push("test_agent".to_string());
        store
            .set_setting("disabled_tools", &serde_json::to_string(&disabled).unwrap())
            .unwrap();
        store
            .insert_skill(&sample_skill("skill-a", "skill-a", &source))
            .unwrap();
        for (id, tool) in [
            ("target-test", "test_agent"),
            ("target-other", "other_agent"),
        ] {
            store
                .insert_target(&SkillTargetRecord {
                    id: id.to_string(),
                    skill_id: "skill-a".to_string(),
                    tool: tool.to_string(),
                    target_path: shared_target.to_string_lossy().to_string(),
                    mode: "copy".to_string(),
                    status: "ok".to_string(),
                    synced_at: Some(1),
                    last_error: None,
                    source_hash: None,
                })
                .unwrap();
        }

        apply_tool_skills_dir(
            &store,
            "test_agent",
            &tmp.path().join("new-agent").to_string_lossy(),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(shared_target.join("SKILL.md")).unwrap(),
            "shared deployment"
        );
        let targets = store.get_targets_for_skill("skill-a").unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].tool, "other_agent");
    }

    #[test]
    fn rejected_tool_path_change_keeps_the_previous_deployment_and_record() {
        let tmp = tempdir().unwrap();
        let store = SkillStore::new(&tmp.path().join("test.db")).unwrap();
        let source = write_skill_dir(&tmp.path().join("center"), "skill-a", "center");
        let old_base = tmp.path().join("old-agent");
        let old_target = old_base.join("skill-a");
        fs::create_dir_all(&old_target).unwrap();
        fs::write(old_target.join("SKILL.md"), "old deployment").unwrap();
        configure_single_custom_tool(&store, &old_base);
        store
            .insert_scenario(&sample_scenario("active", "Active"))
            .unwrap();
        store.set_active_scenario("active").unwrap();
        store
            .insert_skill(&sample_skill("skill-a", "skill-a", &source))
            .unwrap();
        store.add_skill_to_scenario("active", "skill-a").unwrap();
        store
            .insert_target(&SkillTargetRecord {
                id: "target-old".to_string(),
                skill_id: "skill-a".to_string(),
                tool: "test_agent".to_string(),
                target_path: old_target.to_string_lossy().to_string(),
                mode: "copy".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: None,
            })
            .unwrap();
        let new_base = tmp.path().join("blocked-agent");
        let blocked_target = new_base.join("skill-a");
        fs::create_dir_all(&blocked_target).unwrap();
        fs::write(blocked_target.join("unmanaged.txt"), "user content").unwrap();

        let failure =
            apply_tool_skills_dir(&store, "test_agent", &new_base.to_string_lossy()).unwrap_err();
        assert_eq!(
            failure.kind,
            crate::core::error::ErrorKind::DeploymentIncomplete
        );

        assert_eq!(
            fs::read_to_string(old_target.join("SKILL.md")).unwrap(),
            "old deployment"
        );
        let targets = store.get_targets_for_skill("skill-a").unwrap();
        assert!(targets.iter().any(|target| {
            target.tool == "test_agent" && target.target_path == old_target.to_string_lossy()
        }));
    }
}

#[cfg(test)]
mod duo_removal_tests {
    use super::*;
    use tempfile::tempdir;
    #[test]
    fn legacy_duo_removal_preserves_overrides_and_exposes_disabled_builtin() {
        let temp = tempdir().unwrap();
        let store = SkillStore::new(&temp.path().join("test.db")).unwrap();
        let custom = CustomToolDef {
            key: "gitlab_duo".into(),
            display_name: "Old Duo".into(),
            skills_dir: temp.path().join("old").to_string_lossy().into_owned(),
            project_relative_skills_dir: None,
            category: ToolCategory::Lobster,
        };
        let builtin_path = temp.path().join("explicit").to_string_lossy().into_owned();
        store
            .update_tool_config(|config| {
                config.customs.push(custom);
                config
                    .paths
                    .insert("gitlab_duo".into(), builtin_path.clone());
                config
                    .project_paths
                    .insert("gitlab_duo".into(), ".duo/skills".into());
                config.order.push("gitlab_duo".into());
                Ok(())
            })
            .unwrap();
        let receipt = remove_custom_tool_internal(&store, "gitlab_duo").unwrap();
        let tool = receipt.next_tool.unwrap();
        assert!(!tool.is_custom);
        assert!(!tool.enabled);
        assert_eq!(tool.skills_dir, builtin_path);
        assert_eq!(
            tool.project_relative_skills_dir.as_deref(),
            Some(".duo/skills")
        );
        assert_eq!(store.tool_config().unwrap().order, ["gitlab_duo"]);
        assert!(verify_visible_duo(&store, None).is_err());
        assert!(verify_visible_duo(&store, Some(&tool)).is_ok());
        store
            .update_tool_config(|c| {
                c.paths.insert(
                    "gitlab_duo".into(),
                    temp.path().join("new").to_string_lossy().into_owned(),
                );
                Ok(())
            })
            .unwrap();
        assert!(verify_visible_duo(&store, Some(&tool)).is_err());
        assert!(!temp.path().join("explicit").exists());
    }
    #[test]
    fn invalid_dormant_override_refuses_removal_without_changing_definition() {
        let temp = tempdir().unwrap();
        let store = SkillStore::new(&temp.path().join("test.db")).unwrap();
        store
            .update_tool_config(|c| {
                c.customs.push(CustomToolDef {
                    key: "gitlab_duo".into(),
                    display_name: "Old".into(),
                    skills_dir: temp.path().join("old").to_string_lossy().into_owned(),
                    project_relative_skills_dir: None,
                    category: Default::default(),
                });
                c.paths.insert("gitlab_duo".into(), "relative".into());
                Ok(())
            })
            .unwrap();
        let before = store.get_setting("custom_tools").unwrap();
        assert!(remove_custom_tool_internal(&store, "gitlab_duo").is_err());
        assert_eq!(store.get_setting("custom_tools").unwrap(), before);
        assert!(store.get_all_targets().unwrap().is_empty());
    }
}
