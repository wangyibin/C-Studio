//! Bounded server-side contact rasterization. No contact arrays cross the network.
use super::*;
mod encoded;
mod warming;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};

const MAX_SIDE: u32 = 2048;
const MAX_PIXELS: u64 = 1_048_576;

// Shared only by this HTTP server, never by the desktop reader.
const CACHE_BYTES: usize = 64 * 1024 * 1024;
#[derive(Default)]
struct ViewCache {
    entries: VecDeque<(String, Arc<Vec<ContactMapCell>>, usize)>,
    bytes: usize,
}
impl ViewCache {
    fn get(&mut self, key: &str) -> Option<Arc<Vec<ContactMapCell>>> {
        let index = self.entries.iter().position(|entry| entry.0 == key)?;
        let entry = self.entries.remove(index)?;
        let cells = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(cells)
    }
    fn insert(&mut self, key: String, cells: Arc<Vec<ContactMapCell>>) {
        let bytes = key.capacity() + cells.capacity() * std::mem::size_of::<ContactMapCell>() + 128;
        if bytes > CACHE_BYTES {
            return;
        }
        if let Some(index) = self.entries.iter().position(|entry| entry.0 == key) {
            self.bytes -= self.entries.remove(index).unwrap().2;
        }
        while self.bytes + bytes > CACHE_BYTES || self.entries.len() >= 256 {
            if let Some(entry) = self.entries.pop_front() {
                self.bytes -= entry.2;
            } else {
                break;
            }
        }
        self.bytes += bytes;
        self.entries.push_back((key, cells, bytes));
    }
}
static VIEW_CACHE: OnceLock<Mutex<ViewCache>> = OnceLock::new();
fn view_cache() -> &'static Mutex<ViewCache> {
    VIEW_CACHE.get_or_init(|| Mutex::new(ViewCache::default()))
}

fn cached_counts(key: &str) -> Option<Arc<Vec<ContactMapCell>>> {
    if let Some(cells) = view_cache().lock().unwrap().get(key) {
        return Some(cells);
    }
    let cells = disk_cache::global()?.get(key)?;
    view_cache()
        .lock()
        .unwrap()
        .insert(key.to_string(), Arc::clone(&cells));
    Some(cells)
}
fn store_counts(key: String, cells: Arc<Vec<ContactMapCell>>) {
    view_cache()
        .lock()
        .unwrap()
        .insert(key.clone(), Arc::clone(&cells));
    if let Some(disk) = disk_cache::global() {
        disk.put(&key, &cells);
    }
}
pub(super) fn warm_layout(state: AppState, dataset: Arc<Dataset>, blocks: Vec<LayoutBlockRequest>) {
    warming::layout(state, dataset, blocks);
}
pub(super) async fn cache_status(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&headers, &state)?;
    dataset(&state, &id)?;
    Ok(Json(
        serde_json::json!({"disk":disk_cache::global().map(|d|d.status()).unwrap_or_else(||serde_json::json!({"enabled":false})),"warming":warming::status(),"images":encoded::status()}),
    ))
}

