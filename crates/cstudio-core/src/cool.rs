use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::{Duration, UNIX_EPOCH},
};

use hdf5::{
    types::{FixedAscii, VarLenUnicode},
    File,
};

use crate::{
    contact_map::ContactBin,
    contact_normalization::{
        compute_normalization_weights, ContactNormalization, SparseContactMatrix,
    },
    CStudioError, CStudioResult,
};

const MAX_COOL_INDEX_CACHE_BYTES: usize = 128 * 1024 * 1024;
const MAX_COOL_NORMALIZATION_CACHE_BYTES: usize = 128 * 1024 * 1024;
const MAX_RUNTIME_NORMALIZATION_MATRIX_BYTES: usize = 512 * 1024 * 1024;
// Each chunk holds bin1, bin2, and count arrays simultaneously. At the
// widest supported element types this caps their combined raw payload near
// 12 MiB, while keeping HDF5 call overhead low for ordinary tile requests.
const MAX_COOL_PIXEL_READ_CHUNK: usize = 500_000;

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
    bin_chrom_ids: Vec<i32>,
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

static COOL_INDEX_CACHE: OnceLock<Mutex<CoolIndexCache>> = OnceLock::new();
static COOL_NORMALIZATION_CACHE: OnceLock<Mutex<CoolNormalizationCache>> = OnceLock::new();

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
    ensure_not_cancelled(should_cancel)?;
    let file = File::open(path).map_err(cool_error)?;
    ensure_not_cancelled(should_cancel)?;
    let index = cached_cool_index(&file, path, resolution, should_cancel)?;
    let prefix = &index.prefix;
    let normalization_weights = cached_normalization_weights(
        &file,
        path,
        resolution,
        &index,
        normalization,
        should_cancel,
    )?;
    let source_range_index = SourceRangeIndex::new(source_ranges);

    let mut bin_to_source = Vec::with_capacity(index.bin_chrom_ids.len());
    let mut selected_bins = HashSet::new();
    for (bin_id, (chrom_id, start)) in index
        .bin_chrom_ids
        .iter()
        .zip(index.bin_starts.iter())
        .enumerate()
    {
        if bin_id % 4_096 == 0 {
            ensure_not_cancelled(should_cancel)?;
        }
        let chrom_index: usize = (*chrom_id).try_into().map_err(|_| {
            CStudioError::InvalidContactMapQuery(format!(
                ".cool bin {bin_id} has negative chrom id {chrom_id}"
            ))
        })?;
        let source_id = index.chrom_names.get(chrom_index).ok_or_else(|| {
            CStudioError::InvalidContactMapQuery(format!(
                ".cool bin {bin_id} references missing chrom id {chrom_id}"
            ))
        })?;

        if source_range_index.contains(source_id, *start) {
            selected_bins.insert(bin_id as u64);
        }

        bin_to_source.push((chrom_index, *start));
    }

    let mut contacts = Vec::new();
    ensure_not_cancelled(should_cancel)?;
    let pixel_ranges = pixel_ranges_for_selected_bins_cancellable(
        &selected_bins,
        &index.bin1_offsets,
        should_cancel,
    )?;
    let pixel_bin1_path = format!("{prefix}pixels/bin1_id");
    let pixel_bin2_path = format!("{prefix}pixels/bin2_id");
    let pixel_count_path = format!("{prefix}pixels/count");

    for (pixel_start, pixel_end) in pixel_ranges {
        for chunk_start in (pixel_start..pixel_end).step_by(MAX_COOL_PIXEL_READ_CHUNK) {
            ensure_not_cancelled(should_cancel)?;
            let chunk_end = chunk_start
                .saturating_add(MAX_COOL_PIXEL_READ_CHUNK)
                .min(pixel_end);
            let pixel_bin1 =
                read_u64_dataset_slice(&file, &pixel_bin1_path, chunk_start, chunk_end)?;
            ensure_not_cancelled(should_cancel)?;
            let pixel_bin2 =
                read_u64_dataset_slice(&file, &pixel_bin2_path, chunk_start, chunk_end)?;
            ensure_not_cancelled(should_cancel)?;
            let pixel_counts =
                read_f64_dataset_slice(&file, &pixel_count_path, chunk_start, chunk_end)?;
            if pixel_bin1.len() != pixel_bin2.len() || pixel_bin1.len() != pixel_counts.len() {
                return Err(CStudioError::InvalidContactMapQuery(
                    ".cool pixels/bin1_id, bin2_id, and count have different lengths".to_string(),
                ));
            }

            for (pixel_index, ((bin1, bin2), count)) in pixel_bin1
                .into_iter()
                .zip(pixel_bin2.into_iter())
                .zip(pixel_counts.into_iter())
                .enumerate()
            {
                if pixel_index % 16_384 == 0 {
                    ensure_not_cancelled(should_cancel)?;
                }
                if !selected_bins.contains(&bin1) || !selected_bins.contains(&bin2) {
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

                let (source1_index, start1) =
                    bin_to_source.get(bin1 as usize).ok_or_else(|| {
                        CStudioError::InvalidContactMapQuery(format!(
                            ".cool pixel references missing bin1_id {bin1}"
                        ))
                    })?;
                let (source2_index, start2) =
                    bin_to_source.get(bin2 as usize).ok_or_else(|| {
                        CStudioError::InvalidContactMapQuery(format!(
                            ".cool pixel references missing bin2_id {bin2}"
                        ))
                    })?;

                contacts.push(ContactBin {
                    source1: index.chrom_names[*source1_index].clone(),
                    start1: *start1,
                    source2: index.chrom_names[*source2_index].clone(),
                    start2: *start2,
                    count,
                });
            }
        }
    }

    ensure_not_cancelled(should_cancel)?;
    Ok(contacts)
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

    fn contains(&self, source: &str, position: u64) -> bool {
        if self.select_all {
            return true;
        }
        let Some(ranges) = self.by_source.get(source) else {
            return false;
        };
        let index = ranges.partition_point(|(_, end)| *end <= position);
        ranges
            .get(index)
            .is_some_and(|(start, end)| position >= *start && position < *end)
    }
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
    let bin1_offsets = read_u64_dataset(file, &format!("{prefix}indexes/bin1_offset"))?;
    ensure_not_cancelled(should_cancel)?;
    let bytes = chrom_names.iter().map(String::capacity).sum::<usize>()
        + bin_chrom_ids.capacity() * std::mem::size_of::<i32>()
        + bin_starts.capacity() * std::mem::size_of::<u64>()
        + bin1_offsets.capacity() * std::mem::size_of::<u64>();
    let index = Arc::new(CoolIndex {
        prefix,
        chrom_names,
        bin_chrom_ids,
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
    file: &File,
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
    cached_normalization_vector(key, should_cancel, || {
        // Preserve precomputed vectors exactly when present. Raw coolers without
        // them fall back to one global calculation for the resolved matrix level.
        let values = if let Some(values) = read_stored_normalization_weights(
            file,
            &index.prefix,
            index.bin_chrom_ids.len(),
            normalization,
            should_cancel,
        )? {
            values
        } else {
            let matrix = read_normalization_matrix(file, index, should_cancel)?;
            compute_normalization_weights(&matrix, normalization, should_cancel)?
        };
        ensure_not_cancelled(should_cancel)?;
        if values.len() != index.bin_chrom_ids.len() {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool {} normalization has {} weights for {} bins",
                normalization.as_str(),
                values.len(),
                index.bin_chrom_ids.len(),
            )));
        }
        Ok(values)
    })
    .map(Some)
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
    let estimated_bytes = pixel_count.saturating_mul(
        2 * std::mem::size_of::<u64>()
            + std::mem::size_of::<f64>()
            + 2 * std::mem::size_of::<u32>(),
    );
    if estimated_bytes > MAX_RUNTIME_NORMALIZATION_MATRIX_BYTES {
        return Err(CStudioError::InvalidContactMapQuery(format!(
            ".cool runtime normalization needs about {} MiB for {pixel_count} pixels; add a precomputed bins normalization vector",
            estimated_bytes / (1024 * 1024),
        )));
    }
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

    SparseContactMatrix::new(index.bin_chrom_ids.len(), bin1, bin2, counts)
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
fn pixel_ranges_for_selected_bins(
    selected_bins: &HashSet<u64>,
    bin1_offsets: &[u64],
) -> CStudioResult<Vec<(usize, usize)>> {
    pixel_ranges_for_selected_bins_cancellable(selected_bins, bin1_offsets, &|| false)
}

