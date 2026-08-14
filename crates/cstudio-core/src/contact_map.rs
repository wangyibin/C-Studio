use std::collections::{HashMap, HashSet};

use crate::{agp::Orientation, CStudioError, CStudioResult};

#[derive(Debug, Clone, PartialEq)]
pub struct ContactMapQuery {
    pub base_resolution: u64,
    pub target_resolution: u64,
    pub viewport: Viewport,
    pub layout_blocks: Vec<LayoutBlock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewport {
    pub x_start: u64,
    pub x_end: u64,
    pub y_start: u64,
    pub y_end: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutBlock {
    pub id: String,
    pub source_id: String,
    pub source_start: u64,
    pub source_end: u64,
    pub visual_start: u64,
    pub orientation: Orientation,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContactBin {
    pub source1: String,
    pub start1: u64,
    pub source2: String,
    pub start2: u64,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContactMapView {
    pub resolution: u64,
    pub viewport: Viewport,
    pub cells: Vec<ContactMapCell>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContactMapCell {
    pub x_bin: u64,
    pub y_bin: u64,
    pub count: f64,
}

pub trait ContactMapContact {
    fn source1(&self) -> &str;
    fn start1(&self) -> u64;
    fn source2(&self) -> &str;
    fn start2(&self) -> u64;
    fn count(&self) -> f64;
}

impl ContactMapContact for ContactBin {
    fn source1(&self) -> &str {
        &self.source1
    }

    fn start1(&self) -> u64 {
        self.start1
    }

    fn source2(&self) -> &str {
        &self.source2
    }

    fn start2(&self) -> u64 {
        self.start2
    }

    fn count(&self) -> f64 {
        self.count
    }
}

impl<T> ContactMapContact for &T
where
    T: ContactMapContact + ?Sized,
{
    fn source1(&self) -> &str {
        (*self).source1()
    }

    fn start1(&self) -> u64 {
        (*self).start1()
    }

    fn source2(&self) -> &str {
        (*self).source2()
    }

    fn start2(&self) -> u64 {
        (*self).start2()
    }

    fn count(&self) -> f64 {
        (*self).count()
    }
}

pub fn build_contact_map_view<I>(
    query: &ContactMapQuery,
    contacts: I,
) -> CStudioResult<ContactMapView>
where
    I: IntoIterator<Item = ContactBin>,
{
    build_contact_map_view_from_contacts(query, contacts)
}

pub fn build_contact_map_view_from_refs<'a, I>(
    query: &ContactMapQuery,
    contacts: I,
) -> CStudioResult<ContactMapView>
where
    I: IntoIterator<Item = &'a ContactBin>,
{
    build_contact_map_view_from_contacts(query, contacts)
}

pub fn build_contact_map_view_from_contacts<I, C>(
    query: &ContactMapQuery,
    contacts: I,
) -> CStudioResult<ContactMapView>
where
    I: IntoIterator<Item = C>,
    C: ContactMapContact,
{
    build_contact_map_view_from_contacts_cancellable(query, contacts, &|| false)
}

pub fn build_contact_map_view_from_contacts_cancellable<I, C>(
    query: &ContactMapQuery,
    contacts: I,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<ContactMapView>
where
    I: IntoIterator<Item = C>,
    C: ContactMapContact,
{
    let mut projector = ContactMapChunkProjector::new(query)?;
    ensure_not_cancelled(should_cancel)?;

    for (contact_index, contact) in contacts.into_iter().enumerate() {
        if contact_index % 4_096 == 0 {
            ensure_not_cancelled(should_cancel)?;
        }
        projector.push_contact(
            contact.source1(),
            contact.start1(),
            contact.source2(),
            contact.start2(),
            contact.count(),
        );
    }

    ensure_not_cancelled(should_cancel)?;
    let view = projector.take_view();
    ensure_not_cancelled(should_cancel)?;
    Ok(view)
}

/// Stateful projector for one HDF5 scan. `take_view` drains only the current
/// chunk's sparse aggregate, allowing callers to emit additive deltas without
/// retaining the complete contact matrix in backend memory.
pub struct ContactMapChunkProjector<'a> {
    query: &'a ContactMapQuery,
    block_index: LayoutBlockIndex<'a>,
    last_x_source: Option<(&'a str, usize)>,
    last_y_source: Option<(&'a str, usize)>,
    indexed_source_slots: Vec<Option<Option<usize>>>,
    requested_tiles: Option<RequestedTileFilter>,
    aggregate: ContactMapAggregate,
}

struct RequestedTileFilter {
    tile_size_bins: u64,
    tiles: HashSet<(u64, u64)>,
}

enum ContactMapAggregate {
    Sparse(HashMap<(u64, u64), f64>),
    Dense(DenseContactMapAggregate),
}

struct DenseContactMapAggregate {
    x_start_bin: u64,
    y_start_bin: u64,
    x_bins: usize,
    y_bins: usize,
    counts: Vec<f64>,
    occupied: Vec<bool>,
    occupied_count: usize,
}

impl<'a> ContactMapChunkProjector<'a> {
    pub fn new(query: &'a ContactMapQuery) -> CStudioResult<Self> {
        validate_query(query)?;
        Ok(Self {
            query,
            block_index: LayoutBlockIndex::new(&query.layout_blocks),
            last_x_source: None,
            last_y_source: None,
            indexed_source_slots: Vec::new(),
            requested_tiles: None,
            aggregate: ContactMapAggregate::Sparse(HashMap::new()),
        })
    }

    /// Builds an exact dense aggregate whose allocation is bounded by the
    /// caller before any source contacts are visited. This avoids hashing tens
    /// of millions of contacts into a screen-sized overview grid.
    pub fn new_for_bounded_view(
        query: &'a ContactMapQuery,
        max_cells: usize,
    ) -> CStudioResult<Self> {
        validate_query(query)?;
        Ok(Self {
            query,
            block_index: LayoutBlockIndex::new(&query.layout_blocks),
            last_x_source: None,
            last_y_source: None,
            indexed_source_slots: Vec::new(),
            requested_tiles: None,
            aggregate: ContactMapAggregate::Dense(DenseContactMapAggregate::new(
                query, max_cells,
            )?),
        })
    }

    pub fn new_for_tiles<I>(
        query: &'a ContactMapQuery,
        tile_size_bins: u64,
        requested_tiles: I,
    ) -> CStudioResult<Self>
    where
        I: IntoIterator<Item = (u64, u64)>,
    {
        if tile_size_bins == 0 {
            return Err(CStudioError::InvalidContactMapQuery(
                "tile_size_bins must be positive".to_string(),
            ));
        }
        let mut projector = Self::new(query)?;
        projector.requested_tiles = Some(RequestedTileFilter {
            tile_size_bins,
            tiles: requested_tiles
                .into_iter()
                .map(|(tile_x, tile_y)| {
                    if tile_x <= tile_y {
                        (tile_x, tile_y)
                    } else {
                        (tile_y, tile_x)
                    }
                })
                .collect(),
        });
        Ok(projector)
    }

    pub fn push_contact(
        &mut self,
        source1: &str,
        start1: u64,
        source2: &str,
        start2: u64,
        count: f64,
    ) {
        let Some(x_source) = Self::cached_source_slot(
            &self.block_index,
            &mut self.last_x_source,
            source1,
        ) else {
            return;
        };
        let Some(y_source) = Self::cached_source_slot(
            &self.block_index,
            &mut self.last_y_source,
            source2,
        ) else {
            return;
        };
        self.push_contact_from_source_slots(x_source, start1, y_source, start2, count);
    }

    /// Projects a Cooler contact by its stable chromosome-table indexes. Each
    /// source name is resolved against the layout once per scan instead of
    /// hashing two strings for every pixel.
    pub fn push_indexed_contact(
        &mut self,
        source1_index: usize,
        source1: &str,
        start1: u64,
        source2_index: usize,
        source2: &str,
        start2: u64,
        count: f64,
    ) {
        let Some(x_source) = self.indexed_source_slot(source1_index, source1) else {
            return;
        };
        let Some(y_source) = self.indexed_source_slot(source2_index, source2) else {
            return;
        };
        self.push_contact_from_source_slots(x_source, start1, y_source, start2, count);
    }

    fn indexed_source_slot(&mut self, source_index: usize, source_id: &str) -> Option<usize> {
        if self.indexed_source_slots.len() <= source_index {
            self.indexed_source_slots.resize(source_index + 1, None);
        }
        if let Some(slot) = self.indexed_source_slots[source_index] {
            return slot;
        }
        let slot = self.block_index.source_slot(source_id);
        self.indexed_source_slots[source_index] = Some(slot);
        slot
    }

    fn push_contact_from_source_slots(
        &mut self,
        x_source: usize,
        start1: u64,
        y_source: usize,
        start2: u64,
        count: f64,
    ) {
        let x_blocks = self.block_index.blocks(x_source);
        let y_blocks = self.block_index.blocks(y_source);

        // Most assembly sources have exactly one current placement. Avoid two
        // extra interval scans and the copy-share division on that dominant
        // whole-genome path while preserving the general copied-placement path.
        if x_blocks.len() == 1 && y_blocks.len() == 1 {
            let Some(x) = x_blocks[0].visual_position(start1) else {
                return;
            };
            let Some(y) = y_blocks[0].visual_position(start2) else {
                return;
            };
            Self::push_visual_contact(
                self.query,
                self.requested_tiles.as_ref(),
                &mut self.aggregate,
                x,
                y,
                count,
            );
            return;
        }

        let x_position_count = x_blocks
            .iter()
            .filter(|block| block.visual_position(start1).is_some())
            .count();
        if x_position_count == 0 {
            return;
        }
        let y_position_count = y_blocks
            .iter()
            .filter(|block| block.visual_position(start2).is_some())
            .count();
        if y_position_count == 0 {
            return;
        }
        // A copied layout placement does not create new source observations.
        // Treat every matching placement pair as one equally likely assignment
        // of the original contact so projection conserves the observed signal.
        let assignment_count = x_position_count as f64 * y_position_count as f64;
        let projected_count = count / assignment_count;

        for x_block in x_blocks {
            let Some(x) = x_block.visual_position(start1) else {
                continue;
            };
            for y_block in y_blocks {
                let Some(y) = y_block.visual_position(start2) else {
                    continue;
                };
                Self::push_visual_contact(
                    self.query,
                    self.requested_tiles.as_ref(),
                    &mut self.aggregate,
                    x,
                    y,
                    projected_count,
                );
            }
        }
    }

    fn cached_source_slot(
        block_index: &LayoutBlockIndex<'a>,
        cached: &mut Option<(&'a str, usize)>,
        source_id: &str,
    ) -> Option<usize> {
        if let Some((cached_source, slot)) = *cached {
            if cached_source == source_id {
                return Some(slot);
            }
        }
        let slot = block_index.source_slot(source_id)?;
        *cached = Some((block_index.source_id(slot), slot));
        Some(slot)
    }

    fn push_visual_contact(
        query: &ContactMapQuery,
        requested_tiles: Option<&RequestedTileFilter>,
        aggregate: &mut ContactMapAggregate,
        x: u64,
        y: u64,
        count: f64,
    ) {
        let (visual_x, visual_y) = if x <= y { (x, y) } else { (y, x) };
        if !query.viewport.contains(visual_x, visual_y) {
            return;
        }
        let x_bin = visual_x / query.target_resolution;
        let y_bin = visual_y / query.target_resolution;
        if let Some(filter) = requested_tiles {
            let tile = (x_bin / filter.tile_size_bins, y_bin / filter.tile_size_bins);
            if !filter.tiles.contains(&tile) {
                return;
            }
        }
        aggregate.add(x_bin, y_bin, count);
    }

    pub fn take_view(&mut self) -> ContactMapView {
        let cells = self.aggregate.take_cells();
        ContactMapView {
            resolution: self.query.target_resolution,
            viewport: self.query.viewport,
            cells,
        }
    }

    pub fn pending_cell_count(&self) -> usize {
        self.aggregate.len()
    }
}

impl ContactMapAggregate {
    fn add(&mut self, x_bin: u64, y_bin: u64, count: f64) {
        match self {
            Self::Sparse(aggregate) => {
                *aggregate.entry((x_bin, y_bin)).or_insert(0.0) += count;
            }
            Self::Dense(aggregate) => aggregate.add(x_bin, y_bin, count),
        }
    }

    fn take_cells(&mut self) -> Vec<ContactMapCell> {
        match self {
            Self::Sparse(aggregate) => {
                let mut cells: Vec<ContactMapCell> = std::mem::take(aggregate)
                    .into_iter()
                    .map(|((x_bin, y_bin), count)| ContactMapCell {
                        x_bin,
                        y_bin,
                        count,
                    })
                    .collect();
                cells.sort_by_key(|cell| (cell.x_bin, cell.y_bin));
                cells
            }
            Self::Dense(aggregate) => aggregate.take_cells(),
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::Sparse(aggregate) => aggregate.len(),
            Self::Dense(aggregate) => aggregate.occupied_count,
        }
    }
}

impl DenseContactMapAggregate {
    fn new(query: &ContactMapQuery, max_cells: usize) -> CStudioResult<Self> {
        let resolution = query.target_resolution;
        let x_start_bin = query.viewport.x_start / resolution;
        let x_end_bin = query.viewport.x_end.div_ceil(resolution);
        let y_start_bin = query.viewport.y_start / resolution;
        let y_end_bin = query.viewport.y_end.div_ceil(resolution);
        let x_bins = x_end_bin.saturating_sub(x_start_bin);
        let y_bins = y_end_bin.saturating_sub(y_start_bin);
        let cell_count = x_bins.checked_mul(y_bins).ok_or_else(|| {
            CStudioError::InvalidContactMapQuery(
                "bounded contact-map aggregate grid overflowed u64".to_string(),
            )
        })?;
        if cell_count > u64::try_from(max_cells).unwrap_or(u64::MAX) {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                "contact-map aggregate requires {cell_count} cells, exceeding bound {max_cells}"
            )));
        }
        let x_bins = usize::try_from(x_bins).map_err(|_| {
            CStudioError::InvalidContactMapQuery(
                "bounded contact-map X grid exceeds platform range".to_string(),
            )
        })?;
        let y_bins = usize::try_from(y_bins).map_err(|_| {
            CStudioError::InvalidContactMapQuery(
                "bounded contact-map Y grid exceeds platform range".to_string(),
            )
        })?;
        let cell_count = usize::try_from(cell_count).map_err(|_| {
            CStudioError::InvalidContactMapQuery(
                "bounded contact-map grid exceeds platform range".to_string(),
            )
        })?;
        Ok(Self {
            x_start_bin,
            y_start_bin,
            x_bins,
            y_bins,
            counts: vec![0.0; cell_count],
            occupied: vec![false; cell_count],
            occupied_count: 0,
        })
    }

    fn add(&mut self, x_bin: u64, y_bin: u64, count: f64) {
        let Some(local_x) = x_bin
            .checked_sub(self.x_start_bin)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value < self.x_bins)
        else {
            return;
        };
        let Some(local_y) = y_bin
            .checked_sub(self.y_start_bin)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value < self.y_bins)
        else {
            return;
        };
        let index = local_x * self.y_bins + local_y;
        if !self.occupied[index] {
            self.occupied[index] = true;
            self.occupied_count += 1;
        }
        self.counts[index] += count;
    }

    fn take_cells(&mut self) -> Vec<ContactMapCell> {
        let mut cells = Vec::with_capacity(self.occupied_count);
        for local_x in 0..self.x_bins {
            for local_y in 0..self.y_bins {
                let index = local_x * self.y_bins + local_y;
                if !self.occupied[index] {
                    continue;
                }
                cells.push(ContactMapCell {
                    x_bin: self.x_start_bin + local_x as u64,
                    y_bin: self.y_start_bin + local_y as u64,
                    count: self.counts[index],
                });
                self.counts[index] = 0.0;
                self.occupied[index] = false;
            }
        }
        self.occupied_count = 0;
        cells
    }
}

fn ensure_not_cancelled(should_cancel: &dyn Fn() -> bool) -> CStudioResult<()> {
    if should_cancel() {
        Err(CStudioError::RequestCancelled)
    } else {
        Ok(())
    }
}

fn validate_query(query: &ContactMapQuery) -> CStudioResult<()> {
    if query.base_resolution == 0
        || query.target_resolution == 0
        || query.target_resolution % query.base_resolution != 0
    {
        return Err(CStudioError::InvalidContactMapQuery(
            "target_resolution must be a positive multiple of base_resolution".to_string(),
        ));
    }

    if query.viewport.x_start >= query.viewport.x_end
        || query.viewport.y_start >= query.viewport.y_end
    {
        return Err(CStudioError::InvalidContactMapQuery(
            "viewport start must be less than viewport end".to_string(),
        ));
    }

    for block in &query.layout_blocks {
        if block.source_id.trim().is_empty() {
            return Err(CStudioError::InvalidContactMapQuery(
                "layout block source_id cannot be empty".to_string(),
            ));
        }
        if block.source_start >= block.source_end {
            return Err(CStudioError::InvalidContactMapQuery(format!(
                "layout block {} source_start must be less than source_end",
                block.id
            )));
        }
    }

    Ok(())
}

struct LayoutBlockIndex<'a> {
    by_source: HashMap<&'a str, usize>,
    sources: Vec<SourceLayoutBlocks<'a>>,
}

struct SourceLayoutBlocks<'a> {
    source_id: &'a str,
    blocks: Vec<&'a LayoutBlock>,
}

