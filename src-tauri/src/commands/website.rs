use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::core::{
    central_repo, content_hash,
    error::AppError,
    installer,
    repo_lock::RepoLock,
    skill_metadata,
    skill_store::{SkillRecord, SkillStore},
    sync_metadata,
    well_known::{self, DownloadedSkill},
};

pub fn check_cancel(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::SeqCst) {
        Err(AppError::cancelled("Installation cancelled by user"))
    } else {
        Ok(())
    }
}

pub fn download(
    store: &SkillStore,
    site_url: &str,
    cancel: &AtomicBool,
) -> Result<DownloadedSkill, AppError> {
    let result =
        well_known::download_site_skill(site_url, store.proxy_url().as_deref(), Some(cancel));
    match result {
        Err(error) => {
            check_cancel(cancel)?;
            Err(AppError::network(error))
        }
        Ok(downloaded) => Ok(downloaded),
    }
}

pub fn download_and_install(
    store: &SkillStore,
    site_url: &str,
    name: Option<&str>,
    replace: bool,
    scenario: Option<&str>,
    cancel: &AtomicBool,
) -> Result<SkillRecord, AppError> {
    check_cancel(cancel)?;
    let downloaded = download(store, site_url, cancel)?;
    let result = install_snapshot(
        store,
        site_url,
        &downloaded,
        name,
        replace,
        scenario,
        cancel,
    );
    well_known::cleanup_temp(&downloaded.temp_dir);
    result
}

/// Read only a verified website preview, bound to this canonical source.
pub fn read_preview(site_url: &str, temp: &Path) -> Result<DownloadedSkill, AppError> {
    let site = well_known::parse_site_ref(site_url)
        .map_err(|error| AppError::invalid_input(error.to_string()))?;
    if !temp.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .starts_with(well_known::TEMP_DIR_PREFIX)
    }) {
        return Err(AppError::invalid_input("Invalid website preview"));
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(temp.join("snapshot.json"))?)
            .map_err(|error| AppError::invalid_input(error.to_string()))?;
    let skill_dir = well_known::skill_dir_from_temp(temp)
        .map_err(|error| AppError::invalid_input(error.to_string()))?;
    if metadata["source_ref"].as_str() != Some(&site.canonical_url())
        || metadata["content_hash"].as_str()
            != Some(&content_hash::hash_directory(&skill_dir).map_err(AppError::io)?)
    {
        return Err(AppError::invalid_input(
            "Website preview changed; download it again",
        ));
    }
    Ok(DownloadedSkill {
        temp_dir: temp.to_path_buf(),
        skill_dir,
        resolved_url: metadata["resolved_url"]
            .as_str()
            .ok_or_else(|| AppError::invalid_input("Invalid website preview"))?
            .to_string(),
        revision: metadata["revision"].as_str().map(str::to_string),
    })
}

