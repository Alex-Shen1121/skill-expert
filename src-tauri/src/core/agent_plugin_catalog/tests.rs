use super::*;

struct FixtureAdapter {
    stdout: &'static [u8],
}

struct OwnedFixtureAdapter {
    stdout: Vec<u8>,
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

impl CatalogAdapter for OwnedFixtureAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
        Ok(CatalogCommandOutput {
            stdout: self.stdout.clone(),
        })
    }
}

#[test]
fn complete_manifest_supplements_details_without_overriding_cli_facts() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    std::fs::create_dir_all(root.join("skills/safe-skill")).unwrap();
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(
        root.join("skills/safe-skill/SKILL.md"),
        "---\nname: safe-skill\ndescription: 只读处理文档\n---\n",
    )
    .unwrap();
    std::fs::write(
        root.join(".mcp.json"),
        r#"{"mcp_servers":{"docs":{"command":"secret-command","env":{"TOKEN":"secret-value"}}}}"#,
    )
    .unwrap();
    std::fs::write(
        root.join(".app.json"),
        r#"{"apps":{"docs-connector":{"id":"plugin_asdk_secret"}}}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("assets/icon.png"),
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        )
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        r##"{
          "name":"manifest-name",
          "version":"99.0.0",
          "description":"顶层说明",
          "author":{"name":"顶层开发者","email":"secret@example.com"},
          "skills":"./skills/",
          "mcpServers":"./.mcp.json",
          "apps":"./.app.json",
          "hooks":{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo secret"}]}]}},
          "interface":{
            "displayName":"安全详情插件",
            "longDescription":"只展示可信补充资料。",
            "developerName":"可信开发者",
            "category":"效率",
            "capabilities":["Read","Write"],
            "defaultPrompt":["总结文档","检查变更"],
            "composerIcon":"./assets/icon.png"
          }
        }"##,
    )
    .unwrap();

    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed": [{
            "pluginId": "safe-details@market",
            "name": "CLI 名称",
            "marketplaceName": "market",
            "version": "1.2.3",
            "installed": true,
            "enabled": false,
            "authPolicy": "ON_INSTALL",
            "source": {"source": "local", "path": root}
        }],
        "available": []
    }))
    .unwrap();
    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &OwnedFixtureAdapter { stdout },
    );

    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("合法 manifest 应保留就绪投影");
    };
    let plugin = &installed[0];
    assert_eq!(plugin.identity.plugin_id, "safe-details@market");
    assert_eq!(plugin.version.as_deref(), Some("1.2.3"));
    assert_eq!(
        plugin.install_status,
        AgentPluginInstallStatus::InstalledDisabled
    );
    assert_eq!(plugin.display_name, "安全详情插件");
    assert_eq!(
        plugin.details.description.as_deref(),
        Some("只展示可信补充资料。")
    );
    assert_eq!(plugin.details.developer.as_deref(), Some("可信开发者"));
    assert_eq!(plugin.details.category.as_deref(), Some("效率"));
    assert_eq!(plugin.details.default_prompts, ["总结文档", "检查变更"]);
    assert_eq!(plugin.details.declared_capabilities, ["Read", "Write"]);
    assert_eq!(
        plugin.details.skills,
        [AgentPluginSkill {
            name: "safe-skill".into(),
            description: Some("只读处理文档".into()),
        }]
    );
    assert_eq!(plugin.details.mcp_servers, ["docs"]);
    assert_eq!(plugin.details.hook_events, ["SessionStart"]);
    assert_eq!(plugin.details.connectors, ["docs-connector"]);
    assert!(plugin.details.browser_extensions.is_empty());
    assert!(plugin.details.custom_ui.is_empty());
    assert!(plugin
        .details
        .icon_data_url
        .as_deref()
        .is_some_and(|value| value.starts_with("data:image/png;base64,")));
    assert_eq!(
        plugin.details.completeness,
        AgentPluginDetailsCompleteness::Complete
    );
    assert!(plugin.details.issues.is_empty());
    assert_eq!(
        plugin.details.technical.source_type.as_deref(),
        Some("local")
    );
    assert!(plugin
        .details
        .technical
        .location
        .as_deref()
        .is_some_and(|value| !value.contains(temp.path().to_string_lossy().as_ref())));
    let serialized = serde_json::to_string(plugin).unwrap();
    for secret in [
        "secret-command",
        "secret-value",
        "plugin_asdk_secret",
        "secret@example.com",
    ] {
        assert!(!serialized.contains(secret));
    }
}

