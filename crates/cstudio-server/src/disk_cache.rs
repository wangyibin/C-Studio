//! Optional persistent count tiles. Corrupt/missing entries are cache misses.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Write,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::SystemTime,
};
const MAX_ENTRY: usize = 64 * 1024 * 1024;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CACHE: OnceLock<Option<DiskCache>> = OnceLock::new();
static PORT: OnceLock<u16> = OnceLock::new();
pub(super) fn configure(port: u16) {
    let _ = PORT.set(port);
}
pub(super) fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
pub(super) fn global() -> Option<&'static DiskCache> {
    CACHE
        .get_or_init(|| {
            if cfg!(test) {
                return None;
            }
            let mb = std::env::var("CSTUDIO_DISK_CACHE_MB")
                .ok()
                .and_then(|x| x.parse::<u64>().ok())
                .unwrap_or(4096)
                .min(1_048_576);
            if mb == 0 {
                return None;
            }
            let root = std::env::var_os("CSTUDIO_DISK_CACHE_DIR")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("XDG_CACHE_HOME")
                        .map(|p| PathBuf::from(p).join("cstudio-server"))
                })
                .or_else(|| {
                    std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".cache/cstudio-server"))
                })?;
            let root = if std::env::var_os("CSTUDIO_DISK_CACHE_DIR").is_some() {
                root
            } else {
                root.join(format!("port-{}", PORT.get().copied().unwrap_or(8787)))
            };
            match DiskCache::new(root.join("counts-v1"), mb * 1024 * 1024) {
                Ok(cache) => Some(cache),
                Err(e) => {
                    tracing::warn!(error=%e,"disk cache disabled");
                    None
                }
            }
        })
        .as_ref()
}
#[derive(Default)]
struct Index {
    files: BTreeMap<String, (u64, SystemTime)>,
    bytes: u64,
}
pub(super) struct DiskCache {
    root: PathBuf,
    budget: u64,
    index: Mutex<Index>,
    hits: AtomicU64,
    writes: AtomicU64,
}
impl DiskCache {
    fn new(root: PathBuf, budget: u64) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        let mut index = Index::default();
        for entry in fs::read_dir(&root)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.len() != 69
                || !name.ends_with(".tile")
                || !name[..64].bytes().all(|b| b.is_ascii_hexdigit())
            {
                continue;
            }
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.is_file() {
                index.bytes += meta.len();
                index.files.insert(name, (meta.len(), meta.modified()?));
            }
        }
        let cache = Self {
            root,
            budget,
            index: Mutex::new(index),
            hits: AtomicU64::new(0),
            writes: AtomicU64::new(0),
        };
        cache.trim(&mut cache.index.lock().unwrap(), 0);
        Ok(cache)
    }
    fn trim(&self, index: &mut Index, reserve: u64) {
        while index.bytes.saturating_add(reserve) > self.budget {
            let Some(name) = index
                .files
                .iter()
                .min_by_key(|(_, v)| v.1)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Err(e) = fs::remove_file(self.root.join(&name)) {
                tracing::warn!(error=%e,"cache eviction failed");
                break;
            }
            let size = index.files.remove(&name).unwrap().0;
            index.bytes = index.bytes.saturating_sub(size);
        }
    }
    pub(super) fn get(&self, key: &str) -> Option<Arc<Vec<ContactMapCell>>> {
        let name = format!("{}.tile", digest(key.as_bytes()));
        let path = self.root.join(&name);
        let meta = fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > MAX_ENTRY as u64 {
            return None;
        }
        let bytes = fs::read(&path).ok()?;
        let parsed = (|| {
            if bytes.len() < 52 || &bytes[..8] != b"CSTILE01" {
                return None;
            }
            let end = bytes.len() - 32;
            if Sha256::digest(&bytes[..end]).as_slice() != &bytes[end..] {
                return None;
            }
            let n = u32::from_le_bytes(bytes[8..12].try_into().ok()?) as usize;
            if 20usize.checked_add(n)? > end || bytes.get(12..12 + n)? != key.as_bytes() {
                return None;
            }
            let count = u64::from_le_bytes(bytes[12 + n..20 + n].try_into().ok()?) as usize;
            if count.checked_mul(24)?.checked_add(20 + n)? != end {
                return None;
            }
            let mut cells = Vec::with_capacity(count);
            for c in bytes[20 + n..end].chunks_exact(24) {
                let count = f64::from_le_bytes(c[16..24].try_into().ok()?);
                if !count.is_finite() {
                    return None;
                }
                cells.push(ContactMapCell {
                    x_bin: u64::from_le_bytes(c[..8].try_into().ok()?),
                    y_bin: u64::from_le_bytes(c[8..16].try_into().ok()?),
                    count,
                });
            }
            Some(Arc::new(cells))
        })();
        if parsed.is_some() {
            self.hits.fetch_add(1, Ordering::Relaxed);
            if let Some(entry) = self.index.lock().unwrap().files.get_mut(&name) {
                entry.1 = SystemTime::now();
            }
            if let Ok(file) = fs::File::open(path) {
                let _ = file.set_modified(SystemTime::now());
            }
        }
        parsed
    }
    pub(super) fn put(&self, key: &str, cells: &[ContactMapCell]) {
        let size = 20usize
            .saturating_add(key.len())
            .saturating_add(cells.len().saturating_mul(24))
            .saturating_add(32);
        if size > MAX_ENTRY || size as u64 > self.budget {
            return;
        }
        let mut bytes = Vec::with_capacity(size);
        bytes.extend_from_slice(b"CSTILE01");
        bytes.extend_from_slice(&(key.len() as u32).to_le_bytes());
        bytes.extend_from_slice(key.as_bytes());
        bytes.extend_from_slice(&(cells.len() as u64).to_le_bytes());
        for c in cells {
            bytes.extend_from_slice(&c.x_bin.to_le_bytes());
            bytes.extend_from_slice(&c.y_bin.to_le_bytes());
            bytes.extend_from_slice(&c.count.to_le_bytes());
        }
        let checksum = Sha256::digest(&bytes);
        bytes.extend_from_slice(&checksum);
        let name = format!("{}.tile", digest(key.as_bytes()));
        let temp = self.root.join(format!(
            ".{}-{}.tmp",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| -> std::io::Result<()> {
            let mut index = self.index.lock().unwrap();
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            file.write_all(&bytes)?;
            drop(file);
            if index.files.contains_key(&name) {
                match fs::remove_file(self.root.join(&name)) {
                    Ok(()) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e),
                }
            }
            if let Some(old) = index.files.remove(&name) {
                index.bytes = index.bytes.saturating_sub(old.0);
            }
            self.trim(&mut index, size as u64);
            if index.bytes.saturating_add(size as u64) > self.budget {
                return Err(std::io::Error::other("cache budget cannot be reclaimed"));
            }
            fs::rename(&temp, self.root.join(&name))?;
            index.bytes += size as u64;
            index.files.insert(name, (size as u64, SystemTime::now()));
            self.writes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })();
        if let Err(e) = result {
            let _ = fs::remove_file(temp);
            tracing::warn!(error=%e,"disk cache write skipped");
        }
    }
    pub(super) fn status(&self) -> serde_json::Value {
        let i = self.index.lock().unwrap();
        serde_json::json!({"enabled":true,"bytes":i.bytes,"budgetBytes":self.budget,"entries":i.files.len(),"hits":self.hits.load(Ordering::Relaxed),"writes":self.writes.load(Ordering::Relaxed)})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_corruption_and_budget() {
        let root = std::env::temp_dir().join(format!(
            "cstudio-disk-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let c = DiskCache::new(root.clone(), 200).unwrap();
        let cells = vec![ContactMapCell {
            x_bin: 1,
            y_bin: 2,
            count: 3.5,
        }];
        c.put("layout-A", &cells);
        drop(c);
        let c = DiskCache::new(root.clone(), 200).unwrap();
        assert_eq!(c.get("layout-A").unwrap()[0].count, 3.5);
        assert!(c.get("layout-B").is_none());
        fs::write(
            root.join(format!("{}.tile", digest(b"layout-A"))),
            b"broken",
        )
        .unwrap();
        assert!(c.get("layout-A").is_none());
        for n in 0..10 {
            c.put(&n.to_string(), &cells);
        }
        assert!(c.index.lock().unwrap().bytes <= 200);
        fs::remove_dir_all(root).unwrap();
    }
}
