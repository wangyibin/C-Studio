use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet, VecDeque},
    fs,
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering as AtomicOrdering},
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::{Duration, Instant, UNIX_EPOCH},
};

use hdf5::{
    types::{FixedAscii, TypeDescriptor, VarLenAscii, VarLenUnicode},
    Dataset, File,
};

use crate::{
    contact_map::{
        build_contact_map_view_from_contacts_cancellable, ContactBin, ContactMapCell,
        ContactMapQuery, ContactMapView, LayoutBlock,
    },
    contact_normalization::{
        compute_normalization_weights, ContactNormalization, SparseContactMatrix,
    },
    CStudioError, CStudioResult,
};

const MAX_COOL_INDEX_CACHE_BYTES: usize = 128 * 1024 * 1024;
const MAX_COOL_NORMALIZATION_CACHE_BYTES: usize = 128 * 1024 * 1024;
const PERSISTENT_NORMALIZATION_MAGIC: [u8; 4] = *b"CSN1";
const PERSISTENT_NORMALIZATION_VERSION: u16 = 1;
const RUNTIME_NORMALIZATION_MEMORY_NUMERATOR: usize = 4;
const RUNTIME_NORMALIZATION_MEMORY_DENOMINATOR: usize = 5;
const FALLBACK_RUNTIME_NORMALIZATION_MEMORY_BYTES: usize = 512 * 1024 * 1024;
const MAX_COOL_READER_CACHE_ENTRIES: usize = 8;
const MAX_ADAPTIVE_CHILD_CACHE_BYTES: usize = 128 * 1024 * 1024;
// Cooler pixel columns are commonly stored in 1-2 MiB compressed HDF5 chunks.
// HDF5's 1 MiB default raw chunk cache cannot retain even one bin2 chunk, so
// the many disjoint AGP source ranges in a visual tile repeatedly decompress
// the same chunks. Keep enough chunks resident for one viewport working set.
// The budget is per opened pixel dataset and allocated lazily by HDF5.
const COOL_PIXEL_CHUNK_CACHE_SLOTS: usize = 521;
const COOL_PIXEL_CHUNK_CACHE_BYTES: usize = 64 * 1024 * 1024;
const COOL_PIXEL_CHUNK_CACHE_PREEMPTION: f64 = 0.75;
// A compact resident bin2 column is a bounded, in-memory secondary index. It
// lets viewport reads identify the exact 2D pixel runs before touching the
// count dataset instead of decompressing every off-axis bin2 value again.
const MAX_COOL_RESIDENT_BIN2_ENTRY_BYTES: usize = 128 * 1024 * 1024;
const MAX_COOL_RESIDENT_BIN2_CACHE_BYTES: usize = 160 * 1024 * 1024;
const MAX_COOL_RESIDENT_COUNT_ENTRY_BYTES: usize = 128 * 1024 * 1024;
const MAX_COOL_RESIDENT_COUNT_CACHE_BYTES: usize = 160 * 1024 * 1024;
const COOL_RESIDENT_BIN2_READ_CHUNK: usize = 500_000;
const COOL_RESIDENT_PIXEL_BATCH_GAP: usize = 256;
const ADAPTIVE_TARGET_RESOLUTION: u64 = 2_500_000;
const ADAPTIVE_RESOLUTION_CHAIN: [u64; 5] = [2_500_000, 500_000, 100_000, 10_000, 1_000];
// bin1 is derived from the Cooler CSR bin1_offset index, so each chunk only
// holds bin2 and count arrays. At the widest supported element types this caps
// their combined raw payload near 8 MiB while keeping HDF5 call overhead low.
const MAX_COOL_PIXEL_READ_CHUNK: usize = 500_000;
// Streaming consumers can project or drain state after every chunk. A smaller
// bound keeps raw HDF5 payloads and transient projection state independent of
// the total number of source pixels.
const MAX_COOL_STREAM_PIXEL_READ_CHUNK: usize = 100_000;
// Reading a small unselected gap is cheaper than issuing another three HDF5
// hyperslab calls. Bridged pixels are still rejected by SelectedBinIndex.
const MAX_COOL_PIXEL_BATCH_GAP: usize = 16_384;
static PERSISTENT_NORMALIZATION_CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();
static NEXT_NORMALIZATION_CACHE_TEMP: AtomicU64 = AtomicU64::new(1);

fn runtime_normalization_memory_budget_bytes(available_bytes: usize) -> usize {
    ((available_bytes as u128) * (RUNTIME_NORMALIZATION_MEMORY_NUMERATOR as u128)
        / (RUNTIME_NORMALIZATION_MEMORY_DENOMINATOR as u128))
        .min(usize::MAX as u128) as usize
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn available_system_memory_bytes() -> Option<usize> {
    static HOST_PORT: OnceLock<libc::mach_port_t> = OnceLock::new();
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return None;
    }

    let host = *HOST_PORT.get_or_init(|| unsafe { libc::mach_host_self() });
    let mut statistics = std::mem::MaybeUninit::<libc::vm_statistics64_data_t>::zeroed();
    let mut count = libc::HOST_VM_INFO64_COUNT;
    let status = unsafe {
        libc::host_statistics64(
            host,
            libc::HOST_VM_INFO64,
            statistics.as_mut_ptr().cast::<libc::integer_t>(),
            &mut count,
        )
    };
    if status != libc::KERN_SUCCESS {
        return None;
    }
    let statistics = unsafe { statistics.assume_init() };
    // Inactive and speculative pages are reclaimable by the kernel. Excluding
    // active, wired, and compressed pages keeps this below physical memory and
    // reflects pressure at the moment a normalization allocation is attempted.
    let available_pages = u64::from(statistics.free_count)
        .saturating_add(u64::from(statistics.inactive_count))
        .saturating_add(u64::from(statistics.speculative_count));
    usize::try_from(available_pages.saturating_mul(page_size as u64)).ok()
}

#[cfg(target_os = "linux")]
fn available_system_memory_bytes() -> Option<usize> {
    let meminfo = fs::read_to_string("/proc/meminfo").ok()?;
    parse_linux_available_memory_bytes(&meminfo)
}

#[cfg(target_os = "linux")]
fn parse_linux_available_memory_bytes(meminfo: &str) -> Option<usize> {
    let kibibytes = meminfo.lines().find_map(|line| {
        let value = line.strip_prefix("MemAvailable:")?.trim();
        value.split_whitespace().next()?.parse::<usize>().ok()
    })?;
    kibibytes.checked_mul(1024)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn available_system_memory_bytes() -> Option<usize> {
    None
}

fn ensure_runtime_normalization_memory_budget(
    estimated_bytes: usize,
    allocation_scope: &str,
) -> CStudioResult<()> {
    ensure_runtime_normalization_memory_budget_with_available(
        estimated_bytes,
        allocation_scope,
        available_system_memory_bytes(),
    )
}

fn ensure_runtime_normalization_memory_budget_with_available(
    estimated_bytes: usize,
    allocation_scope: &str,
    available_bytes: Option<usize>,
) -> CStudioResult<()> {
    let (budget_bytes, availability) = match available_bytes {
        Some(available_bytes) => (
            runtime_normalization_memory_budget_bytes(available_bytes),
            format!(
                "{} MiB currently available; the 80% budget is {} MiB",
                available_bytes / (1024 * 1024),
                runtime_normalization_memory_budget_bytes(available_bytes) / (1024 * 1024),
            ),
        ),
        None => (
            FALLBACK_RUNTIME_NORMALIZATION_MEMORY_BYTES,
            format!(
                "available memory could not be determined; the fallback budget is {} MiB",
                FALLBACK_RUNTIME_NORMALIZATION_MEMORY_BYTES / (1024 * 1024),
            ),
        ),
    };
    if estimated_bytes > budget_bytes {
        return Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool runtime normalization estimates about {} MiB {allocation_scope}, but {availability}; add a precomputed bins normalization vector or free memory",
            estimated_bytes / (1024 * 1024),
        )));
    }
    Ok(())
}

fn estimated_runtime_normalization_peak_bytes(
    pixel_count: usize,
    bin_count: usize,
    normalization: ContactNormalization,
) -> usize {
    // SparseContactMatrix construction peaks at 32 bytes per pixel while u64
    // HDF5 indexes are compacted to u32. KR later owns the compact sparse matrix
    // plus a duplicated symmetric CSR and BNEWT work vectors, so account for its
    // higher live peak rather than protecting only the input read.
    let (bytes_per_pixel, bytes_per_bin) = match normalization {
        ContactNormalization::Kr => (40_usize, 160_usize),
        ContactNormalization::Ice => (32, 64),
        ContactNormalization::Vc | ContactNormalization::VcSqrt => (32, 32),
        ContactNormalization::Raw => (0, 0),
    };
    pixel_count
        .saturating_mul(bytes_per_pixel)
        .saturating_add(bin_count.saturating_mul(bytes_per_bin))
}

