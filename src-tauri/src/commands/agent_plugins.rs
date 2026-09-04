use crate::core::agent_plugin_catalog::{
    get_agent_plugin_projection as read_agent_plugin_projection, AgentPluginAgent,
    AgentPluginProjection,
};
use crate::core::error::AppError;

/// 把阻塞式 Agent 插件目录读取切换到专用线程；领域失败保留在投影内。
#[tauri::command]
pub async fn get_agent_plugin_projection(
    agent: AgentPluginAgent,
) -> Result<AgentPluginProjection, AppError> {
    tauri::async_runtime::spawn_blocking(move || read_agent_plugin_projection(agent))
        .await
        .map_err(AppError::from)
}
