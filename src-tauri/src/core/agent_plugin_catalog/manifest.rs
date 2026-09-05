use super::{
    AgentPluginDetails, AgentPluginDetailsCompleteness, AgentPluginDetailsIssue, AgentPluginSkill,
    AgentPluginTechnicalDetails,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_COMPONENT_BYTES: u64 = 256 * 1024;
const MAX_SKILL_BYTES: u64 = 128 * 1024;
const MAX_IMAGE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 4096;
const MAX_IMAGE_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_TEXT_LENGTH: usize = 4096;
const MAX_COLLECTION_ITEMS: usize = 128;
const MAX_SCREENSHOTS: usize = 4;
const MAX_COMPONENT_LABEL_LENGTH: usize = 128;
const BROWSER_EXTENSION_CAPABILITY_PREFIX: &str = "browser-extension:";
const CUSTOM_UI_CAPABILITY_PREFIX: &str = "custom-ui:";

pub(super) fn enrich_from_manifest(
    cli_entry: &Map<String, Value>,
    cli_display_name: String,
) -> (String, AgentPluginDetails) {
    let source = cli_entry.get("source").and_then(Value::as_object);
    let source_type = source
        .and_then(|value| value.get("source"))
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
        })
        .map(ToOwned::to_owned);
    let root = source
        .and_then(|value| value.get("path"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let technical = AgentPluginTechnicalDetails {
        source_type,
        location: root.as_deref().map(compact_location),
    };
    let Some(root) = root else {
        return (
            cli_display_name,
            incomplete_details(technical, AgentPluginDetailsIssue::PluginRootUnavailable),
        );
    };
    let Ok(canonical_root) = root.canonicalize() else {
        return (
            cli_display_name,
            incomplete_details(technical, AgentPluginDetailsIssue::PluginRootUnavailable),
        );
    };
    if !canonical_root.is_dir() {
        return (
            cli_display_name,
            incomplete_details(technical, AgentPluginDetailsIssue::PluginRootUnavailable),
        );
    }

    let manifest_path = canonical_root.join(".codex-plugin/plugin.json");
    let manifest_bytes =
        match read_regular_file(&canonical_root, &manifest_path, MAX_MANIFEST_BYTES) {
            Ok(bytes) => bytes,
            Err(ReadFailure::Missing) => {
                return (
                    cli_display_name,
                    incomplete_details(technical, AgentPluginDetailsIssue::ManifestMissing),
                )
            }
            Err(_) => {
                return (
                    cli_display_name,
                    incomplete_details(technical, AgentPluginDetailsIssue::ResourceRejected),
                )
            }
        };
    let manifest: Value = match serde_json::from_slice(&manifest_bytes) {
        Ok(value) => value,
        Err(_) => {
            return (
                cli_display_name,
                incomplete_details(technical, AgentPluginDetailsIssue::ManifestInvalid),
            )
        }
    };
    let Some(manifest) = manifest.as_object() else {
        return (
            cli_display_name,
            incomplete_details(technical, AgentPluginDetailsIssue::ManifestIncompatible),
        );
    };

    let mut reader = ManifestReader::new(&canonical_root, technical);
    let interface = match manifest.get("interface") {
        None | Some(Value::Null) => None,
        Some(Value::Object(value)) => Some(value),
        Some(_) => {
            reader.issue(AgentPluginDetailsIssue::ManifestIncompatible);
            None
        }
    };
    let display_name = interface
        .and_then(|value| reader.optional_string(value, "displayName"))
        .unwrap_or(cli_display_name);
    reader.details.description = interface
        .and_then(|value| reader.optional_string(value, "longDescription"))
        .or_else(|| interface.and_then(|value| reader.optional_string(value, "shortDescription")))
        .or_else(|| reader.optional_string(manifest, "description"));
    reader.details.developer = interface
        .and_then(|value| reader.optional_string(value, "developerName"))
        .or_else(|| author_name(manifest, &mut reader));
    reader.details.category = interface.and_then(|value| reader.optional_string(value, "category"));
    if let Some(value) = interface.and_then(|value| value.get("defaultPrompt")) {
        reader.details.default_prompts = reader.string_or_string_array(value);
    }
    if let Some(value) = interface.and_then(|value| value.get("capabilities")) {
        let capabilities = reader.string_array(value);
        reader.details.declared_capabilities =
            reader.read_explicit_component_capabilities(capabilities);
    }
    if let Some(value) = manifest.get("skills") {
        reader.read_skills(value);
    }
    if let Some(value) = manifest.get("mcpServers") {
        reader.read_named_json_map(value, JsonMapKind::McpServers);
    }
    if let Some(value) = manifest.get("apps") {
        reader.read_named_json_map(value, JsonMapKind::Connectors);
    }
    if let Some(value) = manifest.get("hooks") {
        reader.read_hooks(value);
    }
    if let Some(interface) = interface {
        for key in ["composerIcon", "logo"] {
            if reader.details.icon_data_url.is_some() {
                break;
            }
            if let Some(value) = interface.get(key) {
                reader.read_icon(value);
            }
        }
    }
    if let Some(value) = interface.and_then(|value| value.get("screenshots")) {
        reader.read_screenshots(value);
    }
    reader.finish();
    (display_name, reader.details)
}

fn incomplete_details(
    technical: AgentPluginTechnicalDetails,
    issue: AgentPluginDetailsIssue,
) -> AgentPluginDetails {
    AgentPluginDetails {
        technical,
        issues: vec![issue],
        ..AgentPluginDetails::default()
    }
}

struct ManifestReader<'a> {
    root: &'a Path,
    details: AgentPluginDetails,
}

