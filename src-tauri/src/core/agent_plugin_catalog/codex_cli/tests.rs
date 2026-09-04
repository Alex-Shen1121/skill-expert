use super::*;
use std::ffi::OsString;
use std::sync::Mutex;

struct FixtureProbe {
    result: Mutex<Option<Result<CodexCliProbeOutput, ProcessError>>>,
}

impl FixtureProbe {
    fn success(stdout: &'static [u8]) -> Self {
        Self {
            result: Mutex::new(Some(Ok(CodexCliProbeOutput {
                success: true,
                exit_code: Some(0),
                stdout: stdout.to_vec(),
                stderr: Vec::new(),
            }))),
        }
    }

    fn completed(success: bool, stdout: &'static [u8], stderr: &'static [u8]) -> Self {
        Self {
            result: Mutex::new(Some(Ok(CodexCliProbeOutput {
                success,
                exit_code: Some(if success { 0 } else { 2 }),
                stdout: stdout.to_vec(),
                stderr: stderr.to_vec(),
            }))),
        }
    }

    fn spawn_failed() -> Self {
        Self {
            result: Mutex::new(Some(Err(ProcessError::SpawnFailed(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "secret path",
            ))))),
        }
    }
}

impl CodexCliProbe for FixtureProbe {
    fn run_catalog(
        &self,
        _executable: &std::path::Path,
    ) -> Result<CodexCliProbeOutput, ProcessError> {
        self.result.lock().unwrap().take().unwrap()
    }
}

struct NeverProbe;

impl CodexCliProbe for NeverProbe {
    fn run_catalog(
        &self,
        _executable: &std::path::Path,
    ) -> Result<CodexCliProbeOutput, ProcessError> {
        panic!("无效候选路径不得启动插件目录命令")
    }
}

struct RemovingProbe {
    executable: std::path::PathBuf,
}

impl CodexCliProbe for RemovingProbe {
    fn run_catalog(
        &self,
        _executable: &std::path::Path,
    ) -> Result<CodexCliProbeOutput, ProcessError> {
        std::fs::remove_file(&self.executable).unwrap();
        Ok(CodexCliProbeOutput {
            success: true,
            exit_code: Some(0),
            stdout: VALID_CATALOG.to_vec(),
            stderr: Vec::new(),
        })
    }
}

const VALID_CATALOG: &[u8] = br#"{
  "installed": [{
    "pluginId": "fixture",
    "marketplaceName": "test-market",
    "installed": true,
    "enabled": true
  }],
  "available": []
}"#;

fn make_executable(path: &std::path::Path) {
    std::fs::write(path, b"fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }
}

#[test]
fn explicit_path_has_priority_over_environment_resolution() {
    let temp = tempfile::tempdir().unwrap();
    let explicit = temp.path().join("chosen-codex");
    make_executable(&explicit);
    let environment_dir = temp.path().join("environment");
    std::fs::create_dir(&environment_dir).unwrap();
    make_executable(&environment_dir.join("codex"));
    let environment = CodexCliEnvironment {
        path: Some(std::env::join_paths([environment_dir.clone()]).unwrap()),
        path_extensions: None,
        codex_home: None,
        home: None,
        user_profile: None,
    };

    let resolved =
        resolve_codex_cli(Some(explicit.to_string_lossy().as_ref()), &environment).unwrap();

    assert_eq!(resolved.path, explicit);
    assert_eq!(resolved.source, CodexCliResolutionSource::Explicit);

    let environment_resolved = resolve_codex_cli(None, &environment).unwrap();
    assert_eq!(environment_resolved.path, environment_dir.join("codex"));
    assert_eq!(
        environment_resolved.source,
        CodexCliResolutionSource::Environment,
    );
}

#[cfg(unix)]
#[test]
fn explicit_executable_symlink_is_accepted_by_following_its_target() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("codex-target");
    let link = temp.path().join("codex-link");
    make_executable(&target);
    symlink(&target, &link).unwrap();

    let resolved = resolve_codex_cli(
        Some(link.to_string_lossy().as_ref()),
        &CodexCliEnvironment {
            path: Some(OsString::new()),
            path_extensions: None,
            codex_home: None,
            home: None,
            user_profile: None,
        },
    )
    .unwrap();

    assert_eq!(resolved.path, link);
    assert_eq!(resolved.source, CodexCliResolutionSource::Explicit);
}

