use super::{error::AppError, skill_store::SkillStore};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
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

#[derive(Default)]
pub struct SkillBrowser {
    sessions: Mutex<HashMap<String, Arc<LocalSnapshot>>>,
}

struct LocalSnapshot {
    skill_id: String,
    root: Directory,
    stamps: HashMap<String, String>,
    index: BrowserIndex,
}

impl SkillBrowser {
    pub fn open(&self, store: &SkillStore, skill_id: &str) -> Result<BrowserIndex, AppError> {
        let skill = store
            .get_skill_by_id(skill_id)
            .map_err(AppError::db)?
            .ok_or_else(|| AppError::not_found("Skill 未安装"))?;
        let root = Directory::open(Path::new(&skill.central_path)).map_err(AppError::io)?;
        let mut stamps = HashMap::new();
        let mut entries = Vec::new();
        let mut issues = Vec::new();
        scan(&root, "", &mut entries, &mut stamps, &mut issues);
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
                        entry.kind == "file" && entry.path.to_lowercase().ends_with(".md")
                    })
                    .map(|entry| entry.path.clone())
            });
        let index = BrowserIndex {
            skill_id: skill_id.into(),
            session_id: uuid::Uuid::new_v4().to_string(),
            entry_path,
            file_count: entries
                .iter()
                .filter(|entry| matches!(entry.kind.as_str(), "file" | "symlink" | "special"))
                .count(),
            directory_count: entries
                .iter()
                .filter(|entry| entry.kind == "directory")
                .count(),
            complete: issues.is_empty(),
            entries,
            issues,
        };
        let snapshot = LocalSnapshot {
            skill_id: skill_id.into(),
            root,
            stamps,
            index: index.clone(),
        };
        self.sessions
            .lock()
            .map_err(AppError::internal)?
            .insert(index.session_id.clone(), Arc::new(snapshot));
        Ok(index)
    }

    pub fn close(&self, skill_id: &str, session_id: &str) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock().map_err(AppError::internal)?;
        if let Some(session) = sessions.get(session_id) {
            if session.skill_id != skill_id {
                return Err(AppError::invalid_input("浏览会话与 Skill 不匹配"));
            }
        }
        sessions.remove(session_id);
        Ok(())
    }

    pub fn read(
        &self,
        skill_id: &str,
        session_id: &str,
        relative_path: &str,
    ) -> Result<FilePreview, AppError> {
        validate_relative_path(relative_path)?;
        let session = self
            .sessions
            .lock()
            .map_err(AppError::internal)?
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("浏览会话已关闭，请重新打开"))?;
        if session.skill_id != skill_id {
            return Err(AppError::invalid_input("浏览会话与 Skill 不匹配"));
        }
        let entry = session
            .index
            .entries
            .iter()
            .find(|entry| entry.path == relative_path)
            .ok_or_else(|| AppError::not_found("此版本中没有该文件"))?;
        let mut preview = FilePreview {
            path: relative_path.into(),
            kind: entry.kind.clone(),
            size: entry.size,
            text: None,
            message: entry.error.clone(),
        };
        if let Some(message) = &entry.error {
            preview.kind = "unreadable".into();
            preview.message = Some(message.clone());
            return Ok(preview);
        }
        let changed = AppError::stale_snapshot;
        // 重新核验安装路径的身份，避免已被替换的根目录继续提供旧版本正文。
        let current_root = Directory::open(&session.root.path).map_err(|_| changed())?;
        if current_root.stamp().map_err(|_| changed())? != session.stamps[""] {
            return Err(changed());
        }
        let parts: Vec<_> = relative_path.split('/').collect();
        let mut directories = vec![current_root];
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
            if Some(&directory.stamp().map_err(|_| changed())?) != session.stamps.get(&prefix) {
                return Err(changed());
            }
            directories.push(directory);
        }
        let parent = directories.last().unwrap();
        let name = parts.last().unwrap();
        let info = parent.info(name).map_err(|_| changed())?;
        if Some(&info.stamp) != session.stamps.get(relative_path) {
            return Err(changed());
        }
        if entry.kind != "file" {
            preview.message = Some(match entry.kind.as_str() {
                "symlink" => format!(
                    "符号链接，仅展示链接信息，不读取目标：{}",
                    entry.link_target.as_deref().unwrap_or("未知")
                ),
                "directory" => "目录，请从左侧选择文件".into(),
                _ => "此文件类型不支持预览".into(),
            });
            return Ok(preview);
        }
        let file = parent.open_file(name).map_err(AppError::io)?;
        if file_stamp(&file).map_err(AppError::io)? != info.stamp {
            return Err(changed());
        }
        if entry.size > MAX_PREVIEW_BYTES as u64 {
            preview.kind = "too_large".into();
        } else {
            let mut bytes = Vec::new();
            (&file)
                .take((MAX_PREVIEW_BYTES + 1) as u64)
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
        if file_stamp(&file).map_err(AppError::io)? != info.stamp
            || parent.info(name).map_err(|_| changed())?.stamp != info.stamp
        {
            return Err(changed());
        }
        for (depth, directory) in directories.iter().enumerate() {
            let path = parts[..depth].join("/");
            if Some(&directory.stamp().map_err(|_| changed())?) != session.stamps.get(&path) {
                return Err(changed());
            }
        }
        if Directory::open(&session.root.path)
            .and_then(|directory| directory.stamp())
            .map_err(|_| changed())?
            != session.stamps[""]
        {
            return Err(changed());
        }
        Ok(preview)
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
) {
    let before = match directory.stamp() {
        Ok(stamp) => stamp,
        Err(error) => {
            issues.push(format!("{prefix}：{error}"));
            return;
        }
    };
    stamps.insert(prefix.into(), before.clone());
    match directory.names() {
        Ok(names) => {
            for name in names {
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
                                    scan(&child, &path, entries, stamps, issues);
                                    if previous != issues.len() {
                                        entry.error = Some("此目录未完整读取，请重新加载".into());
                                    }
                                }
                                Err(error) => {
                                    entry.error = Some(error.to_string());
                                    issues.push(format!("{path}：{error}"));
                                }
                            }
                        }
                        entries.push(entry);
                    }
                    Err(error) => {
                        issues.push(format!("{path}：{error}"));
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
        Err(error) => issues.push(format!("{prefix}：{error}")),
    }
    if directory.stamp().ok().as_ref() != Some(&before) {
        issues.push(format!("{prefix}：扫描期间目录已变化，请重新加载"));
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
        pub(super) fn names(&self) -> io::Result<Vec<String>> {
            let mut dir = Dir::from(self.file.try_clone()?)?;
            dir.iter()
                .filter_map(|entry| match entry {
                    Ok(entry) if matches!(entry.file_name().to_bytes(), b"." | b"..") => None,
                    Ok(entry) => Some(
                        std::str::from_utf8(entry.file_name().to_bytes())
                            .map(str::to_owned)
                            .map_err(|_| io::Error::other("文件名不是 UTF-8，目录未完整读取")),
                    ),
                    Err(error) => Some(Err(error.into())),
                })
                .collect()
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
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO,
    };
    const REPARSE: u32 = 0x400;
    fn open_path(path: &Path, read: bool) -> io::Result<File> {
        // 不共享删除权限，将已打开的目录链固定到此次操作结束。
        OpenOptions::new()
            .read(true)
            .access_mode(if read { 0x80000000 } else { 0 })
            .share_mode(3)
            .custom_flags(0x02200000)
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
                if !meta.is_dir() || meta.file_attributes() & REPARSE != 0 {
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
        pub(super) fn names(&self) -> io::Result<Vec<String>> {
            fs::read_dir(&self.path)?
                .map(|entry| {
                    entry.and_then(|entry| {
                        entry
                            .file_name()
                            .into_string()
                            .map_err(|_| io::Error::other("文件名不是 UTF-8，目录未完整读取"))
                    })
                })
                .collect()
        }
        pub(super) fn info(&self, name: &str) -> io::Result<EntryInfo> {
            let path = self.path.join(name);
            let file = open_path(&path, false)?;
            let meta = file.metadata()?;
            let kind = if meta.file_attributes() & REPARSE != 0 {
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
            if !file.metadata()?.is_file() || file.metadata()?.file_attributes() & REPARSE != 0 {
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
