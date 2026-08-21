use std::{
    borrow::Cow,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};

use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};

const MAGIC: [u8; 4] = *b"CSDT";
const VERSION: u16 = 1;
const FLAGS_ZLIB_FLOAT32: u16 = 1;
const FLAGS_ZLIB_R16F: u16 = 2;
const HEADER_BYTES: u64 = 64;
const MAX_KEY_BYTES: usize = 16 * 1024 * 1024;
const MAX_TILE_SIZE_BINS: u32 = 1_024;
const MAX_VALUE_COUNT: usize = MAX_TILE_SIZE_BINS as usize * MAX_TILE_SIZE_BINS as usize;
static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq)]
pub enum DisplayCacheValues {
    Float32(Vec<f32>),
    R16f(Vec<u16>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayCacheStorageFormat {
    Float32,
    R16f,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisplayCacheTile {
    pub tile_size_bins: u32,
    pub tile_x: u64,
    pub tile_y: u64,
    /// Row-major display values. `-1.0` / `0xbc00` is the empty-pixel sentinel.
    pub values: DisplayCacheValues,
}

impl DisplayCacheTile {
    pub fn value_count(&self) -> usize {
        match &self.values {
            DisplayCacheValues::Float32(values) => values.len(),
            DisplayCacheValues::R16f(values) => values.len(),
        }
    }

    pub fn r16f_values(&self) -> Option<&[u16]> {
        match &self.values {
            DisplayCacheValues::R16f(values) => Some(values),
            DisplayCacheValues::Float32(_) => None,
        }
    }

    pub fn float32_values(&self) -> Cow<'_, [f32]> {
        match &self.values {
            DisplayCacheValues::Float32(values) => Cow::Borrowed(values),
            DisplayCacheValues::R16f(values) => Cow::Owned(
                values
                    .iter()
                    .map(|value| r16f_bits_to_f32(*value))
                    .collect(),
            ),
        }
    }

    pub fn occupied_count(&self) -> usize {
        match &self.values {
            DisplayCacheValues::Float32(values) => {
                values.iter().filter(|value| **value != -1.0).count()
            }
            DisplayCacheValues::R16f(values) => values
                .iter()
                .filter(|value| **value != R16F_EMPTY_SENTINEL)
                .count(),
        }
    }
}

pub const R16F_EMPTY_SENTINEL: u16 = 0xbc00;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DisplayCachePruneStats {
    pub removed_entries: usize,
    pub removed_bytes: u64,
}

pub fn digest_name(bytes: &[u8]) -> String {
    format!("{:016x}-{}", fnv1a64(bytes), bytes.len())
}

pub fn load(root: &Path, key: &[u8]) -> io::Result<Option<DisplayCacheTile>> {
    validate_key(key)?;
    let path = cache_path(root, key);
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata_len = file.metadata()?.len();
    let mut reader = BufReader::new(file);
    let mut magic = [0_u8; 4];
    reader.read_exact(&mut magic)?;
    if magic != MAGIC {
        return Err(invalid_data("display cache magic mismatch"));
    }
    let version = read_u16(&mut reader)?;
    let flags = read_u16(&mut reader)?;
    if version != VERSION || (flags != FLAGS_ZLIB_FLOAT32 && flags != FLAGS_ZLIB_R16F) {
        return Err(invalid_data("display cache version or flags mismatch"));
    }
    let key_len = usize::try_from(read_u32(&mut reader)?)
        .map_err(|_| invalid_data("display cache key length exceeds platform range"))?;
    if key_len == 0 || key_len > MAX_KEY_BYTES {
        return Err(invalid_data("display cache key length is invalid"));
    }
    let tile_size_bins = read_u32(&mut reader)?;
    validate_tile_size(tile_size_bins)?;
    let tile_x = read_u64(&mut reader)?;
    let tile_y = read_u64(&mut reader)?;
    let value_count = usize::try_from(read_u64(&mut reader)?)
        .map_err(|_| invalid_data("display cache value count exceeds platform range"))?;
    let raw_bytes = usize::try_from(read_u64(&mut reader)?)
        .map_err(|_| invalid_data("display cache raw length exceeds platform range"))?;
    let compressed_bytes = usize::try_from(read_u64(&mut reader)?)
        .map_err(|_| invalid_data("display cache compressed length exceeds platform range"))?;
    let checksum = read_u64(&mut reader)?;

    let expected_values = tile_value_count(tile_size_bins)?;
    if value_count != expected_values || value_count > MAX_VALUE_COUNT {
        return Err(invalid_data(
            "display cache value count does not match tile size",
        ));
    }
    let bytes_per_value = if flags == FLAGS_ZLIB_R16F {
        std::mem::size_of::<u16>()
    } else {
        std::mem::size_of::<f32>()
    };
    let expected_raw_bytes = value_count
        .checked_mul(bytes_per_value)
        .ok_or_else(|| invalid_data("display cache raw length overflow"))?;
    if raw_bytes != expected_raw_bytes {
        return Err(invalid_data(
            "display cache raw length does not match value count",
        ));
    }
    let expected_file_len = HEADER_BYTES
        .checked_add(u64::try_from(key_len).unwrap_or(u64::MAX))
        .and_then(|length| length.checked_add(u64::try_from(compressed_bytes).ok()?))
        .ok_or_else(|| invalid_data("display cache file length overflow"))?;
    if metadata_len != expected_file_len {
        return Err(invalid_data("display cache file length mismatch"));
    }

    let mut stored_key = vec![0_u8; key_len];
    reader.read_exact(&mut stored_key)?;
    if stored_key != key {
        return Ok(None);
    }
    let mut compressed = vec![0_u8; compressed_bytes];
    reader.read_exact(&mut compressed)?;
    let mut decoder = ZlibDecoder::new(compressed.as_slice());
    let mut raw = Vec::with_capacity(raw_bytes);
    decoder
        .by_ref()
        .take(
            u64::try_from(raw_bytes)
                .unwrap_or(u64::MAX)
                .saturating_add(1),
        )
        .read_to_end(&mut raw)
        .map_err(|error| invalid_data(format!("display cache decompression failed: {error}")))?;
    if raw.len() != raw_bytes {
        return Err(invalid_data("display cache decompressed length mismatch"));
    }
    if fnv1a64(&raw) != checksum {
        return Err(invalid_data("display cache checksum mismatch"));
    }
    let values = if flags == FLAGS_ZLIB_R16F {
        let values = raw
            .chunks_exact(std::mem::size_of::<u16>())
            .map(|bytes| u16::from_le_bytes(bytes.try_into().expect("two-byte half chunk")))
            .collect::<Vec<_>>();
        if values.iter().any(|value| r16f_bits_are_non_finite(*value)) {
            return Err(invalid_data(
                "display cache contains non-finite R16F values",
            ));
        }
        DisplayCacheValues::R16f(values)
    } else {
        let values = raw
            .chunks_exact(std::mem::size_of::<f32>())
            .map(|bytes| f32::from_le_bytes(bytes.try_into().expect("four-byte float chunk")))
            .collect::<Vec<_>>();
        if values.iter().any(|value| !value.is_finite()) {
            return Err(invalid_data("display cache contains non-finite values"));
        }
        DisplayCacheValues::Float32(values)
    };
    Ok(Some(DisplayCacheTile {
        tile_size_bins,
        tile_x,
        tile_y,
        values,
    }))
}

#[cfg(test)]
pub fn store_atomic(root: &Path, key: &[u8], tile: &DisplayCacheTile) -> io::Result<PathBuf> {
    store_atomic_with_format(root, key, tile, DisplayCacheStorageFormat::R16f)
}

pub fn store_atomic_with_format(
    root: &Path,
    key: &[u8],
    tile: &DisplayCacheTile,
    preferred_format: DisplayCacheStorageFormat,
) -> io::Result<PathBuf> {
    validate_key(key)?;
    validate_tile(tile)?;
    fs::create_dir_all(root)?;

    let (flags, raw) = encoded_tile_values(tile, preferred_format);
    let checksum = fnv1a64(&raw);
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(3));
    encoder.write_all(&raw)?;
    let compressed = encoder.finish()?;

    let final_path = cache_path(root, key);
    let temp_id = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
    let temp_path = root.join(format!(
        ".{}.{}.{}.tmp",
        std::process::id(),
        temp_id,
        digest_name(key),
    ));
    let write_result = (|| {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(&MAGIC)?;
        writer.write_all(&VERSION.to_le_bytes())?;
        writer.write_all(&flags.to_le_bytes())?;
        writer.write_all(
            &u32::try_from(key.len())
                .map_err(|_| invalid_input("display cache key is too large"))?
                .to_le_bytes(),
        )?;
        writer.write_all(&tile.tile_size_bins.to_le_bytes())?;
        writer.write_all(&tile.tile_x.to_le_bytes())?;
        writer.write_all(&tile.tile_y.to_le_bytes())?;
        writer.write_all(
            &u64::try_from(tile.value_count())
                .map_err(|_| invalid_input("display cache value count exceeds u64"))?
                .to_le_bytes(),
        )?;
        writer.write_all(
            &u64::try_from(raw.len())
                .map_err(|_| invalid_input("display cache raw length exceeds u64"))?
                .to_le_bytes(),
        )?;
        writer.write_all(
            &u64::try_from(compressed.len())
                .map_err(|_| invalid_input("display cache compressed length exceeds u64"))?
                .to_le_bytes(),
        )?;
        writer.write_all(&checksum.to_le_bytes())?;
        writer.write_all(key)?;
        writer.write_all(&compressed)?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
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

/// Prunes cache files recursively, oldest access/modified time first.
pub fn prune_tree(
    root: &Path,
    max_bytes: u64,
    max_entries: usize,
) -> io::Result<DisplayCachePruneStats> {
    let mut pending_directories = vec![root.to_path_buf()];
    let mut entries = Vec::new();
    let mut total_bytes = 0_u64;
    while let Some(directory_path) = pending_directories.pop() {
        let directory = match fs::read_dir(&directory_path) {
            Ok(directory) => directory,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in directory {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                pending_directories.push(entry.path());
                continue;
            }
            if !file_type.is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("csdt")
            {
                continue;
            }
            let metadata = entry.metadata()?;
            let bytes = metadata.len();
            total_bytes = total_bytes.saturating_add(bytes);
            entries.push((
                metadata
                    .accessed()
                    .or_else(|_| metadata.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH),
                entry.path(),
                bytes,
            ));
        }
    }
    entries.sort_by_key(|entry| entry.0);
    let mut stats = DisplayCachePruneStats::default();
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
    root.join(format!("{}.csdt", digest_name(key)))
}

fn validate_key(key: &[u8]) -> io::Result<()> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return Err(invalid_input("display cache key length is invalid"));
    }
    Ok(())
}

fn validate_tile_size(tile_size_bins: u32) -> io::Result<()> {
    if tile_size_bins == 0 || tile_size_bins > MAX_TILE_SIZE_BINS {
        return Err(invalid_data("display cache tile size is outside 1..1024"));
    }
    Ok(())
}

fn tile_value_count(tile_size_bins: u32) -> io::Result<usize> {
    let tile_size = usize::try_from(tile_size_bins)
        .map_err(|_| invalid_data("display cache tile size exceeds platform range"))?;
    tile_size
        .checked_mul(tile_size)
        .ok_or_else(|| invalid_data("display cache tile value count overflow"))
}

fn validate_tile(tile: &DisplayCacheTile) -> io::Result<()> {
    validate_tile_size(tile.tile_size_bins).map_err(|error| invalid_input(error.to_string()))?;
    let expected_values =
        tile_value_count(tile.tile_size_bins).map_err(|error| invalid_input(error.to_string()))?;
    if tile.value_count() != expected_values {
        return Err(invalid_input(
            "display cache value count does not match tile size",
        ));
    }
    match &tile.values {
        DisplayCacheValues::Float32(values) if values.iter().any(|value| !value.is_finite()) => {
            return Err(invalid_input("display cache values must be finite"));
        }
        DisplayCacheValues::R16f(values)
            if values.iter().any(|value| r16f_bits_are_non_finite(*value)) =>
        {
            return Err(invalid_input("display cache R16F values must be finite"));
        }
        _ => {}
    }
    Ok(())
}

fn encoded_tile_values(
    tile: &DisplayCacheTile,
    preferred_format: DisplayCacheStorageFormat,
) -> (u16, Vec<u8>) {
    if preferred_format == DisplayCacheStorageFormat::R16f {
        let r16f = match &tile.values {
            DisplayCacheValues::R16f(values) => Some(values.clone()),
            DisplayCacheValues::Float32(values) => {
                values.iter().copied().map(f32_to_r16f_bits).collect()
            }
        };
        if let Some(values) = r16f {
            let mut raw = Vec::with_capacity(values.len() * std::mem::size_of::<u16>());
            for value in values {
                raw.extend_from_slice(&value.to_le_bytes());
            }
            return (FLAGS_ZLIB_R16F, raw);
        }
    }

    let values = tile.float32_values();
    let mut raw = Vec::with_capacity(values.len() * std::mem::size_of::<f32>());
    for value in values.iter() {
        raw.extend_from_slice(&value.to_le_bytes());
    }
    (FLAGS_ZLIB_FLOAT32, raw)
}

pub fn f32_to_r16f_bits(value: f32) -> Option<u16> {
    if !value.is_finite() || value.abs() > 65_504.0 {
        return None;
    }
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x7f_ffff;

    if exponent <= 0 {
        if exponent < -10 {
            return Some(sign);
        }
        let normalized = mantissa | 0x80_0000;
        let shift = u32::try_from(14 - exponent).expect("R16F subnormal shift is positive");
        let mut rounded = normalized >> shift;
        let remainder = normalized & ((1_u32 << shift) - 1);
        let halfway = 1_u32 << (shift - 1);
        if remainder > halfway || (remainder == halfway && rounded & 1 != 0) {
            rounded += 1;
        }
        return Some(sign | rounded as u16);
    }

    let mut half_exponent = exponent as u16;
    let mut half_mantissa = (mantissa >> 13) as u16;
    let remainder = mantissa & 0x1fff;
    if remainder > 0x1000 || (remainder == 0x1000 && half_mantissa & 1 != 0) {
        half_mantissa += 1;
        if half_mantissa == 0x400 {
            half_mantissa = 0;
            half_exponent += 1;
        }
    }
    if half_exponent >= 0x1f {
        return None;
    }
    Some(sign | (half_exponent << 10) | half_mantissa)
}

pub fn r16f_bits_to_f32(value: u16) -> f32 {
    let sign = (u32::from(value & 0x8000)) << 16;
    let exponent = u32::from((value >> 10) & 0x1f);
    let mut mantissa = u32::from(value & 0x03ff);
    let bits = if exponent == 0 {
        if mantissa == 0 {
            sign
        } else {
            let mut normalized_exponent = 127 - 15 + 1;
            while mantissa & 0x0400 == 0 {
                mantissa <<= 1;
                normalized_exponent -= 1;
            }
            mantissa &= 0x03ff;
            sign | (normalized_exponent << 23) | (mantissa << 13)
        }
    } else {
        sign | ((exponent + 127 - 15) << 23) | (mantissa << 13)
    };
    f32::from_bits(bits)
}

fn r16f_bits_are_non_finite(value: u16) -> bool {
    value & 0x7c00 == 0x7c00
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
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

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cstudio-display-cache-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ))
    }

    fn tile(tile_x: u64) -> DisplayCacheTile {
        let mut values = vec![-1.0; 16];
        values[1] = 7.25;
        values[15] = 11.5;
        DisplayCacheTile {
            tile_size_bins: 4,
            tile_x,
            tile_y: 3,
            values: DisplayCacheValues::Float32(values),
        }
    }

    #[test]
    fn round_trips_compressed_r16f_tiles_and_empty_sentinel() {
        let root = temporary_root("roundtrip");
        let key = b"file|resolution|normalization|layout|copy-v1|0:3";
        let expected = tile(0);
        let path = store_atomic(&root, key, &expected).unwrap();
        assert!(fs::metadata(path).unwrap().len() < 16 * 4 + HEADER_BYTES + key.len() as u64);
        let loaded = load(&root, key).unwrap().unwrap();
        assert!(matches!(loaded.values, DisplayCacheValues::R16f(_)));
        assert_eq!(
            loaded.float32_values().as_ref(),
            expected.float32_values().as_ref()
        );
        assert_eq!(loaded.r16f_values().unwrap()[0], R16F_EMPTY_SENTINEL);
        assert_eq!(load(&root, b"another-key").unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_float32_format_on_request_or_r16f_range_fallback() {
        let root = temporary_root("float32-fallback");
        let explicit_key = b"explicit-float32";
        let expected = tile(0);
        store_atomic_with_format(
            &root,
            explicit_key,
            &expected,
            DisplayCacheStorageFormat::Float32,
        )
        .unwrap();
        assert_eq!(load(&root, explicit_key).unwrap(), Some(expected.clone()));

        let overflow_key = b"r16f-overflow";
        let mut overflow = expected;
        let DisplayCacheValues::Float32(values) = &mut overflow.values else {
            unreachable!();
        };
        values[1] = 70_000.0;
        store_atomic(&root, overflow_key, &overflow).unwrap();
        assert_eq!(load(&root, overflow_key).unwrap(), Some(overflow));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn converts_r16f_with_round_to_nearest_even() {
        for value in [-1.0, -0.0, 0.0, 0.000_061_035_156, 1.0, 7.25, 65_504.0] {
            let bits = f32_to_r16f_bits(value).unwrap();
            assert_eq!(r16f_bits_to_f32(bits), value);
        }
        assert_eq!(f32_to_r16f_bits(-1.0), Some(R16F_EMPTY_SENTINEL));
        assert_eq!(f32_to_r16f_bits(70_000.0), None);
        assert_eq!(f32_to_r16f_bits(f32::INFINITY), None);
    }

    #[test]
    fn rejects_corrupt_payloads_and_prunes_oldest_files() {
        let root = temporary_root("prune");
        let first_key = b"first";
        let second_key = b"second";
        let first_path = store_atomic(&root, first_key, &tile(1)).unwrap();
        let second_path = store_atomic(&root, second_key, &tile(2)).unwrap();
        let total_bytes =
            fs::metadata(&first_path).unwrap().len() + fs::metadata(&second_path).unwrap().len();
        let stats = prune_tree(&root, total_bytes, 1).unwrap();
        assert_eq!(stats.removed_entries, 1);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);

        let retained = if first_path.exists() {
            first_path
        } else {
            second_path
        };
        let mut bytes = fs::read(&retained).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        fs::write(&retained, bytes).unwrap();
        let retained_key: &[u8] =
            if retained.file_name() == cache_path(&root, first_key).file_name() {
                first_key
            } else {
                second_key
            };
        assert_eq!(
            load(&root, retained_key).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_same_key_writers_leave_one_complete_tile() {
        let root = temporary_root("concurrent");
        let key = b"same-display-tile";
        let writers = 8;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(writers));
        let handles = (0..writers)
            .map(|writer| {
                let root = root.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut candidate = tile(1);
                    let DisplayCacheValues::Float32(values) = &mut candidate.values else {
                        unreachable!();
                    };
                    values[1] = writer as f32;
                    barrier.wait();
                    store_atomic(&root, key, &candidate).unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }

        let loaded = load(&root, key).unwrap().unwrap();
        assert!((0.0..writers as f32).contains(&loaded.float32_values()[1]));
        assert_eq!(loaded.value_count(), 16);
        fs::remove_dir_all(root).unwrap();
    }
}