impl<'a> ManifestReader<'a> {
    fn new(root: &'a Path, technical: AgentPluginTechnicalDetails) -> Self {
        Self {
            root,
            details: AgentPluginDetails {
                completeness: AgentPluginDetailsCompleteness::Complete,
                issues: Vec::new(),
                technical,
                ..AgentPluginDetails::default()
            },
        }
    }

    fn finish(&mut self) {
        if !self.details.issues.is_empty() {
            self.details.completeness = AgentPluginDetailsCompleteness::Incomplete;
        }
    }

    fn issue(&mut self, issue: AgentPluginDetailsIssue) {
        if !self.details.issues.contains(&issue) {
            self.details.issues.push(issue);
        }
    }

    fn optional_string(&mut self, object: &Map<String, Value>, key: &str) -> Option<String> {
        match object.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::String(value))
                if !value.trim().is_empty() && value.len() <= MAX_TEXT_LENGTH =>
            {
                Some(value.clone())
            }
            Some(_) => {
                self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
                None
            }
        }
    }

    fn string_or_string_array(&mut self, value: &Value) -> Vec<String> {
        match value {
            Value::String(value) if !value.trim().is_empty() && value.len() <= MAX_TEXT_LENGTH => {
                vec![value.clone()]
            }
            Value::Array(_) => self.string_array(value),
            _ => {
                self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
                Vec::new()
            }
        }
    }

    fn string_array(&mut self, value: &Value) -> Vec<String> {
        let Value::Array(values) = value else {
            self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
            return Vec::new();
        };
        let mut result = Vec::with_capacity(values.len().min(MAX_COLLECTION_ITEMS));
        for value in values.iter().take(MAX_COLLECTION_ITEMS) {
            match value.as_str() {
                Some(value) if !value.trim().is_empty() && value.len() <= MAX_TEXT_LENGTH => {
                    result.push(value.to_owned());
                }
                _ => self.issue(AgentPluginDetailsIssue::ManifestIncompatible),
            }
        }
        if values.len() > MAX_COLLECTION_ITEMS {
            self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
        }
        result
    }

    fn read_explicit_component_capabilities(&mut self, capabilities: Vec<String>) -> Vec<String> {
        let mut general = Vec::with_capacity(capabilities.len());
        for capability in capabilities {
            if let Some(raw_label) = capability.strip_prefix(BROWSER_EXTENSION_CAPABILITY_PREFIX) {
                if let Some(label) = explicit_component_label(raw_label) {
                    if !self.details.browser_extensions.contains(&label) {
                        self.details.browser_extensions.push(label);
                    }
                } else {
                    self.issue(AgentPluginDetailsIssue::ResourceRejected);
                }
            } else if let Some(raw_label) = capability.strip_prefix(CUSTOM_UI_CAPABILITY_PREFIX) {
                if let Some(label) = explicit_component_label(raw_label) {
                    if !self.details.custom_ui.contains(&label) {
                        self.details.custom_ui.push(label);
                    }
                } else {
                    self.issue(AgentPluginDetailsIssue::ResourceRejected);
                }
            } else {
                general.push(capability);
            }
        }
        general
    }

    fn declared_path(&mut self, value: &Value) -> Option<PathBuf> {
        let Some(value) = value.as_str() else {
            self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
            return None;
        };
        if !value.starts_with("./") || value.contains('\0') {
            self.issue(AgentPluginDetailsIssue::ResourceRejected);
            return None;
        }
        let relative = Path::new(value);
        if relative.is_absolute() {
            self.issue(AgentPluginDetailsIssue::ResourceRejected);
            return None;
        }
        Some(self.root.join(relative))
    }

    fn read_skills(&mut self, value: &Value) {
        let Some(path) = self.declared_path(value) else {
            return;
        };
        let Some(directory) = canonical_contained(self.root, &path).filter(|path| path.is_dir())
        else {
            self.issue(AgentPluginDetailsIssue::ResourceRejected);
            return;
        };
        let Ok(entries) = fs::read_dir(directory) else {
            self.issue(AgentPluginDetailsIssue::ComponentUnreadable);
            return;
        };
        let mut skill_directories = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else {
                self.issue(AgentPluginDetailsIssue::ComponentUnreadable);
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                self.issue(AgentPluginDetailsIssue::ComponentUnreadable);
                continue;
            };
            if file_type.is_symlink() {
                self.issue(AgentPluginDetailsIssue::ResourceRejected);
            } else if file_type.is_dir() {
                skill_directories.push(entry.path());
            }
        }
        skill_directories.sort();
        if skill_directories.len() > MAX_COLLECTION_ITEMS {
            self.issue(AgentPluginDetailsIssue::ResourceRejected);
        }
        for directory in skill_directories.into_iter().take(MAX_COLLECTION_ITEMS) {
            let skill_path = directory.join("SKILL.md");
            let bytes = match read_regular_file(self.root, &skill_path, MAX_SKILL_BYTES) {
                Ok(bytes) => bytes,
                Err(_) => {
                    self.issue(AgentPluginDetailsIssue::ComponentUnreadable);
                    continue;
                }
            };
            let Some(skill) = parse_skill_frontmatter(&bytes) else {
                self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
                continue;
            };
            self.details.skills.push(skill);
        }
    }

    fn read_named_json_map(&mut self, value: &Value, kind: JsonMapKind) {
        let Some(path) = self.declared_path(value) else {
            return;
        };
        let bytes = match read_regular_file(self.root, &path, MAX_COMPONENT_BYTES) {
            Ok(bytes) => bytes,
            Err(ReadFailure::Unsafe) => {
                self.issue(AgentPluginDetailsIssue::ResourceRejected);
                return;
            }
            Err(_) => {
                self.issue(AgentPluginDetailsIssue::ComponentUnreadable);
                return;
            }
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
            return;
        };
        let object = match kind {
            JsonMapKind::McpServers => value.as_object().and_then(|object| {
                if object.contains_key("mcp_servers") {
                    object.get("mcp_servers").and_then(Value::as_object)
                } else {
                    Some(object)
                }
            }),
            JsonMapKind::Connectors => value.get("apps").and_then(Value::as_object),
        };
        let Some(object) = object else {
            self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
            return;
        };
        let names = object
            .keys()
            .filter(|name| !name.trim().is_empty() && name.len() <= MAX_TEXT_LENGTH)
            .take(MAX_COLLECTION_ITEMS)
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter();
        if object.len() > MAX_COLLECTION_ITEMS
            || object
                .keys()
                .any(|name| name.trim().is_empty() || name.len() > MAX_TEXT_LENGTH)
        {
            self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
        }
        match kind {
            JsonMapKind::McpServers => self.details.mcp_servers.extend(names),
            JsonMapKind::Connectors => self.details.connectors.extend(names),
        }
    }

    fn read_hooks(&mut self, value: &Value) {
        let mut events = BTreeSet::new();
        self.collect_hook_events(value, &mut events);
        if events.len() > MAX_COLLECTION_ITEMS {
            self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
        }
        self.details
            .hook_events
            .extend(events.into_iter().take(MAX_COLLECTION_ITEMS));
    }

    fn collect_hook_events(&mut self, value: &Value, events: &mut BTreeSet<String>) {
        match value {
            Value::String(_) => {
                let Some(path) = self.declared_path(value) else {
                    return;
                };
                let bytes = match read_regular_file(self.root, &path, MAX_COMPONENT_BYTES) {
                    Ok(bytes) => bytes,
                    Err(ReadFailure::Unsafe) => {
                        self.issue(AgentPluginDetailsIssue::ResourceRejected);
                        return;
                    }
                    Err(_) => {
                        self.issue(AgentPluginDetailsIssue::ComponentUnreadable);
                        return;
                    }
                };
                match serde_json::from_slice::<Value>(&bytes) {
                    Ok(value) => self.collect_hook_events(&value, events),
                    Err(_) => self.issue(AgentPluginDetailsIssue::ManifestIncompatible),
                }
            }
            Value::Array(values) => {
                for value in values {
                    self.collect_hook_events(value, events);
                }
            }
            Value::Object(object) => {
                let Some(hooks) = object.get("hooks").and_then(Value::as_object) else {
                    self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
                    return;
                };
                events.extend(hooks.keys().cloned());
            }
            _ => self.issue(AgentPluginDetailsIssue::ManifestIncompatible),
        }
    }

    fn read_icon(&mut self, value: &Value) {
        self.details.icon_data_url = self.read_png_data_url(value, ImagePurpose::Icon);
    }

    fn read_screenshots(&mut self, value: &Value) {
        let Value::Array(values) = value else {
            self.issue(AgentPluginDetailsIssue::ManifestIncompatible);
            return;
        };
        for value in values.iter().take(MAX_SCREENSHOTS) {
            if let Some(data_url) = self.read_png_data_url(value, ImagePurpose::Screenshot) {
                self.details.screenshot_data_urls.push(data_url);
            }
        }
        if values.len() > MAX_SCREENSHOTS {
            self.issue(AgentPluginDetailsIssue::ResourceRejected);
        }
    }

    fn read_png_data_url(&mut self, value: &Value, purpose: ImagePurpose) -> Option<String> {
        let path = self.declared_path(value)?;
        let bytes = match read_regular_file(self.root, &path, MAX_IMAGE_BYTES) {
            Ok(bytes) => bytes,
            Err(ReadFailure::Unsafe | ReadFailure::TooLarge) => {
                self.issue(AgentPluginDetailsIssue::ResourceRejected);
                return None;
            }
            Err(_) => {
                self.issue(AgentPluginDetailsIssue::ComponentUnreadable);
                return None;
            }
        };
        let dimensions =
            image::ImageReader::with_format(Cursor::new(bytes.as_slice()), image::ImageFormat::Png)
                .into_dimensions();
        let valid_dimensions = dimensions.is_ok_and(|(width, height)| {
            width > 0
                && height > 0
                && width <= MAX_IMAGE_EDGE
                && height <= MAX_IMAGE_EDGE
                && u64::from(width) * u64::from(height) <= MAX_IMAGE_PIXELS
        });
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png);
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || !valid_dimensions || decoded.is_err() {
            self.issue(AgentPluginDetailsIssue::ResourceRejected);
            return None;
        }
        let decoded = decoded.expect("上方已经确认图片解码成功");
        let (width, height, max_output_bytes) = match purpose {
            ImagePurpose::Icon => (128, 128, 256 * 1024),
            ImagePurpose::Screenshot => (640, 400, 1024 * 1024),
        };
        let safe_pixels = decoded.thumbnail(width, height);
        let mut sanitized = Cursor::new(Vec::new());
        if safe_pixels
            .write_to(&mut sanitized, image::ImageFormat::Png)
            .is_err()
        {
            self.issue(AgentPluginDetailsIssue::ResourceRejected);
            return None;
        }
        let sanitized = sanitized.into_inner();
        if sanitized.len() > max_output_bytes {
            self.issue(AgentPluginDetailsIssue::ResourceRejected);
            return None;
        }
        Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(sanitized)
        ))
    }
}

