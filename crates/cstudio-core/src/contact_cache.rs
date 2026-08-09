use std::collections::HashMap;

use crate::{
    contact_map::{
        build_contact_map_view_from_contacts, ContactBin, ContactMapContact, ContactMapQuery,
        ContactMapView,
    },
    CStudioResult,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContactCacheKey {
    pub path: String,
    pub resolution: u64,
    pub source_ids: Vec<String>,
}

#[derive(Debug, Default)]
pub struct ContactCache {
    entries: HashMap<ContactCacheKey, ContactCacheEntry>,
}

#[derive(Debug, Default)]
struct ContactCacheEntry {
    sources: Vec<String>,
    contacts: Vec<CachedContactBin>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct CachedContactBin {
    source1: u32,
    start1: u64,
    source2: u32,
    start2: u64,
    count: f64,
}

struct CachedContactRef<'a> {
    entry: &'a ContactCacheEntry,
    contact: &'a CachedContactBin,
}

impl ContactCacheEntry {
    fn from_contacts(contacts: Vec<ContactBin>) -> Self {
        let mut sources = Vec::new();
        let mut source_indices = HashMap::new();
        let contacts = contacts
            .into_iter()
            .map(|contact| {
                let source1 = intern_source(&mut sources, &mut source_indices, contact.source1);
                let source2 = intern_source(&mut sources, &mut source_indices, contact.source2);

                CachedContactBin {
                    source1,
                    start1: contact.start1,
                    source2,
                    start2: contact.start2,
                    count: contact.count,
                }
            })
            .collect();

        Self { sources, contacts }
    }

    fn contacts(&self) -> impl Iterator<Item = CachedContactRef<'_>> {
        self.contacts
            .iter()
            .map(|contact| CachedContactRef { entry: self, contact })
    }
}

impl ContactMapContact for CachedContactRef<'_> {
    fn source1(&self) -> &str {
        &self.entry.sources[self.contact.source1 as usize]
    }

    fn start1(&self) -> u64 {
        self.contact.start1
    }

    fn source2(&self) -> &str {
        &self.entry.sources[self.contact.source2 as usize]
    }

    fn start2(&self) -> u64 {
        self.contact.start2
    }

    fn count(&self) -> f64 {
        self.contact.count
    }
}

fn intern_source(
    sources: &mut Vec<String>,
    source_indices: &mut HashMap<String, u32>,
    source: String,
) -> u32 {
    if let Some(index) = source_indices.get(source.as_str()) {
        return *index;
    }

    let index = sources.len() as u32;
    sources.push(source.clone());
    source_indices.insert(source, index);
    index
}

impl ContactCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn build_view<F>(
        &mut self,
        key: ContactCacheKey,
        query: &ContactMapQuery,
        load_contacts: F,
    ) -> CStudioResult<ContactMapView>
    where
        F: FnOnce(&ContactCacheKey) -> CStudioResult<Vec<ContactBin>>,
    {
        let entry = match self.entries.get_mut(&key) {
            Some(entry) => entry,
            None => {
                self.entries
                    .insert(key.clone(), ContactCacheEntry::from_contacts(load_contacts(&key)?));
                self.entries
                    .get_mut(&key)
                    .expect("contact cache entry was just inserted")
            }
        };

        Self::build_entry_view(entry, query)
    }

    pub fn contains_key(&self, key: &ContactCacheKey) -> bool {
        self.entries.contains_key(key)
    }

    pub fn insert_contacts(&mut self, key: ContactCacheKey, contacts: Vec<ContactBin>) {
        self.entries
            .insert(key, ContactCacheEntry::from_contacts(contacts));
    }

    pub fn build_cached_view(
        &self,
        key: &ContactCacheKey,
        query: &ContactMapQuery,
    ) -> CStudioResult<Option<ContactMapView>> {
        self.entries
            .get(key)
            .map(|entry| Self::build_entry_view(entry, query))
            .transpose()
    }

    fn build_entry_view(
        entry: &ContactCacheEntry,
        query: &ContactMapQuery,
    ) -> CStudioResult<ContactMapView> {
        let visible_sources = VisibleSourceIndex::new(query);

        build_contact_map_view_from_contacts(
            query,
            entry
                .contacts()
                .filter(|contact| visible_sources.may_contain_contact(contact)),
        )
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn cached_source_count(&self, key: &ContactCacheKey) -> Option<usize> {
        self.entries.get(key).map(|entry| entry.sources.len())
    }

    pub fn cached_contact_count(&self, key: &ContactCacheKey) -> Option<usize> {
        self.entries.get(key).map(|entry| entry.contacts.len())
    }
}

#[derive(Debug)]
struct VisibleSourceIndex {
    ranges_by_source: HashMap<String, Vec<(u64, u64)>>,
}