impl<'a> LayoutBlockIndex<'a> {
    fn new(blocks: &'a [LayoutBlock]) -> Self {
        let mut by_source: HashMap<&'a str, usize> = HashMap::new();
        let mut sources = Vec::<SourceLayoutBlocks<'a>>::new();
        for block in blocks {
            let source_id = block.source_id.as_str();
            let slot = match by_source.get(source_id).copied() {
                Some(slot) => slot,
                None => {
                    let slot = sources.len();
                    sources.push(SourceLayoutBlocks {
                        source_id,
                        blocks: Vec::new(),
                    });
                    by_source.insert(source_id, slot);
                    slot
                }
            };
            sources[slot].blocks.push(block);
        }

        Self { by_source, sources }
    }

    fn source_slot(&self, source_id: &str) -> Option<usize> {
        self.by_source.get(source_id).copied()
    }

    fn source_id(&self, slot: usize) -> &'a str {
        self.sources[slot].source_id
    }

    fn blocks(&self, slot: usize) -> &[&'a LayoutBlock] {
        self.sources[slot].blocks.as_slice()
    }
}

impl LayoutBlock {
    pub(crate) fn visual_position(&self, source_start: u64) -> Option<u64> {
        if source_start < self.source_start || source_start >= self.source_end {
            return None;
        }

        let offset = source_start - self.source_start;
        let visual_offset = match self.orientation {
            Orientation::Forward | Orientation::Unknown => offset,
            Orientation::Reverse => self.source_end - self.source_start - offset - 1,
        };

        Some(self.visual_start + visual_offset)
    }
}

