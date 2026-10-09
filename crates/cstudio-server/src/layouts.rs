//! Dataset-scoped, bounded layout revisions. Eviction is recoverable via HTTP 410.
use super::*;
use std::{collections::VecDeque, sync::Mutex};
const BUDGET: usize = 32 * 1024 * 1024;
#[derive(Debug, Default)]
pub(super) struct Registry {
    entries: VecDeque<(String, String, Vec<LayoutBlockRequest>, usize)>,
    bytes: usize,
    sequence: u64,
}
impl Registry {
    fn insert(
        &mut self,
        dataset: String,
        blocks: Vec<LayoutBlockRequest>,
    ) -> Result<String, ApiError> {
        if let Some(index) = self
            .entries
            .iter()
            .position(|e| e.1 == dataset && e.2 == blocks)
        {
            let entry = self.entries.remove(index).unwrap();
            let id = entry.0.clone();
            self.entries.push_back(entry);
            return Ok(id);
        }
        let bytes = blocks.capacity() * std::mem::size_of::<LayoutBlockRequest>()
            + blocks
                .iter()
                .map(|b| b.id.capacity() + b.source_id.capacity() + b.orientation.capacity())
                .sum::<usize>()
            + 256;
        if bytes > BUDGET {
            return Err(ApiError::bad_request(
                "layout exceeds registry memory budget",
            ));
        }
        while self.bytes + bytes > BUDGET || self.entries.len() >= 32 {
            if let Some(e) = self.entries.pop_front() {
                self.bytes -= e.3;
            } else {
                break;
            }
        }
        self.sequence += 1;
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = format!("{:x}-{:x}-{:x}", std::process::id(), epoch, self.sequence);
        self.bytes += bytes;
        self.entries.push_back((id.clone(), dataset, blocks, bytes));
        Ok(id)
    }
    pub(super) fn get(
        &mut self,
        dataset: &str,
        id: &str,
    ) -> Result<Vec<LayoutBlockRequest>, ApiError> {
        let index = self
            .entries
            .iter()
            .position(|e| e.0 == id && e.1 == dataset)
            .ok_or_else(|| ApiError {
                status: StatusCode::GONE,
                message: "layout revision expired; register again".into(),
            })?;
        let entry = self.entries.remove(index).unwrap();
        let blocks = entry.2.clone();
        self.entries.push_back(entry);
        Ok(blocks)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Registration {
    layout_blocks: Vec<LayoutBlockRequest>,
}
pub(super) async fn handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<Registration>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&headers, &state)?;
    dataset(&state, &id)?;
    validate_layout(&request.layout_blocks)?;
    let warm_blocks = request.layout_blocks.clone();
    let warm_dataset = Arc::clone(dataset(&state, &id)?);
    let revision = state
        .layouts
        .lock()
        .unwrap()
        .insert(id, request.layout_blocks)?;
    raster::warm_layout(state.clone(), warm_dataset, warm_blocks);
    Ok(Json(serde_json::json!({"layoutId":revision})))
}
pub(super) fn registry() -> Arc<Mutex<Registry>> {
    Arc::new(Mutex::new(Registry::default()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revisions_are_scoped_deduplicated_and_bounded() {
        let mut r = Registry::default();
        let id = r.insert("a".into(), vec![]).unwrap();
        assert_eq!(r.insert("a".into(), vec![]).unwrap(), id);
        assert!(r.get("b", &id).is_err());
        assert!(r.get("a", &id).is_ok());
        for i in 0..33 {
            r.insert(format!("dataset-{i}"), vec![]).unwrap();
        }
        assert!(r.get("a", &id).is_err());
        assert!(r.bytes <= BUDGET);
        assert_eq!(r.entries.len(), 32);
    }
}