/// All three entry points commit through this function, including the lock and cancellation gate.
pub fn install_snapshot(
    store: &SkillStore,
    site_url: &str,
    downloaded: &DownloadedSkill,
    name: Option<&str>,
    replace: bool,
    scenario: Option<&str>,
    cancel: &AtomicBool,
) -> Result<SkillRecord, AppError> {
    let site = well_known::parse_site_ref(site_url)
        .map_err(|error| AppError::invalid_input(error.to_string()))?;
    let source_ref = site.canonical_url();
    let _lock = RepoLock::acquire_foreground("install website snapshot").map_err(AppError::db)?;
    check_cancel(cancel)?;
    let existing = store
        .get_skill_by_source_ref("well-known", &source_ref)
        .map_err(AppError::db)?;
    if existing.is_some() && !replace {
        return Err(AppError::invalid_input(
            "Website snapshot already installed; confirm replacement (CLI: --replace)",
        ));
    }
    let (name, destination) = if let Some(existing) = &existing {
        (existing.name.clone(), PathBuf::from(&existing.central_path))
    } else {
        let base = skill_metadata::sanitize_skill_name(name.unwrap_or(&site.skill_name))
            .ok_or_else(|| AppError::invalid_input("Invalid skill name"))?;
        let mut attempt = 1;
        loop {
            let name = if attempt == 1 {
                base.clone()
            } else {
                format!("{base}-{attempt}")
            };
            let path = central_repo::skills_dir().join(&name);
            let occupied = store
                .get_skill_by_central_path(&path.to_string_lossy())
                .map_err(AppError::db)?
                .is_some();
            if !occupied
                && std::fs::symlink_metadata(&path)
                    .is_err_and(|err| err.kind() == std::io::ErrorKind::NotFound)
            {
                break (name, path);
            }
            // Propagate unreadable destinations instead of silently looping forever.
            if let Err(err) = std::fs::symlink_metadata(&path) {
                if err.kind() != std::io::ErrorKind::NotFound {
                    return Err(err.into());
                }
            }
            attempt += 1;
        }
    };
    if destination.parent() != Some(central_repo::skills_dir().as_path())
        || std::fs::symlink_metadata(&destination).is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return Err(AppError::invalid_input(
            "Unsafe website install destination",
        ));
    }
    if !downloaded.skill_dir.join("SKILL.md").is_file() {
        return Err(AppError::invalid_input(
            "Downloaded skill is missing SKILL.md",
        ));
    }
    let staging = tempfile::Builder::new()
        .prefix(".website-install-")
        .tempdir_in(central_repo::skills_dir())
        .map_err(AppError::io)?;
    let staged = staging.path().join("new");
    let backup = staging.path().join("old");
    let installed =
        installer::install_skill_dir_to_destination(&downloaded.skill_dir, &name, &staged)
            .map_err(AppError::io)?;
    check_cancel(cancel)?;
    let now = chrono::Utc::now().timestamp_millis();
    let record = SkillRecord {
        id: existing
            .as_ref()
            .map(|skill| skill.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name,
        description: installed.description,
        source_type: "well-known".into(),
        source_ref: Some(source_ref),
        source_ref_resolved: Some(downloaded.resolved_url.clone()),
        source_subpath: None,
        source_branch: None,
        source_revision: downloaded.revision.clone(),
        remote_revision: None,
        central_path: destination.to_string_lossy().into_owned(),
        content_hash: Some(installed.content_hash),
        enabled: existing.as_ref().map_or(true, |skill| skill.enabled),
        created_at: existing.as_ref().map_or(now, |skill| skill.created_at),
        updated_at: now,
        status: "ok".into(),
        update_status: "local_only".into(),
        last_checked_at: None,
        last_check_error: None,
    };
    // Reindex uses these files as authority, so they commit or roll back with the row.
    sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;
    let tags = store
        .get_tags_map()
        .map_err(AppError::db)?
        .remove(&record.id)
        .unwrap_or_default();
    let member = scenario.map(|scenario| sync_metadata::ScenarioSkillMetaFile {
        schema_version: sync_metadata::SCHEMA_VERSION,
        scenario_id: scenario.to_string(),
        skill_id: record.id.clone(),
        sort_order: 0,
        tools: std::collections::BTreeMap::new(),
    });
    let skill_metadata_path = sync_metadata::metadata_dir()
        .join("skills")
        .join(format!("{}.json", record.id));
    let membership_path = scenario.map(|scenario| {
        sync_metadata::metadata_dir()
            .join("scenario-skills")
            .join(scenario)
            .join(format!("{}.json", record.id))
    });
    let new_member = membership_path.as_ref().is_some_and(|path| !path.exists());
    let mut saved_metadata = Vec::new();
    for path in std::iter::once(skill_metadata_path).chain(membership_path.filter(|_| new_member)) {
        let previous = if path.try_exists()? {
            Some(std::fs::read(&path)?)
        } else {
            None
        };
        saved_metadata.push((path, previous));
    }
    check_cancel(cancel)?;
    let had_previous = destination.try_exists()?;
    if had_previous {
        std::fs::rename(&destination, &backup)?;
    }
    let result = (|| {
        std::fs::rename(&staged, &destination)?;
        check_cancel(cancel)?;
        store
            .store_website_snapshot(&record, scenario, || {
                sync_metadata::write_skill_file(&record, &tags)?;
                if new_member {
                    sync_metadata::write_membership_file(member.as_ref().unwrap())?;
                }
                Ok(())
            })
            .map_err(AppError::db)
    })();
    if let Err(error) = result {
        let rollback = (|| -> std::io::Result<()> {
            if destination.exists() {
                std::fs::remove_dir_all(&destination)?;
            }
            if had_previous {
                std::fs::rename(&backup, &destination)?;
            }
            for (path, previous) in &saved_metadata {
                match previous {
                    Some(bytes) if std::fs::read(path).ok().as_ref() != Some(bytes) => {
                        std::fs::write(path, bytes)?
                    }
                    None if path.exists() => std::fs::remove_file(path)?,
                    _ => {}
                }
            }
            Ok(())
        })();
        if let Err(rollback_error) = rollback {
            // Retain the only old copy if the filesystem itself prevents recovery.
            let recovery = staging.keep();
            return Err(AppError::io(format!(
                "{error}; rollback failed: {rollback_error}; previous files retained at {}",
                recovery.display()
            )));
        }
        return Err(error);
    }
    // Deployment is best-effort after the library snapshot and its metadata are committed.
    if let Some(scenario) = scenario {
        if let Err(error) = super::presets::sync_skill_to_active_preset(store, scenario, &record.id)
        {
            log::warn!("Snapshot preset sync failed: {error}");
        }
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::error::ErrorKind;
    use std::fs;

    struct Repo {
        _guard: std::sync::MutexGuard<'static, ()>,
        _temp: tempfile::TempDir,
        store: SkillStore,
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            central_repo::set_test_base_dir_override(None);
        }
    }
    fn repo() -> Repo {
        let guard = central_repo::test_base_dir_lock();
        let temp = tempfile::tempdir().unwrap();
        central_repo::set_test_base_dir_override(Some(temp.path().to_path_buf()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&temp.path().join("test.db")).unwrap();
        Repo {
            _guard: guard,
            _temp: temp,
            store,
        }
    }
    fn download(body: &str) -> (tempfile::TempDir, DownloadedSkill) {
        let temp = tempfile::Builder::new()
            .prefix(well_known::TEMP_DIR_PREFIX)
            .tempdir()
            .unwrap();
        let skill_dir = temp.path().join("skill");
        fs::create_dir(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), body).unwrap();
        let downloaded = DownloadedSkill {
            temp_dir: temp.path().to_path_buf(),
            skill_dir,
            resolved_url: "https://example.com/demo.zip".into(),
            revision: Some("digest".into()),
        };
        (temp, downloaded)
    }
    const SITE: &str = "https://skills.sh/site/example.com/demo";

    #[test]
    fn canonical_reinstall_requires_confirmation_and_preserves_identity_and_settings() {
        let repo = repo();
        let (_temp, mut downloaded) = download("first");
        let cancel = AtomicBool::new(false);
        let first =
            install_snapshot(&repo.store, SITE, &downloaded, None, false, None, &cancel).unwrap();
        let mut disabled = first.clone();
        disabled.enabled = false;
        repo.store.upsert_skill(&disabled).unwrap();
        fs::write(downloaded.skill_dir.join("SKILL.md"), "second").unwrap();
        downloaded.revision = Some("new digest".into());
        assert!(
            install_snapshot(&repo.store, SITE, &downloaded, None, false, None, &cancel).is_err()
        );
        assert_eq!(
            fs::read_to_string(Path::new(&first.central_path).join("SKILL.md")).unwrap(),
            "first"
        );
        let second = install_snapshot(
            &repo.store,
            "https://www.skills.sh/site/EXAMPLE.COM/demo",
            &downloaded,
            Some("ignored-rename"),
            true,
            None,
            &cancel,
        )
        .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.central_path, second.central_path);
        assert_eq!(first.created_at, second.created_at);
        assert!(!second.enabled);
        assert_eq!(
            fs::read_to_string(Path::new(&second.central_path).join("SKILL.md")).unwrap(),
            "second"
        );
        assert_eq!(repo.store.get_all_skills().unwrap().len(), 1);
        assert!(!crate::skill_update_batch::is_checkable_update_skill(
            &second
        ));
        assert!(super::super::skills::git_source_from_skill(&second).is_err());
        let checked =
            super::super::skills::check_skill_update_internal(&repo.store, &second.id, true, None)
                .unwrap();
        assert_eq!(checked.update_status, "local_only");
        assert!(!checked.can_check_update);
        let browser = crate::core::skill_browser::SkillBrowser::default();
        let session = browser.open(&repo.store, &second.id).unwrap();
        assert!(browser
            .prepare_source(&second.id, &session.session_id)
            .is_err());
        browser.close(&second.id, &session.session_id).unwrap();
    }

    #[test]
    fn different_sites_and_unregistered_directories_never_share_a_destination() {
        let repo = repo();
        let unregistered = central_repo::skills_dir().join("demo");
        fs::create_dir(&unregistered).unwrap();
        fs::write(unregistered.join("user.txt"), "keep").unwrap();
        let (_temp, downloaded) = download("skill");
        let cancel = AtomicBool::new(false);
        let first =
            install_snapshot(&repo.store, SITE, &downloaded, None, false, None, &cancel).unwrap();
        let second = install_snapshot(
            &repo.store,
            "https://skills.sh/site/other.com/demo",
            &downloaded,
            None,
            true,
            None,
            &cancel,
        )
        .unwrap();
        assert_eq!(first.name, "demo-2");
        assert_eq!(second.name, "demo-3");
        assert_ne!(first.id, second.id);
        assert_eq!(
            fs::read_to_string(unregistered.join("user.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn database_failure_rolls_back_new_install_and_replacement() {
        let repo = repo();
        let (_temp, downloaded) = download("first");
        let cancel = AtomicBool::new(false);
        // A nonexistent preset fails the FK constraint after the skill upsert.
        assert!(install_snapshot(
            &repo.store,
            SITE,
            &downloaded,
            None,
            false,
            Some("missing"),
            &cancel
        )
        .is_err());
        assert!(repo.store.get_all_skills().unwrap().is_empty());
        assert!(!central_repo::skills_dir().join("demo").exists());
        assert!(!fs::read_dir(central_repo::skills_dir())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".website-install-")));
        let old =
            install_snapshot(&repo.store, SITE, &downloaded, None, false, None, &cancel).unwrap();
        fs::write(downloaded.skill_dir.join("SKILL.md"), "second").unwrap();
        assert!(install_snapshot(
            &repo.store,
            SITE,
            &downloaded,
            None,
            true,
            Some("missing"),
            &cancel
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(Path::new(&old.central_path).join("SKILL.md")).unwrap(),
            "first"
        );
        let kept = repo.store.get_skill_by_id(&old.id).unwrap().unwrap();
        assert_eq!(kept.content_hash, old.content_hash);
        assert!(!fs::read_dir(central_repo::skills_dir())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".website-install-")));
        // Failure did not poison the next attempt.
        install_snapshot(&repo.store, SITE, &downloaded, None, true, None, &cancel).unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&old.central_path).join("SKILL.md")).unwrap(),
            "second"
        );
    }

    #[test]
    fn cancellation_while_waiting_for_repo_lock_keeps_old_snapshot() {
        let repo = repo();
        let (_temp, downloaded) = download("first");
        let cancel = AtomicBool::new(false);
        let old =
            install_snapshot(&repo.store, SITE, &downloaded, None, false, None, &cancel).unwrap();
        fs::write(downloaded.skill_dir.join("SKILL.md"), "second").unwrap();
        let held = RepoLock::acquire("test contention").unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                install_snapshot(&repo.store, SITE, &downloaded, None, true, None, &cancel)
            });
            std::thread::sleep(std::time::Duration::from_millis(100));
            cancel.store(true, Ordering::SeqCst);
            drop(held);
            assert_eq!(
                worker.join().unwrap().unwrap_err().kind,
                ErrorKind::Cancelled
            );
        });
        assert_eq!(
            fs::read_to_string(Path::new(&old.central_path).join("SKILL.md")).unwrap(),
            "first"
        );
        assert_eq!(repo.store.get_all_skills().unwrap().len(), 1);
        cancel.store(false, Ordering::SeqCst);
        install_snapshot(&repo.store, SITE, &downloaded, None, true, None, &cancel).unwrap();
    }

    #[test]
    fn preview_binding_rejects_another_source_and_changed_files() {
        let (_temp, downloaded) = download("skill");
        fs::write(downloaded.temp_dir.join("snapshot.json"), serde_json::to_vec(&serde_json::json!({
            "source_ref": SITE, "resolved_url": downloaded.resolved_url, "revision": downloaded.revision,
            "content_hash": content_hash::hash_directory(&downloaded.skill_dir).unwrap()
        })).unwrap()).unwrap();
        read_preview(
            "https://www.skills.sh/site/EXAMPLE.COM/demo",
            &downloaded.temp_dir,
        )
        .unwrap();
        assert!(read_preview(
            "https://skills.sh/site/other.com/demo",
            &downloaded.temp_dir
        )
        .is_err());
        fs::write(downloaded.skill_dir.join("SKILL.md"), "changed").unwrap();
        assert!(read_preview(SITE, &downloaded.temp_dir).is_err());
    }
}
