use std::collections::HashMap;

use crate::{
    agp::Orientation,
    contact_map::{LayoutBlock, Viewport},
    CStudioError, CStudioResult,
};

#[derive(Debug, Clone, PartialEq)]
pub struct SyntenyQuery {
    pub viewport: Viewport,
    pub layout_blocks: Vec<LayoutBlock>,
    pub min_mapq: u8,
    pub min_alignment_len: u64,
    pub max_query_gap: u64,
    pub max_target_gap: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PafRecord {
    pub query_name: String,
    pub query_len: u64,
    pub query_start: u64,
    pub query_end: u64,
    pub strand: char,
    pub target_name: String,
    pub target_len: u64,
    pub target_start: u64,
    pub target_end: u64,
    pub residue_matches: u64,
    pub alignment_block_len: u64,
    pub mapq: u8,
}

impl PafRecord {
    pub fn parse_line(line: &str) -> CStudioResult<Option<Self>> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return Ok(None);
        }

        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 12 {
            return Err(CStudioError::InvalidContactMapQuery(
                "PAF line must contain at least 12 columns".to_string(),
            ));
        }

        let strand = columns[4].chars().next().ok_or_else(|| {
            CStudioError::InvalidContactMapQuery("PAF strand cannot be empty".to_string())
        })?;
        if strand != '+' && strand != '-' {
            return Err(CStudioError::InvalidContactMapQuery(
                "PAF strand must be + or -".to_string(),
            ));
        }

        Ok(Some(Self {
            query_name: columns[0].to_string(),
            query_len: parse_u64(columns[1], "PAF query length")?,
            query_start: parse_u64(columns[2], "PAF query start")?,
            query_end: parse_u64(columns[3], "PAF query end")?,
            strand,
            target_name: columns[5].to_string(),
            target_len: parse_u64(columns[6], "PAF target length")?,
            target_start: parse_u64(columns[7], "PAF target start")?,
            target_end: parse_u64(columns[8], "PAF target end")?,
            residue_matches: parse_u64(columns[9], "PAF residue matches")?,
            alignment_block_len: parse_u64(columns[10], "PAF alignment block length")?,
            mapq: columns[11].parse::<u8>().map_err(|_| {
                CStudioError::InvalidContactMapQuery("PAF mapq must be an integer".to_string())
            })?,
        }))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SyntenyView {
    pub viewport: Viewport,
    pub blocks: Vec<SyntenyBlock>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SyntenyBlock {
    pub assembly_block_id: String,
    pub query_source_id: String,
    pub visual_start: u64,
    pub visual_end: u64,
    pub target_id: String,
    pub target_start: u64,
    pub target_end: u64,
    pub strand: char,
    pub mapq: u8,
    pub alignment_count: usize,
}

pub fn build_synteny_view<I>(query: &SyntenyQuery, records: I) -> CStudioResult<SyntenyView>
where
    I: IntoIterator<Item = PafRecord>,
{
    let mut builder = SyntenyViewBuilder::new(query)?;

    for record in records {
        builder.add_record(record)?;
    }

    Ok(builder.finish())
}

pub struct SyntenyViewBuilder<'a> {
    query: &'a SyntenyQuery,
    block_index: SyntenyBlockIndex<'a>,
    segments: Vec<SyntenyBlock>,
}

impl<'a> SyntenyViewBuilder<'a> {
    pub fn new(query: &'a SyntenyQuery) -> CStudioResult<Self> {
        validate_query(query)?;

        Ok(Self {
            query,
            block_index: SyntenyBlockIndex::new(&query.layout_blocks),
            segments: Vec::new(),
        })
    }

    pub fn add_record(&mut self, record: PafRecord) -> CStudioResult<()> {
        self.add_record_ref(&record)
    }

    pub fn add_record_ref(&mut self, record: &PafRecord) -> CStudioResult<()> {
        if record.mapq < self.query.min_mapq
            || record.alignment_block_len < self.query.min_alignment_len
        {
            return Ok(());
        }
        if record.query_start >= record.query_end || record.target_start >= record.target_end {
            return Err(CStudioError::InvalidContactMapQuery(
                "PAF alignment start must be less than end".to_string(),
            ));
        }

        let Some(blocks) = self.block_index.by_source.get(record.query_name.as_str()) else {
            return Ok(());
        };

        for block in blocks {
            let overlap_start = record.query_start.max(block.source_start);
            let overlap_end = record.query_end.min(block.source_end);
            if overlap_start >= overlap_end {
                continue;
            }

            let Some(mut segment) =
                map_overlap_to_segment(self.query, block, record, overlap_start, overlap_end)
            else {
                continue;
            };
            if segment.visual_start > segment.visual_end {
                std::mem::swap(&mut segment.visual_start, &mut segment.visual_end);
            }
            if overlaps_viewport(
                self.query.viewport,
                segment.visual_start,
                segment.visual_end,
            ) {
                self.segments.push(segment);
            }
        }

        Ok(())
    }

