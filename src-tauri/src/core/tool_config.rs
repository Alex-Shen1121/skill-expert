use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use super::{
    error::AppError,
    tool_adapters::{default_tool_adapters, CustomToolDef},
    tool_service::{normalize_project_relative_skills_dir_input, normalize_skills_dir_input},
};

pub const PROTECTED_KEYS: [&str; 5] = [
    "custom_tools",
    "custom_tool_paths",
    "custom_tool_project_paths",
    "disabled_tools",
    "tool_order",
];

/// One database snapshot of the Agent configuration; dormant Duo overrides
/// remain untouched until the user removes the legacy custom definition.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolConfig {
    pub customs: Vec<CustomToolDef>,
    pub paths: HashMap<String, String>,
    pub project_paths: HashMap<String, String>,
    pub disabled: Vec<String>,
    pub order: Vec<String>,
}

fn invalid(setting: &str, reason: &str) -> AppError {
    AppError::configuration(setting, reason)
}

fn read<T: DeserializeOwned + Default>(conn: &Connection, key: &str) -> Result<T, AppError> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|_| invalid(key, "read failed"))?;
    match raw {
        None => Ok(T::default()),
        Some(value) => {
            serde_json::from_str(&value).map_err(|_| invalid(key, "invalid JSON or type"))
        }
    }
}

