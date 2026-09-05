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

struct RemoteInstalledFixtureAdapter {
    catalog_stdout: &'static [u8],
    installed_result: Result<&'static [u8], AgentPluginCatalogError>,
}

struct InstalledOnlyFixtureAdapter {
    installed: &'static [u8],
}

impl CatalogAdapter for RemoteInstalledFixtureAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
        Ok(CatalogCommandOutput {
            stdout: self.catalog_stdout.to_vec(),
        })
    }

    fn read_installed(&self) -> Option<Result<Vec<u8>, AgentPluginCatalogError>> {
        Some(self.installed_result.clone().map(ToOwned::to_owned))
    }
}

impl CatalogAdapter for InstalledOnlyFixtureAdapter {
    fn read(&self) -> Result<CatalogCommandOutput, AgentPluginCatalogError> {
        Err(catalog_error(AgentPluginCatalogErrorKind::TimedOut, None))
    }

    fn read_installed(&self) -> Option<Result<Vec<u8>, AgentPluginCatalogError>> {
        Some(Ok(self.installed.to_vec()))
    }
}

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
fn namespaced_manifest_capabilities_explicitly_declare_browser_extensions_and_custom_ui() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        r#"{
          "name":"explicit-components",
          "interface":{
            "capabilities":[
              "Interactive",
              "browser-extension: Chrome session bridge",
              "custom-ui: Review dashboard"
            ]
          }
        }"#,
    )
    .unwrap();
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed":[{
            "pluginId":"explicit-components",
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
        panic!("显式组件声明应保留就绪投影");
    };
    let details = &installed[0].details;

    assert_eq!(details.browser_extensions, ["Chrome session bridge"]);
    assert_eq!(details.custom_ui, ["Review dashboard"]);
    assert_eq!(details.declared_capabilities, ["Interactive"]);
    assert_eq!(
        details.completeness,
        AgentPluginDetailsCompleteness::Complete
    );
}