    pub fn finish(self) -> SyntenyView {
        SyntenyView {
            viewport: self.query.viewport,
            blocks: merge_segments(self.query, self.segments),
        }
    }
}

fn map_overlap_to_segment(
    query: &SyntenyQuery,
    block: &LayoutBlock,
    record: &PafRecord,
    overlap_start: u64,
    overlap_end: u64,
) -> Option<SyntenyBlock> {
    let (visual_start, visual_end) = visual_interval(block, overlap_start, overlap_end)?;
    let overlap_len = overlap_end - overlap_start;
    if overlap_len < query.min_alignment_len {
        return None;
    }

    let query_offset_start = overlap_start - record.query_start;
    let query_offset_end = overlap_end - record.query_start;
    let target_span = record.target_end - record.target_start;
    let query_span = record.query_end - record.query_start;
    let target_start = record.target_start + target_span * query_offset_start / query_span;
    let target_end = record.target_start + target_span * query_offset_end / query_span;
    let strand = relative_strand(record.strand, block.orientation.clone());

    Some(SyntenyBlock {
        assembly_block_id: block.id.clone(),
        query_source_id: record.query_name.clone(),
        visual_start,
        visual_end,
        target_id: record.target_name.clone(),
        target_start,
        target_end,
        strand,
        mapq: record.mapq,
        alignment_count: 1,
    })
}

fn visual_interval(block: &LayoutBlock, source_start: u64, source_end: u64) -> Option<(u64, u64)> {
    if source_start < block.source_start
        || source_end > block.source_end
        || source_start >= source_end
    {
        return None;
    }

    let result = match block.orientation {
        Orientation::Forward | Orientation::Unknown => {
            let start = block.visual_start + (source_start - block.source_start);
            let end = block.visual_start + (source_end - block.source_start);
            (start, end)
        }
        Orientation::Reverse => {
            let start = block.visual_start + (block.source_end - source_end);
            let end = block.visual_start + (block.source_end - source_start);
            (start, end)
        }
    };

    Some(result)
}

fn merge_segments(query: &SyntenyQuery, mut segments: Vec<SyntenyBlock>) -> Vec<SyntenyBlock> {
    segments.sort_by(|a, b| {
        (
            a.assembly_block_id.as_str(),
            a.query_source_id.as_str(),
            a.target_id.as_str(),
            a.strand,
            a.visual_start,
            a.target_start,
        )
            .cmp(&(
                b.assembly_block_id.as_str(),
                b.query_source_id.as_str(),
                b.target_id.as_str(),
                b.strand,
                b.visual_start,
                b.target_start,
            ))
    });

    let mut merged: Vec<SyntenyBlock> = Vec::new();
    for segment in segments {
        if let Some(last) = merged.last_mut() {
            let query_gap = segment.visual_start.saturating_sub(last.visual_end);
            let target_gap = if segment.target_start >= last.target_end {
                segment.target_start - last.target_end
            } else {
                last.target_start.saturating_sub(segment.target_end)
            };

            if last.assembly_block_id == segment.assembly_block_id
                && last.query_source_id == segment.query_source_id
                && last.target_id == segment.target_id
                && last.strand == segment.strand
                && query_gap <= query.max_query_gap
                && target_gap <= query.max_target_gap
            {
                last.visual_end = last.visual_end.max(segment.visual_end);
                last.target_start = last.target_start.min(segment.target_start);
                last.target_end = last.target_end.max(segment.target_end);
                last.mapq = last.mapq.min(segment.mapq);
                last.alignment_count += segment.alignment_count;
                continue;
            }
        }

        merged.push(segment);
    }

    merged
}

fn validate_query(query: &SyntenyQuery) -> CStudioResult<()> {
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

fn overlaps_viewport(viewport: Viewport, start: u64, end: u64) -> bool {
    start < viewport.x_end && end > viewport.x_start
}

fn relative_strand(paf_strand: char, orientation: Orientation) -> char {
    match (paf_strand, orientation) {
        ('+', Orientation::Reverse) | ('-', Orientation::Forward) | ('-', Orientation::Unknown) => {
            '-'
        }
        _ => '+',
    }
}

fn parse_u64(value: &str, label: &str) -> CStudioResult<u64> {
    value
        .parse::<u64>()
        .map_err(|_| CStudioError::InvalidContactMapQuery(format!("{label} must be an integer")))
}

struct SyntenyBlockIndex<'a> {
    by_source: HashMap<&'a str, Vec<&'a LayoutBlock>>,
}

impl<'a> SyntenyBlockIndex<'a> {
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
        synteny::{build_synteny_view, PafRecord, SyntenyQuery},
    };

