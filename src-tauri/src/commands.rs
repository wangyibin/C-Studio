use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

use cstudio_core::contact_cache::{ContactCache, ContactCacheKey};
use cstudio_core::coverage_cache::{CoverageCache, CoverageCacheKey};
use cstudio_core::source_contact_cache::{
    source_windows_for_ranges_with_limit, SourceContactCache, DEFAULT_SOURCE_CONTACT_CACHE_BYTES,
};
use cstudio_core::synteny_cache::{SyntenyCache, SyntenyCacheKey};

#[derive(Debug, Default)]
pub struct ContactCacheState {
    cache: Arc<Mutex<ContactCache>>,
}

#[derive(Debug, Default)]
pub struct ContactTileCacheState {
    cache: Arc<Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>>,
}

#[derive(Debug, Clone, Default)]
pub struct ContactTileRequestState {
    latest_generation: Arc<AtomicU64>,
    active_requests: Arc<Mutex<HashMap<u64, u64>>>,
}

impl ContactTileRequestState {
    fn retain_and_begin_generation(
        &self,
        generation: u64,
        retained_request_ids: &[u64],
    ) -> Result<Vec<u64>, String> {
        let mut active_requests = self
            .active_requests
            .lock()
            .map_err(|_| "contact tile request state lock poisoned".to_string())?;
        if generation < self.latest_generation.load(Ordering::SeqCst) {
            return Ok(Vec::new());
        }
        let mut retained = Vec::new();
        for request_id in retained_request_ids {
            if let Some(active_generation) = active_requests.get_mut(request_id) {
                *active_generation = (*active_generation).max(generation);
                retained.push(*request_id);
            }
        }
        retained.sort_unstable();
        retained.dedup();
        self.latest_generation
            .fetch_max(generation, Ordering::SeqCst);
        Ok(retained)
    }

    fn register(&self, request_id: u64, generation: u64) -> Result<(), String> {
        let mut active_requests = self
            .active_requests
            .lock()
            .map_err(|_| "contact tile request state lock poisoned".to_string())?;
        if generation < self.latest_generation.load(Ordering::SeqCst) {
            return Err("contact tile request cancelled".to_string());
        }
        if active_requests.contains_key(&request_id) {
            return Err(format!(
                "contact tile request {request_id} is already active"
            ));
        }
        active_requests.insert(request_id, generation);
        self.latest_generation
            .fetch_max(generation, Ordering::SeqCst);
        Ok(())
    }

    fn is_cancelled(&self, request_id: u64) -> bool {
        let Ok(active_requests) = self.active_requests.lock() else {
            return true;
        };
        let latest_generation = self.latest_generation.load(Ordering::SeqCst);
        active_requests
            .get(&request_id)
            .is_none_or(|generation| *generation < latest_generation)
    }

    fn finish(&self, request_id: u64) {
        if let Ok(mut active_requests) = self.active_requests.lock() {
            active_requests.remove(&request_id);
        }
    }
}

struct ContactTileRequestGuard {
    state: ContactTileRequestState,
    request_id: u64,
}

impl Drop for ContactTileRequestGuard {
    fn drop(&mut self) {
        self.state.finish(self.request_id);
    }
}

#[derive(Debug)]
pub struct SourceContactCacheState {
    cache: Arc<Mutex<SourceContactCache>>,
}

impl Default for SourceContactCacheState {
    fn default() -> Self {
        const MIB: usize = 1024 * 1024;
        const MAX_CACHE_MIB: usize = 512;
        let configured_mib = std::env::var("CSTUDIO_SOURCE_CACHE_MB")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .map(|value| value.clamp(16, MAX_CACHE_MIB));
        let max_bytes = configured_mib
            .map(|value| value * MIB)
            .unwrap_or(DEFAULT_SOURCE_CONTACT_CACHE_BYTES);
        Self {
            cache: Arc::new(Mutex::new(SourceContactCache::new(max_bytes))),
        }
    }
}

#[derive(Debug, Default)]
pub struct CoverageCacheState {
    cache: Arc<Mutex<CoverageCache>>,
}

#[derive(Debug, Default)]
pub struct SyntenyCacheState {
    cache: Arc<Mutex<SyntenyCache>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ContactTileCacheKey {
    path: String,
    resolution: u64,
    tile_size_bins: u64,
    normalization: ContactNormalizationRequest,
    projection_fingerprint: String,
    tile_x: u64,
    tile_y: u64,
}

#[derive(Debug, Default)]
struct ContactTileStageTimings {
    prepare: Cell<Duration>,
    visual_cache: Cell<Duration>,
    source_planning: Cell<Duration>,
    source_cache: Cell<Duration>,
    cool_read: Cell<Duration>,
    projection: Cell<Duration>,
    response_pack: Cell<Duration>,
    store: Cell<Duration>,
    total: Cell<Duration>,
    visual_hits: Cell<usize>,
    visual_misses: Cell<usize>,
    source_hits: Cell<usize>,
    source_misses: Cell<usize>,
    cool_reads: Cell<usize>,
    response_cells: Cell<usize>,
}

static CONTACT_TILE_PERF_LOG_ENABLED: OnceLock<bool> = OnceLock::new();

fn contact_tile_perf_logging_enabled() -> bool {
    *CONTACT_TILE_PERF_LOG_ENABLED
        .get_or_init(|| std::env::var("CSTUDIO_PERF_LOG").ok().as_deref() == Some("1"))
}

#[derive(Debug, Clone, Copy)]
struct ContactTilePerfContext<'a> {
    scenario: &'a str,
    request_id: u64,
    generation: u64,
    base_resolution: u64,
    target_resolution: u64,
    tile_size_bins: u64,
    normalization: ContactNormalizationRequest,
    layout_blocks: usize,
    requested_tiles: usize,
    returned_tiles: usize,
}

impl ContactTileStageTimings {
    fn line(&self, context: ContactTilePerfContext<'_>) -> String {
        format!(
            "CSTUDIO_PERF event=contact_tiles scenario={} status=ok \
             request_id={} generation={} base_resolution={} target_resolution={} \
             tile_size_bins={} normalization={} layout_blocks={} \
             requested_tiles={} returned_tiles={} \
             visual_hits={} visual_misses={} source_hits={} source_misses={} \
             cool_reads={} response_cells={} prepare_us={} visual_cache_us={} \
             source_planning_us={} source_cache_us={} cool_read_us={} projection_us={} \
             response_pack_us={} store_us={} total_us={}",
            context.scenario,
            context.request_id,
            context.generation,
            context.base_resolution,
            context.target_resolution,
            context.tile_size_bins,
            context.normalization.cache_key(),
            context.layout_blocks,
            context.requested_tiles,
            context.returned_tiles,
            self.visual_hits.get(),
            self.visual_misses.get(),
            self.source_hits.get(),
            self.source_misses.get(),
            self.cool_reads.get(),
            self.response_cells.get(),
            self.prepare.get().as_micros(),
            self.visual_cache.get().as_micros(),
            self.source_planning.get().as_micros(),
            self.source_cache.get().as_micros(),
            self.cool_read.get().as_micros(),
            self.projection.get().as_micros(),
            self.response_pack.get().as_micros(),
            self.store.get().as_micros(),
            self.total.get().as_micros(),
        )
    }
}

struct ContactTileStageSpan<'a> {
    accumulator: &'a Cell<Duration>,
    started: Instant,
}

impl<'a> ContactTileStageSpan<'a> {
    fn new(accumulator: &'a Cell<Duration>) -> Self {
        Self {
            accumulator,
            started: Instant::now(),
        }
    }
}

impl Drop for ContactTileStageSpan<'_> {
    fn drop(&mut self) {
        self.accumulator.set(
            self.accumulator
                .get()
                .saturating_add(self.started.elapsed()),
        );
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactNormalizationRequest {
    #[default]
    Raw,
    Ice,
    Kr,
    Vc,
    VcSqrt,
}

impl ContactNormalizationRequest {
    fn cache_key(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Ice => "ice",
            Self::Kr => "kr",
            Self::Vc => "vc",
            Self::VcSqrt => "vc_sqrt",
        }
    }
}

