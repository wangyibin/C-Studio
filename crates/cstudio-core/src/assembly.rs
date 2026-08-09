use crate::{agp::Orientation, coords::Interval, copy_model::CopyMetadata};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceContig {
    pub id: String,
    pub length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssemblyBlock {
    pub id: String,
    pub source_id: String,
    pub source_interval: Interval,
    pub orientation: Orientation,
    pub copy: Option<CopyMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scaffold {
    pub id: String,
    pub blocks: Vec<AssemblyBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AssemblyDocument {
    pub sources: Vec<SourceContig>,
    pub scaffolds: Vec<Scaffold>,
}