#[test]
fn configuration_reports_directory_resolution_runtime_and_contract_as_separate_facts() {
    let temp = tempfile::tempdir().unwrap();
    let configuration_dir = temp.path().join("codex-home");
    std::fs::create_dir(&configuration_dir).unwrap();
    let invalid_path = temp.path().join("not-an-executable");
    std::fs::create_dir(&invalid_path).unwrap();
    let environment = CodexCliEnvironment {
        path: None,
        path_extensions: None,
        codex_home: Some(configuration_dir.into_os_string()),
        home: None,
        user_profile: None,
    };

    let configuration = inspect_codex_cli_configuration(
        Some(invalid_path.to_string_lossy().as_ref()),
        &environment,
    );

    assert_eq!(
        configuration,
        CodexCliConfiguration {
            resolution_source: CodexCliResolutionSource::Explicit,
            configured_path: Some(invalid_path.to_string_lossy().into_owned()),
            facts: CodexCliFacts {
                configuration_directory: CodexCliFactStatus::Confirmed,
                executable_resolution: CodexCliFactStatus::Unavailable,
                command_runtime: CodexCliFactStatus::Unavailable,
                plugin_json_contract: CodexCliFactStatus::Unchecked,
            },
            error: Some(AgentPluginCatalogErrorKind::ConfiguredPathInvalid),
        }
    );
}

#[cfg(unix)]
#[test]
fn regular_file_without_execute_permission_is_distinct_from_an_invalid_path() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("codex");
    std::fs::write(&path, b"fixture").unwrap();
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o644);
    std::fs::set_permissions(&path, permissions).unwrap();

    let configuration = inspect_codex_cli_configuration(
        Some(path.to_string_lossy().as_ref()),
        &CodexCliEnvironment::empty(),
    );

    assert_eq!(
        configuration.facts.executable_resolution,
        CodexCliFactStatus::Confirmed,
    );
    assert_eq!(
        configuration.facts.command_runtime,
        CodexCliFactStatus::Unavailable,
    );
    assert_eq!(
        configuration.error,
        Some(AgentPluginCatalogErrorKind::CliNotRunnable),
    );
}

#[test]
fn relative_candidate_is_rejected_even_when_it_points_to_an_executable_file() {
    let current_dir = std::env::current_dir().unwrap();
    let temp = tempfile::tempdir_in(&current_dir).unwrap();
    let executable = temp.path().join("codex");
    make_executable(&executable);
    let relative = executable.strip_prefix(&current_dir).unwrap();

    let configuration = validate_codex_cli_path_with(
        relative.to_string_lossy().as_ref(),
        &CodexCliEnvironment::empty(),
        &NeverProbe,
    );

    assert_eq!(
        configuration.error,
        Some(AgentPluginCatalogErrorKind::ConfiguredPathInvalid),
    );
}

#[test]
fn validation_marks_runtime_and_plugin_json_contract_only_after_a_real_probe() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("codex");
    make_executable(&executable);

    let configuration = validate_codex_cli_path_with(
        executable.to_string_lossy().as_ref(),
        &CodexCliEnvironment::empty(),
        &FixtureProbe::success(VALID_CATALOG),
    );

    assert_eq!(configuration.error, None);
    assert_eq!(
        configuration.facts.executable_resolution,
        CodexCliFactStatus::Confirmed,
    );
    assert_eq!(
        configuration.facts.command_runtime,
        CodexCliFactStatus::Confirmed,
    );
    assert_eq!(
        configuration.facts.plugin_json_contract,
        CodexCliFactStatus::Confirmed,
    );
}

