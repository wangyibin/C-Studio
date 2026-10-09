//! Bounded, cooperative background warming. Never publish images or change LOD.
use super::*;
use std::time::{Duration, Instant};
#[derive(Clone)]
struct Job {
    dataset: Arc<Dataset>,
    request: Arc<RenderRequest>,
    tile: TileKeyRequest,
    layout: String,
    neighbor: bool,
}
struct Queue {
    latest: BTreeMap<PathBuf, String>,
    jobs: VecDeque<Job>,
    active: Option<Arc<AtomicBool>>,
    foreground: usize,
    last: Instant,
    running: bool,
    completed: u64,
    cancelled: u64,
    failed: u64,
}
impl Default for Queue {
    fn default() -> Self {
        Self {
            latest: BTreeMap::new(),
            jobs: VecDeque::new(),
            active: None,
            foreground: 0,
            last: Instant::now(),
            running: false,
            completed: 0,
            cancelled: 0,
            failed: 0,
        }
    }
}
static QUEUE: OnceLock<Mutex<Queue>> = OnceLock::new();
fn queue() -> &'static Mutex<Queue> {
    QUEUE.get_or_init(|| Mutex::new(Queue::default()))
}
fn enabled() -> bool {
    !cfg!(test) && std::env::var("CSTUDIO_PREWARM").as_deref() != Ok("0")
}
pub(super) struct Foreground;
pub(super) fn foreground() -> Foreground {
    let mut q = queue().lock().unwrap();
    q.foreground += 1;
    q.last = Instant::now();
    if let Some(c) = &q.active {
        c.store(true, Ordering::Relaxed);
    }
    Foreground
}
impl Drop for Foreground {
    fn drop(&mut self) {
        let mut q = queue().lock().unwrap();
        q.foreground = q.foreground.saturating_sub(1);
        q.last = Instant::now();
    }
}
pub(super) fn status() -> serde_json::Value {
    let q = queue().lock().unwrap();
    serde_json::json!({"enabled":enabled(),"pending":q.jobs.len(),"active":q.active.is_some(),"completed":q.completed,"cancelled":q.cancelled,"failed":q.failed})
}
fn enqueue(state: AppState, jobs: Vec<Job>, neighbors: bool) {
    if !enabled() || jobs.is_empty() {
        return;
    }
    let mut q = queue().lock().unwrap();
    let first = &jobs[0];
    if q.latest
        .get(&first.dataset.path)
        .is_some_and(|v| v != &first.layout)
    {
        if let Some(c) = &q.active {
            c.store(true, Ordering::Relaxed);
        }
    }
    q.latest
        .insert(first.dataset.path.clone(), first.layout.clone());
    q.jobs.retain(|j| {
        j.dataset.path != first.dataset.path
            || (j.layout == first.layout && !(neighbors && j.neighbor))
    });
    for job in jobs {
        if q.jobs.len() >= 128 {
            if neighbors {
                q.jobs.pop_back();
            } else {
                break;
            }
        }
        if !q.jobs.iter().any(|j| {
            j.dataset.path == job.dataset.path
                && j.layout == job.layout
                && j.request.source_resolution == job.request.source_resolution
                && j.request.target_resolution == job.request.target_resolution
                && j.request.tile_size_bins == job.request.tile_size_bins
                && j.request.normalization == job.request.normalization
                && j.tile == job.tile
        }) {
            if neighbors {
                q.jobs.push_front(job);
            } else {
                q.jobs.push_back(job);
            }
        }
    }
    if q.running {
        return;
    }
    q.running = true;
    drop(q);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        let mut q = queue().lock().unwrap();
        if q.jobs.is_empty() {
            q.running = false;
            return;
        }
        if q.foreground > 0
            || q.last.elapsed() < Duration::from_millis(500)
            || state.render_slots.available_permits() < 2
        {
            continue;
        }
        let Ok(permit) = state.render_slots.clone().try_acquire_owned() else {
            continue;
        };
        let job = q.jobs.pop_front().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        q.active = Some(cancelled.clone());
        drop(q);
        let mut request = (*job.request).clone();
        request.tiles = vec![job.tile];
        request.scale_tiles = None;
        let result = compute_inner(&job.dataset, request, &cancelled, true);
        drop(permit);
        let mut q = queue().lock().unwrap();
        q.active = None;
        if cancelled.load(Ordering::Relaxed) {
            q.cancelled += 1;
            if q.jobs.len() < 128 && q.latest.get(&job.dataset.path) == Some(&job.layout) {
                q.jobs.push_back(job);
            }
        } else if let Err(error) = result {
            q.failed += 1;
            tracing::warn!(error=?error,"background tile skipped");
        } else {
            q.completed += 1;
        }
    });
}
fn span(blocks: &[LayoutBlockRequest]) -> u64 {
    blocks
        .iter()
        .map(|b| b.visual_start.saturating_add(b.source_end - b.source_start))
        .max()
        .unwrap_or(1)
        .max(1)
}
fn base(
    blocks: Vec<LayoutBlockRequest>,
    source: u64,
    target: u64,
    size: u64,
    total: u64,
) -> RenderRequest {
    RenderRequest {
        source_resolution: source,
        target_resolution: Some(target),
        tiles: vec![],
        scale_tiles: None,
        adaptive_refinement: false,
        viewport: ViewportRequest {
            x_start: 0,
            x_end: total,
            y_start: 0,
            y_end: total,
        },
        layout_id: None,
        layout_blocks: blocks,
        normalization: NormalizationRequest::Raw,
        width: 1,
        height: 1,
        color_scale: ColorScale {
            min: 0.0,
            max: 1.0,
            log: false,
            auto: false,
        },
        color_lut: vec![0; 1024],
        palette_stop_count: 0,
        overview: false,
        tile_size_bins: size,
    }
}
fn global_plans(total: u64, levels: &[u64]) -> Vec<(u64, u64, u64)> {
    let mut levels = levels.to_vec();
    levels.sort_unstable();
    levels.retain(|v| *v > 0);
    let Some(&coarse) = levels.last() else {
        return vec![];
    };
    let raw = total.div_ceil(320).max(1);
    let source = *levels.iter().min_by_key(|r| r.abs_diff(raw)).unwrap();
    let mut plans = vec![(source, raw.div_ceil(source) * source, 320)];
    for multiple in [3, 2, 1, 4] {
        if let Some(target) = coarse.checked_mul(multiple) {
            plans.push((coarse, target, 256));
        }
    }
    if levels.len() > 1 {
        let r = levels[levels.len() - 2];
        plans.push((r, r, 256));
    }
    plans
}
pub(super) fn layout(state: AppState, dataset: Arc<Dataset>, blocks: Vec<LayoutBlockRequest>) {
    if !enabled() || blocks.is_empty() {
        return;
    }
    let total = span(&blocks);
    let layout = disk_cache::digest(format!("{:?}", blocks).as_bytes());
    let mut jobs = Vec::new();
    for (source, target, size) in global_plans(total, &dataset.metadata.available_resolutions) {
        let Some(tile_span) = target.checked_mul(size) else {
            continue;
        };
        let n = total.div_ceil(tile_span);
        if n > 16 {
            continue;
        }
        let request = Arc::new(base(blocks.clone(), source, target, size, total));
        for x in 0..n {
            for y in x..n {
                if jobs.len() >= 128 {
                    break;
                }
                jobs.push(Job {
                    dataset: dataset.clone(),
                    request: request.clone(),
                    tile: TileKeyRequest {
                        tile_x: x,
                        tile_y: y,
                    },
                    layout: layout.clone(),
                    neighbor: false,
                });
            }
        }
    }
    enqueue(state, jobs, false);
}
pub(super) fn neighbors(state: AppState, dataset: Arc<Dataset>, request: RenderRequest) {
    if !enabled() || request.adaptive_refinement || request.overview || request.tiles.is_empty() {
        return;
    }
    let Some(target) = request.target_resolution else {
        return;
    };
    let Some(tile_span) = target.checked_mul(request.tile_size_bins) else {
        return;
    };
    let n = span(&request.layout_blocks).div_ceil(tile_span);
    let visible: BTreeSet<_> = request
        .tiles
        .iter()
        .map(|t| canonical_tile(t.tile_x, t.tile_y))
        .collect();
    let mut nearby = BTreeSet::new();
    for &(x, y) in &visible {
        for a in x.saturating_sub(1)..=x.saturating_add(1).min(n.saturating_sub(1)) {
            for b in y.saturating_sub(1)..=y.saturating_add(1).min(n.saturating_sub(1)) {
                let t = canonical_tile(a, b);
                if !visible.contains(&t) {
                    nearby.insert(t);
                }
            }
        }
    }
    let layout = disk_cache::digest(format!("{:?}", request.layout_blocks).as_bytes());
    let request = Arc::new(request);
    let jobs = nearby
        .into_iter()
        .take(16)
        .map(|(x, y)| Job {
            dataset: dataset.clone(),
            request: request.clone(),
            tile: TileKeyRequest {
                tile_x: x,
                tile_y: y,
            },
            layout: layout.clone(),
            neighbor: true,
        })
        .collect();
    enqueue(state, jobs, true);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overview_matches_desktop_plan() {
        let p = global_plans(3179259998, &[1000, 1000000, 2500000]);
        assert_eq!(p[0], (2500000, 10000000, 320));
        assert!(p.contains(&(2500000, 7500000, 256)));
    }
    #[test]
    fn foreground_cancels_background() {
        let c = Arc::new(AtomicBool::new(false));
        queue().lock().unwrap().active = Some(c.clone());
        {
            let _guard = foreground();
            assert!(c.load(Ordering::Relaxed));
        }
        let mut q = queue().lock().unwrap();
        q.active = None;
        // Other request-handler tests may hold their own foreground guard.
    }
}
