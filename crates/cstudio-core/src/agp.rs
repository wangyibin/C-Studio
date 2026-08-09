use std::collections::HashSet;

use crate::{coords::AgpInterval, CStudioError, CStudioResult};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AgpComponentType {
    WgsContig,
    Fragment,
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Orientation {
    Forward,
    Reverse,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgpComponent {
    pub object_id: String,
    pub object_interval: AgpInterval,
    pub part_number: u32,
    pub component_type: AgpComponentType,
    pub component_id: String,
    pub component_interval: AgpInterval,
    pub orientation: Orientation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgpSummary {
    pub line_count: usize,
    pub object_count: usize,
    pub component_count: usize,
    pub gap_count: usize,
    pub max_object_span: u64,
}

impl AgpSummary {
    pub fn parse(input: &str) -> CStudioResult<Self> {
        let mut line_count = 0;
        let mut component_count = 0;
        let mut gap_count = 0;
        let mut max_object_span = 0;
        let mut objects = HashSet::new();

        for (index, raw_line) in input.lines().enumerate() {
            let line = raw_line.trim();

            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let columns: Vec<&str> = line.split('\t').collect();
            if columns.len() != 9 {
                return Err(CStudioError::InvalidAgp(format!(
                    "line {} has {} columns; expected 9",
                    index + 1,
                    columns.len()
                )));
            }

            let object_end = columns[2].parse::<u64>().map_err(|_| {
                CStudioError::InvalidAgp(format!("line {} has invalid object end", index + 1))
            })?;

            line_count += 1;
            objects.insert(columns[0].to_string());
            max_object_span = max_object_span.max(object_end);

            match columns[4] {
                "N" | "U" => gap_count += 1,
                _ => component_count += 1,
            }
        }

        Ok(Self {
            line_count,
            object_count: objects.len(),
            component_count,
            gap_count,
            max_object_span,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::AgpSummary;

    #[test]
    fn summarizes_example_agp_file() {
        let agp = include_str!("../../../examples/groups.agp");

        let summary = AgpSummary::parse(agp).expect("example AGP should parse");

        assert_eq!(summary.line_count, 2_576);
        assert_eq!(summary.object_count, 20);
        assert_eq!(summary.component_count, 1_298);
        assert_eq!(summary.gap_count, 1_278);
        assert_eq!(summary.max_object_span, 30_436_571);
    }
}
