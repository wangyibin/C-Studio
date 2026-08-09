use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    sync::{Arc, Mutex, OnceLock},
    time::UNIX_EPOCH,
};

use hdf5::{
    types::{FixedAscii, VarLenUnicode},
    File,
};

use crate::{contact_map::ContactBin, CStudioError, CStudioResult};

const MAX_COOL_INDEX_CACHE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
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

static COOL_INDEX_CACHE: OnceLock<Mutex<CoolIndexCache>> = OnceLock::new();

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

pub fn read_cool_contacts_for_source_ranges_at_resolution(
    path: &str,
    source_ranges: &[(String, u64, u64)],
    resolution: Option<u64>,
) -> CStudioResult<Vec<ContactBin>> {
    let file = File::open(path).map_err(cool_error)?;
    let index = cached_cool_index(&file, path, resolution)?;
    let prefix = &index.prefix;
    let source_range_index = SourceRangeIndex::new(source_ranges);

    let mut bin_to_source = Vec::with_capacity(index.bin_chrom_ids.len());
    let mut selected_bins = HashSet::new();
    for (bin_id, (chrom_id, start)) in index
        .bin_chrom_ids
        .iter()
        .zip(index.bin_starts.iter())
        .enumerate()
    {
        let chrom_index: usize = (*chrom_id).try_into().map_err(|_| {
            CStudioError::InvalidContactMapQuery(format!(
                ".cool bin {bin_id} has negative chrom id {chrom_id}"
            ))
        })?;
        let source_id = index
            .chrom_names
            .get(chrom_index)
            .ok_or_else(|| {
                CStudioError::InvalidContactMapQuery(format!(
                    ".cool bin {bin_id} references missing chrom id {chrom_id}"
                ))
            })?
            ;

        if source_range_index.contains(source_id, *start) {
            selected_bins.insert(bin_id as u64);
        }

        bin_to_source.push((chrom_index, *start));
    }

    let mut contacts = Vec::new();
    let pixel_ranges = pixel_ranges_for_selected_bins(
        &selected_bins,
        &index.bin1_offsets,
    )?;

    for (pixel_start, pixel_end) in pixel_ranges {
        let pixel_bin1 = read_u64_dataset_slice(
            &file,
            &format!("{prefix}pixels/bin1_id"),
            pixel_start,
            pixel_end,
        )?;
        let pixel_bin2 = read_u64_dataset_slice(
            &file,
            &format!("{prefix}pixels/bin2_id"),
            pixel_start,
            pixel_end,
        )?;
        let pixel_counts = read_f64_dataset_slice(
            &file,
            &format!("{prefix}pixels/count"),
            pixel_start,
            pixel_end,
        )?;
        if pixel_bin1.len() != pixel_bin2.len() || pixel_bin1.len() != pixel_counts.len() {
            return Err(CStudioError::InvalidContactMapQuery(
                ".cool pixels/bin1_id, bin2_id, and count have different lengths".to_string(),
            ));
        }

        for ((bin1, bin2), count) in pixel_bin1
            .into_iter()
            .zip(pixel_bin2.into_iter())
            .zip(pixel_counts.into_iter())
        {
            if !selected_bins.contains(&bin1) || !selected_bins.contains(&bin2) {
                continue;
            }

            let (source1_index, start1) = bin_to_source
                .get(bin1 as usize)
                .ok_or_else(|| {
                    CStudioError::InvalidContactMapQuery(format!(
                        ".cool pixel references missing bin1_id {bin1}"
                    ))
                })?;
            let (source2_index, start2) = bin_to_source
                .get(bin2 as usize)
                .ok_or_else(|| {
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

fn cached_cool_index(file: &File, path: &str, resolution: Option<u64>) -> CStudioResult<Arc<CoolIndex>> {
    let metadata = fs::metadata(path).ok();
    let key = CoolIndexCacheKey {
        path: path.to_string(),
        resolution,
        size_bytes: metadata.as_ref().map_or(0, fs::Metadata::len),
        modified_nanos: metadata
            .and_then(|value| value.modified().ok())
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |value| value.as_nanos()),
    };
    let cache = COOL_INDEX_CACHE.get_or_init(|| Mutex::new(CoolIndexCache::default()));
    if let Ok(mut cache) = cache.lock() {
        if let Some(position) = cache.entries.iter().position(|(entry_key, _)| *entry_key == key) {
            let entry = cache.entries.remove(position).expect("cached index position exists");
            let result = Arc::clone(&entry.1);
            cache.entries.push_back(entry);
            return Ok(result);
        }
    }

    let prefix = cool_dataset_prefix(file, resolution)?;
    let chrom_names = read_string_dataset(file, &format!("{prefix}chroms/name"))?;
    let bin_chrom_ids = read_i32_dataset(file, &format!("{prefix}bins/chrom"))?;
    let bin_starts = read_u64_dataset(file, &format!("{prefix}bins/start"))?;
    if bin_chrom_ids.len() != bin_starts.len() {
        return Err(CStudioError::InvalidContactMapQuery(
            ".cool bins/chrom and bins/start have different lengths".to_string(),
        ));
    }
    let bin1_offsets = read_u64_dataset(file, &format!("{prefix}indexes/bin1_offset"))?;
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

fn pixel_ranges_for_selected_bins(
    selected_bins: &HashSet<u64>,
    bin1_offsets: &[u64],
) -> CStudioResult<Vec<(usize, usize)>> {
    let mut selected_bins = selected_bins.iter().copied().collect::<Vec<_>>();
    selected_bins.sort_unstable();

    let mut ranges = Vec::new();
    for bin_id in selected_bins {
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
        file.group(prefix.trim_end_matches('/')).map_err(cool_error)?;
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
    use std::collections::HashSet;

    use super::{read_cool_contacts_for_source_ranges_at_resolution, read_cool_contacts_for_sources};

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
    fn merges_adjacent_pixel_ranges_for_selected_bins() {
        let selected_bins = HashSet::from([1, 2, 4]);
        let ranges = super::pixel_ranges_for_selected_bins(
            &selected_bins,
            &[0, 5, 8, 12, 20, 25],
        )
        .expect("valid bin offsets");

        assert_eq!(ranges, vec![(5, 12), (20, 25)]);
    }
}