// Keep at least two stored bins per screen pixel, using the finer screen axis.
// Normalized counts at different stored levels are not equivalent; retain the
// requested level for those modes. Flat .cool files also retain their level.
fn read_resolution(dataset: &Dataset, r: &RenderRequest) -> u64 {
    if dataset.metadata.format != "mcool" || r.normalization != NormalizationRequest::Raw {
        return r.source_resolution;
    }
    let limit = ((r.viewport.x_end - r.viewport.x_start) / u64::from(r.width))
        .min((r.viewport.y_end - r.viewport.y_start) / u64::from(r.height))
        / 2;
    dataset
        .metadata
        .available_resolutions
        .iter()
        .copied()
        .filter(|value| {
            *value >= r.source_resolution && *value <= limit && *value % r.source_resolution == 0
        })
        .max()
        .unwrap_or(r.source_resolution)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RenderRequest {
    source_resolution: u64,
    #[serde(default)]
    target_resolution: Option<u64>,
    #[serde(default)]
    tiles: Vec<TileKeyRequest>,
    #[serde(default)]
    scale_tiles: Option<Vec<TileKeyRequest>>,
    #[serde(default)]
    adaptive_refinement: bool,
    viewport: ViewportRequest,
    #[serde(default)]
    layout_id: Option<String>,
    #[serde(default)]
    layout_blocks: Vec<LayoutBlockRequest>,
    #[serde(default)]
    normalization: NormalizationRequest,
    width: u32,
    height: u32,
    color_scale: ColorScale,
    /// Client's existing palette, so all desktop palettes stay available.
    color_lut: Vec<u8>,
    #[serde(default)]
    palette_stop_count: u32,
    #[serde(default)]
    overview: bool,
    #[serde(default = "default_tile_size")]
    tile_size_bins: u64,
}

fn default_tile_size() -> u64 {
    256
}

#[derive(Debug, Clone, Deserialize)]
struct ColorScale {
    min: f64,
    max: f64,
    log: bool,
    auto: bool,
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub(super) async fn render_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(mut request): Json<RenderRequest>,
) -> Result<Response, ApiError> {
    let handler_started = std::time::Instant::now();
    authorize(&headers, &state)?;
    let _foreground = warming::foreground();
    if let Some(revision) = &request.layout_id {
        if !request.layout_blocks.is_empty() {
            return Err(ApiError::bad_request(
                "provide layoutId or layoutBlocks, not both",
            ));
        }
        request.layout_blocks = state.layouts.lock().unwrap().get(&id, revision)?;
    }
    validate(&request)?;
    let dataset = Arc::clone(dataset(&state, &id)?);
    // Hold the permit inside the blocking worker, including after HTTP cancellation.
    let permit = state
        .render_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "render workers busy; retry shortly".into(),
        })?;
    let guard = CancelOnDrop(Arc::new(AtomicBool::new(false)));
    let cancelled = guard.0.clone();
    let warm_request = request.clone();
    let warm_dataset = Arc::clone(&dataset);
    let (bytes, resolution, scale_max, source_resolution, cache_hit, image_hit) =
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            encoded::render(&dataset, request, &cancelled)
        })
        .await
        .map_err(|e| ApiError::internal(format!("render worker failed: {e}")))??;
    if !image_hit {
        warming::neighbors(state.clone(), warm_dataset, warm_request);
    }
    let mut response = Response::new(Body::from(bytes));
    for (key, value) in [
        ("content-type", "image/png".to_string()),
        ("cache-control", "private, no-store".to_string()),
        // Starts after Axum has received and decoded the JSON request body.
        // Includes validation, worker scheduling, projection and PNG encoding;
        // excludes request upload and response transfer.
        (
            "server-timing",
            format!(
                "render;dur={:.3}",
                handler_started.elapsed().as_secs_f64() * 1000.0
            ),
        ),
        (
            "x-cstudio-image-cache",
            if image_hit { "hit" } else { "miss" }.to_string(),
        ),
        ("x-cstudio-render-contract", "desktop-v1".to_string()),
        ("x-cstudio-resolution", resolution.to_string()),
        ("x-cstudio-scale-max", scale_max.to_string()),
        ("x-cstudio-source-resolution", source_resolution.to_string()),
        (
            "x-cstudio-cache",
            if cache_hit { "hit" } else { "miss" }.to_string(),
        ),
    ] {
        response.headers_mut().insert(
            axum::http::HeaderName::from_bytes(key.as_bytes()).unwrap(),
            HeaderValue::from_str(&value).map_err(|e| ApiError::internal(e.to_string()))?,
        );
    }
    Ok(response)
}

fn validate(r: &RenderRequest) -> Result<(), ApiError> {
    validate_viewport(r.viewport)?;
    validate_layout(&r.layout_blocks)?;
    const MAX_SAFE_COORD: u64 = 9_007_199_254_740_991;
    if [
        r.viewport.x_start,
        r.viewport.x_end,
        r.viewport.y_start,
        r.viewport.y_end,
        r.source_resolution,
    ]
    .iter()
    .any(|v| *v > MAX_SAFE_COORD)
        || r.layout_blocks.iter().any(|b| {
            b.source_end > MAX_SAFE_COORD
                || b.visual_start
                    .checked_add(b.source_end - b.source_start)
                    .is_none_or(|end| end > MAX_SAFE_COORD)
        })
    {
        return Err(ApiError::bad_request(
            "render coordinates exceed safe integer range",
        ));
    }

    if r.source_resolution == 0
        || r.width == 0
        || r.height == 0
        || r.width > MAX_SIDE
        || r.height > MAX_SIDE
        || u64::from(r.width) * u64::from(r.height) > MAX_PIXELS
        || !(1..=320).contains(&r.tile_size_bins)
        || r.palette_stop_count > 256
        || r.color_lut.len() != 1024
        || !r.color_scale.min.is_finite()
        || !r.color_scale.max.is_finite()
        || r.color_scale.min < 0.0
        || r.color_scale.max < r.color_scale.min
    {
        return Err(ApiError::bad_request("invalid render size, resolution, palette or scale (maximum 2048 per side and 1048576 pixels)"));
    }
    Ok(())
}

fn render_resolution(r: &RenderRequest) -> Result<u64, ApiError> {
    // Screen LOD is an integer multiple of the selected stored resolution.
    let span_x = r.viewport.x_end - r.viewport.x_start;
    let span_y = r.viewport.y_end - r.viewport.y_start;
    let step = span_x
        .div_ceil(u64::from(r.width))
        .max(span_y.div_ceil(u64::from(r.height)));
    let mut multiple = step.div_ceil(r.source_resolution).max(1);
    loop {
        let resolution = r
            .source_resolution
            .checked_mul(multiple)
            .ok_or_else(|| ApiError::bad_request("render resolution overflow"))?;
        let nx = r.viewport.x_end.div_ceil(resolution) - r.viewport.x_start / resolution;
        let ny = r.viewport.y_end.div_ceil(resolution) - r.viewport.y_start / resolution;
        if nx.checked_mul(ny).is_some_and(|n| n <= MAX_PIXELS) {
            return Ok(resolution);
        }
        multiple += 1;
    }
}

