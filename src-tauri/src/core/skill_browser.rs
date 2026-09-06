use super::{
    error::AppError,
    git_fetcher,
    skill_store::{SkillRecord, SkillStore},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub const MAX_PREVIEW_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct BrowserEntry {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub error: Option<String>,
    pub link_target: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BrowserIndex {
    pub skill_id: String,
    pub session_id: String,
    pub entry_path: Option<String>,
    pub entries: Vec<BrowserEntry>,
    pub file_count: usize,
    pub directory_count: usize,
    pub complete: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct FilePreview {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub text: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SourceIndex {
    pub index: BrowserIndex,
    pub source_label: String,
    pub location: String,
    pub revision: String,
}

#[derive(Debug, Serialize)]
pub struct BrowserComparison {
    pub path: String,
    pub local: Option<BrowserEntry>,
    pub source: Option<BrowserEntry>,
    pub local_presence: String,
    pub source_presence: String,
    pub status: Option<String>,
    pub reason: Option<String>,
    pub reason_code: Option<String>,
    pub content_changed: Option<bool>,
    pub exec_bits_before: Option<u32>,
    pub exec_bits_after: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct BrowserDiff {
    pub index: BrowserIndex,
    pub entries: Vec<BrowserComparison>,
    pub changed_file_count: usize,
    pub source_label: String,
    pub revision: String,
}

#[derive(Default)]
pub struct SkillBrowser {
    sessions: Mutex<HashMap<String, Arc<BrowserSession>>>,
}

struct BrowserSession {
    skill: SkillRecord,
    proxy_url: Option<String>,
    local: Snapshot,
    source: Mutex<Option<Arc<SourceSnapshot>>>,
    cancelled: Arc<AtomicBool>,
}

struct SourceSnapshot {
    snapshot: Snapshot,
    info: SourceIndex,
    _checkout: Option<SourceCheckout>,
}

struct SourceCheckout(PathBuf);
impl Drop for SourceCheckout {
    fn drop(&mut self) {
        git_fetcher::cleanup_temp(&self.0);
    }
}

struct Snapshot {
    root: PathBuf,
    stamps: HashMap<String, String>,
    incomplete_paths: Vec<String>,
    index: BrowserIndex,
}

impl Snapshot {
    fn open(path: &Path, skill_id: &str, session_id: &str) -> Result<Self, AppError> {
        let root = Directory::open(path).map_err(AppError::io)?;
        let mut stamps = HashMap::new();
        let mut entries = Vec::new();
        let mut issues = Vec::new();
        let mut incomplete_paths = Vec::new();
        scan(
            &root,
            "",
            &mut entries,
            &mut stamps,
            &mut issues,
            &mut incomplete_paths,
        );
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let candidates = [
            "SKILL.md",
            "skill.md",
            "CLAUDE.md",
            "claude.md",
            "README.md",
            "readme.md",
        ];
        let entry_path = candidates
            .iter()
            .find_map(|name| {
                entries
                    .iter()
                    .find(|entry| entry.path == *name && entry.kind == "file")
                    .map(|entry| entry.path.clone())
            })
            .or_else(|| {
                entries
                    .iter()
                    .find(|entry| {
                        entry.kind == "file"
                            && entry
                                .path
                                .rsplit('/')
                                .next()
                                .is_some_and(|name| candidates.contains(&name))
                    })
                    .map(|entry| entry.path.clone())
            });
        let index = BrowserIndex {
            skill_id: skill_id.into(),
            session_id: session_id.into(),
            entry_path,
            file_count: entries
                .iter()
                .filter(|entry| entry.kind != "directory")
                .count(),
            directory_count: entries
                .iter()
                .filter(|entry| entry.kind == "directory")
                .count(),
            complete: issues.is_empty(),
            entries,
            issues,
        };
        Ok(Self {
            root: root.path.clone(),
            stamps,
            incomplete_paths,
            index,
        })
    }

    fn validate(&self) -> Result<(), AppError> {
        let root = Directory::open(&self.root).map_err(|_| AppError::stale_snapshot())?;
        let mut stamps = HashMap::new();
        scan(
            &root,
            "",
            &mut Vec::new(),
            &mut stamps,
            &mut Vec::new(),
            &mut Vec::new(),
        );
        if stamps != self.stamps {
            return Err(AppError::stale_snapshot());
        }
        Ok(())
    }

    fn absence_unknown(&self, path: &str) -> bool {
        self.incomplete_paths.iter().any(|prefix| {
            prefix.is_empty() || path == prefix || path.starts_with(&format!("{prefix}/"))
        })
    }

    fn with_entry<T>(
        &self,
        path: &str,
        read: impl FnOnce(&BrowserEntry, Option<&File>) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        validate_relative_path(path)?;
        let entry = self
            .index
            .entries
            .iter()
            .find(|entry| entry.path == path)
            .ok_or_else(|| {
                self.validate().err().unwrap_or_else(|| {
                    if !self.absence_unknown(path) {
                        AppError::not_found("此版本中没有该文件")
                    } else {
                        AppError::unknown_presence()
                    }
                })
            })?;
        if entry.error.is_some() {
            return read(entry, None);
        }
        let changed = AppError::stale_snapshot;
        // 所有读取共享目录句柄链，Windows 也在读后复验完成前保留祖先句柄。
        let mut directories = vec![Directory::open(&self.root).map_err(|_| changed())?];
        if Some(&directories[0].stamp().map_err(|_| changed())?) != self.stamps.get("") {
            return Err(changed());
        }
        let parts: Vec<_> = path.split('/').collect();
        let mut prefix = String::new();
        for part in &parts[..parts.len() - 1] {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let directory = directories
                .last()
                .unwrap()
                .child(part)
                .map_err(|_| changed())?;
            if Some(&directory.stamp().map_err(|_| changed())?) != self.stamps.get(&prefix) {
                return Err(changed());
            }
            directories.push(directory);
        }
        let parent = directories.last().unwrap();
        let name = parts.last().unwrap();
        let info = parent.info(name).map_err(|_| changed())?;
        if Some(&info.stamp) != self.stamps.get(path) {
            return Err(changed());
        }
        let file = if entry.kind == "file" {
            let file = parent.open_file(name).map_err(|error| {
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    AppError::io(error)
                } else {
                    changed()
                }
            })?;
            if file_stamp(&file).map_err(AppError::io)? != info.stamp {
                return Err(changed());
            }
            Some(file)
        } else {
            None
        };
        let result = read(entry, file.as_ref());
        if file
            .as_ref()
            .map(file_stamp)
            .transpose()
            .map_err(AppError::io)?
            .is_some_and(|stamp| stamp != info.stamp)
            || parent.info(name).map_err(|_| changed())?.stamp != info.stamp
        {
            return Err(changed());
        }
        for (depth, directory) in directories.iter().enumerate() {
            if Some(&directory.stamp().map_err(|_| changed())?)
                != self.stamps.get(&parts[..depth].join("/"))
            {
                return Err(changed());
            }
        }
        if Some(
            &Directory::open(&self.root)
                .and_then(|root| root.stamp())
                .map_err(|_| changed())?,
        ) != self.stamps.get("")
        {
            return Err(changed());
        }
        result
    }

    fn fingerprint(&self, path: &str) -> Result<(Vec<u8>, u32), AppError> {
        use sha2::{Digest, Sha256};
        self.with_entry(path, |entry, file| {
            let file = file.ok_or_else(|| {
                AppError::io(entry.error.as_deref().unwrap_or("此文件类型无法比较"))
            })?;
            let mut hash = Sha256::new();
            let mut buffer = [0; 8192];
            let mut reader = file;
            loop {
                let count = reader.read(&mut buffer).map_err(AppError::io)?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
            #[cfg(unix)]
            let bits = {
                use std::os::unix::fs::PermissionsExt;
                file.metadata().map_err(AppError::io)?.permissions().mode() & 0o111
            };
            #[cfg(not(unix))]
            let bits = 0;
            Ok((hash.finalize().to_vec(), bits))
        })
    }

    fn read(&self, path: &str) -> Result<FilePreview, AppError> {
        self.with_entry(path, |entry, file| {
            let mut preview = FilePreview {
                path: path.into(),
                kind: entry.kind.clone(),
                size: entry.size,
                text: None,
                message: entry.error.clone(),
            };
            if entry.error.is_some() {
                preview.kind = "unreadable".into();
                return Ok(preview);
            }
            let Some(file) = file else {
                return Ok(preview);
            };
            if entry.size > MAX_PREVIEW_BYTES as u64 {
                preview.kind = "too_large".into();
            } else {
                let mut bytes = Vec::new();
                file.take((MAX_PREVIEW_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(AppError::io)?;
                if bytes.len() > MAX_PREVIEW_BYTES {
                    preview.kind = "too_large".into();
                } else if bytes.contains(&0) {
                    preview.kind = "binary".into();
                } else {
                    match String::from_utf8(bytes) {
                        Ok(text) => {
                            preview.kind = "text".into();
                            preview.text = Some(text);
                        }
                        Err(_) => preview.kind = "unsupported_encoding".into(),
                    }
                }
            }
            Ok(preview)
        })
    }
}

impl SkillBrowser {
    pub fn open(&self, store: &SkillStore, skill_id: &str) -> Result<BrowserIndex, AppError> {
        let skill = store
            .get_skill_by_id(skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill 未安装"))?;
        let session_id = uuid::Uuid::new_v4().to_string();
        let local = Snapshot::open(Path::new(&skill.central_path), skill_id, &session_id)?;
        let index = local.index.clone();
        let session = BrowserSession {
            skill,
            proxy_url: store.proxy_url(),
            local,
            source: Mutex::new(None),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        self.sessions
            .lock()
            .map_err(AppError::internal)?
            .insert(session_id, Arc::new(session));
        Ok(index)
    }

    fn session(&self, skill_id: &str, session_id: &str) -> Result<Arc<BrowserSession>, AppError> {
        let session = self
            .sessions
            .lock()
            .map_err(AppError::internal)?
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("浏览会话已关闭，请重新打开"))?;
        if session.skill.id != skill_id {
            return Err(AppError::invalid_input("浏览会话与 Skill 不匹配"));
        }
        Ok(session)
    }

    pub fn close(&self, skill_id: &str, session_id: &str) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock().map_err(AppError::internal)?;
        if let Some(session) = sessions.get(session_id) {
            if session.skill.id != skill_id {
                return Err(AppError::invalid_input("浏览会话与 Skill 不匹配"));
            }
            session.cancelled.store(true, Ordering::SeqCst);
        }
        sessions.remove(session_id);
        Ok(())
    }

    pub fn read(
        &self,
        skill_id: &str,
        session_id: &str,
        path: &str,
    ) -> Result<FilePreview, AppError> {
        self.read_side(skill_id, session_id, path, "local")
    }

    pub fn read_side(
        &self,
        skill_id: &str,
        session_id: &str,
        path: &str,
        side: &str,
    ) -> Result<FilePreview, AppError> {
        let session = self.session(skill_id, session_id)?;
        match side {
            "local" => session.local.read(path),
            "source" => {
                let source = session
                    .source
                    .lock()
                    .map_err(AppError::internal)?
                    .clone()
                    .ok_or_else(|| AppError::not_found("请先准备来源目录"))?;
                source.snapshot.validate()?;
                let preview = source.snapshot.read(path)?;
                source.snapshot.validate()?;
                Ok(preview)
            }
            _ => Err(AppError::invalid_input("不支持的文件版本")),
        }
    }

    pub fn source_diff(&self, skill_id: &str, session_id: &str) -> Result<BrowserDiff, AppError> {
        self.prepare_source(skill_id, session_id)?;
        let session = self.session(skill_id, session_id)?;
        let source = session
            .source
            .lock()
            .map_err(AppError::internal)?
            .clone()
            .ok_or_else(|| AppError::not_found("来源尚未准备"))?;
        let local = &session.local;
        let remote = &source.snapshot;
        local.validate()?;
        remote.validate()?;
        let mut union: BTreeMap<&str, (Option<&BrowserEntry>, Option<&BrowserEntry>)> =
            BTreeMap::new();
        for entry in &local.index.entries {
            union.entry(&entry.path).or_default().0 = Some(entry);
        }
        for entry in &remote.index.entries {
            union.entry(&entry.path).or_default().1 = Some(entry);
        }
        let mut index = BrowserIndex {
            skill_id: skill_id.into(),
            session_id: session_id.into(),
            entry_path: local
                .index
                .entry_path
                .clone()
                .or_else(|| remote.index.entry_path.clone()),
            entries: Vec::new(),
            file_count: 0,
            directory_count: 0,
            complete: local.index.complete && remote.index.complete,
            issues: local
                .index
                .issues
                .iter()
                .map(|issue| format!("当前安装：{issue}"))
                .chain(
                    remote
                        .index
                        .issues
                        .iter()
                        .map(|issue| format!("来源版本：{issue}")),
                )
                .collect(),
        };
        let mut entries = Vec::new();
        for (path, (left, right)) in union {
            if session.cancelled.load(Ordering::SeqCst) {
                return Err(AppError::cancelled("浏览会话已关闭"));
            }
            // 同路径类型变化以文件为选择入口，同时保留目录侧元数据供树展开。
            let mut display = left
                .filter(|entry| entry.kind != "directory")
                .or(right.filter(|entry| entry.kind != "directory"))
                .or(left)
                .or(right)
                .unwrap()
                .clone();
            let errors: Vec<_> = left
                .into_iter()
                .chain(right)
                .filter_map(|entry| entry.error.as_deref())
                .collect();
            if !errors.is_empty() {
                display.error = Some(errors.join("；"));
            }
            index.entries.push(display.clone());
            if display.kind == "directory" {
                index.directory_count += 1;
            } else {
                index.file_count += 1;
            }
            let mut comparison = BrowserComparison {
                path: path.into(),
                local: left.cloned(),
                source: right.cloned(),
                local_presence: if left.is_some() {
                    "present"
                } else if !local.absence_unknown(path) {
                    "missing"
                } else {
                    "unknown"
                }
                .into(),
                source_presence: if right.is_some() {
                    "present"
                } else if !remote.absence_unknown(path) {
                    "missing"
                } else {
                    "unknown"
                }
                .into(),
                status: None,
                reason: None,
                reason_code: None,
                content_changed: None,
                exec_bits_before: None,
                exec_bits_after: None,
            };
            let unknown_presence =
                comparison.local_presence == "unknown" || comparison.source_presence == "unknown";
            if unknown_presence {
                comparison.reason_code = Some("unknown_presence".into());
            }
            if display.kind == "directory" {
                entries.push(comparison);
                continue;
            }
            if path.split('/').any(super::content_hash::is_ignored) {
                comparison.status = Some("not_compared".into());
                comparison.reason_code = Some("excluded".into());
                entries.push(comparison);
                continue;
            }
            if unknown_presence
                || left
                    .into_iter()
                    .chain(right)
                    .any(|entry| entry.error.is_some())
            {
                comparison.status = Some("uncomparable".into());
                comparison.reason = display.error.clone();
                entries.push(comparison);
                continue;
            }
            if !left
                .into_iter()
                .chain(right)
                .any(|entry| entry.kind == "file")
            {
                comparison.status = Some("not_compared".into());
                comparison.reason_code = Some("unsupported_type".into());
                entries.push(comparison);
                continue;
            }
            let before = left
                .filter(|entry| entry.kind == "file")
                .map(|_| local.fingerprint(path))
                .transpose();
            let after = right
                .filter(|entry| entry.kind == "file")
                .map(|_| remote.fingerprint(path))
                .transpose();
            let (before, after) = match (before, after) {
                (Ok(before), Ok(after)) => (before, after),
                (before, after) => {
                    let mut reasons = Vec::new();
                    for (side, result) in [("当前安装", before), ("来源版本", after)] {
                        if let Err(error) = result {
                            if error.kind == super::error::ErrorKind::StaleSnapshot {
                                return Err(error);
                            }
                            reasons.push(format!("{side}：{}", error.message));
                        }
                    }
                    comparison.status = Some("uncomparable".into());
                    comparison.reason = Some(reasons.join("；"));
                    entries.push(comparison);
                    continue;
                }
            };
            if left
                .zip(right)
                .is_some_and(|(before, after)| before.kind != after.kind)
            {
                comparison.reason_code = Some("type_changed".into());
            }
            comparison.exec_bits_before = before.as_ref().map(|(_, bits)| *bits);
            comparison.exec_bits_after = after.as_ref().map(|(_, bits)| *bits);
            comparison.content_changed =
                Some(before.as_ref().map(|value| &value.0) != after.as_ref().map(|value| &value.0));
            comparison.status = Some(
                if before == after {
                    "unchanged"
                } else if left.is_none() {
                    "added"
                } else if right.is_none() {
                    "removed"
                } else {
                    "modified"
                }
                .into(),
            );
            entries.push(comparison);
        }
        local.validate()?;
        remote.validate()?;
        let changed_file_count = entries
            .iter()
            .filter(|entry| {
                matches!(
                    entry.status.as_deref(),
                    Some("added" | "removed" | "modified")
                )
            })
            .count();
        Ok(BrowserDiff {
            index,
            entries,
            changed_file_count,
            source_label: source.info.source_label.clone(),
            revision: source.info.revision.clone(),
        })
    }

    pub fn prepare_source(
        &self,
        skill_id: &str,
        session_id: &str,
    ) -> Result<SourceIndex, AppError> {
        let session = self.session(skill_id, session_id)?;
        // 仅锁住当前会话的来源准备；本地读取和其他 Skill 不等待来源操作。
        let mut source = session.source.lock().map_err(AppError::internal)?;
        if let Some(source) = source.as_ref() {
            source.snapshot.validate()?;
            return Ok(source.info.clone());
        }
        let skill = &session.skill;
        let (root, location, revision, checkout) = match skill.source_type.as_str() {
            "local" | "import" => {
                let location = skill
                    .source_ref
                    .clone()
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| AppError::not_found("此 Skill 没有记录原始来源"))?;
                if !Path::new(&location).try_exists().map_err(AppError::io)? {
                    return Err(AppError::not_found("原始来源路径已不存在"));
                }
                // 仅解析已记录的来源根；快照固定实际目录，内部链接仍只展示元数据。
                let root = Path::new(&location).canonicalize().map_err(AppError::io)?;
                (root, location, "workspace".into(), None)
            }
            "git" | "skillssh" => {
                use crate::commands::skills::{git_source_from_skill, resolve_skill_dir};
                let source = git_source_from_skill(skill)?;
                git_fetcher::validate_git_url(&source.clone_url).map_err(AppError::git)?;
                let checkout = SourceCheckout(
                    git_fetcher::clone_repo_ref(
                        &source.clone_url,
                        source.branch.as_deref(),
                        Some(&session.cancelled),
                        session.proxy_url.as_deref(),
                    )
                    .map_err(AppError::classify_git_error)?,
                );
                // 固定实际 checkout HEAD，避免远端在查询与克隆之间移动而混用修订。
                let revision =
                    git_fetcher::get_head_revision(&checkout.0).map_err(AppError::git)?;
                let root = resolve_skill_dir(
                    &checkout.0,
                    source.subpath.as_deref(),
                    source.locator_skill_id.as_deref(),
                )?;
                if !super::skill_metadata::is_valid_skill_dir(&root) {
                    return Err(AppError::not_found("来源位置不是可确定的单个 Skill 目录"));
                }
                let relative = root
                    .strip_prefix(&checkout.0)
                    .map_err(|error| AppError::invalid_input(error.to_string()))?;
                let location = if relative.as_os_str().is_empty() {
                    source.clone_url
                } else {
                    format!("{} · {}", source.clone_url, relative.display())
                };
                (root, location, revision, Some(checkout))
            }
            _ => return Err(AppError::not_found("此 Skill 没有可浏览的来源")),
        };
        let snapshot = Snapshot::open(&root, skill_id, session_id)?;
        let info = SourceIndex {
            index: snapshot.index.clone(),
            source_label: skill.source_type.clone(),
            location,
            revision,
        };
        if session.cancelled.load(Ordering::SeqCst) {
            return Err(AppError::cancelled("浏览会话已关闭"));
        }
        *source = Some(Arc::new(SourceSnapshot {
            snapshot,
            info: info.clone(),
            _checkout: checkout,
        }));
        Ok(info)
    }
}

fn validate_relative_path(path: &str) -> Result<(), AppError> {
    if path.is_empty()
        || (cfg!(windows) && (path.contains('\\') || path.contains(':')))
        || path.contains('\0')
        || path.split('/').any(|part| matches!(part, "" | "." | ".."))
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::invalid_input(
            "文件路径必须是 Skill 目录内的相对路径",
        ));
    }
    Ok(())
}

fn scan(
    directory: &Directory,
    prefix: &str,
    entries: &mut Vec<BrowserEntry>,
    stamps: &mut HashMap<String, String>,
    issues: &mut Vec<String>,
    incomplete_paths: &mut Vec<String>,
) {
    let before = match directory.stamp() {
        Ok(stamp) => stamp,
        Err(error) => {
            issues.push(format!("{prefix}：{error}"));
            incomplete_paths.push(prefix.into());
            return;
        }
    };
    stamps.insert(prefix.into(), before.clone());
    match directory.names() {
        Ok(names) => {
            for name in names {
                let name = match name {
                    Ok(name) => name,
                    Err(error) => {
                        issues.push(format!("{prefix}：{error}"));
                        incomplete_paths.push(prefix.into());
                        continue;
                    }
                };
                let path = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                match directory.info(&name) {
                    Ok(info) => {
                        stamps.insert(path.clone(), info.stamp);
                        let mut entry = BrowserEntry {
                            path: path.clone(),
                            kind: info.kind.into(),
                            size: info.size,
                            error: None,
                            link_target: info.link,
                        };
                        if info.kind == "directory" {
                            match directory.child(&name) {
                                Ok(child) => {
                                    let previous = issues.len();
                                    scan(&child, &path, entries, stamps, issues, incomplete_paths);
                                    if previous != issues.len() {
                                        entry.error = Some("此目录未完整读取，请重新加载".into());
                                    }
                                }
                                Err(error) => {
                                    entry.error = Some(error.to_string());
                                    issues.push(format!("{path}：{error}"));
                                    incomplete_paths.push(path.clone());
                                }
                            }
                        }
                        entries.push(entry);
                    }
                    Err(error) => {
                        issues.push(format!("{path}：{error}"));
                        incomplete_paths.push(path.clone());
                        entries.push(BrowserEntry {
                            path,
                            kind: "unreadable".into(),
                            size: 0,
                            error: Some(error.to_string()),
                            link_target: None,
                        });
                    }
                }
            }
        }
        Err(error) => {
            issues.push(format!("{prefix}：{error}"));
            incomplete_paths.push(prefix.into());
        }
    }
    if directory.stamp().ok().as_ref() != Some(&before) {
        issues.push(format!("{prefix}：扫描期间目录已变化，请重新加载"));
        incomplete_paths.push(prefix.into());
    }
}

struct EntryInfo {
    kind: &'static str,
    size: u64,
    stamp: String,
    link: Option<String>,
}
struct Directory {
    file: File,
    path: PathBuf,
    #[cfg(windows)]
    _ancestors: Vec<File>,
}

#[cfg(unix)]
mod platform {
    use super::*;
    use nix::{
        dir::Dir,
        fcntl::{open, openat, readlinkat, AtFlags, OFlag},
        sys::stat::{fstat, fstatat, FileStat, Mode, SFlag},
    };
    use std::{
        io,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };
    fn stamp(stat: &FileStat) -> String {
        format!(
            "{}:{}:{}:{}:{}:{}:{}:{}",
            stat.st_dev,
            stat.st_ino,
            stat.st_mode,
            stat.st_size,
            stat.st_mtime,
            stat.st_mtime_nsec,
            stat.st_ctime,
            stat.st_ctime_nsec
        )
    }
    fn owned(fd: i32) -> File {
        // open/openat 返回的新句柄只在这里转移一次所有权。
        unsafe { File::from_raw_fd(fd) }
    }
    const DIRECTORY_FLAGS: OFlag = OFlag::O_RDONLY
        .union(OFlag::O_DIRECTORY)
        .union(OFlag::O_NOFOLLOW)
        .union(OFlag::O_CLOEXEC);
    impl Directory {
        pub(super) fn open(path: &Path) -> io::Result<Self> {
            Ok(Self {
                file: owned(open(path, DIRECTORY_FLAGS, Mode::empty())?),
                path: path.into(),
            })
        }
        pub(super) fn child(&self, name: &str) -> io::Result<Self> {
            Ok(Self {
                file: owned(openat(
                    self.file.as_raw_fd(),
                    name,
                    DIRECTORY_FLAGS,
                    Mode::empty(),
                )?),
                path: self.path.join(name),
            })
        }
        pub(super) fn stamp(&self) -> io::Result<String> {
            file_stamp(&self.file)
        }
        pub(super) fn names(&self) -> io::Result<Vec<io::Result<String>>> {
            let mut dir = Dir::from(self.file.try_clone()?)?;
            Ok(dir
                .iter()
                .filter_map(|entry| match entry {
                    Ok(entry) if matches!(entry.file_name().to_bytes(), b"." | b"..") => None,
                    Ok(entry) => Some(
                        std::str::from_utf8(entry.file_name().to_bytes())
                            .map(str::to_owned)
                            .map_err(|_| io::Error::other("文件名不是 UTF-8，目录未完整读取")),
                    ),
                    Err(error) => Some(Err(error.into())),
                })
                .collect())
        }
        pub(super) fn info(&self, name: &str) -> io::Result<EntryInfo> {
            let stat = fstatat(self.file.as_raw_fd(), name, AtFlags::AT_SYMLINK_NOFOLLOW)?;
            let mode = SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT;
            let kind = if mode == SFlag::S_IFLNK {
                "symlink"
            } else if mode == SFlag::S_IFDIR {
                "directory"
            } else if mode == SFlag::S_IFREG {
                "file"
            } else {
                "special"
            };
            let link = if kind == "symlink" {
                readlinkat(self.file.as_raw_fd(), name)
                    .ok()
                    .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
            } else {
                None
            };
            Ok(EntryInfo {
                kind,
                size: stat.st_size.max(0) as u64,
                stamp: stamp(&stat),
                link,
            })
        }
        pub(super) fn open_file(&self, name: &str) -> io::Result<File> {
            Ok(owned(openat(
                self.file.as_raw_fd(),
                name,
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::empty(),
            )?))
        }
    }
    pub(super) fn file_stamp(file: &File) -> io::Result<String> {
        Ok(stamp(&fstat(file.as_raw_fd())?))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        fs::{self, OpenOptions},
        io,
        os::windows::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
    };
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    fn open_path(path: &Path, read: bool) -> io::Result<File> {
        // 不共享删除权限，将已打开的目录链固定到此次操作结束。
        OpenOptions::new()
            .read(true)
            .access_mode(if read {
                GENERIC_READ
            } else {
                FILE_READ_ATTRIBUTES
            })
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }
    impl Directory {
        pub(super) fn open(path: &Path) -> io::Result<Self> {
            if !path.is_absolute() {
                return Err(io::Error::other("Skill 安装路径必须是绝对路径"));
            }
            let mut ancestors = Vec::new();
            for ancestor in path
                .ancestors()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .filter(|path| path.is_absolute())
            {
                let file = open_path(ancestor, false)?;
                let meta = file.metadata()?;
                if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(io::Error::other("不能跟随链接目录"));
                }
                ancestors.push(file);
            }
            let file = ancestors
                .pop()
                .ok_or_else(|| io::Error::other("Skill 安装路径无效"))?;
            Ok(Self {
                file,
                path: path.into(),
                _ancestors: ancestors,
            })
        }
        pub(super) fn child(&self, name: &str) -> io::Result<Self> {
            Self::open(&self.path.join(name))
        }
        pub(super) fn stamp(&self) -> io::Result<String> {
            file_stamp(&self.file)
        }
        pub(super) fn names(&self) -> io::Result<Vec<io::Result<String>>> {
            Ok(fs::read_dir(&self.path)?
                .map(|entry| {
                    entry.and_then(|entry| {
                        entry
                            .file_name()
                            .into_string()
                            .map_err(|_| io::Error::other("文件名不是 UTF-8，目录未完整读取"))
                    })
                })
                .collect())
        }
        pub(super) fn info(&self, name: &str) -> io::Result<EntryInfo> {
            let path = self.path.join(name);
            let file = open_path(&path, false)?;
            let meta = file.metadata()?;
            let kind = if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                "symlink"
            } else if meta.is_dir() {
                "directory"
            } else if meta.is_file() {
                "file"
            } else {
                "special"
            };
            Ok(EntryInfo {
                kind,
                size: meta.len(),
                stamp: file_stamp(&file)?,
                link: if kind == "symlink" {
                    fs::read_link(path)
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned())
                } else {
                    None
                },
            })
        }
        pub(super) fn open_file(&self, name: &str) -> io::Result<File> {
            let file = open_path(&self.path.join(name), true)?;
            if !file.metadata()?.is_file()
                || file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(io::Error::other("不能读取链接或特殊文件"));
            }
            Ok(file)
        }
    }
    pub(super) fn file_stamp(file: &File) -> io::Result<String> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        // 两个结构均为 Windows 定义的输出缓冲区，句柄在调用期间保持有效。
        let ok = unsafe {
            GetFileInformationByHandle(file.as_raw_handle(), &mut info) != 0
                && GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FileBasicInfo,
                    (&mut basic as *mut FILE_BASIC_INFO).cast(),
                    std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                ) != 0
        };
        if !ok {
            return Err(io::Error::last_os_error());
        }
        Ok(format!(
            "{}:{}:{}:{}:{}:{}:{}:{}",
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
            info.nFileSizeHigh,
            info.nFileSizeLow,
            basic.LastWriteTime,
            basic.ChangeTime,
            basic.FileAttributes
        ))
    }
}
use platform::file_stamp;
