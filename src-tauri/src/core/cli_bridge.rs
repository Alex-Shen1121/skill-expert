//! 供 Agent 调用的 `skill-expert-cli` 固定副本。
//!
//! 桌面安装包已经把 CLI 放在应用主程序旁边，但 macOS 应用包和 Windows 安装目录
//! 通常不在 `PATH` 中。应用启动后把同版本 CLI 复制到固定的
//! `~/.skill-expert/bin`，`manage-skills` Skill 即可在不知道应用安装位置的情况下找到它。
//!
//! 桥接使用副本而不是符号链接：AppImage 挂载路径是临时的，macOS 应用也可能被移动。
//! `.version` 印记最后写入、最先失效；只有印记存在且二进制验证通过时，Agent 才能运行它。

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

use super::central_repo;

const BRIDGE_BIN_NAME: &str = if cfg!(windows) {
    "skill-expert-cli.exe"
} else {
    "skill-expert-cli"
};

pub fn bridge_dir() -> PathBuf {
    central_repo::home_base_dir().join("bin")
}

pub fn bridge_path() -> PathBuf {
    bridge_dir().join(BRIDGE_BIN_NAME)
}

fn stamp_path() -> PathBuf {
    bridge_dir().join(".version")
}

/// 当前桌面应用随包携带的 CLI。
fn bundled_cli() -> Result<PathBuf> {
    let executable = std::env::current_exe().context("无法定位当前应用程序")?;
    let directory = executable.parent().context("当前应用程序没有父目录")?;
    let candidate = directory.join(BRIDGE_BIN_NAME);
    if !candidate.is_file() {
        bail!(
            "当前构建未在应用程序旁携带 {BRIDGE_BIN_NAME}（{}）",
            directory.display()
        );
    }
    Ok(candidate)
}

/// 空印记等同于无印记，与 Skill 中的 `-s` 检查保持一致。
fn read_stamp() -> Option<String> {
    std::fs::read_to_string(stamp_path())
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 在触碰二进制前先让旧桥接失效。
///
/// 依次尝试删除印记、清空印记、删除二进制；只有三种方式都失败时才中止发布，
/// 从而避免旧二进制继续被旧印记错误背书。
fn invalidate_bridge() -> Result<()> {
    let stamp = stamp_path();
    match std::fs::remove_file(&stamp) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => log::warn!("CLI 桥接：无法删除 {}：{error}", stamp.display()),
    }
    if std::fs::write(&stamp, b"").is_ok() {
        return Ok(());
    }
    log::warn!("CLI 桥接：无法清空 {}", stamp.display());
    let binary = bridge_path();
    match std::fs::remove_file(&binary) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::Error::new(error).context(format!(
            "无法让已发布 CLI 失效：{} 与 {} 均无法移除",
            stamp.display(),
            binary.display()
        ))),
    }
}

/// 运行刚复制的 CLI 并核对完整版本令牌。
fn verify(path: &Path, expected_version: &str) -> Result<()> {
    let output = Command::new(path)
        .arg("--version")
        .output()
        .with_context(|| format!("无法运行 {}", path.display()))?;
    if !output.status.success() {
        bail!("{} --version 退出状态为 {}", path.display(), output.status);
    }
    let reported = String::from_utf8_lossy(&output.stdout);
    let version = reported.split_whitespace().last().unwrap_or_default();
    if version != expected_version {
        bail!(
            "{} 报告 {:?}，预期版本为 {expected_version}",
            path.display(),
            reported.trim()
        );
    }
    Ok(())
}

/// 尽力发布当前 CLI；任何失败都会留下无印记状态并写入日志，不阻塞桌面应用启动。
pub fn ensure_bridge(app_version: &str) {
    match ensure_bridge_inner(app_version) {
        Ok(path) => log::info!("CLI 桥接：已就绪 {}", path.display()),
        Err(error) => log::warn!("CLI 桥接：当前不可用：{error:#}"),
    }
}

fn ensure_bridge_inner(app_version: &str) -> Result<PathBuf> {
    if read_stamp().as_deref() == Some(app_version) && bridge_path().is_file() {
        return Ok(bridge_path());
    }
    publish_from(&bundled_cli()?, app_version)
}

fn publish_from(source: &Path, app_version: &str) -> Result<PathBuf> {
    let target = bridge_path();
    invalidate_bridge()?;

    let directory = bridge_dir();
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("无法创建 {}", directory.display()))?;

    let staged = directory.join(format!(".{BRIDGE_BIN_NAME}.staged"));
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(source, &staged)
        .with_context(|| format!("无法把 {} 复制到 {}", source.display(), staged.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .context("无法为暂存 CLI 添加执行权限")?;
    }

    if let Err(error) = verify(&staged, app_version) {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }

    std::fs::rename(&staged, &target)
        .with_context(|| format!("无法替换 {}，文件可能正在使用", target.display()))?;
    std::fs::write(stamp_path(), app_version)
        .with_context(|| format!("无法写入 {}", stamp_path().display()))?;

    log::info!("CLI 桥接：已发布 {app_version} 到 {}", target.display());
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(unix)]
    fn fake_cli(directory: &Path, reports: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("skill-expert-cli");
        std::fs::write(
            &path,
            format!("#!/bin/sh\necho 'skill-expert-cli {reports}'\n"),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn publishing_stamps_only_after_verified_copy_runs() {
        let _lock = central_repo::test_base_dir_lock();
        let temp = tempdir().unwrap();
        central_repo::set_test_home_dir_override(Some(temp.path().to_path_buf()));
        let bundle = temp.path().join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();

        publish_from(&fake_cli(&bundle, "9.9.9"), "9.9.9").unwrap();

        assert!(bridge_path().is_file());
        assert_eq!(read_stamp().as_deref(), Some("9.9.9"));
        central_repo::set_test_home_dir_override(None);
    }

    #[cfg(unix)]
    #[test]
    fn failed_republish_leaves_previous_bridge_untrusted() {
        let _lock = central_repo::test_base_dir_lock();
        let temp = tempdir().unwrap();
        central_repo::set_test_home_dir_override(Some(temp.path().to_path_buf()));
        let bundle = temp.path().join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();

        publish_from(&fake_cli(&bundle, "9.9.9"), "9.9.9").unwrap();
        let broken = bundle.join("broken-cli");
        std::fs::write(&broken, "不可执行").unwrap();

        publish_from(&broken, "9.9.10").expect_err("不可运行的 CLI 不能发布");
        assert!(read_stamp().is_none());
        assert!(bridge_path().is_file());
        central_repo::set_test_home_dir_override(None);
    }

    #[cfg(unix)]
    #[test]
    fn bridge_uses_fixed_identity_root_instead_of_relocated_library() {
        let _lock = central_repo::test_base_dir_lock();
        let temp = tempdir().unwrap();
        central_repo::set_test_home_dir_override(Some(temp.path().to_path_buf()));
        central_repo::set_test_base_dir_override(Some(temp.path().join("relocated-library")));

        assert_eq!(bridge_dir(), temp.path().join(".skill-expert").join("bin"));
        assert_ne!(bridge_dir(), central_repo::base_dir().join("bin"));

        central_repo::set_test_base_dir_override(None);
        central_repo::set_test_home_dir_override(None);
    }
}