fn explicit_component_label(value: &str) -> Option<String> {
    let label = value.trim();
    (!label.is_empty()
        && label.len() <= MAX_COMPONENT_LABEL_LENGTH
        && !label.contains(['/', '\\'])
        && label.chars().all(|character| !character.is_control()))
    .then(|| label.to_owned())
}

#[derive(Clone, Copy)]
enum JsonMapKind {
    McpServers,
    Connectors,
}

#[derive(Clone, Copy)]
enum ImagePurpose {
    Icon,
    Screenshot,
}

#[derive(Clone, Copy)]
enum ReadFailure {
    Missing,
    Unsafe,
    TooLarge,
    Io,
}

fn read_regular_file(root: &Path, path: &Path, max_bytes: u64) -> Result<Vec<u8>, ReadFailure> {
    let metadata = fs::metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ReadFailure::Missing
        } else {
            ReadFailure::Io
        }
    })?;
    let Some(canonical) = canonical_contained(root, path) else {
        return Err(ReadFailure::Unsafe);
    };
    if !metadata.is_file() {
        return Err(ReadFailure::Unsafe);
    }
    if metadata.len() > max_bytes {
        return Err(ReadFailure::TooLarge);
    }
    fs::read(canonical).map_err(|_| ReadFailure::Io)
}