/// Configure the optional on-disk normalization-vector cache. The directory is
/// process-global because the in-memory Cooler reader and normalization caches
/// are process-global too. Calling this more than once keeps the first path.
pub fn configure_persistent_normalization_cache(directory: PathBuf) {
    let _ = PERSISTENT_NORMALIZATION_CACHE_DIR.set(directory);
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CoolIndexCacheKey {
    path: String,
    resolution: Option<u64>,
    size_bytes: u64,
    modified_nanos: u128,
}

#[derive(Debug)]
struct CoolIndex {
    prefix: String,
    chrom_names: Vec<String>,
    chrom_lengths: Vec<u64>,
    bin_chrom_ids: Vec<i32>,
    chrom_offsets: Vec<usize>,
    bin_starts: Vec<u64>,
    bin1_offsets: Vec<u64>,
    bytes: usize,
}

#[derive(Debug, Default)]
struct CoolIndexCache {
    entries: VecDeque<(CoolIndexCacheKey, Arc<CoolIndex>)>,
    used_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CoolNormalizationCacheKey {
    file: CoolIndexCacheKey,
    normalization: ContactNormalization,
}

#[derive(Debug, Default)]
struct CoolNormalizationFlight {
    result: Mutex<Option<CStudioResult<Arc<Vec<f64>>>>>,
    ready: Condvar,
}

#[derive(Debug, Default)]
struct CoolNormalizationCache {
    entries: VecDeque<(CoolNormalizationCacheKey, Arc<Vec<f64>>)>,
    used_bytes: usize,
    in_flight: HashMap<CoolNormalizationCacheKey, Arc<CoolNormalizationFlight>>,
}

#[derive(Debug, Default)]
struct CoolReaderCache {
    entries: VecDeque<(CoolIndexCacheKey, Arc<CoolReader>)>,
}

#[derive(Debug, Default)]
struct CoolResidentBin2Flight {
    result: Mutex<Option<CStudioResult<Arc<Vec<u32>>>>>,
    ready: Condvar,
}

#[derive(Debug, Default)]
struct CoolResidentBin2Cache {
    entries: VecDeque<(CoolIndexCacheKey, Arc<Vec<u32>>)>,
    used_bytes: usize,
    in_flight: HashMap<CoolIndexCacheKey, Arc<CoolResidentBin2Flight>>,
}

#[derive(Debug)]
enum CoolResidentCounts {
    F64(Vec<f64>),
    F32(Vec<f32>),
    I64(Vec<i64>),
    I32(Vec<i32>),
    U64(Vec<u64>),
    U32(Vec<u32>),
}

#[derive(Debug, Default)]
struct CoolResidentCountFlight {
    result: Mutex<Option<CStudioResult<Arc<CoolResidentCounts>>>>,
    ready: Condvar,
}

#[derive(Debug, Default)]
struct CoolResidentCountCache {
    entries: VecDeque<(CoolIndexCacheKey, Arc<CoolResidentCounts>)>,
    used_bytes: usize,
    in_flight: HashMap<CoolIndexCacheKey, Arc<CoolResidentCountFlight>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct AdaptivePixel {
    bin1: u64,
    bin2: u64,
    count: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AdaptiveFileKey {
    path: Arc<str>,
    size_bytes: u64,
    modified_nanos: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AdaptiveChildBlockKey {
    file: AdaptiveFileKey,
    parent_resolution: u64,
    child_resolution: u64,
    parent_bin1: u64,
    parent_bin2: u64,
}

#[derive(Debug)]
struct AdaptiveChildCacheEntry {
    pixels: Arc<Vec<AdaptivePixel>>,
    bytes: usize,
    last_used: u64,
}

#[derive(Debug)]
struct AdaptiveChildCache {
    max_bytes: usize,
    used_bytes: usize,
    tick: u64,
    entries: HashMap<AdaptiveChildBlockKey, AdaptiveChildCacheEntry>,
}

impl Default for AdaptiveChildCache {
    fn default() -> Self {
        Self {
            max_bytes: MAX_ADAPTIVE_CHILD_CACHE_BYTES,
            used_bytes: 0,
            tick: 0,
            entries: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdaptiveCoolStats {
    pub candidate_pixels: usize,
    pub child_rows_read: usize,
    pub bin2_ids_scanned: usize,
    pub child_blocks_requested: usize,
    pub child_blocks_cached: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdaptiveContactMapResult {
    pub view: ContactMapView,
    pub stats: AdaptiveCoolStats,
}

/// Coarse-grained timings for one bounded Cooler contact visit. Timers are
/// sampled once per HDF5 chunk rather than once per contact so diagnostics do
/// not materially perturb the hot projection loop.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CoolContactVisitTimings {
    pub prepare: Duration,
    pub hdf5_read: Duration,
    /// Includes selected-bin filtering, coordinate lookup, and the caller's
    /// projection callback. Those operations share one per-pixel loop and
    /// cannot be separated without changing the production data path.
    pub scan_project: Duration,
    pub finish_chunk: Duration,
    pub hdf5_chunks: usize,
    pub scanned_pixels: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AdaptiveEndpointDecision {
    Drop,
    Safe(u64),
    Refine,
}

#[derive(Debug)]
struct CoolReader {
    file: File,
    index: Arc<CoolIndex>,
    // Opening still validates the required Cooler column and its integer type;
    // scan paths derive its values from indexes/bin1_offset without reading it.
    _pixel_bin1: CoolUnsignedDataset,
    pixel_bin2: CoolUnsignedDataset,
    pixel_counts: CoolCountDataset,
}

#[derive(Debug)]
enum CoolUnsignedDataset {
    U64(Dataset),
    U32(Dataset),
    I64(Dataset),
    I32(Dataset),
}

#[derive(Debug)]
enum CoolCountDataset {
    F64(Dataset),
    F32(Dataset),
    I64(Dataset),
    I32(Dataset),
    U64(Dataset),
    U32(Dataset),
}

static COOL_INDEX_CACHE: OnceLock<Mutex<CoolIndexCache>> = OnceLock::new();
static COOL_NORMALIZATION_CACHE: OnceLock<Mutex<CoolNormalizationCache>> = OnceLock::new();
static COOL_READER_CACHE: OnceLock<Mutex<CoolReaderCache>> = OnceLock::new();
static COOL_RESIDENT_BIN2_CACHE: OnceLock<Mutex<CoolResidentBin2Cache>> = OnceLock::new();
static COOL_RESIDENT_COUNT_CACHE: OnceLock<Mutex<CoolResidentCountCache>> = OnceLock::new();
static ADAPTIVE_CHILD_CACHE: OnceLock<Mutex<AdaptiveChildCache>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoolSourceMetadata {
    pub name: String,
    pub length: u64,
}

pub fn list_mcool_resolutions(path: &str) -> CStudioResult<Vec<u64>> {
    let file = File::open(path).map_err(cool_error)?;
    let group = file.group("resolutions").map_err(cool_error)?;
    let mut resolutions = group
        .member_names()
        .map_err(cool_error)?
        .into_iter()
        .filter_map(|name| name.parse::<u64>().ok())
        .filter(|resolution| *resolution > 0)
        .collect::<Vec<_>>();
    resolutions.sort_unstable_by(|left, right| right.cmp(left));
    resolutions.dedup();
    Ok(resolutions)
}

pub fn list_contact_resolutions(path: &str) -> CStudioResult<Vec<u64>> {
    let file = File::open(path).map_err(cool_error)?;
    if file.group("resolutions").is_ok() {
        return list_mcool_resolutions(path);
    }
    if let Ok(attribute) = file.attr("bin-size") {
        if let Ok(resolution) = attribute.read_scalar::<u64>() {
            if resolution > 0 {
                return Ok(vec![resolution]);
            }
        }
        if let Ok(resolution) = attribute.read_scalar::<i64>() {
            if resolution > 0 {
                return Ok(vec![resolution as u64]);
            }
        }
    }

    let starts = CoolUnsignedDataset::open(&file, "bins/start")?;
    let ends = CoolUnsignedDataset::open(&file, "bins/end")?;
    let sample_len = file
        .dataset("bins/start")
        .map_err(cool_error)?
        .size()
        .min(1_024);
    let starts = starts.read_slice(0, sample_len)?;
    let ends = ends.read_slice(0, sample_len)?;
    if starts.len() != ends.len() {
        return Err(CStudioError::InvalidContactMapQuery(
            ".cool bins/start and bins/end have different lengths".to_string(),
        ));
    }
    let resolution = starts
        .into_iter()
        .zip(ends)
        .filter_map(|(start, end)| end.checked_sub(start))
        .filter(|span| *span > 0)
        .max()
        .ok_or_else(|| {
            CStudioError::InvalidContactMapQuery(
                ".cool file does not contain a positive fixed-bin span".to_string(),
            )
        })?;
    Ok(vec![resolution])
}

pub fn list_contact_sources(path: &str) -> CStudioResult<Vec<CoolSourceMetadata>> {
    let file = File::open(path).map_err(cool_error)?;
    let resolution = if file.group("resolutions").is_ok() {
        list_mcool_resolutions(path)?.into_iter().next()
    } else {
        None
    };
    let prefix = cool_dataset_prefix(&file, resolution)?;
    let names = read_string_dataset(&file, &format!("{prefix}chroms/name"))?;
    let lengths = read_u64_dataset(&file, &format!("{prefix}chroms/length"))?;
    if names.len() != lengths.len() {
        return Err(CStudioError::InvalidContactMapQuery(
            ".cool chroms/name and chroms/length have different lengths".to_string(),
        ));
    }
    Ok(names
        .into_iter()
        .zip(lengths)
        .map(|(name, length)| CoolSourceMetadata { name, length })
        .collect())
}

/// Resolve and cache one normalization vector without reading or projecting
/// any contact tiles. This is used by the desktop app's low-priority idle
/// prewarmer; foreground readers reuse the same single-flight and LRU entries.
pub fn prewarm_contact_normalization_at_resolution_cancellable(
    path: &str,
    resolution: Option<u64>,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<()> {
    ensure_not_cancelled(should_cancel)?;
    if normalization == ContactNormalization::Raw {
        return Ok(());
    }
    let reader = cached_cool_reader(path, resolution, should_cancel)?;
    cached_normalization_weights(
        reader.as_ref(),
        path,
        resolution,
        &reader.index,
        normalization,
        should_cancel,
    )?;
    ensure_not_cancelled(should_cancel)
}

/// Build the bounded resident secondary index for one displayed Cooler level.
/// The app schedules this only after the first visible layer has painted, so
/// later pans can select bin2 and count values without touching HDF5 again.
/// Returns false for levels that exceed the configured resident-memory caps.
pub fn prewarm_contact_pixels_at_resolution_cancellable(
    path: &str,
    resolution: Option<u64>,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<bool> {
    ensure_not_cancelled(should_cancel)?;
    let reader = cached_cool_reader(path, resolution, should_cancel)?;
    let bin2_ready =
        cached_resident_bin2(path, resolution, reader.as_ref(), should_cancel)?.is_some();
    let counts_ready =
        cached_resident_counts(path, resolution, reader.as_ref(), should_cancel)?.is_some();
    ensure_not_cancelled(should_cancel)?;
    Ok(bin2_ready && counts_ready)
}

impl CoolUnsignedDataset {
    fn open(file: &File, path: &str) -> CStudioResult<Self> {
        let dataset = file.dataset(path).map_err(cool_error)?;
        let datatype = dataset.dtype().map_err(cool_error)?;
        if datatype.is::<u64>() {
            Ok(Self::U64(dataset))
        } else if datatype.is::<u32>() {
            Ok(Self::U32(dataset))
        } else if datatype.is::<i64>() {
            Ok(Self::I64(dataset))
        } else if datatype.is::<i32>() {
            Ok(Self::I32(dataset))
        } else {
            Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool dataset {path} must contain 32-bit or 64-bit integer values"
            )))
        }
    }

    fn read_slice(&self, start: usize, end: usize) -> CStudioResult<Vec<u64>> {
        if start >= end {
            return Ok(Vec::new());
        }
        match self {
            Self::U64(dataset) => dataset
                .read_slice_1d::<u64, _>(start..end)
                .map(|values| values.to_vec())
                .map_err(cool_error),
            Self::U32(dataset) => dataset
                .read_slice_1d::<u32, _>(start..end)
                .map(|values| values.iter().map(|value| *value as u64).collect())
                .map_err(cool_error),
            Self::I64(dataset) => dataset
                .read_slice_1d::<i64, _>(start..end)
                .map_err(cool_error)
                .and_then(|values| signed_bin_ids_to_u64(values.iter().copied())),
            Self::I32(dataset) => dataset
                .read_slice_1d::<i32, _>(start..end)
                .map_err(cool_error)
                .and_then(|values| signed_bin_ids_to_u64(values.iter().copied())),
        }
    }
}

fn signed_bin_ids_to_u64<T, I>(values: I) -> CStudioResult<Vec<u64>>
where
    T: Copy + TryInto<u64> + std::fmt::Display,
    I: IntoIterator<Item = T>,
{
    values
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            value.try_into().map_err(|_| {
                CStudioError::InvalidContactMapQuery(format!(
                    ".cool pixel bin id {value} at slice index {index} is negative"
                ))
            })
        })
        .collect()
}

impl CoolCountDataset {
    fn open(file: &File, path: &str) -> CStudioResult<Self> {
        let dataset = file.dataset(path).map_err(cool_error)?;
        let datatype = dataset.dtype().map_err(cool_error)?;
        if datatype.is::<f64>() {
            Ok(Self::F64(dataset))
        } else if datatype.is::<f32>() {
            Ok(Self::F32(dataset))
        } else if datatype.is::<i64>() {
            Ok(Self::I64(dataset))
        } else if datatype.is::<i32>() {
            Ok(Self::I32(dataset))
        } else if datatype.is::<u64>() {
            Ok(Self::U64(dataset))
        } else if datatype.is::<u32>() {
            Ok(Self::U32(dataset))
        } else {
            Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool dataset {path} has an unsupported count type"
            )))
        }
    }

    fn read_slice(&self, start: usize, end: usize) -> CStudioResult<Vec<f64>> {
        if start >= end {
            return Ok(Vec::new());
        }
        macro_rules! read_counts {
            ($dataset:expr, $value_type:ty) => {
                $dataset
                    .read_slice_1d::<$value_type, _>(start..end)
                    .map(|values| values.iter().map(|value| *value as f64).collect())
                    .map_err(cool_error)
            };
        }
        match self {
            Self::F64(dataset) => read_counts!(dataset, f64),
            Self::F32(dataset) => read_counts!(dataset, f32),
            Self::I64(dataset) => read_counts!(dataset, i64),
            Self::I32(dataset) => read_counts!(dataset, i32),
            Self::U64(dataset) => read_counts!(dataset, u64),
            Self::U32(dataset) => read_counts!(dataset, u32),
        }
    }

    fn resident_value_bytes(&self) -> usize {
        match self {
            Self::F64(_) | Self::I64(_) | Self::U64(_) => 8,
            Self::F32(_) | Self::I32(_) | Self::U32(_) => 4,
        }
    }

    fn resident_with_capacity(&self, capacity: usize) -> CoolResidentCounts {
        match self {
            Self::F64(_) => CoolResidentCounts::F64(Vec::with_capacity(capacity)),
            Self::F32(_) => CoolResidentCounts::F32(Vec::with_capacity(capacity)),
            Self::I64(_) => CoolResidentCounts::I64(Vec::with_capacity(capacity)),
            Self::I32(_) => CoolResidentCounts::I32(Vec::with_capacity(capacity)),
            Self::U64(_) => CoolResidentCounts::U64(Vec::with_capacity(capacity)),
            Self::U32(_) => CoolResidentCounts::U32(Vec::with_capacity(capacity)),
        }
    }

    fn append_resident_slice(
        &self,
        resident: &mut CoolResidentCounts,
        start: usize,
        end: usize,
    ) -> CStudioResult<()> {
        macro_rules! append_counts {
            ($dataset:expr, $resident:expr, $value_type:ty) => {{
                let values = $dataset
                    .read_slice_1d::<$value_type, _>(start..end)
                    .map_err(cool_error)?;
                $resident.extend(values.iter().copied());
                Ok(())
            }};
        }
        match (self, resident) {
            (Self::F64(dataset), CoolResidentCounts::F64(values)) => {
                append_counts!(dataset, values, f64)
            }
            (Self::F32(dataset), CoolResidentCounts::F32(values)) => {
                append_counts!(dataset, values, f32)
            }
            (Self::I64(dataset), CoolResidentCounts::I64(values)) => {
                append_counts!(dataset, values, i64)
            }
            (Self::I32(dataset), CoolResidentCounts::I32(values)) => {
                append_counts!(dataset, values, i32)
            }
            (Self::U64(dataset), CoolResidentCounts::U64(values)) => {
                append_counts!(dataset, values, u64)
            }
            (Self::U32(dataset), CoolResidentCounts::U32(values)) => {
                append_counts!(dataset, values, u32)
            }
            _ => Err(CStudioError::InvalidContactMapQuery(
                ".cool resident count type changed while loading".to_string(),
            )),
        }
    }
}

impl CoolResidentCounts {
    fn len(&self) -> usize {
        match self {
            Self::F64(values) => values.len(),
            Self::F32(values) => values.len(),
            Self::I64(values) => values.len(),
            Self::I32(values) => values.len(),
            Self::U64(values) => values.len(),
            Self::U32(values) => values.len(),
        }
    }

    fn capacity_bytes(&self) -> usize {
        match self {
            Self::F64(values) => values.capacity().saturating_mul(std::mem::size_of::<f64>()),
            Self::F32(values) => values.capacity().saturating_mul(std::mem::size_of::<f32>()),
            Self::I64(values) => values.capacity().saturating_mul(std::mem::size_of::<i64>()),
            Self::I32(values) => values.capacity().saturating_mul(std::mem::size_of::<i32>()),
            Self::U64(values) => values.capacity().saturating_mul(std::mem::size_of::<u64>()),
            Self::U32(values) => values.capacity().saturating_mul(std::mem::size_of::<u32>()),
        }
    }

    fn get_f64(&self, index: usize) -> Option<f64> {
        match self {
            Self::F64(values) => values.get(index).copied(),
            Self::F32(values) => values.get(index).map(|value| f64::from(*value)),
            Self::I64(values) => values.get(index).map(|value| *value as f64),
            Self::I32(values) => values.get(index).map(|value| f64::from(*value)),
            Self::U64(values) => values.get(index).map(|value| *value as f64),
            Self::U32(values) => values.get(index).map(|value| f64::from(*value)),
        }
    }
}

impl CoolReader {
    fn open(
        path: &str,
        resolution: Option<u64>,
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<Self> {
        ensure_not_cancelled(should_cancel)?;
        let mut file_builder = File::with_options();
        file_builder.with_fapl(|access| {
            access.chunk_cache(
                COOL_PIXEL_CHUNK_CACHE_SLOTS,
                COOL_PIXEL_CHUNK_CACHE_BYTES,
                COOL_PIXEL_CHUNK_CACHE_PREEMPTION,
            )
        });
        let file = file_builder.open(path).map_err(cool_error)?;
        ensure_not_cancelled(should_cancel)?;
        let index = cached_cool_index(&file, path, resolution, should_cancel)?;
        let pixel_bin1 =
            CoolUnsignedDataset::open(&file, &format!("{}pixels/bin1_id", index.prefix))?;
        let pixel_bin2 =
            CoolUnsignedDataset::open(&file, &format!("{}pixels/bin2_id", index.prefix))?;
        let pixel_counts = CoolCountDataset::open(&file, &format!("{}pixels/count", index.prefix))?;
        Ok(Self {
            file,
            index,
            _pixel_bin1: pixel_bin1,
            pixel_bin2,
            pixel_counts,
        })
    }
}

pub fn read_cool_contacts_for_sources(
    path: &str,
    source_ids: &[String],
) -> CStudioResult<Vec<ContactBin>> {
    read_cool_contacts_for_sources_at_resolution(path, source_ids, None)
}

pub fn read_cool_contacts_for_sources_at_resolution(
    path: &str,
    source_ids: &[String],
    resolution: Option<u64>,
) -> CStudioResult<Vec<ContactBin>> {
    let source_ranges = source_ids
        .iter()
        .map(|source_id| (source_id.clone(), 0, u64::MAX))
        .collect::<Vec<_>>();
    read_cool_contacts_for_source_ranges_at_resolution(path, &source_ranges, resolution)
}

pub fn read_cool_contacts_for_sources_at_resolution_with_normalization(
    path: &str,
    source_ids: &[String],
    resolution: Option<u64>,
    normalization: ContactNormalization,
) -> CStudioResult<Vec<ContactBin>> {
    let source_ranges = source_ids
        .iter()
        .map(|source_id| (source_id.clone(), 0, u64::MAX))
        .collect::<Vec<_>>();
    read_cool_contacts_for_source_ranges_at_resolution_with_normalization(
        path,
        &source_ranges,
        resolution,
        normalization,
    )
}

pub fn read_cool_contacts_for_source_ranges_at_resolution(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
) -> CStudioResult<Vec<ContactBin>> {
    read_cool_contacts_for_source_ranges_at_resolution_cancellable(
        path,
        source_ranges,
        resolution,
        &|| false,
    )
}

pub fn read_cool_contacts_for_source_ranges_at_resolution_with_normalization(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
    normalization: ContactNormalization,
) -> CStudioResult<Vec<ContactBin>> {
    read_cool_contacts_for_source_ranges_at_resolution_with_normalization_cancellable(
        path,
        source_ranges,
        resolution,
        normalization,
        &|| false,
    )
}

pub fn read_cool_contacts_for_source_ranges_at_resolution_cancellable(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<ContactBin>> {
    read_cool_contacts_for_source_ranges_at_resolution_with_normalization_cancellable(
        path,
        source_ranges,
        resolution,
        ContactNormalization::Raw,
        should_cancel,
    )
}

pub fn read_cool_contacts_for_source_ranges_at_resolution_with_normalization_cancellable(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<ContactBin>> {
    let mut contacts = Vec::new();
    visit_cool_contact_chunks_with_limit(
        path,
        source_ranges,
        resolution,
        normalization,
        should_cancel,
        MAX_COOL_PIXEL_READ_CHUNK,
        None,
        |_, source1, start1, _, source2, start2, count| {
            contacts.push(ContactBin {
                source1: source1.to_string(),
                start1,
                source2: source2.to_string(),
                start2,
                count,
            });
            Ok(())
        },
        || Ok(()),
    )?;
    Ok(contacts)
}

/// Visits selected Cooler contacts without allocating owned source names or a
/// whole-request `Vec<ContactBin>`. `finish_chunk` runs after each bounded HDF5
/// pixel chunk, which lets callers drain and emit an additive projection delta.
pub fn visit_cool_contact_chunks_for_source_ranges_at_resolution_with_normalization_cancellable<
    Visit,
    Finish,
>(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
    mut visit: Visit,
    finish_chunk: Finish,
) -> CStudioResult<usize>
where
    Visit: FnMut(&str, u64, &str, u64, f64) -> CStudioResult<()>,
    Finish: FnMut() -> CStudioResult<()>,
{
    visit_cool_contact_chunks_with_limit(
        path,
        source_ranges,
        resolution,
        normalization,
        should_cancel,
        MAX_COOL_STREAM_PIXEL_READ_CHUNK,
        None,
        |_, source1, start1, _, source2, start2, count| {
            visit(source1, start1, source2, start2, count)
        },
        finish_chunk,
    )
}

/// Indexed variant of the bounded Cooler visitor. Chromosome indexes are
/// stable for one cached Cooler reader, allowing projection callers to resolve
/// layout sources once per chromosome instead of hashing names per pixel.
pub fn visit_cool_contact_chunks_indexed_for_source_ranges_at_resolution_with_normalization_cancellable<
    Visit,
    Finish,
>(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
    visit: Visit,
    finish_chunk: Finish,
) -> CStudioResult<usize>
where
    Visit: FnMut(usize, &str, u64, usize, &str, u64, f64) -> CStudioResult<()>,
    Finish: FnMut() -> CStudioResult<()>,
{
    visit_cool_contact_chunks_with_limit(
        path,
        source_ranges,
        resolution,
        normalization,
        should_cancel,
        MAX_COOL_STREAM_PIXEL_READ_CHUNK,
        None,
        visit,
        finish_chunk,
    )
}

/// Profiled form of the string-source visitor. Kept for an exact A/B control
/// against the indexed production path.
pub fn visit_cool_contact_chunks_profiled_for_source_ranges_at_resolution_with_normalization_cancellable<
    Visit,
    Finish,
>(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
    timings: &mut CoolContactVisitTimings,
    mut visit: Visit,
    finish_chunk: Finish,
) -> CStudioResult<usize>
where
    Visit: FnMut(&str, u64, &str, u64, f64) -> CStudioResult<()>,
    Finish: FnMut() -> CStudioResult<()>,
{
    visit_cool_contact_chunks_with_limit(
        path,
        source_ranges,
        resolution,
        normalization,
        should_cancel,
        MAX_COOL_STREAM_PIXEL_READ_CHUNK,
        Some(timings),
        |_, source1, start1, _, source2, start2, count| {
            visit(source1, start1, source2, start2, count)
        },
        finish_chunk,
    )
}

/// Profiled form of the indexed visitor used by the visible-tile delta stream.
pub fn visit_cool_contact_chunks_indexed_profiled_for_source_ranges_at_resolution_with_normalization_cancellable<
    Visit,
    Finish,
>(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
    timings: &mut CoolContactVisitTimings,
    visit: Visit,
    finish_chunk: Finish,
) -> CStudioResult<usize>
where
    Visit: FnMut(usize, &str, u64, usize, &str, u64, f64) -> CStudioResult<()>,
    Finish: FnMut() -> CStudioResult<()>,
{
    visit_cool_contact_chunks_with_limit(
        path,
        source_ranges,
        resolution,
        normalization,
        should_cancel,
        MAX_COOL_STREAM_PIXEL_READ_CHUNK,
        Some(timings),
        visit,
        finish_chunk,
    )
}

fn bin1_for_pixel_offset(bin1_offsets: &[u64], pixel_offset: usize) -> CStudioResult<usize> {
    let pixel_offset = u64::try_from(pixel_offset).map_err(|_| {
        CStudioError::InvalidContactMapQuery(".cool pixel offset exceeds u64".to_string())
    })?;
    let Some(&pixel_end) = bin1_offsets.last() else {
        return Err(CStudioError::InvalidContactMapQuery(
            ".cool indexes/bin1_offset is empty".to_string(),
        ));
    };
    if pixel_offset >= pixel_end {
        return Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool pixel offset {pixel_offset} is outside indexes/bin1_offset end {pixel_end}"
        )));
    }
    // Empty bin1 rows repeat an offset. partition_point selects the final row
    // beginning at or before this pixel, which is the first non-empty owner.
    let upper = bin1_offsets.partition_point(|offset| *offset <= pixel_offset);
    let bin1 = upper.saturating_sub(1);
    if bin1 + 1 >= bin1_offsets.len()
        || bin1_offsets[bin1] > pixel_offset
        || bin1_offsets[bin1 + 1] <= pixel_offset
    {
        return Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool indexes/bin1_offset does not own pixel {pixel_offset}"
        )));
    }
    Ok(bin1)
}

fn visit_cool_contact_chunks_with_limit<Visit, Finish>(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
    pixel_read_chunk: usize,
    mut timings: Option<&mut CoolContactVisitTimings>,
    mut visit: Visit,
    mut finish_chunk: Finish,
) -> CStudioResult<usize>
where
    Visit: FnMut(usize, &str, u64, usize, &str, u64, f64) -> CStudioResult<()>,
    Finish: FnMut() -> CStudioResult<()>,
{
    let prepare_started = Instant::now();
    ensure_not_cancelled(should_cancel)?;
    let reader = cached_cool_reader(path, resolution, should_cancel)?;
    let index = &reader.index;
    let normalization_weights = cached_normalization_weights(
        reader.as_ref(),
        path,
        resolution,
        &index,
        normalization,
        should_cancel,
    )?;
    let source_range_index = SourceRangeIndex::new(source_ranges);
    let selected_bins = SelectedBinIndex::new(&index, &source_range_index, should_cancel)?;
    let resident_bin2 = cached_resident_bin2(path, resolution, reader.as_ref(), should_cancel)?;
    let resident_counts = cached_resident_counts(path, resolution, reader.as_ref(), should_cancel)?;

    let mut visited_contacts = 0usize;
    ensure_not_cancelled(should_cancel)?;
    let bin1_pixel_ranges = pixel_ranges_for_selected_bin_ranges_cancellable(
        selected_bins.ranges(),
        &index.bin1_offsets,
        should_cancel,
    )?;
    let pixel_ranges = if let Some(resident_bin2) = resident_bin2.as_deref() {
        selected_pixel_ranges_from_resident_bin2(
            &bin1_pixel_ranges,
            resident_bin2,
            &selected_bins,
            should_cancel,
        )?
    } else {
        batch_nearby_pixel_ranges(&bin1_pixel_ranges, MAX_COOL_PIXEL_BATCH_GAP)
    };
    if let Some(timings) = timings.as_deref_mut() {
        timings.prepare += prepare_started.elapsed();
    }

    for (pixel_start, pixel_end) in pixel_ranges {
        for chunk_start in (pixel_start..pixel_end).step_by(pixel_read_chunk) {
            ensure_not_cancelled(should_cancel)?;
            let chunk_end = chunk_start.saturating_add(pixel_read_chunk).min(pixel_end);
            let expected_len = chunk_end.saturating_sub(chunk_start);
            let read_started = Instant::now();
            let pixel_bin2 = if resident_bin2.is_none() {
                Some(reader.pixel_bin2.read_slice(chunk_start, chunk_end)?)
            } else {
                None
            };
            let pixel_counts = if resident_counts.is_none() {
                Some(reader.pixel_counts.read_slice(chunk_start, chunk_end)?)
            } else {
                None
            };
            if let Some(timings) = timings.as_deref_mut() {
                timings.hdf5_read += read_started.elapsed();
                if pixel_bin2.is_some() || pixel_counts.is_some() {
                    timings.hdf5_chunks = timings.hdf5_chunks.saturating_add(1);
                }
                timings.scanned_pixels = timings.scanned_pixels.saturating_add(expected_len);
            }
            if pixel_counts
                .as_ref()
                .is_some_and(|values| values.len() != expected_len)
                || pixel_bin2
                    .as_ref()
                    .is_some_and(|values| values.len() != expected_len)
            {
                return Err(CStudioError::InvalidContactMapQuery(
                    ".cool pixels/bin2_id and count have different lengths".to_string(),
                ));
            }
            let mut bin1_index = bin1_for_pixel_offset(&index.bin1_offsets, chunk_start)?;
            let scan_project_started = Instant::now();

            for pixel_index in 0..expected_len {
                if pixel_index % 16_384 == 0 {
                    ensure_not_cancelled(should_cancel)?;
                }
                let absolute_pixel_index = chunk_start.saturating_add(pixel_index);
                let bin2 = if let Some(resident_bin2) = resident_bin2.as_deref() {
                    u64::from(resident_bin2[absolute_pixel_index])
                } else {
                    pixel_bin2
                        .as_ref()
                        .and_then(|values| values.get(pixel_index))
                        .copied()
                        .ok_or_else(|| {
                            CStudioError::InvalidContactMapQuery(
                                ".cool pixels/bin2_id ended before count".to_string(),
                            )
                        })?
                };
                let count = if let Some(resident_counts) = resident_counts.as_deref() {
                    resident_counts
                        .get_f64(absolute_pixel_index)
                        .ok_or_else(|| {
                            CStudioError::InvalidContactMapQuery(
                                ".cool resident count index ended before bin2_id".to_string(),
                            )
                        })?
                } else {
                    pixel_counts
                        .as_ref()
                        .and_then(|values| values.get(pixel_index))
                        .copied()
                        .ok_or_else(|| {
                            CStudioError::InvalidContactMapQuery(
                                ".cool pixels/count ended before bin2_id".to_string(),
                            )
                        })?
                };
                let pixel_offset = u64::try_from(absolute_pixel_index).map_err(|_| {
                    CStudioError::InvalidContactMapQuery(
                        ".cool pixel offset exceeds u64".to_string(),
                    )
                })?;
                while index
                    .bin1_offsets
                    .get(bin1_index + 1)
                    .is_some_and(|next_offset| *next_offset <= pixel_offset)
                {
                    bin1_index += 1;
                }
                let bin1 = u64::try_from(bin1_index).map_err(|_| {
                    CStudioError::InvalidContactMapQuery(".cool bin1 index exceeds u64".to_string())
                })?;
                if !selected_bins.contains(bin1) || !selected_bins.contains(bin2) {
                    continue;
                }
                let Some(count) = normalized_contact_count(
                    count,
                    bin1,
                    bin2,
                    normalization_weights.as_deref().map(Vec::as_slice),
                ) else {
                    continue;
                };

                let (source1_index, start1) = bin_source_and_start(&index, bin1, "bin1_id")?;
                let (source2_index, start2) = bin_source_and_start(&index, bin2, "bin2_id")?;

                visit(
                    source1_index,
                    &index.chrom_names[source1_index],
                    start1,
                    source2_index,
                    &index.chrom_names[source2_index],
                    start2,
                    count,
                )?;
                visited_contacts = visited_contacts.saturating_add(1);
            }
            if let Some(timings) = timings.as_deref_mut() {
                timings.scan_project += scan_project_started.elapsed();
            }
            ensure_not_cancelled(should_cancel)?;
            let finish_started = Instant::now();
            finish_chunk()?;
            if let Some(timings) = timings.as_deref_mut() {
                timings.finish_chunk += finish_started.elapsed();
            }
        }
    }

    ensure_not_cancelled(should_cancel)?;
    Ok(visited_contacts)
}

