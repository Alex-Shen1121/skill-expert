use crate::core::agent_plugin_catalog::{
    get_agent_plugin_projection as read_agent_plugin_projection,
    get_codex_cli_configuration as read_codex_cli_configuration,
    reset_codex_cli_path as reset_stored_codex_cli_path,
    save_codex_cli_path as save_stored_codex_cli_path,
    validate_codex_cli_path as validate_candidate_codex_cli_path, AgentPluginAgent,
    AgentPluginProjection, CodexCliConfiguration, CODEX_CLI_PATH_SETTING_KEY,
};
use crate::core::error::AppError;
use crate::core::skill_store::SkillStore;
use std::sync::Arc;
use tauri::State;

/// 把阻塞式 Agent 插件目录读取切换到专用线程；领域失败保留在投影内。
#[tauri::command]
pub async fn get_agent_plugin_projection(
    agent: AgentPluginAgent,
    store: State<'_, Arc<SkillStore>>,
) -> Result<AgentPluginProjection, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let configured_path = store
            .get_setting(CODEX_CLI_PATH_SETTING_KEY)
            .map_err(AppError::db)?;
        Ok::<_, AppError>(read_agent_plugin_projection(
            agent,
            configured_path.as_deref(),
        ))
    })
    .await
    .map_err(AppError::from)?
}

/// 返回当前路径来源与分层事实，不执行插件目录命令。
#[tauri::command]
pub async fn get_codex_cli_configuration(
    store: State<'_, Arc<SkillStore>>,
) -> Result<CodexCliConfiguration, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        read_codex_cli_configuration(&store).map_err(AppError::db)
    })
    .await?
}

/// 验证候选路径，但不保存设置。
#[tauri::command]
pub async fn validate_codex_cli_path(path: String) -> Result<CodexCliConfiguration, AppError> {
    tauri::async_runtime::spawn_blocking(move || validate_candidate_codex_cli_path(&path))
        .await
        .map_err(AppError::from)
}

/// 在后端完整验证候选路径后才原子写入设置。
#[tauri::command]
pub async fn set_codex_cli_path(
    path: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<CodexCliConfiguration, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        save_stored_codex_cli_path(&store, &path).map_err(AppError::db)
    })
    .await?
}

/// 清除显式路径并恢复环境解析；不执行插件目录命令。
#[tauri::command]
pub async fn reset_codex_cli_path(
    store: State<'_, Arc<SkillStore>>,
) -> Result<CodexCliConfiguration, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        reset_stored_codex_cli_path(&store).map_err(AppError::db)
    })
    .await?
}
