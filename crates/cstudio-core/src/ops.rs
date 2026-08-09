use crate::coords::Interval;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitOperation {
    pub block_id: String,
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveOperation {
    pub block_id: String,
    pub target_scaffold_id: String,
    pub target_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlipOperation {
    pub block_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyOperation {
    pub source_block_id: String,
    pub source_interval: Interval,
    pub target_scaffold_id: String,
    pub target_index: usize,
    pub copy_number: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditOperation {
    Split(SplitOperation),
    Move(MoveOperation),
    Flip(FlipOperation),
    Copy(CopyOperation),
}