    #[test]
    fn parses_standard_paf_line() {
        let record = PafRecord::parse_line(
            "contig-a\t10000\t1000\t3000\t+\tmono1\t50000\t20000\t22000\t1900\t2000\t60",
        )
        .expect("valid paf")
        .expect("data record");

        assert_eq!(record.query_name, "contig-a");
        assert_eq!(record.query_start, 1_000);
        assert_eq!(record.query_end, 3_000);
        assert_eq!(record.strand, '+');
        assert_eq!(record.target_name, "mono1");
        assert_eq!(record.target_start, 20_000);
        assert_eq!(record.target_end, 22_000);
        assert_eq!(record.mapq, 60);
    }

    #[test]
    fn maps_paf_records_to_current_visual_layout_and_merges_adjacent_blocks() {
        let query = SyntenyQuery {
            viewport: Viewport {
                x_start: 0,
                x_end: 5_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 5_000,
                visual_start: 0,
                orientation: Orientation::Forward,
            }],
            min_mapq: 20,
            min_alignment_len: 500,
            max_query_gap: 200,
            max_target_gap: 200,
        };
        let records = vec![
            PafRecord::parse_line(
                "contig-a\t5000\t0\t1000\t+\tmono1\t50000\t10000\t11000\t950\t1000\t60",
            )
            .unwrap()
            .unwrap(),
            PafRecord::parse_line(
                "contig-a\t5000\t1100\t2000\t+\tmono1\t50000\t11100\t12000\t850\t900\t55",
            )
            .unwrap()
            .unwrap(),
        ];

        let view = build_synteny_view(&query, records).expect("valid synteny query");

        assert_eq!(view.blocks.len(), 1);
        assert_eq!(view.blocks[0].assembly_block_id, "block-a");
        assert_eq!(view.blocks[0].visual_start, 0);
        assert_eq!(view.blocks[0].visual_end, 2_000);
        assert_eq!(view.blocks[0].target_id, "mono1");
        assert_eq!(view.blocks[0].target_start, 10_000);
        assert_eq!(view.blocks[0].target_end, 12_000);
        assert_eq!(view.blocks[0].alignment_count, 2);
    }

    #[test]
    fn reverse_layout_blocks_flip_visual_coordinates_and_relative_strand() {
        let query = SyntenyQuery {
            viewport: Viewport {
                x_start: 0,
                x_end: 5_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![LayoutBlock {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 5_000,
                visual_start: 0,
                orientation: Orientation::Reverse,
            }],
            min_mapq: 0,
            min_alignment_len: 1,
            max_query_gap: 100,
            max_target_gap: 100,
        };
        let records = vec![PafRecord::parse_line(
            "contig-a\t5000\t0\t1000\t+\tmono1\t50000\t10000\t11000\t900\t1000\t60",
        )
        .unwrap()
        .unwrap()];

        let view = build_synteny_view(&query, records).expect("valid synteny query");

        assert_eq!(view.blocks.len(), 1);
        assert_eq!(view.blocks[0].visual_start, 4_000);
        assert_eq!(view.blocks[0].visual_end, 5_000);
        assert_eq!(view.blocks[0].strand, '-');
    }

    #[test]
    fn copied_blocks_reuse_paf_alignments_and_deleted_blocks_are_absent() {
        let query = SyntenyQuery {
            viewport: Viewport {
                x_start: 0,
                x_end: 6_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![
                LayoutBlock {
                    id: "copy-1".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 0,
                    orientation: Orientation::Forward,
                },
                LayoutBlock {
                    id: "copy-2".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 3_000,
                    orientation: Orientation::Forward,
                },
            ],
            min_mapq: 0,
            min_alignment_len: 1,
            max_query_gap: 100,
            max_target_gap: 100,
        };
        let records = vec![
            PafRecord::parse_line(
                "contig-a\t2000\t0\t1000\t+\tmono1\t50000\t10000\t11000\t900\t1000\t60",
            )
            .unwrap()
            .unwrap(),
            PafRecord::parse_line(
                "deleted-contig\t2000\t0\t1000\t+\tmono2\t50000\t20000\t21000\t900\t1000\t60",
            )
            .unwrap()
            .unwrap(),
        ];

        let view = build_synteny_view(&query, records).expect("valid synteny query");

        assert_eq!(view.blocks.len(), 2);
        assert_eq!(
            view.blocks
                .iter()
                .map(|block| block.assembly_block_id.as_str())
                .collect::<Vec<_>>(),
            vec!["copy-1", "copy-2"]
        );
        assert_eq!(
            view.blocks
                .iter()
                .map(|block| block.visual_start)
                .collect::<Vec<_>>(),
            vec![0, 3_000]
        );
        assert!(view.blocks.iter().all(|block| block.target_id == "mono1"));
    }
}