fn cached_cool_reader(
    path: &str,
    resolution: Option<u64>,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Arc<CoolReader>> {
    ensure_not_cancelled(should_cancel)?;
    let key = cool_index_cache_key(path, resolution);
    let cache = COOL_READER_CACHE.get_or_init(|| Mutex::new(CoolReaderCache::default()));
    {
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(position) = cache
            .entries
            .iter()
            .position(|(entry_key, _)| *entry_key == key)
        {
            let entry = cache
                .entries
                .remove(position)
                .expect("cached reader position exists");
            let reader = Arc::clone(&entry.1);
            cache.entries.push_back(entry);
            return Ok(reader);
        }
    }

    // Opening the HDF5 file and resolving dataset types happens outside the
    // cache mutex so an unrelated visible request never waits for this setup.
    let opened = Arc::new(CoolReader::open(path, resolution, should_cancel)?);
    ensure_not_cancelled(should_cancel)?;
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(position) = cache
        .entries
        .iter()
        .position(|(entry_key, _)| *entry_key == key)
    {
        let entry = cache
            .entries
            .remove(position)
            .expect("concurrently cached reader position exists");
        let reader = Arc::clone(&entry.1);
        cache.entries.push_back(entry);
        return Ok(reader);
    }

    cache.entries.retain(|(entry_key, _)| {
        entry_key.path != key.path || entry_key.resolution != key.resolution
    });
    while cache.entries.len() >= MAX_COOL_READER_CACHE_ENTRIES {
        cache.entries.pop_front();
    }
    cache.entries.push_back((key, Arc::clone(&opened)));
    Ok(opened)
}

fn cached_resident_bin2(
    path: &str,
    resolution: Option<u64>,
    reader: &CoolReader,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Option<Arc<Vec<u32>>>> {
    ensure_not_cancelled(should_cancel)?;
    let pixel_count: usize = reader
        .index
        .bin1_offsets
        .last()
        .copied()
        .unwrap_or(0)
        .try_into()
        .map_err(|_| {
            CStudioError::InvalidContactMapQuery(
                ".cool pixel count exceeds this platform's index range".to_string(),
            )
        })?;
    let Some(entry_bytes) = pixel_count.checked_mul(std::mem::size_of::<u32>()) else {
        return Ok(None);
    };
    if entry_bytes > MAX_COOL_RESIDENT_BIN2_ENTRY_BYTES {
        return Ok(None);
    }

    let key = cool_index_cache_key(path, resolution);
    let cache =
        COOL_RESIDENT_BIN2_CACHE.get_or_init(|| Mutex::new(CoolResidentBin2Cache::default()));
    let (flight, is_leader) = {
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(position) = cache
            .entries
            .iter()
            .position(|(entry_key, _)| *entry_key == key)
        {
            let entry = cache
                .entries
                .remove(position)
                .expect("cached resident bin2 position exists");
            let result = Arc::clone(&entry.1);
            cache.entries.push_back(entry);
            return Ok(Some(result));
        }
        if let Some(flight) = cache.in_flight.get(&key) {
            (Arc::clone(flight), false)
        } else {
            let flight = Arc::new(CoolResidentBin2Flight::default());
            cache.in_flight.insert(key.clone(), Arc::clone(&flight));
            (flight, true)
        }
    };

    if !is_leader {
        return match wait_for_resident_bin2_flight(&flight, should_cancel) {
            // A low-priority prewarmer may lead the flight and yield as soon
            // as this foreground request appears. Retry so the foreground
            // becomes the next leader instead of inheriting idle cancellation.
            Err(CStudioError::RequestCancelled) if !should_cancel() => {
                cached_resident_bin2(path, resolution, reader, should_cancel)
            }
            result => result.map(Some),
        };
    }

    let result = (|| {
        let mut resident = Vec::<u32>::with_capacity(pixel_count);
        for chunk_start in (0..pixel_count).step_by(COOL_RESIDENT_BIN2_READ_CHUNK) {
            ensure_not_cancelled(should_cancel)?;
            let chunk_end = chunk_start
                .saturating_add(COOL_RESIDENT_BIN2_READ_CHUNK)
                .min(pixel_count);
            let values = reader.pixel_bin2.read_slice(chunk_start, chunk_end)?;
            for (value_index, value) in values.into_iter().enumerate() {
                if value_index % 16_384 == 0 {
                    ensure_not_cancelled(should_cancel)?;
                }
                resident.push(u32::try_from(value).map_err(|_| {
                    CStudioError::InvalidContactMapQuery(format!(
                        ".cool pixels/bin2_id value {value} exceeds the compact secondary-index range"
                    ))
                })?);
            }
        }
        if resident.len() != pixel_count {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool pixels/bin2_id contains {} values; expected {pixel_count}",
                resident.len(),
            )));
        }
        ensure_not_cancelled(should_cancel)?;
        Ok(Arc::new(resident))
    })();
    complete_resident_bin2_flight(cache, &key, &flight, &result);
    result.map(Some)
}

fn wait_for_resident_bin2_flight(
    flight: &CoolResidentBin2Flight,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Arc<Vec<u32>>> {
    loop {
        ensure_not_cancelled(should_cancel)?;
        let result = flight
            .result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(result) = result.as_ref() {
            return result.clone();
        }
        let (result, _) = flight
            .ready
            .wait_timeout(result, Duration::from_millis(25))
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(result) = result.as_ref() {
            return result.clone();
        }
    }
}

fn complete_resident_bin2_flight(
    cache: &Mutex<CoolResidentBin2Cache>,
    key: &CoolIndexCacheKey,
    flight: &Arc<CoolResidentBin2Flight>,
    result: &CStudioResult<Arc<Vec<u32>>>,
) {
    {
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Ok(values) = result {
            let bytes = values.capacity().saturating_mul(std::mem::size_of::<u32>());
            if bytes <= MAX_COOL_RESIDENT_BIN2_CACHE_BYTES {
                while cache.used_bytes.saturating_add(bytes) > MAX_COOL_RESIDENT_BIN2_CACHE_BYTES {
                    let Some((_, evicted)) = cache.entries.pop_front() else {
                        break;
                    };
                    cache.used_bytes = cache.used_bytes.saturating_sub(
                        evicted
                            .capacity()
                            .saturating_mul(std::mem::size_of::<u32>()),
                    );
                }
                cache.used_bytes = cache.used_bytes.saturating_add(bytes);
                cache.entries.push_back((key.clone(), Arc::clone(values)));
            }
        }
        if cache
            .in_flight
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, flight))
        {
            cache.in_flight.remove(key);
        }
    }

    let mut completed = flight
        .result
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *completed = Some(result.clone());
    flight.ready.notify_all();
}

fn cached_resident_counts(
    path: &str,
    resolution: Option<u64>,
    reader: &CoolReader,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Option<Arc<CoolResidentCounts>>> {
    ensure_not_cancelled(should_cancel)?;
    let pixel_count: usize = reader
        .index
        .bin1_offsets
        .last()
        .copied()
        .unwrap_or(0)
        .try_into()
        .map_err(|_| {
            CStudioError::InvalidContactMapQuery(
                ".cool pixel count exceeds this platform's index range".to_string(),
            )
        })?;
    let Some(entry_bytes) = pixel_count.checked_mul(reader.pixel_counts.resident_value_bytes())
    else {
        return Ok(None);
    };
    if entry_bytes > MAX_COOL_RESIDENT_COUNT_ENTRY_BYTES {
        return Ok(None);
    }

    let key = cool_index_cache_key(path, resolution);
    let cache =
        COOL_RESIDENT_COUNT_CACHE.get_or_init(|| Mutex::new(CoolResidentCountCache::default()));
    let (flight, is_leader) = {
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(position) = cache
            .entries
            .iter()
            .position(|(entry_key, _)| *entry_key == key)
        {
            let entry = cache
                .entries
                .remove(position)
                .expect("cached resident count position exists");
            let result = Arc::clone(&entry.1);
            cache.entries.push_back(entry);
            return Ok(Some(result));
        }
        if let Some(flight) = cache.in_flight.get(&key) {
            (Arc::clone(flight), false)
        } else {
            let flight = Arc::new(CoolResidentCountFlight::default());
            cache.in_flight.insert(key.clone(), Arc::clone(&flight));
            (flight, true)
        }
    };

    if !is_leader {
        return match wait_for_resident_count_flight(&flight, should_cancel) {
            Err(CStudioError::RequestCancelled) if !should_cancel() => {
                cached_resident_counts(path, resolution, reader, should_cancel)
            }
            result => result.map(Some),
        };
    }

    let result = (|| {
        let mut resident = reader.pixel_counts.resident_with_capacity(pixel_count);
        for chunk_start in (0..pixel_count).step_by(COOL_RESIDENT_BIN2_READ_CHUNK) {
            ensure_not_cancelled(should_cancel)?;
            let chunk_end = chunk_start
                .saturating_add(COOL_RESIDENT_BIN2_READ_CHUNK)
                .min(pixel_count);
            reader
                .pixel_counts
                .append_resident_slice(&mut resident, chunk_start, chunk_end)?;
        }
        if resident.len() != pixel_count {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool pixels/count contains {} values; expected {pixel_count}",
                resident.len(),
            )));
        }
        ensure_not_cancelled(should_cancel)?;
        Ok(Arc::new(resident))
    })();
    complete_resident_count_flight(cache, &key, &flight, &result);
    result.map(Some)
}

fn wait_for_resident_count_flight(
    flight: &CoolResidentCountFlight,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Arc<CoolResidentCounts>> {
    loop {
        ensure_not_cancelled(should_cancel)?;
        let result = flight
            .result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(result) = result.as_ref() {
            return result.clone();
        }
        let (result, _) = flight
            .ready
            .wait_timeout(result, Duration::from_millis(25))
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(result) = result.as_ref() {
            return result.clone();
        }
    }
}

fn complete_resident_count_flight(
    cache: &Mutex<CoolResidentCountCache>,
    key: &CoolIndexCacheKey,
    flight: &Arc<CoolResidentCountFlight>,
    result: &CStudioResult<Arc<CoolResidentCounts>>,
) {
    {
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Ok(values) = result {
            let bytes = values.capacity_bytes();
            if bytes <= MAX_COOL_RESIDENT_COUNT_CACHE_BYTES {
                while cache.used_bytes.saturating_add(bytes) > MAX_COOL_RESIDENT_COUNT_CACHE_BYTES {
                    let Some((_, evicted)) = cache.entries.pop_front() else {
                        break;
                    };
                    cache.used_bytes = cache.used_bytes.saturating_sub(evicted.capacity_bytes());
                }
                cache.used_bytes = cache.used_bytes.saturating_add(bytes);
                cache.entries.push_back((key.clone(), Arc::clone(values)));
            }
        }
        if cache
            .in_flight
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, flight))
        {
            cache.in_flight.remove(key);
        }
    }

    let mut completed = flight
        .result
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *completed = Some(result.clone());
    flight.ready.notify_all();
}

pub fn build_contact_map_view_from_mcool_adaptive_raw_cancellable(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    query: &ContactMapQuery,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Option<AdaptiveContactMapResult>> {
    if query.target_resolution != ADAPTIVE_TARGET_RESOLUTION
        || query.base_resolution != *ADAPTIVE_RESOLUTION_CHAIN.last().unwrap()
        || std::env::var("CSTUDIO_ADAPTIVE_MCOOL").as_deref() == Ok("0")
    {
        if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
            eprintln!(
                "CSTUDIO_PERF event=adaptive_mcool status=fallback reason=request_gate base_resolution={} target_resolution={}",
                query.base_resolution, query.target_resolution,
            );
        }
        return Ok(None);
    }
    let file = File::open(path).map_err(cool_error)?;
    if ADAPTIVE_RESOLUTION_CHAIN
        .iter()
        .any(|resolution| !file.link_exists(&format!("/resolutions/{resolution}")))
    {
        if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
            eprintln!(
                "CSTUDIO_PERF event=adaptive_mcool status=fallback reason=missing_resolution"
            );
        }
        return Ok(None);
    }
    drop(file);
    ensure_not_cancelled(should_cancel)?;

    let file_key = adaptive_file_key(path);
    let top_resolution = ADAPTIVE_RESOLUTION_CHAIN[0];
    let top_reader = cached_cool_reader(path, Some(top_resolution), should_cancel)?;
    if has_duplicate_chrom_names(&top_reader.index.chrom_names) {
        if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
            eprintln!(
                "CSTUDIO_PERF event=adaptive_mcool status=fallback reason=duplicate_source_name"
            );
        }
        return Ok(None);
    }
    let top_ranges =
        expand_source_ranges_to_resolution(source_ranges, top_resolution, &top_reader.index);
    let top_contacts = read_cool_contacts_for_source_ranges_at_resolution_cancellable(
        path,
        &top_ranges,
        Some(top_resolution),
        should_cancel,
    )?;
    let mut candidates = contacts_to_adaptive_pixels(&top_contacts, &top_reader.index)?;
    let mut aggregate = HashMap::<(u64, u64), f64>::new();
    let layout_index = AdaptiveLayoutIndex::new(&query.layout_blocks);
    let mut stats = AdaptiveCoolStats::default();

    for (level_index, resolution) in ADAPTIVE_RESOLUTION_CHAIN.iter().copied().enumerate() {
        ensure_not_cancelled(should_cancel)?;
        stats.candidate_pixels = stats.candidate_pixels.saturating_add(candidates.len());
        let reader = cached_cool_reader(path, Some(resolution), should_cancel)?;
        if resolution == query.base_resolution {
            let contacts = adaptive_pixels_to_contacts(&candidates, &reader.index)?;
            let refined =
                build_contact_map_view_from_contacts_cancellable(query, contacts, should_cancel)?;
            merge_contact_cells(&mut aggregate, refined.cells);
            candidates.clear();
            break;
        }

        let mut rejected = HashSet::<(u64, u64)>::new();
        for (pixel_index, pixel) in candidates.drain(..).enumerate() {
            if pixel_index % 4_096 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            let (source1, start1, end1) = adaptive_bin_interval(&reader.index, pixel.bin1)?;
            let (source2, start2, end2) = adaptive_bin_interval(&reader.index, pixel.bin2)?;
            match (
                layout_index.endpoint_decision(source1, start1, end1, query.target_resolution),
                layout_index.endpoint_decision(source2, start2, end2, query.target_resolution),
            ) {
                (AdaptiveEndpointDecision::Drop, _) | (_, AdaptiveEndpointDecision::Drop) => {}
                (AdaptiveEndpointDecision::Safe(x_bin), AdaptiveEndpointDecision::Safe(y_bin)) => {
                    let (x_bin, y_bin) = if x_bin <= y_bin {
                        (x_bin, y_bin)
                    } else {
                        (y_bin, x_bin)
                    };
                    if query
                        .viewport
                        .contains_bin(x_bin, y_bin, query.target_resolution)
                    {
                        *aggregate.entry((x_bin, y_bin)).or_insert(0.0) += pixel.count;
                    }
                }
                _ => {
                    rejected.insert((pixel.bin1, pixel.bin2));
                }
            }
        }
        let child_resolution = ADAPTIVE_RESOLUTION_CHAIN[level_index + 1];
        candidates = read_adaptive_child_pixels(
            path,
            &file_key,
            resolution,
            child_resolution,
            &rejected,
            should_cancel,
            &mut stats,
        )?;
    }

    let mut cells = aggregate
        .into_iter()
        .map(|((x_bin, y_bin), count)| ContactMapCell {
            x_bin,
            y_bin,
            count,
        })
        .collect::<Vec<_>>();
    cells.sort_by_key(|cell| (cell.x_bin, cell.y_bin));
    Ok(Some(AdaptiveContactMapResult {
        view: ContactMapView {
            resolution: query.target_resolution,
            viewport: query.viewport,
            cells,
        },
        stats,
    }))
}

fn adaptive_file_key(path: &str) -> AdaptiveFileKey {
    let (size_bytes, modified_nanos) = fs::metadata(path)
        .map(|metadata| {
            let modified_nanos = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            (metadata.len(), modified_nanos)
        })
        .unwrap_or((0, 0));
    AdaptiveFileKey {
        path: Arc::from(path),
        size_bytes,
        modified_nanos,
    }
}

fn has_duplicate_chrom_names(names: &[String]) -> bool {
    let mut seen = HashSet::with_capacity(names.len());
    names.iter().any(|name| !seen.insert(name.as_str()))
}

fn expand_source_ranges_to_resolution(
    ranges: &[(String, u64, u64)],
    resolution: u64,
    index: &CoolIndex,
) -> Vec<(String, u64, u64)> {
    let lengths = index
        .chrom_names
        .iter()
        .zip(index.chrom_lengths.iter().copied())
        .map(|(source, length)| (source.as_str(), length))
        .collect::<HashMap<_, _>>();
    ranges
        .iter()
        .filter_map(|(source, start, end)| {
            let length = lengths.get(source.as_str()).copied()?;
            let expanded_start = start / resolution * resolution;
            let expanded_end = end
                .saturating_add(resolution - 1)
                .checked_div(resolution)
                .unwrap_or(0)
                .saturating_mul(resolution)
                .min(length);
            (expanded_start < expanded_end).then(|| (source.clone(), expanded_start, expanded_end))
        })
        .collect()
}

fn adaptive_bin_interval(index: &CoolIndex, bin: u64) -> CStudioResult<(&str, u64, u64)> {
    let (source_index, start, end) = adaptive_bin_source_interval(index, bin)?;
    Ok((index.chrom_names[source_index].as_str(), start, end))
}

fn adaptive_bin_source_interval(index: &CoolIndex, bin: u64) -> CStudioResult<(usize, u64, u64)> {
    let (source_index, start) = bin_source_and_start(index, bin, "bin_id")?;
    let bin_index = usize::try_from(bin).map_err(|_| {
        CStudioError::InvalidContactMapQuery("adaptive bin exceeds platform range".to_string())
    })?;
    let chrom_end = index.chrom_offsets[source_index + 1];
    let end = if bin_index + 1 < chrom_end {
        index.bin_starts[bin_index + 1]
    } else {
        index.chrom_lengths[source_index]
    };
    Ok((source_index, start, end))
}