#[test]
fn invalid_contract_does_not_replace_the_last_saved_path() {
    let temp = tempfile::tempdir().unwrap();
    let store = crate::core::skill_store::SkillStore::new(&temp.path().join("state.db")).unwrap();
    store
        .set_setting(CODEX_CLI_PATH_SETTING_KEY, "/last/known/good/codex")
        .unwrap();
    let candidate = temp.path().join("candidate-codex");
    make_executable(&candidate);

    let configuration = save_codex_cli_path_with(
        &store,
        candidate.to_string_lossy().as_ref(),
        &CodexCliEnvironment::empty(),
        &FixtureProbe::success(br#"{"installed": []}"#),
    )
    .unwrap();

    assert_eq!(
        configuration.error,
        Some(AgentPluginCatalogErrorKind::ContractIncompatible),
    );
    assert_eq!(
        store
            .get_setting(CODEX_CLI_PATH_SETTING_KEY)
            .unwrap()
            .as_deref(),
        Some("/last/known/good/codex"),
    );
}

#[test]
fn valid_save_and_reset_change_only_the_explicit_path_setting() {
    let temp = tempfile::tempdir().unwrap();
    let store = crate::core::skill_store::SkillStore::new(&temp.path().join("state.db")).unwrap();
    let candidate = temp.path().join("candidate-codex");
    make_executable(&candidate);

    let saved = save_codex_cli_path_with(
        &store,
        candidate.to_string_lossy().as_ref(),
        &CodexCliEnvironment::empty(),
        &FixtureProbe::success(VALID_CATALOG),
    )
    .unwrap();
    assert_eq!(saved.error, None);
    assert_eq!(
        store
            .get_setting(CODEX_CLI_PATH_SETTING_KEY)
            .unwrap()
            .as_deref(),
        Some(candidate.to_string_lossy().as_ref()),
    );

    let reset =
        reset_codex_cli_path_with_environment(&store, &CodexCliEnvironment::empty()).unwrap();
    assert_eq!(
        reset.resolution_source,
        CodexCliResolutionSource::Environment
    );
    assert_eq!(reset.configured_path, None);
    assert_eq!(
        store
            .get_setting(CODEX_CLI_PATH_SETTING_KEY)
            .unwrap()
            .as_deref(),
        Some(""),
    );
}

#[test]
fn empty_candidate_is_invalid_and_cannot_clear_the_last_saved_path() {
    let temp = tempfile::tempdir().unwrap();
    let store = crate::core::skill_store::SkillStore::new(&temp.path().join("state.db")).unwrap();
    store
        .set_setting(CODEX_CLI_PATH_SETTING_KEY, "/last/known/good/codex")
        .unwrap();

    let configuration =
        save_codex_cli_path_with(&store, "   ", &CodexCliEnvironment::empty(), &NeverProbe)
            .unwrap();

    assert_eq!(
        configuration.error,
        Some(AgentPluginCatalogErrorKind::ConfiguredPathInvalid),
    );
    assert_eq!(
        store
            .get_setting(CODEX_CLI_PATH_SETTING_KEY)
            .unwrap()
            .as_deref(),
        Some("/last/known/good/codex"),
    );
}

#[test]
fn validation_distinguishes_not_runnable_unsupported_and_incompatible_contracts() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("codex");
    make_executable(&executable);
    let path = executable.to_string_lossy();
    let cases = [
        (
            FixtureProbe::spawn_failed(),
            AgentPluginCatalogErrorKind::CliNotRunnable,
            CodexCliFactStatus::Unavailable,
            CodexCliFactStatus::Unchecked,
        ),
        (
            FixtureProbe::completed(
                false,
                b"",
                b"error: unrecognized subcommand 'plugin'; token=do-not-expose",
            ),
            AgentPluginCatalogErrorKind::CommandUnsupported,
            CodexCliFactStatus::Confirmed,
            CodexCliFactStatus::Unavailable,
        ),
        (
            FixtureProbe::success(br#"{"installed": []}"#),
            AgentPluginCatalogErrorKind::ContractIncompatible,
            CodexCliFactStatus::Confirmed,
            CodexCliFactStatus::Unavailable,
        ),
    ];

    for (probe, expected_error, runtime, contract) in cases {
        let configuration =
            validate_codex_cli_path_with(path.as_ref(), &CodexCliEnvironment::empty(), &probe);
        assert_eq!(configuration.error, Some(expected_error));
        assert_eq!(configuration.facts.command_runtime, runtime);
        assert_eq!(configuration.facts.plugin_json_contract, contract);
        let serialized = serde_json::to_string(&configuration).unwrap();
        assert!(!serialized.contains("do-not-expose"));
        assert!(!serialized.contains("secret path"));
    }
}

#[test]
fn candidate_that_changes_after_probe_cannot_replace_the_last_saved_path() {
    let temp = tempfile::tempdir().unwrap();
    let store = crate::core::skill_store::SkillStore::new(&temp.path().join("state.db")).unwrap();
    store
        .set_setting(CODEX_CLI_PATH_SETTING_KEY, "/last/known/good/codex")
        .unwrap();
    let candidate = temp.path().join("candidate-codex");
    make_executable(&candidate);

    let configuration = save_codex_cli_path_with(
        &store,
        candidate.to_string_lossy().as_ref(),
        &CodexCliEnvironment::empty(),
        &RemovingProbe {
            executable: candidate.clone(),
        },
    )
    .unwrap();

    assert_eq!(
        configuration.error,
        Some(AgentPluginCatalogErrorKind::ConfiguredPathInvalid),
    );
    assert_eq!(
        store
            .get_setting(CODEX_CLI_PATH_SETTING_KEY)
            .unwrap()
            .as_deref(),
        Some("/last/known/good/codex"),
    );
}
