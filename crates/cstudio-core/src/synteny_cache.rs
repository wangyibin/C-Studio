use std::collections::HashMap;

use crate::{
    synteny::{PafRecord, SyntenyQuery, SyntenyView, SyntenyViewBuilder},
    CStudioResult,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SyntenyCacheKey {
    pub path: String,
    pub size_bytes: u64,
    pub modified_nanos: u128,
}

#[derive(Debug, Default)]
pub struct SyntenyCache {
    entries: HashMap<SyntenyCacheKey, Vec<PafRecord>>,
}

impl SyntenyCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn contains_key(&self, key: &SyntenyCacheKey) -> bool {
        self.entries.contains_key(key)
    }

    pub fn insert_records(&mut self, key: SyntenyCacheKey, records: Vec<PafRecord>) {
        self.entries.insert(key, records);
    }

    pub fn build_cached_view(
        &self,
        key: &SyntenyCacheKey,
        query: &SyntenyQuery,
    ) -> CStudioResult<Option<SyntenyView>> {
        let Some(records) = self.entries.get(key) else {
            return Ok(None);
        };
        let mut builder = SyntenyViewBuilder::new(query)?;
        for record in records {
            builder.add_record_ref(record)?;
        }
        Ok(Some(builder.finish()))
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agp::Orientation,
        contact_map::{LayoutBlock, Viewport},
    };

    fn key() -> SyntenyCacheKey {
        SyntenyCacheKey {
            path: "/data/alignments.paf".to_string(),
            size_bytes: 100,
            modified_nanos: 1,
        }
    }

    fn query(blocks: Vec<LayoutBlock>, end: u64) -> SyntenyQuery {
        SyntenyQuery {
            viewport: Viewport { x_start: 0, x_end: end, y_start: 0, y_end: 1 },
            layout_blocks: blocks,
            min_mapq: 0,
            min_alignment_len: 1,
            max_query_gap: 100,
            max_target_gap: 100,
        }
    }

    fn block(id: &str, visual_start: u64) -> LayoutBlock {
        LayoutBlock {
            id: id.to_string(),
            source_id: "ctg-a".to_string(),
            source_start: 0,
            source_end: 1_000,
            visual_start,
            orientation: Orientation::Forward,
        }
    }

    #[test]
    fn cached_paf_reprojects_to_copied_blocks_without_reparsing() {
        let mut cache = SyntenyCache::new();
        let cache_key = key();
        cache.insert_records(cache_key.clone(), vec![PafRecord {
            query_name: "ctg-a".to_string(), query_len: 1_000,
            query_start: 0, query_end: 1_000, strand: '+',
            target_name: "ref-a".to_string(), target_len: 2_000,
            target_start: 0, target_end: 1_000, residue_matches: 900,
            alignment_block_len: 1_000, mapq: 60,
        }]);

        let view = cache.build_cached_view(
            &cache_key,
            &query(vec![block("original", 0), block("copy", 1_000)], 2_000),
        ).unwrap().unwrap();

        assert_eq!(cache.entry_count(), 1);
        assert_eq!(view.blocks.len(), 2);
        assert_eq!(view.blocks[0].assembly_block_id, "copy");
        assert_eq!(view.blocks[1].assembly_block_id, "original");
    }
}