fn contacts_to_adaptive_pixels(
    contacts: &[ContactBin],
    index: &CoolIndex,
) -> CStudioResult<Vec<AdaptivePixel>> {
    let source_indices = index
        .chrom_names
        .iter()
        .enumerate()
        .map(|(source_index, source)| (source.as_str(), source_index))
        .collect::<HashMap<_, _>>();
    contacts
        .iter()
        .map(|contact| {
            let source1 = source_indices
                .get(contact.source1.as_str())
                .ok_or_else(|| {
                    CStudioError::InvalidContactMapQuery(format!(
                        "adaptive source {} is missing from .mcool",
                        contact.source1
                    ))
                })?;
            let source2 = source_indices
                .get(contact.source2.as_str())
                .ok_or_else(|| {
                    CStudioError::InvalidContactMapQuery(format!(
                        "adaptive source {} is missing from .mcool",
                        contact.source2
                    ))
                })?;
            let bin1 = source_bin_for_start(index, *source1, contact.start1)?;
            let bin2 = source_bin_for_start(index, *source2, contact.start2)?;
            Ok(AdaptivePixel {
                bin1,
                bin2,
                count: contact.count,
            })
        })
        .collect()
}

fn source_bin_for_start(index: &CoolIndex, source: usize, start: u64) -> CStudioResult<u64> {
    let chrom_start = index.chrom_offsets[source];
    let chrom_end = index.chrom_offsets[source + 1];
    let starts = &index.bin_starts[chrom_start..chrom_end];
    let relative = starts.binary_search(&start).map_err(|_| {
        CStudioError::InvalidContactMapQuery(format!(
            "adaptive bin start {start} is absent from source {}",
            index.chrom_names[source]
        ))
    })?;
    u64::try_from(chrom_start + relative).map_err(|_| {
        CStudioError::InvalidContactMapQuery("adaptive bin exceeds u64 range".to_string())
    })
}

fn adaptive_pixels_to_contacts(
    pixels: &[AdaptivePixel],
    index: &CoolIndex,
) -> CStudioResult<Vec<ContactBin>> {
    pixels
        .iter()
        .map(|pixel| {
            let (source1, start1, _) = adaptive_bin_interval(index, pixel.bin1)?;
            let (source2, start2, _) = adaptive_bin_interval(index, pixel.bin2)?;
            Ok(ContactBin {
                source1: source1.to_string(),
                start1,
                source2: source2.to_string(),
                start2,
                count: pixel.count,
            })
        })
        .collect()
}

fn merge_contact_cells(aggregate: &mut HashMap<(u64, u64), f64>, cells: Vec<ContactMapCell>) {
    for cell in cells {
        *aggregate.entry((cell.x_bin, cell.y_bin)).or_insert(0.0) += cell.count;
    }
}

struct AdaptiveLayoutIndex<'a> {
    by_source: HashMap<&'a str, Vec<&'a LayoutBlock>>,
}

impl<'a> AdaptiveLayoutIndex<'a> {
    fn new(blocks: &'a [LayoutBlock]) -> Self {
        let mut by_source = HashMap::<&str, Vec<&LayoutBlock>>::new();
        for block in blocks {
            by_source
                .entry(block.source_id.as_str())
                .or_default()
                .push(block);
        }
        Self { by_source }
    }

    fn endpoint_decision(
        &self,
        source: &str,
        start: u64,
        end: u64,
        target_resolution: u64,
    ) -> AdaptiveEndpointDecision {
        let overlaps = self
            .by_source
            .get(source)
            .into_iter()
            .flatten()
            .filter(|block| start < block.source_end && end > block.source_start)
            .copied()
            .collect::<Vec<_>>();
        if overlaps.is_empty() {
            return AdaptiveEndpointDecision::Drop;
        }
        if overlaps.len() != 1 {
            return AdaptiveEndpointDecision::Refine;
        }
        let block = overlaps[0];
        if start < block.source_start || end > block.source_end || start >= end {
            return AdaptiveEndpointDecision::Refine;
        }
        let (visual_low, visual_high) = match block.orientation {
            crate::agp::Orientation::Forward | crate::agp::Orientation::Unknown => (
                block.visual_start + start - block.source_start,
                block.visual_start + end - block.source_start,
            ),
            crate::agp::Orientation::Reverse => (
                block.visual_start + block.source_end - end,
                block.visual_start + block.source_end - start,
            ),
        };
        let low_bin = visual_low / target_resolution;
        let high_bin = (visual_high - 1) / target_resolution;
        if low_bin == high_bin {
            AdaptiveEndpointDecision::Safe(low_bin)
        } else {
            AdaptiveEndpointDecision::Refine
        }
    }
}

fn read_adaptive_child_pixels(
    path: &str,
    file_key: &AdaptiveFileKey,
    parent_resolution: u64,
    child_resolution: u64,
    parents: &HashSet<(u64, u64)>,
    should_cancel: &dyn Fn() -> bool,
    stats: &mut AdaptiveCoolStats,
) -> CStudioResult<Vec<AdaptivePixel>> {
    if parents.is_empty() {
        return Ok(Vec::new());
    }
    stats.child_blocks_requested = stats.child_blocks_requested.saturating_add(parents.len());
    let parent_reader = cached_cool_reader(path, Some(parent_resolution), should_cancel)?;
    let child_reader = cached_cool_reader(path, Some(child_resolution), should_cancel)?;
    validate_adaptive_resolution_pair(&parent_reader.index, &child_reader.index)?;

    let requested_keys = parents
        .iter()
        .map(|&(parent_bin1, parent_bin2)| AdaptiveChildBlockKey {
            file: file_key.clone(),
            parent_resolution,
            child_resolution,
            parent_bin1,
            parent_bin2,
        })
        .collect::<Vec<_>>();
    let (cached, missing) = {
        let cache = ADAPTIVE_CHILD_CACHE.get_or_init(|| Mutex::new(AdaptiveChildCache::default()));
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.lookup(&requested_keys)
    };
    stats.child_blocks_cached = stats.child_blocks_cached.saturating_add(cached.len());

    let loaded = if missing.is_empty() {
        HashMap::new()
    } else {
        load_adaptive_child_blocks(
            &parent_reader,
            &child_reader,
            parent_resolution,
            child_resolution,
            &missing,
            should_cancel,
            stats,
        )?
    };
    let mut pixels = Vec::new();
    for key in &requested_keys {
        if let Some(block) = cached.get(key).or_else(|| loaded.get(key)) {
            pixels.extend(block.iter().copied());
        }
    }
    if !loaded.is_empty() {
        let cache = ADAPTIVE_CHILD_CACHE.get_or_init(|| Mutex::new(AdaptiveChildCache::default()));
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.insert_batch(loaded);
    }
    Ok(pixels)
}

impl AdaptiveChildCache {
    fn next_tick(&mut self) -> u64 {
        self.tick = self.tick.wrapping_add(1).max(1);
        self.tick
    }

    fn lookup(
        &mut self,
        keys: &[AdaptiveChildBlockKey],
    ) -> (
        HashMap<AdaptiveChildBlockKey, Arc<Vec<AdaptivePixel>>>,
        Vec<AdaptiveChildBlockKey>,
    ) {
        let tick = self.next_tick();
        let mut found = HashMap::new();
        let mut missing = Vec::new();
        for key in keys {
            if let Some(entry) = self.entries.get_mut(key) {
                entry.last_used = tick;
                found.insert(key.clone(), Arc::clone(&entry.pixels));
            } else {
                missing.push(key.clone());
            }
        }
        (found, missing)
    }

    fn insert_batch(&mut self, blocks: HashMap<AdaptiveChildBlockKey, Arc<Vec<AdaptivePixel>>>) {
        let tick = self.next_tick();
        for (key, pixels) in blocks {
            if self.entries.contains_key(&key) {
                continue;
            }
            let bytes = adaptive_cache_entry_bytes(&key, pixels.len());
            if bytes > self.max_bytes {
                continue;
            }
            self.used_bytes = self.used_bytes.saturating_add(bytes);
            self.entries.insert(
                key,
                AdaptiveChildCacheEntry {
                    pixels,
                    bytes,
                    last_used: tick,
                },
            );
        }
        if self.used_bytes <= self.max_bytes {
            return;
        }
        let mut recency = self
            .entries
            .iter()
            .map(|(key, entry)| (entry.last_used, key.clone()))
            .collect::<Vec<_>>();
        recency.sort_by_key(|(last_used, _)| *last_used);
        for (_, key) in recency {
            if self.used_bytes <= self.max_bytes {
                break;
            }
            if let Some(entry) = self.entries.remove(&key) {
                self.used_bytes = self.used_bytes.saturating_sub(entry.bytes);
            }
        }
    }
}

fn adaptive_cache_entry_bytes(key: &AdaptiveChildBlockKey, pixel_count: usize) -> usize {
    std::mem::size_of::<AdaptiveChildBlockKey>()
        .saturating_add(key.file.path.len())
        .saturating_add(std::mem::size_of::<AdaptiveChildCacheEntry>())
        .saturating_add(pixel_count.saturating_mul(std::mem::size_of::<AdaptivePixel>()))
}

fn validate_adaptive_resolution_pair(parent: &CoolIndex, child: &CoolIndex) -> CStudioResult<()> {
    if parent.chrom_names != child.chrom_names || parent.chrom_lengths != child.chrom_lengths {
        return Err(CStudioError::InvalidContactMapQuery(
            "adaptive .mcool resolutions have inconsistent chromosomes".to_string(),
        ));
    }
    Ok(())
}

fn load_adaptive_child_blocks(
    parent_reader: &CoolReader,
    child_reader: &CoolReader,
    parent_resolution: u64,
    child_resolution: u64,
    missing: &[AdaptiveChildBlockKey],
    should_cancel: &dyn Fn() -> bool,
    stats: &mut AdaptiveCoolStats,
) -> CStudioResult<HashMap<AdaptiveChildBlockKey, Arc<Vec<AdaptivePixel>>>> {
    let mut blocks = missing
        .iter()
        .cloned()
        .map(|key| (key, Vec::new()))
        .collect::<HashMap<_, Vec<AdaptivePixel>>>();
    let mut row_requests = HashMap::<u64, Vec<(u64, u64)>>::new();
    for (parent_index, key) in missing.iter().enumerate() {
        if parent_index % 4_096 == 0 {
            ensure_not_cancelled(should_cancel)?;
        }
        let (bin1_start, bin1_end) = adaptive_child_bin_range(
            &parent_reader.index,
            &child_reader.index,
            key.parent_bin1,
            parent_resolution,
            child_resolution,
        )?;
        let (bin2_start, bin2_end) = adaptive_child_bin_range(
            &parent_reader.index,
            &child_reader.index,
            key.parent_bin2,
            parent_resolution,
            child_resolution,
        )?;
        for bin1 in bin1_start..bin1_end {
            row_requests
                .entry(bin1)
                .or_default()
                .push((bin2_start, bin2_end));
        }
    }
    let mut rows = row_requests.into_iter().collect::<Vec<_>>();
    rows.sort_by_key(|(row, _)| *row);
    for (_, ranges) in &mut rows {
        ranges.sort_unstable();
        let mut merged = Vec::<(u64, u64)>::new();
        for (start, end) in ranges.iter().copied() {
            if let Some((_, previous_end)) = merged.last_mut() {
                if start <= *previous_end {
                    *previous_end = (*previous_end).max(end);
                    continue;
                }
            }
            merged.push((start, end));
        }
        *ranges = merged;
    }

    let mut span_start = 0;
    while span_start < rows.len() {
        ensure_not_cancelled(should_cancel)?;
        let mut span_end = span_start + 1;
        while span_end < rows.len() && rows[span_end].0 == rows[span_end - 1].0 + 1 {
            span_end += 1;
        }
        let first_row = rows[span_start].0 as usize;
        let last_row = rows[span_end - 1].0 as usize;
        let pixel_start = child_reader.index.bin1_offsets[first_row] as usize;
        let pixel_end = child_reader.index.bin1_offsets[last_row + 1] as usize;
        stats.child_rows_read = stats.child_rows_read.saturating_add(span_end - span_start);
        stats.bin2_ids_scanned = stats
            .bin2_ids_scanned
            .saturating_add(pixel_end.saturating_sub(pixel_start));
        if pixel_start == pixel_end {
            span_start = span_end;
            continue;
        }
        let bin2_ids = child_reader.pixel_bin2.read_slice(pixel_start, pixel_end)?;
        let counts = child_reader
            .pixel_counts
            .read_slice(pixel_start, pixel_end)?;
        if bin2_ids.len() != counts.len() {
            return Err(CStudioError::InvalidContactMapQuery(
                "adaptive child bin2 and count slices differ in length".to_string(),
            ));
        }
        for (row, requested_ranges) in &rows[span_start..span_end] {
            let row = *row as usize;
            let row_start = child_reader.index.bin1_offsets[row] as usize - pixel_start;
            let row_end = child_reader.index.bin1_offsets[row + 1] as usize - pixel_start;
            let row_bin2 = &bin2_ids[row_start..row_end];
            for &(requested_start, requested_end) in requested_ranges {
                let local_start = row_bin2.partition_point(|bin| *bin < requested_start);
                let local_end = row_bin2.partition_point(|bin| *bin < requested_end);
                for local_index in local_start..local_end {
                    let pixel = AdaptivePixel {
                        bin1: row as u64,
                        bin2: row_bin2[local_index],
                        count: counts[row_start + local_index],
                    };
                    let parent_bin1 = adaptive_parent_bin_for_child(
                        &parent_reader.index,
                        &child_reader.index,
                        pixel.bin1,
                    )?;
                    let parent_bin2 = adaptive_parent_bin_for_child(
                        &parent_reader.index,
                        &child_reader.index,
                        pixel.bin2,
                    )?;
                    let key = AdaptiveChildBlockKey {
                        file: missing[0].file.clone(),
                        parent_resolution,
                        child_resolution,
                        parent_bin1,
                        parent_bin2,
                    };
                    if let Some(block) = blocks.get_mut(&key) {
                        block.push(pixel);
                    }
                }
            }
        }
        span_start = span_end;
    }
    Ok(blocks
        .into_iter()
        .map(|(key, pixels)| (key, Arc::new(pixels)))
        .collect())
}

fn adaptive_child_bin_range(
    parent: &CoolIndex,
    child: &CoolIndex,
    parent_bin: u64,
    _parent_resolution: u64,
    _child_resolution: u64,
) -> CStudioResult<(u64, u64)> {
    let (source_index, start, end) = adaptive_bin_source_interval(parent, parent_bin)?;
    let child_start = child.chrom_offsets[source_index]
        + child.bin_starts
            [child.chrom_offsets[source_index]..child.chrom_offsets[source_index + 1]]
            .partition_point(|position| *position < start);
    let child_end = child.chrom_offsets[source_index]
        + child.bin_starts
            [child.chrom_offsets[source_index]..child.chrom_offsets[source_index + 1]]
            .partition_point(|position| *position < end);
    Ok((child_start as u64, child_end as u64))
}

fn adaptive_parent_bin_for_child(
    parent: &CoolIndex,
    child: &CoolIndex,
    child_bin: u64,
) -> CStudioResult<u64> {
    let (source_index, start) = bin_source_and_start(child, child_bin, "child_bin")?;
    source_bin_at_or_before(parent, source_index, start)
}

fn source_bin_at_or_before(index: &CoolIndex, source: usize, start: u64) -> CStudioResult<u64> {
    let chrom_start = index.chrom_offsets[source];
    let chrom_end = index.chrom_offsets[source + 1];
    let starts = &index.bin_starts[chrom_start..chrom_end];
    let relative = starts
        .partition_point(|position| *position <= start)
        .saturating_sub(1);
    u64::try_from(chrom_start + relative).map_err(|_| {
        CStudioError::InvalidContactMapQuery("adaptive parent bin exceeds u64 range".to_string())
    })
}

#[derive(Debug)]
struct SourceRangeIndex {
    select_all: bool,
    by_source: HashMap<String, Vec<(u64, u64)>>,
}

impl SourceRangeIndex {
    fn new(source_ranges: &[(String, u64, u64)]) -> Self {
        if source_ranges.is_empty() {
            return Self {
                select_all: true,
                by_source: HashMap::new(),
            };
        }

        let mut by_source = HashMap::<String, Vec<(u64, u64)>>::new();
        for (source, start, end) in source_ranges {
            if start < end {
                by_source
                    .entry(source.clone())
                    .or_default()
                    .push((*start, *end));
            }
        }
        for ranges in by_source.values_mut() {
            ranges.sort_unstable();
            let mut merged = Vec::<(u64, u64)>::with_capacity(ranges.len());
            for (start, end) in ranges.drain(..) {
                if let Some((_, previous_end)) = merged.last_mut() {
                    if start <= *previous_end {
                        *previous_end = (*previous_end).max(end);
                        continue;
                    }
                }
                merged.push((start, end));
            }
            *ranges = merged;
        }
        Self {
            select_all: false,
            by_source,
        }
    }

    fn ranges(&self, source: &str) -> Option<&[(u64, u64)]> {
        self.by_source.get(source).map(Vec::as_slice)
    }
}

#[derive(Debug)]
enum SelectedBinMembership {
    All { bin_count: usize },
    Partial { bin_count: usize, words: Vec<u64> },
}

#[derive(Debug)]
struct SelectedBinIndex {
    ranges: Vec<(usize, usize)>,
    membership: SelectedBinMembership,
}