fn canonical_contained(root: &Path, path: &Path) -> Option<PathBuf> {
    let canonical_root = root.canonicalize().ok()?;
    let canonical_path = path.canonicalize().ok()?;
    canonical_path
        .starts_with(&canonical_root)
        .then_some(canonical_path)
}

fn author_name(manifest: &Map<String, Value>, reader: &mut ManifestReader<'_>) -> Option<String> {
    match manifest.get("author") {
        None | Some(Value::Null) => None,
        Some(Value::Object(author)) => reader.optional_string(author, "name"),
        Some(_) => {
            reader.issue(AgentPluginDetailsIssue::ManifestIncompatible);
            None
        }
    }
}

fn parse_skill_frontmatter(bytes: &[u8]) -> Option<AgentPluginSkill> {
    let content = std::str::from_utf8(bytes).ok()?.trim();
    let rest = content.strip_prefix("---")?;
    let end = rest.find("---")?;
    let yaml = serde_yaml::from_str::<serde_yaml::Value>(&rest[..end]).ok()?;
    let name = yaml.get("name")?.as_str()?.trim();
    if name.is_empty() || name.len() > MAX_TEXT_LENGTH {
        return None;
    }
    let description = yaml
        .get("description")
        .and_then(serde_yaml::Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= MAX_TEXT_LENGTH)
        .map(ToOwned::to_owned);
    Some(AgentPluginSkill {
        name: name.to_owned(),
        description,
    })
}

fn compact_location(path: &Path) -> String {
    let suffix = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .chars()
                .filter(|character| !character.is_control())
                .take(80)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "plugin".into());
    if dirs::home_dir().is_some_and(|home| path.starts_with(home)) {
        format!("~/…/{suffix}")
    } else {
        format!("…/{suffix}")
    }
}