fn pixel_ranges_for_selected_bins_cancellable(
    selected_bins: &HashSet<u64>,
    bin1_offsets: &[u64],
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<(usize, usize)>> {
    ensure_not_cancelled(should_cancel)?;
    let mut selected_bins = selected_bins.iter().copied().collect::<Vec<_>>();
    selected_bins.sort_unstable();
    ensure_not_cancelled(should_cancel)?;

    let mut ranges = Vec::new();
    for (selected_index, bin_id) in selected_bins.into_iter().enumerate() {
        if selected_index % 4_096 == 0 {
            ensure_not_cancelled(should_cancel)?;
        }
        let bin_index = bin_id as usize;
        let Some(&start) = bin1_offsets.get(bin_index) else {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/bin1_offset missing start for bin {bin_id}"
            )));
        };
        let Some(&end) = bin1_offsets.get(bin_index + 1) else {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                ".cool indexes/bin1_offset missing end for bin {bin_id}"
            )));
        };
        if start == end {
            continue;
        }

        let start = start as usize;
        let end = end as usize;
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
    if let Ok(values) = file
        .dataset(path)
        .and_then(|dataset| dataset.read_1d::<FixedAscii<11>>())
    {
        return Ok(values
            .iter()
            .map(|value| String::from(value.clone()))
            .collect());
    }

    let values = file
        .dataset(path)
        .and_then(|dataset| dataset.read_1d::<VarLenUnicode>())
        .map_err(cool_error)?;
    Ok(values
        .iter()
        .map(|value| value.as_str().to_string())
        .collect())
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
        collections::HashSet,
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
        cached_normalization_vector, normalized_contact_count,
        read_cool_contacts_for_source_ranges_at_resolution,
        read_cool_contacts_for_source_ranges_at_resolution_cancellable,
        read_cool_contacts_for_sources,
        read_cool_contacts_for_sources_at_resolution_with_normalization, CoolIndexCacheKey,
        CoolNormalizationCacheKey,
    };
    use crate::{contact_normalization::ContactNormalization, CStudioError, CStudioResult};

    static NEXT_TEST_FILE_ID: AtomicU64 = AtomicU64::new(1);

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

        fn create(weight: Option<&[f64]>, divisive: Option<&[f64]>) -> Self {
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

        fn path(&self) -> &str {
            self.path.to_str().expect("UTF-8 test path")
        }
    }

    impl Drop for TestCoolFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    #[test]
    fn reads_contacts_from_example_1k_cool_file() {
        let contacts = read_cool_contacts_for_sources(
            "../../examples/input.q1.1k.cool",
            &["Chr2A.ctg30".to_string()],
        )
        .expect("example .cool should read");

        assert!(!contacts.is_empty());
    }

    #[test]
    fn reads_contacts_from_source_ranges_only() {
        let contacts = read_cool_contacts_for_source_ranges_at_resolution(
            "../../examples/input.q1.1k.cool",
            &[("Chr2A.ctg30".to_string(), 0, 100_000)],
            None,
        )
        .expect("example .cool range should read");

        assert!(!contacts.is_empty());
        assert!(contacts
            .iter()
            .all(|contact| contact.start1 < 100_000 && contact.start2 < 100_000));
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
    fn computes_a_global_vector_when_the_requested_column_is_missing() {
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
        let selected_bins = HashSet::from([1, 2, 4]);
        let ranges = super::pixel_ranges_for_selected_bins(&selected_bins, &[0, 5, 8, 12, 20, 25])
            .expect("valid bin offsets");

        assert_eq!(ranges, vec![(5, 12), (20, 25)]);
    }
}