fn compute(
    dataset: &Dataset,
    r: RenderRequest,
    cancelled: &AtomicBool,
) -> Result<(Vec<u8>, u64, f64, u64, bool), ApiError> {
    compute_inner(dataset, r, cancelled, false)
}
fn compute_inner(
    dataset: &Dataset,
    r: RenderRequest,
    cancelled: &AtomicBool,
    warm_only: bool,
) -> Result<(Vec<u8>, u64, f64, u64, bool), ApiError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(ApiError::bad_request("render cancelled"));
    }
    validate(&r)?;
    validate_dataset_resolution(dataset, r.source_resolution)?;
    let mut r = r;
    if r.target_resolution.is_none() {
        r.source_resolution = read_resolution(dataset, &r);
    }
    let resolution = match r.target_resolution {
        Some(value) if value > 0 && value % r.source_resolution == 0 => value,
        Some(_) => {
            return Err(ApiError::bad_request(
                "targetResolution must be a positive multiple of sourceResolution",
            ))
        }
        None => render_resolution(&r)?,
    };
    let tiles: BTreeSet<_> = r
        .tiles
        .iter()
        .map(|t| canonical_tile(t.tile_x, t.tile_y))
        .collect();
    if r.target_resolution.is_some() && (tiles.is_empty() || tiles.len() > 64) {
        return Err(ApiError::bad_request(
            "explicit display plan requires 1 to 64 tiles",
        ));
    }
    let data_viewport = if tiles.is_empty() {
        r.viewport
    } else {
        let span = resolution
            .checked_mul(r.tile_size_bins)
            .ok_or_else(|| ApiError::bad_request("tile span overflow"))?;
        ViewportRequest {
            x_start: checked_axis_start(tiles.iter().map(|t| t.0).min().unwrap(), span)?,
            x_end: checked_axis_end(tiles.iter().map(|t| t.0).max().unwrap(), span)?,
            y_start: checked_axis_start(tiles.iter().map(|t| t.1).min().unwrap(), span)?,
            y_end: checked_axis_end(tiles.iter().map(|t| t.1).max().unwrap(), span)?,
        }
    };
    let ranges = source_ranges_for_viewport(&data_viewport, &r.layout_blocks);
    // File identity invalidates views after replacement or in-place modification.
    let stamp = if ranges.is_empty() {
        None
    } else {
        let metadata =
            fs::metadata(&dataset.path).map_err(|e| ApiError::internal(e.to_string()))?;
        Some((
            metadata.len(),
            metadata
                .modified()
                .map_err(|e| ApiError::internal(e.to_string()))?,
            file_change_identity(&metadata),
        ))
    };
    let layout_key = disk_cache::digest(format!("{:?}", r.layout_blocks).as_bytes());
    let scope = format!(
        "projection-v1|{:?}|{:?}|{}|{}|{:?}|{}|{}",
        dataset.path,
        stamp,
        r.source_resolution,
        resolution,
        r.normalization,
        layout_key,
        r.tile_size_bins
    );
    // Adaptive refinement depends on its complete neighborhood; keep that path
    // scoped to the complete request. Ordinary projected tiles are independent.
    let per_tile = !tiles.is_empty() && !r.adaptive_refinement;
    let mut retained = Vec::new();
    let mut work_tiles = tiles.clone();
    if per_tile {
        work_tiles.retain(|tile| {
            if let Some(cells) = cached_counts(&format!("tile|{}|{:?}", scope, tile)) {
                retained.push(cells);
                false
            } else {
                true
            }
        });
    }
    let data_viewport = if per_tile && !work_tiles.is_empty() {
        let span = resolution
            .checked_mul(r.tile_size_bins)
            .ok_or_else(|| ApiError::bad_request("tile span overflow"))?;
        ViewportRequest {
            x_start: checked_axis_start(work_tiles.iter().map(|t| t.0).min().unwrap(), span)?,
            x_end: checked_axis_end(work_tiles.iter().map(|t| t.0).max().unwrap(), span)?,
            y_start: checked_axis_start(work_tiles.iter().map(|t| t.1).min().unwrap(), span)?,
            y_end: checked_axis_end(work_tiles.iter().map(|t| t.1).max().unwrap(), span)?,
        }
    } else {
        data_viewport
    };
    let ranges = source_ranges_for_viewport(&data_viewport, &r.layout_blocks);
    let key = format!(
        "view|{}|{:?}|{:?}|{}",
        scope, data_viewport, tiles, r.adaptive_refinement
    );
    let cached = if per_tile {
        if work_tiles.is_empty() {
            Some(merge_tile_cells(&retained))
        } else {
            None
        }
    } else {
        cached_counts(&key)
    };
    let cache_hit = cached.is_some();
    let cells = if let Some(cells) = cached {
        cells
    } else {
        let query = contact_query(
            if r.adaptive_refinement {
                1000
            } else {
                r.source_resolution
            },
            resolution,
            data_viewport,
            &r.layout_blocks,
        )?;
        let adaptive = if r.adaptive_refinement
            && r.normalization == NormalizationRequest::Raw
            && dataset.metadata.format == "mcool"
            && resolution == 2_500_000
            && tiles.len() <= 4
        {
            cstudio_core::cool::build_contact_map_view_from_mcool_adaptive_raw_cancellable(
                dataset.path.to_string_lossy().as_ref(),
                &ranges,
                &query,
                &|| cancelled.load(Ordering::Relaxed),
            )
            .map_err(|e| ApiError::bad_request(e.to_string()))?
        } else {
            None
        };
        let mut projector = if !tiles.is_empty() {
            cstudio_core::contact_map::ContactMapChunkProjector::new_for_tiles(
                &query,
                r.tile_size_bins,
                work_tiles.iter().copied(),
            )
        } else if r.viewport.x_start == r.viewport.y_start && r.viewport.x_end == r.viewport.y_end {
            cstudio_core::contact_map::ContactMapChunkProjector::new_for_bounded_view(
                &query,
                MAX_PIXELS as usize,
            )
        } else {
            // The screen grid bounds the unique sparse canonical cells even
            // when the viewport is far from the diagonal. Do not allocate the
            // potentially enormous enclosing square.
            cstudio_core::contact_map::ContactMapChunkProjector::new_for_symmetric_view(&query)
        }
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
        if adaptive.is_none() && !ranges.is_empty() {
            visit_cool_contact_chunks_indexed_for_source_ranges_at_resolution_with_normalization_cancellable(
                dataset.path.to_string_lossy().as_ref(), &ranges,
                (dataset.metadata.format == "mcool").then_some(r.source_resolution),
                r.normalization.into(), &|| cancelled.load(Ordering::Relaxed),
                |i, s, a, j, t, b, count| {
                    projector.push_indexed_contact(i, s, a, j, t, b, count);
                    Ok(())
                }, || Ok(()),
            ).map_err(|e| ApiError::bad_request(e.to_string()))?;
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err(ApiError::bad_request("render cancelled"));
        }
        let mut cells = adaptive
            .map(|a| a.view.cells)
            .unwrap_or_else(|| projector.take_view().cells);
        if !tiles.is_empty() {
            cells.retain(|c| {
                work_tiles.contains(&canonical_tile(
                    c.x_bin / r.tile_size_bins,
                    c.y_bin / r.tile_size_bins,
                ))
            });
        }
        if per_tile {
            let mut buckets: BTreeMap<_, Vec<ContactMapCell>> =
                work_tiles.iter().map(|t| (*t, Vec::new())).collect();
            for cell in cells {
                buckets
                    .get_mut(&canonical_tile(
                        cell.x_bin / r.tile_size_bins,
                        cell.y_bin / r.tile_size_bins,
                    ))
                    .unwrap()
                    .push(cell);
            }
            for (tile, cells) in buckets {
                let cells = Arc::new(cells);
                store_counts(format!("tile|{}|{:?}", scope, tile), Arc::clone(&cells));
                retained.push(cells);
            }
            merge_tile_cells(&retained)
        } else {
            let cells = Arc::new(cells);
            store_counts(key, Arc::clone(&cells));
            cells
        }
    };
    if warm_only {
        return Ok((Vec::new(), resolution, 0.0, r.source_resolution, cache_hit));
    }
    let mut scale = r.color_scale.clone();
    if scale.auto {
        scale.min = 0.0;
        scale.max = if r.target_resolution.is_some() {
            auto_max_tiles(
                &cells,
                r.scale_tiles.as_deref(),
                r.tile_size_bins,
                r.viewport,
                resolution,
            )
        } else {
            auto_max(&cells, r.viewport, resolution)
        };
    }
    let pixels = rasterize(&r, resolution, &cells, &scale, cancelled)?;
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, r.width, r.height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| ApiError::internal(e.to_string()))?;
        writer
            .write_image_data(&pixels)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
    Ok((bytes, resolution, scale.max, r.source_resolution, cache_hit))
}

