use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use crate::{
    contact_map::{
        build_contact_map_view_from_contacts_cancellable, ContactBin, ContactMapContact,
        ContactMapQuery, ContactMapView,
    },
    CStudioResult,
};

pub const DEFAULT_SOURCE_CONTACT_CACHE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SourceWindow {
    pub source_id: String,
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SourceContactCacheKey {
    pub path: String,
    pub resolution: u64,
    pub first: SourceWindow,
    pub second: SourceWindow,
}

#[derive(Debug, Clone, Copy)]
struct CachedSourceContact {
    first_start: u64,
    second_start: u64,
    count: f64,
}

#[derive(Debug)]
struct SourceContactCacheEntry {
    contacts: Arc<Vec<CachedSourceContact>>,
    bytes: usize,
    last_used: u64,
}

#[derive(Debug)]
pub struct PreparedSourceContactCacheEntries {
    entries: Vec<(SourceContactCacheKey, Vec<CachedSourceContact>)>,
}

#[derive(Debug, Clone)]
pub struct SourceContactCacheSnapshot {
    entries: Vec<(SourceContactCacheKey, Arc<Vec<CachedSourceContact>>)>,
}

#[derive(Debug)]
pub struct SourceContactCache {
    max_bytes: usize,
    used_bytes: usize,
    clock: u64,
    entries: HashMap<SourceContactCacheKey, SourceContactCacheEntry>,
}

impl Default for SourceContactCache {
    fn default() -> Self {
        Self::new(DEFAULT_SOURCE_CONTACT_CACHE_BYTES)
    }
}

impl SourceContactCache {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            used_bytes: 0,
            clock: 0,
            entries: HashMap::new(),
        }
    }

    pub fn keys_for_windows(
        path: &str,
        resolution: u64,
        windows: &[SourceWindow],
    ) -> Vec<SourceContactCacheKey> {
        let mut keys = Vec::new();
        for (first_index, first) in windows.iter().enumerate() {
            for second in &windows[first_index..] {
                keys.push(SourceContactCacheKey {
                    path: path.to_string(),
                    resolution,
                    first: first.clone(),
                    second: second.clone(),
                });
            }
        }
        keys
    }

    pub fn contains_all(&self, keys: &[SourceContactCacheKey]) -> bool {
        keys.iter().all(|key| self.entries.contains_key(key))
    }

    pub fn insert_contacts_for_windows(
        &mut self,
        path: &str,
        resolution: u64,
        windows: &[SourceWindow],
        contacts: &[ContactBin],
    ) {
        self.insert_contacts_for_windows_cancellable(path, resolution, windows, contacts, &|| {
            false
        })
        .expect("a non-cancellable source cache insertion cannot be cancelled");
    }

    pub fn insert_contacts_for_windows_cancellable(
        &mut self,
        path: &str,
        resolution: u64,
        windows: &[SourceWindow],
        contacts: &[ContactBin],
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<()> {
        let prepared = Self::prepare_contacts_for_windows_cancellable(
            path,
            resolution,
            windows,
            contacts,
            should_cancel,
        )?;
        self.insert_prepared_cancellable(prepared, should_cancel)
    }

    pub fn prepare_contacts_for_windows_cancellable(
        path: &str,
        resolution: u64,
        windows: &[SourceWindow],
        contacts: &[ContactBin],
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<PreparedSourceContactCacheEntries> {
        if should_cancel() {
            return Err(crate::CStudioError::RequestCancelled);
        }
        let keys = Self::keys_for_windows(path, resolution, windows);
        let window_index = SourceWindowIndex::new(windows);
        let mut contacts_by_key = (0..keys.len())
            .map(|_| Vec::new())
            .collect::<Vec<Vec<CachedSourceContact>>>();

        for (contact_index, contact) in contacts.iter().enumerate() {
            if contact_index % 4_096 == 0 && should_cancel() {
                return Err(crate::CStudioError::RequestCancelled);
            }
            let Some(first_index) = window_index.find(&contact.source1, contact.start1) else {
                continue;
            };
            let Some(second_index) = window_index.find(&contact.source2, contact.start2) else {
                continue;
            };
            let (first_index, second_index, first_start, second_start) =
                if first_index <= second_index {
                    (first_index, second_index, contact.start1, contact.start2)
                } else {
                    (second_index, first_index, contact.start2, contact.start1)
                };
            let entry_index = upper_triangle_index(windows.len(), first_index, second_index);
            if let Some(entry_contacts) = contacts_by_key.get_mut(entry_index) {
                entry_contacts.push(CachedSourceContact {
                    first_start,
                    second_start,
                    count: contact.count,
                });
            }
        }

        if should_cancel() {
            return Err(crate::CStudioError::RequestCancelled);
        }
        Ok(PreparedSourceContactCacheEntries {
            entries: keys.into_iter().zip(contacts_by_key).collect(),
        })
    }

    pub fn insert_prepared_cancellable(
        &mut self,
        prepared: PreparedSourceContactCacheEntries,
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<()> {
        for (entry_index, (key, entry_contacts)) in prepared.entries.into_iter().enumerate() {
            if entry_index % 128 == 0 && should_cancel() {
                return Err(crate::CStudioError::RequestCancelled);
            }
            self.insert_entry(key, entry_contacts);
        }
        Ok(())
    }

    pub fn build_cached_view(
        &mut self,
        keys: &[SourceContactCacheKey],
        query: &ContactMapQuery,
    ) -> CStudioResult<Option<ContactMapView>> {
        self.build_cached_view_cancellable(keys, query, &|| false)
    }

    pub fn build_cached_view_cancellable(
        &mut self,
        keys: &[SourceContactCacheKey],
        query: &ContactMapQuery,
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<Option<ContactMapView>> {
        let Some(snapshot) = self.snapshot_for_keys_cancellable(keys, should_cancel)? else {
            return Ok(None);
        };
        snapshot
            .build_view_cancellable(query, should_cancel)
            .map(Some)
    }

    pub fn snapshot_for_keys_cancellable(
        &mut self,
        keys: &[SourceContactCacheKey],
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<Option<SourceContactCacheSnapshot>> {
        if should_cancel() {
            return Err(crate::CStudioError::RequestCancelled);
        }
        if !self.contains_all(keys) {
            return Ok(None);
        }

        self.clock = self.clock.wrapping_add(1);
        let tick = self.clock;
        for key in keys {
            if let Some(entry) = self.entries.get_mut(key) {
                entry.last_used = tick;
            }
        }
        Ok(Some(SourceContactCacheSnapshot {
            entries: keys
                .iter()
                .map(|key| {
                    let entry = self
                        .entries
                        .get(key)
                        .expect("cache keys were checked above");
                    (key.clone(), Arc::clone(&entry.contacts))
                })
                .collect(),
        }))
    }

    pub fn used_bytes(&self) -> usize {
        self.used_bytes
    }

    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    fn insert_entry(&mut self, key: SourceContactCacheKey, contacts: Vec<CachedSourceContact>) {
        let bytes = estimated_entry_bytes(&key, contacts.capacity());
        if bytes > self.max_bytes {
            return;
        }

        if let Some(previous) = self.entries.remove(&key) {
            self.used_bytes = self.used_bytes.saturating_sub(previous.bytes);
        }
        while self.used_bytes.saturating_add(bytes) > self.max_bytes {
            let Some(lru_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(entry) = self.entries.remove(&lru_key) {
                self.used_bytes = self.used_bytes.saturating_sub(entry.bytes);
            }
        }

        self.clock = self.clock.wrapping_add(1);
        self.entries.insert(
            key,
            SourceContactCacheEntry {
                contacts: Arc::new(contacts),
                bytes,
                last_used: self.clock,
            },
        );
        self.used_bytes += bytes;
    }
}

impl SourceContactCacheSnapshot {
    pub fn build_view_cancellable(
        &self,
        query: &ContactMapQuery,
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<ContactMapView> {
        let contacts = self.entries.iter().flat_map(|(key, contacts)| {
            contacts
                .iter()
                .map(move |contact| CachedSourceContactRef { key, contact })
        });
        build_contact_map_view_from_contacts_cancellable(query, contacts, should_cancel)
    }
}

struct CachedSourceContactRef<'a> {
    key: &'a SourceContactCacheKey,
    contact: &'a CachedSourceContact,
}

impl ContactMapContact for CachedSourceContactRef<'_> {
    fn source1(&self) -> &str {
        &self.key.first.source_id
    }

    fn start1(&self) -> u64 {
        self.contact.first_start
    }

    fn source2(&self) -> &str {
        &self.key.second.source_id
    }

    fn start2(&self) -> u64 {
        self.contact.second_start
    }

    fn count(&self) -> f64 {
        self.contact.count
    }
}

pub fn source_windows_for_ranges(
    source_ranges: &[(String, u64, u64)],
    window_size: u64,
) -> Vec<SourceWindow> {
    source_windows_for_ranges_with_limit(source_ranges, window_size, usize::MAX)
        .expect("an unbounded source-window request cannot exceed its limit")
}

/// Build unique, sorted cache windows without allowing an oversized request to
/// allocate every possible window first. `None` means the number of unique
/// windows exceeded `max_windows`.
pub fn source_windows_for_ranges_with_limit(
    source_ranges: &[(String, u64, u64)],
    window_size: u64,
    max_windows: usize,
) -> Option<Vec<SourceWindow>> {
    let window_size = window_size.max(1);
    let mut windows = HashSet::new();
    for (source_id, range_start, range_end) in source_ranges {
        if range_start >= range_end {
            continue;
        }
        let mut start = range_start / window_size * window_size;
        while start < *range_end {
            let end = start.saturating_add(window_size);
            let inserted = windows.insert(SourceWindow {
                source_id: source_id.clone(),
                start,
                end,
            });
            if inserted && windows.len() > max_windows {
                return None;
            }
            if end <= start {
                break;
            }
            start = end;
        }
    }
    let mut windows = windows.into_iter().collect::<Vec<_>>();
    windows.sort();
    Some(windows)
}

struct SourceWindowIndex<'a> {
    windows: &'a [SourceWindow],
    exact_by_start: HashMap<(&'a str, u64), usize>,
    uniform_window_size: Option<u64>,
    ranges_by_source: HashMap<&'a str, Vec<(u64, u64, usize)>>,
}

impl<'a> SourceWindowIndex<'a> {
    fn new(windows: &'a [SourceWindow]) -> Self {
        let first_window_size = windows
            .first()
            .map(|window| window.end.saturating_sub(window.start))
            .filter(|size| *size > 0);
        let uniform_window_size = first_window_size.filter(|size| {
            windows.iter().all(|window| {
                window.end.saturating_sub(window.start) == *size && window.start % *size == 0
            })
        });
        let mut exact_by_start = HashMap::with_capacity(windows.len());
        let mut ranges_by_source = HashMap::<&str, Vec<(u64, u64, usize)>>::new();
        for (index, window) in windows.iter().enumerate() {
            exact_by_start.insert((window.source_id.as_str(), window.start), index);
            ranges_by_source
                .entry(window.source_id.as_str())
                .or_default()
                .push((window.start, window.end, index));
        }
        for ranges in ranges_by_source.values_mut() {
            ranges.sort_unstable_by_key(|range| range.0);
        }
        Self {
            windows,
            exact_by_start,
            uniform_window_size,
            ranges_by_source,
        }
    }

    fn find(&self, source_id: &str, position: u64) -> Option<usize> {
        if let Some(window_size) = self.uniform_window_size {
            let start = position / window_size * window_size;
            if let Some(index) = self.exact_by_start.get(&(source_id, start)).copied() {
                return (position < self.windows[index].end).then_some(index);
            }
        }
        let ranges = self.ranges_by_source.get(source_id)?;
        let insertion = ranges.partition_point(|(start, _, _)| *start <= position);
        let (_, end, index) = insertion
            .checked_sub(1)
            .and_then(|index| ranges.get(index))?;
        (position < *end).then_some(*index)
    }
}

fn upper_triangle_index(size: usize, first: usize, second: usize) -> usize {
    debug_assert!(first <= second && second < size);
    first * size - first.saturating_mul(first.saturating_sub(1)) / 2 + (second - first)
}

fn estimated_entry_bytes(key: &SourceContactCacheKey, contact_capacity: usize) -> usize {
    std::mem::size_of::<SourceContactCacheKey>()
        + key.path.capacity()
        + key.first.source_id.capacity()
        + key.second.source_id.capacity()
        + std::mem::size_of::<SourceContactCacheEntry>()
        + contact_capacity * std::mem::size_of::<CachedSourceContact>()
        + 128
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agp::Orientation,
        contact_map::{LayoutBlock, Viewport},
    };

    fn query(visual_start: u64) -> ContactMapQuery {
        ContactMapQuery {
            base_resolution: 100,
            target_resolution: 100,
            viewport: Viewport {
                x_start: visual_start,
                x_end: visual_start + 1_000,
                y_start: visual_start,
                y_end: visual_start + 1_000,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "ctg-a".to_string(),
                source_start: 0,
                source_end: 1_000,
                visual_start,
                orientation: Orientation::Forward,
            }],
        }
    }

    #[test]
    fn reuses_source_windows_after_layout_move() {
        let windows = source_windows_for_ranges(&[("ctg-a".to_string(), 0, 1_000)], 1_000);
        let keys = SourceContactCache::keys_for_windows("map.cool", 100, &windows);
        let mut cache = SourceContactCache::new(16_384);
        cache.insert_contacts_for_windows(
            "map.cool",
            100,
            &windows,
            &[ContactBin {
                source1: "ctg-a".to_string(),
                start1: 100,
                source2: "ctg-a".to_string(),
                start2: 300,
                count: 5.0,
            }],
        );

        let initial = cache.build_cached_view(&keys, &query(0)).unwrap().unwrap();
        let moved = cache
            .build_cached_view(&keys, &query(2_000))
            .unwrap()
            .unwrap();

        assert_eq!(initial.cells[0].x_bin, 1);
        assert_eq!(moved.cells[0].x_bin, 21);
        assert_eq!(cache.entry_count(), 1);
    }

    #[test]
    fn copied_layout_blocks_reuse_one_source_entry() {
        let windows = source_windows_for_ranges(&[("ctg-a".to_string(), 0, 1_000)], 1_000);
        let keys = SourceContactCache::keys_for_windows("map.cool", 100, &windows);
        let mut cache = SourceContactCache::new(16_384);
        cache.insert_contacts_for_windows(
            "map.cool",
            100,
            &windows,
            &[ContactBin {
                source1: "ctg-a".to_string(),
                start1: 100,
                source2: "ctg-a".to_string(),
                start2: 300,
                count: 5.0,
            }],
        );
        let mut copied_query = query(0);
        copied_query.viewport.x_end = 2_000;
        copied_query.viewport.y_end = 2_000;
        copied_query.layout_blocks.push(LayoutBlock {
            id: "block-copy".to_string(),
            source_id: "ctg-a".to_string(),
            source_start: 0,
            source_end: 1_000,
            visual_start: 1_000,
            orientation: Orientation::Forward,
        });

        let copied = cache
            .build_cached_view(&keys, &copied_query)
            .unwrap()
            .unwrap();

        assert_eq!(cache.entry_count(), 1);
        assert_eq!(copied.cells.len(), 4);
    }

    #[test]
    fn evicts_lru_entries_without_exceeding_budget() {
        let windows = vec![
            SourceWindow {
                source_id: "a".to_string(),
                start: 0,
                end: 100,
            },
            SourceWindow {
                source_id: "b".to_string(),
                start: 0,
                end: 100,
            },
        ];
        let one_entry_budget = estimated_entry_bytes(
            &SourceContactCache::keys_for_windows("map.cool", 100, &windows[..1])[0],
            0,
        );
        let mut cache = SourceContactCache::new(one_entry_budget);
        cache.insert_contacts_for_windows("map.cool", 100, &windows[..1], &[]);
        cache.insert_contacts_for_windows("map.cool", 100, &windows[1..], &[]);

        assert_eq!(cache.entry_count(), 1);
        assert!(cache.used_bytes() <= cache.max_bytes());
    }

    #[test]
    fn bypasses_an_entry_larger_than_the_entire_budget() {
        let windows = source_windows_for_ranges(&[("ctg-a".to_string(), 0, 100)], 100);
        let mut cache = SourceContactCache::new(1);
        cache.insert_contacts_for_windows("map.cool", 100, &windows, &[]);

        assert_eq!(cache.entry_count(), 0);
        assert_eq!(cache.used_bytes(), 0);
    }

    #[test]
    fn bounds_source_window_allocation_before_cache_pair_expansion() {
        let ranges = vec![
            ("ctg-a".to_string(), 0, 250),
            ("ctg-a".to_string(), 50, 150),
        ];

        let within_limit = source_windows_for_ranges_with_limit(&ranges, 100, 3)
            .expect("three unique windows fit the limit");
        let over_limit = source_windows_for_ranges_with_limit(&ranges, 100, 2);

        assert_eq!(within_limit.len(), 3);
        assert!(over_limit.is_none());
    }

    #[test]
    fn indexed_preparation_assigns_contacts_to_the_expected_window_pair() {
        let windows = vec![
            SourceWindow {
                source_id: "a".to_string(),
                start: 0,
                end: 100,
            },
            SourceWindow {
                source_id: "a".to_string(),
                start: 100,
                end: 200,
            },
            SourceWindow {
                source_id: "b".to_string(),
                start: 0,
                end: 100,
            },
        ];
        let contacts = vec![
            ContactBin {
                source1: "b".to_string(),
                start1: 25,
                source2: "a".to_string(),
                start2: 125,
                count: 4.0,
            },
            ContactBin {
                source1: "a".to_string(),
                start1: 50,
                source2: "missing".to_string(),
                start2: 50,
                count: 8.0,
            },
        ];

        let prepared = SourceContactCache::prepare_contacts_for_windows_cancellable(
            "map.cool",
            100,
            &windows,
            &contacts,
            &|| false,
        )
        .expect("preparation succeeds");
        let populated = prepared
            .entries
            .iter()
            .filter(|(_, contacts)| !contacts.is_empty())
            .collect::<Vec<_>>();

        assert_eq!(populated.len(), 1);
        assert_eq!(populated[0].0.first, windows[1]);
        assert_eq!(populated[0].0.second, windows[2]);
        assert_eq!(populated[0].1[0].first_start, 125);
        assert_eq!(populated[0].1[0].second_start, 25);
    }

    #[test]
    fn cache_snapshot_remains_usable_after_the_cache_is_dropped() {
        let windows = source_windows_for_ranges(&[("ctg-a".to_string(), 0, 1_000)], 1_000);
        let keys = SourceContactCache::keys_for_windows("map.cool", 100, &windows);
        let mut cache = SourceContactCache::new(16_384);
        cache.insert_contacts_for_windows(
            "map.cool",
            100,
            &windows,
            &[ContactBin {
                source1: "ctg-a".to_string(),
                start1: 100,
                source2: "ctg-a".to_string(),
                start2: 300,
                count: 5.0,
            }],
        );
        let snapshot = cache
            .snapshot_for_keys_cancellable(&keys, &|| false)
            .expect("snapshot lookup succeeds")
            .expect("entry is cached");
        drop(cache);

        let view = snapshot
            .build_view_cancellable(&query(0), &|| false)
            .expect("snapshot projects without the cache lock");

        assert_eq!(view.cells.len(), 1);
        assert_eq!(view.cells[0].count, 5.0);
    }
}
