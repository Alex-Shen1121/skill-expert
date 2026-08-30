use serde::Serialize;
use std::fmt;

/// Tauri 命令使用的结构化错误。
///
/// `details` 只承载调用方必须按字段处理的附加信息；没有附加信息时不进入序列化结果，
/// 因而现有前端调用方仍可只读取 `kind` 与 `message`。
#[derive(Debug, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<ErrorDetails>,
}

/// 部署因目标不属于本应用而被拒绝时的机器可读信息。
#[derive(Debug, Serialize)]
pub struct ErrorDetails {
    pub conflicts: Vec<TargetConflictDetail>,
}

#[derive(Debug, Serialize)]
pub struct TargetConflictDetail {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Database,
    Io,
    Network,
    Git,
    NotFound,
    InvalidInput,
    Cancelled,
    Internal,
    /// 目标路径不是受管部署，现有内容保持不变。
    TargetConflict,
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl AppError {
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::NotFound,
            message: msg.into(),
            details: None,
        }
    }

    pub fn invalid_input(msg: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::InvalidInput,
            message: msg.into(),
            details: None,
        }
    }

    #[allow(dead_code)]
    pub fn cancelled(msg: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Cancelled,
            message: msg.into(),
            details: None,
        }
    }

    /// Convert an `anyhow::Error` originating from database operations.
    pub fn db(e: impl fmt::Display) -> Self {
        Self {
            kind: ErrorKind::Database,
            message: e.to_string(),
            details: None,
        }
    }

    /// Convert an `anyhow::Error` originating from git operations.
    pub fn git(e: impl fmt::Display) -> Self {
        Self {
            kind: ErrorKind::Git,
            message: e.to_string(),
            details: None,
        }
    }

    /// Classify a git operation error into cancellation, network, or generic git error.
    pub fn classify_git_error(e: impl fmt::Display) -> Self {
        let message = e.to_string();
        let lower = message.to_ascii_lowercase();
        if lower.contains("cancelled") || lower.contains("canceled") {
            Self {
                kind: ErrorKind::Cancelled,
                message,
                details: None,
            }
        } else if lower.contains("connection refused")
            || lower.contains("could not resolve host")
            || lower.contains("failed to connect")
            || lower.contains("connection timed out")
            || lower.contains("network is unreachable")
        {
            Self {
                kind: ErrorKind::Network,
                message,
                details: None,
            }
        } else {
            Self {
                kind: ErrorKind::Git,
                message,
                details: None,
            }
        }
    }

    /// Convert an `anyhow::Error` originating from network operations.
    pub fn network(e: impl fmt::Display) -> Self {
        Self {
            kind: ErrorKind::Network,
            message: e.to_string(),
            details: None,
        }
    }

    /// Convert an `anyhow::Error` originating from IO operations.
    pub fn io(e: impl fmt::Display) -> Self {
        Self {
            kind: ErrorKind::Io,
            message: e.to_string(),
            details: None,
        }
    }

    /// 构造带冲突路径的部署拒绝错误，供 CLI 和前端直接读取路径。
    pub fn target_conflict(
        message: impl Into<String>,
        conflicts: Vec<TargetConflictDetail>,
    ) -> Self {
        Self {
            kind: ErrorKind::TargetConflict,
            message: message.into(),
            details: Some(ErrorDetails { conflicts }),
        }
    }

    pub fn internal(e: impl fmt::Display) -> Self {
        Self {
            kind: ErrorKind::Internal,
            message: e.to_string(),
            details: None,
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self {
            kind: ErrorKind::Io,
            message: e.to_string(),
            details: None,
        }
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        Self {
            kind: ErrorKind::Internal,
            message: e.to_string(),
            details: None,
        }
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        Self {
            kind: ErrorKind::Internal,
            message: e.to_string(),
            details: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_git_error_detects_cancelled() {
        let err = AppError::classify_git_error("Installation cancelled by user");
        assert!(matches!(err.kind, ErrorKind::Cancelled));
    }

    #[test]
    fn classify_git_error_detects_canceled_american_spelling() {
        let err = AppError::classify_git_error("Operation was canceled");
        assert!(matches!(err.kind, ErrorKind::Cancelled));
    }

    #[test]
    fn classify_git_error_regular_git_error() {
        let err = AppError::classify_git_error("Failed to push to remote");
        assert!(matches!(err.kind, ErrorKind::Git));
    }

    #[test]
    fn classify_git_error_case_insensitive() {
        let err = AppError::classify_git_error("CANCELLED by system");
        assert!(matches!(err.kind, ErrorKind::Cancelled));
    }

    #[test]
    fn classify_git_error_detects_connection_refused() {
        let err = AppError::classify_git_error("fatal: unable to access 'https://gitea.example.com/user/repo.git/': Failed to connect to gitea.example.com port 443: Connection refused");
        assert!(matches!(err.kind, ErrorKind::Network));
    }

    #[test]
    fn classify_git_error_detects_could_not_resolve_host() {
        let err = AppError::classify_git_error(
            "fatal: unable to access: Could not resolve host: example.com",
        );
        assert!(matches!(err.kind, ErrorKind::Network));
    }

    #[test]
    fn constructors_set_correct_kinds() {
        assert!(matches!(AppError::not_found("x").kind, ErrorKind::NotFound));
        assert!(matches!(
            AppError::invalid_input("x").kind,
            ErrorKind::InvalidInput
        ));
        assert!(matches!(
            AppError::cancelled("x").kind,
            ErrorKind::Cancelled
        ));
        assert!(matches!(AppError::db("x").kind, ErrorKind::Database));
        assert!(matches!(AppError::git("x").kind, ErrorKind::Git));
        assert!(matches!(AppError::network("x").kind, ErrorKind::Network));
        assert!(matches!(AppError::io("x").kind, ErrorKind::Io));
        assert!(matches!(AppError::internal("x").kind, ErrorKind::Internal));
    }

    #[test]
    fn display_shows_message() {
        let err = AppError::not_found("Skill not found");
        assert_eq!(format!("{}", err), "Skill not found");
    }

    #[test]
    fn serializes_to_json_with_kind_and_message() {
        let err = AppError::not_found("missing");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "not_found");
        assert_eq!(json["message"], "missing");
        assert!(json.get("details").is_none());
    }

    #[test]
    fn target_conflict_serializes_paths_as_details() {
        let err = AppError::target_conflict(
            "目标冲突",
            vec![TargetConflictDetail {
                path: "/tmp/agent/skills/demo".to_string(),
                reason: "不是受管部署".to_string(),
            }],
        );
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "target_conflict");
        assert_eq!(
            json["details"]["conflicts"][0]["path"],
            "/tmp/agent/skills/demo"
        );
    }

    #[test]
    fn error_kind_serializes_snake_case() {
        let err = AppError::invalid_input("bad");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "invalid_input");
    }

    #[test]
    fn from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file gone");
        let app_err: AppError = io_err.into();
        assert!(matches!(app_err.kind, ErrorKind::Io));
        assert!(app_err.message.contains("file gone"));
    }
}