#[test]
fn generic_labels_unknown_fields_and_unsafe_names_do_not_infer_plugin_components() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        r#"{
          "name":"no-inference",
          "browserExtensions":["guessed-from-unknown-field"],
          "customUi":["guessed-from-unknown-field"],
          "interface":{
            "capabilities":[
              "Interactive",
              "Browser",
              "Custom UI",
              "browser-extension: ../private/extension",
              "custom-ui: https://secret.example/widget"
            ]
          }
        }"#,
    )
    .unwrap();
    let stdout = serde_json::to_vec(&serde_json::json!({
        "installed":[{
            "pluginId":"browser-brand-does-not-count",
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
        panic!("未知或不安全的声明应只降级当前详情");
    };
    let details = &installed[0].details;

    assert!(details.browser_extensions.is_empty());
    assert!(details.custom_ui.is_empty());
    assert_eq!(
        details.declared_capabilities,
        ["Interactive", "Browser", "Custom UI"]
    );
    assert_eq!(
        details.completeness,
        AgentPluginDetailsCompleteness::Incomplete
    );
    assert!(details
        .issues
        .contains(&AgentPluginDetailsIssue::ResourceRejected));
    let serialized = serde_json::to_string(details).unwrap();
    assert!(!serialized.contains("private/extension"));
    assert!(!serialized.contains("secret.example"));
    assert!(!serialized.contains("guessed-from-unknown-field"));
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
fn unsafe_visual_resources_fall_back_without_reducing_detail_completeness() {
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
    for (id, _, _) in cases {
        let plugin = installed
            .iter()
            .find(|plugin| plugin.identity.plugin_id == id)
            .unwrap();
        assert_eq!(
            plugin.details.completeness,
            AgentPluginDetailsCompleteness::Complete
        );
        assert!(plugin.details.icon_data_url.is_none());
        assert!(plugin.details.issues.is_empty());
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
fn safe_logo_can_replace_an_unsafe_composer_icon_without_marking_details_incomplete() {
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
        AgentPluginDetailsCompleteness::Complete
    );
    assert!(details.issues.is_empty());
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
        AgentPluginDetailsCompleteness::Complete
    );
    assert!(details.issues.is_empty());
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
fn app_server_installed_state_replaces_the_cli_subset_and_keeps_available_plugins() {
    let catalog = r#"{
      "installed":[{
        "pluginId":"local-only","name":"本地子集","marketplaceName":"openai-bundled",
        "version":"1.0.0","installed":true,"enabled":true
      }],
      "available":[{
        "pluginId":"available-only","name":"可安装插件","marketplaceName":"marketplace",
        "version":"2.0.0","installed":false,"enabled":false
      }]
    }"#
    .as_bytes();
    let installed = r#"{
      "marketplaces":[{
        "name":"openai-curated-remote","path":null,"interface":null,"plugins":[
          {
            "id":"github@openai-curated-remote","remotePluginId":"github","version":"1.2.3",
            "localVersion":"1.2.2","name":"github","source":{"type":"remote"},
            "installed":true,"enabled":true,"installPolicy":"AVAILABLE","authPolicy":"ON_USE",
            "interface":{
              "displayName":"GitHub","shortDescription":"处理仓库和拉取请求",
              "longDescription":"读取 GitHub 仓库并处理拉取请求。","developerName":"GitHub",
              "category":"Developer Tools","capabilities":["Read","Write"],
              "defaultPrompt":["检查我的拉取请求"],
              "composerIconUrl":"https://example.com/github.png","logoUrl":null
            }
          },
          {
            "id":"vercel@openai-curated-remote","remotePluginId":"vercel","version":"0.21.4",
            "localVersion":"0.21.4","name":"vercel","source":{"type":"remote"},
            "installed":true,"enabled":true,"installPolicy":"AVAILABLE","authPolicy":"ON_INSTALL",
            "interface":{"displayName":"Vercel","logoUrl":"https://example.com/vercel.png"}
          }
        ]
      }],
      "marketplaceLoadErrors":[]
    }"#
    .as_bytes();

    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &RemoteInstalledFixtureAdapter {
            catalog_stdout: catalog,
            installed_result: Ok(installed),
        },
    );

    let AgentPluginProjection::Ready {
        installed,
        available,
        installed_complete,
        available_complete,
        ..
    } = projection
    else {
        panic!("合法的 App Server 已安装状态应生成就绪投影");
    };
    assert!(installed_complete);
    assert!(available_complete);
    assert_eq!(
        installed
            .iter()
            .map(|plugin| plugin.identity.plugin_id.as_str())
            .collect::<Vec<_>>(),
        [
            "github@openai-curated-remote",
            "vercel@openai-curated-remote"
        ]
    );
    assert_eq!(available[0].identity.plugin_id, "available-only");
    assert_eq!(installed[0].display_name, "GitHub");
    assert_eq!(installed[0].version.as_deref(), Some("1.2.2"));
    assert_eq!(installed[0].details.developer.as_deref(), Some("GitHub"));
    assert_eq!(
        installed[0].details.icon_url.as_deref(),
        Some("https://example.com/github.png")
    );
}

#[test]
fn app_server_failure_preserves_the_cli_subset_as_an_explicit_partial_projection() {
    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &RemoteInstalledFixtureAdapter {
            catalog_stdout: br#"{
              "installed":[{"pluginId":"local-only","marketplaceName":"bundled","installed":true,"enabled":true}],
              "available":[]
            }"#,
            installed_result: Err(catalog_error(AgentPluginCatalogErrorKind::TimedOut, None)),
        },
    );

    assert!(matches!(
        projection,
        AgentPluginProjection::Ready {
            installed,
            installed_complete: false,
            available_complete: true,
            ..
        } if installed.len() == 1 && installed[0].identity.plugin_id == "local-only"
    ));
}

#[test]
fn cli_catalog_failure_preserves_the_app_server_installed_collection() {
    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &InstalledOnlyFixtureAdapter {
            installed: br#"{
              "marketplaces":[{"name":"openai-curated-remote","plugins":[{
                "id":"github@openai-curated-remote","name":"github","source":{"type":"remote"},
                "installed":true,"enabled":true,"interface":{"displayName":"GitHub"}
              }]}],
              "marketplaceLoadErrors":[]
            }"#,
        },
    );

    assert!(matches!(
        projection,
        AgentPluginProjection::Ready {
            installed,
            available,
            installed_complete: true,
            available_complete: false,
            ..
        }
          if installed.len() == 1
            && installed[0].identity.plugin_id == "github@openai-curated-remote"
            && available.is_empty()
    ));
}