#[test]
fn manifest_screenshots_are_returned_only_after_safe_image_validation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    std::fs::create_dir_all(root.join("assets")).unwrap();
    let png = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    )
    .unwrap();
    std::fs::write(root.join("assets/screen.png"), png).unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        r#"{"name":"fixture","interface":{"screenshots":["./assets/screen.png"]}}"#,
    )
    .unwrap();
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed": [{
            "pluginId":"fixture",
            "marketplaceName":"market",
            "installed":true,
            "enabled":true,
            "source":{"source":"local","path":root}
        }],
        "available":[]
    }))
    .unwrap();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &OwnedFixtureAdapter { stdout },
    );
    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("安全截图不应影响 CLI 就绪投影");
    };

    assert_eq!(installed[0].details.screenshot_data_urls.len(), 1);
    assert!(installed[0].details.screenshot_data_urls[0].starts_with("data:image/png;base64,"));
    assert_eq!(
        installed[0].details.completeness,
        AgentPluginDetailsCompleteness::Complete
    );
}

#[cfg(unix)]
#[test]
fn unsafe_visual_resources_fall_back_per_plugin_without_reducing_the_cli_collection() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let png = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    )
    .unwrap();
    std::fs::write(temp.path().join("outside.png"), &png).unwrap();
    let cases = [
        (
            "traversal",
            "./../outside.png",
            AgentPluginDetailsIssue::ResourceRejected,
        ),
        (
            "absolute",
            "/tmp/skill-expert-absolute-icon.png",
            AgentPluginDetailsIssue::ResourceRejected,
        ),
        (
            "remote",
            "https://example.com/icon.png",
            AgentPluginDetailsIssue::ResourceRejected,
        ),
        (
            "missing",
            "./assets/missing.png",
            AgentPluginDetailsIssue::ComponentUnreadable,
        ),
        (
            "unsupported",
            "./assets/icon.svg",
            AgentPluginDetailsIssue::ResourceRejected,
        ),
        (
            "oversized",
            "./assets/large.png",
            AgentPluginDetailsIssue::ResourceRejected,
        ),
        (
            "symlink",
            "./assets/link.png",
            AgentPluginDetailsIssue::ResourceRejected,
        ),
    ];
    let mut entries = Vec::new();
    for (id, icon, _) in cases {
        let root = temp.path().join(id);
        std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        match id {
            "unsupported" => std::fs::write(root.join("assets/icon.svg"), b"<svg/>").unwrap(),
            "oversized" => {
                let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
                bytes.resize(2 * 1024 * 1024 + 1, 0);
                std::fs::write(root.join("assets/large.png"), bytes).unwrap();
            }
            "symlink" => symlink(
                temp.path().join("outside.png"),
                root.join("assets/link.png"),
            )
            .unwrap(),
            _ => {}
        }
        std::fs::write(
            root.join(".codex-plugin/plugin.json"),
            serde_json::to_vec(&serde_json::json!({
                "name": id,
                "interface": {"composerIcon": icon}
            }))
            .unwrap(),
        )
        .unwrap();
        entries.push(serde_json::json!({
            "pluginId": id,
            "marketplaceName": "market",
            "installed": true,
            "enabled": true,
            "source": {"source": "local", "path": root}
        }));
    }
    let healthy_root = temp.path().join("healthy");
    std::fs::create_dir_all(healthy_root.join(".codex-plugin")).unwrap();
    std::fs::write(
        healthy_root.join(".codex-plugin/plugin.json"),
        r#"{"name":"healthy","description":"仍可读取"}"#,
    )
    .unwrap();
    entries.push(serde_json::json!({
        "pluginId":"healthy",
        "marketplaceName":"market",
        "installed":true,
        "enabled":true,
        "source":{"source":"local","path":healthy_root}
    }));
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed": entries,
        "available": []
    }))
    .unwrap();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &OwnedFixtureAdapter { stdout },
    );
    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("单条视觉资源失败不能提升为 Agent 失败");
    };

    assert_eq!(installed.len(), 8);
    for (id, _, expected_issue) in cases {
        let plugin = installed
            .iter()
            .find(|plugin| plugin.identity.plugin_id == id)
            .unwrap();
        assert_eq!(
            plugin.details.completeness,
            AgentPluginDetailsCompleteness::Incomplete
        );
        assert!(plugin.details.icon_data_url.is_none());
        assert!(
            plugin.details.issues.contains(&expected_issue),
            "{id} 应包含 {expected_issue:?}，实际为 {:?}",
            plugin.details.issues
        );
    }
    let healthy = installed
        .iter()
        .find(|plugin| plugin.identity.plugin_id == "healthy")
        .unwrap();
    assert_eq!(
        healthy.details.completeness,
        AgentPluginDetailsCompleteness::Complete
    );
    assert_eq!(healthy.details.description.as_deref(), Some("仍可读取"));
}