#[cfg(unix)]
fn file_change_identity(metadata: &fs::Metadata) -> (u64, i64, i64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.ino(), metadata.ctime(), metadata.ctime_nsec())
}
#[cfg(not(unix))]
fn file_change_identity(_: &fs::Metadata) -> (u64, i64, i64) {
    (0, 0, 0)
}

fn merge_tile_cells(tiles: &[Arc<Vec<ContactMapCell>>]) -> Arc<Vec<ContactMapCell>> {
    let mut cells: Vec<_> = tiles.iter().flat_map(|t| t.iter().cloned()).collect();
    cells.sort_unstable_by_key(|c| (c.x_bin, c.y_bin));
    Arc::new(cells)
}

fn auto_max_tiles(
    cells: &[ContactMapCell],
    selected: Option<&[TileKeyRequest]>,
    tile_size: u64,
    viewport: ViewportRequest,
    resolution: u64,
) -> f64 {
    let selected = selected.map(|ts| {
        ts.iter()
            .map(|t| canonical_tile(t.tile_x, t.tile_y))
            .collect::<BTreeSet<_>>()
    });
    visible_auto_max(
        cells.iter().filter(|cell| {
            let tile = canonical_tile(cell.x_bin / tile_size, cell.y_bin / tile_size);
            selected.as_ref().is_none_or(|set| set.contains(&tile))
        }),
        viewport,
        resolution,
    )
}

