use std::collections::HashMap;

use crate::{
    agp::Orientation,
    contact_map::{LayoutBlock, Viewport},
    CStudioError, CStudioResult,
};

#[derive(Debug, Clone, PartialEq)]
pub struct CoverageQuery {
    pub display_resolution: u64,
    pub viewport: Viewport,
    pub layout_blocks: Vec<LayoutBlock>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BedGraphRecord {
    pub chrom: String,
    pub start: u64,
    pub end: u64,
    pub value: f64,
}

impl BedGraphRecord {
    pub fn parse_line(line: &str) -> CStudioResult<Option<Self>> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return Ok(None);
        }

        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 4 {
            return Err(CStudioError::InvalidContactMapQuery(
                "bedGraph line must contain chrom, start, end, and value".to_string(),
            ));
        }

        let start = columns[1].parse::<u64>().map_err(|_| {
            CStudioError::InvalidContactMapQuery("bedGraph start must be an integer".to_string())
        })?;
        let end = columns[2].parse::<u64>().map_err(|_| {
            CStudioError::InvalidContactMapQuery("bedGraph end must be an integer".to_string())
        })?;
        let value = columns[3].parse::<f64>().map_err(|_| {
            CStudioError::InvalidContactMapQuery("bedGraph value must be numeric".to_string())
        })?;

        Ok(Some(Self {
            chrom: columns[0].to_string(),
            start,
            end,
            value,
        }))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoverageView {
    pub resolution: u64,
    pub viewport: Viewport,
    pub bins: Vec<CoverageBin>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoverageBin {
    pub x_bin: u64,
    pub value: f64,
}

pub fn build_coverage_view<I>(query: &CoverageQuery, records: I) -> CStudioResult<CoverageView>
where
    I: IntoIterator<Item = BedGraphRecord>,
{
    let mut builder = CoverageViewBuilder::new(query)?;

    for record in records {
        builder.add_record(record)?;
    }

    Ok(builder.finish())
}

pub struct CoverageViewBuilder<'a> {
    query: &'a CoverageQuery,
    block_index: CoverageBlockIndex<'a>,
    viewport_start_bin: u64,
    viewport_end_bin: u64,
    aggregate: HashMap<u64, WeightedCoverage>,
}

impl<'a> CoverageViewBuilder<'a> {
    pub fn new(query: &'a CoverageQuery) -> CStudioResult<Self> {
        validate_query(query)?;

        Ok(Self {
            query,
            block_index: CoverageBlockIndex::new(&query.layout_blocks),
            viewport_start_bin: query.viewport.x_start / query.display_resolution,
            viewport_end_bin: (query.viewport.x_end - 1) / query.display_resolution,
            aggregate: HashMap::new(),
        })
    }

    pub fn add_record(&mut self, record: BedGraphRecord) -> CStudioResult<()> {
        self.add_record_fields(&record.chrom, record.start, record.end, record.value)
    }

    pub fn add_record_fields(
        &mut self,
        chrom: &str,
        start: u64,
        end: u64,
        value: f64,
    ) -> CStudioResult<()> {
        if start >= end {
            return Err(CStudioError::InvalidContactMapQuery(
                "bedGraph record start must be less than end".to_string(),
            ));
        }

        let Some(blocks) = self.block_index.by_source.get(chrom) else {
            return Ok(());
        };

        for block in blocks {
            let overlap_start = start.max(block.source_start);
            let overlap_end = end.min(block.source_end);
            if overlap_start >= overlap_end {
                continue;
            }

            let mut source = overlap_start;
            while source < overlap_end {
                let visual = block
                    .visual_position(source)
                    .expect("overlap is inside block");
                let x_bin = visual / self.query.display_resolution;
                let (placement_count, next_placement_boundary) =
                    placement_count_and_next_boundary(blocks, source, overlap_end);
                let step =
                    contiguous_step(block, source, overlap_end, self.query.display_resolution)
                        .min(next_placement_boundary.saturating_sub(source))
                        .max(1);

                if x_bin < self.viewport_start_bin || x_bin > self.viewport_end_bin {
                    source += step;
                    continue;
                }

                self.aggregate
                    .entry(x_bin)
                    .or_default()
                    .add(value / placement_count as f64, step);
                source += step;
            }
        }

        Ok(())
    }