impl Viewport {
    fn contains(&self, x: u64, y: u64) -> bool {
        x >= self.x_start && x < self.x_end && y >= self.y_start && y < self.y_end
    }

    pub fn contains_bin(&self, x_bin: u64, y_bin: u64, resolution: u64) -> bool {
        let x = x_bin.saturating_mul(resolution);
        let y = y_bin.saturating_mul(resolution);
        self.contains(x, y)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::{
        agp::Orientation,
        contact_map::{
            build_contact_map_view, build_contact_map_view_from_contacts_cancellable,
            build_contact_map_view_from_refs, ContactBin, ContactMapCell, ContactMapChunkProjector,
            ContactMapQuery, LayoutBlock, Viewport,
        },
        CStudioError,
    };

    #[test]
    fn cancellation_stops_before_consuming_contact_aggregation_input() {
        let consumed = AtomicUsize::new(0);
        let contacts = std::iter::from_fn(|| {
            consumed.fetch_add(1, Ordering::SeqCst);
            Some(ContactBin {
                source1: "contig-a".to_string(),
                start1: 0,
                source2: "contig-a".to_string(),
                start2: 0,
                count: 1.0,
            })
        });
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 1_000,
                y_start: 0,
                y_end: 1_000,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 1_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };

        let error = build_contact_map_view_from_contacts_cancellable(&query, contacts, &|| true)
            .expect_err("cancelled aggregation should not consume contacts");

        assert_eq!(error, CStudioError::RequestCancelled);
        assert_eq!(consumed.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn chunk_projector_deltas_sum_to_the_one_shot_projection() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 2_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 4_000,
                y_start: 0,
                y_end: 4_000,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 4_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };
        let contacts = vec![
            ContactBin {
                source1: "contig-a".to_string(),
                start1: 0,
                source2: "contig-a".to_string(),
                start2: 1_000,
                count: 3.0,
            },
            ContactBin {
                source1: "contig-a".to_string(),
                start1: 500,
                source2: "contig-a".to_string(),
                start2: 1_500,
                count: 7.0,
            },
        ];
        let expected = build_contact_map_view(&query, contacts.clone()).expect("one-shot view");
        let mut projector = ContactMapChunkProjector::new(&query).expect("valid projector");
        let mut delta_counts = std::collections::HashMap::new();
        for contact in contacts {
            projector.push_contact(
                &contact.source1,
                contact.start1,
                &contact.source2,
                contact.start2,
                contact.count,
            );
            for cell in projector.take_view().cells {
                *delta_counts.entry((cell.x_bin, cell.y_bin)).or_insert(0.0) += cell.count;
            }
        }

        assert!(projector.take_view().cells.is_empty());
        assert_eq!(delta_counts.len(), expected.cells.len());
        for cell in expected.cells {
            assert_eq!(delta_counts[&(cell.x_bin, cell.y_bin)], cell.count);
        }
    }

