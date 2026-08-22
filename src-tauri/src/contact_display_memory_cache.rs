use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};

use crate::contact_display_cache::DisplayCacheTile;

const ENTRY_OVERHEAD_BYTES: usize = 96;

#[derive(Debug)]
struct CacheEntry {
    tile: DisplayCacheTile,
    charged_bytes: usize,
    stamp: u64,
}

/// A process-local, byte-bounded LRU for immutable decoded display tiles.
///
/// Keys are the same complete keys used by the persistent CSDT cache, so file
/// fingerprint, resolution, normalization, layout/copy mapping, and storage
/// identity remain part of every lookup. Tile payload clones are cheap because
/// their decoded arrays are shared through `Arc`.
#[derive(Debug)]
pub struct DecodedDisplayTileCache {
    max_bytes: usize,
    resident_bytes: usize,
    clock: u64,
    entries: HashMap<Arc<[u8]>, CacheEntry>,
    recency: BTreeMap<u64, Arc<[u8]>>,
}

impl DecodedDisplayTileCache {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            resident_bytes: 0,
            clock: 0,
            entries: HashMap::new(),
            recency: BTreeMap::new(),
        }
    }

    pub fn get(&mut self, key: &[u8]) -> Option<DisplayCacheTile> {
        if self.max_bytes == 0 {
            return None;
        }
        let (stored_key, entry) = self.entries.get_key_value(key)?;
        let stored_key = Arc::clone(stored_key);
        let previous_stamp = entry.stamp;
        let tile = entry.tile.clone();
        self.recency.remove(&previous_stamp);
        let stamp = self.next_stamp();
        if let Some(entry) = self.entries.get_mut(key) {
            entry.stamp = stamp;
        }
        self.recency.insert(stamp, stored_key);
        Some(tile)
    }

    pub fn insert(&mut self, key: Vec<u8>, tile: DisplayCacheTile) {
        if self.max_bytes == 0 {
            return;
        }
        self.remove(&key);
        let charged_bytes = key
            .len()
            .saturating_add(tile.decoded_bytes())
            .saturating_add(ENTRY_OVERHEAD_BYTES);
        if charged_bytes > self.max_bytes {
            return;
        }
        let key: Arc<[u8]> = key.into();
        let stamp = self.next_stamp();
        self.resident_bytes = self.resident_bytes.saturating_add(charged_bytes);
        self.recency.insert(stamp, Arc::clone(&key));
        self.entries.insert(
            key,
            CacheEntry {
                tile,
                charged_bytes,
                stamp,
            },
        );
        self.evict_over_budget();
    }

    pub fn remove(&mut self, key: &[u8]) -> bool {
        let Some(entry) = self.entries.remove(key) else {
            return false;
        };
        self.recency.remove(&entry.stamp);
        self.resident_bytes = self.resident_bytes.saturating_sub(entry.charged_bytes);
        true
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn resident_bytes(&self) -> usize {
        self.resident_bytes
    }

    fn next_stamp(&mut self) -> u64 {
        if self.clock == u64::MAX {
            // This is unreachable in practice, but rebuilding preserves strict
            // LRU ordering instead of allowing duplicate saturated stamps.
            let keys = self.recency.values().cloned().collect::<Vec<Arc<[u8]>>>();
            self.recency.clear();
            for (index, key) in keys.into_iter().enumerate() {
                let stamp = index as u64 + 1;
                if let Some(entry) = self.entries.get_mut(key.as_ref()) {
                    entry.stamp = stamp;
                }
                self.recency.insert(stamp, key);
            }
            self.clock = self.recency.len() as u64;
        }
        self.clock += 1;
        self.clock
    }

    fn evict_over_budget(&mut self) {
        while self.resident_bytes > self.max_bytes {
            let Some((_, key)) = self.recency.pop_first() else {
                break;
            };
            if let Some(entry) = self.entries.remove(key.as_ref()) {
                self.resident_bytes = self.resident_bytes.saturating_sub(entry.charged_bytes);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contact_display_cache::{DisplayCacheTile, DisplayCacheValues};

    fn tile(tile_x: u64) -> DisplayCacheTile {
        DisplayCacheTile {
            tile_size_bins: 2,
            tile_x,
            tile_y: 0,
            values: DisplayCacheValues::R16f(vec![0xbc00, 0x3c00, 0x4000, 0].into()),
        }
    }

    fn charge(key: &[u8], tile: &DisplayCacheTile) -> usize {
        key.len() + tile.decoded_bytes() + ENTRY_OVERHEAD_BYTES
    }

    #[test]
    fn evicts_least_recently_used_entry_by_decoded_byte_budget() {
        let first = tile(1);
        let second = tile(2);
        let third = tile(3);
        let budget = charge(b"first", &first) + charge(b"second", &second);
        let mut cache = DecodedDisplayTileCache::new(budget);
        cache.insert(b"first".to_vec(), first);
        cache.insert(b"second".to_vec(), second);
        assert_eq!(cache.get(b"first").unwrap().tile_x, 1);

        cache.insert(b"third".to_vec(), third);

        assert!(cache.get(b"second").is_none());
        assert_eq!(cache.get(b"first").unwrap().tile_x, 1);
        assert_eq!(cache.get(b"third").unwrap().tile_x, 3);
        assert_eq!(cache.len(), 2);
        assert!(cache.resident_bytes() <= budget);
    }

    #[test]
    fn replacement_updates_accounting_and_shares_decoded_storage() {
        let mut cache = DecodedDisplayTileCache::new(1_024);
        let original = tile(1);
        cache.insert(b"same".to_vec(), original.clone());
        let hit = cache.get(b"same").unwrap();
        let (DisplayCacheValues::R16f(original_values), DisplayCacheValues::R16f(hit_values)) =
            (&original.values, &hit.values)
        else {
            unreachable!();
        };
        assert!(Arc::ptr_eq(original_values, hit_values));

        cache.insert(b"same".to_vec(), tile(9));
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get(b"same").unwrap().tile_x, 9);
        assert!(cache.resident_bytes() <= 1_024);
    }

    #[test]
    fn zero_or_too_small_budget_keeps_no_entries() {
        let mut disabled = DecodedDisplayTileCache::new(0);
        disabled.insert(b"tile".to_vec(), tile(1));
        assert!(disabled.get(b"tile").is_none());

        let mut undersized = DecodedDisplayTileCache::new(1);
        undersized.insert(b"tile".to_vec(), tile(1));
        assert_eq!(undersized.len(), 0);
        assert_eq!(undersized.resident_bytes(), 0);
    }
}