fn auto_max(cells: &[ContactMapCell], viewport: ViewportRequest, resolution: u64) -> f64 {
    visible_auto_max(cells.iter(), viewport, resolution)
}

fn visible_auto_max<'a>(
    cells: impl Iterator<Item = &'a ContactMapCell>,
    viewport: ViewportRequest,
    resolution: u64,
) -> f64 {
    let intersects = |x: u64, y: u64| {
        (x as f64 + 1.0) * resolution as f64 > viewport.x_start as f64
            && x as f64 * (resolution as f64) < viewport.x_end as f64
            && (y as f64 + 1.0) * resolution as f64 > viewport.y_start as f64
            && y as f64 * (resolution as f64) < viewport.y_end as f64
    };
    let mut samples = Vec::new();
    let mut small_sample = Vec::new();
    let mut eligible = 0;
    for cell in cells {
        if cell.x_bin == cell.y_bin
            || !cell.count.is_finite()
            || cell.count <= 0.0
            || !(intersects(cell.x_bin, cell.y_bin) || intersects(cell.y_bin, cell.x_bin))
        {
            continue;
        }
        eligible += 1;
        if eligible <= 10_000 {
            small_sample.push(cell.count);
        }
        // Same wrapping coordinate hash and small-view fallback as the desktop.
        let hash = (cell.x_bin.min(cell.y_bin) as u32).wrapping_mul(73856093)
            ^ (cell.x_bin.max(cell.y_bin) as u32).wrapping_mul(19349663);
        if hash % 10 == 0 {
            samples.push(cell.count);
        }
    }
    percentile_max(if eligible <= 10_000 || samples.is_empty() {
        small_sample
    } else {
        samples
    })
}

fn percentile_max(mut values: Vec<f64>) -> f64 {
    values.retain(|v| v.is_finite() && *v > 0.0);
    if values.is_empty() {
        return 1.0;
    }
    values.sort_unstable_by(f64::total_cmp);
    let position = 0.99 * (values.len() + 1) as f64;
    let value = if position < 1.0 {
        values[0]
    } else if position >= values.len() as f64 {
        values[values.len() - 1]
    } else {
        let lower = position.floor() as usize;
        values[lower - 1] + (position - lower as f64) * (values[lower] - values[lower - 1])
    };
    // Match desktop float32 percentile without producing infinite HTTP metadata.
    (value as f32).min(f32::MAX) as f64
}