#[test]
fn app_server_identity_keeps_matching_cli_manifest_details_for_local_plugins() {
    let projection = get_agent_plugin_projection_with_adapter(
        AgentPluginAgent::Codex,
        &RemoteInstalledFixtureAdapter {
            catalog_stdout: br#"{
              "installed":[{"pluginId":"local@bundled","marketplaceName":"bundled","installed":true,"enabled":true}],
              "available":[]
            }"#,
            installed_result: Ok(br#"{
              "marketplaces":[{"name":"bundled","plugins":[{
                "id":"local@bundled","name":"local","source":{"type":"local"},
                "installed":true,"enabled":true,"interface":{"longDescription":"summary"}
              }]}],
              "marketplaceLoadErrors":[]
            }"#),
        },
    );

    let AgentPluginProjection::Ready { installed, .. } = projection else {
        panic!("匹配的本地身份应保留就绪投影");
    };
    assert_eq!(
        installed[0].details.issues,
        [AgentPluginDetailsIssue::PluginRootUnavailable]
    );
    assert_eq!(installed[0].details.technical.source_type, None);
}

#[test]
fn app_server_plugin_read_returns_complete_remote_components_without_exposing_paths() {
    let identity = AgentPluginIdentity {
        agent: AgentPluginAgent::Codex,
        marketplace_name: "openai-curated-remote".into(),
        plugin_id: "vercel@openai-curated-remote".into(),
    };
    let response = r#"{
      "plugin":{
        "marketplaceName":"openai-curated-remote",
        "marketplacePath":null,
        "summary":{
          "id":"vercel@openai-curated-remote","name":"vercel","source":{"type":"remote"},
          "interface":{
            "displayName":"Vercel","longDescription":"构建并部署应用。",
            "developerName":"Vercel","category":"Developer Tools",
            "capabilities":["Read","Write"],"defaultPrompt":["检查部署"],
            "logoUrl":"https://example.com/vercel.png"
          }
        },
        "description":"完整的 Vercel 插件说明。",
        "skills":[{"name":"vercel-cli","description":"操作 Vercel CLI","path":"/secret/path"}],
        "hooks":[{"key":"session","eventName":"SessionStart"}],
        "apps":[{"id":"secret-app-id","name":"Vercel Connector","description":null}],
        "appTemplates":[],
        "mcpServers":["vercel"],
        "scheduledTasks":null,
        "shareUrl":null
      }
    }"#;

    let details = parse_app_server_details(&identity, response.as_bytes()).unwrap();

    assert_eq!(
        details.completeness,
        AgentPluginDetailsCompleteness::Complete
    );
    assert!(details.issues.is_empty());
    assert_eq!(
        details.description.as_deref(),
        Some("完整的 Vercel 插件说明。")
    );
    assert_eq!(details.skills[0].name, "vercel-cli");
    assert_eq!(details.hook_events, ["SessionStart"]);
    assert_eq!(details.connectors, ["Vercel Connector"]);
    assert_eq!(details.mcp_servers, ["vercel"]);
    assert_eq!(
        details.icon_url.as_deref(),
        Some("https://example.com/vercel.png")
    );
    assert!(!serde_json::to_string(&details)
        .unwrap()
        .contains("/secret/path"));
    assert!(!serde_json::to_string(&details)
        .unwrap()
        .contains("secret-app-id"));
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

