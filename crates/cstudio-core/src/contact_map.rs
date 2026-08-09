use std::collections::HashMap;

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
    validate_query(query)?;

    let block_index = LayoutBlockIndex::new(&query.layout_blocks);
    let mut aggregate: HashMap<(u64, u64), f64> = HashMap::new();

    for contact in contacts {
        let x_positions = block_index.visual_positions(contact.source1(), contact.start1());
        if x_positions.is_empty() {
            continue;
        }
        let y_positions = block_index.visual_positions(contact.source2(), contact.start2());
        if y_positions.is_empty() {
            continue;
        }

        for x in &x_positions {
            for y in &y_positions {
                // Cooler contacts are canonical in source coordinates, but a
                // layout reorder can invert their visual coordinates. The
                // contact map stores only the visual upper triangle, so
                // canonicalize before viewport filtering as well as binning.
                let (visual_x, visual_y) = if x <= y { (*x, *y) } else { (*y, *x) };
                if !query.viewport.contains(visual_x, visual_y) {
                    continue;
                }

                let x_bin = visual_x / query.target_resolution;
                let y_bin = visual_y / query.target_resolution;

                *aggregate.entry((x_bin, y_bin)).or_insert(0.0) += contact.count();
            }
        }
    }

    let mut cells: Vec<ContactMapCell> = aggregate
        .into_iter()
        .map(|((x_bin, y_bin), count)| ContactMapCell {
            x_bin,
            y_bin,
            count,
        })
        .collect();
    cells.sort_by_key(|cell| (cell.x_bin, cell.y_bin));

    Ok(ContactMapView {
        resolution: query.target_resolution,
        viewport: query.viewport,
        cells,
    })
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
    by_source: HashMap<&'a str, Vec<&'a LayoutBlock>>,
}

impl<'a> LayoutBlockIndex<'a> {
    fn new(blocks: &'a [LayoutBlock]) -> Self {
        let mut by_source: HashMap<&'a str, Vec<&'a LayoutBlock>> = HashMap::new();
        for block in blocks {
            by_source
                .entry(block.source_id.as_str())
                .or_default()
                .push(block);
        }

        Self { by_source }
    }

    fn visual_positions(&self, source_id: &str, source_start: u64) -> Vec<u64> {
        self.by_source
            .get(source_id)
            .into_iter()
            .flatten()
            .filter_map(|block| block.visual_position(source_start))
            .collect()
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
    use crate::{
        agp::Orientation,
        contact_map::{
            build_contact_map_view, build_contact_map_view_from_refs, ContactBin, ContactMapQuery,
            LayoutBlock, Viewport,
        },
    };

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
    fn expands_contacts_for_copied_layout_blocks_sharing_source_ids() {
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
            vec![(0, 1, 5.0), (1, 2, 5.0)]
        );
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