impl From<ContactNormalizationRequest>
    for cstudio_core::contact_normalization::ContactNormalization
{
    fn from(value: ContactNormalizationRequest) -> Self {
        match value {
            ContactNormalizationRequest::Raw => Self::Raw,
            ContactNormalizationRequest::Ice => Self::Ice,
            ContactNormalizationRequest::Kr => Self::Kr,
            ContactNormalizationRequest::Vc => Self::Vc,
            ContactNormalizationRequest::VcSqrt => Self::VcSqrt,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppStatus {
    pub engine: String,
    pub coordinate_convention: String,
    pub supported_operations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExampleDatasetSummary {
    pub agp_path: String,
    pub mcool_path: String,
    pub cool_path: String,
    pub paf_path: Option<String>,
    pub agp_lines: usize,
    pub agp_objects: usize,
    pub agp_components: usize,
    pub agp_gaps: usize,
    pub max_object_span: u64,
    pub mcool_size_bytes: u64,
    pub coverage_path: Option<String>,
    pub agp_layout: AgpLayoutResponse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportedContactFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgpLayoutResponse {
    pub blocks: Vec<ContactMapLayoutBlockResponse>,
    pub total_span: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgpGapMetadataResponse {
    pub component_type: String,
    pub length: u64,
    pub gap_type: String,
    pub linkage: String,
    pub linkage_evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapLayoutBlockResponse {
    pub id: String,
    pub object_id: String,
    pub source_id: String,
    pub source_start: u64,
    pub source_end: u64,
    pub visual_start: u64,
    pub orientation: String,
    pub component_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap_before: Option<AgpGapMetadataResponse>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapViewRequest {
    pub base_resolution: u64,
    pub target_resolution: u64,
    pub viewport: ContactMapViewportRequest,
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
    pub contact_bins: Vec<ContactMapBinRequest>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapViewFromCoolRequest {
    pub cool_path: String,
    pub base_resolution: u64,
    pub target_resolution: u64,
    #[serde(default)]
    pub normalization: ContactNormalizationRequest,
    pub viewport: ContactMapViewportRequest,
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapTilesFromCoolRequest {
    pub request_id: u64,
    pub generation: u64,
    pub cool_path: String,
    pub base_resolution: u64,
    pub target_resolution: u64,
    pub tile_size_bins: u64,
    #[serde(default)]
    pub normalization: ContactNormalizationRequest,
    pub tiles: Vec<ContactMapTileKeyRequest>,
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginContactTileGenerationRequest {
    pub generation: u64,
    pub retained_request_ids: Vec<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapTileKeyRequest {
    pub tile_x: u64,
    pub tile_y: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapViewportRequest {
    pub x_start: u64,
    pub x_end: u64,
    pub y_start: u64,
    pub y_end: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapLayoutBlockRequest {
    pub id: String,
    pub source_id: String,
    pub source_start: u64,
    pub source_end: u64,
    pub visual_start: u64,
    pub orientation: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapBinRequest {
    pub source1: String,
    pub start1: u64,
    pub source2: String,
    pub start2: u64,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapViewResponse {
    pub resolution: u64,
    pub viewport: ContactMapViewportResponse,
    pub cells: Vec<ContactMapCellResponse>,
    pub tile_size_bins: u64,
    pub tiles: Vec<ContactMapTileResponse>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapViewportResponse {
    pub x_start: u64,
    pub x_end: u64,
    pub y_start: u64,
    pub y_end: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapCellResponse {
    pub x_bin: u64,
    pub y_bin: u64,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapTileResponse {
    pub tile_x: u64,
    pub tile_y: u64,
    pub cells: Vec<ContactMapCellResponse>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageViewRequest {
    pub display_resolution: u64,
    pub viewport: ContactMapViewportRequest,
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
    pub bedgraph_records: Vec<BedGraphRecordRequest>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageViewFromBedGraphRequest {
    pub bedgraph_path: String,
    pub display_resolution: u64,
    pub viewport: ContactMapViewportRequest,
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedGraphRecordRequest {
    pub chrom: String,
    pub start: u64,
    pub end: u64,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageViewResponse {
    pub resolution: u64,
    pub viewport: ContactMapViewportResponse,
    pub bins: Vec<CoverageBinResponse>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageBinResponse {
    pub x_bin: u64,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntenyViewRequest {
    pub viewport: ContactMapViewportRequest,
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
    pub paf_records: Vec<PafRecordRequest>,
    pub min_mapq: u8,
    pub min_alignment_len: u64,
    pub max_query_gap: u64,
    pub max_target_gap: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntenyViewFromPafRequest {
    pub paf_path: String,
    pub viewport: ContactMapViewportRequest,
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
    pub min_mapq: u8,
    pub min_alignment_len: u64,
    pub max_query_gap: u64,
    pub max_target_gap: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PafRecordRequest {
    pub query_name: String,
    pub query_len: u64,
    pub query_start: u64,
    pub query_end: u64,
    pub strand: String,
    pub target_name: String,
    pub target_len: u64,
    pub target_start: u64,
    pub target_end: u64,
    pub residue_matches: u64,
    pub alignment_block_len: u64,
    pub mapq: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntenyViewResponse {
    pub viewport: ContactMapViewportResponse,
    pub blocks: Vec<SyntenyBlockResponse>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntenyBlockResponse {
    pub assembly_block_id: String,
    pub query_source_id: String,
    pub visual_start: u64,
    pub visual_end: u64,
    pub target_id: String,
    pub target_length: u64,
    pub target_start: u64,
    pub target_end: u64,
    pub strand: String,
    pub mapq: u8,
    pub alignment_count: usize,
}

#[tauri::command]
pub fn get_app_status() -> AppStatus {
    let status = cstudio_core::core_status();

    AppStatus {
        engine: status.engine.to_string(),
        coordinate_convention: status.coordinate_convention.to_string(),
        supported_operations: status
            .supported_operations
            .into_iter()
            .map(str::to_string)
            .collect(),
    }
}

#[tauri::command]
pub fn load_example_dataset() -> Result<ExampleDatasetSummary, String> {
    let root = project_root();
    let agp_path = root.join("examples/groups.agp");
    let coverage_path = root.join("examples/input.1000.coverage.bedgraph");
    let paf_path = root.join("examples/ref_vs_contig.paf");
    let preferred_contact_path = root.join("examples/input.q1.mcool");
    let fallback_contact_path = root.join("examples/input.q1.1k.cool");
    let contact_path = if preferred_contact_path.exists() {
        preferred_contact_path
    } else {
        fallback_contact_path
    };
    let agp_text = fs::read_to_string(&agp_path).map_err(|error| error.to_string())?;
    let agp_summary =
        cstudio_core::agp::AgpSummary::parse(&agp_text).map_err(|error| error.to_string())?;
    let mcool_size_bytes = fs::metadata(&contact_path)
        .map_err(|error| error.to_string())?
        .len();
    fs::metadata(&coverage_path).map_err(|error| error.to_string())?;
    fs::metadata(&paf_path).map_err(|error| error.to_string())?;
    let contact_name = contact_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("input.q1.1k.cool");

    Ok(ExampleDatasetSummary {
        agp_path: "examples/groups.agp".to_string(),
        mcool_path: format!("examples/{contact_name}"),
        cool_path: contact_path.to_string_lossy().to_string(),
        paf_path: Some(paf_path.to_string_lossy().to_string()),
        agp_lines: agp_summary.line_count,
        agp_objects: agp_summary.object_count,
        agp_components: agp_summary.component_count,
        agp_gaps: agp_summary.gap_count,
        max_object_span: agp_summary.max_object_span,
        mcool_size_bytes,
        coverage_path: Some(coverage_path.to_string_lossy().to_string()),
        agp_layout: parse_agp_layout_for_response(&agp_text)?,
    })
}

#[tauri::command]
pub fn select_contact_file() -> Result<Option<ImportedContactFile>, String> {
    let Some(path) = choose_contact_file_path()? else {
        return Ok(None);
    };

    contact_file_from_path(&path).map(Some)
}

#[tauri::command]
pub fn select_coverage_file() -> Result<Option<ImportedContactFile>, String> {
    let Some(path) = choose_coverage_file_path()? else {
        return Ok(None);
    };

    coverage_file_from_path(&path).map(Some)
}

#[tauri::command]
pub fn select_paf_file() -> Result<Option<ImportedContactFile>, String> {
    let Some(path) = choose_paf_file_path()? else {
        return Ok(None);
    };
    paf_file_from_path(&path).map(Some)
}

#[tauri::command]
pub fn save_agp_file(default_filename: String, contents: String) -> Result<Option<String>, String> {
    let Some(path) = choose_agp_save_path(&default_filename)? else {
        return Ok(None);
    };

    fs::write(&path, contents).map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn build_contact_map_view(
    request: ContactMapViewRequest,
) -> Result<ContactMapViewResponse, String> {
    let query = contact_map_query_from_parts(
        request.base_resolution,
        request.target_resolution,
        request.viewport,
        request.layout_blocks,
    )?;

    let contacts =
        request
            .contact_bins
            .into_iter()
            .map(|bin| cstudio_core::contact_map::ContactBin {
                source1: bin.source1,
                start1: bin.start1,
                source2: bin.source2,
                start2: bin.start2,
                count: bin.count,
            });

    contact_map_response_from_view(
        cstudio_core::contact_map::build_contact_map_view(&query, contacts)
            .map_err(|error| error.to_string())?,
    )
}

#[tauri::command]
pub async fn build_contact_map_view_from_cool(
    request: ContactMapViewFromCoolRequest,
    cache_state: tauri::State<'_, ContactCacheState>,
) -> Result<ContactMapViewResponse, String> {
    let cache = Arc::clone(&cache_state.inner().cache);
    tauri::async_runtime::spawn_blocking(move || {
        build_contact_map_view_from_cool_with_cache(request, cache.as_ref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn begin_contact_tile_generation(
    request: BeginContactTileGenerationRequest,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<Vec<u64>, String> {
    request_state.retain_and_begin_generation(request.generation, &request.retained_request_ids)
}

#[tauri::command]
pub async fn get_contact_map_tiles_from_cool(
    request: ContactMapTilesFromCoolRequest,
    source_cache_state: tauri::State<'_, SourceContactCacheState>,
    tile_cache_state: tauri::State<'_, ContactTileCacheState>,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<Vec<ContactMapTileResponse>, String> {
    let request_id = request.request_id;
    let generation = request.generation;
    request_state.register(request_id, generation)?;
    let _request_guard = ContactTileRequestGuard {
        state: request_state.inner().clone(),
        request_id,
    };
    let source_cache = Arc::clone(&source_cache_state.inner().cache);
    let tile_cache = Arc::clone(&tile_cache_state.inner().cache);
    let task_request_state = request_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_contact_map_tiles_from_cool_with_cache_cancellable(
            request,
            source_cache.as_ref(),
            tile_cache.as_ref(),
            &|| task_request_state.is_cancelled(request_id),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
fn get_contact_map_tiles_from_cool_with_cache(
    request: ContactMapTilesFromCoolRequest,
    source_cache: &Mutex<SourceContactCache>,
    tile_cache: &Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>,
) -> Result<Vec<ContactMapTileResponse>, String> {
    get_contact_map_tiles_from_cool_with_cache_cancellable(
        request,
        source_cache,
        tile_cache,
        &|| false,
    )
}

fn get_contact_map_tiles_from_cool_with_cache_cancellable(
    request: ContactMapTilesFromCoolRequest,
    source_cache: &Mutex<SourceContactCache>,
    tile_cache: &Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<ContactMapTileResponse>, String> {
    let request_id = request.request_id;
    let generation = request.generation;
    let base_resolution = request.base_resolution;
    let target_resolution = request.target_resolution;
    let tile_size_bins = request.tile_size_bins;
    let normalization = request.normalization;
    let layout_blocks = request.layout_blocks.len();
    let requested_tiles = request.tiles.len();
    let (result, timings) =
        profile_contact_tile_request(request, source_cache, tile_cache, should_cancel);
    if contact_tile_perf_logging_enabled() {
        if let Ok(tiles) = result.as_ref() {
            eprintln!(
                "{}",
                timings.line(ContactTilePerfContext {
                    scenario: "request",
                    request_id,
                    generation,
                    base_resolution,
                    target_resolution,
                    tile_size_bins,
                    normalization,
                    layout_blocks,
                    requested_tiles,
                    returned_tiles: tiles.len(),
                })
            );
        }
    }
    result
}

fn profile_contact_tile_request(
    request: ContactMapTilesFromCoolRequest,
    source_cache: &Mutex<SourceContactCache>,
    tile_cache: &Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>,
    should_cancel: &dyn Fn() -> bool,
) -> (
    Result<Vec<ContactMapTileResponse>, String>,
    ContactTileStageTimings,
) {
    let timings = ContactTileStageTimings::default();
    let started = Instant::now();
    let result = get_contact_map_tiles_from_cool_inner(
        request,
        source_cache,
        tile_cache,
        should_cancel,
        &timings,
    );
    timings.total.set(started.elapsed());
    (result, timings)
}

fn get_contact_map_tiles_from_cool_inner(
    mut request: ContactMapTilesFromCoolRequest,
    source_cache: &Mutex<SourceContactCache>,
    tile_cache: &Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>,
    should_cancel: &dyn Fn() -> bool,
    timings: &ContactTileStageTimings,
) -> Result<Vec<ContactMapTileResponse>, String> {
    let tile_span;
    let axis_fingerprints;
    let requested_tile_keys;
    {
        let _stage = ContactTileStageSpan::new(&timings.prepare);
        ensure_contact_tile_request_active(should_cancel)?;
        let mut canonical_tiles = BTreeMap::new();
        for tile in request.tiles.drain(..) {
            let canonical = if tile.tile_x <= tile.tile_y {
                tile
            } else {
                ContactMapTileKeyRequest {
                    tile_x: tile.tile_y,
                    tile_y: tile.tile_x,
                }
            };
            canonical_tiles.insert((canonical.tile_x, canonical.tile_y), canonical);
        }
        request.tiles = canonical_tiles.into_values().collect();

        ensure_contact_tile_request_active(should_cancel)?;
        if request.tiles.is_empty() {
            return Ok(Vec::new());
        }

        tile_span = request
            .tile_size_bins
            .saturating_mul(request.target_resolution);
        let mut fingerprints = BTreeMap::<u64, String>::new();
        for tile in &request.tiles {
            for axis in [tile.tile_x, tile.tile_y] {
                fingerprints.entry(axis).or_insert_with(|| {
                    contact_projection_axis_fingerprint(axis, tile_span, &request.layout_blocks)
                });
            }
        }
        requested_tile_keys = request
            .tiles
            .iter()
            .map(|tile| ContactTileCacheKey {
                path: request.cool_path.clone(),
                resolution: request.target_resolution,
                tile_size_bins: request.tile_size_bins,
                normalization: request.normalization,
                projection_fingerprint: format!(
                    "{}:{}",
                    fingerprints
                        .get(&tile.tile_x)
                        .expect("tile X axis fingerprint was precomputed"),
                    fingerprints
                        .get(&tile.tile_y)
                        .expect("tile Y axis fingerprint was precomputed")
                ),
                tile_x: tile.tile_x,
                tile_y: tile.tile_y,
            })
            .collect::<Vec<_>>();
        axis_fingerprints = fingerprints;
    }

    let mut cached_tiles = BTreeMap::new();
    let mut missing_tiles = Vec::new();
    {
        let _stage = ContactTileStageSpan::new(&timings.visual_cache);
        let tile_cache = tile_cache
            .lock()
            .map_err(|_| "contact tile cache lock poisoned".to_string())?;
        for (tile, key) in request.tiles.iter().zip(requested_tile_keys.iter()) {
            if let Some(cached_tile) = tile_cache.get(key) {
                cached_tiles.insert((tile.tile_x, tile.tile_y), cached_tile.clone());
            } else {
                missing_tiles.push(*tile);
            }
        }
    }
    timings
        .visual_hits
        .set(timings.visual_hits.get().saturating_add(cached_tiles.len()));
    timings.visual_misses.set(
        timings
            .visual_misses
            .get()
            .saturating_add(missing_tiles.len()),
    );
    ensure_contact_tile_request_active(should_cancel)?;

    if missing_tiles.is_empty() {
        let _stage = ContactTileStageSpan::new(&timings.response_pack);
        return Ok(request
            .tiles
            .into_iter()
            .filter_map(|tile| cached_tiles.remove(&(tile.tile_x, tile.tile_y)))
            .collect());
    }

    // A partially populated cache can leave holes inside one frontend batch.
    // Never turn those sparse misses back into one large min/max rectangle:
    // partition them into dense regions whose union is exactly the missing
    // tile set, then load only those regions.
    let work_regions = {
        let _stage = ContactTileStageSpan::new(&timings.source_planning);
        contact_tile_work_regions(&missing_tiles)
    };
    if work_regions.len() > 1 {
        for region_tiles in work_regions {
            let mut region_request = request.clone();
            region_request.tiles = region_tiles;
            let loaded_tiles = get_contact_map_tiles_from_cool_inner(
                region_request,
                source_cache,
                tile_cache,
                should_cancel,
                timings,
            )?;
            for tile in loaded_tiles {
                cached_tiles.insert((tile.tile_x, tile.tile_y), tile);
            }
        }
        let _stage = ContactTileStageSpan::new(&timings.response_pack);
        return Ok(request
            .tiles
            .into_iter()
            .filter_map(|tile| cached_tiles.remove(&(tile.tile_x, tile.tile_y)))
            .collect());
    }

    let (source_ranges, query, source_windows, source_cache_path, source_cache_keys) = {
        let _stage = ContactTileStageSpan::new(&timings.source_planning);
        let min_tile_x = missing_tiles
            .iter()
            .map(|tile| tile.tile_x)
            .min()
            .unwrap_or(0);
        let max_tile_x = missing_tiles
            .iter()
            .map(|tile| tile.tile_x)
            .max()
            .unwrap_or(min_tile_x);
        let min_tile_y = missing_tiles
            .iter()
            .map(|tile| tile.tile_y)
            .min()
            .unwrap_or(0);
        let max_tile_y = missing_tiles
            .iter()
            .map(|tile| tile.tile_y)
            .max()
            .unwrap_or(min_tile_y);
        let viewport = ContactMapViewportRequest {
            x_start: min_tile_x.saturating_mul(tile_span),
            x_end: max_tile_x.saturating_add(1).saturating_mul(tile_span),
            y_start: min_tile_y.saturating_mul(tile_span),
            y_end: max_tile_y.saturating_add(1).saturating_mul(tile_span),
        };

        ensure_contact_tile_request_active(should_cancel)?;
        let source_ranges = source_ranges_for_contact_viewport(&viewport, &request.layout_blocks);
        let query = contact_map_query_from_parts(
            request.base_resolution,
            request.target_resolution,
            viewport,
            request.layout_blocks.clone(),
        )?;
        // 180 windows produce 16,290 upper-triangle pairs. The next window would
        // exceed the 16,384-pair cache budget. Stop collecting at that point so a
        // deliberately wide or very fragmented viewport cannot first allocate a
        // huge source-window vector only to bypass the cache afterwards.
        const MAX_CACHE_WINDOWS_PER_REQUEST: usize = 180;
        let source_windows = source_windows_for_ranges_with_limit(
            &source_ranges,
            tile_span,
            MAX_CACHE_WINDOWS_PER_REQUEST,
        );
        ensure_contact_tile_request_active(should_cancel)?;
        let source_cache_path = fs::metadata(&request.cool_path)
            .map(|metadata| {
                let modified_nanos = metadata
                    .modified()
                    .ok()
                    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_nanos())
                    .unwrap_or(0);
                format!(
                    "{}|{}|{}|normalization={}",
                    request.cool_path,
                    metadata.len(),
                    modified_nanos,
                    request.normalization.cache_key(),
                )
            })
            .unwrap_or_else(|_| {
                format!(
                    "{}|normalization={}",
                    request.cool_path,
                    request.normalization.cache_key(),
                )
            });
        let source_cache_keys = source_windows.as_ref().map(|source_windows| {
            SourceContactCache::keys_for_windows(
                &source_cache_path,
                request.target_resolution,
                source_windows,
            )
        });
        (
            source_ranges,
            query,
            source_windows,
            source_cache_path,
            source_cache_keys,
        )
    };

    let cached_view = if let Some(keys) = source_cache_keys.as_ref() {
        let (mut source_cache, has_all) = {
            let _stage = ContactTileStageSpan::new(&timings.source_cache);
            let source_cache = source_cache
                .lock()
                .map_err(|_| "source contact cache lock poisoned".to_string())?;
            let has_all = source_cache.contains_all(keys);
            (source_cache, has_all)
        };
        if has_all {
            timings
                .source_hits
                .set(timings.source_hits.get().saturating_add(1));
            let _stage = ContactTileStageSpan::new(&timings.projection);
            source_cache
                .build_cached_view_cancellable(keys, &query, should_cancel)
                .map_err(|error| error.to_string())?
        } else {
            timings
                .source_misses
                .set(timings.source_misses.get().saturating_add(1));
            None
        }
    } else {
        None
    };

    let view = if let Some(view) = cached_view {
        view
    } else if source_ranges.is_empty() {
        let _stage = ContactTileStageSpan::new(&timings.projection);
        cstudio_core::contact_map::build_contact_map_view_from_contacts_cancellable(
            &query,
            Vec::<cstudio_core::contact_map::ContactBin>::new(),
            should_cancel,
        )
        .map_err(|error| error.to_string())?
    } else {
        let cache_window_ranges = {
            let _stage = ContactTileStageSpan::new(&timings.source_planning);
            source_windows.as_ref().map(|source_windows| {
                source_windows
                    .iter()
                    .map(|window| (window.source_id.clone(), window.start, window.end))
                    .collect::<Vec<_>>()
            })
        };
        let read_ranges = cache_window_ranges
            .as_deref()
            .unwrap_or(source_ranges.as_slice());
        ensure_contact_tile_request_active(should_cancel)?;
        timings
            .cool_reads
            .set(timings.cool_reads.get().saturating_add(1));
        let contacts = {
            let _stage = ContactTileStageSpan::new(&timings.cool_read);
            cstudio_core::cool::read_cool_contacts_for_source_ranges_at_resolution_with_normalization_cancellable(
                &request.cool_path,
                read_ranges,
                Some(request.target_resolution),
                request.normalization.into(),
                should_cancel,
            )
            .map_err(|error| error.to_string())?
        };
        ensure_contact_tile_request_active(should_cancel)?;

        if let (Some(keys), Some(source_windows)) =
            (source_cache_keys.as_ref(), source_windows.as_ref())
        {
            let mut source_cache = {
                let _stage = ContactTileStageSpan::new(&timings.source_cache);
                let mut source_cache = source_cache
                    .lock()
                    .map_err(|_| "source contact cache lock poisoned".to_string())?;
                source_cache
                    .insert_contacts_for_windows_cancellable(
                        &source_cache_path,
                        request.target_resolution,
                        source_windows,
                        &contacts,
                        should_cancel,
                    )
                    .map_err(|error| error.to_string())?;
                source_cache
            };
            ensure_contact_tile_request_active(should_cancel)?;
            let cached_projection = {
                let _stage = ContactTileStageSpan::new(&timings.projection);
                source_cache
                    .build_cached_view_cancellable(keys, &query, should_cancel)
                    .map_err(|error| error.to_string())?
            };
            if let Some(view) = cached_projection {
                view
            } else {
                let _stage = ContactTileStageSpan::new(&timings.projection);
                cstudio_core::contact_map::build_contact_map_view_from_contacts_cancellable(
                    &query,
                    contacts,
                    should_cancel,
                )
                .map_err(|error| error.to_string())?
            }
        } else {
            let _stage = ContactTileStageSpan::new(&timings.projection);
            cstudio_core::contact_map::build_contact_map_view_from_contacts_cancellable(
                &query,
                contacts,
                should_cancel,
            )
            .map_err(|error| error.to_string())?
        }
    };
    ensure_contact_tile_request_active(should_cancel)?;
    let (missing, response_tiles) = {
        let _stage = ContactTileStageSpan::new(&timings.response_pack);
        let missing = missing_tiles
            .into_iter()
            .map(|tile| (tile.tile_x, tile.tile_y))
            .collect::<BTreeSet<_>>();
        let response_tiles = contact_map_tiles_from_view_cancellable(
            view,
            request.tile_size_bins,
            &missing,
            should_cancel,
        )?;
        (missing, response_tiles)
    };
    timings.response_cells.set(
        timings.response_cells.get().saturating_add(
            response_tiles
                .iter()
                .map(|tile| tile.cells.len())
                .sum::<usize>(),
        ),
    );

    ensure_contact_tile_request_active(should_cancel)?;
    {
        let _stage = ContactTileStageSpan::new(&timings.store);
        let mut tile_cache = tile_cache
            .lock()
            .map_err(|_| "contact tile cache lock poisoned".to_string())?;
        const MAX_VISUAL_TILE_CACHE_ENTRIES: usize = 512;
        let overflow = tile_cache
            .len()
            .saturating_add(missing.len())
            .saturating_sub(MAX_VISUAL_TILE_CACHE_ENTRIES);
        let stale_keys = tile_cache
            .keys()
            .take(overflow)
            .cloned()
            .collect::<Vec<_>>();
        for key in stale_keys {
            tile_cache.remove(&key);
        }
        for tile in response_tiles {
            let (tile_x, tile_y) = (tile.tile_x, tile.tile_y);
            tile_cache.insert(
                ContactTileCacheKey {
                    path: request.cool_path.clone(),
                    resolution: request.target_resolution,
                    tile_size_bins: request.tile_size_bins,
                    normalization: request.normalization,
                    projection_fingerprint: format!(
                        "{}:{}",
                        axis_fingerprints
                            .get(&tile_x)
                            .expect("tile X axis fingerprint was precomputed"),
                        axis_fingerprints
                            .get(&tile_y)
                            .expect("tile Y axis fingerprint was precomputed")
                    ),
                    tile_x,
                    tile_y,
                },
                tile.clone(),
            );
            cached_tiles.insert((tile_x, tile_y), tile);
        }
    }

    ensure_contact_tile_request_active(should_cancel)?;
    let _stage = ContactTileStageSpan::new(&timings.response_pack);
    Ok(request
        .tiles
        .into_iter()
        .filter_map(|tile| cached_tiles.remove(&(tile.tile_x, tile.tile_y)))
        .collect())
}

fn ensure_contact_tile_request_active(should_cancel: &dyn Fn() -> bool) -> Result<(), String> {
    if should_cancel() {
        Err("contact tile request cancelled".to_string())
    } else {
        Ok(())
    }
}

fn contact_tile_work_regions(
    tiles: &[ContactMapTileKeyRequest],
) -> Vec<Vec<ContactMapTileKeyRequest>> {
    let mut rows = BTreeMap::<u64, Vec<u64>>::new();
    for tile in tiles {
        rows.entry(tile.tile_y).or_default().push(tile.tile_x);
    }

    let mut regions = Vec::<Vec<ContactMapTileKeyRequest>>::new();
    let mut active_spans = BTreeMap::<(u64, u64), usize>::new();
    let mut previous_y: Option<u64> = None;

    for (tile_y, mut tile_xs) in rows {
        tile_xs.sort_unstable();
        tile_xs.dedup();
        if previous_y.is_none_or(|previous| previous.saturating_add(1) != tile_y) {
            active_spans.clear();
        }

        let mut next_active_spans = BTreeMap::new();
        let mut run_start = 0;
        while run_start < tile_xs.len() {
            let mut run_end = run_start;
            while run_end + 1 < tile_xs.len()
                && tile_xs[run_end].saturating_add(1) == tile_xs[run_end + 1]
            {
                run_end += 1;
            }

            let span = (tile_xs[run_start], tile_xs[run_end]);
            let region_index = if let Some(region_index) = active_spans.get(&span).copied() {
                region_index
            } else {
                regions.push(Vec::new());
                regions.len() - 1
            };
            for tile_x in span.0..=span.1 {
                regions[region_index].push(ContactMapTileKeyRequest { tile_x, tile_y });
            }
            next_active_spans.insert(span, region_index);
            run_start = run_end + 1;
        }

        active_spans = next_active_spans;
        previous_y = Some(tile_y);
    }

    regions
}

fn build_contact_map_view_from_cool_with_cache(
    request: ContactMapViewFromCoolRequest,
    cache: &Mutex<ContactCache>,
) -> Result<ContactMapViewResponse, String> {
    let cool_path = request.cool_path.clone();
    let normalization = request.normalization;
    let query = contact_map_query_from_parts(
        request.base_resolution,
        request.target_resolution,
        request.viewport,
        request.layout_blocks,
    )?;
    let source_ids = query
        .layout_blocks
        .iter()
        .map(|block| block.source_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let key = ContactCacheKey {
        path: format!("{}|normalization={}", cool_path, normalization.cache_key(),),
        resolution: request.target_resolution,
        source_ids,
    };

    {
        let cache = cache
            .lock()
            .map_err(|_| "contact cache lock poisoned".to_string())?;
        if let Some(view) = cache
            .build_cached_view(&key, &query)
            .map_err(|error| error.to_string())?
        {
            return contact_map_response_from_view(view);
        }
    }

    let contacts =
        cstudio_core::cool::read_cool_contacts_for_sources_at_resolution_with_normalization(
            &cool_path,
            &key.source_ids,
            Some(key.resolution),
            normalization.into(),
        )
        .map_err(|error| error.to_string())?;

    let view = {
        let mut cache = cache
            .lock()
            .map_err(|_| "contact cache lock poisoned".to_string())?;
        if !cache.contains_key(&key) {
            cache.insert_contacts(key.clone(), contacts);
        }
        cache
            .build_cached_view(&key, &query)
            .map_err(|error| error.to_string())?
            .expect("contact cache entry was just inserted")
    };

    contact_map_response_from_view(view)
}

#[derive(Debug)]
struct ContactProjectionSegment<'a> {
    relative_visual_start: u64,
    relative_visual_end: u64,
    source_id: &'a str,
    source_start: u64,
    source_end: u64,
    reverse: bool,
    source_shares: Vec<(u64, u64)>,
}

/// Stable cross-runtime identity for one visual axis tile. The clipped source
/// projection and the copy-share intervals that affect it participate;
/// block/chromosome labels cannot affect contact pixels.
fn contact_projection_axis_fingerprint(
    axis: u64,
    tile_span: u64,
    layout_blocks: &[ContactMapLayoutBlockRequest],
) -> String {
    let tile_start = axis.saturating_mul(tile_span);
    let tile_end = tile_start.saturating_add(tile_span);
    let mut segments = Vec::<ContactProjectionSegment<'_>>::new();

    if tile_end > tile_start {
        for block in layout_blocks {
            let block_span = block.source_end.saturating_sub(block.source_start);
            if block_span == 0 {
                continue;
            }
            let block_visual_end = block.visual_start.saturating_add(block_span);
            let overlap_start = tile_start.max(block.visual_start);
            let overlap_end = tile_end.min(block_visual_end);
            if overlap_start >= overlap_end {
                continue;
            }
            let start_offset = overlap_start.saturating_sub(block.visual_start);
            let end_offset = overlap_end.saturating_sub(block.visual_start);
            let reverse =
                block.orientation == "-" || block.orientation.eq_ignore_ascii_case("reverse");
            let (source_start, source_end) = if reverse {
                (
                    block.source_end.saturating_sub(end_offset),
                    block.source_end.saturating_sub(start_offset),
                )
            } else {
                (
                    block.source_start.saturating_add(start_offset),
                    block.source_start.saturating_add(end_offset),
                )
            };
            let mut source_shares = layout_blocks
                .iter()
                .filter(|candidate| {
                    candidate.source_id == block.source_id
                        && candidate.source_start < candidate.source_end
                        && candidate.source_start < source_end
                        && candidate.source_end > source_start
                })
                .map(|candidate| {
                    (
                        candidate.source_start.max(source_start),
                        candidate.source_end.min(source_end),
                    )
                })
                .collect::<Vec<_>>();
            source_shares.sort_unstable();
            segments.push(ContactProjectionSegment {
                relative_visual_start: overlap_start.saturating_sub(tile_start),
                relative_visual_end: overlap_end.saturating_sub(tile_start),
                source_id: &block.source_id,
                source_start,
                source_end,
                reverse,
                source_shares,
            });
        }
    }

    segments.sort_by(|left, right| {
        left.relative_visual_start
            .cmp(&right.relative_visual_start)
            .then_with(|| left.relative_visual_end.cmp(&right.relative_visual_end))
            .then_with(|| left.source_id.as_bytes().cmp(right.source_id.as_bytes()))
            .then_with(|| left.source_start.cmp(&right.source_start))
            .then_with(|| left.source_end.cmp(&right.source_end))
            .then_with(|| left.reverse.cmp(&right.reverse))
    });

    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    fn write_byte(hash: &mut u64, byte: u8) {
        *hash = (*hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME);
    }
    fn write_u64(hash: &mut u64, value: u64) {
        for byte in value.to_le_bytes() {
            write_byte(hash, byte);
        }
    }

    let mut hash = FNV_OFFSET_BASIS;
    for byte in [b'C', b'S', b'T', b'L', 2] {
        write_byte(&mut hash, byte);
    }
    write_u64(&mut hash, segments.len() as u64);
    for segment in segments {
        write_u64(&mut hash, segment.relative_visual_start);
        write_u64(&mut hash, segment.relative_visual_end);
        write_u64(&mut hash, segment.source_start);
        write_u64(&mut hash, segment.source_end);
        write_byte(&mut hash, u8::from(segment.reverse));
        write_u64(&mut hash, segment.source_id.len() as u64);
        for byte in segment.source_id.as_bytes() {
            write_byte(&mut hash, *byte);
        }
        write_u64(&mut hash, segment.source_shares.len() as u64);
        for (source_start, source_end) in segment.source_shares {
            write_u64(&mut hash, source_start);
            write_u64(&mut hash, source_end);
        }
    }
    format!("{hash:016x}")
}

#[cfg(test)]
fn contact_tile_projection_fingerprint(
    tile_x: u64,
    tile_y: u64,
    tile_span: u64,
    layout_blocks: &[ContactMapLayoutBlockRequest],
) -> String {
    let (tile_x, tile_y) = if tile_x <= tile_y {
        (tile_x, tile_y)
    } else {
        (tile_y, tile_x)
    };
    format!(
        "{}:{}",
        contact_projection_axis_fingerprint(tile_x, tile_span, layout_blocks),
        contact_projection_axis_fingerprint(tile_y, tile_span, layout_blocks)
    )
}

fn source_ranges_for_contact_viewport(
    viewport: &ContactMapViewportRequest,
    layout_blocks: &[ContactMapLayoutBlockRequest],
) -> Vec<(String, u64, u64)> {
    let mut visual_ranges = [
        (viewport.x_start, viewport.x_end),
        (viewport.y_start, viewport.y_end),
    ];
    visual_ranges.sort_unstable();

    // X and Y may overlap near the diagonal. Normalize their half-open ranges
    // first so an overlapping layout block is never visited twice.
    let visual_range_count = if visual_ranges[0].1 >= visual_ranges[1].0 {
        visual_ranges[0].1 = visual_ranges[0].1.max(visual_ranges[1].1);
        1
    } else {
        2
    };

    // Borrow source ids while collecting and merging. Only the final compact
    // result owns strings, keeping temporary memory proportional to at most two
    // numeric ranges per layout block instead of cloning every id up front.
    let mut ranges: Vec<(&str, u64, u64)> = Vec::new();

    for block in layout_blocks {
        let block_span = block.source_end.saturating_sub(block.source_start);
        if block_span == 0 {
            continue;
        }
        let block_visual_start = block.visual_start;
        let block_visual_end = block.visual_start.saturating_add(block_span);

        for &(visual_start, visual_end) in &visual_ranges[..visual_range_count] {
            let overlap_start = visual_start.max(block_visual_start);
            let overlap_end = visual_end.min(block_visual_end);
            if overlap_start >= overlap_end {
                continue;
            }

            let offset_start = overlap_start - block_visual_start;
            let offset_end = overlap_end - block_visual_start;
            let (source_start, source_end) =
                if block.orientation == "-" || block.orientation.eq_ignore_ascii_case("reverse") {
                    (
                        block.source_end.saturating_sub(offset_end),
                        block.source_end.saturating_sub(offset_start),
                    )
                } else {
                    (
                        block.source_start.saturating_add(offset_start),
                        block.source_start.saturating_add(offset_end),
                    )
                };

            ranges.push((block.source_id.as_str(), source_start, source_end));
        }
    }

    ranges.sort_unstable_by(|left, right| {
        left.0
            .cmp(right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });

    let mut write_index = 0;
    for read_index in 0..ranges.len() {
        let (source_id, source_start, source_end) = ranges[read_index];
        if write_index > 0 {
            let (last_source_id, _last_start, last_end) = &mut ranges[write_index - 1];
            if *last_source_id == source_id && source_start <= *last_end {
                *last_end = (*last_end).max(source_end);
                continue;
            }
        }
        ranges[write_index] = (source_id, source_start, source_end);
        write_index += 1;
    }
    ranges.truncate(write_index);

    ranges
        .into_iter()
        .map(|(source_id, source_start, source_end)| {
            (source_id.to_owned(), source_start, source_end)
        })
        .collect()
}

#[tauri::command]
pub fn build_coverage_view(request: CoverageViewRequest) -> Result<CoverageViewResponse, String> {
    let query = coverage_query_from_parts(
        request.display_resolution,
        request.viewport,
        request.layout_blocks,
    )?;
    let records =
        request
            .bedgraph_records
            .into_iter()
            .map(|record| cstudio_core::coverage::BedGraphRecord {
                chrom: record.chrom,
                start: record.start,
                end: record.end,
                value: record.value,
            });

    coverage_response_from_view(
        cstudio_core::coverage::build_coverage_view(&query, records)
            .map_err(|error| error.to_string())?,
    )
}

#[tauri::command]
pub async fn build_coverage_view_from_bedgraph(
    request: CoverageViewFromBedGraphRequest,
    cache_state: tauri::State<'_, CoverageCacheState>,
) -> Result<CoverageViewResponse, String> {
    let cache = Arc::clone(&cache_state.inner().cache);
    tauri::async_runtime::spawn_blocking(move || {
        build_coverage_view_from_bedgraph_with_cache(request, cache.as_ref())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn build_coverage_view_from_bedgraph_with_cache(
    request: CoverageViewFromBedGraphRequest,
    cache: &Mutex<CoverageCache>,
) -> Result<CoverageViewResponse, String> {
    let query = coverage_query_from_parts(
        request.display_resolution,
        request.viewport,
        request.layout_blocks,
    )?;
    let metadata = fs::metadata(&request.bedgraph_path).map_err(|error| error.to_string())?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let key = CoverageCacheKey {
        path: request.bedgraph_path.clone(),
        size_bytes: metadata.len(),
        modified_nanos,
    };

    if let Some(view) = cache
        .lock()
        .map_err(|_| "coverage cache lock poisoned".to_string())?
        .build_cached_view(&key, &query)
        .map_err(|error| error.to_string())?
    {
        return coverage_response_from_view(view);
    }

    let file = fs::File::open(&request.bedgraph_path).map_err(|error| error.to_string())?;
    let mut records = Vec::new();

    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if let Some(record) = cstudio_core::coverage::BedGraphRecord::parse_line(&line)
            .map_err(|error| error.to_string())?
        {
            records.push(record);
        }
    }

    let mut cache = cache
        .lock()
        .map_err(|_| "coverage cache lock poisoned".to_string())?;
    if !cache.contains_key(&key) {
        cache.insert_records(key.clone(), records);
    }
    let view = cache
        .build_cached_view(&key, &query)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "coverage cache entry missing after import".to_string())?;
    coverage_response_from_view(view)
}

fn contact_map_query_from_parts(
    base_resolution: u64,
    target_resolution: u64,
    viewport: ContactMapViewportRequest,
    layout_blocks: Vec<ContactMapLayoutBlockRequest>,
) -> Result<cstudio_core::contact_map::ContactMapQuery, String> {
    Ok(cstudio_core::contact_map::ContactMapQuery {
        base_resolution,
        target_resolution,
        viewport: cstudio_core::contact_map::Viewport {
            x_start: viewport.x_start,
            x_end: viewport.x_end,
            y_start: viewport.y_start,
            y_end: viewport.y_end,
        },
        layout_blocks: layout_blocks
            .into_iter()
            .map(|block| {
                Ok(cstudio_core::contact_map::LayoutBlock {
                    id: block.id,
                    source_id: block.source_id,
                    source_start: block.source_start,
                    source_end: block.source_end,
                    visual_start: block.visual_start,
                    orientation: parse_orientation(&block.orientation)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
    })
}

fn contact_map_response_from_view(
    view: cstudio_core::contact_map::ContactMapView,
) -> Result<ContactMapViewResponse, String> {
    contact_map_response_from_view_cancellable(view, &|| false)
}

fn contact_map_response_from_view_cancellable(
    view: cstudio_core::contact_map::ContactMapView,
    should_cancel: &dyn Fn() -> bool,
) -> Result<ContactMapViewResponse, String> {
    ensure_contact_tile_request_active(should_cancel)?;
    let tile_size_bins = 256;
    let mut cells = Vec::with_capacity(view.cells.len());
    for (cell_index, cell) in view.cells.into_iter().enumerate() {
        if cell_index % 4_096 == 0 {
            ensure_contact_tile_request_active(should_cancel)?;
        }
        cells.push(ContactMapCellResponse {
            x_bin: cell.x_bin,
            y_bin: cell.y_bin,
            count: cell.count,
        });
    }
    let mut tiles_by_key =
        std::collections::BTreeMap::<(u64, u64), Vec<ContactMapCellResponse>>::new();

    for (cell_index, cell) in cells.iter().cloned().enumerate() {
        if cell_index % 4_096 == 0 {
            ensure_contact_tile_request_active(should_cancel)?;
        }
        tiles_by_key
            .entry((cell.x_bin / tile_size_bins, cell.y_bin / tile_size_bins))
            .or_default()
            .push(cell);
    }

    let mut tiles = Vec::with_capacity(tiles_by_key.len());
    for (tile_index, ((tile_x, tile_y), cells)) in tiles_by_key.into_iter().enumerate() {
        if tile_index % 128 == 0 {
            ensure_contact_tile_request_active(should_cancel)?;
        }
        tiles.push(ContactMapTileResponse {
            tile_x,
            tile_y,
            cells,
        });
    }

    Ok(ContactMapViewResponse {
        resolution: view.resolution,
        viewport: ContactMapViewportResponse {
            x_start: view.viewport.x_start,
            x_end: view.viewport.x_end,
            y_start: view.viewport.y_start,
            y_end: view.viewport.y_end,
        },
        cells,
        tile_size_bins,
        tiles,
    })
}

fn contact_map_tiles_from_view_cancellable(
    view: cstudio_core::contact_map::ContactMapView,
    tile_size_bins: u64,
    requested_tiles: &BTreeSet<(u64, u64)>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<ContactMapTileResponse>, String> {
    ensure_contact_tile_request_active(should_cancel)?;
    if tile_size_bins == 0 {
        return Err("contact tile size must be greater than zero".to_string());
    }

    // Seed every requested tile so empty tiles remain explicit cache entries.
    // BTreeMap also preserves the canonical, deterministic request order.
    let mut tiles_by_key = requested_tiles
        .iter()
        .copied()
        .map(|key| (key, Vec::new()))
        .collect::<BTreeMap<_, Vec<ContactMapCellResponse>>>();

    for (cell_index, cell) in view.cells.into_iter().enumerate() {
        if cell_index % 4_096 == 0 {
            ensure_contact_tile_request_active(should_cancel)?;
        }
        let key = (cell.x_bin / tile_size_bins, cell.y_bin / tile_size_bins);
        let Some(tile_cells) = tiles_by_key.get_mut(&key) else {
            continue;
        };
        tile_cells.push(ContactMapCellResponse {
            x_bin: cell.x_bin,
            y_bin: cell.y_bin,
            count: cell.count,
        });
    }

    ensure_contact_tile_request_active(should_cancel)?;
    let mut tiles = Vec::with_capacity(tiles_by_key.len());
    for (tile_index, ((tile_x, tile_y), cells)) in tiles_by_key.into_iter().enumerate() {
        if tile_index % 128 == 0 {
            ensure_contact_tile_request_active(should_cancel)?;
        }
        tiles.push(ContactMapTileResponse {
            tile_x,
            tile_y,
            cells,
        });
    }
    ensure_contact_tile_request_active(should_cancel)?;

    Ok(tiles)
}

fn parse_agp_layout_for_response(text: &str) -> Result<AgpLayoutResponse, String> {
    let mut object_offsets = std::collections::HashMap::<String, u64>::new();
    let mut object_order = Vec::<String>::new();
    let mut object_ends = std::collections::HashMap::<String, u64>::new();
    let mut pending_gaps = std::collections::HashMap::<String, AgpGapMetadataResponse>::new();
    let mut blocks = Vec::new();

    for (index, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let columns = line.split('\t').collect::<Vec<_>>();
        if columns.len() != 9 {
            return Err(format!(
                "line {} has {} columns; expected 9",
                index + 1,
                columns.len()
            ));
        }

        let object_id = columns[0].to_string();
        if !object_offsets.contains_key(&object_id) {
            let offset = object_order
                .iter()
                .map(|id| object_ends.get(id).copied().unwrap_or(0))
                .sum();
            object_offsets.insert(object_id.clone(), offset);
            object_order.push(object_id.clone());
        }

        let object_start = columns[1]
            .parse::<u64>()
            .map_err(|_| format!("line {} has invalid object start", index + 1))?
            .saturating_sub(1);
        let object_end = columns[2]
            .parse::<u64>()
            .map_err(|_| format!("line {} has invalid object end", index + 1))?;
        object_ends
            .entry(object_id.clone())
            .and_modify(|end| *end = (*end).max(object_end))
            .or_insert(object_end);

        if matches!(columns[4], "N" | "U") {
            let length = columns[5]
                .parse::<u64>()
                .map_err(|_| format!("line {} has invalid gap length", index + 1))?;
            pending_gaps.insert(
                object_id,
                AgpGapMetadataResponse {
                    component_type: columns[4].to_string(),
                    length,
                    gap_type: columns[6].to_string(),
                    linkage: columns[7].to_string(),
                    linkage_evidence: columns[8].to_string(),
                },
            );
            continue;
        }

        let component_start = columns[6]
            .parse::<u64>()
            .map_err(|_| format!("line {} has invalid component start", index + 1))?
            .saturating_sub(1);
        let component_end = columns[7]
            .parse::<u64>()
            .map_err(|_| format!("line {} has invalid component end", index + 1))?;

        blocks.push(ContactMapLayoutBlockResponse {
            id: format!("{}:{}:{}", object_id, columns[3], columns[5]),
            object_id: object_id.clone(),
            source_id: columns[5].to_string(),
            source_start: component_start,
            source_end: component_end,
            visual_start: object_offsets.get(&object_id).copied().unwrap_or(0) + object_start,
            orientation: normalize_agp_orientation(columns[8]).to_string(),
            component_type: columns[4].to_string(),
            gap_before: pending_gaps.remove(&object_id),
        });
    }

    Ok(AgpLayoutResponse {
        blocks,
        total_span: object_order
            .iter()
            .map(|id| object_ends.get(id).copied().unwrap_or(0))
            .sum(),
    })
}

fn normalize_agp_orientation(value: &str) -> &str {
    match value {
        "-" => "-",
        "?" => "?",
        "0" => "0",
        "na" => "na",
        _ => "+",
    }
}

fn contact_file_from_path(path: &Path) -> Result<ImportedContactFile, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "cool" && extension != "mcool" {
        return Err("selected file must end with .cool or .mcool".to_string());
    }

    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(ImportedContactFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("contact.cool")
            .to_string(),
        size_bytes: metadata.len(),
    })
}

fn coverage_file_from_path(path: &Path) -> Result<ImportedContactFile, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "bedgraph" | "bg" | "txt") {
        return Err("selected file must end with .bedgraph, .bg, or .txt".to_string());
    }

    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(ImportedContactFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("coverage.bedgraph")
            .to_string(),
        size_bytes: metadata.len(),
    })
}

fn paf_file_from_path(path: &Path) -> Result<ImportedContactFile, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "paf" | "txt") {
        return Err("selected file must end with .paf or .txt".to_string());
    }

    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(ImportedContactFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("alignment.paf")
            .to_string(),
        size_bytes: metadata.len(),
    })
}

#[cfg(target_os = "macos")]
fn choose_contact_file_path() -> Result<Option<PathBuf>, String> {
    use std::process::Command;

    let script = r#"set selectedFile to choose file with prompt "Select a .cool or .mcool contact map" of type {"cool", "mcool", "public.data"}
POSIX path of selectedFile"#;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Ok(None);
        }
        return Err(stderr.trim().to_string());
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }

    Ok(Some(PathBuf::from(path)))
}

#[cfg(not(target_os = "macos"))]
fn choose_contact_file_path() -> Result<Option<PathBuf>, String> {
    Err("native contact file picker is only implemented for macOS".to_string())
}

#[cfg(target_os = "macos")]
fn choose_coverage_file_path() -> Result<Option<PathBuf>, String> {
    use std::process::Command;

    let script = r#"set selectedFile to choose file with prompt "Select a bedGraph coverage file"
POSIX path of selectedFile"#;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Ok(None);
        }
        return Err(stderr.trim().to_string());
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(path)))
}

#[cfg(not(target_os = "macos"))]
fn choose_coverage_file_path() -> Result<Option<PathBuf>, String> {
    Err("native coverage file picker is only implemented for macOS".to_string())
}

#[cfg(target_os = "macos")]
fn choose_paf_file_path() -> Result<Option<PathBuf>, String> {
    use std::process::Command;

    let script = r#"set selectedFile to choose file with prompt "Select a PAF alignment file"
POSIX path of selectedFile"#;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Ok(None);
        }
        return Err(stderr.trim().to_string());
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!path.is_empty()).then(|| PathBuf::from(path)))
}

#[cfg(not(target_os = "macos"))]
fn choose_paf_file_path() -> Result<Option<PathBuf>, String> {
    Err("native PAF file picker is only implemented for macOS".to_string())
}

#[cfg(target_os = "macos")]
fn choose_agp_save_path(default_filename: &str) -> Result<Option<PathBuf>, String> {
    use std::process::Command;

    let safe_filename = default_filename.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"set saveFile to choose file name with prompt "Save edited AGP" default name "{safe_filename}"
POSIX path of saveFile"#
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Ok(None);
        }
        return Err(stderr.trim().to_string());
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }

    Ok(Some(PathBuf::from(path)))
}

#[cfg(not(target_os = "macos"))]
fn choose_agp_save_path(_default_filename: &str) -> Result<Option<PathBuf>, String> {
    Err("native AGP save dialog is only implemented for macOS".to_string())
}

#[tauri::command]
pub fn build_synteny_view(request: SyntenyViewRequest) -> Result<SyntenyViewResponse, String> {
    let query = synteny_query_from_parts(
        request.viewport,
        request.layout_blocks,
        request.min_mapq,
        request.min_alignment_len,
        request.max_query_gap,
        request.max_target_gap,
    )?;
    let records = request
        .paf_records
        .into_iter()
        .map(paf_record_from_request)
        .collect::<Result<Vec<_>, String>>()?;

    synteny_response_from_view(
        cstudio_core::synteny::build_synteny_view(&query, records)
            .map_err(|error| error.to_string())?,
    )
}

#[tauri::command]
pub async fn build_synteny_view_from_paf(
    request: SyntenyViewFromPafRequest,
    cache_state: tauri::State<'_, SyntenyCacheState>,
) -> Result<SyntenyViewResponse, String> {
    let cache = Arc::clone(&cache_state.inner().cache);
    tauri::async_runtime::spawn_blocking(move || {
        build_synteny_view_from_paf_with_cache(request, cache.as_ref())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn build_synteny_view_from_paf_with_cache(
    request: SyntenyViewFromPafRequest,
    cache: &Mutex<SyntenyCache>,
) -> Result<SyntenyViewResponse, String> {
    let query = synteny_query_from_parts(
        request.viewport,
        request.layout_blocks,
        request.min_mapq,
        request.min_alignment_len,
        request.max_query_gap,
        request.max_target_gap,
    )?;
    let metadata = fs::metadata(&request.paf_path).map_err(|error| error.to_string())?;
    let key = SyntenyCacheKey {
        path: request.paf_path.clone(),
        size_bytes: metadata.len(),
        modified_nanos: metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0),
    };

    if let Some(view) = cache
        .lock()
        .map_err(|_| "synteny cache lock poisoned".to_string())?
        .build_cached_view(&key, &query)
        .map_err(|error| error.to_string())?
    {
        return synteny_response_from_view(view);
    }

    let file = fs::File::open(&request.paf_path).map_err(|error| error.to_string())?;
    let mut records = Vec::new();

    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if let Some(record) = cstudio_core::synteny::PafRecord::parse_line(&line)
            .map_err(|error| error.to_string())?
        {
            records.push(record);
        }
    }

    let mut cache = cache
        .lock()
        .map_err(|_| "synteny cache lock poisoned".to_string())?;
    if !cache.contains_key(&key) {
        cache.insert_records(key.clone(), records);
    }
    let view = cache
        .build_cached_view(&key, &query)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "synteny cache entry missing after import".to_string())?;
    synteny_response_from_view(view)
}

fn coverage_query_from_parts(
    display_resolution: u64,
    viewport: ContactMapViewportRequest,
    layout_blocks: Vec<ContactMapLayoutBlockRequest>,
) -> Result<cstudio_core::coverage::CoverageQuery, String> {
    Ok(cstudio_core::coverage::CoverageQuery {
        display_resolution,
        viewport: cstudio_core::contact_map::Viewport {
            x_start: viewport.x_start,
            x_end: viewport.x_end,
            y_start: viewport.y_start,
            y_end: viewport.y_end,
        },
        layout_blocks: layout_blocks
            .into_iter()
            .map(|block| {
                Ok(cstudio_core::contact_map::LayoutBlock {
                    id: block.id,
                    source_id: block.source_id,
                    source_start: block.source_start,
                    source_end: block.source_end,
                    visual_start: block.visual_start,
                    orientation: parse_orientation(&block.orientation)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
    })
}

fn coverage_response_from_view(
    view: cstudio_core::coverage::CoverageView,
) -> Result<CoverageViewResponse, String> {
    Ok(CoverageViewResponse {
        resolution: view.resolution,
        viewport: ContactMapViewportResponse {
            x_start: view.viewport.x_start,
            x_end: view.viewport.x_end,
            y_start: view.viewport.y_start,
            y_end: view.viewport.y_end,
        },
        bins: view
            .bins
            .into_iter()
            .map(|bin| CoverageBinResponse {
                x_bin: bin.x_bin,
                value: bin.value,
            })
            .collect(),
    })
}

fn synteny_query_from_parts(
    viewport: ContactMapViewportRequest,
    layout_blocks: Vec<ContactMapLayoutBlockRequest>,
    min_mapq: u8,
    min_alignment_len: u64,
    max_query_gap: u64,
    max_target_gap: u64,
) -> Result<cstudio_core::synteny::SyntenyQuery, String> {
    Ok(cstudio_core::synteny::SyntenyQuery {
        viewport: cstudio_core::contact_map::Viewport {
            x_start: viewport.x_start,
            x_end: viewport.x_end,
            y_start: viewport.y_start,
            y_end: viewport.y_end,
        },
        layout_blocks: layout_blocks
            .into_iter()
            .map(|block| {
                Ok(cstudio_core::contact_map::LayoutBlock {
                    id: block.id,
                    source_id: block.source_id,
                    source_start: block.source_start,
                    source_end: block.source_end,
                    visual_start: block.visual_start,
                    orientation: parse_orientation(&block.orientation)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
        min_mapq,
        min_alignment_len,
        max_query_gap,
        max_target_gap,
    })
}

fn paf_record_from_request(
    request: PafRecordRequest,
) -> Result<cstudio_core::synteny::PafRecord, String> {
    let strand = request
        .strand
        .chars()
        .next()
        .ok_or_else(|| "invalid strand: empty".to_string())?;
    if strand != '+' && strand != '-' {
        return Err(format!("invalid strand: {}", request.strand));
    }

    Ok(cstudio_core::synteny::PafRecord {
        query_name: request.query_name,
        query_len: request.query_len,
        query_start: request.query_start,
        query_end: request.query_end,
        strand,
        target_name: request.target_name,
        target_len: request.target_len,
        target_start: request.target_start,
        target_end: request.target_end,
        residue_matches: request.residue_matches,
        alignment_block_len: request.alignment_block_len,
        mapq: request.mapq,
    })
}

fn synteny_response_from_view(
    view: cstudio_core::synteny::SyntenyView,
) -> Result<SyntenyViewResponse, String> {
    Ok(SyntenyViewResponse {
        viewport: ContactMapViewportResponse {
            x_start: view.viewport.x_start,
            x_end: view.viewport.x_end,
            y_start: view.viewport.y_start,
            y_end: view.viewport.y_end,
        },
        blocks: view
            .blocks
            .into_iter()
            .map(|block| SyntenyBlockResponse {
                assembly_block_id: block.assembly_block_id,
                query_source_id: block.query_source_id,
                visual_start: block.visual_start,
                visual_end: block.visual_end,
                target_id: block.target_id,
                target_length: block.target_length,
                target_start: block.target_start,
                target_end: block.target_end,
                strand: block.strand.to_string(),
                mapq: block.mapq,
                alignment_count: block.alignment_count,
            })
            .collect(),
    })
}

fn parse_orientation(value: &str) -> Result<cstudio_core::agp::Orientation, String> {
    match value {
        "+" | "forward" | "Forward" => Ok(cstudio_core::agp::Orientation::Forward),
        "-" | "reverse" | "Reverse" => Ok(cstudio_core::agp::Orientation::Reverse),
        "?" | "0" | "na" | "unknown" | "Unknown" => Ok(cstudio_core::agp::Orientation::Unknown),
        _ => Err(format!("invalid orientation: {value}")),
    }
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent project directory")
        .to_path_buf()
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet, HashMap};
    use std::sync::Mutex;

    use cstudio_core::{
        contact_cache::ContactCache,
        contact_map::{ContactMapCell, ContactMapView, Viewport},
        coverage_cache::CoverageCache,
        source_contact_cache::SourceContactCache,
    };

    use super::{
        build_contact_map_view, build_coverage_view, build_coverage_view_from_bedgraph_with_cache,
        build_synteny_view, get_app_status, BedGraphRecordRequest, ContactMapBinRequest,
        ContactMapLayoutBlockRequest, ContactMapTileKeyRequest, ContactMapTilesFromCoolRequest,
        ContactMapViewFromCoolRequest, ContactMapViewRequest, ContactMapViewportRequest,
        ContactNormalizationRequest, CoverageViewFromBedGraphRequest, CoverageViewRequest,
        PafRecordRequest, SyntenyViewRequest,
    };

    #[test]
    fn returns_core_engine_status() {
        let status = get_app_status();

        assert_eq!(status.engine, "cstudio-core");
        assert_eq!(
            status.coordinate_convention,
            "0-based half-open internal; 1-based closed AGP"
        );
        assert_eq!(
            status.supported_operations,
            vec!["split", "move", "flip", "copy"]
        );
    }

    #[test]
    fn contact_normalization_request_uses_stable_wire_values() {
        for (wire_value, expected) in [
            ("raw", ContactNormalizationRequest::Raw),
            ("ice", ContactNormalizationRequest::Ice),
            ("kr", ContactNormalizationRequest::Kr),
            ("vc", ContactNormalizationRequest::Vc),
            ("vc_sqrt", ContactNormalizationRequest::VcSqrt),
        ] {
            let parsed: ContactNormalizationRequest =
                serde_json::from_str(format!("\"{wire_value}\"").as_str())
                    .expect("known normalization wire value");
            assert_eq!(parsed, expected);
        }
        assert!(serde_json::from_str::<ContactNormalizationRequest>("\"unknown\"").is_err());
    }

    #[test]
    fn omitted_contact_normalization_defaults_to_raw() {
        let request: ContactMapTilesFromCoolRequest = serde_json::from_value(serde_json::json!({
            "requestId": 1,
            "generation": 1,
            "coolPath": "/tmp/input.cool",
            "baseResolution": 1_000,
            "targetResolution": 10_000,
            "tileSizeBins": 256,
            "tiles": [],
            "layoutBlocks": [],
        }))
        .expect("legacy request without normalization");

        assert_eq!(request.normalization, ContactNormalizationRequest::Raw);
    }

    #[test]
    fn contact_tile_cache_identity_includes_normalization() {
        let raw = super::ContactTileCacheKey {
            path: "/tmp/input.cool".to_string(),
            resolution: 10_000,
            tile_size_bins: 256,
            normalization: ContactNormalizationRequest::Raw,
            projection_fingerprint: "same-layout".to_string(),
            tile_x: 1,
            tile_y: 2,
        };
        let kr = super::ContactTileCacheKey {
            normalization: ContactNormalizationRequest::Kr,
            ..raw.clone()
        };

        assert_ne!(raw, kr);
    }

    #[test]
    fn contact_tile_generations_atomically_retain_current_work_and_cancel_stale_work() {
        let state = super::ContactTileRequestState::default();
        state.register(11, 1).expect("first request registers");
        state.register(12, 1).expect("second request registers");

        let retained = state
            .retain_and_begin_generation(2, &[11, 11, 99])
            .expect("generation advances");

        assert_eq!(retained, vec![11]);
        assert!(!state.is_cancelled(11));
        assert!(state.is_cancelled(12));

        state.finish(11);
        assert!(state.is_cancelled(11));
        assert_eq!(
            state
                .retain_and_begin_generation(1, &[12])
                .expect("stale begin is harmless"),
            Vec::<u64>::new()
        );
        assert!(state.register(13, 1).is_err());

        state
            .register(14, 3)
            .expect("newer direct request registers");
        assert!(!state.is_cancelled(14));
        state
            .retain_and_begin_generation(2, &[12])
            .expect("older generation cannot move the clock backwards");
        assert!(state.is_cancelled(12));
        assert!(!state.is_cancelled(14));

        state.register(15, 3).expect("guarded request registers");
        {
            let _guard = super::ContactTileRequestGuard {
                state: state.clone(),
                request_id: 15,
            };
            assert!(!state.is_cancelled(15));
        }
        assert!(state.is_cancelled(15));
    }

    #[test]
    fn cancelled_contact_tile_request_stops_before_io_or_cache_mutation() {
        let source_cache = Mutex::new(SourceContactCache::new(1024));
        let tile_cache = Mutex::new(HashMap::new());
        let result = super::get_contact_map_tiles_from_cool_with_cache_cancellable(
            ContactMapTilesFromCoolRequest {
                request_id: 1,
                generation: 1,
                cool_path: "/path/that/does/not/exist.cool".to_string(),
                base_resolution: 1_000,
                target_resolution: 1_000,
                tile_size_bins: 256,
                normalization: ContactNormalizationRequest::Raw,
                tiles: vec![ContactMapTileKeyRequest {
                    tile_x: 0,
                    tile_y: 0,
                }],
                layout_blocks: Vec::new(),
            },
            &source_cache,
            &tile_cache,
            &|| true,
        );

        assert_eq!(result.unwrap_err(), "contact tile request cancelled");
        assert!(tile_cache.lock().expect("tile cache lock").is_empty());
        assert_eq!(
            source_cache
                .lock()
                .expect("source cache lock")
                .entry_count(),
            0
        );
    }

    #[test]
    fn contact_tile_work_regions_cover_sparse_misses_without_holes() {
        let missing_tiles = vec![
            ContactMapTileKeyRequest {
                tile_x: 0,
                tile_y: 2,
            },
            ContactMapTileKeyRequest {
                tile_x: 1,
                tile_y: 2,
            },
            ContactMapTileKeyRequest {
                tile_x: 3,
                tile_y: 2,
            },
            ContactMapTileKeyRequest {
                tile_x: 0,
                tile_y: 3,
            },
            ContactMapTileKeyRequest {
                tile_x: 1,
                tile_y: 3,
            },
            ContactMapTileKeyRequest {
                tile_x: 3,
                tile_y: 4,
            },
        ];

        let regions = super::contact_tile_work_regions(&missing_tiles);
        let mut flattened = regions
            .iter()
            .flatten()
            .map(|tile| (tile.tile_x, tile.tile_y))
            .collect::<Vec<_>>();
        flattened.sort_unstable();
        let mut expected = missing_tiles
            .iter()
            .map(|tile| (tile.tile_x, tile.tile_y))
            .collect::<Vec<_>>();
        expected.sort_unstable();

        assert_eq!(regions.len(), 3);
        assert_eq!(flattened, expected);
        for region in regions {
            let min_x = region.iter().map(|tile| tile.tile_x).min().unwrap();
            let max_x = region.iter().map(|tile| tile.tile_x).max().unwrap();
            let min_y = region.iter().map(|tile| tile.tile_y).min().unwrap();
            let max_y = region.iter().map(|tile| tile.tile_y).max().unwrap();
            assert_eq!(
                region.len() as u64,
                (max_x - min_x + 1) * (max_y - min_y + 1)
            );
        }
    }

    #[test]
    fn contact_tile_converter_keeps_only_requested_tiles() {
        let view = ContactMapView {
            resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 20_000,
                y_start: 0,
                y_end: 20_000,
            },
            cells: vec![
                ContactMapCell {
                    x_bin: 1,
                    y_bin: 2,
                    count: 3.0,
                },
                ContactMapCell {
                    x_bin: 3,
                    y_bin: 14,
                    count: 5.0,
                },
                ContactMapCell {
                    x_bin: 13,
                    y_bin: 14,
                    count: 7.0,
                },
            ],
        };
        let requested = BTreeSet::from([(0, 1)]);

        let tiles = super::contact_map_tiles_from_view_cancellable(view, 10, &requested, &|| false)
            .expect("requested tile conversion");

        assert_eq!(
            tiles,
            vec![super::ContactMapTileResponse {
                tile_x: 0,
                tile_y: 1,
                cells: vec![super::ContactMapCellResponse {
                    x_bin: 3,
                    y_bin: 14,
                    count: 5.0,
                }],
            }]
        );
    }

    #[test]
    fn contact_tile_converter_returns_requested_empty_tiles_in_order() {
        let view = ContactMapView {
            resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 40_000,
                y_start: 0,
                y_end: 40_000,
            },
            cells: vec![ContactMapCell {
                x_bin: 11,
                y_bin: 22,
                count: 9.0,
            }],
        };
        let requested = BTreeSet::from([(2, 3), (0, 1), (1, 2)]);

        let tiles = super::contact_map_tiles_from_view_cancellable(view, 10, &requested, &|| false)
            .expect("requested empty tiles remain explicit");

        assert_eq!(
            tiles
                .iter()
                .map(|tile| (tile.tile_x, tile.tile_y))
                .collect::<Vec<_>>(),
            vec![(0, 1), (1, 2), (2, 3)]
        );
        assert!(tiles[0].cells.is_empty());
        assert_eq!(tiles[1].cells.len(), 1);
        assert!(tiles[2].cells.is_empty());
    }

    #[test]
    fn contact_tile_converter_matches_general_converter_for_requested_tiles() {
        let view = ContactMapView {
            resolution: 1_000,
            viewport: Viewport {
                x_start: 0,
                x_end: 800_000,
                y_start: 0,
                y_end: 800_000,
            },
            cells: vec![
                ContactMapCell {
                    x_bin: 0,
                    y_bin: 1,
                    count: 2.0,
                },
                ContactMapCell {
                    x_bin: 2,
                    y_bin: 257,
                    count: 3.0,
                },
                ContactMapCell {
                    x_bin: 258,
                    y_bin: 300,
                    count: 5.0,
                },
                ContactMapCell {
                    x_bin: 300,
                    y_bin: 600,
                    count: 7.0,
                },
            ],
        };
        let requested = BTreeSet::from([(0, 1), (1, 1), (2, 2)]);

        let mut general_cells = super::contact_map_response_from_view(view.clone())
            .expect("general conversion")
            .tiles
            .into_iter()
            .filter(|tile| requested.contains(&(tile.tile_x, tile.tile_y)))
            .map(|tile| ((tile.tile_x, tile.tile_y), tile.cells))
            .collect::<BTreeMap<_, _>>();
        let expected = requested
            .iter()
            .map(|&(tile_x, tile_y)| super::ContactMapTileResponse {
                tile_x,
                tile_y,
                cells: general_cells.remove(&(tile_x, tile_y)).unwrap_or_default(),
            })
            .collect::<Vec<_>>();

        let actual =
            super::contact_map_tiles_from_view_cancellable(view, 256, &requested, &|| false)
                .expect("tile-only conversion");

        assert_eq!(actual, expected);
    }

    #[test]
    fn contact_tile_converter_honors_cancellation() {
        let error = super::contact_map_tiles_from_view_cancellable(
            ContactMapView {
                resolution: 1_000,
                viewport: Viewport {
                    x_start: 0,
                    x_end: 1_000,
                    y_start: 0,
                    y_end: 1_000,
                },
                cells: Vec::new(),
            },
            256,
            &BTreeSet::from([(0, 0)]),
            &|| true,
        )
        .expect_err("cancelled tile conversion must stop");

        assert_eq!(error, "contact tile request cancelled");
    }

    #[test]
    fn preserves_agp_component_and_gap_metadata_for_layout_response() {
        let agp = [
            "Chr01\t1\t10\t1\tF\tctgA\t11\t20\t+",
            "Chr01\t11\t110\t2\tU\t100\tscaffold\tyes\tmap",
            "Chr01\t111\t120\t3\tW\tctgB\t1\t10\t-",
            "Chr02\t1\t8\t1\tO\tctgC\t3\t10\t?",
            "Chr02\t9\t13\t2\tN\t5\tcontig\tno\tna",
            "Chr02\t14\t21\t3\tP\tctgD\t1\t8\t+",
        ]
        .join("\n");

        let layout = super::parse_agp_layout_for_response(&agp).expect("valid AGP layout");

        assert_eq!(layout.total_span, 141);
        assert_eq!(layout.blocks.len(), 4);

        let first = &layout.blocks[0];
        assert_eq!(first.object_id, "Chr01");
        assert_eq!(first.component_type, "F");
        assert_eq!((first.source_start, first.source_end), (10, 20));
        assert_eq!(first.visual_start, 0);
        assert_eq!(first.gap_before, None);

        let after_unknown_gap = &layout.blocks[1];
        assert_eq!(after_unknown_gap.object_id, "Chr01");
        assert_eq!(after_unknown_gap.component_type, "W");
        assert_eq!(after_unknown_gap.visual_start, 110);
        assert_eq!(
            after_unknown_gap.gap_before,
            Some(super::AgpGapMetadataResponse {
                component_type: "U".to_string(),
                length: 100,
                gap_type: "scaffold".to_string(),
                linkage: "yes".to_string(),
                linkage_evidence: "map".to_string(),
            })
        );

        let after_known_gap = &layout.blocks[3];
        assert_eq!(after_known_gap.object_id, "Chr02");
        assert_eq!(after_known_gap.component_type, "P");
        assert_eq!(after_known_gap.visual_start, 133);
        assert_eq!(
            after_known_gap.gap_before,
            Some(super::AgpGapMetadataResponse {
                component_type: "N".to_string(),
                length: 5,
                gap_type: "contig".to_string(),
                linkage: "no".to_string(),
                linkage_evidence: "na".to_string(),
            })
        );

        let serialized = serde_json::to_value(after_unknown_gap).expect("serialize AGP block");
        assert_eq!(serialized["objectId"], "Chr01");
        assert_eq!(serialized["componentType"], "W");
        assert_eq!(serialized["gapBefore"]["componentType"], "U");
        assert_eq!(serialized["gapBefore"]["length"], 100);
        assert_eq!(serialized["gapBefore"]["gapType"], "scaffold");
        assert_eq!(serialized["gapBefore"]["linkage"], "yes");
        assert_eq!(serialized["gapBefore"]["linkageEvidence"], "map");
        let first_serialized = serde_json::to_value(first).expect("serialize first AGP block");
        assert!(first_serialized.get("gapBefore").is_none());
    }

    #[test]
    fn preserves_and_accepts_agp_zero_and_na_orientations() {
        let agp = [
            "ChrO\t1\t10\t1\tW\tctgZero\t11\t20\t0",
            "ChrO\t11\t20\t2\tF\tctgNa\t31\t40\tna",
        ]
        .join("\n");

        let layout = super::parse_agp_layout_for_response(&agp).expect("valid AGP layout");

        assert_eq!(layout.blocks[0].orientation, "0");
        assert_eq!(layout.blocks[1].orientation, "na");
        assert_eq!(
            serde_json::to_value(&layout.blocks).expect("serialize AGP blocks")[0]["orientation"],
            "0"
        );
        assert_eq!(
            serde_json::to_value(&layout.blocks).expect("serialize AGP blocks")[1]["orientation"],
            "na"
        );
        assert_eq!(
            super::parse_orientation("0").expect("zero means unknown orientation"),
            cstudio_core::agp::Orientation::Unknown
        );
        assert_eq!(
            super::parse_orientation("na").expect("na means irrelevant orientation"),
            cstudio_core::agp::Orientation::Unknown
        );
    }

    #[test]
    fn loads_example_dataset_summary() {
        let summary = super::load_example_dataset().expect("example dataset should load");

        assert_eq!(summary.agp_lines, 2_576);
        assert_eq!(summary.agp_objects, 20);
        assert_eq!(summary.agp_components, 1_298);
        assert_eq!(summary.agp_gaps, 1_278);
        assert_eq!(summary.max_object_span, 30_436_571);
        assert!(summary.mcool_size_bytes > 1_000_000);
        let coverage_path = summary
            .coverage_path
            .as_deref()
            .expect("example coverage path");
        let paf_path = summary.paf_path.as_deref().expect("example PAF path");
        assert!(coverage_path.ends_with("examples/input.1000.coverage.bedgraph"));
        assert!(paf_path.ends_with("examples/ref_vs_contig.paf"));
        assert!(std::path::Path::new(coverage_path).is_absolute());
        assert!(std::path::Path::new(paf_path).is_absolute());
        assert!(std::path::Path::new(coverage_path).is_file());
        assert!(std::path::Path::new(paf_path).is_file());
        assert!(
            summary.cool_path.ends_with("examples/input.q1.mcool")
                || summary.cool_path.ends_with("examples/input.q1.1k.cool")
        );
        assert_eq!(summary.agp_layout.blocks.len(), 1_298);
        assert!(summary.agp_layout.total_span > summary.max_object_span);
        assert_eq!(summary.agp_layout.blocks[0].object_id, "Chr01g1");
        assert_eq!(summary.agp_layout.blocks[0].component_type, "W");
        assert_eq!(summary.agp_layout.blocks[0].gap_before, None);
        assert_eq!(
            summary.agp_layout.blocks[1].gap_before,
            Some(super::AgpGapMetadataResponse {
                component_type: "U".to_string(),
                length: 100,
                gap_type: "contig".to_string(),
                linkage: "yes".to_string(),
                linkage_evidence: "map".to_string(),
            })
        );
    }

    #[test]
    fn builds_example_contact_map_view_from_cool_and_agp_layout() {
        let summary = super::load_example_dataset().expect("example dataset should load");
        let cache = Mutex::new(ContactCache::new());
        let response = super::build_contact_map_view_from_cool_with_cache(
            ContactMapViewFromCoolRequest {
                cool_path: summary.cool_path,
                base_resolution: 1_000,
                target_resolution: 10_000,
                normalization: ContactNormalizationRequest::Raw,
                viewport: ContactMapViewportRequest {
                    x_start: 0,
                    x_end: summary.agp_layout.total_span,
                    y_start: 0,
                    y_end: summary.agp_layout.total_span,
                },
                layout_blocks: summary
                    .agp_layout
                    .blocks
                    .into_iter()
                    .map(|block| ContactMapLayoutBlockRequest {
                        id: block.id,
                        source_id: block.source_id,
                        source_start: block.source_start,
                        source_end: block.source_end,
                        visual_start: block.visual_start,
                        orientation: block.orientation,
                    })
                    .collect(),
            },
            &cache,
        )
        .expect("example cool and AGP layout should render");

        assert_eq!(response.resolution, 10_000);
        assert!(!response.cells.is_empty());
        assert!(!response.tiles.is_empty());
        assert_eq!(
            response
                .tiles
                .iter()
                .map(|tile| tile.cells.len())
                .sum::<usize>(),
            response.cells.len()
        );
    }

    fn local_invalidation_layout(
        order: &[&str],
        reverse_source: Option<&str>,
    ) -> Vec<ContactMapLayoutBlockRequest> {
        order
            .iter()
            .enumerate()
            .map(|(index, source_id)| ContactMapLayoutBlockRequest {
                id: format!("block-{source_id}"),
                source_id: (*source_id).to_string(),
                source_start: 0,
                source_end: 100,
                visual_start: index as u64 * 100,
                orientation: if reverse_source == Some(*source_id) {
                    "-".to_string()
                } else {
                    "+".to_string()
                },
            })
            .collect()
    }

    #[test]
    fn tile_projection_fingerprint_matches_frontend_and_precise_edit_ranges() {
        let sources = ["A", "B", "C", "D", "E", "F"];
        let before = local_invalidation_layout(&sources, None);
        let flipped = local_invalidation_layout(&sources, Some("B"));
        let inserted = local_invalidation_layout(&["A", "C", "D", "B", "E", "F"], None);
        let tile_span = 100;
        let mut flipped_changed = Vec::new();
        let mut inserted_reused = Vec::new();
        for tile_y in 0..6 {
            for tile_x in 0..=tile_y {
                let old_fingerprint =
                    super::contact_tile_projection_fingerprint(tile_x, tile_y, tile_span, &before);
                if old_fingerprint
                    != super::contact_tile_projection_fingerprint(
                        tile_x, tile_y, tile_span, &flipped,
                    )
                {
                    flipped_changed.push(format!("{tile_x}:{tile_y}"));
                }
                if old_fingerprint
                    == super::contact_tile_projection_fingerprint(
                        tile_x, tile_y, tile_span, &inserted,
                    )
                {
                    inserted_reused.push(format!("{tile_x}:{tile_y}"));
                }
            }
        }

        assert_eq!(flipped_changed, ["0:1", "1:1", "1:2", "1:3", "1:4", "1:5"]);
        assert_eq!(inserted_reused, ["0:0", "0:4", "4:4", "0:5", "4:5", "5:5"]);

        let mut copied = before.clone();
        copied.push(ContactMapLayoutBlockRequest {
            id: "block-A-copy".to_string(),
            source_id: "A".to_string(),
            source_start: 0,
            source_end: 100,
            visual_start: 600,
            orientation: "+".to_string(),
        });
        assert_ne!(
            super::contact_tile_projection_fingerprint(0, 1, tile_span, &before),
            super::contact_tile_projection_fingerprint(0, 1, tile_span, &copied),
        );
        assert_eq!(
            super::contact_tile_projection_fingerprint(1, 1, tile_span, &before),
            super::contact_tile_projection_fingerprint(1, 1, tile_span, &copied),
        );

        let mut renamed = before.clone();
        for (index, block) in renamed.iter_mut().enumerate() {
            block.id = format!("renamed-{index}");
        }
        for tile_y in 0..6 {
            for tile_x in 0..=tile_y {
                assert_eq!(
                    super::contact_tile_projection_fingerprint(tile_x, tile_y, tile_span, &before,),
                    super::contact_tile_projection_fingerprint(tile_x, tile_y, tile_span, &renamed,)
                );
            }
        }

        let unicode_layout = vec![ContactMapLayoutBlockRequest {
            id: "ignored-id".to_string(),
            source_id: "片段|β".to_string(),
            source_start: 7,
            source_end: 107,
            visual_start: 0,
            orientation: "?".to_string(),
        }];
        assert_eq!(
            super::contact_tile_projection_fingerprint(0, 0, tile_span, &unicode_layout),
            "ac570d514b060508:ac570d514b060508"
        );
        assert_eq!(
            super::contact_tile_projection_fingerprint(5, 2, tile_span, &before),
            super::contact_tile_projection_fingerprint(2, 5, tile_span, &before)
        );
    }

    #[test]
    fn backend_reuses_unaffected_tiles_and_rejects_stale_affected_tiles() {
        let cool_path = "/path/that/does/not/exist.cool".to_string();
        let target_resolution = 10;
        let tile_size_bins = 10;
        let tile_span = target_resolution * tile_size_bins;
        let before = local_invalidation_layout(&["A", "B", "C", "D", "E", "F"], None);
        let inserted = local_invalidation_layout(&["A", "C", "D", "B", "E", "F"], None);
        let source_cache = Mutex::new(SourceContactCache::new(1024));

        let unaffected_tile = ContactMapTileKeyRequest {
            tile_x: 0,
            tile_y: 4,
        };
        let unaffected_response = super::ContactMapTileResponse {
            tile_x: unaffected_tile.tile_x,
            tile_y: unaffected_tile.tile_y,
            cells: vec![super::ContactMapCellResponse {
                x_bin: 1,
                y_bin: 41,
                count: 7.0,
            }],
        };
        let unaffected_cache = Mutex::new(HashMap::from([(
            super::ContactTileCacheKey {
                path: cool_path.clone(),
                resolution: target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                projection_fingerprint: super::contact_tile_projection_fingerprint(
                    unaffected_tile.tile_x,
                    unaffected_tile.tile_y,
                    tile_span,
                    &before,
                ),
                tile_x: unaffected_tile.tile_x,
                tile_y: unaffected_tile.tile_y,
            },
            unaffected_response.clone(),
        )]));
        let reused = super::get_contact_map_tiles_from_cool_with_cache(
            ContactMapTilesFromCoolRequest {
                request_id: 10,
                generation: 1,
                cool_path: cool_path.clone(),
                base_resolution: target_resolution,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                tiles: vec![unaffected_tile],
                layout_blocks: inserted.clone(),
            },
            &source_cache,
            &unaffected_cache,
        )
        .expect("an unaffected tile must hit cache without opening the COOL file");
        assert_eq!(reused, vec![unaffected_response]);

        let affected_tile = ContactMapTileKeyRequest {
            tile_x: 1,
            tile_y: 4,
        };
        let old_affected_fingerprint = super::contact_tile_projection_fingerprint(
            affected_tile.tile_x,
            affected_tile.tile_y,
            tile_span,
            &before,
        );
        let new_affected_fingerprint = super::contact_tile_projection_fingerprint(
            affected_tile.tile_x,
            affected_tile.tile_y,
            tile_span,
            &inserted,
        );
        assert_ne!(old_affected_fingerprint, new_affected_fingerprint);
        let affected_cache = Mutex::new(HashMap::from([(
            super::ContactTileCacheKey {
                path: cool_path.clone(),
                resolution: target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                projection_fingerprint: old_affected_fingerprint,
                tile_x: affected_tile.tile_x,
                tile_y: affected_tile.tile_y,
            },
            super::ContactMapTileResponse {
                tile_x: affected_tile.tile_x,
                tile_y: affected_tile.tile_y,
                cells: Vec::new(),
            },
        )]));
        let error = super::get_contact_map_tiles_from_cool_with_cache(
            ContactMapTilesFromCoolRequest {
                request_id: 11,
                generation: 1,
                cool_path,
                base_resolution: target_resolution,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                tiles: vec![affected_tile],
                layout_blocks: inserted,
            },
            &source_cache,
            &affected_cache,
        )
        .expect_err("an affected tile must miss instead of using the stale layout entry");
        assert!(!error.is_empty());
    }

    #[test]
    fn mixed_tile_cache_hit_reads_only_the_missing_tile_extent() {
        let cool_path = "/path/that/does/not/exist.cool".to_string();
        let target_resolution = 1_000;
        let tile_size_bins = 256;
        let layout_blocks = vec![ContactMapLayoutBlockRequest {
            id: "cached-region".to_string(),
            source_id: "contig-a".to_string(),
            source_start: 0,
            source_end: tile_size_bins * target_resolution,
            visual_start: tile_size_bins * target_resolution,
            orientation: "+".to_string(),
        }];
        let cached_tile = super::ContactMapTileResponse {
            tile_x: 1,
            tile_y: 1,
            cells: vec![super::ContactMapCellResponse {
                x_bin: 257,
                y_bin: 258,
                count: 42.0,
            }],
        };
        let tile_cache = Mutex::new(HashMap::from([(
            super::ContactTileCacheKey {
                path: cool_path.clone(),
                resolution: target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                projection_fingerprint: super::contact_tile_projection_fingerprint(
                    1,
                    1,
                    tile_size_bins * target_resolution,
                    &layout_blocks,
                ),
                tile_x: 1,
                tile_y: 1,
            },
            cached_tile.clone(),
        )]));
        let source_cache = Mutex::new(SourceContactCache::new(1024));

        let response = super::get_contact_map_tiles_from_cool_with_cache(
            ContactMapTilesFromCoolRequest {
                request_id: 1,
                generation: 1,
                cool_path,
                base_resolution: 1_000,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                tiles: vec![
                    ContactMapTileKeyRequest {
                        tile_x: 0,
                        tile_y: 0,
                    },
                    ContactMapTileKeyRequest {
                        tile_x: 1,
                        tile_y: 1,
                    },
                    ContactMapTileKeyRequest {
                        tile_x: 2,
                        tile_y: 2,
                    },
                ],
                layout_blocks,
            },
            &source_cache,
            &tile_cache,
        )
        .expect("cache holes must not turn sparse missing tiles into one over-read rectangle");

        assert_eq!(response.len(), 3);
        assert_eq!((response[0].tile_x, response[0].tile_y), (0, 0));
        assert!(response[0].cells.is_empty());
        assert_eq!(response[1], cached_tile);
        assert_eq!((response[2].tile_x, response[2].tile_y), (2, 2));
        assert!(response[2].cells.is_empty());
        assert_eq!(tile_cache.lock().expect("tile cache lock").len(), 3);
        assert_eq!(
            source_cache
                .lock()
                .expect("source cache lock")
                .entry_count(),
            0
        );
    }

    #[test]
    fn returns_requested_contact_tiles_including_empty_tiles() {
        let summary = super::load_example_dataset().expect("example dataset should load");
        let source_cache = Mutex::new(SourceContactCache::new(16 * 1024 * 1024));
        let tile_cache = Mutex::new(HashMap::new());
        let layout_blocks: Vec<ContactMapLayoutBlockRequest> = summary
            .agp_layout
            .blocks
            .into_iter()
            .map(|block| ContactMapLayoutBlockRequest {
                id: block.id,
                source_id: block.source_id,
                source_start: block.source_start,
                source_end: block.source_end,
                visual_start: block.visual_start,
                orientation: block.orientation,
            })
            .collect();

        let response = super::get_contact_map_tiles_from_cool_with_cache(
            ContactMapTilesFromCoolRequest {
                request_id: 1,
                generation: 1,
                cool_path: summary.cool_path.clone(),
                base_resolution: 1_000,
                target_resolution: 10_000,
                tile_size_bins: 256,
                normalization: ContactNormalizationRequest::Raw,
                tiles: vec![
                    ContactMapTileKeyRequest {
                        tile_x: 10_000,
                        tile_y: 10_000,
                    },
                    ContactMapTileKeyRequest {
                        tile_x: 10_001,
                        tile_y: 10_000,
                    },
                    ContactMapTileKeyRequest {
                        tile_x: 10_000,
                        tile_y: 10_001,
                    },
                ],
                layout_blocks: layout_blocks.clone(),
            },
            &source_cache,
            &tile_cache,
        )
        .expect("requested tiles should render");

        assert_eq!(response.len(), 2);
        assert_eq!(
            response
                .iter()
                .map(|tile| (tile.tile_x, tile.tile_y))
                .collect::<Vec<_>>(),
            vec![(10_000, 10_000), (10_000, 10_001)]
        );
        assert!(response.iter().all(|tile| tile.cells.is_empty()));
        assert_eq!(tile_cache.lock().expect("tile cache lock").len(), 2);

        let empty_source_cache = Mutex::new(SourceContactCache::new(16 * 1024 * 1024));
        let cached_response = super::get_contact_map_tiles_from_cool_with_cache(
            ContactMapTilesFromCoolRequest {
                request_id: 2,
                generation: 1,
                cool_path: summary.cool_path,
                base_resolution: 1_000,
                target_resolution: 10_000,
                tile_size_bins: 256,
                normalization: ContactNormalizationRequest::Raw,
                tiles: vec![
                    ContactMapTileKeyRequest {
                        tile_x: 10_000,
                        tile_y: 10_000,
                    },
                    ContactMapTileKeyRequest {
                        tile_x: 10_001,
                        tile_y: 10_000,
                    },
                    ContactMapTileKeyRequest {
                        tile_x: 10_000,
                        tile_y: 10_001,
                    },
                ],
                layout_blocks,
            },
            &empty_source_cache,
            &tile_cache,
        )
        .expect("cached requested tiles should render");

        assert_eq!(cached_response, response);
    }

    #[test]
    #[ignore = "run explicitly in a release build for diagnostic timings"]
    fn contact_tile_backend_release_benchmark() {
        assert!(
            !cfg!(debug_assertions),
            "contact tile timings are only meaningful with --release"
        );

        fn run_scenario(
            scenario: &str,
            request: ContactMapTilesFromCoolRequest,
            source_cache: &Mutex<SourceContactCache>,
            tile_cache: &Mutex<HashMap<super::ContactTileCacheKey, super::ContactMapTileResponse>>,
        ) -> (
            Vec<super::ContactMapTileResponse>,
            super::ContactTileStageTimings,
        ) {
            let request_id = request.request_id;
            let generation = request.generation;
            let base_resolution = request.base_resolution;
            let target_resolution = request.target_resolution;
            let tile_size_bins = request.tile_size_bins;
            let normalization = request.normalization;
            let layout_blocks = request.layout_blocks.len();
            let requested_tiles = request.tiles.len();
            let (result, timings) =
                super::profile_contact_tile_request(request, source_cache, tile_cache, &|| false);
            let tiles = result.expect("benchmark request should render");
            println!(
                "{}",
                timings.line(super::ContactTilePerfContext {
                    scenario,
                    request_id,
                    generation,
                    base_resolution,
                    target_resolution,
                    tile_size_bins,
                    normalization,
                    layout_blocks,
                    requested_tiles,
                    returned_tiles: tiles.len(),
                })
            );
            (tiles, timings)
        }

        let summary = super::load_example_dataset().expect("example dataset should load");
        let source_block = summary
            .agp_layout
            .blocks
            .into_iter()
            .max_by_key(|block| block.source_end - block.source_start)
            .expect("example layout block");
        let source_cache = Mutex::new(SourceContactCache::new(16 * 1024 * 1024));
        let cold_visual_cache = Mutex::new(HashMap::new());
        let moved_visual_cache = Mutex::new(HashMap::new());
        let tile_size_bins = 256;
        let target_resolution = 10_000;
        let tile_span = tile_size_bins * target_resolution;
        let request = |request_id, tile_x, tile_y, visual_start| ContactMapTilesFromCoolRequest {
            request_id,
            generation: 1,
            cool_path: summary.cool_path.clone(),
            base_resolution: 1_000,
            target_resolution,
            tile_size_bins,
            normalization: ContactNormalizationRequest::Raw,
            tiles: vec![ContactMapTileKeyRequest { tile_x, tile_y }],
            layout_blocks: vec![ContactMapLayoutBlockRequest {
                id: source_block.id.clone(),
                source_id: source_block.source_id.clone(),
                source_start: source_block.source_start,
                source_end: source_block.source_end,
                visual_start,
                orientation: source_block.orientation.clone(),
            }],
        };

        let (cold_tiles, cold) = run_scenario(
            "cold",
            request(10_001, 0, 0, 0),
            &source_cache,
            &cold_visual_cache,
        );
        assert_eq!(cold_tiles.len(), 1);
        assert_eq!(cold.cool_reads.get(), 1);
        assert_eq!(cold.source_misses.get(), 1);

        let (reprojected_tiles, reprojected) = run_scenario(
            "source_reprojection",
            request(10_002, 1, 1, tile_span),
            &source_cache,
            &moved_visual_cache,
        );
        assert_eq!(reprojected_tiles.len(), 1);
        assert_eq!(reprojected.cool_reads.get(), 0);
        assert_eq!(reprojected.source_hits.get(), 1);

        let (visual_hit_tiles, visual_hit) = run_scenario(
            "visual_hit",
            request(10_003, 0, 0, 0),
            &source_cache,
            &cold_visual_cache,
        );
        assert_eq!(visual_hit_tiles, cold_tiles);
        assert_eq!(visual_hit.visual_hits.get(), 1);
        assert_eq!(visual_hit.cool_reads.get(), 0);
        assert_eq!(visual_hit.projection.get(), std::time::Duration::ZERO);
        assert_eq!(visual_hit.store.get(), std::time::Duration::ZERO);
    }

    #[test]
    fn reuses_source_contact_tiles_after_visual_layout_move() {
        let summary = super::load_example_dataset().expect("example dataset should load");
        let source_block = summary
            .agp_layout
            .blocks
            .into_iter()
            .max_by_key(|block| block.source_end - block.source_start)
            .expect("example layout block");
        let source_cache = Mutex::new(SourceContactCache::new(16 * 1024 * 1024));
        let first_visual_cache = Mutex::new(HashMap::new());
        let tile_size_bins = 256;
        let target_resolution = 10_000;
        let tile_span = tile_size_bins * target_resolution;
        let layout_block = |visual_start| ContactMapLayoutBlockRequest {
            id: source_block.id.clone(),
            source_id: source_block.source_id.clone(),
            source_start: source_block.source_start,
            source_end: source_block.source_end,
            visual_start,
            orientation: source_block.orientation.clone(),
        };

        super::get_contact_map_tiles_from_cool_with_cache(
            ContactMapTilesFromCoolRequest {
                request_id: 3,
                generation: 1,
                cool_path: summary.cool_path.clone(),
                base_resolution: 1_000,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                tiles: vec![ContactMapTileKeyRequest {
                    tile_x: 0,
                    tile_y: 0,
                }],
                layout_blocks: vec![layout_block(0)],
            },
            &source_cache,
            &first_visual_cache,
        )
        .expect("initial source tile should load");
        let initial_entries = source_cache.lock().unwrap().entry_count();
        assert!(initial_entries > 0);

        let moved_visual_cache = Mutex::new(HashMap::new());
        let moved = super::get_contact_map_tiles_from_cool_with_cache(
            ContactMapTilesFromCoolRequest {
                request_id: 4,
                generation: 1,
                cool_path: summary.cool_path,
                base_resolution: 1_000,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                tiles: vec![ContactMapTileKeyRequest {
                    tile_x: 1,
                    tile_y: 1,
                }],
                layout_blocks: vec![layout_block(tile_span)],
            },
            &source_cache,
            &moved_visual_cache,
        )
        .expect("moved layout should reproject the source cache");

        assert_eq!(moved.len(), 1);
        assert_eq!(source_cache.lock().unwrap().entry_count(), initial_entries);
    }

    #[test]
    fn maps_contact_viewport_to_source_ranges_for_forward_and_reverse_blocks() {
        let ranges = super::source_ranges_for_contact_viewport(
            &ContactMapViewportRequest {
                x_start: 1_500,
                x_end: 3_500,
                y_start: 6_500,
                y_end: 7_500,
            },
            &[
                ContactMapLayoutBlockRequest {
                    id: "forward".to_string(),
                    source_id: "ctg-forward".to_string(),
                    source_start: 10_000,
                    source_end: 20_000,
                    visual_start: 1_000,
                    orientation: "+".to_string(),
                },
                ContactMapLayoutBlockRequest {
                    id: "reverse".to_string(),
                    source_id: "ctg-reverse".to_string(),
                    source_start: 30_000,
                    source_end: 40_000,
                    visual_start: 6_000,
                    orientation: "-".to_string(),
                },
            ],
        );

        assert_eq!(
            ranges,
            vec![
                ("ctg-forward".to_string(), 10_500, 12_500),
                ("ctg-forward".to_string(), 15_500, 16_500),
                ("ctg-reverse".to_string(), 38_500, 39_500),
            ]
        );
    }

    #[test]
    fn contact_viewport_source_ranges_exclude_the_gap_between_x_and_y() {
        let ranges = super::source_ranges_for_contact_viewport(
            &ContactMapViewportRequest {
                x_start: 0,
                x_end: 200,
                y_start: 900,
                y_end: 1_000,
            },
            &[
                ContactMapLayoutBlockRequest {
                    id: "x".to_string(),
                    source_id: "ctg-x".to_string(),
                    source_start: 0,
                    source_end: 200,
                    visual_start: 0,
                    orientation: "+".to_string(),
                },
                ContactMapLayoutBlockRequest {
                    id: "middle".to_string(),
                    source_id: "ctg-middle".to_string(),
                    source_start: 0,
                    source_end: 700,
                    visual_start: 200,
                    orientation: "+".to_string(),
                },
                ContactMapLayoutBlockRequest {
                    id: "y".to_string(),
                    source_id: "ctg-y".to_string(),
                    source_start: 10_000,
                    source_end: 10_100,
                    visual_start: 900,
                    orientation: "+".to_string(),
                },
            ],
        );

        assert_eq!(
            ranges,
            vec![
                ("ctg-x".to_string(), 0, 200),
                ("ctg-y".to_string(), 10_000, 10_100),
            ]
        );
    }

    #[test]
    fn contact_viewport_source_ranges_merge_overlapping_axes_per_source() {
        let ranges = super::source_ranges_for_contact_viewport(
            &ContactMapViewportRequest {
                x_start: 500,
                x_end: 2_500,
                y_start: 2_000,
                y_end: 3_500,
            },
            &[ContactMapLayoutBlockRequest {
                id: "shared".to_string(),
                source_id: "ctg-shared".to_string(),
                source_start: 1_000,
                source_end: 5_000,
                visual_start: 0,
                orientation: "+".to_string(),
            }],
        );

        assert_eq!(ranges, vec![("ctg-shared".to_string(), 1_500, 4_500)]);
    }

    #[test]
    fn contact_viewport_source_ranges_merge_adjacent_copies_of_one_source() {
        let ranges = super::source_ranges_for_contact_viewport(
            &ContactMapViewportRequest {
                x_start: 100,
                x_end: 300,
                y_start: 1_000,
                y_end: 1_200,
            },
            &[
                ContactMapLayoutBlockRequest {
                    id: "shared-a".to_string(),
                    source_id: "ctg-shared".to_string(),
                    source_start: 20_000,
                    source_end: 20_300,
                    visual_start: 0,
                    orientation: "+".to_string(),
                },
                ContactMapLayoutBlockRequest {
                    id: "shared-b".to_string(),
                    source_id: "ctg-shared".to_string(),
                    source_start: 20_300,
                    source_end: 20_600,
                    visual_start: 1_000,
                    orientation: "+".to_string(),
                },
            ],
        );

        assert_eq!(ranges, vec![("ctg-shared".to_string(), 20_100, 20_500)]);
    }

    #[test]
    fn builds_contact_map_view_response_from_frontend_layout_blocks() {
        let response = build_contact_map_view(ContactMapViewRequest {
            base_resolution: 1_000,
            target_resolution: 2_000,
            viewport: ContactMapViewportRequest {
                x_start: 0,
                x_end: 4_000,
                y_start: 0,
                y_end: 4_000,
            },
            layout_blocks: vec![
                ContactMapLayoutBlockRequest {
                    id: "block-a".to_string(),
                    source_id: "contig-a".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 0,
                    orientation: "+".to_string(),
                },
                ContactMapLayoutBlockRequest {
                    id: "block-b".to_string(),
                    source_id: "contig-b".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 2_000,
                    orientation: "+".to_string(),
                },
            ],
            contact_bins: vec![
                ContactMapBinRequest {
                    source1: "contig-a".to_string(),
                    start1: 0,
                    source2: "contig-b".to_string(),
                    start2: 0,
                    count: 4.0,
                },
                ContactMapBinRequest {
                    source1: "contig-a".to_string(),
                    start1: 1_000,
                    source2: "contig-b".to_string(),
                    start2: 1_000,
                    count: 6.0,
                },
            ],
        })
        .expect("valid contact map view request");

        assert_eq!(response.resolution, 2_000);
        assert_eq!(response.tile_size_bins, 256);
        assert_eq!(response.cells.len(), 1);
        assert_eq!(response.tiles.len(), 1);
        assert_eq!(response.tiles[0].cells.len(), 1);
        assert_eq!(response.cells[0].x_bin, 0);
        assert_eq!(response.cells[0].y_bin, 1);
        assert_eq!(response.cells[0].count, 10.0);
    }

    #[test]
    fn builds_coverage_view_response_from_frontend_layout_blocks() {
        let response = build_coverage_view(CoverageViewRequest {
            display_resolution: 1_000,
            viewport: ContactMapViewportRequest {
                x_start: 0,
                x_end: 3_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![ContactMapLayoutBlockRequest {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 10_000,
                visual_start: 0,
                orientation: "+".to_string(),
            }],
            bedgraph_records: vec![BedGraphRecordRequest {
                chrom: "contig-a".to_string(),
                start: 0,
                end: 10_000,
                value: 32.0,
            }],
        })
        .expect("valid coverage view request");

        assert_eq!(response.resolution, 1_000);
        assert_eq!(response.bins.len(), 3);
        assert!(response.bins.iter().all(|bin| bin.value == 32.0));
    }

    #[test]
    fn imports_bedgraph_file_for_coverage_view() {
        let root = super::project_root();
        let cache = Mutex::new(CoverageCache::new());
        let response = build_coverage_view_from_bedgraph_with_cache(
            CoverageViewFromBedGraphRequest {
                bedgraph_path: root
                    .join("examples/input.1000.coverage.bedgraph")
                    .to_string_lossy()
                    .to_string(),
                display_resolution: 1_000,
                viewport: ContactMapViewportRequest {
                    x_start: 0,
                    x_end: 2_000,
                    y_start: 0,
                    y_end: 1,
                },
                layout_blocks: vec![ContactMapLayoutBlockRequest {
                    id: "first-window".to_string(),
                    source_id: "Chr2A.ctg30".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 0,
                    orientation: "+".to_string(),
                }],
            },
            &cache,
        )
        .expect("example bedGraph should import");

        assert_eq!(response.resolution, 1_000);
        assert!(response.bins.len() <= 2);
        assert_eq!(cache.lock().unwrap().entry_count(), 1);

        let second = build_coverage_view_from_bedgraph_with_cache(
            CoverageViewFromBedGraphRequest {
                bedgraph_path: root
                    .join("examples/input.1000.coverage.bedgraph")
                    .to_string_lossy()
                    .to_string(),
                display_resolution: 1_000,
                viewport: ContactMapViewportRequest {
                    x_start: 2_000,
                    x_end: 4_000,
                    y_start: 0,
                    y_end: 1,
                },
                layout_blocks: vec![ContactMapLayoutBlockRequest {
                    id: "moved-window".to_string(),
                    source_id: "Chr2A.ctg30".to_string(),
                    source_start: 0,
                    source_end: 2_000,
                    visual_start: 2_000,
                    orientation: "+".to_string(),
                }],
            },
            &cache,
        )
        .expect("cached bedGraph should reproject");

        assert_eq!(second.resolution, 1_000);
        assert_eq!(cache.lock().unwrap().entry_count(), 1);
    }

    #[test]
    fn builds_synteny_view_response_with_merged_blocks() {
        let response = build_synteny_view(SyntenyViewRequest {
            viewport: ContactMapViewportRequest {
                x_start: 0,
                x_end: 5_000,
                y_start: 0,
                y_end: 1,
            },
            layout_blocks: vec![ContactMapLayoutBlockRequest {
                id: "block-a".to_string(),
                source_id: "contig-a".to_string(),
                source_start: 0,
                source_end: 5_000,
                visual_start: 0,
                orientation: "+".to_string(),
            }],
            paf_records: vec![
                PafRecordRequest {
                    query_name: "contig-a".to_string(),
                    query_len: 5_000,
                    query_start: 0,
                    query_end: 1_000,
                    strand: "+".to_string(),
                    target_name: "mono1".to_string(),
                    target_len: 50_000,
                    target_start: 10_000,
                    target_end: 11_000,
                    residue_matches: 900,
                    alignment_block_len: 1_000,
                    mapq: 60,
                },
                PafRecordRequest {
                    query_name: "contig-a".to_string(),
                    query_len: 5_000,
                    query_start: 1_050,
                    query_end: 2_000,
                    strand: "+".to_string(),
                    target_name: "mono1".to_string(),
                    target_len: 50_000,
                    target_start: 11_050,
                    target_end: 12_000,
                    residue_matches: 850,
                    alignment_block_len: 950,
                    mapq: 55,
                },
            ],
            min_mapq: 20,
            min_alignment_len: 500,
            max_query_gap: 100,
            max_target_gap: 100,
        })
        .expect("valid synteny view request");

        assert_eq!(response.blocks.len(), 1);
        assert_eq!(response.blocks[0].assembly_block_id, "block-a");
        assert_eq!(response.blocks[0].visual_start, 0);
        assert_eq!(response.blocks[0].visual_end, 2_000);
        assert_eq!(response.blocks[0].target_id, "mono1");
        assert_eq!(response.blocks[0].target_length, 50_000);
        assert_eq!(response.blocks[0].alignment_count, 2);
    }
}