    pub fn finish(self) -> CoverageView {
        let mut bins: Vec<CoverageBin> = self
            .aggregate
            .into_iter()
            .map(|(x_bin, coverage)| CoverageBin {
                x_bin,
                value: coverage.average(),
            })
            .collect();
        bins.sort_by_key(|bin| bin.x_bin);

        CoverageView {
            resolution: self.query.display_resolution,
            viewport: self.query.viewport,
            bins,
        }
    }
}

fn placement_count_and_next_boundary(
    blocks: &[&LayoutBlock],
    source: u64,
    overlap_end: u64,
) -> (usize, u64) {
    let mut placement_count = 0;
    let mut next_boundary = overlap_end;

    for block in blocks {
        if source >= block.source_start && source < block.source_end {
            placement_count += 1;
            next_boundary = next_boundary.min(block.source_end);
        } else if block.source_start > source {
            next_boundary = next_boundary.min(block.source_start);
        }
    }

    // The caller only asks about coordinates inside its current block.
    debug_assert!(placement_count > 0);
    (placement_count.max(1), next_boundary)
}

fn validate_query(query: &CoverageQuery) -> CStudioResult<()> {
    if query.display_resolution == 0 {
        return Err(CStudioError::InvalidContactMapQuery(
            "display_resolution must be positive".to_string(),
        ));
    }

    if query.viewport.x_start >= query.viewport.x_end {
        return Err(CStudioError::InvalidContactMapQuery(
            "viewport x_start must be less than x_end".to_string(),
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

fn contiguous_step(
    block: &LayoutBlock,
    source: u64,
    overlap_end: u64,
    display_resolution: u64,
) -> u64 {
    let visual = block
        .visual_position(source)
        .expect("source is inside block");
    let bin_start = visual / display_resolution * display_resolution;
    let bin_end = bin_start + display_resolution;
    let source_bin_edge = match block.orientation {
        Orientation::Forward | Orientation::Unknown => {
            block.source_start + (bin_end - block.visual_start)
        }
        Orientation::Reverse => {
            let block_len = block.source_end - block.source_start;
            let visual_bin_start_offset = bin_start.saturating_sub(block.visual_start);
            block.source_start + block_len - visual_bin_start_offset
        }
    };

    let next_edge = source_bin_edge.min(overlap_end);
    next_edge.saturating_sub(source).max(1)
}

#[derive(Default)]
struct WeightedCoverage {
    weighted_sum: f64,
    length: u64,
}

impl WeightedCoverage {
    fn add(&mut self, value: f64, length: u64) {
        self.weighted_sum += value * length as f64;
        self.length += length;
    }

    fn average(&self) -> f64 {
        if self.length == 0 {
            0.0
        } else {
            self.weighted_sum / self.length as f64
        }
    }
}

struct CoverageBlockIndex<'a> {
    by_source: HashMap<&'a str, Vec<&'a LayoutBlock>>,
}

impl<'a> CoverageBlockIndex<'a> {
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
}

#[cfg(test)]
mod tests {
    use crate::{
        agp::Orientation,
        contact_map::{LayoutBlock, Viewport},
        coverage::{build_coverage_view, BedGraphRecord, CoverageQuery},
    };

    #[test]
    fn fills_finer_display_bins_from_coarser_bedgraph_window() {
        let query = CoverageQuery {
            display_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 4_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 10_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };
        let records = vec![BedGraphRecord {
            chrom: "contig-a".to_string(),
            start: 0,
            end: 10_000,
            value: 42.0,
        }];

        let view = build_coverage_view(&query, records).expect("valid query");

        assert_eq!(view.resolution, 1_000);
        assert_eq!(view.bins.len(), 4);
        assert!(view.bins.iter().all(|bin| bin.value == 42.0));
        assert_eq!(
            view.bins.iter().map(|bin| bin.x_bin).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn averages_multiple_bedgraph_records_inside_coarser_display_bin() {
        let query = CoverageQuery {
            display_resolution: 10_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 10_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 10_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };
        let records = vec![
            BedGraphRecord {
                chrom: "contig-a".to_string(),
                start: 0,
                end: 5_000,
                value: 10.0,
            },
            BedGraphRecord {
                chrom: "contig-a".to_string(),
                start: 5_000,
                end: 10_000,
                value: 30.0,
            },
        ];

        let view = build_coverage_view(&query, records).expect("valid query");

        assert_eq!(view.bins.len(), 1);
        assert_eq!(view.bins[0].x_bin, 0);
        assert_eq!(view.bins[0].value, 20.0);
    }

    #[test]
    fn duplicated_layout_blocks_share_source_coverage_without_mutating_records() {
        let query = CoverageQuery {
            display_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 4_000,
                y_start: 0,
                y_end: 1,
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
                    id: "block-a-copy".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 2_000,
                    orientation: Orientation::Forward,
                },
            ],
        };
        let records = vec![BedGraphRecord {
            chrom: "contig-a".to_string(),
            start: 0,
            end: 2_000,
            value: 50.0,
        }];

        let view = build_coverage_view(&query, records).expect("valid query");

        assert_eq!(view.bins.len(), 4);
        assert!(view.bins.iter().all(|bin| bin.value == 25.0));
    }

    #[test]
    fn partial_copy_boundaries_change_coverage_share_inside_a_display_bin() {
        let query = CoverageQuery {
            display_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 3_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![
                LayoutBlock {
                    id: "original".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 0,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "partial-copy".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 500,
                    source_end: 1_500,
                    visual_start: 2_000,
                    orientation: Orientation::Forward,
                },
            ],
        };
        let records = vec![BedGraphRecord {
            chrom: "contig-a".to_string(),
            start: 0,
            end: 2_000,
            value: 60.0,
        }];

        let view = build_coverage_view(&query, records).expect("valid query");

        assert_eq!(
            view.bins
                .iter()
                .map(|bin| (bin.x_bin, bin.value))
                .collect::<Vec<_>>(),
            vec![(0, 45.0), (1, 45.0), (2, 30.0)]
        );
    }

    #[test]
    fn deleting_a_copy_restores_full_coverage_to_the_remaining_placement() {
        let query = CoverageQuery {
            display_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 2_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![LayoutBlock {
                id: "remaining".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 2_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };
        let records = vec![BedGraphRecord {
            chrom: "contig-a".to_string(),
            start: 0,
            end: 2_000,
            value: 50.0,
        }];

        let view = build_coverage_view(&query, records).expect("valid query");

        assert_eq!(view.bins.len(), 2);
        assert!(view.bins.iter().all(|bin| bin.value == 50.0));
    }

    #[test]
    fn deleted_blocks_disappear_when_omitted_from_layout() {
        let query = CoverageQuery {
            display_resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 4_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![LayoutBlock {
                id: "kept".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 2_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
        };
        let records = vec![
            BedGraphRecord {
                chrom: "contig-a".to_string(),
                start: 0,
                end: 2_000,
                value: 11.0,
            },
            BedGraphRecord {
                chrom: "contig-b".to_string(),
                start: 0,
                end: 2_000,
                value: 99.0,
            },
        ];

        let view = build_coverage_view(&query, records).expect("valid query");

        assert_eq!(view.bins.len(), 2);
        assert!(view.bins.iter().all(|bin| bin.value == 11.0));
    }

    #[test]
    fn parses_bedgraph_line_for_streaming_import() {
        let record = BedGraphRecord::parse_line("contig-a\t1000\t2000\t17.5")
            .expect("valid bedGraph line")
            .expect("data record");

        assert_eq!(record.chrom, "contig-a");
        assert_eq!(record.start, 1_000);
        assert_eq!(record.end, 2_000);
        assert_eq!(record.value, 17.5);
    }
}
