use anyhow::{Context, Result};
use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::time::{Duration, Instant};
use std::{
    cell::RefCell,
    collections::HashMap,
    path::{Path, PathBuf},
    rc::{Rc, Weak},
};

use super::central_repo;

/// Filename used for the central-repository write lock.
///
/// The lock lives in `base_dir()` (the parent of `skills_dir()`), not inside
/// `skills_dir` itself. `skills_dir` gets renamed/recreated during clone and
/// reclone flows, and on Windows mandatory file locking makes it impossible
/// to rename a directory that contains a file held with an exclusive lock —
/// see issue #99 (os error 5 / "Access is denied").
const LOCK_FILE_NAME: &str = ".skill-expert.lock";

/// How long a user-initiated ("foreground") operation waits for the central
/// repository lock before giving up with a "busy" error. Background work holds
/// the lock only briefly per skill, but an auto-backup `git push` can hold it
/// for ~10–15s, so we wait comfortably longer than the longest expected
/// background hold. Without this wait, a foreground install/update/tag/delete
/// that happened to collide with a background update check or backup failed
/// instantly with "skills repository is busy" (issues #196, #220, #232).
pub const FOREGROUND_WAIT: Duration = Duration::from_secs(20);

/// Poll cadence while waiting for the lock. Kept below the yield the background
/// per-skill loops insert between releases (see `skill_auto_updater` and the
/// tray check) so a waiting foreground op reliably wins the lock during that
/// window instead of being starved by the background re-acquiring immediately.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

thread_local! {
    static HELD: RefCell<HashMap<PathBuf, Weak<File>>> = RefCell::new(HashMap::new());
}

pub struct RepoLock {
    file: Rc<File>,
}

impl RepoLock {
    /// Acquire the lock, failing immediately if it is already held. Used by
    /// background loops that prefer to skip a unit of work and retry on the
    /// next round rather than block a user-initiated operation.
    pub fn acquire(operation: &str) -> Result<Self> {
        let file = open_lock_file()?;
        file.try_lock_exclusive()
            .with_context(|| format!("skills repository is busy: {operation}"))?;
        Self::stamp(file, operation, &central_repo::base_dir())
    }

    /// Acquire the lock, waiting up to `timeout` for a concurrent holder to
    /// release it before reporting the repository as busy. Used by
    /// user-initiated operations so transient contention with background work
    /// (update checks, auto-backup) surfaces as a short wait, not an error.
    pub fn acquire_blocking(operation: &str, timeout: Duration) -> Result<Self> {
        let file = open_lock_file()?;
        let start = Instant::now();
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Self::stamp(file, operation, &central_repo::base_dir()),
                // Retry on any error (not just `WouldBlock`): on Windows
                // `LockFileEx` reports contention as `ERROR_LOCK_VIOLATION`,
                // which does not map to `ErrorKind::WouldBlock`, so gating on
                // the kind would defeat the wait on the very platform that
                // needs it most.
                Err(err) => {
                    if start.elapsed() >= timeout {
                        return Err(err)
                            .with_context(|| format!("skills repository is busy: {operation}"));
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
            }
        }
    }

    /// Convenience for user-initiated operations: wait up to [`FOREGROUND_WAIT`].
    pub fn acquire_foreground(operation: &str) -> Result<Self> {
        Self::for_library(&central_repo::base_dir(), operation)
    }