    #[test]
    fn bounded_dense_projector_matches_sparse_projection_and_resets_exactly() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 4_000,
                y_start: 0,
                y_end: 4_000,
            },
            layout_blocks: vec![
                LayoutBlock {
                    id: "copy-forward".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 0,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "copy-reverse".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 2_000,
                    orientation: Orientation::Reverse,
                },
            ],
        };
        let contacts = [
            ("contig-a", 0, "contig-a", 1_000, 8.0),
            ("contig-a", 1_000, "contig-a", 1_000, 4.0),
        ];
        let mut sparse = ContactMapChunkProjector::new(&query).expect("sparse projector");
        let mut dense = ContactMapChunkProjector::new_for_bounded_view(&query, 16)
            .expect("bounded dense projector");
        for (source1, start1, source2, start2, count) in contacts {
            sparse.push_contact(source1, start1, source2, start2, count);
            dense.push_indexed_contact(0, source1, start1, 0, source2, start2, count);
        }

        assert_eq!(dense.pending_cell_count(), sparse.pending_cell_count());
        assert_eq!(dense.take_view(), sparse.take_view());
        assert!(dense.take_view().cells.is_empty());

        let error = ContactMapChunkProjector::new_for_bounded_view(&query, 15)
            .err()
            .expect("undersized bound should fail before allocation");
        assert!(error.to_string().contains("exceeding bound 15"));
    }

    #[test]
    fn chunk_projector_filters_unrequested_tiles_before_aggregation() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 4_000,
                y_start: 0,
                y_end: 4_000,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 4_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };
        let mut projector = ContactMapChunkProjector::new_for_tiles(&query, 2, [(0, 0)])
            .expect("valid tile-filtered projector");
        projector.push_contact("contig-a", 0, "contig-a", 1_000, 3.0);
        projector.push_contact("contig-a", 2_000, "contig-a", 3_000, 7.0);

        assert_eq!(
            projector.take_view().cells,
            vec![ContactMapCell {
                x_bin: 0,
                y_bin: 1,
                count: 3.0,
            }]
        );
    }

    #[test]
    fn aggregates_source_contacts_into_target_resolution_cells_for_layout_blocks() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 2_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 4_000,
                y_start: 0,
                y_end: 4_000,
            },
            layout_blocks: vec![
                LayoutBlock {
                    id: "block-a".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 0,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "block-b".to_string(),
                    source_id: "contig-b".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 2_000,
                    orientation: Orientation::Forward,
                },
            ],
        };
        let contacts = vec![
            ContactBin {
                source1: "contig-a".to_string(),
                start1: 0,
                source2: "contig-b".to_string(),
                start2: 0,
                count: 3.0,
            },
            ContactBin {
                source1: "contig-a".to_string(),
                start1: 1_000,
                source2: "contig-b".to_string(),
                start2: 1_000,
                count: 7.0,
            },
        ];

        let view = build_contact_map_view(&query, contacts).expect("valid query");

        assert_eq!(view.resolution, 2_000);
        assert_eq!(view.cells.len(), 1);
        assert_eq!(view.cells[0].x_bin, 0);
        assert_eq!(view.cells[0].y_bin, 1);
        assert_eq!(view.cells[0].count, 10.0);
    }

    #[test]
    fn keeps_contacts_whose_visual_order_is_inverted_by_layout_reordering() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 1_000,
                y_start: 2_000,
                y_end: 3_000,
            },
            layout_blocks: vec![
                LayoutBlock {
                    id: "block-a".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 2_000,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "block-b".to_string(),
                    source_id: "contig-b".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 0,
                    orientation: Orientation::Forward,
                },
            ],
        };
        let contacts = vec![ContactBin {
            source1: "contig-a".to_string(),
            start1: 0,
            source2: "contig-b".to_string(),
            start2: 0,
            count: 11.0,
        }];

        let view = build_contact_map_view(&query, contacts).expect("valid reordered query");

        assert_eq!(view.cells.len(), 1);
        assert_eq!(view.cells[0].x_bin, 0);
        assert_eq!(view.cells[0].y_bin, 2);
        assert_eq!(view.cells[0].count, 11.0);
    }

    #[test]
    fn maps_reverse_oriented_blocks_without_expanding_dense_matrix() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 2_000,
                y_start: 0,
                y_end: 2_000,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 2_000,
                visual_start: 0,
                orientation: Orientation::Reverse,
            }],
        };
        let contacts = vec![ContactBin {
            source1: "contig-a".to_string(),
            start1: 0,
            source2: "contig-a".to_string(),
            start2: 1_000,
            count: 5.0,
        }];

        let view = build_contact_map_view(&query, contacts).expect("valid query");

        assert_eq!(view.cells.len(), 1);
        assert_eq!(view.cells[0].x_bin, 0);
        assert_eq!(view.cells[0].y_bin, 1);
        assert_eq!(view.cells[0].count, 5.0);
    }

    #[test]
    fn filters_contacts_outside_viewport() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 1_000,
                y_start: 0,
                y_end: 1_000,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 2_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };
        let contacts = vec![
            ContactBin {
                source1: "contig-a".to_string(),
                start1: 0,
                source2: "contig-a".to_string(),
                start2: 0,
                count: 2.0,
            },
            ContactBin {
                source1: "contig-a".to_string(),
                start1: 1_000,
                source2: "contig-a".to_string(),
                start2: 1_000,
                count: 9.0,
            },
        ];

        let view = build_contact_map_view(&query, contacts).expect("valid query");

        assert_eq!(view.cells.len(), 1);
        assert_eq!(view.cells[0].count, 2.0);
    }

    #[test]
    fn builds_view_from_borrowed_contacts_without_consuming_source_vector() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 1_000,
                y_start: 0,
                y_end: 1_000,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 1_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };
        let contacts = vec![ContactBin {
            source1: "contig-a".to_string(),
            start1: 0,
            source2: "contig-a".to_string(),
            start2: 0,
            count: 2.0,
        }];

        let view = build_contact_map_view_from_refs(&query, contacts.iter()).expect("valid query");

        assert_eq!(view.cells.len(), 1);
        assert_eq!(view.cells[0].count, 2.0);
        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].source1, "contig-a");
    }

    #[test]
    fn shares_contacts_equally_across_copied_layout_blocks() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 4_000,
                y_start: 0,
                y_end: 4_000,
            },
            layout_blocks: vec![
                LayoutBlock {
                    id: "block-a".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 0,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "block-b".to_string(),
                    source_id: "contig-b".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 1_000,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "block-a_d2".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 2_000,
                    orientation: Orientation::Forward,
                },
            ],
        };
        let contacts = vec![ContactBin {
            source1: "contig-a".to_string(),
            start1: 0,
            source2: "contig-b".to_string(),
            start2: 0,
            count: 5.0,
        }];

        let view = build_contact_map_view(&query, contacts).expect("valid query");

        assert_eq!(
            view.cells
                .iter()
                .map(|cell| (cell.x_bin, cell.y_bin, cell.count))
                .collect::<Vec<_>>(),
            vec![(0, 1, 2.5), (1, 2, 2.5)]
        );
        assert_eq!(view.cells.iter().map(|cell| cell.count).sum::<f64>(), 5.0);
    }

    #[test]
    fn shares_contacts_by_the_local_copy_number_at_each_endpoint() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 7_000,
                y_start: 0,
                y_end: 7_000,
            },
            layout_blocks: vec![
                LayoutBlock {
                    id: "a-1".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 0,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "a-2".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 1_000,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "b-1".to_string(),
                    source_id: "contig-b".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 2_000,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "b-2".to_string(),
                    source_id: "contig-b".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 3_000,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "b-3".to_string(),
                    source_id: "contig-b".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 4_000,
                    orientation: Orientation::Forward,
                },
            ],
        };
        let contacts = vec![ContactBin {
            source1: "contig-a".to_string(),
            start1: 0,
            source2: "contig-b".to_string(),
            start2: 0,
            count: 12.0,
        }];

        let view = build_contact_map_view(&query, contacts).expect("valid query");

        assert_eq!(view.cells.len(), 6);
        assert!(view.cells.iter().all(|cell| cell.count == 2.0));
        assert_eq!(view.cells.iter().map(|cell| cell.count).sum::<f64>(), 12.0);
    }

    #[test]
    fn deleting_a_copy_restores_the_full_contact_share_to_the_remaining_placement() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 2_000,
                y_start: 0,
                y_end: 2_000,
            },
            layout_blocks: vec![
                LayoutBlock {
                    id: "remaining-a".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 0,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "b".to_string(),
                    source_id: "contig-b".to_string(),
                    source_start: 0,
                    source_end: 1_000,
                    visual_start: 1_000,
                    orientation: Orientation::Forward,
                },
            ],
        };
        let contacts = vec![ContactBin {
            source1: "contig-a".to_string(),
            start1: 0,
            source2: "contig-b".to_string(),
            start2: 0,
            count: 8.0,
        }];

        let view = build_contact_map_view(&query, contacts).expect("valid query");

        assert_eq!(view.cells.len(), 1);
        assert_eq!(view.cells[0].count, 8.0);
    }

    #[test]
    fn rejects_target_resolution_that_is_not_a_multiple_of_base_resolution() {
        let query = ContactMapQuery {
            base_resolution: 1_000,
            target_resolution: 1_500,
            viewport: Viewport {
                x_start: 0,
                x_end: 1_000,
                y_start: 0,
                y_end: 1_000,
            },
            layout_blocks: Vec::new(),
        };

        let error = build_contact_map_view(&query, Vec::new()).expect_err("invalid resolution");

        assert_eq!(
            error.to_string(),
            "invalid contact map query: target_resolution must be a positive multiple of base_resolution"
        );
    }
}
