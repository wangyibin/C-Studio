use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CStudioError {
    InvalidInterval { start: u64, end: u64 },
    InvalidAgpInterval { start: u64, end: u64 },
    InvalidCopyMetadata(String),
    InvalidAgp(String),
    InvalidContactMapQuery(String),
}

pub type CStudioResult<T> = Result<T, CStudioError>;

impl fmt::Display for CStudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInterval { start, end } => {
                write!(
                    f,
                    "invalid interval: start {start} must be less than end {end}"
                )
            }
            Self::InvalidAgpInterval { start, end } => {
                write!(
                    f,
                    "invalid AGP interval: start {start} and end {end} must be 1-based closed coordinates"
                )
            }
            Self::InvalidCopyMetadata(message) => write!(f, "invalid copy metadata: {message}"),
            Self::InvalidAgp(message) => write!(f, "invalid AGP: {message}"),
            Self::InvalidContactMapQuery(message) => {
                write!(f, "invalid contact map query: {message}")
            }
        }
    }
}

impl std::error::Error for CStudioError {}
