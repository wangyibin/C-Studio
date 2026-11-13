use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static SAVES: OnceLock<Mutex<HashMap<u64, PendingSave>>> = OnceLock::new();
fn saves() -> &'static Mutex<HashMap<u64, PendingSave>> {
    SAVES.get_or_init(Default::default)
}

struct PendingSave {
    target: PathBuf,
    history_target: PathBuf,
    agp_temp: PathBuf,
    history_temp: PathBuf,
    agp: Option<File>,
    history: Option<File>,
}
impl Drop for PendingSave {
    fn drop(&mut self) {
        self.agp.take();
        self.history.take();
        let _ = fs::remove_file(&self.agp_temp);
        let _ = fs::remove_file(&self.history_temp);
    }
}
fn error(path: &Path, err: impl std::fmt::Display) -> String {
    format!("{}: {}", path.display(), err)
}
fn create(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| error(path, e))
}

pub fn begin(
    path: String,
    history_target: PathBuf,
    require_existing: bool,
) -> Result<Option<u64>, String> {
    let target = PathBuf::from(path);
    if require_existing && !target.is_file() {
        return Ok(None);
    }
    for p in [&target, &history_target] {
        if p.exists() && !p.is_file() {
            return Err(error(p, "destination is not a regular file"));
        }
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let stem = format!(".cstudio-save-{}-{nonce}-{id}", std::process::id());
    let agp_temp = target.with_file_name(format!("{stem}.agp.tmp"));
    let history_temp = target.with_file_name(format!("{stem}.history.tmp"));
    let agp = create(&agp_temp)?;
    let history = match create(&history_temp) {
        Ok(file) => file,
        Err(e) => {
            drop(agp);
            let _ = fs::remove_file(&agp_temp);
            return Err(e);
        }
    };
    let pending = PendingSave {
        target,
        history_target,
        agp_temp,
        history_temp,
        agp: Some(agp),
        history: Some(history),
    };
    saves()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, pending);
    Ok(Some(id))
}

pub fn append(session: u64, part: &str, contents: &str) -> Result<(), String> {
    if contents.len() > 1024 * 1024 {
        return Err("save chunk exceeds 1 MiB".into());
    }
    let mut saves = saves().lock().map_err(|e| e.to_string())?;
    let save = saves.get_mut(&session).ok_or("unknown save session")?;
    match part {
        "agp" => save
            .agp
            .as_mut()
            .unwrap()
            .write_all(contents.as_bytes())
            .map_err(|e| error(&save.target, e)),
        "history" => save
            .history
            .as_mut()
            .unwrap()
            .write_all(contents.as_bytes())
            .map_err(|e| error(&save.history_target, e)),
        _ => Err("unknown save part".into()),
    }
}

pub fn abort(session: u64) -> Result<(), String> {
    saves().lock().map_err(|e| e.to_string())?.remove(&session);
    Ok(())
}

// Keep old files recoverable until both replacements succeed. Temporary files
// live beside the destination, so renames stay on the same filesystem.
fn replace_pair(
    agp_temp: &Path,
    history_temp: &Path,
    target: &Path,
    history: &Path,
) -> Result<(), String> {
    let pairs = [(agp_temp, target), (history_temp, history)];
    let mut backups: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut installed: Vec<PathBuf> = Vec::new();
    let result = (|| {
        for (temp, dest) in pairs {
            if dest.exists() {
                if !dest.is_file() {
                    return Err(error(dest, "destination is not a regular file"));
                }
                let backup = temp.with_extension("backup");
                fs::rename(dest, &backup).map_err(|e| error(dest, e))?;
                backups.push((backup, dest.to_path_buf()));
            }
        }
        // Publish history first, as in the original bundle writer.
        for (temp, dest) in pairs.into_iter().rev() {
            fs::rename(temp, dest).map_err(|e| error(dest, e))?;
            installed.push(dest.to_path_buf());
        }
        Ok(())
    })();
    if let Err(mut err) = result {
        for dest in installed {
            if let Err(e) = fs::remove_file(&dest) {
                err += &format!("; rollback: {}", error(&dest, e));
            }
        }
        for (backup, dest) in backups.into_iter().rev() {
            if let Err(e) = fs::rename(&backup, &dest) {
                err += &format!("; recovery backup retained at {}: {e}", backup.display());
            }
        }
        return Err(err);
    }
    for (backup, _) in backups {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

pub fn finish(session: u64) -> Result<String, String> {
    let mut save = saves()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session)
        .ok_or("unknown save session")?;
    save.agp
        .take()
        .unwrap()
        .sync_all()
        .map_err(|e| error(&save.target, e))?;
    save.history
        .take()
        .unwrap()
        .sync_all()
        .map_err(|e| error(&save.history_target, e))?;
    replace_pair(
        &save.agp_temp,
        &save.history_temp,
        &save.target,
        &save.history_target,
    )?;
    Ok(save.target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "cstudio-stream-test-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn publishes_both_files_only_after_completion() {
        let dir = directory();
        let agp = dir.join("test.agp");
        let history = dir.join("test.history.json");
        fs::write(&agp, "old agp").unwrap();
        fs::write(&history, "old history").unwrap();
        let id = begin(agp.to_string_lossy().into_owned(), history.clone(), true)
            .unwrap()
            .unwrap();
        append(id, "agp", "new ").unwrap();
        append(id, "agp", "agp").unwrap();
        append(id, "history", "{\"unicode\":\"🧬\"}").unwrap();
        assert_eq!(fs::read_to_string(&agp).unwrap(), "old agp");
        finish(id).unwrap();
        assert_eq!(fs::read_to_string(&agp).unwrap(), "new agp");
        assert_eq!(
            fs::read_to_string(&history).unwrap(),
            "{\"unicode\":\"🧬\"}"
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn abort_preserves_previous_pair_and_cleans_temps() {
        let dir = directory();
        let agp = dir.join("test.agp");
        let history = dir.join("test.history.json");
        fs::write(&agp, "old").unwrap();
        fs::write(&history, "old history").unwrap();
        let id = begin(agp.to_string_lossy().into_owned(), history.clone(), false)
            .unwrap()
            .unwrap();
        append(id, "agp", "partial").unwrap();
        assert!(append(id, "history", &"x".repeat(1024 * 1024 + 1)).is_err());
        abort(id).unwrap();
        assert_eq!(fs::read_to_string(&agp).unwrap(), "old");
        assert_eq!(fs::read_to_string(&history).unwrap(), "old history");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_commit_restores_backups() {
        let dir = directory();
        let agp = dir.join("test.agp");
        let history = dir.join("test.history.json");
        let agp_temp = dir.join("a.tmp");
        let history_temp = dir.join("h.tmp");
        fs::write(&agp, "old").unwrap();
        fs::write(&history, "old history").unwrap();
        fs::write(&history_temp, "new history").unwrap();
        assert!(replace_pair(&agp_temp, &history_temp, &agp, &history).is_err());
        assert_eq!(fs::read_to_string(&agp).unwrap(), "old");
        assert_eq!(fs::read_to_string(&history).unwrap(), "old history");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_overwrite_target_does_not_create_a_session() {
        let dir = directory();
        assert_eq!(
            begin(
                dir.join("absent.agp").to_string_lossy().into_owned(),
                dir.join("h.json"),
                true
            )
            .unwrap(),
            None
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        fs::remove_dir_all(dir).unwrap();
    }
}
