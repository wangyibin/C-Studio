use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};

const MAGIC: [u8; 4] = *b"CSL1";
const VERSION: u16 = 1;
const FLAGS: u16 = 0;
const HEADER_BYTES: u64 = 68;
const CELL_BYTES: u64 = 24;
const MAX_KEY_BYTES: usize = 16 * 1024 * 1024;
const MAX_CELL_COUNT: usize = 50_000_000;
static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LodCacheCell {
    pub x_bin: u64,
    pub y_bin: u64,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LodCachePayload {
    pub source_resolution: u64,
    pub target_resolution: u64,
    pub viewport: [u64; 4],
    pub cells: Vec<LodCacheCell>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LodCachePruneStats {
    pub removed_entries: usize,
    pub removed_bytes: u64,
}

pub fn load(root: &Path, key: &[u8]) -> io::Result<Option<LodCachePayload>> {
    validate_key(key)?;
    let path = cache_path(root, key);
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata_len = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let mut magic = [0_u8; 4];
    reader.read_exact(&mut magic)?;
    if magic != MAGIC {
        return Err(invalid_data("persistent LOD cache magic mismatch"));
    }
    let version = read_u16(&mut reader)?;
    let flags = read_u16(&mut reader)?;
    if version != VERSION || flags != FLAGS {
        return Err(invalid_data("persistent LOD cache version mismatch"));
    }
    let key_len = usize::try_from(read_u32(&mut reader)?)
        .map_err(|_| invalid_data("persistent LOD key length exceeds platform range"))?;
    if key_len > MAX_KEY_BYTES {
        return Err(invalid_data("persistent LOD key is too large"));
    }
    let cell_count = usize::try_from(read_u64(&mut reader)?)
        .map_err(|_| invalid_data("persistent LOD cell count exceeds platform range"))?;
    if cell_count > MAX_CELL_COUNT {
        return Err(invalid_data(
            "persistent LOD cell count exceeds safety limit",
        ));
    }
    let source_resolution = read_u64(&mut reader)?;
    let target_resolution = read_u64(&mut reader)?;
    let viewport = [
        read_u64(&mut reader)?,
        read_u64(&mut reader)?,
        read_u64(&mut reader)?,
        read_u64(&mut reader)?,
    ];
    let expected_len = HEADER_BYTES
        .checked_add(u64::try_from(key_len).unwrap_or(u64::MAX))
        .and_then(|length| {
            length.checked_add(
                u64::try_from(cell_count)
                    .unwrap_or(u64::MAX)
                    .saturating_mul(CELL_BYTES),
            )
        })
        .ok_or_else(|| invalid_data("persistent LOD cache length overflow"))?;
    if metadata_len != expected_len {
        return Err(invalid_data("persistent LOD cache length mismatch"));
    }
    let mut stored_key = vec![0_u8; key_len];
    reader.read_exact(&mut stored_key)?;
    if stored_key != key {
        return Ok(None);
    }
    let mut cells = Vec::with_capacity(cell_count);
    for _ in 0..cell_count {
        cells.push(LodCacheCell {
            x_bin: read_u64(&mut reader)?,
            y_bin: read_u64(&mut reader)?,
            count: f64::from_bits(read_u64(&mut reader)?),
        });
    }
    Ok(Some(LodCachePayload {
        source_resolution,
        target_resolution,
        viewport,
        cells,
    }))
}

pub fn store_atomic(root: &Path, key: &[u8], payload: &LodCachePayload) -> io::Result<PathBuf> {
    validate_key(key)?;
    if payload.cells.len() > MAX_CELL_COUNT {
        return Err(invalid_input(
            "persistent LOD cell count exceeds safety limit",
        ));
    }
    fs::create_dir_all(root)?;
    let final_path = cache_path(root, key);
    let temp_id = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
    let temp_path = root.join(format!(
        ".{}.{}.{}.tmp",
        std::process::id(),
        temp_id,
        file_stem(key),
    ));
    let write_result = (|| {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(&MAGIC)?;
        writer.write_all(&VERSION.to_le_bytes())?;
        writer.write_all(&FLAGS.to_le_bytes())?;
        writer.write_all(
            &u32::try_from(key.len())
                .map_err(|_| invalid_input("persistent LOD key is too large"))?
                .to_le_bytes(),
        )?;
        writer.write_all(
            &u64::try_from(payload.cells.len())
                .map_err(|_| invalid_input("persistent LOD cell count exceeds u64"))?
                .to_le_bytes(),
        )?;
        writer.write_all(&payload.source_resolution.to_le_bytes())?;
        writer.write_all(&payload.target_resolution.to_le_bytes())?;
        for value in payload.viewport {
            writer.write_all(&value.to_le_bytes())?;
        }
        writer.write_all(key)?;
        for cell in &payload.cells {
            writer.write_all(&cell.x_bin.to_le_bytes())?;
            writer.write_all(&cell.y_bin.to_le_bytes())?;
            writer.write_all(&cell.count.to_bits().to_le_bytes())?;
        }
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        // POSIX rename atomically replaces an old entry for the same exact key.
        // On platforms that reject replacement, discard the old cache file and
        // immediately install the fully flushed temporary file.
        if let Err(error) = fs::rename(&temp_path, &final_path) {
            if final_path.exists() {
                fs::remove_file(&final_path)?;
                fs::rename(&temp_path, &final_path)?;
            } else {
                return Err(error);
            }
        }
        Ok(final_path.clone())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

pub fn remove_entry(root: &Path, key: &[u8]) -> io::Result<()> {
    match fs::remove_file(cache_path(root, key)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn prune(root: &Path, max_bytes: u64, max_entries: usize) -> io::Result<LodCachePruneStats> {
    let directory = match fs::read_dir(root) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(error) => return Err(error),
    };
    let mut entries = Vec::new();
    let mut total_bytes = 0_u64;
    for entry in directory {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("cslod") {
            continue;
        }
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        let bytes = metadata.len();
        total_bytes = total_bytes.saturating_add(bytes);
        entries.push((
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            path,
            bytes,
        ));
    }
    entries.sort_by_key(|entry| entry.0);
    let mut stats = LodCachePruneStats::default();
    let mut retained_entries = entries.len();
    for (_, path, bytes) in entries {
        if retained_entries <= max_entries && total_bytes <= max_bytes {
            break;
        }
        match fs::remove_file(path) {
            Ok(()) => {
                retained_entries = retained_entries.saturating_sub(1);
                total_bytes = total_bytes.saturating_sub(bytes);
                stats.removed_entries = stats.removed_entries.saturating_add(1);
                stats.removed_bytes = stats.removed_bytes.saturating_add(bytes);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                retained_entries = retained_entries.saturating_sub(1);
                total_bytes = total_bytes.saturating_sub(bytes);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(stats)
}

fn cache_path(root: &Path, key: &[u8]) -> PathBuf {
    root.join(format!("{}.cslod", file_stem(key)))
}

fn file_stem(key: &[u8]) -> String {
    format!("{:016x}-{}", fnv1a64(key), key.len())
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn validate_key(key: &[u8]) -> io::Result<()> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return Err(invalid_input("persistent LOD key length is invalid"));
    }
    Ok(())
}

fn read_u16(reader: &mut impl Read) -> io::Result<u16> {
    let mut bytes = [0_u8; 2];
    reader.read_exact(&mut bytes)?;
    Ok(u16::from_le_bytes(bytes))
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> io::Result<u64> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

fn invalid_data(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn invalid_input(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::{load, prune, remove_entry, store_atomic, LodCacheCell, LodCachePayload};
    use std::{fs, time::SystemTime};

    fn temp_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "cstudio-lod-cache-test-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ))
    }

    fn payload() -> LodCachePayload {
        LodCachePayload {
            source_resolution: 1_000,
            target_resolution: 2_500_000,
            viewport: [0, 10_000_000, 0, 10_000_000],
            cells: vec![LodCacheCell {
                x_bin: 2,
                y_bin: 3,
                count: 7.25,
            }],
        }
    }

    #[test]
    fn round_trips_exact_key_and_f64_bits() {
        let root = temp_root("roundtrip");
        let key = b"source-and-layout-a";
        store_atomic(&root, key, &payload()).unwrap();

        assert_eq!(load(&root, key).unwrap(), Some(payload()));
        assert_eq!(load(&root, b"source-and-layout-b").unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_truncated_entries_and_allows_replacement() {
        let root = temp_root("corrupt");
        let key = b"source-and-layout";
        let path = store_atomic(&root, key, &payload()).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(12).unwrap();
        assert!(load(&root, key).is_err());

        remove_entry(&root, key).unwrap();
        store_atomic(&root, key, &payload()).unwrap();
        assert_eq!(load(&root, key).unwrap(), Some(payload()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prunes_only_lod_entries_to_the_requested_limit() {
        let root = temp_root("prune");
        store_atomic(&root, b"a", &payload()).unwrap();
        store_atomic(&root, b"b", &payload()).unwrap();
        fs::write(root.join("keep.txt"), b"not a lod cache entry").unwrap();

        let stats = prune(&root, u64::MAX, 1).unwrap();
        assert_eq!(stats.removed_entries, 1);
        assert!(root.join("keep.txt").exists());
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str())
                        == Some("cslod")
                )
                .count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_same_key_writers_leave_one_complete_entry() {
        let root = temp_root("concurrent");
        let workers = (0..8)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || store_atomic(&root, b"shared", &payload()))
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }

        assert_eq!(load(&root, b"shared").unwrap(), Some(payload()));
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str())
                        == Some("cslod")
                )
                .count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }
}