impl SelectedBinIndex {
    fn new(
        index: &CoolIndex,
        source_ranges: &SourceRangeIndex,
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<Self> {
        ensure_not_cancelled(should_cancel)?;
        let bin_count = index.bin_starts.len();
        if source_ranges.select_all {
            return Ok(Self::all(bin_count));
        }

        let mut ranges = Vec::new();
        for (chrom_index, source) in index.chrom_names.iter().enumerate() {
            if chrom_index % 256 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            let Some(source_ranges) = source_ranges.ranges(source) else {
                continue;
            };
            let chrom_start = index.chrom_offsets[chrom_index];
            let chrom_end = index.chrom_offsets[chrom_index + 1];
            let starts = &index.bin_starts[chrom_start..chrom_end];

            for &(source_start, source_end) in source_ranges {
                let selected_start =
                    chrom_start + starts.partition_point(|position| *position < source_start);
                let selected_end =
                    chrom_start + starts.partition_point(|position| *position < source_end);
                push_merged_bin_range(&mut ranges, selected_start, selected_end);
            }
        }
        ensure_not_cancelled(should_cancel)?;

        if ranges.as_slice() == [(0, bin_count)] {
            return Ok(Self::all(bin_count));
        }

        let mut words = vec![0_u64; bin_count.saturating_add(63) / 64];
        let mut selected_count = 0_usize;
        for &(start, end) in &ranges {
            for bin in start..end {
                if selected_count & 4_095 == 0 {
                    ensure_not_cancelled(should_cancel)?;
                }
                words[bin / 64] |= 1_u64 << (bin % 64);
                selected_count += 1;
            }
        }

        Ok(Self {
            ranges,
            membership: SelectedBinMembership::Partial { bin_count, words },
        })
    }

    fn all(bin_count: usize) -> Self {
        Self {
            ranges: (bin_count > 0)
                .then_some((0, bin_count))
                .into_iter()
                .collect(),
            membership: SelectedBinMembership::All { bin_count },
        }
    }

    fn contains(&self, bin_id: u64) -> bool {
        let Ok(bin) = usize::try_from(bin_id) else {
            return false;
        };
        match &self.membership {
            SelectedBinMembership::All { bin_count } => bin < *bin_count,
            SelectedBinMembership::Partial { bin_count, words } => {
                bin < *bin_count && words[bin / 64] & (1_u64 << (bin % 64)) != 0
            }
        }
    }

    fn ranges(&self) -> &[(usize, usize)] {
        &self.ranges
    }
}

fn push_merged_bin_range(ranges: &mut Vec<(usize, usize)>, start: usize, end: usize) {
    if start >= end {
        return;
    }
    if let Some((_, previous_end)) = ranges.last_mut() {
        if start <= *previous_end {
            *previous_end = (*previous_end).max(end);
            return;
        }
    }
    ranges.push((start, end));
}

fn bin_source_and_start(
    index: &CoolIndex,
    bin_id: u64,
    pixel_column: &str,
) -> CStudioResult<(usize, u64)> {
    let bin_index: usize = bin_id.try_into().map_err(|_| {
        CStudioError::InvalidContactMapQuery(format!(
            ".cool pixel {pixel_column} {bin_id} exceeds this platform's index range"
        ))
    })?;
    let start = index.bin_starts.get(bin_index).copied().ok_or_else(|| {
        CStudioError::InvalidContactMapQuery(format!(
            ".cool pixel references missing {pixel_column} {bin_id}"
        ))
    })?;
    let chrom_id = index.bin_chrom_ids.get(bin_index).copied().ok_or_else(|| {
        CStudioError::InvalidContactMapQuery(format!(
            ".cool pixel references missing {pixel_column} {bin_id}"
        ))
    })?;
    let chrom_index = validated_bin_chrom_index(bin_index, chrom_id, index.chrom_names.len())?;

    Ok((chrom_index, start))
}

fn cached_cool_index(
    file: &File,
    path: &str,
    resolution: Option<u64>,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Arc<CoolIndex>> {
    ensure_not_cancelled(should_cancel)?;
    let key = cool_index_cache_key(path, resolution);
    let cache = COOL_INDEX_CACHE.get_or_init(|| Mutex::new(CoolIndexCache::default()));
    if let Ok(mut cache) = cache.lock() {
        if let Some(position) = cache
            .entries
            .iter()
            .position(|(entry_key, _)| *entry_key == key)
        {
            let entry = cache
                .entries
                .remove(position)
                .expect("cached index position exists");
            let result = Arc::clone(&entry.1);
            cache.entries.push_back(entry);
            return Ok(result);
        }
    }

    let prefix = cool_dataset_prefix(file, resolution)?;
    ensure_not_cancelled(should_cancel)?;
    let chrom_names = read_string_dataset(file, &format!("{prefix}chroms/name"))?;
    let chrom_lengths = read_u64_dataset(file, &format!("{prefix}chroms/length"))?;
    if chrom_names.len() != chrom_lengths.len() {
        return Err(CStudioError::InvalidContactMapQuery(
            ".cool chroms/name and chroms/length have different lengths".to_string(),
        ));
    }
    ensure_not_cancelled(should_cancel)?;
    let bin_chrom_ids = read_i32_dataset(file, &format!("{prefix}bins/chrom"))?;
    ensure_not_cancelled(should_cancel)?;
    let bin_starts = read_u64_dataset(file, &format!("{prefix}bins/start"))?;
    if bin_chrom_ids.len() != bin_starts.len() {
        return Err(CStudioError::InvalidContactMapQuery(
            ".cool bins/chrom and bins/start have different lengths".to_string(),
        ));
    }
    ensure_not_cancelled(should_cancel)?;
    let chrom_offset_path = format!("{prefix}indexes/chrom_offset");
    let stored_chrom_offsets = if file.link_exists(&chrom_offset_path) {
        Some(read_u64_dataset(file, &chrom_offset_path)?)
    } else {
        None
    };
    let chrom_offsets = resolve_chrom_offsets(
        chrom_names.len(),
        &bin_chrom_ids,
        stored_chrom_offsets.as_deref(),
        should_cancel,
    )?;
    validate_bin_starts_by_chrom(&bin_starts, &chrom_offsets, should_cancel)?;
    ensure_not_cancelled(should_cancel)?;
    let bin1_offsets = read_u64_dataset(file, &format!("{prefix}indexes/bin1_offset"))?;
    validate_bin1_offsets(&bin1_offsets, bin_starts.len(), should_cancel)?;
    ensure_not_cancelled(should_cancel)?;
    let bytes = chrom_names.iter().map(String::capacity).sum::<usize>()
        + chrom_lengths.capacity() * std::mem::size_of::<u64>()
        + bin_chrom_ids.capacity() * std::mem::size_of::<i32>()
        + chrom_offsets.capacity() * std::mem::size_of::<usize>()
        + bin_starts.capacity() * std::mem::size_of::<u64>()
        + bin1_offsets.capacity() * std::mem::size_of::<u64>();
    let index = Arc::new(CoolIndex {
        prefix,
        chrom_names,
        chrom_lengths,
        bin_chrom_ids,
        chrom_offsets,
        bin_starts,
        bin1_offsets,
        bytes,
    });

    if bytes <= MAX_COOL_INDEX_CACHE_BYTES {
        if let Ok(mut cache) = cache.lock() {
            while cache.used_bytes.saturating_add(bytes) > MAX_COOL_INDEX_CACHE_BYTES {
                let Some((_, evicted)) = cache.entries.pop_front() else {
                    break;
                };
                cache.used_bytes = cache.used_bytes.saturating_sub(evicted.bytes);
            }
            cache.used_bytes += bytes;
            cache.entries.push_back((key, Arc::clone(&index)));
        }
    }
    Ok(index)
}

fn resolve_chrom_offsets(
    chrom_count: usize,
    bin_chrom_ids: &[i32],
    stored_offsets: Option<&[u64]>,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<usize>> {
    let Some(stored_offsets) = stored_offsets else {
        let mut counts = vec![0_usize; chrom_count];
        let mut previous_chrom = None;
        for (bin_index, chrom_id) in bin_chrom_ids.iter().copied().enumerate() {
            if bin_index % 4_096 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            let chrom_index = validated_bin_chrom_index(bin_index, chrom_id, chrom_count)?;
            if previous_chrom.is_some_and(|previous| previous > chrom_index) {
                return Err(CStudioError::InvalidContactMapQuery(format!(
                    ".cool bins/chrom must be nondecreasing; bin {bin_index} has chrom id {chrom_id} after {}",
                    previous_chrom.unwrap_or(chrom_index),
                )));
            }
            counts[chrom_index] += 1;
            previous_chrom = Some(chrom_index);
        }
        let mut offsets = Vec::with_capacity(chrom_count + 1);
        offsets.push(0);
        for count in counts {
            offsets.push(offsets.last().copied().unwrap_or(0) + count);
        }
        return Ok(offsets);
    };

    if stored_offsets.len() != chrom_count + 1 {
        return Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool indexes/chrom_offset has {} values for {chrom_count} chromosomes; expected {}",
            stored_offsets.len(),
            chrom_count + 1,
        )));
    }

    let offsets = stored_offsets
        .iter()
        .enumerate()
        .map(|(offset_index, offset)| {
            usize::try_from(*offset).map_err(|_| {
                CStudioError::InvalidContactMapQuery(format!(
                    ".cool indexes/chrom_offset value {offset} at index {offset_index} exceeds this platform's index range"
                ))
            })
        })
        .collect::<CStudioResult<Vec<_>>>()?;
    if offsets.first().copied() != Some(0) {
        return Err(CStudioError::InvalidContactMapQuery(
            ".cool indexes/chrom_offset must start at 0".to_string(),
        ));
    }
    if offsets.last().copied() != Some(bin_chrom_ids.len()) {
        return Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool indexes/chrom_offset must end at the bin count {}; found {}",
            bin_chrom_ids.len(),
            offsets.last().copied().unwrap_or(0),
        )));
    }
    for (offset_index, offset) in offsets.iter().copied().enumerate() {
        if offset > bin_chrom_ids.len() {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/chrom_offset value {offset} at index {offset_index} exceeds the bin count {}",
                bin_chrom_ids.len(),
            )));
        }
    }
    for (chrom_index, pair) in offsets.windows(2).enumerate() {
        if pair[0] > pair[1] {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/chrom_offset decreases from {} to {} at chromosome {chrom_index}",
                pair[0], pair[1],
            )));
        }
    }
    for (chrom_index, pair) in offsets.windows(2).enumerate() {
        for (bin_index, chrom_id) in bin_chrom_ids
            .iter()
            .copied()
            .enumerate()
            .take(pair[1])
            .skip(pair[0])
        {
            if bin_index % 4_096 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            let actual_chrom = validated_bin_chrom_index(bin_index, chrom_id, chrom_count)?;
            if actual_chrom != chrom_index {
                return Err(CStudioError::InvalidContactMapQuery(format!(
                    ".cool indexes/chrom_offset assigns bin {bin_index} to chrom {chrom_index}, but bins/chrom contains {actual_chrom}"
                )));
            }
        }
    }

    Ok(offsets)
}

fn validated_bin_chrom_index(
    bin_index: usize,
    chrom_id: i32,
    chrom_count: usize,
) -> CStudioResult<usize> {
    let chrom_index: usize = chrom_id.try_into().map_err(|_| {
        CStudioError::InvalidContactMapQuery(format!(
            ".cool bin {bin_index} has negative chrom id {chrom_id}"
        ))
    })?;
    if chrom_index >= chrom_count {
        return Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool bin {bin_index} references missing chrom id {chrom_id}"
        )));
    }
    Ok(chrom_index)
}

fn validate_bin_starts_by_chrom(
    bin_starts: &[u64],
    chrom_offsets: &[usize],
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<()> {
    for (chrom_index, offsets) in chrom_offsets.windows(2).enumerate() {
        if chrom_index % 256 == 0 {
            ensure_not_cancelled(should_cancel)?;
        }
        for (local_index, starts) in bin_starts[offsets[0]..offsets[1]].windows(2).enumerate() {
            if local_index % 4_096 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            if starts[0] > starts[1] {
                let bin_index = offsets[0] + local_index + 1;
                return Err(CStudioError::InvalidContactMapQuery(format!(
                    ".cool bins/start must be nondecreasing within chrom {chrom_index}; bin {bin_index} starts at {} after {}",
                    starts[1], starts[0],
                )));
            }
        }
    }
    Ok(())
}

fn validate_bin1_offsets(
    bin1_offsets: &[u64],
    bin_count: usize,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<()> {
    let expected_len = bin_count.checked_add(1).ok_or_else(|| {
        CStudioError::InvalidContactMapQuery(
            ".cool bin count exceeds this platform's index range".to_string(),
        )
    })?;
    if bin1_offsets.len() != expected_len {
        return Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool indexes/bin1_offset has {} values for {bin_count} bins; expected {expected_len}",
            bin1_offsets.len(),
        )));
    }
    for (offset_index, offsets) in bin1_offsets.windows(2).enumerate() {
        if offset_index % 4_096 == 0 {
            ensure_not_cancelled(should_cancel)?;
        }
        if offsets[0] > offsets[1] {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/bin1_offset decreases from {} to {} at bin {offset_index}",
                offsets[0], offsets[1],
            )));
        }
    }
    Ok(())
}

fn cool_index_cache_key(path: &str, resolution: Option<u64>) -> CoolIndexCacheKey {
    let metadata = fs::metadata(path).ok();
    CoolIndexCacheKey {
        path: path.to_string(),
        resolution,
        size_bytes: metadata.as_ref().map_or(0, fs::Metadata::len),
        modified_nanos: metadata
            .and_then(|value| value.modified().ok())
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |value| value.as_nanos()),
    }
}

fn cached_normalization_weights(
    reader: &CoolReader,
    path: &str,
    resolution: Option<u64>,
    index: &CoolIndex,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Option<Arc<Vec<f64>>>> {
    if normalization == ContactNormalization::Raw {
        return Ok(None);
    }
    ensure_not_cancelled(should_cancel)?;

    let key = CoolNormalizationCacheKey {
        file: cool_index_cache_key(path, resolution),
        normalization,
    };
    loop {
        let result = cached_normalization_vector(key.clone(), should_cancel, || {
            // Preserve precomputed vectors exactly when present. Raw coolers without
            // them fall back to a runtime calculation for the resolved matrix level.
            let values = if let Some(values) = read_stored_normalization_weights(
                &reader.file,
                &index.prefix,
                index.bin_starts.len(),
                normalization,
                should_cancel,
            )? {
                values
            } else if let Some(values) = load_persistent_normalization_vector(
                path,
                resolution,
                normalization,
                index.bin_starts.len(),
            ) {
                if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
                    eprintln!(
                        "CSTUDIO_PERF event=runtime_normalization status=cache_hit normalization={} scope=disk bins={}",
                        normalization.as_str(),
                        values.len(),
                    );
                }
                values
            } else {
                let values = compute_runtime_normalization_weights(
                    reader,
                    index,
                    normalization,
                    should_cancel,
                )?;
                store_persistent_normalization_vector(path, resolution, normalization, &values);
                values
            };
            ensure_not_cancelled(should_cancel)?;
            if values.len() != index.bin_starts.len() {
                return Err(CStudioError::InvalidContactMapQuery(format!(
                    ".cool {} normalization has {} weights for {} bins",
                    normalization.as_str(),
                    values.len(),
                    index.bin_starts.len(),
                )));
            }
            Ok(values)
        });

        match result {
            // A foreground request can arrive while an idle prewarmer owns the
            // single-flight. If that low-priority leader yields, the still-live
            // foreground waiter must take over instead of surfacing a transient
            // cancellation to the UI.
            Err(CStudioError::RequestCancelled) if !should_cancel() => continue,
            result => return result.map(Some),
        }
    }
}

fn persistent_normalization_cache_path(
    path: &str,
    resolution: Option<u64>,
    normalization: ContactNormalization,
) -> Option<PathBuf> {
    if normalization != ContactNormalization::Kr {
        return None;
    }
    let root = PERSISTENT_NORMALIZATION_CACHE_DIR.get()?;
    let source = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let metadata = fs::metadata(&source).ok()?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let mut hasher = DefaultHasher::new();
    "cstudio-runtime-kr-assembly-csr-v1".hash(&mut hasher);
    source.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified_nanos.hash(&mut hasher);
    resolution.hash(&mut hasher);
    normalization.hash(&mut hasher);
    Some(root.join(format!("{:016x}.csnorm", hasher.finish())))
}

fn load_persistent_normalization_vector(
    path: &str,
    resolution: Option<u64>,
    normalization: ContactNormalization,
    expected_len: usize,
) -> Option<Vec<f64>> {
    let cache_path = persistent_normalization_cache_path(path, resolution, normalization)?;
    let mut file = fs::File::open(&cache_path).ok()?;
    let mut header = [0_u8; 16];
    if file.read_exact(&mut header).is_err()
        || header[..4] != PERSISTENT_NORMALIZATION_MAGIC
        || u16::from_le_bytes([header[4], header[5]]) != PERSISTENT_NORMALIZATION_VERSION
    {
        let _ = fs::remove_file(cache_path);
        return None;
    }
    let stored_len = u64::from_le_bytes(header[8..16].try_into().ok()?);
    if stored_len != expected_len as u64 {
        let _ = fs::remove_file(cache_path);
        return None;
    }
    let expected_bytes = expected_len.checked_mul(std::mem::size_of::<f64>())?;
    let mut bytes = vec![0_u8; expected_bytes];
    if file.read_exact(&mut bytes).is_err() {
        let _ = fs::remove_file(cache_path);
        return None;
    }
    let mut trailing = [0_u8; 1];
    if file.read(&mut trailing).ok()? != 0 {
        let _ = fs::remove_file(cache_path);
        return None;
    }
    Some(
        bytes
            .chunks_exact(8)
            .map(|chunk| f64::from_le_bytes(chunk.try_into().expect("eight-byte chunk")))
            .collect(),
    )
}

fn store_persistent_normalization_vector(
    path: &str,
    resolution: Option<u64>,
    normalization: ContactNormalization,
    weights: &[f64],
) {
    let Some(cache_path) = persistent_normalization_cache_path(path, resolution, normalization)
    else {
        return;
    };
    let Some(root) = cache_path.parent() else {
        return;
    };
    if fs::create_dir_all(root).is_err() {
        return;
    }
    let temp_id = NEXT_NORMALIZATION_CACHE_TEMP.fetch_add(1, AtomicOrdering::Relaxed);
    let temp_path = root.join(format!(
        ".{}.{}-{temp_id}.tmp",
        cache_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("normalization"),
        std::process::id(),
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(&PERSISTENT_NORMALIZATION_MAGIC)?;
        file.write_all(&PERSISTENT_NORMALIZATION_VERSION.to_le_bytes())?;
        file.write_all(&0_u16.to_le_bytes())?;
        file.write_all(&(weights.len() as u64).to_le_bytes())?;
        for weight in weights {
            file.write_all(&weight.to_le_bytes())?;
        }
        file.sync_all()?;
        fs::rename(&temp_path, &cache_path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
}

fn compute_runtime_normalization_weights(
    reader: &CoolReader,
    index: &CoolIndex,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<f64>> {
    match normalization {
        // Juicebox Assembly Tools builds its review map on one synthetic
        // `assembly` chromosome. Match that curation scope by balancing every
        // source bin and every cis/inter contact together. The resulting vector
        // remains attached to immutable source bins and can therefore be reused
        // while AGP placements are moved, flipped, joined, or split.
        ContactNormalization::Kr => {
            let matrix =
                read_normalization_matrix(&reader.file, index, normalization, should_cancel)?;
            let weights = compute_normalization_weights(&matrix, normalization, should_cancel)?;
            if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
                let valid_bins = weights
                    .iter()
                    .filter(|weight| weight.is_finite() && **weight > 0.0)
                    .count();
                eprintln!(
                    "CSTUDIO_PERF event=runtime_normalization status=complete normalization=kr scope=assembly valid_bins={} invalid_bins={} bins={}",
                    valid_bins,
                    weights.len().saturating_sub(valid_bins),
                    weights.len(),
                );
            }
            Ok(weights)
        }
        // Coverage normalizations retain their chromosome-cis definition.
        ContactNormalization::Vc | ContactNormalization::VcSqrt => {
            compute_cis_normalization_weights_by_chromosome(
                reader,
                index,
                normalization,
                should_cancel,
            )
        }
        // The `weight` fallback deliberately remains Cooler-style genome-wide
        // ICE. It is a different normalization family from Juicebox KR.
        ContactNormalization::Ice => {
            let matrix =
                read_normalization_matrix(&reader.file, index, normalization, should_cancel)?;
            compute_normalization_weights(&matrix, normalization, should_cancel)
        }
        ContactNormalization::Raw => Ok(vec![1.0; index.bin_starts.len()]),
    }
}

fn compute_cis_normalization_weights_by_chromosome(
    reader: &CoolReader,
    index: &CoolIndex,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<f64>> {
    let mut combined = vec![f64::NAN; index.bin_starts.len()];
    let mut completed_chromosomes = 0_usize;
    let mut failed_chromosomes = 0_usize;

    for chrom_index in 0..index.chrom_names.len() {
        ensure_not_cancelled(should_cancel)?;
        let bin_start = *index.chrom_offsets.get(chrom_index).ok_or_else(|| {
            CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/chrom_offset is missing chromosome {chrom_index}",
            ))
        })?;
        let bin_end = *index.chrom_offsets.get(chrom_index + 1).ok_or_else(|| {
            CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/chrom_offset is missing chromosome end {}",
                chrom_index + 1,
            ))
        })?;
        if bin_start >= bin_end {
            continue;
        }

        let matrix = read_chromosome_cis_normalization_matrix(
            reader,
            index,
            bin_start,
            bin_end,
            normalization,
            should_cancel,
        )?;
        match compute_normalization_weights(&matrix, normalization, should_cancel) {
            Ok(weights) => {
                if weights.len() != bin_end - bin_start {
                    return Err(CStudioError::InvalidContactMapQuery(format!(
                        ".cool {} normalization returned {} weights for chromosome {} with {} bins",
                        normalization.as_str(),
                        weights.len(),
                        index.chrom_names[chrom_index],
                        bin_end - bin_start,
                    )));
                }
                combined[bin_start..bin_end].copy_from_slice(&weights);
                completed_chromosomes += 1;
            }
            Err(CStudioError::RequestCancelled) => return Err(CStudioError::RequestCancelled),
            Err(error) => {
                // Juicebox treats a failed chromosome normalization as an
                // unavailable vector for that chromosome. Keep its bins NaN so
                // one sparse source cannot suppress valid vectors elsewhere.
                failed_chromosomes += 1;
                if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
                    eprintln!(
                        "CSTUDIO_PERF event=runtime_normalization_chromosome status=failed normalization={} chromosome={} bins={} error={}",
                        normalization.as_str(),
                        index.chrom_names[chrom_index],
                        bin_end - bin_start,
                        error,
                    );
                }
            }
        }
    }

    if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
        eprintln!(
            "CSTUDIO_PERF event=runtime_normalization status=complete normalization={} chromosomes={} failed_chromosomes={} bins={}",
            normalization.as_str(),
            completed_chromosomes,
            failed_chromosomes,
            combined.len(),
        );
    }
    Ok(combined)
}

