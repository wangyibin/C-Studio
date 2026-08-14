pub mod agp;
pub mod assembly;
pub mod contact_cache;
pub mod contact_map;
pub mod contact_normalization;
pub mod cool;
pub mod coords;
pub mod copy_model;
pub mod coverage;
pub mod coverage_cache;
pub mod error;
pub mod gfa_layout;
pub mod ops;
pub mod source_contact_cache;
pub mod synteny;
pub mod synteny_cache;

pub use error::{CStudioError, CStudioResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreStatus {
    pub engine: &'static str,
    pub coordinate_convention: &'static str,
    pub supported_operations: Vec<&'static str>,
}

pub fn core_status() -> CoreStatus {
    CoreStatus {
        engine: "cstudio-core",
        coordinate_convention: "0-based half-open internal; 1-based closed AGP",
        supported_operations: vec!["split", "move", "flip", "copy"],
    }
}