fn rasterize(
    r: &RenderRequest,
    resolution: u64,
    cells: &[ContactMapCell],
    scale: &ColorScale,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, ApiError> {
    let mut pixels = vec![255; r.width as usize * r.height as usize * 3];
    let xs = (r.viewport.x_end - r.viewport.x_start) as f64;
    let ys = (r.viewport.y_end - r.viewport.y_start) as f64;
    for (index, cell) in cells.iter().enumerate() {
        if index % 4096 == 0 && cancelled.load(Ordering::Relaxed) {
            return Err(ApiError::bad_request("render cancelled"));
        }
        if !cell.count.is_finite() {
            continue;
        }
        let intensity = if scale.max == scale.min {
            if cell.count >= scale.max {
                1.0
            } else {
                0.0
            }
        } else if scale.log {
            ((cell.count + 1.0).log10() - (scale.min + 1.0).log10())
                / ((scale.max + 1.0).log10() - (scale.min + 1.0).log10())
        } else {
            (cell.count - scale.min) / (scale.max - scale.min)
        };
        let intensity = intensity.clamp(0.0, 1.0);
        let lut_intensity = if r.palette_stop_count > 0 {
            let n = r.palette_stop_count as f64;
            ((intensity * n).floor().min(n - 1.0) + 0.5) / n
        } else {
            intensity
        };
        let offset = (lut_intensity * 255.0).floor() as usize * 4;
        let alpha = f64::from(r.color_lut[offset + 3]) / 255.0;
        let color: [u8; 3] = std::array::from_fn(|i| {
            (f64::from(r.color_lut[offset + i]) * alpha + 255.0 * (1.0 - alpha)).round() as u8
        });
        let positions = [(cell.x_bin, cell.y_bin), (cell.y_bin, cell.x_bin)];
        for &(x, y) in &positions[..if cell.x_bin == cell.y_bin { 1 } else { 2 }] {
            let xb = x as f64 * resolution as f64 - r.viewport.x_start as f64;
            let yb = y as f64 * resolution as f64 - r.viewport.y_start as f64;
            let left = (xb / xs * r.width as f64)
                .floor()
                .clamp(0.0, r.width as f64) as usize;
            let right = ((xb + resolution as f64) / xs * r.width as f64)
                .ceil()
                .clamp(0.0, r.width as f64) as usize;
            let top = (yb / ys * r.height as f64)
                .floor()
                .clamp(0.0, r.height as f64) as usize;
            let bottom = ((yb + resolution as f64) / ys * r.height as f64)
                .ceil()
                .clamp(0.0, r.height as f64) as usize;
            for row in top..bottom {
                for col in left..right {
                    let i = (row * r.width as usize + col) * 3;
                    if r.overview {
                        for channel in 0..3 {
                            pixels[i + channel] = (f64::from(r.color_lut[offset + channel]) * alpha
                                + f64::from(pixels[i + channel]) * (1.0 - alpha))
                                .round() as u8;
                        }
                    } else {
                        pixels[i..i + 3].copy_from_slice(&color);
                    }
                }
            }
        }
    }
    Ok(pixels)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn request() -> RenderRequest {
        RenderRequest {
            source_resolution: 10,
            target_resolution: None,
            tiles: vec![],
            scale_tiles: None,
            adaptive_refinement: false,
            viewport: ViewportRequest {
                x_start: 0,
                x_end: 40,
                y_start: 0,
                y_end: 40,
            },
            layout_id: None,
            layout_blocks: vec![],
            normalization: NormalizationRequest::Raw,
            width: 4,
            height: 4,
            color_scale: ColorScale {
                min: 0.0,
                max: 10.0,
                log: false,
                auto: false,
            },
            palette_stop_count: 0,
            overview: false,
            tile_size_bins: 256,
            color_lut: (0..256).flat_map(|i| [i as u8, 0, 0, 255]).collect(),
        }
    }
    #[tokio::test]
    async fn render_handler_enforces_auth_admission_and_png_contract() {
        let dataset = Arc::new(Dataset {
            path: PathBuf::from("unused.mcool"),
            assembly: None,
            metadata: DatasetMetadata {
                api_version: 1,
                assembly: None,
                render_modes: vec!["png-v1".into()],
                id: "test".into(),
                name: "test".into(),
                format: "mcool".into(),
                size_bytes: 0,
                available_resolutions: vec![10],
                sources: vec![],
            },
        });
        let state = AppState {
            layouts: layouts::registry(),
            datasets: Arc::new(BTreeMap::from([("test".into(), dataset)])),
            bearer_token: Some(Arc::from("test-token")),
            render_slots: Arc::new(tokio::sync::Semaphore::new(1)),
        };
        let denied = render_handler(
            State(state.clone()),
            AxumPath("test".into()),
            HeaderMap::new(),
            Json(request()),
        )
        .await
        .unwrap_err();
        assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer test-token"));
        let permit = state.render_slots.clone().acquire_owned().await.unwrap();
        let busy = render_handler(
            State(state.clone()),
            AxumPath("test".into()),
            headers.clone(),
            Json(request()),
        )
        .await
        .unwrap_err();
        assert_eq!(busy.status, StatusCode::TOO_MANY_REQUESTS);
        drop(permit);
        let response = render_handler(
            State(state.clone()),
            AxumPath("test".into()),
            headers,
            Json(request()),
        )
        .await
        .unwrap();
        assert_eq!(response.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert_eq!(response.headers()["x-cstudio-resolution"], "10");
        let timing = response.headers()["server-timing"].to_str().unwrap();
        let duration: f64 = timing.strip_prefix("render;dur=").unwrap().parse().unwrap();
        assert!(duration.is_finite() && duration >= 0.0);
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(state.render_slots.available_permits(), 1);
    }

    #[test]
    fn pixels_match_local_renderer_for_linear_log_discrete_and_clipped_bins() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/remote-render-parity.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let r: RenderRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
            let cells: Vec<_> = fixture["cells"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| ContactMapCell {
                    x_bin: c["xBin"].as_u64().unwrap(),
                    y_bin: c["yBin"].as_u64().unwrap(),
                    count: c["count"].as_f64().unwrap(),
                })
                .collect();
            let pixels = rasterize(
                &r,
                r.source_resolution,
                &cells,
                &r.color_scale,
                &AtomicBool::new(false),
            )
            .unwrap();
            let expected: Vec<u8> = serde_json::from_value(fixture["rgb"].clone()).unwrap();
            assert_eq!(pixels, expected, "{}", fixture["colormap"]);
        }
    }

    #[test]
    fn moving_camera_reuses_full_tiles_but_sampling_changes_invalidate() {
        let dataset = Dataset {
            path: PathBuf::from("camera-reuse-test.mcool"),
            assembly: None,
            metadata: DatasetMetadata {
                api_version: 1,
                assembly: None,
                render_modes: vec![],
                id: "pan-cache".into(),
                name: "pan-cache".into(),
                format: "mcool".into(),
                size_bytes: 0,
                available_resolutions: vec![10],
                sources: vec![],
            },
        };
        let mut r = request();
        r.target_resolution = Some(10);
        r.tiles = vec![TileKeyRequest {
            tile_x: 0,
            tile_y: 0,
        }];
        let first = compute(&dataset, r.clone(), &AtomicBool::new(false)).unwrap();
        assert!(!first.4);
        r.viewport.x_start += 10;
        r.viewport.x_end += 10;
        let pan = compute(&dataset, r.clone(), &AtomicBool::new(false)).unwrap();
        assert!(pan.4);
        assert_eq!(pan.1, first.1);
        // A new set reuses its overlap and retains empty tiles too. Once each
        // independent tile has been visited, their union needs no new read.
        r.tiles.push(TileKeyRequest {
            tile_x: 0,
            tile_y: 1,
        });
        assert!(
            !compute(&dataset, r.clone(), &AtomicBool::new(false))
                .unwrap()
                .4
        );
        r.tiles = vec![TileKeyRequest {
            tile_x: 0,
            tile_y: 1,
        }];
        assert!(
            compute(&dataset, r.clone(), &AtomicBool::new(false))
                .unwrap()
                .4
        );
        r.tiles.push(TileKeyRequest {
            tile_x: 0,
            tile_y: 0,
        });
        assert!(
            compute(&dataset, r.clone(), &AtomicBool::new(false))
                .unwrap()
                .4
        );
        r.normalization = NormalizationRequest::Vc;
        assert!(
            !compute(&dataset, r.clone(), &AtomicBool::new(false))
                .unwrap()
                .4
        );
        r.normalization = NormalizationRequest::Raw;
        r.target_resolution = Some(20);
        assert!(!compute(&dataset, r, &AtomicBool::new(false)).unwrap().4);
    }

    #[test]
    fn explicit_display_bins_are_not_changed_by_image_dimensions() {
        let mut r = request();
        r.target_resolution = Some(10);
        r.tiles = vec![TileKeyRequest {
            tile_x: 0,
            tile_y: 0,
        }];
        r.width = 1;
        r.height = 1;
        let dataset = Dataset {
            path: PathBuf::from("unused.mcool"),
            assembly: None,
            metadata: DatasetMetadata {
                api_version: 1,
                assembly: None,
                render_modes: vec![],
                id: "test".into(),
                name: "test".into(),
                format: "mcool".into(),
                size_bytes: 0,
                available_resolutions: vec![10],
                sources: vec![],
            },
        };
        assert_eq!(compute(&dataset, r, &AtomicBool::new(false)).unwrap().1, 10);
    }

    #[test]
    fn automatic_scale_samples_each_visible_tile_and_excludes_prefetch() {
        let cells = vec![
            ContactMapCell {
                x_bin: 0,
                y_bin: 1,
                count: 2.0,
            },
            ContactMapCell {
                x_bin: 0,
                y_bin: 257,
                count: 8.0,
            },
            ContactMapCell {
                x_bin: 0,
                y_bin: 513,
                count: 900.0,
            },
        ];
        let tiles = vec![
            TileKeyRequest {
                tile_x: 0,
                tile_y: 0,
            },
            TileKeyRequest {
                tile_x: 0,
                tile_y: 1,
            },
        ];
        assert_eq!(
            auto_max_tiles(
                &cells,
                Some(&tiles),
                256,
                ViewportRequest {
                    x_start: 0,
                    x_end: 600,
                    y_start: 0,
                    y_end: 600
                },
                1
            ),
            8.0
        );
    }

    #[test]
    fn auto_scale_uses_visible_signal_including_small_samples() {
        let cells = vec![
            ContactMapCell {
                x_bin: 1,
                y_bin: 2,
                count: 100.0,
            },
            ContactMapCell {
                x_bin: 20,
                y_bin: 21,
                count: 2.0,
            },
            ContactMapCell {
                x_bin: 1,
                y_bin: 1,
                count: 99999.0,
            },
        ];
        assert_eq!(
            auto_max(
                &cells,
                ViewportRequest {
                    x_start: 0,
                    x_end: 8,
                    y_start: 0,
                    y_end: 8
                },
                1
            ),
            100.0
        );
        assert_eq!(
            auto_max(
                &cells,
                ViewportRequest {
                    x_start: 20,
                    x_end: 24,
                    y_start: 20,
                    y_end: 24
                },
                1
            ),
            2.0
        );
        assert_eq!(
            auto_max(
                &cells,
                ViewportRequest {
                    x_start: 2,
                    x_end: 3,
                    y_start: 1,
                    y_end: 2
                },
                1
            ),
            100.0
        );
    }

    #[test]
    fn adaptive_reads_refine_on_zoom_and_preserve_normalized_levels() {
        let mut dataset = Dataset {
            path: PathBuf::from("lod.mcool"),
            assembly: None,
            metadata: DatasetMetadata {
                api_version: 1,
                assembly: None,
                render_modes: vec![],
                id: "lod".into(),
                name: "lod".into(),
                format: "mcool".into(),
                size_bytes: 0,
                available_resolutions: vec![10, 20, 50, 100],
                sources: vec![],
            },
        };
        let mut r = request();
        r.viewport.x_end = 800;
        r.viewport.y_end = 800;
        assert_eq!(read_resolution(&dataset, &r), 100);
        r.viewport.x_end = 40;
        assert_eq!(read_resolution(&dataset, &r), 10); // finer axis wins
        r.viewport.x_end = 800;
        r.normalization = NormalizationRequest::Ice;
        assert_eq!(read_resolution(&dataset, &r), 10);
        r.normalization = NormalizationRequest::Raw;
        dataset.metadata.format = "cool".into();
        assert_eq!(read_resolution(&dataset, &r), 10);
    }

    #[test]
    fn view_cache_is_bounded_lru_and_replaces_duplicates() {
        let mut cache = ViewCache::default();
        let cells = Arc::new(vec![ContactMapCell {
            x_bin: 0,
            y_bin: 1,
            count: 7.0,
        }]);
        for i in 0..256 {
            cache.insert(i.to_string(), Arc::clone(&cells));
        }
        assert_eq!(cache.get("0").unwrap()[0].count, 7.0);
        cache.insert("256".into(), Arc::clone(&cells));
        assert!(cache.get("1").is_none());
        assert!(cache.get("0").is_some());
        let bytes = cache.bytes;
        cache.insert("256".into(), Arc::clone(&cells));
        assert_eq!(cache.bytes, bytes);
        assert_eq!(cache.entries.len(), 256);
        let oversized = "x".repeat(CACHE_BYTES + 1);
        cache.insert(oversized, cells);
        assert_eq!(cache.bytes, bytes);
        assert!(cache.bytes <= CACHE_BYTES);
    }

    #[test]
    fn bounded_lod_and_request_validation() {
        let mut r = request();
        assert!(validate(&r).is_ok());
        r.viewport = ViewportRequest {
            x_start: 7,
            x_end: 10_000_007,
            y_start: 3,
            y_end: 20_000_003,
        };
        let resolution = render_resolution(&r).unwrap();
        assert_eq!(resolution % 10, 0);
        let nx = r.viewport.x_end.div_ceil(resolution) - r.viewport.x_start / resolution;
        let ny = r.viewport.y_end.div_ceil(resolution) - r.viewport.y_start / resolution;
        assert!(nx * ny <= MAX_PIXELS);
        r.width = 2048;
        r.height = 2048;
        assert!(validate(&r).is_err());
        r.width = 4;
        r.height = 4;
        r.color_lut.pop();
        assert!(validate(&r).is_err());
    }
    #[test]
    fn mirrors_cells_clips_viewport_and_preserves_empty_white() {
        let r = request();
        let cells = vec![ContactMapCell {
            x_bin: 0,
            y_bin: 2,
            count: 10.0,
        }];
        let pixels = rasterize(&r, 10, &cells, &r.color_scale, &AtomicBool::new(false)).unwrap();
        assert_eq!(&pixels[6..9], &[255, 0, 0]);
        assert_eq!(&pixels[24..27], &[255, 0, 0]);
        assert_eq!(&pixels[0..3], &[255, 255, 255]);
        let mut off_axis = r.clone();
        off_axis.viewport.x_start = 20;
        off_axis.viewport.x_end = 60;
        let shifted = rasterize(
            &off_axis,
            10,
            &cells,
            &r.color_scale,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(&shifted[0..3], &[255, 0, 0]);
        assert_eq!(&shifted[6..9], &[255, 255, 255]);
        assert!(rasterize(&r, 10, &cells, &r.color_scale, &AtomicBool::new(true)).is_err());
    }
    #[test]
    fn auto_scale_excludes_diagonal_and_log_scale_matches_desktop() {
        assert_eq!(
            auto_max(
                &[ContactMapCell {
                    x_bin: 0,
                    y_bin: 0,
                    count: 999.0
                }],
                request().viewport,
                10
            ),
            1.0
        );
        let mut r = request();
        r.color_scale.max = 99.0;
        r.color_scale.log = true;
        let pixels = rasterize(
            &r,
            10,
            &[ContactMapCell {
                x_bin: 0,
                y_bin: 1,
                count: 9.0,
            }],
            &r.color_scale,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(&pixels[3..6], &[127, 0, 0]);
    }
    #[test]
    fn png_encodes_empty_view_without_opening_dataset() {
        let dataset = Dataset {
            path: PathBuf::from("unused.mcool"),
            assembly: None,
            metadata: DatasetMetadata {
                api_version: 1,
                assembly: None,
                render_modes: vec![],
                id: "test".into(),
                name: "test".into(),
                format: "mcool".into(),
                size_bytes: 0,
                available_resolutions: vec![10],
                sources: vec![],
            },
        };
        let (bytes, resolution, _, _, _) =
            compute(&dataset, request(), &AtomicBool::new(false)).unwrap();
        assert_eq!(resolution, 10);
        let mut reader = png::Decoder::new(bytes.as_slice()).read_info().unwrap();
        let mut output = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut output).unwrap();
        assert_eq!((info.width, info.height), (4, 4));
        assert!(output.iter().all(|p| *p == 255));
    }
}