#[cfg(unix)]
#[test]
fn manifest_skill_directory_rejects_symlink_entries_that_escape_the_plugin_root() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    let outside = temp.path().join("outside-skill");
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    std::fs::create_dir_all(root.join("skills")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(
        outside.join("SKILL.md"),
        "---\nname: escaped\ndescription: 不得读取\n---\n",
    )
    .unwrap();
    symlink(&outside, root.join("skills/escaped")).unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        r#"{"name":"fixture","skills":"./skills/"}"#,
    )
    .unwrap();
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed":[{
            "pluginId":"fixture",
            "marketplaceName":"market",
            "installed":true,
            "enabled":true,
            "source":{"source":"local","path":root}
        }],
        "available":[]
    }))
    .unwrap();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &OwnedFixtureAdapter { stdout },
    );
    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("越界 Skill 不能破坏 Agent 状态投影");
    };

    assert!(installed[0].details.skills.is_empty());
    assert_eq!(
        installed[0].details.completeness,
        AgentPluginDetailsCompleteness::Incomplete
    );
    assert!(installed[0]
        .details
        .issues
        .contains(&AgentPluginDetailsIssue::ResourceRejected));
}

#[test]
fn authentication_policy_is_limited_to_three_declared_states() {
    let installed = [
        ("install", Some("ON_INSTALL")),
        ("use", Some("ON_USE")),
        ("none", Some("NONE")),
        ("future", Some("FUTURE_POLICY")),
        ("missing", None),
    ]
    .into_iter()
    .map(|(id, policy)| {
        let mut entry = serde_json::json!({
            "pluginId":id,
            "marketplaceName":"market",
            "installed":true,
            "enabled":true
        });
        if let Some(policy) = policy {
            entry["authPolicy"] = Value::String(policy.into());
        }
        entry
    })
    .collect::<Vec<_>>();
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed":installed,
        "available":[]
    }))
    .unwrap();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &OwnedFixtureAdapter { stdout },
    );
    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("未知认证策略应前向兼容，而不是破坏投影");
    };

    assert_eq!(
        installed[0].auth_policy,
        Some(AgentPluginAuthPolicy::OnInstall)
    );
    assert_eq!(installed[1].auth_policy, Some(AgentPluginAuthPolicy::OnUse));
    assert_eq!(installed[2].auth_policy, Some(AgentPluginAuthPolicy::None));
    assert_eq!(installed[3].auth_policy, None);
    assert_eq!(installed[4].auth_policy, None);
}

#[test]
fn malformed_mcp_wrapper_degrades_only_details_and_default_hook_files_are_not_inferred() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    std::fs::create_dir_all(root.join("hooks")).unwrap();
    std::fs::write(
        root.join(".mcp.json"),
        r#"{"mcp_servers":"secret-server-name","command":"secret-command"}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("hooks/hooks.json"),
        r#"{"hooks":{"SecretDefaultEvent":[{"hooks":[{"command":"secret-hook"}]}]}}"#,
    )
    .unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        r#"{"name":"fixture","mcpServers":"./.mcp.json"}"#,
    )
    .unwrap();
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed":[{
            "pluginId":"fixture",
            "marketplaceName":"market",
            "installed":true,
            "enabled":true,
            "source":{"source":"local","path":root}
        }],
        "available":[]
    }))
    .unwrap();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &OwnedFixtureAdapter { stdout },
    );
    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("组件字段不兼容不能否定 CLI 投影");
    };

    let plugin = &installed[0];
    assert!(plugin.details.mcp_servers.is_empty());
    assert!(plugin.details.hook_events.is_empty());
    assert!(plugin.details.browser_extensions.is_empty());
    assert!(plugin.details.custom_ui.is_empty());
    assert_eq!(
        plugin.details.completeness,
        AgentPluginDetailsCompleteness::Incomplete
    );
    assert!(plugin
        .details
        .issues
        .contains(&AgentPluginDetailsIssue::ManifestIncompatible));
    let serialized = serde_json::to_string(plugin).unwrap();
    for secret in [
        "secret-server-name",
        "secret-command",
        "SecretDefaultEvent",
        "secret-hook",
    ] {
        assert!(!serialized.contains(secret));
    }
}

#[test]
fn safe_logo_can_replace_an_unsafe_composer_icon_without_hiding_the_warning() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(
        root.join("assets/logo.png"),
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        )
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        r#"{"name":"fixture","interface":{"composerIcon":"https://example.com/unsafe.png","logo":"./assets/logo.png"}}"#,
    )
    .unwrap();
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed":[{
            "pluginId":"fixture",
            "marketplaceName":"market",
            "installed":true,
            "enabled":true,
            "source":{"source":"local","path":root}
        }],
        "available":[]
    }))
    .unwrap();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &OwnedFixtureAdapter { stdout },
    );
    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("视觉候选失败不能破坏状态投影");
    };
    let details = &installed[0].details;

    assert!(details
        .icon_data_url
        .as_deref()
        .is_some_and(|value| value.starts_with("data:image/png;base64,")));
    assert_eq!(
        details.completeness,
        AgentPluginDetailsCompleteness::Incomplete
    );
    assert!(details
        .issues
        .contains(&AgentPluginDetailsIssue::ResourceRejected));
}

