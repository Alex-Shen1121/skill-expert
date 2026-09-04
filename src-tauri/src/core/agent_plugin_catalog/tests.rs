use super::*;

struct FixtureAdapter {
    stdout: &'static [u8],
}

struct CompletedCommandAdapter {
    success: bool,
    exit_code: Option<i32>,
    stdout: &'static [u8],
    stderr: &'static [u8],
}

struct TimedOutCommandAdapter;

impl CatalogAdapter for TimedOutCommandAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
        Err(codex::classify_process_error(
            crate::core::process_runner::ProcessError::TimedOut {
                timeout: std::time::Duration::from_secs(30),
            },
        ))
    }
}

impl CatalogAdapter for CompletedCommandAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
        codex::classify_completed_output(
            self.success,
            self.exit_code,
            self.stdout.to_vec(),
            self.stderr,
        )
    }
}

impl CatalogAdapter for FixtureAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
        Ok(CatalogCommandOutput {
            stdout: self.stdout.to_vec(),
        })
    }
}

#[test]
fn one_snapshot_preserves_every_identity_and_maps_installed_states() {
    let fixture = r#"{
      "installed": [
        {
          "pluginId": "same-name@first",
          "name": "同名插件",
          "marketplaceName": "market-one",
          "version": "1.2.3",
          "installed": true,
          "enabled": true,
          "installPolicy": "AVAILABLE",
          "authPolicy": "ON_INSTALL",
          "updateAvailable": false,
          "futureField": {"ignored": true}
        },
        {
          "pluginId": "same-name@second",
          "name": "同名插件",
          "marketplaceName": "market-two",
          "version": "2.0.0",
          "installed": true,
          "enabled": false
        }
      ],
      "available": [
        {
          "pluginId": "third@market-three",
          "name": "第三个插件",
          "marketplaceName": "market-three",
          "version": null,
          "installed": false,
          "enabled": false
        }
      ],
      "futureTopLevel": "ignored"
    }"#;

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &FixtureAdapter {
            stdout: fixture.as_bytes(),
        },
    );

    let AgentPluginProjection::Ready {
        agent,
        installed,
        available,
        ..
    } = projection
    else {
        panic!("合法 CLI fixture 应生成就绪投影");
    };
    assert_eq!(
        (agent, installed, available),
        (
            AgentPluginAgent::Codex,
            vec![
                AgentPluginSummary {
                    identity: AgentPluginIdentity {
                        agent: AgentPluginAgent::Codex,
                        marketplace_name: "market-one".into(),
                        plugin_id: "same-name@first".into(),
                    },
                    display_name: "同名插件".into(),
                    version: Some("1.2.3".into()),
                    install_status: AgentPluginInstallStatus::InstalledEnabled,
                    update_available: Some(false),
                    install_policy: Some("AVAILABLE".into()),
                    auth_policy: Some("ON_INSTALL".into()),
                },
                AgentPluginSummary {
                    identity: AgentPluginIdentity {
                        agent: AgentPluginAgent::Codex,
                        marketplace_name: "market-two".into(),
                        plugin_id: "same-name@second".into(),
                    },
                    display_name: "同名插件".into(),
                    version: Some("2.0.0".into()),
                    install_status: AgentPluginInstallStatus::InstalledDisabled,
                    update_available: None,
                    install_policy: None,
                    auth_policy: None,
                },
            ],
            vec![AgentPluginSummary {
                identity: AgentPluginIdentity {
                    agent: AgentPluginAgent::Codex,
                    marketplace_name: "market-three".into(),
                    plugin_id: "third@market-three".into(),
                },
                display_name: "第三个插件".into(),
                version: None,
                install_status: AgentPluginInstallStatus::Available,
                update_available: None,
                install_policy: None,
                auth_policy: None,
            }],
        )
    );
}

#[test]
fn missing_codex_executable_is_a_structured_cli_unavailable_error() {
    let adapter = codex::CodexCatalogAdapter::with_executable(std::path::PathBuf::from(
        "definitely-missing-skill-expert-codex-fixture",
    ));

    let projection = get_agent_plugin_projection_with_adapter(AgentPluginAgent::Codex, &adapter);

    assert!(matches!(
        projection,
        AgentPluginProjection::Error {
            error: AgentPluginCatalogError {
                kind: AgentPluginCatalogErrorKind::CliUnavailable,
                exit_code: None,
            },
            ..
        }
    ));
}