#[test]
fn debug_acceptance_summary_compares_raw_and_projected_identities_without_storing_rows() {
    let raw = br#"{
      "installed":[{"pluginId":"one","marketplaceName":"market-a","installed":true,"enabled":true}],
      "available":[{"pluginId":"two","marketplaceName":"market-b","installed":false,"enabled":false}]
    }"#;
    let (installed, available) = parse_projection(AgentPluginAgent::Codex, raw).unwrap();

    let evidence = acceptance::build_identity_evidence(raw, None, &installed, &available).unwrap();

    assert_eq!(
        (
            evidence.installed.raw_count,
            evidence.installed.projected_count,
            evidence.available.raw_count,
            evidence.available.projected_count,
        ),
        (1, 1, 1, 1)
    );
    assert!(evidence.installed.identities_match);
    assert!(evidence.available.identities_match);
    assert!(evidence.all_collections_match);
    assert_eq!(
        evidence.installed.raw_sha256,
        evidence.installed.projected_sha256
    );
    let serialized = serde_json::to_string(&evidence).unwrap();
    assert!(serialized.contains("\"installed_source\":\"cli\""));
    assert!(serialized.contains("\"installed\":{\"raw_count\":1,\"projected_count\":1"));
    assert!(serialized.contains("\"available\":{\"raw_count\":1,\"projected_count\":1"));
    assert!(serialized.contains("\"all_collections_match\":true"));
    assert!(!serialized.contains("raw_installed"));
    assert!(!serialized.contains("market-a"));
    assert!(!serialized.contains("market-b"));
    assert!(!serialized.contains("\"one\""));
    assert!(!serialized.contains("\"two\""));
}

#[test]
fn debug_acceptance_summary_rejects_identities_swapped_between_status_collections() {
    let raw = br#"{
      "installed":[{"pluginId":"one","marketplaceName":"market","installed":true,"enabled":true}],
      "available":[{"pluginId":"two","marketplaceName":"market","installed":false,"enabled":false}]
    }"#;
    let swapped = br#"{
      "installed":[{"pluginId":"two","marketplaceName":"market","installed":true,"enabled":true}],
      "available":[{"pluginId":"one","marketplaceName":"market","installed":false,"enabled":false}]
    }"#;
    let (installed, available) = parse_projection(AgentPluginAgent::Codex, swapped).unwrap();

    let evidence = acceptance::build_identity_evidence(raw, None, &installed, &available).unwrap();

    assert!(!evidence.installed.identities_match);
    assert!(!evidence.available.identities_match);
    assert!(!evidence.all_collections_match);
}

#[test]
fn debug_acceptance_compares_installed_identities_to_app_server_without_a_fixed_count() {
    let catalog = br#"{
      "installed":[{"pluginId":"local","marketplaceName":"bundled","installed":true,"enabled":true}],
      "available":[{"pluginId":"available","marketplaceName":"market","installed":false,"enabled":false}]
    }"#;
    let app_server = br#"{
      "marketplaces":[{"name":"remote","plugins":[
        {"id":"github@remote"},{"id":"vercel@remote"}
      ]}],
      "marketplaceLoadErrors":[]
    }"#;
    let installed = vec![
        AgentPluginSummary {
            identity: AgentPluginIdentity {
                agent: AgentPluginAgent::Codex,
                marketplace_name: "remote".into(),
                plugin_id: "github@remote".into(),
            },
            display_name: "GitHub".into(),
            version: None,
            install_status: AgentPluginInstallStatus::InstalledEnabled,
            update_available: None,
            install_policy: None,
            auth_policy: None,
            details: AgentPluginDetails::default(),
        },
        AgentPluginSummary {
            identity: AgentPluginIdentity {
                agent: AgentPluginAgent::Codex,
                marketplace_name: "remote".into(),
                plugin_id: "vercel@remote".into(),
            },
            display_name: "Vercel".into(),
            version: None,
            install_status: AgentPluginInstallStatus::InstalledEnabled,
            update_available: None,
            install_policy: None,
            auth_policy: None,
            details: AgentPluginDetails::default(),
        },
    ];
    let (_, available) = parse_projection(AgentPluginAgent::Codex, catalog).unwrap();

    let evidence =
        acceptance::build_identity_evidence(catalog, Some(app_server), &installed, &available)
            .unwrap();

    assert_eq!(evidence.installed_source, "app_server");
    assert_eq!(evidence.installed.raw_count, 2);
    assert!(evidence.all_collections_match);
}