impl ToolConfig {
    pub(crate) fn read(conn: &Connection) -> Result<Self, AppError> {
        let config = Self {
            customs: read(conn, "custom_tools")?,
            paths: read(conn, "custom_tool_paths")?,
            project_paths: read(conn, "custom_tool_project_paths")?,
            disabled: read(conn, "disabled_tools")?,
            order: read(conn, "tool_order")?,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), AppError> {
        let mut keys = HashSet::new();
        for custom in &self.customs {
            if custom.key.trim().is_empty() || custom.display_name.trim().is_empty() {
                return Err(invalid("custom_tools", "empty key or name"));
            }
            if !keys.insert(&custom.key) {
                return Err(invalid("custom_tools", "duplicate key"));
            }
            normalize_skills_dir_input(&custom.skills_dir)
                .map_err(|_| invalid("custom_tools", "invalid skills path"))?;
            if let Some(path) = &custom.project_relative_skills_dir {
                if normalize_project_relative_skills_dir_input(path)
                    .map_err(|_| invalid("custom_tools", "invalid project path"))?
                    .is_none()
                {
                    return Err(invalid("custom_tools", "empty project path"));
                }
            }
        }
        for adapter in default_tool_adapters() {
            if adapter.key == "gitlab_duo" && keys.contains(&adapter.key) {
                continue;
            }
            self.validate_builtin_overrides(&adapter.key)?;
        }
        Ok(())
    }

    pub fn validate_builtin_overrides(&self, key: &str) -> Result<(), AppError> {
        if let Some(path) = self.paths.get(key) {
            normalize_skills_dir_input(path)
                .map_err(|_| invalid("custom_tool_paths", "invalid skills path"))?;
        }
        if let Some(path) = self.project_paths.get(key) {
            // Existing empty overrides mean no project support.
            if !path.is_empty() {
                normalize_project_relative_skills_dir_input(path)
                    .map_err(|_| invalid("custom_tool_project_paths", "invalid project path"))?
                    .ok_or_else(|| invalid("custom_tool_project_paths", "invalid project path"))?;
            }
        }
        Ok(())
    }

    pub(crate) fn save_changes(&self, before: &Self, conn: &Connection) -> Result<(), AppError> {
        fn save<T: Serialize + PartialEq>(
            conn: &Connection,
            key: &str,
            value: &T,
            before: &T,
        ) -> Result<(), AppError> {
            if value != before {
                let json = serde_json::to_string(value).map_err(AppError::internal)?;
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                    [key, &json],
                )
                .map_err(AppError::db)?;
            }
            Ok(())
        }
        self.validate()?;
        save(conn, "custom_tools", &self.customs, &before.customs)?;
        save(conn, "custom_tool_paths", &self.paths, &before.paths)?;
        save(
            conn,
            "custom_tool_project_paths",
            &self.project_paths,
            &before.project_paths,
        )?;
        save(conn, "disabled_tools", &self.disabled, &before.disabled)?;
        save(conn, "tool_order", &self.order, &before.order)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{skill_store::SkillStore, tool_adapters, tool_service};
    use tempfile::tempdir;

    fn custom(key: &str, root: &std::path::Path) -> CustomToolDef {
        CustomToolDef {
            key: key.into(),
            display_name: format!("Old {key}"),
            skills_dir: root.join(key).to_string_lossy().into_owned(),
            project_relative_skills_dir: None,
            category: tool_adapters::ToolCategory::Lobster,
        }
    }

    #[test]
    fn legacy_duo_is_one_custom_identity_and_dormant_paths_do_not_override_it() {
        let dir = tempdir().unwrap();
        let store = SkillStore::new(&dir.path().join("test.db")).unwrap();
        let definition = custom("gitlab_duo", dir.path());
        let raw = format!("[ {} ]", serde_json::to_string(&definition).unwrap());
        store.set_setting("custom_tools", &raw).unwrap();
        store
            .set_setting("custom_tool_paths", r#"{"gitlab_duo":"dormant-relative"}"#)
            .unwrap();
        store
            .set_setting("disabled_tools", r#"["gitlab_duo"]"#)
            .unwrap();
        for _ in 0..2 {
            tool_service::migrate_legacy_tool_keys(&store).unwrap();
            let infos = tool_service::list_tool_info(&store).unwrap();
            let duos: Vec<_> = infos.iter().filter(|i| i.key == "gitlab_duo").collect();
            assert_eq!(duos.len(), 1);
            let duo = duos[0];
            assert!(duo.is_custom);
            assert!(!duo.enabled);
            assert_eq!(duo.display_name, definition.display_name);
            assert_eq!(duo.skills_dir, definition.skills_dir);
            assert_eq!(duo.category, definition.category);
            assert!(duo.project_relative_skills_dir.is_none());
            let adapter = tool_adapters::find_adapter_with_store(&store, "gitlab_duo")
                .unwrap()
                .unwrap();
            assert!(adapter.additional_scan_dirs.is_empty());
            assert!(store
                .tool_config()
                .unwrap()
                .validate_builtin_overrides("gitlab_duo")
                .is_err());
            assert_eq!(store.get_setting("custom_tools").unwrap().unwrap(), raw);
        }
    }

    #[test]
    fn malformed_or_duplicate_configuration_stops_reads_and_writes() {
        let dir = tempdir().unwrap();
        let store = SkillStore::new(&dir.path().join("test.db")).unwrap();
        for raw in ["{", "null", "{}", r#"[{"key":"gitlab_duo"}]"#] {
            store.set_setting("custom_tools", raw).unwrap();
            assert!(tool_service::list_tool_info(&store).is_err());
            assert!(store
                .update_tool_config(|c| {
                    c.disabled.push("cursor".into());
                    Ok(())
                })
                .is_err());
            assert_eq!(
                store.get_setting("custom_tools").unwrap().as_deref(),
                Some(raw)
            );
            assert!(store.get_setting("disabled_tools").unwrap().is_none());
        }
        let duo = custom("gitlab_duo", dir.path());
        let raw = serde_json::to_string(&[&duo, &duo]).unwrap();
        store.set_setting("custom_tools", &raw).unwrap();
        assert!(store.tool_config().is_err());
    }

    #[test]
    fn concurrent_definition_changes_keep_both_and_duplicate_has_one_winner() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("test.db");
        let first = SkillStore::new(&db).unwrap();
        let second = SkillStore::new(&db).unwrap();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            for (store, key) in [(&first, "a"), (&second, "b")] {
                let barrier = &barrier;
                let definition = custom(key, dir.path());
                scope.spawn(move || {
                    barrier.wait();
                    crate::commands::tools::register_custom_definition(store, definition).unwrap();
                });
            }
        });
        assert_eq!(first.tool_config().unwrap().customs.len(), 2);
        let wins = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for store in [&first, &second] {
                let barrier = &barrier;
                let wins = &wins;
                let definition = custom("same", dir.path());
                scope.spawn(move || {
                    barrier.wait();
                    if crate::commands::tools::register_custom_definition(store, definition).is_ok()
                    {
                        wins.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(wins.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(first.tool_config().unwrap().customs.len(), 3);
    }

    #[test]
    fn transaction_failure_rolls_back_definition_and_disabled_together() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("test.db");
        let store = SkillStore::new(&db).unwrap();
        store
            .update_tool_config(|c| {
                c.customs.push(custom("gitlab_duo", dir.path()));
                Ok(())
            })
            .unwrap();
        let before = store.get_setting("custom_tools").unwrap();
        Connection::open(db).unwrap().execute_batch("CREATE TRIGGER reject_disabled BEFORE INSERT ON settings WHEN NEW.key = 'disabled_tools' BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        assert!(store
            .update_tool_config(|c| {
                c.customs.clear();
                c.disabled.push("gitlab_duo".into());
                Ok(())
            })
            .is_err());
        assert_eq!(store.get_setting("custom_tools").unwrap(), before);
        assert!(store.get_setting("disabled_tools").unwrap().is_none());
    }

    #[test]
    fn global_paths_follow_native_absolute_semantics() {
        let temp = tempdir().unwrap();
        let path = temp
            .path()
            .join("nonexistent skills")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            tool_service::normalize_skills_dir_input(&path).unwrap(),
            path
        );
        assert!(!std::path::Path::new(&path).exists());
        for value in ["", "relative/skills"] {
            assert!(tool_service::normalize_skills_dir_input(value).is_err());
        }
        #[cfg(windows)]
        {
            for value in [r"C:\skills", r"\\server\share\skills", r"\\?\C:\skills"] {
                assert_eq!(
                    tool_service::normalize_skills_dir_input(value).unwrap(),
                    value
                );
            }
            for value in ["C:skills", r"\skills"] {
                assert!(tool_service::normalize_skills_dir_input(value).is_err());
            }
        }
    }

    #[test]
    fn project_paths_reject_parent_and_empty_root() {
        for value in [".", "./", "../skills", ".a/../skills", "/tmp/skills"] {
            assert!(
                tool_service::normalize_project_relative_skills_dir_input(value).is_err(),
                "{value}"
            );
        }
        assert_eq!(
            tool_service::normalize_project_relative_skills_dir_input("  ").unwrap(),
            None
        );
        assert_eq!(
            tool_service::normalize_project_relative_skills_dir_input(" .agent/long skills ")
                .unwrap(),
            Some(".agent/long skills".into())
        );
        #[cfg(windows)]
        for value in [
            r"C:\skills",
            "C:skills",
            r"\skills",
            r"\\server\skills",
            r"\\?\C:\skills",
            r"..\skills",
        ] {
            assert!(tool_service::normalize_project_relative_skills_dir_input(value).is_err());
        }
    }
}