fn read_chromosome_cis_normalization_matrix(
    reader: &CoolReader,
    index: &CoolIndex,
    bin_start: usize,
    bin_end: usize,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<SparseContactMatrix> {
    let bin_count = bin_end.checked_sub(bin_start).ok_or_else(|| {
        CStudioError::InvalidContactMapQuery(".cool chromosome bin range is reversed".to_string())
    })?;
    let pixel_start: usize = (*index.bin1_offsets.get(bin_start).ok_or_else(|| {
        CStudioError::InvalidContactMapQuery(format!(
            ".cool indexes/bin1_offset is missing bin {bin_start}",
        ))
    })?)
    .try_into()
    .map_err(|_| {
        CStudioError::InvalidContactMapQuery(
            ".cool chromosome pixel start exceeds this platform's index range".to_string(),
        )
    })?;
    let pixel_end: usize = (*index.bin1_offsets.get(bin_end).ok_or_else(|| {
        CStudioError::InvalidContactMapQuery(format!(
            ".cool indexes/bin1_offset is missing bin {bin_end}",
        ))
    })?)
    .try_into()
    .map_err(|_| {
        CStudioError::InvalidContactMapQuery(
            ".cool chromosome pixel end exceeds this platform's index range".to_string(),
        )
    })?;

    let pixel_count = pixel_end.saturating_sub(pixel_start);
    let estimated_bytes =
        estimated_runtime_normalization_peak_bytes(pixel_count, bin_count, normalization);
    ensure_runtime_normalization_memory_budget(
        estimated_bytes,
        &format!("for one chromosome with {bin_count} bins and {pixel_count} pixels"),
    )?;

    let mut local_bin1 = Vec::new();
    let mut local_bin2 = Vec::new();
    let mut counts = Vec::new();
    for chunk_start in (pixel_start..pixel_end).step_by(MAX_COOL_PIXEL_READ_CHUNK) {
        ensure_not_cancelled(should_cancel)?;
        let chunk_end = chunk_start
            .saturating_add(MAX_COOL_PIXEL_READ_CHUNK)
            .min(pixel_end);
        let pixel_bin2 = reader.pixel_bin2.read_slice(chunk_start, chunk_end)?;
        let pixel_counts = reader.pixel_counts.read_slice(chunk_start, chunk_end)?;
        if pixel_bin2.len() != pixel_counts.len() {
            return Err(CStudioError::InvalidContactMapQuery(
                ".cool pixels/bin2_id and count have different lengths".to_string(),
            ));
        }
        let mut bin1_index = bin1_for_pixel_offset(&index.bin1_offsets, chunk_start)?;
        for (pixel_index, (bin2, count)) in pixel_bin2.into_iter().zip(pixel_counts).enumerate() {
            if pixel_index % 16_384 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            let pixel_offset =
                u64::try_from(chunk_start.saturating_add(pixel_index)).map_err(|_| {
                    CStudioError::InvalidContactMapQuery(
                        ".cool pixel offset exceeds u64".to_string(),
                    )
                })?;
            while index
                .bin1_offsets
                .get(bin1_index + 1)
                .is_some_and(|next_offset| *next_offset <= pixel_offset)
            {
                bin1_index += 1;
            }
            let bin2: usize = bin2.try_into().map_err(|_| {
                CStudioError::InvalidContactMapQuery(
                    ".cool bin2 index exceeds this platform's index range".to_string(),
                )
            })?;
            if bin1_index < bin_start
                || bin1_index >= bin_end
                || bin2 < bin_start
                || bin2 >= bin_end
            {
                continue;
            }
            local_bin1.push((bin1_index - bin_start) as u64);
            local_bin2.push((bin2 - bin_start) as u64);
            counts.push(count);
        }
    }

    SparseContactMatrix::new(bin_count, local_bin1, local_bin2, counts)
}

fn cached_normalization_vector<F>(
    key: CoolNormalizationCacheKey,
    should_cancel: &dyn Fn() -> bool,
    compute: F,
) -> CStudioResult<Arc<Vec<f64>>>
where
    F: FnOnce() -> CStudioResult<Vec<f64>>,
{
    ensure_not_cancelled(should_cancel)?;
    let cache =
        COOL_NORMALIZATION_CACHE.get_or_init(|| Mutex::new(CoolNormalizationCache::default()));
    let (flight, is_leader) = {
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(position) = cache
            .entries
            .iter()
            .position(|(entry_key, _)| *entry_key == key)
        {
            let entry = cache
                .entries
                .remove(position)
                .expect("cached normalization position exists");
            let result = Arc::clone(&entry.1);
            cache.entries.push_back(entry);
            return Ok(result);
        }

        if let Some(flight) = cache.in_flight.get(&key) {
            (Arc::clone(flight), false)
        } else {
            let flight = Arc::new(CoolNormalizationFlight::default());
            cache.in_flight.insert(key.clone(), Arc::clone(&flight));
            (flight, true)
        }
    };

    if !is_leader {
        return wait_for_normalization_flight(&flight, should_cancel);
    }

    let result = compute().map(Arc::new);
    complete_normalization_flight(cache, &key, &flight, &result);
    result
}

fn wait_for_normalization_flight(
    flight: &CoolNormalizationFlight,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Arc<Vec<f64>>> {
    loop {
        ensure_not_cancelled(should_cancel)?;
        let result = flight
            .result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(result) = result.as_ref() {
            return result.clone();
        }

        let (result, _) = flight
            .ready
            .wait_timeout(result, Duration::from_millis(25))
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(result) = result.as_ref() {
            return result.clone();
        }
    }
}

fn complete_normalization_flight(
    cache: &Mutex<CoolNormalizationCache>,
    key: &CoolNormalizationCacheKey,
    flight: &Arc<CoolNormalizationFlight>,
    result: &CStudioResult<Arc<Vec<f64>>>,
) {
    {
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Ok(values) = result {
            let bytes = values.capacity() * std::mem::size_of::<f64>();
            if bytes <= MAX_COOL_NORMALIZATION_CACHE_BYTES {
                while cache.used_bytes.saturating_add(bytes) > MAX_COOL_NORMALIZATION_CACHE_BYTES {
                    let Some((_, evicted)) = cache.entries.pop_front() else {
                        break;
                    };
                    cache.used_bytes = cache
                        .used_bytes
                        .saturating_sub(evicted.capacity() * std::mem::size_of::<f64>());
                }
                cache.used_bytes += bytes;
                cache.entries.push_back((key.clone(), Arc::clone(values)));
            }
        }
        if cache
            .in_flight
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, flight))
        {
            cache.in_flight.remove(key);
        }
    }

    let mut completed = flight
        .result
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *completed = Some(result.clone());
    flight.ready.notify_all();
}

fn read_stored_normalization_weights(
    file: &File,
    prefix: &str,
    bin_count: usize,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Option<Vec<f64>>> {
    let Some((column, divisive)) = stored_normalization_column(normalization) else {
        return Ok(None);
    };
    let dataset_path = format!("{prefix}bins/{column}");
    if file.dataset(&dataset_path).is_err() {
        return Ok(None);
    }

    ensure_not_cancelled(should_cancel)?;
    let mut weights = read_f64_dataset(file, &dataset_path)?;
    ensure_not_cancelled(should_cancel)?;
    if weights.len() != bin_count {
        return Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool normalization column {dataset_path} has {} weights for {bin_count} bins",
            weights.len(),
        )));
    }

    for (index, weight) in weights.iter_mut().enumerate() {
        if index % 16_384 == 0 {
            ensure_not_cancelled(should_cancel)?;
        }
        let converted = if weight.is_finite() && *weight > 0.0 {
            if divisive {
                1.0 / *weight
            } else {
                *weight
            }
        } else {
            f64::NAN
        };
        *weight = if converted.is_finite() && converted > 0.0 {
            converted
        } else {
            f64::NAN
        };
    }
    Ok(Some(weights))
}

fn stored_normalization_column(
    normalization: ContactNormalization,
) -> Option<(&'static str, bool)> {
    match normalization {
        ContactNormalization::Raw => None,
        // Cooler-native balancing weights are multiplicative.
        ContactNormalization::Ice => Some(("weight", false)),
        // 4DN/hic2cool vectors preserve Juicebox's divisive convention.
        ContactNormalization::Kr => Some(("KR", true)),
        ContactNormalization::Vc => Some(("VC", true)),
        ContactNormalization::VcSqrt => Some(("VC_SQRT", true)),
    }
}

fn read_normalization_matrix(
    file: &File,
    index: &CoolIndex,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<SparseContactMatrix> {
    let pixel_count: usize = index
        .bin1_offsets
        .last()
        .copied()
        .unwrap_or(0)
        .try_into()
        .map_err(|_| {
            CStudioError::InvalidContactMapQuery(
                ".cool normalization pixel count exceeds this platform's index range".to_string(),
            )
        })?;
    let estimated_bytes = estimated_runtime_normalization_peak_bytes(
        pixel_count,
        index.bin_starts.len(),
        normalization,
    );
    ensure_runtime_normalization_memory_budget(
        estimated_bytes,
        &format!(
            "for {} bins and {pixel_count} pixels",
            index.bin_starts.len()
        ),
    )?;
    let mut bin1 = Vec::with_capacity(pixel_count);
    let mut bin2 = Vec::with_capacity(pixel_count);
    let mut counts = Vec::with_capacity(pixel_count);
    let bin1_path = format!("{}pixels/bin1_id", index.prefix);
    let bin2_path = format!("{}pixels/bin2_id", index.prefix);
    let count_path = format!("{}pixels/count", index.prefix);

    for start in (0..pixel_count).step_by(MAX_COOL_PIXEL_READ_CHUNK) {
        ensure_not_cancelled(should_cancel)?;
        let end = start
            .saturating_add(MAX_COOL_PIXEL_READ_CHUNK)
            .min(pixel_count);
        let chunk_bin1 = read_u64_dataset_slice(file, &bin1_path, start, end)?;
        ensure_not_cancelled(should_cancel)?;
        let chunk_bin2 = read_u64_dataset_slice(file, &bin2_path, start, end)?;
        ensure_not_cancelled(should_cancel)?;
        let chunk_counts = read_f64_dataset_slice(file, &count_path, start, end)?;
        if chunk_bin1.len() != chunk_bin2.len() || chunk_bin1.len() != chunk_counts.len() {
            return Err(CStudioError::InvalidContactMapQuery(
                ".cool pixels/bin1_id, bin2_id, and count have different lengths".to_string(),
            ));
        }
        bin1.extend(chunk_bin1);
        bin2.extend(chunk_bin2);
        counts.extend(chunk_counts);
    }

    SparseContactMatrix::new(index.bin_starts.len(), bin1, bin2, counts)
}

fn normalized_contact_count(
    count: f64,
    bin1: u64,
    bin2: u64,
    weights: Option<&[f64]>,
) -> Option<f64> {
    let Some(weights) = weights else {
        return Some(count);
    };
    let first = *weights.get(bin1 as usize)?;
    let second = *weights.get(bin2 as usize)?;
    if !count.is_finite()
        || !first.is_finite()
        || first <= 0.0
        || !second.is_finite()
        || second <= 0.0
    {
        return None;
    }
    let normalized = count * first * second;
    normalized.is_finite().then_some(normalized)
}

fn ensure_not_cancelled(should_cancel: &dyn Fn() -> bool) -> CStudioResult<()> {
    if should_cancel() {
        Err(CStudioError::RequestCancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
fn pixel_ranges_for_selected_bin_ranges(
    selected_bin_ranges: &[(usize, usize)],
    bin1_offsets: &[u64],
) -> CStudioResult<Vec<(usize, usize)>> {
    pixel_ranges_for_selected_bin_ranges_cancellable(selected_bin_ranges, bin1_offsets, &|| false)
}

fn pixel_ranges_for_selected_bin_ranges_cancellable(
    selected_bin_ranges: &[(usize, usize)],
    bin1_offsets: &[u64],
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<(usize, usize)>> {
    ensure_not_cancelled(should_cancel)?;
    let mut ranges = Vec::new();
    for (selected_index, &(bin_start, bin_end)) in selected_bin_ranges.iter().enumerate() {
        if selected_index % 4_096 == 0 {
            ensure_not_cancelled(should_cancel)?;
        }
        if bin_start >= bin_end {
            continue;
        }
        let Some(&start) = bin1_offsets.get(bin_start) else {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/bin1_offset missing start for bin {bin_start}"
            )));
        };
        let Some(&end) = bin1_offsets.get(bin_end) else {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/bin1_offset missing end for bin {}",
                bin_end - 1,
            )));
        };
        if start == end {
            continue;
        }
        if start > end {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/bin1_offset decreases from {start} to {end} across bins {bin_start}..{bin_end}"
            )));
        }

        let start: usize = start.try_into().map_err(|_| {
            CStudioError::InvalidContactMapQuery(format!(
                ".cool pixel offset {start} exceeds this platform's index range"
            ))
        })?;
        let end: usize = end.try_into().map_err(|_| {
            CStudioError::InvalidContactMapQuery(format!(
                ".cool pixel offset {end} exceeds this platform's index range"
            ))
        })?;
        if let Some((_, last_end)) = ranges.last_mut() {
            if start <= *last_end {
                *last_end = (*last_end).max(end);
                continue;
            }
        }
        ranges.push((start, end));
    }

    Ok(ranges)
}

fn selected_pixel_ranges_from_resident_bin2(
    bin1_pixel_ranges: &[(usize, usize)],
    resident_bin2: &[u32],
    selected_bins: &SelectedBinIndex,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<(usize, usize)>> {
    ensure_not_cancelled(should_cancel)?;
    let mut selected_ranges = Vec::<(usize, usize)>::new();
    for (range_index, &(start, end)) in bin1_pixel_ranges.iter().enumerate() {
        if range_index % 4_096 == 0 {
            ensure_not_cancelled(should_cancel)?;
        }
        if start >= end {
            continue;
        }
        if end > resident_bin2.len() {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool pixel range {start}..{end} exceeds the resident bin2 index length {}",
                resident_bin2.len(),
            )));
        }

        let mut run_start = None::<usize>;
        for (relative_offset, bin2) in resident_bin2[start..end].iter().copied().enumerate() {
            if relative_offset % 16_384 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            let pixel_offset = start + relative_offset;
            if selected_bins.contains(u64::from(bin2)) {
                run_start.get_or_insert(pixel_offset);
            } else if let Some(selected_start) = run_start.take() {
                selected_ranges.push((selected_start, pixel_offset));
            }
        }
        if let Some(selected_start) = run_start {
            selected_ranges.push((selected_start, end));
        }
    }
    ensure_not_cancelled(should_cancel)?;
    Ok(batch_nearby_pixel_ranges(
        &selected_ranges,
        COOL_RESIDENT_PIXEL_BATCH_GAP,
    ))
}

fn batch_nearby_pixel_ranges(
    pixel_ranges: &[(usize, usize)],
    max_gap: usize,
) -> Vec<(usize, usize)> {
    let mut batches = Vec::<(usize, usize)>::with_capacity(pixel_ranges.len());
    for &(start, end) in pixel_ranges {
        if start >= end {
            continue;
        }
        if let Some((_, previous_end)) = batches.last_mut() {
            if start.saturating_sub(*previous_end) <= max_gap {
                *previous_end = (*previous_end).max(end);
                continue;
            }
        }
        batches.push((start, end));
    }
    batches
}

fn cool_dataset_prefix(file: &File, resolution: Option<u64>) -> CStudioResult<String> {
    if file.group("resolutions").is_ok() {
        let resolution = resolution.ok_or_else(|| {
            CStudioError::InvalidContactMapQuery(
                ".mcool files require an explicit resolution".to_string(),
            )
        })?;
        let prefix = format!("resolutions/{resolution}/");
        file.group(prefix.trim_end_matches('/'))
            .map_err(cool_error)?;
        return Ok(prefix);
    }

    Ok(String::new())
}

fn read_string_dataset(file: &File, path: &str) -> CStudioResult<Vec<String>> {
    let dataset = file.dataset(path).map_err(cool_error)?;
    match dataset
        .dtype()
        .and_then(|datatype| datatype.to_descriptor())
    {
        Ok(TypeDescriptor::VarLenUnicode) => dataset
            .read_1d::<VarLenUnicode>()
            .map(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().to_string())
                    .collect()
            })
            .map_err(cool_error),
        Ok(TypeDescriptor::VarLenAscii) => dataset
            .read_1d::<VarLenAscii>()
            .map(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().to_string())
                    .collect()
            })
            .map_err(cool_error),
        Ok(TypeDescriptor::FixedAscii(length)) if length <= 256 => dataset
            .read_1d::<FixedAscii<256>>()
            .map(|values| {
                values
                    .iter()
                    .map(|value| String::from(value.clone()))
                    .collect()
            })
            .map_err(cool_error),
        Ok(TypeDescriptor::FixedAscii(length)) => Err(CStudioError::InvalidContactMapQuery(
            format!(".cool string width {length} exceeds the supported 256-byte limit"),
        )),
        Ok(descriptor) => Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool dataset {path} must contain ASCII or Unicode strings, found {descriptor}"
        ))),
        Err(error) => Err(cool_error(error)),
    }
}

fn read_i32_dataset(file: &File, path: &str) -> CStudioResult<Vec<i32>> {
    let values = file
        .dataset(path)
        .and_then(|dataset| dataset.read_1d::<i32>())
        .map_err(cool_error)?;
    Ok(values.to_vec())
}

fn read_u64_dataset(file: &File, path: &str) -> CStudioResult<Vec<u64>> {
    if let Ok(values) = file
        .dataset(path)
        .and_then(|dataset| dataset.read_1d::<u64>())
    {
        return Ok(values.to_vec());
    }

    let values = file
        .dataset(path)
        .and_then(|dataset| dataset.read_1d::<u32>())
        .map_err(cool_error)?;
    Ok(values.iter().map(|value| *value as u64).collect())
}

fn read_u64_dataset_slice(
    file: &File,
    path: &str,
    start: usize,
    end: usize,
) -> CStudioResult<Vec<u64>> {
    if start >= end {
        return Ok(Vec::new());
    }

    let dataset = file.dataset(path).map_err(cool_error)?;
    if let Ok(values) = dataset.read_slice_1d::<u64, _>(start..end) {
        return Ok(values.to_vec());
    }

    let values = dataset
        .read_slice_1d::<u32, _>(start..end)
        .map_err(cool_error)?;
    Ok(values.iter().map(|value| *value as u64).collect())
}

fn read_f64_dataset(file: &File, path: &str) -> CStudioResult<Vec<f64>> {
    let dataset = file.dataset(path).map_err(cool_error)?;
    if let Ok(values) = dataset.read_1d::<f64>() {
        return Ok(values.to_vec());
    }
    if let Ok(values) = dataset.read_1d::<f32>() {
        return Ok(values.iter().map(|value| *value as f64).collect());
    }
    if let Ok(values) = dataset.read_1d::<i64>() {
        return Ok(values.iter().map(|value| *value as f64).collect());
    }
    if let Ok(values) = dataset.read_1d::<i32>() {
        return Ok(values.iter().map(|value| *value as f64).collect());
    }
    if let Ok(values) = dataset.read_1d::<u64>() {
        return Ok(values.iter().map(|value| *value as f64).collect());
    }
    let values = dataset.read_1d::<u32>().map_err(cool_error)?;
    Ok(values.iter().map(|value| *value as f64).collect())
}

fn read_f64_dataset_slice(
    file: &File,
    path: &str,
    start: usize,
    end: usize,
) -> CStudioResult<Vec<f64>> {
    if start >= end {
        return Ok(Vec::new());
    }

    let dataset = file.dataset(path).map_err(cool_error)?;
    if let Ok(values) = dataset.read_slice_1d::<f64, _>(start..end) {
        return Ok(values.to_vec());
    }

    if let Ok(values) = dataset.read_slice_1d::<f32, _>(start..end) {
        return Ok(values.iter().map(|value| *value as f64).collect());
    }

    let values = dataset
        .read_slice_1d::<i32, _>(start..end)
        .map_err(cool_error)?;
    Ok(values.iter().map(|value| *value as f64).collect())
}

