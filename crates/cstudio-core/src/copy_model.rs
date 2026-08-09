use crate::{CStudioError, CStudioResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMetadata {
    source_id: String,
    copy_index: u32,
    copy_number: u32,
}

impl CopyMetadata {
    pub fn new(
        source_id: impl Into<String>,
        copy_index: u32,
        copy_number: u32,
    ) -> CStudioResult<Self> {
        let source_id = source_id.into();

        if source_id.trim().is_empty() {
            return Err(CStudioError::InvalidCopyMetadata(
                "source_id cannot be empty".to_string(),
            ));
        }

        if copy_index == 0 {
            return Err(CStudioError::InvalidCopyMetadata(
                "copy_index must be at least 1".to_string(),
            ));
        }

        if copy_number < copy_index {
            return Err(CStudioError::InvalidCopyMetadata(
                "copy_number must be greater than or equal to copy_index".to_string(),
            ));
        }

        Ok(Self {
            source_id,
            copy_index,
            copy_number,
        })
    }

    pub fn source_id(&self) -> &str {
        &self.source_id
    }

    pub fn copy_index(&self) -> u32 {
        self.copy_index
    }

    pub fn copy_number(&self) -> u32 {
        self.copy_number
    }

    pub fn copy_id(&self) -> String {
        format!("{}_copy{}", self.source_id, self.copy_index)
    }
}

#[cfg(test)]
mod tests {
    use super::CopyMetadata;

    #[test]
    fn creates_stable_copy_id_from_source_and_index() {
        let metadata = CopyMetadata::new("utg000123", 2, 3).expect("valid metadata");

        assert_eq!(metadata.copy_id(), "utg000123_copy2");
        assert_eq!(metadata.source_id(), "utg000123");
        assert_eq!(metadata.copy_index(), 2);
        assert_eq!(metadata.copy_number(), 3);
    }
}
