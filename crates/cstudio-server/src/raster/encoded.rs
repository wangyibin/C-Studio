//! Finished images: bounded memory LRU, persistent blobs in the shared disk budget.
use super::*;
const BUDGET: usize = 32 * 1024 * 1024;
#[derive(Clone)]
struct Image {
    bytes: Vec<u8>,
    resolution: u64,
    scale: f64,
    source: u64,
}
#[derive(Default)]
struct Cache {
    entries: VecDeque<(String, Image)>,
    bytes: usize,
    hits: u64,
}
impl Cache {
    fn get(&mut self, key: &str) -> Option<Image> {
        let i = self.entries.iter().position(|e| e.0 == key)?;
        let e = self.entries.remove(i)?;
        let value = e.1.clone();
        self.entries.push_back(e);
        self.hits += 1;
        Some(value)
    }
    fn put(&mut self, key: String, image: Image) {
        let size = image.bytes.len() + key.len();
        if size > BUDGET {
            return;
        }
        if let Some(i) = self.entries.iter().position(|e| e.0 == key) {
            let e = self.entries.remove(i).unwrap();
            self.bytes -= e.0.len() + e.1.bytes.len();
        }
        while self.bytes + size > BUDGET || self.entries.len() >= 512 {
            if let Some(e) = self.entries.pop_front() {
                self.bytes -= e.0.len() + e.1.bytes.len();
            }
        }
        self.bytes += size;
        self.entries.push_back((key, image));
    }
}
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}
pub(super) fn status() -> serde_json::Value {
    let c = cache().lock().unwrap();
    serde_json::json!({"bytes":c.bytes,"budgetBytes":BUDGET,"entries":c.entries.len(),"hits":c.hits})
}
fn key(dataset: &Dataset, request: &RenderRequest) -> Result<String, ApiError> {
    // A registry ID is process-local. Cache by the exact resolved layout and all
    // display inputs; the namespace changes whenever the raster contract changes.
    let stamp = match fs::metadata(&dataset.path) {
        Ok(m) => Some((
            m.len(),
            m.modified()
                .map_err(|e| ApiError::internal(e.to_string()))?,
            file_change_identity(&m),
        )),
        Err(_) if request.layout_blocks.is_empty() => None,
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };
    let mut r = request.clone();
    r.layout_id = None;
    Ok(format!(
        "image-v1|{}",
        disk_cache::digest(format!("{:?}|{:?}|{:?}", dataset.path, stamp, r).as_bytes())
    ))
}
fn pack(image: &Image) -> Vec<u8> {
    let mut b = Vec::with_capacity(24 + image.bytes.len());
    b.extend_from_slice(&image.resolution.to_le_bytes());
    b.extend_from_slice(&image.scale.to_le_bytes());
    b.extend_from_slice(&image.source.to_le_bytes());
    b.extend_from_slice(&image.bytes);
    b
}
fn unpack(b: Vec<u8>) -> Option<Image> {
    if b.len() < 32 || &b[24..32] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let resolution = u64::from_le_bytes(b[..8].try_into().ok()?);
    let scale = f64::from_le_bytes(b[8..16].try_into().ok()?);
    let source = u64::from_le_bytes(b[16..24].try_into().ok()?);
    if resolution == 0 || source == 0 || !scale.is_finite() {
        return None;
    }
    Some(Image {
        bytes: b[24..].to_vec(),
        resolution,
        scale,
        source,
    })
}
pub(super) fn render(
    dataset: &Dataset,
    r: RenderRequest,
    cancel: &AtomicBool,
) -> Result<(Vec<u8>, u64, f64, u64, bool, bool), ApiError> {
    validate(&r)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(ApiError::bad_request("render cancelled"));
    }
    let key = key(dataset, &r)?;
    let memory = cache().lock().unwrap().get(&key);
    let found = memory.or_else(|| {
        disk_cache::global()
            .and_then(|d| d.get_blob(&key))
            .and_then(unpack)
    });
    if let Some(image) = found {
        cache().lock().unwrap().put(key, image.clone());
        return Ok((
            image.bytes,
            image.resolution,
            image.scale,
            image.source,
            true,
            true,
        ));
    }
    let (bytes, resolution, scale, source, count_hit) = compute(dataset, r, cancel)?;
    let image = Image {
        bytes,
        resolution,
        scale,
        source,
    };
    if !cancel.load(Ordering::Relaxed) {
        if let Some(disk) = disk_cache::global() {
            disk.put_blob(&key, &pack(&image));
        }
        cache().lock().unwrap().put(key, image.clone());
    }
    Ok((image.bytes, resolution, scale, source, count_hit, false))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_lru_and_binary_metadata() {
        let image = Image {
            bytes: b"\x89PNG\r\n\x1a\nfixture".to_vec(),
            resolution: 10,
            scale: 50.,
            source: 5,
        };
        assert_eq!(unpack(pack(&image)).unwrap().scale, 50.);
        assert!(unpack(vec![0; 32]).is_none());
        let mut c = Cache::default();
        for i in 0..513 {
            c.put(i.to_string(), image.clone());
        }
        assert!(c.get("0").is_none());
        assert!(c.get("512").is_some());
        assert!(c.bytes <= BUDGET);
        assert_eq!(c.entries.len(), 512);
    }
    #[test]
    fn key_ignores_registration_id_but_tracks_display_and_layout() {
        let d = Dataset {
            path: PathBuf::from("/missing-test-file"),
            assembly: None,
            metadata: DatasetMetadata {
                api_version: 1,
                assembly: None,
                id: "test".into(),
                name: "test".into(),
                format: "mcool".into(),
                size_bytes: 0,
                available_resolutions: vec![10],
                sources: vec![],
                render_modes: vec![],
            },
        };
        let mut r = super::super::tests::request();
        let original = key(&d, &r).unwrap();
        r.layout_id = Some("new-id".into());
        assert_eq!(key(&d, &r).unwrap(), original);
        r.color_scale.max += 1.;
        assert_ne!(key(&d, &r).unwrap(), original);
        r.color_scale.max -= 1.;
        r.viewport.x_end += 10;
        assert_ne!(key(&d, &r).unwrap(), original);
    }
}