    /// Nested deployment calls reuse only this thread's guard for this exact
    /// library. Independent operations and other processes still take the file lock.
    pub(crate) fn for_library(base: &Path, operation: &str) -> Result<Self> {
        std::fs::create_dir_all(base)?;
        let key = base.canonicalize()?.join(LOCK_FILE_NAME);
        if let Some(file) = HELD.with(|held| held.borrow().get(&key).and_then(Weak::upgrade)) {
            return Ok(Self { file });
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&key)?;
        let start = Instant::now();
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Self::stamp(file, operation, base),
                Err(error) if start.elapsed() >= FOREGROUND_WAIT => {
                    return Err(error).context("Skills repository is busy")
                }
                Err(_) => std::thread::sleep(POLL_INTERVAL),
            }
        }
    }

    fn stamp(mut file: File, operation: &str, base: &Path) -> Result<Self> {
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        writeln!(
            file,
            "pid={}\nhostname={}\noperation={}\nstart_time={}",
            std::process::id(),
            std::env::var("HOSTNAME")
                .or_else(|_| std::env::var("COMPUTERNAME"))
                .unwrap_or_else(|_| "unknown".to_string()),
            operation,
            chrono::Utc::now().to_rfc3339()
        )?;
        file.sync_all()?;
        let file = Rc::new(file);
        let key = base.canonicalize()?.join(LOCK_FILE_NAME);
        HELD.with(|held| {
            held.borrow_mut().insert(key, Rc::downgrade(&file));
        });
        Ok(Self { file })
    }
}

fn open_lock_file() -> Result<File> {
    let base = central_repo::base_dir();
    std::fs::create_dir_all(&base)?;
    let lock_path = base.join(LOCK_FILE_NAME);
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .with_context(|| format!("failed to open repo lock {}", lock_path.display()))
}

impl Drop for RepoLock {
    fn drop(&mut self) {
        if Rc::strong_count(&self.file) == 1 {
            let _ = FileExt::unlock(&*self.file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Regression test for issue #99: the lock file must not live inside
    /// `skills_dir`. On Windows, an open exclusive lock on a file inside a
    /// directory makes it impossible to rename or remove that directory
    /// (Access is denied / os error 5), which broke the clone-with-backup
    /// flow used by "use existing remote backup".
    #[test]
    fn lock_file_lives_outside_skills_dir() {
        assert_eq!(LOCK_FILE_NAME, ".skill-expert.lock");
        let _guard = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("base");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        let skills_dir = central_repo::skills_dir();
        std::fs::create_dir_all(&skills_dir).unwrap();

        let lock = RepoLock::acquire("test").unwrap();

        assert!(base.join(LOCK_FILE_NAME).exists());
        assert!(!skills_dir.join(LOCK_FILE_NAME).exists());

        let entries: Vec<_> = std::fs::read_dir(&skills_dir).unwrap().collect();
        assert!(
            entries.is_empty(),
            "skills_dir should remain empty while the lock is held; got {entries:?}"
        );

        drop(lock);
        central_repo::set_test_base_dir_override(None);
    }

    /// A blocking acquire must report "busy" only after waiting roughly the
    /// requested timeout while another holder keeps the lock, and must succeed
    /// once that holder releases. This is the behaviour foreground operations
    /// rely on to ride out transient contention with background work.
    #[test]
    fn blocking_acquire_waits_then_times_out_and_recovers() {
        let _guard = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("base");
        central_repo::set_test_base_dir_override(Some(base));

        let held = RepoLock::acquire("holder").unwrap();

        let start = Instant::now();
        let busy = RepoLock::acquire_blocking("waiter", Duration::from_millis(300));
        assert!(busy.is_err(), "should time out while the lock is held");
        assert!(
            start.elapsed() >= Duration::from_millis(250),
            "should have waited close to the timeout, waited {:?}",
            start.elapsed()
        );

        drop(held);
        let recovered = RepoLock::acquire_blocking("waiter", Duration::from_millis(300));
        assert!(recovered.is_ok(), "should acquire once the holder releases");
        drop(recovered);

        central_repo::set_test_base_dir_override(None);
    }
    #[test]
    fn nested_library_guard_keeps_the_cross_thread_lock_until_the_last_guard_drops() {
        let dir = tempdir().unwrap();
        let outer = RepoLock::for_library(dir.path(), "outer").unwrap();
        let inner = RepoLock::for_library(dir.path(), "inner").unwrap();
        drop(outer);
        let path = dir.path().join(LOCK_FILE_NAME);
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let file = OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&path)
                        .unwrap();
                    assert!(file.try_lock_exclusive().is_err());
                })
                .join()
                .unwrap();
        });
        drop(inner);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        file.try_lock_exclusive().unwrap();
    }
}
