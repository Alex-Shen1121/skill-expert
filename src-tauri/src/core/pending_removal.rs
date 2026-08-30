use serde::Serialize;

/// 即将删除的路径位于中央技能库或某个 Agent 的部署副本。
#[derive(Debug, Clone, Serialize)]
pub struct PendingRemoval {
    pub location: String,
    pub path: String,
}

pub const LIBRARY_LOCATION: &str = "library";
