use std::collections::HashMap;

use crate::{
    coverage::{BedGraphRecord, CoverageQuery, CoverageView, CoverageViewBuilder},
    CStudioResult,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CoverageCacheKey {
    pub path: String,
    pub size_bytes: u64,
    pub modified_nanos: u128,
}

#[derive(Debug, Clone)]
struct CachedCoverageRecord {
    source_index: u32,
    start: u64,
    end: u64,
    value: f64,
}

#[derive(Debug, Clone, Default)]
struct CoverageCacheEntry {
    sources: Vec<String>,
    records: Vec<CachedCoverageRecord>,
}

#[derive(Debug, Default)]
pub struct CoverageCache {
    entries: HashMap<CoverageCacheKey, CoverageCacheEntry>,
}

impl CoverageCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn contains_key(&self, key: &CoverageCacheKey) -> bool {
        self.entries.contains_key(key)
    }

    pub fn insert_records(&mut self, key: CoverageCacheKey, records: Vec<BedGraphRecord>) {
        let mut source_indices = HashMap::<String, u32>::new();
        let mut entry = CoverageCacheEntry::default();

        for record in records {
            let source_index = match source_indices.get(&record.chrom) {
                Some(index) => *index,
                None => {
                    let index = entry.sources.len() as u32;
                    source_indices.insert(record.chrom.clone(), index);
                    entry.sources.push(record.chrom);
                    index
                }
            };
            entry.records.push(CachedCoverageRecord {
                source_index,
                start: record.start,
                end: record.end,
                value: record.value,
            });
        }

        self.entries.insert(key, entry);
    }

    pub fn build_cached_view(
        &self,
        key: &CoverageCacheKey,
        query: &CoverageQuery,
    ) -> CStudioResult<Option<CoverageView>> {
        let Some(entry) = self.entries.get(key) else {
            return Ok(None);
        };

        let mut builder = CoverageViewBuilder::new(query)?;
        for record in &entry.records {
            let source = &entry.sources[record.source_index as usize];
            builder.add_record_fields(source, record.start, record.end, record.value)?;
        }
        Ok(Some(builder.finish()))
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn cached_record_count(&self, key: &CoverageCacheKey) -> usize {
        self.entries
            .get(key)
            .map(|entry| entry.records.len())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agp::Orientation,
        contact_map::{LayoutBlock, Viewport},
    };

    fn key(modified_nanos: u128) -> CoverageCacheKey {
        CoverageCacheKey {
            path: "/data/coverage.bedgraph".to_string(),
            size_bytes: 128,
            modified_nanos,
        }
    }

    fn query(blocks: Vec<LayoutBlock>, end: u64) -> CoverageQuery {
        CoverageQuery {
            display_resolution: 100,
            viewport: Viewport {
                x_start: 0,
                x_end: end,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: blocks,
        }
    }

    fn block(id: &str, visual_start: u64) -> LayoutBlock {
        LayoutBlock {
            id: id.to_string(),
            source_id: "ctg-a".to_string(),
            source_start: 0,
            source_end: 200,
            visual_start,
            orientation: Orientation::Forward,
        }
    }

    #[test]
    fn reprojects_cached_records_for_a_new_layout_without_reinsertion() {
        let mut cache = CoverageCache::new();
        let cache_key = key(1);
        cache.insert_records(
            cache_key.clone(),
            vec![BedGraphRecord {
                chrom: "ctg-a".to_string(),
                start: 0,
                end: 200,
                value: 12.0,
            }],
        );

        let initial = cache
            .build_cached_view(&cache_key, &query(vec![block("a", 0)], 200))
            .unwrap()
            .unwrap();
        let moved = cache
            .build_cached_view(&cache_key, &query(vec![block("a", 300)], 500))
            .unwrap()
            .unwrap();

        assert_eq!(cache.entry_count(), 1);
        assert_eq!(cache.cached_record_count(&cache_key), 1);
        assert_eq!(
            initial.bins.iter().map(|bin| bin.x_bin).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(
            moved.bins.iter().map(|bin| bin.x_bin).collect::<Vec<_>>(),
            vec![3, 4]
        );
    }

    #[test]
    fn copied_layout_blocks_share_the_same_cached_source_coverage() {
        let mut cache = CoverageCache::new();
        let cache_key = key(1);
        cache.insert_records(
            cache_key.clone(),
            vec![BedGraphRecord {
                chrom: "ctg-a".to_string(),
                start: 0,
                end: 200,
                value: 7.0,
            }],
        );

        let view = cache
            .build_cached_view(
                &cache_key,
                &query(vec![block("original", 0), block("copy", 200)], 400),
            )
            .unwrap()
            .unwrap();

        assert_eq!(
            view.bins.iter().map(|bin| bin.x_bin).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        assert!(view.bins.iter().all(|bin| bin.value == 3.5));
    }

    #[test]
    fn file_metadata_change_uses_a_distinct_cache_entry() {
        let mut cache = CoverageCache::new();
        cache.insert_records(key(1), Vec::new());
        cache.insert_records(key(2), Vec::new());
        assert_eq!(cache.entry_count(), 2);
    }
}