#[test]
fn unsupported_plugin_subcommand_is_not_reported_as_a_generic_failure() {
    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &CompletedCommandAdapter {
            success: false,
            exit_code: Some(2),
            stdout: b"",
            stderr: b"error: unrecognized subcommand 'plugin'",
        },
    );

    assert!(matches!(
        projection,
        AgentPluginProjection::Error {
            error: AgentPluginCatalogError {
                kind: AgentPluginCatalogErrorKind::CommandUnsupported,
                exit_code: Some(2),
            },
            ..
        }
    ));
}

#[test]
fn unsupported_list_or_json_arguments_are_reported_as_command_unsupported() {
    for stderr in [
        b"error: unrecognized subcommand 'list'".as_slice(),
        b"error: unexpected argument '--available'".as_slice(),
        b"error: unexpected argument '--json'".as_slice(),
    ] {
        let projection = get_agent_plugin_projection_with_adapter(
            AgentPluginAgent::Codex,
            &CompletedCommandAdapter {
                success: false,
                exit_code: Some(2),
                stdout: b"",
                stderr,
            },
        );
        assert!(matches!(
            projection,
            AgentPluginProjection::Error {
                error: AgentPluginCatalogError {
                    kind: AgentPluginCatalogErrorKind::CommandUnsupported,
                    ..
                },
                ..
            }
        ));
    }
}

#[test]
fn nonzero_exit_is_reported_without_exposing_stderr() {
    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &CompletedCommandAdapter {
            success: false,
            exit_code: Some(23),
            stdout: b"",
            stderr: b"request failed with secret=do-not-expose",
        },
    );

    assert_eq!(
        projection,
        AgentPluginProjection::Error {
            agent: AgentPluginAgent::Codex,
            refreshed_at_unix_ms: projection_timestamp(&projection),
            error: AgentPluginCatalogError {
                kind: AgentPluginCatalogErrorKind::CommandFailed,
                exit_code: Some(23),
            },
        }
    );
}

#[test]
fn process_timeout_has_its_own_catalog_error_kind() {
    let projection =
        get_agent_plugin_projection_with_adapter(AgentPluginAgent::Codex, &TimedOutCommandAdapter);

    assert!(matches!(
        projection,
        AgentPluginProjection::Error {
            error: AgentPluginCatalogError {
                kind: AgentPluginCatalogErrorKind::TimedOut,
                exit_code: None,
            },
            ..
        }
    ));
}

#[test]
fn invalid_json_and_incompatible_contract_remain_distinct() {
    let cases = [
        (
            b"not-json".as_slice(),
            AgentPluginCatalogErrorKind::InvalidJson,
        ),
        (
            br#"{"installed": []}"#.as_slice(),
            AgentPluginCatalogErrorKind::ContractIncompatible,
        ),
        (
            r#"{"installed": [{"name":"缺少身份"}], "available": []}"#.as_bytes(),
            AgentPluginCatalogErrorKind::ContractIncompatible,
        ),
        (
            r#"{
              "installed": [{"pluginId":"duplicate","marketplaceName":"same","installed":true,"enabled":true}],
              "available": [{"pluginId":"duplicate","marketplaceName":"same","installed":false,"enabled":false}]
            }"#
            .as_bytes(),
            AgentPluginCatalogErrorKind::ContractIncompatible,
        ),
    ];

    for (stdout, expected_kind) in cases {
        let projection = get_agent_plugin_projection_with_adapter(
            AgentPluginAgent::Codex,
            &FixtureAdapter { stdout },
        );
        assert!(matches!(
            projection,
            AgentPluginProjection::Error {
                error: AgentPluginCatalogError { kind, .. },
                ..
            } if kind == expected_kind
        ));
    }
}

#[cfg(unix)]
#[test]
fn codex_adapter_uses_the_controlled_process_seam_with_the_exact_read_only_arguments() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("codex");
    std::fs::write(
        &executable,
        r#"#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1" != "plugin" ] || [ "$2" != "list" ] || [ "$3" != "--available" ] || [ "$4" != "--json" ]; then
  exit 71
fi
printf '%s' '{"installed":[{"pluginId":"fixture","name":"Fixture","marketplaceName":"test-market","version":"1.0.0","installed":true,"enabled":true}],"available":[]}'
"#,
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&executable, permissions).unwrap();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &codex::CodexCatalogAdapter::with_executable(executable),
    );

    assert!(matches!(
        projection,
        AgentPluginProjection::Ready {
            installed,
            available,
            ..
        } if installed.len() == 1
            && installed[0].identity.plugin_id == "fixture"
            && available.is_empty()
    ));
}

fn projection_timestamp(projection: &AgentPluginProjection) -> u64 {
    match projection {
        AgentPluginProjection::Ready {
            refreshed_at_unix_ms,
            ..
        }
        | AgentPluginProjection::Error {
            refreshed_at_unix_ms,
            ..
        } => *refreshed_at_unix_ms,
    }
}