fn cool_error(error: hdf5::Error) -> CStudioError {
    CStudioError::InvalidContactMapQuery(format!(".cool read error: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
            mpsc, Arc, Barrier, Condvar, Mutex,
        },
        thread,
        time::Duration,
    };

    use hdf5::{types::FixedAscii, File};

    use super::{
        batch_nearby_pixel_ranges, bin1_for_pixel_offset, cached_cool_reader,
        cached_normalization_vector, cool_index_cache_key, list_contact_resolutions,
        list_contact_sources, normalized_contact_count, pixel_ranges_for_selected_bin_ranges,
        read_cool_contacts_for_source_ranges_at_resolution,
        read_cool_contacts_for_source_ranges_at_resolution_cancellable,
        read_cool_contacts_for_sources,
        read_cool_contacts_for_sources_at_resolution_with_normalization, resolve_chrom_offsets,
        runtime_normalization_memory_budget_bytes, selected_pixel_ranges_from_resident_bin2,
        validate_bin1_offsets,
        visit_cool_contact_chunks_for_source_ranges_at_resolution_with_normalization_cancellable,
        visit_cool_contact_chunks_indexed_for_source_ranges_at_resolution_with_normalization_cancellable,
        visit_cool_contact_chunks_indexed_profiled_for_source_ranges_at_resolution_with_normalization_cancellable,
        visit_cool_contact_chunks_profiled_for_source_ranges_at_resolution_with_normalization_cancellable,
        CoolContactVisitTimings, CoolIndex, CoolIndexCacheKey, CoolNormalizationCacheKey,
        CoolSourceMetadata, SelectedBinIndex, SelectedBinMembership, SourceRangeIndex,
    };
    use crate::{
        agp::Orientation,
        contact_map::{
            build_contact_map_view_from_contacts, ContactMapQuery, LayoutBlock, Viewport,
        },
    };
    use crate::{contact_normalization::ContactNormalization, CStudioError, CStudioResult};

    static NEXT_TEST_FILE_ID: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn runtime_normalization_budget_is_eighty_percent_of_available_memory() {
        assert_eq!(runtime_normalization_memory_budget_bytes(1_000), 800);
        assert_eq!(runtime_normalization_memory_budget_bytes(9), 7);

        super::ensure_runtime_normalization_memory_budget_with_available(
            800,
            "for a test matrix",
            Some(1_000),
        )
        .expect("an estimate at the 80% boundary is allowed");
        let error = super::ensure_runtime_normalization_memory_budget_with_available(
            801,
            "for a test matrix",
            Some(1_000),
        )
        .expect_err("an estimate above the 80% boundary is rejected");
        assert!(error.to_string().contains("80% budget"));
    }

    #[test]
    fn runtime_normalization_can_observe_current_available_memory() {
        let available = super::available_system_memory_bytes()
            .expect("this supported desktop should report available memory");
        assert!(available > 0);
        assert!(runtime_normalization_memory_budget_bytes(available) <= available);
    }

    fn test_normalization_cache_key() -> CoolNormalizationCacheKey {
        let id = NEXT_TEST_FILE_ID.fetch_add(1, Ordering::Relaxed);
        CoolNormalizationCacheKey {
            file: CoolIndexCacheKey {
                path: format!("singleflight-test-{id}"),
                resolution: None,
                size_bytes: 0,
                modified_nanos: 0,
            },
            normalization: ContactNormalization::Vc,
        }
    }

    struct TestCoolFile {
        path: PathBuf,
    }

    impl TestCoolFile {
        fn with_weights(weight: &[f64], divisive: &[f64]) -> Self {
            Self::create(Some(weight), Some(divisive))
        }

        fn without_weights() -> Self {
            Self::create(None, None)
        }

        fn with_chrom_offsets(chrom_offsets: &[u64]) -> Self {
            Self::create_with_chrom_offsets(None, None, Some(chrom_offsets))
        }

        fn with_two_chromosomes_and_strong_inter_contacts() -> Self {
            Self::create_custom(
                &["chr1", "chr2"],
                &[2_000, 2_000],
                &[0, 0, 1, 1],
                &[0, 1_000, 0, 1_000],
                &[1_000, 2_000, 1_000, 2_000],
                &[0, 3, 5, 7, 8],
                &[0, 0, 0, 1, 1, 2, 2, 3],
                &[0, 1, 2, 1, 3, 2, 3, 3],
                &[12.0, 6.0, 1_000.0, 3.0, 1_000.0, 4.0, 2.0, 1.0],
                &[0, 2, 4],
            )
        }

        fn create(weight: Option<&[f64]>, divisive: Option<&[f64]>) -> Self {
            Self::create_with_chrom_offsets(weight, divisive, None)
        }

        fn create_with_chrom_offsets(
            weight: Option<&[f64]>,
            divisive: Option<&[f64]>,
            chrom_offsets: Option<&[u64]>,
        ) -> Self {
            let id = NEXT_TEST_FILE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cstudio-normalization-{}-{id}.cool",
                std::process::id(),
            ));
            let file = File::create(&path).expect("create test .cool file");
            file.create_group("chroms").expect("create chroms group");
            file.create_group("bins").expect("create bins group");
            file.create_group("indexes").expect("create indexes group");
            file.create_group("pixels").expect("create pixels group");
            let names = [FixedAscii::<11>::from_ascii("chr1").expect("ASCII chromosome")];
            file.new_dataset_builder()
                .with_data(&names)
                .create("chroms/name")
                .expect("write chromosome names");
            file.new_dataset_builder()
                .with_data(&[2_000_u64])
                .create("chroms/length")
                .expect("write chromosome lengths");
            file.new_dataset_builder()
                .with_data(&[0_i32, 0])
                .create("bins/chrom")
                .expect("write bin chromosomes");
            file.new_dataset_builder()
                .with_data(&[0_u64, 1_000])
                .create("bins/start")
                .expect("write bin starts");
            file.new_dataset_builder()
                .with_data(&[1_000_u64, 2_000])
                .create("bins/end")
                .expect("write bin ends");
            file.new_dataset_builder()
                .with_data(&[0_u64, 2, 3])
                .create("indexes/bin1_offset")
                .expect("write bin offsets");
            if let Some(chrom_offsets) = chrom_offsets {
                file.new_dataset_builder()
                    .with_data(chrom_offsets)
                    .create("indexes/chrom_offset")
                    .expect("write chromosome offsets");
            }
            file.new_dataset_builder()
                .with_data(&[0_u64, 0, 1])
                .create("pixels/bin1_id")
                .expect("write pixel bin1 ids");
            file.new_dataset_builder()
                .with_data(&[0_u64, 1, 1])
                .create("pixels/bin2_id")
                .expect("write pixel bin2 ids");
            file.new_dataset_builder()
                .with_data(&[12.0_f64, 6.0, 3.0])
                .create("pixels/count")
                .expect("write pixel counts");
            if let Some(weight) = weight {
                file.new_dataset_builder()
                    .with_data(weight)
                    .create("bins/weight")
                    .expect("write ICE weights");
            }
            if let Some(divisive) = divisive {
                for column in ["KR", "VC", "VC_SQRT"] {
                    file.new_dataset_builder()
                        .with_data(divisive)
                        .create(format!("bins/{column}").as_str())
                        .expect("write divisive weights");
                }
            }
            drop(file);
            Self { path }
        }

        #[allow(clippy::too_many_arguments)]
        fn create_custom(
            chrom_names: &[&str],
            chrom_lengths: &[u64],
            bin_chrom: &[i32],
            bin_starts: &[u64],
            bin_ends: &[u64],
            bin1_offsets: &[u64],
            pixel_bin1: &[u64],
            pixel_bin2: &[u64],
            pixel_counts: &[f64],
            chrom_offsets: &[u64],
        ) -> Self {
            let id = NEXT_TEST_FILE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cstudio-normalization-custom-{}-{id}.cool",
                std::process::id(),
            ));
            let file = File::create(&path).expect("create custom test .cool file");
            for group in ["chroms", "bins", "indexes", "pixels"] {
                file.create_group(group).expect("create Cooler group");
            }
            let names = chrom_names
                .iter()
                .map(|name| FixedAscii::<11>::from_ascii(name).expect("ASCII chromosome"))
                .collect::<Vec<_>>();
            file.new_dataset_builder()
                .with_data(&names)
                .create("chroms/name")
                .expect("write chromosome names");
            file.new_dataset_builder()
                .with_data(chrom_lengths)
                .create("chroms/length")
                .expect("write chromosome lengths");
            for (path, values) in [
                ("bins/start", bin_starts),
                ("bins/end", bin_ends),
                ("indexes/bin1_offset", bin1_offsets),
                ("indexes/chrom_offset", chrom_offsets),
                ("pixels/bin1_id", pixel_bin1),
                ("pixels/bin2_id", pixel_bin2),
            ] {
                file.new_dataset_builder()
                    .with_data(values)
                    .create(path)
                    .expect("write unsigned Cooler dataset");
            }
            file.new_dataset_builder()
                .with_data(bin_chrom)
                .create("bins/chrom")
                .expect("write bin chromosomes");
            file.new_dataset_builder()
                .with_data(pixel_counts)
                .create("pixels/count")
                .expect("write pixel counts");
            drop(file);
            Self { path }
        }

        fn path(&self) -> &str {
            self.path.to_str().expect("UTF-8 test path")
        }
    }

    impl Drop for TestCoolFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    struct TestAdaptiveMcool {
        path: PathBuf,
    }

    impl TestAdaptiveMcool {
        fn create() -> Self {
            let id = NEXT_TEST_FILE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cstudio-adaptive-{}-{id}.mcool",
                std::process::id(),
            ));
            let file = File::create(&path).expect("create adaptive test mcool");
            file.create_group("resolutions")
                .expect("create resolutions");
            let observations = [
                (0_u64, 0_u64, 2_i32),
                (1_249_000, 1_249_000, 3),
                (1_250_000, 1_250_000, 5),
                (2_499_000, 2_499_000, 7),
            ];
            for resolution in super::ADAPTIVE_RESOLUTION_CHAIN {
                Self::write_resolution(&file, resolution, &observations);
            }
            drop(file);
            Self { path }
        }

        fn write_resolution(file: &File, resolution: u64, observations: &[(u64, u64, i32)]) {
            let prefix = format!("resolutions/{resolution}");
            file.create_group(&prefix).expect("create resolution");
            for group in ["chroms", "bins", "indexes", "pixels"] {
                file.create_group(&format!("{prefix}/{group}"))
                    .expect("create resolution subgroup");
            }
            let names = [FixedAscii::<8>::from_ascii("chr1").expect("ASCII source")];
            file.new_dataset_builder()
                .with_data(&names)
                .create(format!("{prefix}/chroms/name").as_str())
                .expect("write names");
            file.new_dataset_builder()
                .with_data(&[3_000_000_u64])
                .create(format!("{prefix}/chroms/length").as_str())
                .expect("write lengths");
            let bin_count = 3_000_000_u64.div_ceil(resolution) as usize;
            let bin_chrom = vec![0_i32; bin_count];
            let bin_starts = (0..bin_count)
                .map(|bin| bin as u64 * resolution)
                .collect::<Vec<_>>();
            let bin_ends = bin_starts
                .iter()
                .map(|start| start.saturating_add(resolution).min(3_000_000))
                .collect::<Vec<_>>();
            file.new_dataset_builder()
                .with_data(&bin_chrom)
                .create(format!("{prefix}/bins/chrom").as_str())
                .expect("write bin chroms");
            file.new_dataset_builder()
                .with_data(&bin_starts)
                .create(format!("{prefix}/bins/start").as_str())
                .expect("write bin starts");
            file.new_dataset_builder()
                .with_data(&bin_ends)
                .create(format!("{prefix}/bins/end").as_str())
                .expect("write bin ends");
            file.new_dataset_builder()
                .with_data(&[0_u64, bin_count as u64])
                .create(format!("{prefix}/indexes/chrom_offset").as_str())
                .expect("write chrom offsets");

            let mut aggregated = HashMap::<(u64, u64), i32>::new();
            for &(start1, start2, count) in observations {
                *aggregated
                    .entry((start1 / resolution, start2 / resolution))
                    .or_insert(0) += count;
            }
            let mut pixels = aggregated.into_iter().collect::<Vec<_>>();
            pixels.sort_by_key(|((bin1, bin2), _)| (*bin1, *bin2));
            let pixel_bin1 = pixels
                .iter()
                .map(|((bin1, _), _)| *bin1)
                .collect::<Vec<_>>();
            let pixel_bin2 = pixels
                .iter()
                .map(|((_, bin2), _)| *bin2)
                .collect::<Vec<_>>();
            let pixel_counts = pixels.iter().map(|(_, count)| *count).collect::<Vec<_>>();
            let mut bin1_offsets = vec![0_u64; bin_count + 1];
            for &bin1 in &pixel_bin1 {
                bin1_offsets[bin1 as usize + 1] += 1;
            }
            for index in 1..bin1_offsets.len() {
                bin1_offsets[index] += bin1_offsets[index - 1];
            }
            file.new_dataset_builder()
                .with_data(&bin1_offsets)
                .create(format!("{prefix}/indexes/bin1_offset").as_str())
                .expect("write bin1 offsets");
            file.new_dataset_builder()
                .with_data(&pixel_bin1)
                .create(format!("{prefix}/pixels/bin1_id").as_str())
                .expect("write bin1 ids");
            file.new_dataset_builder()
                .with_data(&pixel_bin2)
                .create(format!("{prefix}/pixels/bin2_id").as_str())
                .expect("write bin2 ids");
            file.new_dataset_builder()
                .with_data(&pixel_counts)
                .create(format!("{prefix}/pixels/count").as_str())
                .expect("write counts");
        }

        fn path(&self) -> &str {
            self.path.to_str().expect("UTF-8 adaptive path")
        }
    }

    impl Drop for TestAdaptiveMcool {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    #[test]
    fn reads_contacts_from_example_1k_cool_file() {
        let contacts = read_cool_contacts_for_sources(
            "../../examples/input.1k.cool",
            &["utg000001l".to_string()],
        )
        .expect("example .cool should read");

        assert!(!contacts.is_empty());
    }

    #[test]
    fn reports_the_native_resolution_for_single_resolution_cool() {
        let file = TestCoolFile::without_weights();

        assert_eq!(
            list_contact_resolutions(file.path()).expect("read .cool resolution"),
            vec![1_000],
        );
    }

    #[test]
    fn lists_cooler_source_names_and_lengths() {
        let file = TestCoolFile::with_two_chromosomes_and_strong_inter_contacts();

        assert_eq!(
            list_contact_sources(file.path()).expect("read .cool sources"),
            vec![
                CoolSourceMetadata {
                    name: "chr1".to_string(),
                    length: 2_000,
                },
                CoolSourceMetadata {
                    name: "chr2".to_string(),
                    length: 2_000,
                },
            ],
        );
    }

    #[test]
    fn chunk_visitor_matches_owned_contact_reader_without_source_name_allocation_contract() {
        let file = TestCoolFile::without_weights();
        let ranges = vec![("chr1".to_string(), 0, 2_000)];
        let expected =
            read_cool_contacts_for_source_ranges_at_resolution(file.path(), &ranges, None)
                .expect("owned reader should work");
        let mut observed = Vec::new();
        let mut finished_chunks = 0;
        let visited = visit_cool_contact_chunks_for_source_ranges_at_resolution_with_normalization_cancellable(
            file.path(),
            &ranges,
            None,
            ContactNormalization::Raw,
            &|| false,
            |source1, start1, source2, start2, count| {
                observed.push((source1.to_string(), start1, source2.to_string(), start2, count));
                Ok(())
            },
            || {
                finished_chunks += 1;
                Ok(())
            },
        )
        .expect("chunk visitor should work");

        let expected_tuples = expected
            .iter()
            .map(|contact| {
                (
                    contact.source1.clone(),
                    contact.start1,
                    contact.source2.clone(),
                    contact.start2,
                    contact.count,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(observed, expected_tuples);
        assert_eq!(visited, expected.len());
        assert_eq!(finished_chunks, 1);

        let mut indexed = Vec::new();
        let indexed_visited = visit_cool_contact_chunks_indexed_for_source_ranges_at_resolution_with_normalization_cancellable(
            file.path(),
            &ranges,
            None,
            ContactNormalization::Raw,
            &|| false,
            |source1_index, source1, start1, source2_index, source2, start2, count| {
                indexed.push((
                    source1_index,
                    source1.to_string(),
                    start1,
                    source2_index,
                    source2.to_string(),
                    start2,
                    count,
                ));
                Ok(())
            },
            || Ok(()),
        )
        .expect("indexed chunk visitor should work");
        assert_eq!(indexed_visited, expected.len());
        assert!(indexed
            .iter()
            .all(|contact| contact.0 == 0 && contact.3 == 0));
        assert_eq!(
            indexed
                .into_iter()
                .map(|(_, source1, start1, _, source2, start2, count)| {
                    (source1, start1, source2, start2, count)
                })
                .collect::<Vec<_>>(),
            expected_tuples,
        );

        let mut profiled_control = Vec::new();
        let mut control_timings = CoolContactVisitTimings::default();
        let profiled_control_visited = visit_cool_contact_chunks_profiled_for_source_ranges_at_resolution_with_normalization_cancellable(
            file.path(),
            &ranges,
            None,
            ContactNormalization::Raw,
            &|| false,
            &mut control_timings,
            |source1, start1, source2, start2, count| {
                profiled_control.push((
                    source1.to_string(),
                    start1,
                    source2.to_string(),
                    start2,
                    count,
                ));
                Ok(())
            },
            || Ok(()),
        )
        .expect("profiled string visitor should work");
        assert_eq!(profiled_control_visited, expected.len());
        assert_eq!(profiled_control, expected_tuples);
        assert_eq!(control_timings.hdf5_chunks, 0);
        assert!(control_timings.scanned_pixels >= expected.len());

        let mut profiled_indexed = Vec::new();
        let mut indexed_timings = CoolContactVisitTimings::default();
        let profiled_indexed_visited = visit_cool_contact_chunks_indexed_profiled_for_source_ranges_at_resolution_with_normalization_cancellable(
            file.path(),
            &ranges,
            None,
            ContactNormalization::Raw,
            &|| false,
            &mut indexed_timings,
            |source1_index, source1, start1, source2_index, source2, start2, count| {
                profiled_indexed.push((
                    source1_index,
                    source1.to_string(),
                    start1,
                    source2_index,
                    source2.to_string(),
                    start2,
                    count,
                ));
                Ok(())
            },
            || Ok(()),
        )
        .expect("profiled indexed visitor should work");
        assert_eq!(profiled_indexed_visited, expected.len());
        assert_eq!(indexed_timings.hdf5_chunks, 0);
        assert_eq!(
            indexed_timings.scanned_pixels,
            control_timings.scanned_pixels
        );
        assert_eq!(
            profiled_indexed
                .into_iter()
                .map(|(_, source1, start1, _, source2, start2, count)| {
                    (source1, start1, source2, start2, count)
                })
                .collect::<Vec<_>>(),
            expected_tuples,
        );
    }

    #[test]
    fn derives_bin1_from_offsets_across_empty_rows() {
        let offsets = [0, 0, 2, 2, 5];

        assert_eq!(bin1_for_pixel_offset(&offsets, 0).unwrap(), 1);
        assert_eq!(bin1_for_pixel_offset(&offsets, 1).unwrap(), 1);
        assert_eq!(bin1_for_pixel_offset(&offsets, 2).unwrap(), 3);
        assert_eq!(bin1_for_pixel_offset(&offsets, 4).unwrap(), 3);
        assert!(bin1_for_pixel_offset(&offsets, 5).is_err());
    }

    #[test]
    fn reports_all_stored_mcool_resolutions_coarsest_first() {
        let file = TestAdaptiveMcool::create();

        assert_eq!(
            list_contact_resolutions(file.path()).expect("read .mcool resolutions"),
            vec![2_500_000, 500_000, 100_000, 10_000, 1_000],
        );
    }

    #[test]
    fn reads_contacts_from_source_ranges_only() {
        let contacts = read_cool_contacts_for_source_ranges_at_resolution(
            "../../examples/input.1k.cool",
            &[("utg000001l".to_string(), 0, 100_000)],
            None,
        )
        .expect("example .cool range should read");

        assert!(!contacts.is_empty());
        assert!(contacts
            .iter()
            .all(|contact| contact.start1 < 100_000 && contact.start2 < 100_000));
    }

    #[test]
    fn reuses_open_cool_reader_and_dataset_handles() {
        let file = TestCoolFile::without_weights();
        let first = cached_cool_reader(file.path(), None, &|| false)
            .expect("open the first persistent reader");
        let second =
            cached_cool_reader(file.path(), None, &|| false).expect("reuse the persistent reader");

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.index.bin_starts, vec![0, 1_000]);
    }

    #[test]
    fn batches_only_nearby_pixel_ranges() {
        assert_eq!(
            batch_nearby_pixel_ranges(&[(10, 20), (20, 25), (30, 40), (100, 110)], 5),
            vec![(10, 40), (100, 110)],
        );
        assert_eq!(
            batch_nearby_pixel_ranges(&[(0, 1), (17, 18)], 15),
            vec![(0, 1), (17, 18)],
        );
        assert_eq!(
            batch_nearby_pixel_ranges(&[(4, 4), (5, 9)], 16),
            vec![(5, 9)],
        );
    }

    #[test]
    fn reads_fixed_ascii_source_names_without_truncating_them() {
        let id = NEXT_TEST_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "cstudio-long-source-names-{}-{id}.h5",
            std::process::id(),
        ));
        let file = File::create(&path).expect("create long-name test file");
        let names = [
            FixedAscii::<32>::from_ascii("shared-prefix-source-A").expect("ASCII name"),
            FixedAscii::<32>::from_ascii("shared-prefix-source-B").expect("ASCII name"),
        ];
        file.new_dataset_builder()
            .with_data(&names)
            .create("names")
            .expect("write long names");

        let read = super::read_string_dataset(&file, "names").expect("read full names");
        drop(file);
        let _ = std::fs::remove_file(path);

        assert_eq!(
            read,
            vec![
                "shared-prefix-source-A".to_string(),
                "shared-prefix-source-B".to_string(),
            ]
        );
    }

    #[test]
    fn adaptive_mcool_refines_agp_boundaries_to_the_exact_base_result_and_reuses_children() {
        let file = TestAdaptiveMcool::create();
        let ranges = [("chr1".to_string(), 0, 3_000_000)];
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 2_500_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 5_000_000,
                y_start: 0,
                y_end: 5_000_000,
            },
            layout_blocks: vec![LayoutBlock {
                id: "shifted".to_string(),
                source_id: "chr1".to_string(),
                source_start: 0,
                source_end: 3_000_000,
                visual_start: 1_250_000,
                orientation: Orientation::Forward,
            }],
        };
        let base_contacts =
            read_cool_contacts_for_source_ranges_at_resolution(file.path(), &ranges, Some(1_000))
                .expect("read exact base contacts");
        let baseline = build_contact_map_view_from_contacts(&query, base_contacts)
            .expect("build exact baseline");

        let first = super::build_contact_map_view_from_mcool_adaptive_raw_cancellable(
            file.path(),
            &ranges,
            &query,
            &|| false,
        )
        .expect("adaptive read")
        .expect("adaptive chain should be supported");
        let second = super::build_contact_map_view_from_mcool_adaptive_raw_cancellable(
            file.path(),
            &ranges,
            &query,
            &|| false,
        )
        .expect("cached adaptive read")
        .expect("adaptive chain should remain supported");

        assert_eq!(first.view, baseline);
        assert_eq!(second.view, baseline);
        assert!(first.stats.child_blocks_requested > 0);
        assert_eq!(first.stats.child_blocks_cached, 0);
        assert!(second.stats.child_blocks_cached > 0);
        assert_eq!(second.stats.child_rows_read, 0);
        assert_eq!(second.stats.bin2_ids_scanned, 0);
    }

    #[test]
    fn adaptive_mcool_declines_unsupported_target_resolution() {
        let file = TestAdaptiveMcool::create();
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 500_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 1_000_000,
                y_start: 0,
                y_end: 1_000_000,
            },
            layout_blocks: Vec::new(),
        };
        assert!(
            super::build_contact_map_view_from_mcool_adaptive_raw_cancellable(
                file.path(),
                &[("chr1".to_string(), 0, 1_000_000)],
                &query,
                &|| false,
            )
            .expect("unsupported target should not error")
            .is_none()
        );
    }

    #[test]
    fn adaptive_mcool_observes_cancellation_before_contact_io() {
        let file = TestAdaptiveMcool::create();
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 2_500_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 2_500_000,
                y_start: 0,
                y_end: 2_500_000,
            },
            layout_blocks: Vec::new(),
        };
        let error = super::build_contact_map_view_from_mcool_adaptive_raw_cancellable(
            file.path(),
            &[("chr1".to_string(), 0, 1_000_000)],
            &query,
            &|| true,
        )
        .expect_err("cancelled adaptive request should stop before contact reads");

        assert_eq!(error, CStudioError::RequestCancelled);
    }

    #[test]
    fn reads_valid_chrom_offsets_and_falls_back_when_the_dataset_is_missing() {
        let indexed = TestCoolFile::with_chrom_offsets(&[0, 2]);
        let fallback = TestCoolFile::without_weights();

        for file in [&indexed, &fallback] {
            let contacts = read_cool_contacts_for_sources(file.path(), &["chr1".to_string()])
                .expect("valid or derived chromosome offsets");
            assert_eq!(contacts.len(), 3);
        }
    }

    #[test]
    fn rejects_malformed_stored_chrom_offsets() {
        let file = TestCoolFile::with_chrom_offsets(&[0, 1]);
        let error = read_cool_contacts_for_sources(file.path(), &["chr1".to_string()])
            .expect_err("stored chromosome offsets must cover every bin");

        assert!(error.to_string().contains("indexes/chrom_offset"));
        assert!(error.to_string().contains("bin count 2"));
    }

    #[test]
    fn validates_and_derives_chrom_offsets() {
        let bin_chrom_ids = [0, 0, 2];
        assert_eq!(
            resolve_chrom_offsets(3, &bin_chrom_ids, Some(&[0, 2, 2, 3]), &|| false)
                .expect("valid stored offsets"),
            vec![0, 2, 2, 3],
        );
        assert_eq!(
            resolve_chrom_offsets(3, &bin_chrom_ids, None, &|| false).expect("derived offsets"),
            vec![0, 2, 2, 3],
        );

        for malformed in [
            &[0, 3][..],
            &[1, 2, 3][..],
            &[0, 2, 2][..],
            &[0, 4, 3][..],
            &[0, 1, 3][..],
        ] {
            let error = resolve_chrom_offsets(2, &[0, 0, 1], Some(malformed), &|| false)
                .expect_err("malformed stored offsets");
            assert!(error.to_string().contains("indexes/chrom_offset"));
        }
    }

    #[test]
    fn selects_half_open_boundaries_across_duplicate_chrom_names() {
        let index = CoolIndex {
            prefix: String::new(),
            chrom_names: vec!["duplicate".to_string(), "duplicate".to_string()],
            chrom_lengths: vec![200, 200],
            bin_chrom_ids: vec![0, 0, 1, 1],
            chrom_offsets: vec![0, 2, 4],
            bin_starts: vec![0, 100, 0, 100],
            bin1_offsets: vec![0; 5],
            bytes: 0,
        };
        let first = SourceRangeIndex::new(&[("duplicate".to_string(), 0, 100)]);
        let first =
            SelectedBinIndex::new(&index, &first, &|| false).expect("select duplicate chromosomes");
        assert_eq!(first.ranges(), &[(0, 1), (2, 3)]);
        assert!(first.contains(0));
        assert!(!first.contains(1));
        assert!(first.contains(2));
        assert!(!first.contains(3));

        let second = SourceRangeIndex::new(&[("duplicate".to_string(), 100, 101)]);
        let second =
            SelectedBinIndex::new(&index, &second, &|| false).expect("include the lower boundary");
        assert_eq!(second.ranges(), &[(1, 2), (3, 4)]);
    }

    #[test]
    fn applies_stored_multiplicative_and_divisive_normalization_vectors() {
        let file = TestCoolFile::with_weights(&[2.0, 3.0], &[2.0, 3.0]);
        let source_ids = ["chr1".to_string()];
        let counts_for = |normalization| {
            read_cool_contacts_for_sources_at_resolution_with_normalization(
                file.path(),
                &source_ids,
                None,
                normalization,
            )
            .expect("normalized contacts")
            .into_iter()
            .map(|contact| contact.count)
            .collect::<Vec<_>>()
        };

        assert_eq!(counts_for(ContactNormalization::Raw), vec![12.0, 6.0, 3.0]);
        assert_eq!(
            counts_for(ContactNormalization::Ice),
            vec![48.0, 36.0, 27.0]
        );
        for normalization in [
            ContactNormalization::Kr,
            ContactNormalization::Vc,
            ContactNormalization::VcSqrt,
        ] {
            let counts = counts_for(normalization);
            assert_eq!(counts[0], 3.0);
            assert_eq!(counts[1], 1.0);
            assert!((counts[2] - (1.0 / 3.0)).abs() < 1e-12);
        }
    }

    #[test]
    fn computes_a_runtime_vector_when_the_requested_column_is_missing() {
        let file = TestCoolFile::without_weights();
        let contacts = read_cool_contacts_for_sources_at_resolution_with_normalization(
            file.path(),
            &["chr1".to_string()],
            None,
            ContactNormalization::Vc,
        )
        .expect("runtime VC normalization");
        let counts = contacts
            .into_iter()
            .map(|contact| contact.count)
            .collect::<Vec<_>>();

        assert_eq!(counts, vec![6.75, 6.75, 6.75]);
    }

    #[test]
    fn runtime_coverage_normalizations_use_each_chromosome_cis_matrix() {
        let reference = TestCoolFile::without_weights();
        let multi = TestCoolFile::with_two_chromosomes_and_strong_inter_contacts();

        for normalization in [ContactNormalization::Vc, ContactNormalization::VcSqrt] {
            let counts_for = |file: &TestCoolFile| {
                read_cool_contacts_for_sources_at_resolution_with_normalization(
                    file.path(),
                    &["chr1".to_string()],
                    None,
                    normalization,
                )
                .expect("runtime chromosome normalization")
                .into_iter()
                .map(|contact| contact.count)
                .collect::<Vec<_>>()
            };
            let expected = counts_for(&reference);
            let observed = counts_for(&multi);
            assert_eq!(observed.len(), expected.len());
            for (observed, expected) in observed.into_iter().zip(expected) {
                let tolerance = 1e-10 * expected.abs().max(1.0);
                assert!(
                    (observed - expected).abs() <= tolerance,
                    "{normalization:?}: observed {observed}, expected {expected}",
                );
            }
        }
    }

    #[test]
    fn runtime_kr_uses_the_whole_assembly_matrix() {
        let reference = TestCoolFile::without_weights();
        let multi = TestCoolFile::with_two_chromosomes_and_strong_inter_contacts();
        let counts_for = |file: &TestCoolFile| {
            read_cool_contacts_for_sources_at_resolution_with_normalization(
                file.path(),
                &["chr1".to_string()],
                None,
                ContactNormalization::Kr,
            )
            .expect("whole-assembly KR normalization")
            .into_iter()
            .map(|contact| contact.count)
            .collect::<Vec<_>>()
        };

        let cis_only = counts_for(&reference);
        let with_inter_contacts = counts_for(&multi);
        assert_eq!(with_inter_contacts.len(), cis_only.len());
        assert!(with_inter_contacts
            .iter()
            .zip(cis_only)
            .any(|(whole_assembly, cis)| (whole_assembly - cis).abs() > 1e-6));
    }

    #[test]
    fn normalization_cache_singleflights_matching_misses() {
        const THREAD_COUNT: usize = 8;
        let key = test_normalization_cache_key();
        let start = Arc::new(Barrier::new(THREAD_COUNT));
        let compute_count = Arc::new(AtomicUsize::new(0));
        let handles = (0..THREAD_COUNT)
            .map(|_| {
                let key = key.clone();
                let start = Arc::clone(&start);
                let compute_count = Arc::clone(&compute_count);
                thread::spawn(move || {
                    start.wait();
                    cached_normalization_vector(key, &|| false, || -> CStudioResult<Vec<f64>> {
                        compute_count.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(100));
                        Ok(vec![1.0, 2.0])
                    })
                    .expect("singleflight result")
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("normalization worker"))
            .collect::<Vec<_>>();

        assert_eq!(compute_count.load(Ordering::SeqCst), 1);
        assert!(results
            .iter()
            .skip(1)
            .all(|result| Arc::ptr_eq(&results[0], result)));
    }

    #[test]
    fn normalization_cache_does_not_retain_failures() {
        let key = test_normalization_cache_key();
        let first =
            cached_normalization_vector(key.clone(), &|| false, || -> CStudioResult<Vec<f64>> {
                Err(CStudioError::InvalidContactMapQuery(
                    "synthetic normalization failure".to_string(),
                ))
            });
        assert!(matches!(
            first,
            Err(CStudioError::InvalidContactMapQuery(_))
        ));

        let second = cached_normalization_vector(key.clone(), &|| false, || Ok(vec![3.0, 4.0]))
            .expect("a failed flight must be retried");
        let cached = cached_normalization_vector(key, &|| false, || {
            panic!("successful retry should enter the LRU cache")
        })
        .expect("cached retry result");

        assert_eq!(second.as_slice(), &[3.0, 4.0]);
        assert!(Arc::ptr_eq(&second, &cached));
    }

    #[test]
    fn persistent_kr_vector_round_trips_and_rejects_corruption() {
        let file = TestCoolFile::without_weights();
        let cache_root = std::env::temp_dir().join(format!(
            "cstudio-normalization-cache-test-{}-{}",
            std::process::id(),
            NEXT_TEST_FILE_ID.fetch_add(1, Ordering::Relaxed),
        ));
        let cache_path =
            super::persistent_normalization_cache_path(file.path(), None, ContactNormalization::Kr);
        if cache_path.is_none() {
            super::configure_persistent_normalization_cache(cache_root.clone());
        }
        let cache_path =
            super::persistent_normalization_cache_path(file.path(), None, ContactNormalization::Kr)
                .expect("persistent normalization path");
        let weights = vec![1.0, f64::NAN];
        super::store_persistent_normalization_vector(
            file.path(),
            None,
            ContactNormalization::Kr,
            &weights,
        );
        let loaded = super::load_persistent_normalization_vector(
            file.path(),
            None,
            ContactNormalization::Kr,
            weights.len(),
        )
        .expect("persisted KR vector");
        assert_eq!(loaded[0].to_bits(), weights[0].to_bits());
        assert_eq!(loaded[1].to_bits(), weights[1].to_bits());

        fs::write(&cache_path, b"broken").expect("corrupt persistent vector");
        assert!(super::load_persistent_normalization_vector(
            file.path(),
            None,
            ContactNormalization::Kr,
            weights.len(),
        )
        .is_none());
        assert!(!cache_path.exists());
        let _ = fs::remove_dir_all(cache_root);
    }

    #[test]
    fn normalization_singleflight_waiter_can_cancel_independently() {
        let key = test_normalization_cache_key();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (leader_started_tx, leader_started_rx) = mpsc::channel();
        let leader_gate = Arc::clone(&gate);
        let leader_key = key.clone();
        let leader = thread::spawn(move || {
            cached_normalization_vector(leader_key, &|| false, || -> CStudioResult<Vec<f64>> {
                leader_started_tx.send(()).expect("signal leader start");
                let (released, ready) = &*leader_gate;
                let mut released = released
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                while !*released {
                    released = ready
                        .wait(released)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
                Ok(vec![5.0, 6.0])
            })
        });
        leader_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("leader should register the flight");

        let cancelled = Arc::new(AtomicBool::new(false));
        let waiter_cancelled = Arc::clone(&cancelled);
        let (waiter_ready_tx, waiter_ready_rx) = mpsc::channel();
        let (waiter_result_tx, waiter_result_rx) = mpsc::channel();
        let waiter = thread::spawn(move || {
            waiter_ready_tx.send(()).expect("signal waiter start");
            let result = cached_normalization_vector(
                key,
                &|| waiter_cancelled.load(Ordering::SeqCst),
                || panic!("waiter must not compute an existing flight"),
            );
            waiter_result_tx.send(result).expect("send waiter result");
        });
        waiter_ready_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("waiter should start");
        thread::sleep(Duration::from_millis(50));
        cancelled.store(true, Ordering::SeqCst);
        let waiter_result = waiter_result_rx.recv_timeout(Duration::from_secs(1));

        let (released, ready) = &*gate;
        *released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        ready.notify_all();
        let leader_result = leader.join().expect("leader thread");
        waiter.join().expect("waiter thread");

        assert_eq!(
            waiter_result.expect("waiter should observe cancellation"),
            Err(CStudioError::RequestCancelled),
        );
        assert_eq!(
            leader_result.expect("leader result").as_slice(),
            &[5.0, 6.0]
        );
    }

    #[test]
    fn foreground_normalization_retries_after_idle_leader_yields() {
        let file = TestCoolFile::with_weights(&[2.0, 4.0], &[2.0, 4.0]);
        let key = CoolNormalizationCacheKey {
            file: cool_index_cache_key(file.path(), None),
            normalization: ContactNormalization::Kr,
        };
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let leader_gate = Arc::clone(&gate);
        let (leader_started_tx, leader_started_rx) = mpsc::channel();
        let leader = thread::spawn(move || {
            cached_normalization_vector(key, &|| false, || -> CStudioResult<Vec<f64>> {
                leader_started_tx.send(()).expect("signal idle leader");
                let (released, ready) = &*leader_gate;
                let mut released = released
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                while !*released {
                    released = ready
                        .wait(released)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
                Err(CStudioError::RequestCancelled)
            })
        });
        leader_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("idle leader should own the flight");

        let path = file.path().to_string();
        let foreground = thread::spawn(move || {
            read_cool_contacts_for_sources_at_resolution_with_normalization(
                &path,
                &["chr1".to_string()],
                None,
                ContactNormalization::Kr,
            )
        });
        thread::sleep(Duration::from_millis(50));
        let (released, ready) = &*gate;
        *released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        ready.notify_all();

        assert_eq!(
            leader.join().expect("idle leader thread"),
            Err(CStudioError::RequestCancelled),
        );
        let contacts = foreground
            .join()
            .expect("foreground thread")
            .expect("foreground should replace the cancelled idle flight");
        assert!(!contacts.is_empty());
    }

    #[test]
    fn masks_pixels_whose_normalization_weight_is_invalid() {
        let file = TestCoolFile::with_weights(&[2.0, f64::NAN], &[2.0, 0.0]);
        let source_ids = ["chr1".to_string()];

        for normalization in [ContactNormalization::Ice, ContactNormalization::Kr] {
            let contacts = read_cool_contacts_for_sources_at_resolution_with_normalization(
                file.path(),
                &source_ids,
                None,
                normalization,
            )
            .expect("invalid weights should mask pixels");
            assert_eq!(contacts.len(), 1);
            assert_eq!(contacts[0].start1, 0);
            assert_eq!(contacts[0].start2, 0);
        }
    }

    #[test]
    fn normalized_count_uses_the_same_bin_weight_twice_on_the_diagonal() {
        assert_eq!(
            normalized_contact_count(12.0, 0, 0, Some(&[2.0])),
            Some(48.0),
        );
        assert_eq!(
            normalized_contact_count(12.0, 0, 0, Some(&[f64::NAN])),
            None
        );
    }

    #[test]
    fn cancellation_stops_before_opening_a_cool_file() {
        let error = read_cool_contacts_for_source_ranges_at_resolution_cancellable(
            "/path/that/does/not/exist.cool",
            &[],
            None,
            &|| true,
        )
        .expect_err("cancelled read should stop before IO");

        assert_eq!(error, crate::CStudioError::RequestCancelled);
    }

    #[test]
    fn merges_adjacent_pixel_ranges_for_selected_bins() {
        let ranges =
            pixel_ranges_for_selected_bin_ranges(&[(1, 3), (4, 5)], &[0, 5, 8, 12, 20, 25])
                .expect("valid bin offsets");

        assert_eq!(ranges, vec![(5, 12), (20, 25)]);
    }

    #[test]
    fn resident_bin2_index_prunes_distant_unselected_pixel_runs() {
        let mut resident_bin2 = vec![0_u32; 700];
        resident_bin2[10..20].fill(1);
        resident_bin2[200..210].fill(3);
        resident_bin2[500..510].fill(1);
        let selected_bins = SelectedBinIndex {
            ranges: vec![(1, 2), (3, 4)],
            membership: SelectedBinMembership::Partial {
                bin_count: 4,
                words: vec![(1_u64 << 1) | (1_u64 << 3)],
            },
        };

        let ranges = selected_pixel_ranges_from_resident_bin2(
            &[(0, resident_bin2.len())],
            &resident_bin2,
            &selected_bins,
            &|| false,
        )
        .expect("resident bin2 ranges");

        // The first two selected runs are deliberately close enough to batch
        // into one HDF5 count read; the distant third run stays independent.
        assert_eq!(ranges, vec![(10, 210), (500, 510)]);
    }

    #[test]
    fn validates_bin1_offsets_before_merging_selected_bin_ranges() {
        validate_bin1_offsets(&[0, 3, 3, 8], 3, &|| false).expect("valid bin offsets");

        for malformed in [&[0, 3, 8][..], &[0, 5, 4, 8][..]] {
            let error = validate_bin1_offsets(malformed, 3, &|| false)
                .expect_err("malformed bin offsets must be rejected");
            assert!(error.to_string().contains("indexes/bin1_offset"));
        }
    }
}