#[test]
fn image_dimensions_are_bounded_even_when_the_png_file_is_small() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    std::fs::create_dir_all(root.join("assets")).unwrap();
    image::RgbaImage::new(5000, 1)
        .save(root.join("assets/wide.png"))
        .unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        r#"{"name":"fixture","interface":{"logo":"./assets/wide.png"}}"#,
    )
    .unwrap();
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed":[{
            "pluginId":"fixture",
            "marketplaceName":"market",
            "installed":true,
            "enabled":true,
            "source":{"source":"local","path":root}
        }],
        "available":[]
    }))
    .unwrap();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &OwnedFixtureAdapter { stdout },
    );
    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("不安全图片不能破坏状态投影");
    };
    let details = &installed[0].details;

    assert!(details.icon_data_url.is_none());
    assert_eq!(
        details.completeness,
        AgentPluginDetailsCompleteness::Incomplete
    );
    assert!(details
        .issues
        .contains(&AgentPluginDetailsIssue::ResourceRejected));
}

#[test]
fn missing_invalid_and_incompatible_manifests_degrade_only_their_own_cli_entries() {
    let temp = tempfile::tempdir().unwrap();
    let fixtures = [
        (
            "partial",
            Some(r#"{"name":"manifest-name","description":"部分字段仍然有效"}"#),
        ),
        ("missing", None),
        ("invalid", Some("{not-json")),
        (
            "incompatible",
            Some(r#"{"name":"fixture","interface":"wrong-type"}"#),
        ),
    ];
    let mut entries = Vec::new();
    for (id, manifest) in fixtures {
        let root = temp.path().join(id);
        std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        if let Some(manifest) = manifest {
            std::fs::write(root.join(".codex-plugin/plugin.json"), manifest).unwrap();
        }
        entries.push(serde_json::json!({
            "pluginId":id,
            "name":format!("CLI {id}"),
            "marketplaceName":"market",
            "installed":true,
            "enabled":true,
            "source":{"source":"local","path":root}
        }));
    }
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed":entries,
        "available":[]
    }))
    .unwrap();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &OwnedFixtureAdapter { stdout },
    );
    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("manifest 资料质量不得提升为 Agent 失败");
    };

    assert_eq!(installed.len(), 4);
    let partial = &installed[0];
    assert_eq!(partial.display_name, "CLI partial");
    assert_eq!(
        partial.details.description.as_deref(),
        Some("部分字段仍然有效")
    );
    assert_eq!(
        partial.details.completeness,
        AgentPluginDetailsCompleteness::Complete
    );
    for (index, issue) in [
        AgentPluginDetailsIssue::ManifestMissing,
        AgentPluginDetailsIssue::ManifestInvalid,
        AgentPluginDetailsIssue::ManifestIncompatible,
    ]
    .into_iter()
    .enumerate()
    {
        let plugin = &installed[index + 1];
        assert_eq!(
            plugin.details.completeness,
            AgentPluginDetailsCompleteness::Incomplete
        );
        assert!(plugin.details.issues.contains(&issue));
        assert!(plugin.details.skills.is_empty());
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
                    auth_policy: Some(AgentPluginAuthPolicy::OnInstall),
                    details: AgentPluginDetails::default(),
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
                    details: AgentPluginDetails::default(),
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
                details: AgentPluginDetails::default(),
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

#[test]
fn explicit_cli_path_is_revalidated_immediately_before_each_catalog_execution() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("codex");
    std::fs::write(&executable, b"fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();
    }
    let adapter = codex::CodexCatalogAdapter::with_explicit_executable(executable.clone());
    std::fs::remove_file(executable).unwrap();

    let projection = get_agent_plugin_projection_with_adapter(AgentPluginAgent::Codex, &adapter);

    assert!(matches!(
        projection,
        AgentPluginProjection::Error {
            error: AgentPluginCatalogError {
                kind: AgentPluginCatalogErrorKind::ConfiguredPathInvalid,
                ..
            },
            ..
        }
    ));
}

#[cfg(unix)]
#[test]
fn configured_cli_path_drives_the_public_catalog_projection() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("custom-codex");
    std::fs::write(
        &executable,
        r#"#!/bin/sh
printf '%s' '{"installed":[{"pluginId":"configured","marketplaceName":"fixture","installed":true,"enabled":true}],"available":[]}'
"#,
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&executable, permissions).unwrap();

    let projection = get_agent_plugin_projection(
        AgentPluginAgent::Codex,
        Some(executable.to_string_lossy().as_ref()),
    );

    assert!(matches!(
        projection,
        AgentPluginProjection::Ready { installed, .. }
            if installed.len() == 1 && installed[0].identity.plugin_id == "configured"
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