impl VisibleSourceIndex {
    fn new(query: &ContactMapQuery) -> Self {
        let visual_start = query.viewport.x_start.min(query.viewport.y_start);
        let visual_end = query.viewport.x_end.max(query.viewport.y_end);
        let mut ranges_by_source: HashMap<String, Vec<(u64, u64)>> = HashMap::new();

        for block in &query.layout_blocks {
            let block_visual_end = block.visual_start + (block.source_end - block.source_start);
            if block.visual_start >= visual_end || block_visual_end <= visual_start {
                continue;
            }

            ranges_by_source
                .entry(block.source_id.clone())
                .or_default()
                .push((block.source_start, block.source_end));
        }

        Self { ranges_by_source }
    }

    fn may_contain_contact(&self, contact: &impl ContactMapContact) -> bool {
        self.contains_source_position(contact.source1(), contact.start1())
            && self.contains_source_position(contact.source2(), contact.start2())
    }

    fn contains_source_position(&self, source_id: &str, source_start: u64) -> bool {
        self.ranges_by_source
            .get(source_id)
            .is_some_and(|ranges| ranges.iter().any(|(start, end)| source_start >= *start && source_start < *end))
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use crate::{
        agp::Orientation,
        contact_map::{ContactBin, ContactMapQuery, LayoutBlock, Viewport},
    };

    use super::{ContactCache, ContactCacheKey};

    #[test]
    fn reuses_loaded_contacts_for_multiple_viewports() {
        let mut cache = ContactCache::new();
        let load_count = Cell::new(0);
        let key = ContactCacheKey {
            path: "sample.cool".to_string(),
            resolution: 1_000,
            source_ids: vec!["ctg1".to_string()],
        };
        let layout_blocks = vec![LayoutBlock {
            id: "block-1".to_string(),
            source_id: "ctg1".to_string(),
            source_start: 0,
            source_end: 5_000,
            visual_start: 0,
            orientation: Orientation::Forward,
        }];

        let first = cache
            .build_view(
                key.clone(),
                &ContactMapQuery {
                    base_resolution: 1_000,
                    target_resolution: 1_000,
                    viewport: Viewport {
                        x_start: 0,
                        x_end: 3_000,
                        y_start: 0,
                        y_end: 3_000,
                    },
                    layout_blocks: layout_blocks.clone(),
                },
                |_| {
                    load_count.set(load_count.get() + 1);
                    Ok(vec![
                        ContactBin {
                            source1: "ctg1".to_string(),
                            start1: 0,
                            source2: "ctg1".to_string(),
                            start2: 0,
                            count: 10.0,
                        },
                        ContactBin {
                            source1: "ctg1".to_string(),
                            start1: 4_000,
                            source2: "ctg1".to_string(),
                            start2: 4_000,
                            count: 20.0,
                        },
                    ])
                },
            )
            .expect("first viewport should build");

        let second = cache
            .build_view(
                key,
                &ContactMapQuery {
                    base_resolution: 1_000,
                    target_resolution: 1_000,
                    viewport: Viewport {
                        x_start: 3_000,
                        x_end: 5_000,
                        y_start: 3_000,
                        y_end: 5_000,
                    },
                    layout_blocks,
                },
                |_| {
                    load_count.set(load_count.get() + 1);
                    Ok(Vec::new())
                },
            )
            .expect("second viewport should build");

        assert_eq!(load_count.get(), 1);
        assert_eq!(cache.entry_count(), 1);
        assert_eq!(first.cells.len(), 1);
        assert_eq!(second.cells.len(), 1);
    }

    #[test]
    fn stores_repeated_contact_sources_once_per_cache_entry() {
        let mut cache = ContactCache::new();
        let key = ContactCacheKey {
            path: "sample.cool".to_string(),
            resolution: 1_000,
            source_ids: vec!["ctg1".to_string()],
        };
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 5_000,
                y_start: 0,
                y_end: 5_000,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-1".to_string(),
                source_id: "ctg1".to_string(),
                source_start: 0,
                source_end: 5_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };

        cache
            .build_view(key.clone(), &query, |_| {
                Ok(vec![
                    ContactBin {
                        source1: "ctg1".to_string(),
                        start1: 0,
                        source2: "ctg1".to_string(),
                        start2: 0,
                        count: 10.0,
                    },
                    ContactBin {
                        source1: "ctg1".to_string(),
                        start1: 4_000,
                        source2: "ctg1".to_string(),
                        start2: 4_000,
                        count: 20.0,
                    },
                ])
            })
            .expect("view should build");

        assert_eq!(cache.cached_source_count(&key), Some(1));
        assert_eq!(cache.cached_contact_count(&key), Some(2));
    }
}
