use flate2::read::MultiGzDecoder;
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Read, Write},
    ops::{Deref, DerefMut},
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
use tauri::Manager;

use crate::{
    contact_display_cache::{
        self, DisplayCacheStorageFormat, DisplayCacheTile, DisplayCacheValues,
    },
    contact_lod_cache::{self, LodCacheCell, LodCachePayload},
};

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

const MAX_CONTACT_LAYOUT_HANDLES: usize = 64;
const UNKNOWN_CONTACT_LAYOUT_HANDLE_PREFIX: &str = "unknown contact map layout handle";
// Overview aggregation must remain screen-sized even when the source matrix
// contains tens of millions of pixels. The frontend currently requests about
// 320 bins for the inspector and at most screen-scale bins for the main view;
// one million target slots leaves headroom for rectangular desktop viewports
// while preventing an accidental fine-resolution whole-genome request from
// growing an unbounded sparse HashMap.
const MAX_CONTACT_OVERVIEW_AGGREGATE_CELLS: u64 = 1_048_576;

#[derive(Debug)]
struct ContactLayoutRegistry {
    capacity: usize,
    next_handle: u64,
    layouts: HashMap<String, Arc<Vec<ContactMapLayoutBlockRequest>>>,
    recency: VecDeque<String>,
}

impl ContactLayoutRegistry {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            next_handle: 1,
            layouts: HashMap::new(),
            recency: VecDeque::new(),
        }
    }

    fn register(
        &mut self,
        layout_blocks: Vec<ContactMapLayoutBlockRequest>,
    ) -> Result<String, String> {
        let next_handle = self.next_handle;
        self.next_handle = self
            .next_handle
            .checked_add(1)
            .ok_or_else(|| "contact map layout handle space exhausted".to_string())?;
        let handle = format!("layout-{next_handle:016x}");
        self.layouts.insert(handle.clone(), Arc::new(layout_blocks));
        self.touch(&handle);
        self.evict_over_capacity();
        Ok(handle)
    }

    fn resolve(&mut self, handle: &str) -> Result<Arc<Vec<ContactMapLayoutBlockRequest>>, String> {
        let layout = self
            .layouts
            .get(handle)
            .cloned()
            .ok_or_else(|| format!("{UNKNOWN_CONTACT_LAYOUT_HANDLE_PREFIX}: {handle}"))?;
        self.touch(handle);
        Ok(layout)
    }

    fn touch(&mut self, handle: &str) {
        if let Some(index) = self.recency.iter().position(|current| current == handle) {
            self.recency.remove(index);
        }
        self.recency.push_back(handle.to_string());
    }

    fn evict_over_capacity(&mut self) {
        while self.layouts.len() > self.capacity {
            let Some(handle) = self.recency.pop_front() else {
                break;
            };
            self.layouts.remove(&handle);
        }
    }
}

#[derive(Debug, Clone)]
pub struct ContactLayoutRegistryState {
    registry: Arc<Mutex<ContactLayoutRegistry>>,
}

impl Default for ContactLayoutRegistryState {
    fn default() -> Self {
        Self {
            registry: Arc::new(Mutex::new(ContactLayoutRegistry::with_capacity(
                MAX_CONTACT_LAYOUT_HANDLES,
            ))),
        }
    }
}

impl ContactLayoutRegistryState {
    #[cfg(test)]
    fn with_capacity(capacity: usize) -> Self {
        Self {
            registry: Arc::new(Mutex::new(ContactLayoutRegistry::with_capacity(capacity))),
        }
    }

    fn register(&self, layout_blocks: Vec<ContactMapLayoutBlockRequest>) -> Result<String, String> {
        self.registry
            .lock()
            .map_err(|_| "contact map layout registry lock poisoned".to_string())?
            .register(layout_blocks)
    }

    fn resolve(&self, handle: &str) -> Result<Arc<Vec<ContactMapLayoutBlockRequest>>, String> {
        self.registry
            .lock()
            .map_err(|_| "contact map layout registry lock poisoned".to_string())?
            .resolve(handle)
    }
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

    fn register_for_purpose(
        &self,
        request_id: u64,
        generation: u64,
        purpose: ContactTileRequestPurpose,
    ) -> Result<(), String> {
        if purpose == ContactTileRequestPurpose::Visible {
            self.register(request_id, generation)
        } else {
            self.register_current_generation(request_id, generation)
        }
    }

    /// Register background work only after the visible layer has explicitly
    /// begun this generation. Unlike `register`, this cannot advance the
    /// generation clock and therefore cannot cancel foreground requests.
    fn register_current_generation(&self, request_id: u64, generation: u64) -> Result<(), String> {
        let mut active_requests = self
            .active_requests
            .lock()
            .map_err(|_| "contact tile request state lock poisoned".to_string())?;
        if generation != self.latest_generation.load(Ordering::SeqCst) {
            return Err("contact tile request cancelled".to_string());
        }
        if active_requests.contains_key(&request_id) {
            return Err(format!(
                "contact tile request {request_id} is already active"
            ));
        }
        active_requests.insert(request_id, generation);
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

    /// Normalization prewarming is lower priority than every contact-map
    /// request. It may run only while it is the sole registered task in the
    /// current generation; a foreground or tile-prefetch request makes its
    /// cancellation closure true at the next normalization checkpoint.
    fn is_normalization_prewarm_cancelled(&self, request_id: u64) -> bool {
        let Ok(active_requests) = self.active_requests.lock() else {
            return true;
        };
        let latest_generation = self.latest_generation.load(Ordering::SeqCst);
        let Some(generation) = active_requests.get(&request_id) else {
            return true;
        };
        *generation < latest_generation
            || active_requests
                .keys()
                .any(|active_request_id| *active_request_id != request_id)
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
    source_resolution: u64,
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

fn emit_contact_tile_perf_line(line: &str) {
    eprintln!("{line}");
    let Ok(path) = std::env::var("CSTUDIO_PERF_LOG_PATH") else {
        return;
    };
    if path.is_empty() || path.len() > 4_096 {
        return;
    }
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| {
            file.write_all(line.as_bytes())?;
            file.write_all(b"\n")
        });
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

#[derive(Debug, Clone, Copy)]
struct ContactTileCommandPerfContext<'a> {
    scenario: &'a str,
    request_id: u64,
    generation: u64,
    target_resolution: u64,
    requested_tiles: usize,
    returned_tiles: usize,
    response_cells: usize,
    command_us: u128,
}

fn contact_tile_command_perf_line(context: ContactTileCommandPerfContext<'_>) -> String {
    format!(
        "CSTUDIO_PERF event=contact_tiles_command scenario={} status=ok \
         request_id={} generation={} target_resolution={} requested_tiles={} \
         returned_tiles={} response_cells={} command_us={}",
        context.scenario,
        context.request_id,
        context.generation,
        context.target_resolution,
        context.requested_tiles,
        context.returned_tiles,
        context.response_cells,
        context.command_us,
    )
}

#[derive(Debug, Clone, Copy)]
struct ContactTileBinaryCommandPerfContext<'a> {
    scenario: &'a str,
    request_id: u64,
    generation: u64,
    target_resolution: u64,
    requested_tiles: usize,
    returned_tiles: usize,
    response_cells: usize,
    response_bytes: usize,
    command_us: u128,
}

#[derive(Debug, Clone, Copy)]
struct ContactTileProgressiveChunkPerfContext<'a> {
    scenario: &'a str,
    request_id: u64,
    generation: u64,
    target_resolution: u64,
    chunk_index: usize,
    chunk_count: usize,
    requested_tiles: usize,
    returned_tiles: usize,
    response_cells: usize,
    response_bytes: usize,
    compute_us: u128,
    encode_send_us: u128,
    elapsed_us: u128,
}

fn contact_tile_binary_command_perf_line(
    context: ContactTileBinaryCommandPerfContext<'_>,
) -> String {
    format!(
        "CSTUDIO_PERF event=contact_tiles_binary_command scenario={} status=ok \
         request_id={} generation={} target_resolution={} requested_tiles={} \
         returned_tiles={} response_cells={} response_bytes={} command_us={}",
        context.scenario,
        context.request_id,
        context.generation,
        context.target_resolution,
        context.requested_tiles,
        context.returned_tiles,
        context.response_cells,
        context.response_bytes,
        context.command_us,
    )
}

fn contact_tile_progressive_chunk_perf_line(
    context: ContactTileProgressiveChunkPerfContext<'_>,
) -> String {
    format!(
        "CSTUDIO_PERF event=contact_tiles_progressive_chunk scenario={} status=ok \
         request_id={} generation={} target_resolution={} chunk_index={} chunk_count={} \
         requested_tiles={} returned_tiles={} response_cells={} response_bytes={} \
         compute_us={} encode_send_us={} elapsed_us={}",
        context.scenario,
        context.request_id,
        context.generation,
        context.target_resolution,
        context.chunk_index,
        context.chunk_count,
        context.requested_tiles,
        context.returned_tiles,
        context.response_cells,
        context.response_bytes,
        context.compute_us,
        context.encode_send_us,
        context.elapsed_us,
    )
}

fn contact_tile_frontend_ipc_perf_line(
    request: &ContactTileFrontendIpcPerformanceRequest,
) -> String {
    format!(
        "CSTUDIO_PERF event=contact_tiles_invoke scenario={} status={} \
         request_id={} generation={} attempt={} target_resolution={} requested_tiles={} \
         returned_tiles={} response_cells={} response_bytes={} decode_us={} transport={} invoke_us={}",
        request.purpose.scenario_key(),
        request.status.key(),
        request.request_id,
        request.generation,
        request.attempt,
        request.target_resolution,
        request.requested_tiles,
        request.returned_tiles,
        request.response_cells,
        request.response_bytes,
        request.decode_us,
        request.transport.key(),
        request.invoke_us,
    )
}

fn contact_pan_frontend_perf_line(request: &ContactPanFrontendPerformanceRequest) -> String {
    format!(
        "CSTUDIO_PERF event=contact_pan_pipeline status={} pan_sequence={} generation={} \
         visible_tiles={} cache_hit={} pointer_to_generation_ms={} \
         pointer_to_ipc_start_ms={} ipc_ms={} pointer_to_cache_merge_ms={} \
         pointer_to_gpu_paint_ms={} total_ms={}",
        request.status.key(),
        request.pan_sequence,
        request.generation,
        request.visible_tiles,
        request.cache_hit,
        request.pointer_to_generation_ms,
        optional_perf_milliseconds(request.pointer_to_ipc_start_ms),
        optional_perf_milliseconds(request.ipc_ms),
        optional_perf_milliseconds(request.pointer_to_cache_merge_ms),
        optional_perf_milliseconds(request.pointer_to_gpu_paint_ms),
        optional_perf_milliseconds(request.total_ms),
    )
}

fn optional_perf_milliseconds(value: Option<f64>) -> String {
    value.map_or_else(
        || "null".to_string(),
        |milliseconds| milliseconds.to_string(),
    )
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
            // Cache namespace changes whenever runtime KR semantics change.
            // `kr_assembly_v1` invalidates tiles produced by the earlier
            // per-source-cis fallback while leaving raw/ICE/VC caches intact.
            Self::Kr => "kr_assembly_v1",
            Self::Vc => "vc",
            Self::VcSqrt => "vc_sqrt",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactTileRequestPurpose {
    #[default]
    Visible,
    SpatialPrefetch,
    AdjacentPrefetch,
    Overview,
    EndpointEvidence,
}

impl ContactTileRequestPurpose {
    fn scenario_key(self) -> &'static str {
        match self {
            Self::Visible => "visible",
            Self::SpatialPrefetch => "spatial_prefetch",
            Self::AdjacentPrefetch => "adjacent_prefetch",
            Self::Overview => "overview",
            Self::EndpointEvidence => "endpoint_evidence",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactTileFrontendIpcStatus {
    Ok,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactPanFrontendStatus {
    Ok,
    Superseded,
}

impl ContactPanFrontendStatus {
    fn key(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Superseded => "superseded",
        }
    }
}

impl ContactTileFrontendIpcStatus {
    fn key(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactTileFrontendIpcTransport {
    ArrayBuffer,
    Json,
    #[default]
    Unknown,
}

impl ContactTileFrontendIpcTransport {
    fn key(self) -> &'static str {
        match self {
            Self::ArrayBuffer => "array_buffer",
            Self::Json => "json",
            Self::Unknown => "unknown",
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
    pub version: String,
    pub engine: String,
    pub coordinate_convention: String,
    pub supported_operations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GfaBandageLayoutRequest {
    pub nodes: Vec<GfaBandageLayoutNodeRequest>,
    pub edges: Vec<GfaBandageLayoutEdgeRequest>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GfaBandageLayoutNodeRequest {
    pub id: String,
    pub width: f64,
    pub orientation: String,
    pub layout_unit_id: String,
    pub layout_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GfaBandageLayoutEdgeRequest {
    pub source: String,
    pub target: String,
    pub source_side: String,
    pub target_side: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GfaBandageLayoutResponse {
    pub algorithm: String,
    pub paths: Vec<GfaBandageLayoutPathResponse>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GfaBandageLayoutPathResponse {
    pub id: String,
    pub points: Vec<GfaBandageLayoutPointResponse>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct GfaBandageLayoutPointResponse {
    pub x: f64,
    pub y: f64,
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
    pub available_resolutions: Vec<u64>,
    pub contact_sources: Vec<ContactSourceMetadataResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContactSourceMetadataResponse {
    pub name: String,
    pub length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportedContactFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub available_resolutions: Vec<u64>,
    pub sources: Vec<ContactSourceMetadataResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProjectTextFile {
    pub path: String,
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAgpBundle {
    pub agp: ImportedProjectTextFile,
    pub history: Option<ImportedProjectTextFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProjectDirectory {
    pub directory: String,
    pub agp: Option<ImportedProjectTextFile>,
    pub history: Option<ImportedProjectTextFile>,
    pub gfa: Option<ImportedProjectTextFile>,
    pub paf: Option<ImportedContactFile>,
    pub coverage: Option<ImportedContactFile>,
    pub contact: Option<ImportedContactFile>,
    pub ignored_candidates: Vec<String>,
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
pub struct ContactMapOverviewFromCoolRequest {
    pub request_id: u64,
    pub generation: u64,
    pub cool_path: String,
    pub source_resolution: u64,
    pub target_resolution: u64,
    #[serde(default)]
    pub normalization: ContactNormalizationRequest,
    pub viewport: ContactMapViewportRequest,
    #[serde(default)]
    pub layout_handle: Option<String>,
    #[serde(default)]
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterContactMapLayoutRequest {
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactTileFrontendIpcPerformanceRequest {
    pub request_id: u64,
    pub generation: u64,
    pub purpose: ContactTileRequestPurpose,
    pub attempt: u32,
    pub target_resolution: u64,
    pub requested_tiles: usize,
    pub returned_tiles: usize,
    pub response_cells: usize,
    #[serde(default)]
    pub response_bytes: usize,
    #[serde(default)]
    pub decode_us: u64,
    #[serde(default)]
    pub transport: ContactTileFrontendIpcTransport,
    pub invoke_us: u64,
    pub status: ContactTileFrontendIpcStatus,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactPanFrontendPerformanceRequest {
    pub status: ContactPanFrontendStatus,
    pub generation: u64,
    pub pan_sequence: u64,
    pub visible_tiles: usize,
    pub cache_hit: bool,
    pub pointer_to_generation_ms: f64,
    pub pointer_to_ipc_start_ms: Option<f64>,
    pub ipc_ms: Option<f64>,
    pub pointer_to_cache_merge_ms: Option<f64>,
    pub pointer_to_gpu_paint_ms: Option<f64>,
    pub total_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapTilesFromCoolRequest {
    pub request_id: u64,
    pub generation: u64,
    #[serde(default)]
    pub purpose: ContactTileRequestPurpose,
    pub cool_path: String,
    pub base_resolution: u64,
    #[serde(default)]
    pub source_resolution: Option<u64>,
    pub target_resolution: u64,
    pub tile_size_bins: u64,
    #[serde(default)]
    pub normalization: ContactNormalizationRequest,
    #[serde(default)]
    pub adaptive_refinement: bool,
    pub tiles: Vec<ContactMapTileKeyRequest>,
    #[serde(default)]
    pub layout_handle: Option<String>,
    #[serde(default)]
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
}

#[derive(Debug, Clone)]
struct ResolvedContactMapTilesFromCoolRequest {
    request: ContactMapTilesFromCoolRequest,
    layout_blocks: Arc<Vec<ContactMapLayoutBlockRequest>>,
}

impl Deref for ResolvedContactMapTilesFromCoolRequest {
    type Target = ContactMapTilesFromCoolRequest;

    fn deref(&self) -> &Self::Target {
        &self.request
    }
}

impl DerefMut for ResolvedContactMapTilesFromCoolRequest {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.request
    }
}

const MAX_ADAPTIVE_MCOOL_EXACT_TILES: usize = 4;

fn adaptive_mcool_refinement_requested(
    request: &ResolvedContactMapTilesFromCoolRequest,
    tiles: &[ContactMapTileKeyRequest],
) -> bool {
    if !request.adaptive_refinement
        || request.purpose != ContactTileRequestPurpose::Visible
        || request.normalization != ContactNormalizationRequest::Raw
        || request.base_resolution != 1_000
        || request.target_resolution != 2_500_000
        || !request.cool_path.to_ascii_lowercase().ends_with(".mcool")
        || std::env::var("CSTUDIO_ADAPTIVE_MCOOL").as_deref() == Ok("0")
    {
        return false;
    }

    let coordinates = tiles
        .iter()
        .map(canonical_contact_tile_coordinate)
        .collect::<BTreeSet<_>>();
    if coordinates.is_empty() || coordinates.len() > MAX_ADAPTIVE_MCOOL_EXACT_TILES {
        return false;
    }
    let min_x = coordinates
        .iter()
        .map(|coordinate| coordinate.0)
        .min()
        .unwrap_or(0);
    let max_x = coordinates
        .iter()
        .map(|coordinate| coordinate.0)
        .max()
        .unwrap_or(min_x);
    let min_y = coordinates
        .iter()
        .map(|coordinate| coordinate.1)
        .min()
        .unwrap_or(0);
    let max_y = coordinates
        .iter()
        .map(|coordinate| coordinate.1)
        .max()
        .unwrap_or(min_y);

    max_x.saturating_sub(min_x) <= 1 && max_y.saturating_sub(min_y) <= 1
}

fn resolve_contact_tile_request(
    mut request: ContactMapTilesFromCoolRequest,
    registry_state: Option<&ContactLayoutRegistryState>,
) -> Result<ResolvedContactMapTilesFromCoolRequest, String> {
    let layout_blocks = if let Some(handle) = request.layout_handle.as_deref() {
        let registry_state = registry_state
            .ok_or_else(|| format!("{UNKNOWN_CONTACT_LAYOUT_HANDLE_PREFIX}: {handle}"))?;
        registry_state.resolve(handle)?
    } else {
        Arc::new(std::mem::take(&mut request.layout_blocks))
    };
    // Once a handle has been resolved, the immutable Arc is the sole layout
    // authority for this request. Clearing the legacy payload keeps recursive
    // work-region clones cheap and prevents a conflicting fallback from being
    // consulted later.
    request.layout_blocks.clear();
    Ok(ResolvedContactMapTilesFromCoolRequest {
        request,
        layout_blocks,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginContactTileGenerationRequest {
    pub generation: u64,
    pub retained_request_ids: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrewarmContactNormalizationsRequest {
    pub request_id: u64,
    pub generation: u64,
    pub cool_path: String,
    pub resolutions: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelContactNormalizationPrewarmRequest {
    pub request_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrewarmContactNormalizationsResponse {
    pub pixels_prepared: bool,
    pub prepared: usize,
    pub failed: usize,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactTilePrefetchResponse {
    pub cached_tiles: usize,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapOverviewResponse {
    pub source_resolution: u64,
    pub resolution: u64,
    pub viewport: ContactMapViewportResponse,
    pub cells: Vec<ContactMapCellResponse>,
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

const CONTACT_TILE_BINARY_MAGIC: [u8; 4] = *b"CST1";
const CONTACT_TILE_BINARY_VERSION: u16 = 1;
const CONTACT_TILE_BINARY_FLAGS: u16 = 0;
const CONTACT_TILE_BINARY_DENSE_FLOAT32_FLAGS: u16 = 1;
const CONTACT_TILE_BINARY_DENSE_R16F_FLAGS: u16 = 2;
const CONTACT_TILE_BINARY_DENSE_MIXED_FLAGS: u16 = 3;
const CONTACT_TILE_BINARY_DENSE_R16F_COUNT_FLAG: u32 = 1 << 31;
const CONTACT_TILE_BINARY_HEADER_BYTES: usize = 16;
const CONTACT_TILE_BINARY_DIRECTORY_BYTES: usize = 24;
const CONTACT_TILE_BINARY_MAX_TILE_SIZE_BINS: u64 = u16::MAX as u64 + 1;

fn encode_contact_map_tiles_binary_v1(
    tiles: &[ContactMapTileResponse],
    tile_size_bins: u64,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    ensure_contact_tile_request_active(should_cancel)?;
    if tile_size_bins == 0 || tile_size_bins > CONTACT_TILE_BINARY_MAX_TILE_SIZE_BINS {
        return Err(format!(
            "binary contact tile size must be between 1 and {CONTACT_TILE_BINARY_MAX_TILE_SIZE_BINS} bins"
        ));
    }

    let tile_count = u32::try_from(tiles.len())
        .map_err(|_| "binary contact tile count exceeds u32".to_string())?;
    let directory_len = tiles
        .len()
        .checked_mul(CONTACT_TILE_BINARY_DIRECTORY_BYTES)
        .ok_or_else(|| "binary contact tile directory size overflow".to_string())?;
    let metadata_len = CONTACT_TILE_BINARY_HEADER_BYTES
        .checked_add(directory_len)
        .ok_or_else(|| "binary contact tile metadata size overflow".to_string())?;
    let mut response_len = metadata_len;
    for tile in tiles {
        let cell_count = tile.cells.len();
        u32::try_from(cell_count)
            .map_err(|_| "binary contact tile cell count exceeds u32".to_string())?;
        let coordinate_bytes = cell_count
            .checked_mul(4)
            .ok_or_else(|| "binary contact tile coordinate size overflow".to_string())?;
        let aligned_coordinate_bytes = coordinate_bytes
            .checked_add(7)
            .map(|bytes| bytes & !7)
            .ok_or_else(|| "binary contact tile coordinate alignment overflow".to_string())?;
        let count_bytes = cell_count
            .checked_mul(std::mem::size_of::<f64>())
            .ok_or_else(|| "binary contact tile count payload size overflow".to_string())?;
        response_len = response_len
            .checked_add(aligned_coordinate_bytes)
            .and_then(|bytes| bytes.checked_add(count_bytes))
            .ok_or_else(|| "binary contact tile response size overflow".to_string())?;
    }
    if response_len > u32::MAX as usize {
        return Err("binary contact tile response exceeds u32 offsets".to_string());
    }

    let mut bytes = vec![0; metadata_len];
    bytes.reserve(response_len.saturating_sub(metadata_len));
    bytes[0..4].copy_from_slice(&CONTACT_TILE_BINARY_MAGIC);
    bytes[4..6].copy_from_slice(&CONTACT_TILE_BINARY_VERSION.to_le_bytes());
    bytes[6..8].copy_from_slice(&CONTACT_TILE_BINARY_FLAGS.to_le_bytes());
    bytes[8..12].copy_from_slice(&(tile_size_bins as u32).to_le_bytes());
    bytes[12..16].copy_from_slice(&tile_count.to_le_bytes());

    for (tile_index, tile) in tiles.iter().enumerate() {
        ensure_contact_tile_request_active(should_cancel)?;
        let (tile_start_x, tile_start_y) = if tile.cells.is_empty() {
            // Empty tiles carry only their directory identity. Avoid rejecting a
            // valid u64 tile key merely because no coordinate needs an origin.
            (0, 0)
        } else {
            (
                tile.tile_x
                    .checked_mul(tile_size_bins)
                    .ok_or_else(|| "binary contact tile X origin overflow".to_string())?,
                tile.tile_y
                    .checked_mul(tile_size_bins)
                    .ok_or_else(|| "binary contact tile Y origin overflow".to_string())?,
            )
        };
        let data_offset = u32::try_from(bytes.len())
            .map_err(|_| "binary contact tile data offset exceeds u32".to_string())?;
        let cell_count = u32::try_from(tile.cells.len())
            .map_err(|_| "binary contact tile cell count exceeds u32".to_string())?;
        let directory_offset =
            CONTACT_TILE_BINARY_HEADER_BYTES + tile_index * CONTACT_TILE_BINARY_DIRECTORY_BYTES;
        bytes[directory_offset..directory_offset + 8].copy_from_slice(&tile.tile_x.to_le_bytes());
        bytes[directory_offset + 8..directory_offset + 16]
            .copy_from_slice(&tile.tile_y.to_le_bytes());
        bytes[directory_offset + 16..directory_offset + 20]
            .copy_from_slice(&cell_count.to_le_bytes());
        bytes[directory_offset + 20..directory_offset + 24]
            .copy_from_slice(&data_offset.to_le_bytes());

        for (cell_index, cell) in tile.cells.iter().enumerate() {
            if cell_index % 4_096 == 0 {
                ensure_contact_tile_request_active(should_cancel)?;
            }
            let local_x = contact_tile_local_bin(
                cell.x_bin,
                tile_start_x,
                tile_size_bins,
                tile.tile_x,
                tile.tile_y,
                "X",
            )?;
            bytes.extend_from_slice(&local_x.to_le_bytes());
        }
        for (cell_index, cell) in tile.cells.iter().enumerate() {
            if cell_index % 4_096 == 0 {
                ensure_contact_tile_request_active(should_cancel)?;
            }
            let local_y = contact_tile_local_bin(
                cell.y_bin,
                tile_start_y,
                tile_size_bins,
                tile.tile_x,
                tile.tile_y,
                "Y",
            )?;
            bytes.extend_from_slice(&local_y.to_le_bytes());
        }
        while bytes.len() % std::mem::align_of::<f64>() != 0 {
            bytes.push(0);
        }
        for (cell_index, cell) in tile.cells.iter().enumerate() {
            if cell_index % 4_096 == 0 {
                ensure_contact_tile_request_active(should_cancel)?;
            }
            bytes.extend_from_slice(&cell.count.to_le_bytes());
        }
    }
    ensure_contact_tile_request_active(should_cancel)?;
    debug_assert_eq!(bytes.len(), response_len);
    Ok(bytes)
}

fn encode_contact_map_dense_tiles_binary_v1(
    tiles: &[DisplayCacheTile],
    tile_size_bins: u64,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    ensure_contact_tile_request_active(should_cancel)?;
    if tile_size_bins == 0 || tile_size_bins > CONTACT_TILE_BINARY_MAX_TILE_SIZE_BINS {
        return Err(format!(
            "binary contact tile size must be between 1 and {CONTACT_TILE_BINARY_MAX_TILE_SIZE_BINS} bins"
        ));
    }
    let tile_size = usize::try_from(tile_size_bins)
        .map_err(|_| "dense binary contact tile size exceeds platform range".to_string())?;
    let value_count = tile_size
        .checked_mul(tile_size)
        .ok_or_else(|| "dense binary contact tile value count overflow".to_string())?;
    let value_count_u32 = u32::try_from(value_count)
        .map_err(|_| "dense binary contact tile value count exceeds u32".to_string())?;
    let tile_count = u32::try_from(tiles.len())
        .map_err(|_| "dense binary contact tile count exceeds u32".to_string())?;
    let directory_len = tiles
        .len()
        .checked_mul(CONTACT_TILE_BINARY_DIRECTORY_BYTES)
        .ok_or_else(|| "dense binary contact tile directory size overflow".to_string())?;
    let metadata_len = CONTACT_TILE_BINARY_HEADER_BYTES
        .checked_add(directory_len)
        .ok_or_else(|| "dense binary contact tile metadata size overflow".to_string())?;
    let r16f_tiles = tiles
        .iter()
        .filter(|tile| tile.r16f_values().is_some())
        .count();
    let dense_r16f = !tiles.is_empty() && r16f_tiles == tiles.len();
    let dense_mixed = r16f_tiles > 0 && r16f_tiles < tiles.len();
    let mut response_len = metadata_len;
    for tile in tiles {
        let value_bytes = if tile.r16f_values().is_some() {
            std::mem::size_of::<u16>()
        } else {
            std::mem::size_of::<f32>()
        };
        let payload_bytes = value_count
            .checked_mul(value_bytes)
            .and_then(|payload| {
                if dense_mixed && tile.r16f_values().is_some() {
                    payload.checked_add(3).map(|bytes| bytes & !3)
                } else {
                    Some(payload)
                }
            })
            .ok_or_else(|| "dense binary contact tile response size overflow".to_string())?;
        response_len = response_len
            .checked_add(payload_bytes)
            .ok_or_else(|| "dense binary contact tile response size overflow".to_string())?;
    }
    if response_len > u32::MAX as usize {
        return Err("dense binary contact tile response exceeds u32 offsets".to_string());
    }

    let mut bytes = vec![0; metadata_len];
    bytes.reserve(response_len.saturating_sub(metadata_len));
    bytes[0..4].copy_from_slice(&CONTACT_TILE_BINARY_MAGIC);
    bytes[4..6].copy_from_slice(&CONTACT_TILE_BINARY_VERSION.to_le_bytes());
    let flags = if dense_mixed {
        CONTACT_TILE_BINARY_DENSE_MIXED_FLAGS
    } else if dense_r16f {
        CONTACT_TILE_BINARY_DENSE_R16F_FLAGS
    } else {
        CONTACT_TILE_BINARY_DENSE_FLOAT32_FLAGS
    };
    bytes[6..8].copy_from_slice(&flags.to_le_bytes());
    bytes[8..12].copy_from_slice(&(tile_size_bins as u32).to_le_bytes());
    bytes[12..16].copy_from_slice(&tile_count.to_le_bytes());

    for (tile_index, tile) in tiles.iter().enumerate() {
        ensure_contact_tile_request_active(should_cancel)?;
        if u64::from(tile.tile_size_bins) != tile_size_bins || tile.value_count() != value_count {
            return Err(format!(
                "dense binary contact tile {}:{} does not match tile size",
                tile.tile_x, tile.tile_y
            ));
        }
        let data_offset = u32::try_from(bytes.len())
            .map_err(|_| "dense binary contact tile data offset exceeds u32".to_string())?;
        let directory_offset =
            CONTACT_TILE_BINARY_HEADER_BYTES + tile_index * CONTACT_TILE_BINARY_DIRECTORY_BYTES;
        bytes[directory_offset..directory_offset + 8].copy_from_slice(&tile.tile_x.to_le_bytes());
        bytes[directory_offset + 8..directory_offset + 16]
            .copy_from_slice(&tile.tile_y.to_le_bytes());
        let directory_value_count = if dense_mixed && tile.r16f_values().is_some() {
            value_count_u32 | CONTACT_TILE_BINARY_DENSE_R16F_COUNT_FLAG
        } else {
            value_count_u32
        };
        bytes[directory_offset + 16..directory_offset + 20]
            .copy_from_slice(&directory_value_count.to_le_bytes());
        bytes[directory_offset + 20..directory_offset + 24]
            .copy_from_slice(&data_offset.to_le_bytes());
        if let Some(values) = tile.r16f_values() {
            for (value_index, value) in values.iter().enumerate() {
                if value_index % 4_096 == 0 {
                    ensure_contact_tile_request_active(should_cancel)?;
                }
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            while dense_mixed && bytes.len() % std::mem::align_of::<f32>() != 0 {
                bytes.push(0);
            }
        } else {
            let values = tile.float32_values();
            for (value_index, value) in values.iter().enumerate() {
                if value_index % 4_096 == 0 {
                    ensure_contact_tile_request_active(should_cancel)?;
                }
                if !value.is_finite() {
                    return Err(format!(
                        "dense binary contact tile {}:{} contains a non-finite value",
                        tile.tile_x, tile.tile_y
                    ));
                }
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    ensure_contact_tile_request_active(should_cancel)?;
    debug_assert_eq!(bytes.len(), response_len);
    Ok(bytes)
}

fn contact_tile_local_bin(
    global_bin: u64,
    tile_start: u64,
    tile_size_bins: u64,
    tile_x: u64,
    tile_y: u64,
    axis: &str,
) -> Result<u16, String> {
    let local_bin = global_bin.checked_sub(tile_start).ok_or_else(|| {
        format!("contact cell {axis} bin {global_bin} is outside tile ({tile_x}, {tile_y})")
    })?;
    if local_bin >= tile_size_bins || local_bin > u64::from(u16::MAX) {
        return Err(format!(
            "contact cell {axis} bin {global_bin} is outside tile ({tile_x}, {tile_y})"
        ));
    }
    Ok(local_bin as u16)
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
        version: env!("CARGO_PKG_VERSION").to_string(),
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
pub async fn layout_gfa_bandage(
    request: GfaBandageLayoutRequest,
) -> Result<GfaBandageLayoutResponse, String> {
    tauri::async_runtime::spawn_blocking(move || layout_gfa_bandage_response(request))
        .await
        .map_err(|error| error.to_string())?
}

fn layout_gfa_bandage_response(
    request: GfaBandageLayoutRequest,
) -> Result<GfaBandageLayoutResponse, String> {
    let mut ids = BTreeSet::new();
    let nodes = request
        .nodes
        .into_iter()
        .map(|node| {
            if node.id.is_empty() {
                return Err("GFA layout node id must not be empty".to_string());
            }
            if !ids.insert(node.id.clone()) {
                return Err(format!("duplicate GFA layout node id: {}", node.id));
            }
            Ok(cstudio_core::gfa_layout::GfaLayoutNode {
                id: node.id,
                width: node.width,
                reverse: node.orientation == "-",
                layout_unit_id: node.layout_unit_id,
                layout_order: node.layout_order,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let edges = request
        .edges
        .into_iter()
        .map(|edge| {
            Ok(cstudio_core::gfa_layout::GfaLayoutEdge {
                source: edge.source,
                target: edge.target,
                source_side: parse_gfa_layout_side(&edge.source_side)?,
                target_side: parse_gfa_layout_side(&edge.target_side)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let paths = cstudio_core::gfa_layout::layout_gfa_multilevel(&nodes, &edges)
        .into_iter()
        .map(|path| GfaBandageLayoutPathResponse {
            id: path.id,
            points: path
                .points
                .into_iter()
                .map(|point| GfaBandageLayoutPointResponse {
                    x: point.x,
                    y: point.y,
                })
                .collect(),
        })
        .collect();
    Ok(GfaBandageLayoutResponse {
        algorithm: "cstudio-rust-multilevel-v1".to_string(),
        paths,
    })
}

fn parse_gfa_layout_side(side: &str) -> Result<cstudio_core::gfa_layout::GfaLayoutSide, String> {
    match side {
        "start" => Ok(cstudio_core::gfa_layout::GfaLayoutSide::Start),
        "end" => Ok(cstudio_core::gfa_layout::GfaLayoutSide::End),
        _ => Err(format!("invalid GFA layout side: {side}")),
    }
}

#[tauri::command]
pub fn load_example_dataset() -> Result<ExampleDatasetSummary, String> {
    let root = project_root();
    let agp_path = root.join("examples/groups.agp");
    let coverage_path = root.join("examples/hifi.asm.bp.p_utg.noseq.depth");
    let paf_path = root.join("examples/mono.hifi.asm.bp.p_utg.paf");
    let contact_path = root.join("examples/input.1k_allres.mcool");
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
        .unwrap_or("input.1k_allres.mcool");

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
        available_resolutions: cstudio_core::cool::list_contact_resolutions(
            contact_path.to_string_lossy().as_ref(),
        )
        .map_err(|error| error.to_string())?,
        contact_sources: contact_sources_from_path(&contact_path)?,
    })
}

#[tauri::command]
pub fn load_example_gfa_text() -> Result<String, String> {
    fs::read_to_string(project_root().join("examples/hifi.asm.bp.p_utg.noseq.gfa"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_contact_file(path: String) -> Result<ImportedContactFile, String> {
    contact_file_from_path(Path::new(&path))
}

#[tauri::command]
pub fn load_coverage_file(path: String) -> Result<ImportedContactFile, String> {
    coverage_file_from_path(Path::new(&path))
}

#[tauri::command]
pub fn load_paf_file(path: String) -> Result<ImportedContactFile, String> {
    paf_file_from_path(Path::new(&path))
}

#[tauri::command]
pub fn load_project_directory(path: String) -> Result<ImportedProjectDirectory, String> {
    scan_project_directory(Path::new(&path))
}

#[tauri::command]
pub fn load_agp_bundle(path: String) -> Result<ImportedAgpBundle, String> {
    let path = PathBuf::from(path);
    if !has_data_suffix(&path, &["agp", "txt"]) {
        return Err("selected file must end with .agp, .txt, or their .gz form".to_string());
    }
    let agp = imported_text_file(&path)?;
    let history_path = history_sidecar_path(&path);
    let history = history_path
        .is_file()
        .then(|| imported_text_file(&history_path))
        .transpose()?;
    Ok(ImportedAgpBundle { agp, history })
}

#[tauri::command]
pub fn write_agp_file(path: String, contents: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    fs::write(&path, contents).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn write_agp_bundle(
    path: String,
    contents: String,
    history_contents: String,
) -> Result<String, String> {
    let path = PathBuf::from(path);
    write_agp_and_history(&path, &contents, &history_contents)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn overwrite_agp_file(path: String, contents: String) -> Result<bool, String> {
    write_existing_agp_path(Path::new(&path), &contents)
}

#[tauri::command]
pub fn overwrite_agp_bundle(
    path: String,
    contents: String,
    history_contents: String,
) -> Result<bool, String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Ok(false);
    }
    write_agp_and_history(&path, &contents, &history_contents)?;
    Ok(true)
}

#[tauri::command]
pub fn set_window_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|error| error.to_string())
}

fn write_existing_agp_path(path: &Path, contents: &str) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }

    fs::write(path, contents).map_err(|error| error.to_string())?;
    Ok(true)
}

fn write_agp_and_history(
    path: &Path,
    contents: &str,
    history_contents: &str,
) -> Result<(), String> {
    // Write the sidecar first. If the AGP write then fails, the embedded exact
    // AGP text makes the sidecar safely reject rather than attach to stale data.
    fs::write(history_sidecar_path(path), history_contents).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
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
pub async fn build_contact_map_overview_from_cool(
    request: ContactMapOverviewFromCoolRequest,
    app_handle: tauri::AppHandle,
    layout_registry_state: tauri::State<'_, ContactLayoutRegistryState>,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<ContactMapOverviewResponse, String> {
    let command_started = Instant::now();
    let layout_blocks = if let Some(handle) = request.layout_handle.as_deref() {
        layout_registry_state.resolve(handle)?
    } else {
        Arc::new(request.layout_blocks.clone())
    };
    let request_id = request.request_id;
    let generation = request.generation;
    request_state.register_for_purpose(
        request_id,
        generation,
        ContactTileRequestPurpose::Overview,
    )?;
    let _request_guard = ContactTileRequestGuard {
        state: request_state.inner().clone(),
        request_id,
    };
    let task_request_state = request_state.inner().clone();
    let persistent_cache_root = persistent_lod_cache_root(&app_handle, &request.cool_path);
    let persistent_cache_key = persistent_cache_root
        .as_ref()
        .map(|_| persistent_lod_cache_key(&request, layout_blocks.as_ref()))
        .transpose()?;
    let (response, cache_status, pending_store) = tauri::async_runtime::spawn_blocking(move || -> Result<
        (
            ContactMapOverviewResponse,
            &'static str,
            Option<(PathBuf, Vec<u8>, LodCachePayload)>,
        ),
        String,
    > {
        let should_cancel = || task_request_state.is_cancelled(request_id);
        ensure_contact_tile_request_active(&should_cancel)?;
        if let (Some(root), Some(key)) = (&persistent_cache_root, &persistent_cache_key) {
            match contact_lod_cache::load(root, key) {
                Ok(Some(payload)) => {
                    ensure_contact_tile_request_active(&should_cancel)?;
                    return Ok((
                        contact_overview_response_from_lod_payload(payload),
                        "hit",
                        None,
                    ));
                }
                Ok(None) => {}
                Err(error) => {
                    if contact_tile_perf_logging_enabled() {
                        eprintln!(
                            "CSTUDIO_PERF event=contact_lod_cache status=corrupt error={error}"
                        );
                    }
                    let _ = contact_lod_cache::remove_entry(root, key);
                }
            }
        }
        let response =
            build_contact_map_overview_from_cool_inner(request, layout_blocks, &should_cancel)?;
        let pending_store = persistent_cache_root
            .zip(persistent_cache_key)
            .map(|(root, key)| (root, key, lod_payload_from_contact_overview(&response)));
        let cache_status = if pending_store.is_some() {
            "miss"
        } else {
            "disabled"
        };
        Ok((response, cache_status, pending_store))
    })
    .await
    .map_err(|error| error.to_string())??;

    if let Some((root, key, payload)) = pending_store {
        tauri::async_runtime::spawn_blocking(move || {
            let started = Instant::now();
            let result = contact_lod_cache::store_atomic(&root, &key, &payload);
            let prune_result = result
                .as_ref()
                .ok()
                .map(|_| contact_lod_cache::prune(&root, persistent_lod_cache_budget_bytes(), 128));
            if contact_tile_perf_logging_enabled() {
                match result {
                    Ok(path) => eprintln!(
                        "CSTUDIO_PERF event=contact_lod_cache status=stored cells={} bytes={} write_us={} pruned_entries={} pruned_bytes={} path={}",
                        payload.cells.len(),
                        fs::metadata(&path).map_or(0, |metadata| metadata.len()),
                        started.elapsed().as_micros(),
                        prune_result.as_ref().and_then(|result| result.as_ref().ok()).map_or(0, |stats| stats.removed_entries),
                        prune_result.as_ref().and_then(|result| result.as_ref().ok()).map_or(0, |stats| stats.removed_bytes),
                        path.display(),
                    ),
                    Err(error) => eprintln!(
                        "CSTUDIO_PERF event=contact_lod_cache status=store_failed write_us={} error={error}",
                        started.elapsed().as_micros(),
                    ),
                }
                if let Some(Err(error)) = prune_result {
                    eprintln!(
                        "CSTUDIO_PERF event=contact_lod_cache status=prune_failed error={error}"
                    );
                }
            }
        });
    }

    if contact_tile_perf_logging_enabled() {
        eprintln!(
            "CSTUDIO_PERF event=contact_overview status=ok generation={} source_resolution={} \
             target_resolution={} response_cells={} persistent_cache={} command_us={}",
            generation,
            response.source_resolution,
            response.resolution,
            response.cells.len(),
            cache_status,
            command_started.elapsed().as_micros(),
        );
    }
    Ok(response)
}

fn persistent_lod_cache_root(app_handle: &tauri::AppHandle, cool_path: &str) -> Option<PathBuf> {
    if std::env::var("CSTUDIO_PERSISTENT_LOD_CACHE").as_deref() == Ok("0") {
        return None;
    }
    persistent_contact_lod_cache_enabled_for_path(cool_path)
        .then(|| app_handle.path().app_cache_dir().ok())
        .flatten()
        .map(|root| root.join("contact-lod-v1"))
}

fn persistent_contact_lod_cache_enabled_for_path(cool_path: &str) -> bool {
    Path::new(cool_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cool") || extension.eq_ignore_ascii_case("mcool")
        })
}

fn persistent_lod_cache_budget_bytes() -> u64 {
    std::env::var("CSTUDIO_PERSISTENT_LOD_CACHE_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_024)
        .clamp(64, 4_096)
        .saturating_mul(1024 * 1024)
}

fn persistent_lod_cache_key(
    request: &ContactMapOverviewFromCoolRequest,
    layout_blocks: &[ContactMapLayoutBlockRequest],
) -> Result<Vec<u8>, String> {
    let source_path =
        fs::canonicalize(&request.cool_path).unwrap_or_else(|_| PathBuf::from(&request.cool_path));
    let metadata = fs::metadata(&source_path).map_err(|error| {
        format!(
            "failed to identify .cool/.mcool file {} for persistent LOD cache: {error}",
            source_path.display()
        )
    })?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let mut key = Vec::with_capacity(layout_blocks.len().saturating_mul(96));
    push_lod_key_bytes(&mut key, b"cstudio-contact-overview-projection-v1")?;
    push_lod_key_bytes(&mut key, source_path.to_string_lossy().as_bytes())?;
    key.extend_from_slice(&metadata.len().to_le_bytes());
    key.extend_from_slice(&modified_nanos.to_le_bytes());
    key.extend_from_slice(&request.source_resolution.to_le_bytes());
    key.extend_from_slice(&request.target_resolution.to_le_bytes());
    push_lod_key_bytes(&mut key, request.normalization.cache_key().as_bytes())?;
    for value in [
        request.viewport.x_start,
        request.viewport.x_end,
        request.viewport.y_start,
        request.viewport.y_end,
    ] {
        key.extend_from_slice(&value.to_le_bytes());
    }
    key.extend_from_slice(
        &u64::try_from(layout_blocks.len())
            .map_err(|_| "layout block count exceeds persistent LOD key range".to_string())?
            .to_le_bytes(),
    );
    for block in layout_blocks {
        push_lod_key_bytes(&mut key, block.id.as_bytes())?;
        push_lod_key_bytes(&mut key, block.source_id.as_bytes())?;
        key.extend_from_slice(&block.source_start.to_le_bytes());
        key.extend_from_slice(&block.source_end.to_le_bytes());
        key.extend_from_slice(&block.visual_start.to_le_bytes());
        push_lod_key_bytes(&mut key, block.orientation.as_bytes())?;
    }
    Ok(key)
}

fn push_lod_key_bytes(key: &mut Vec<u8>, value: &[u8]) -> Result<(), String> {
    key.extend_from_slice(
        &u64::try_from(value.len())
            .map_err(|_| "persistent LOD key field exceeds u64".to_string())?
            .to_le_bytes(),
    );
    key.extend_from_slice(value);
    Ok(())
}

const DISPLAY_CACHE_COPY_SEMANTICS_VERSION: &[u8] = b"copy-share-interval-v1";
const DISPLAY_CACHE_MAX_DATASET_ENTRIES: usize = 100_000;
const DISPLAY_CACHE_MAX_GLOBAL_ENTRIES: usize = 500_000;

#[derive(Debug, Clone)]
struct PersistentDisplayCacheContext {
    global_root: PathBuf,
    dataset_root: PathBuf,
    file_fingerprint: Vec<u8>,
}

#[derive(Debug, Clone)]
struct PersistentDisplayTilePlan {
    tile_x: u64,
    tile_y: u64,
    key: Vec<u8>,
}

fn persistent_display_cache_context(
    app_handle: &tauri::AppHandle,
    request: &ResolvedContactMapTilesFromCoolRequest,
) -> Result<Option<PersistentDisplayCacheContext>, String> {
    if std::env::var("CSTUDIO_DISPLAY_CACHE").as_deref() == Ok("0")
        || std::env::var("CSTUDIO_DISPLAY_LOD_CACHE").as_deref() == Ok("0")
        || !persistent_contact_lod_cache_enabled_for_path(&request.cool_path)
    {
        return Ok(None);
    }
    let Some(app_cache_root) = app_handle.path().app_cache_dir().ok() else {
        return Ok(None);
    };
    let source_path =
        fs::canonicalize(&request.cool_path).unwrap_or_else(|_| PathBuf::from(&request.cool_path));
    let metadata = fs::metadata(&source_path).map_err(|error| {
        format!(
            "failed to identify .cool/.mcool file {} for display cache: {error}",
            source_path.display()
        )
    })?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let mut file_fingerprint = Vec::new();
    push_lod_key_bytes(&mut file_fingerprint, b"cstudio-contact-source-file-v1")?;
    push_lod_key_bytes(
        &mut file_fingerprint,
        source_path.to_string_lossy().as_bytes(),
    )?;
    file_fingerprint.extend_from_slice(&metadata.len().to_le_bytes());
    file_fingerprint.extend_from_slice(&modified_nanos.to_le_bytes());
    let global_root = app_cache_root.join("contact-display-v1");
    let dataset_root = global_root.join(contact_display_cache::digest_name(&file_fingerprint));
    Ok(Some(PersistentDisplayCacheContext {
        global_root,
        dataset_root,
        file_fingerprint,
    }))
}

fn persistent_display_tile_plans(
    context: &PersistentDisplayCacheContext,
    request: &ResolvedContactMapTilesFromCoolRequest,
) -> Result<Vec<PersistentDisplayTilePlan>, String> {
    let source_resolution = request
        .source_resolution
        .unwrap_or(request.target_resolution);
    let adaptive_refinement = adaptive_mcool_refinement_requested(request, &request.tiles);
    let tile_span = request
        .tile_size_bins
        .checked_mul(request.target_resolution)
        .ok_or_else(|| "display cache tile span overflowed".to_string())?;
    let coordinates = request
        .tiles
        .iter()
        .map(canonical_contact_tile_coordinate)
        .collect::<BTreeSet<_>>();
    let mut axis_fingerprints = BTreeMap::<u64, String>::new();
    for (tile_x, tile_y) in &coordinates {
        for axis in [*tile_x, *tile_y] {
            axis_fingerprints.entry(axis).or_insert_with(|| {
                contact_projection_axis_fingerprint(axis, tile_span, &request.layout_blocks)
            });
        }
    }
    coordinates
        .into_iter()
        .map(|(tile_x, tile_y)| {
            let mut key = Vec::new();
            push_lod_key_bytes(&mut key, b"cstudio-display-tile-v2")?;
            push_lod_key_bytes(
                &mut key,
                if persistent_display_cache_storage_format() == DisplayCacheStorageFormat::R16f {
                    b"gpu-ready-r16f-v1"
                } else {
                    b"float32-v1"
                },
            )?;
            push_lod_key_bytes(&mut key, &context.file_fingerprint)?;
            key.extend_from_slice(&request.base_resolution.to_le_bytes());
            key.extend_from_slice(&source_resolution.to_le_bytes());
            key.extend_from_slice(&request.target_resolution.to_le_bytes());
            key.extend_from_slice(&request.tile_size_bins.to_le_bytes());
            key.push(u8::from(adaptive_refinement));
            push_lod_key_bytes(&mut key, request.normalization.cache_key().as_bytes())?;
            push_lod_key_bytes(&mut key, DISPLAY_CACHE_COPY_SEMANTICS_VERSION)?;
            key.extend_from_slice(&tile_x.to_le_bytes());
            key.extend_from_slice(&tile_y.to_le_bytes());
            push_lod_key_bytes(
                &mut key,
                axis_fingerprints
                    .get(&tile_x)
                    .expect("display cache X fingerprint was precomputed")
                    .as_bytes(),
            )?;
            push_lod_key_bytes(
                &mut key,
                axis_fingerprints
                    .get(&tile_y)
                    .expect("display cache Y fingerprint was precomputed")
                    .as_bytes(),
            )?;
            Ok(PersistentDisplayTilePlan {
                tile_x,
                tile_y,
                key,
            })
        })
        .collect()
}

fn persistent_display_cache_storage_format() -> DisplayCacheStorageFormat {
    if std::env::var("CSTUDIO_DISPLAY_CACHE_R16F").as_deref() == Ok("0") {
        DisplayCacheStorageFormat::Float32
    } else {
        DisplayCacheStorageFormat::R16f
    }
}

fn persistent_display_cache_dataset_budget_bytes() -> u64 {
    std::env::var("CSTUDIO_DISPLAY_LOD_CACHE_DATASET_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(2_048)
        .clamp(256, 5_120)
        .saturating_mul(1024 * 1024)
}

fn persistent_display_cache_global_budget_bytes() -> u64 {
    std::env::var("CSTUDIO_DISPLAY_LOD_CACHE_GLOBAL_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(10_240)
        .clamp(1_024, 20_480)
        .saturating_mul(1024 * 1024)
}

fn lod_payload_from_contact_overview(response: &ContactMapOverviewResponse) -> LodCachePayload {
    LodCachePayload {
        source_resolution: response.source_resolution,
        target_resolution: response.resolution,
        viewport: [
            response.viewport.x_start,
            response.viewport.x_end,
            response.viewport.y_start,
            response.viewport.y_end,
        ],
        cells: response
            .cells
            .iter()
            .map(|cell| LodCacheCell {
                x_bin: cell.x_bin,
                y_bin: cell.y_bin,
                count: cell.count,
            })
            .collect(),
    }
}

fn contact_overview_response_from_lod_payload(
    payload: LodCachePayload,
) -> ContactMapOverviewResponse {
    ContactMapOverviewResponse {
        source_resolution: payload.source_resolution,
        resolution: payload.target_resolution,
        viewport: ContactMapViewportResponse {
            x_start: payload.viewport[0],
            x_end: payload.viewport[1],
            y_start: payload.viewport[2],
            y_end: payload.viewport[3],
        },
        cells: payload
            .cells
            .into_iter()
            .map(|cell| ContactMapCellResponse {
                x_bin: cell.x_bin,
                y_bin: cell.y_bin,
                count: cell.count,
            })
            .collect(),
    }
}

fn contact_overview_aggregate_cell_bound(
    request: &ContactMapOverviewFromCoolRequest,
) -> Result<usize, String> {
    let resolution = request.target_resolution;
    if resolution == 0 {
        return Err("overview targetResolution must be positive".to_string());
    }
    if request.viewport.x_start >= request.viewport.x_end
        || request.viewport.y_start >= request.viewport.y_end
    {
        return Err("overview viewport start must be less than viewport end".to_string());
    }

    let x_start_bin = request.viewport.x_start / resolution;
    let x_end_bin = request.viewport.x_end.div_ceil(resolution);
    let y_start_bin = request.viewport.y_start / resolution;
    let y_end_bin = request.viewport.y_end.div_ceil(resolution);
    let x_bins = x_end_bin.saturating_sub(x_start_bin);
    let y_bins = y_end_bin.saturating_sub(y_start_bin);
    let cell_bound = x_bins
        .checked_mul(y_bins)
        .ok_or_else(|| "overview target grid cell bound overflowed u64".to_string())?;
    if cell_bound > MAX_CONTACT_OVERVIEW_AGGREGATE_CELLS {
        return Err(format!(
            "overview target grid could contain {cell_bound} cells, exceeding bounded aggregate limit {MAX_CONTACT_OVERVIEW_AGGREGATE_CELLS}; request a coarser targetResolution"
        ));
    }

    usize::try_from(cell_bound)
        .map_err(|_| "overview target grid exceeds this platform's index range".to_string())
}

fn build_contact_map_overview_from_cool_inner(
    request: ContactMapOverviewFromCoolRequest,
    layout_blocks: Arc<Vec<ContactMapLayoutBlockRequest>>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<ContactMapOverviewResponse, String> {
    ensure_contact_tile_request_active(should_cancel)?;
    if request.source_resolution == 0
        || request.target_resolution == 0
        || request.target_resolution % request.source_resolution != 0
    {
        return Err(
            "overview targetResolution must be a positive multiple of sourceResolution".to_string(),
        );
    }
    let aggregate_cell_bound = contact_overview_aggregate_cell_bound(&request)?;

    let query = contact_map_query_from_parts(
        request.source_resolution,
        request.target_resolution,
        request.viewport.clone(),
        layout_blocks.as_ref().clone(),
    )?;
    let source_ranges =
        source_ranges_for_contact_viewport(&request.viewport, layout_blocks.as_ref());
    let is_mcool = Path::new(&request.cool_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mcool"));
    let mut projector = cstudio_core::contact_map::ContactMapChunkProjector::new_for_bounded_view(
        &query,
        aggregate_cell_bound,
    )
    .map_err(|error| error.to_string())?;
    let visited_contacts = cstudio_core::cool::visit_cool_contact_chunks_indexed_for_source_ranges_at_resolution_with_normalization_cancellable(
        &request.cool_path,
        &source_ranges,
        is_mcool.then_some(request.source_resolution),
        request.normalization.into(),
        should_cancel,
        |source1_index, source1, start1, source2_index, source2, start2, count| {
            projector.push_indexed_contact(
                source1_index,
                source1,
                start1,
                source2_index,
                source2,
                start2,
                count,
            );
            Ok(())
        },
        || Ok(()),
    )
    .map_err(|error| error.to_string())?;
    ensure_contact_tile_request_active(should_cancel)?;
    let view = projector.take_view();
    debug_assert!(view.cells.len() <= aggregate_cell_bound);
    if contact_tile_perf_logging_enabled() {
        eprintln!(
            "CSTUDIO_PERF event=contact_overview_chunk_aggregate status=ok source_resolution={} \
             target_resolution={} visited_contacts={} aggregate_cell_bound={} response_cells={}",
            request.source_resolution,
            request.target_resolution,
            visited_contacts,
            aggregate_cell_bound,
            view.cells.len(),
        );
    }
    let cells = view
        .cells
        .into_iter()
        .map(|cell| ContactMapCellResponse {
            x_bin: cell.x_bin,
            y_bin: cell.y_bin,
            count: cell.count,
        })
        .collect();

    Ok(ContactMapOverviewResponse {
        source_resolution: request.source_resolution,
        resolution: view.resolution,
        viewport: ContactMapViewportResponse {
            x_start: view.viewport.x_start,
            x_end: view.viewport.x_end,
            y_start: view.viewport.y_start,
            y_end: view.viewport.y_end,
        },
        cells,
    })
}

#[tauri::command]
pub fn register_contact_map_layout(
    request: RegisterContactMapLayoutRequest,
    registry_state: tauri::State<'_, ContactLayoutRegistryState>,
) -> Result<String, String> {
    registry_state.register(request.layout_blocks)
}

#[tauri::command]
pub fn log_contact_tile_frontend_ipc(request: ContactTileFrontendIpcPerformanceRequest) {
    if contact_tile_perf_logging_enabled() {
        emit_contact_tile_perf_line(&contact_tile_frontend_ipc_perf_line(&request));
    }
}

#[tauri::command]
pub fn log_contact_pan_frontend_performance(request: ContactPanFrontendPerformanceRequest) {
    if contact_tile_perf_logging_enabled() {
        emit_contact_tile_perf_line(&contact_pan_frontend_perf_line(&request));
    }
}

#[tauri::command]
pub fn log_contact_frontend_performance(line: String) {
    let accepted_event = line.starts_with("CSTUDIO_PERF event=contact_tiles_frontend ")
        || line.starts_with("CSTUDIO_PERF event=contact_resolution_responsiveness ")
        || line.starts_with("CSTUDIO_PERF event=contact_gpu_texture ");
    if contact_tile_perf_logging_enabled() && line.len() <= 2_048 && accepted_event {
        emit_contact_tile_perf_line(&line);
    }
}

#[tauri::command]
pub fn log_gfa_frontend_performance(line: String) {
    if line.len() <= 1_024 && line.starts_with("CSTUDIO_PERF event=gfa_") {
        eprintln!("{line}");
    }
}

#[tauri::command]
pub fn begin_contact_tile_generation(
    request: BeginContactTileGenerationRequest,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<Vec<u64>, String> {
    request_state.retain_and_begin_generation(request.generation, &request.retained_request_ids)
}

#[tauri::command]
pub async fn prewarm_contact_normalizations(
    request: PrewarmContactNormalizationsRequest,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<PrewarmContactNormalizationsResponse, String> {
    let mut resolutions = request.resolutions;
    resolutions.retain(|resolution| *resolution > 0);
    let mut seen_resolutions = BTreeSet::new();
    resolutions.retain(|resolution| seen_resolutions.insert(*resolution));
    if resolutions.is_empty() {
        return Err("normalization prewarm requires at least one resolution".to_string());
    }

    request_state.register_current_generation(request.request_id, request.generation)?;
    let task_request_state = request_state.inner().clone();
    let request_id = request.request_id;
    let generation = request.generation;
    let cool_path = request.cool_path;
    let _request_guard = ContactTileRequestGuard {
        state: request_state.inner().clone(),
        request_id,
    };

    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let should_cancel = || {
            task_request_state.is_normalization_prewarm_cancelled(request_id)
        };
        let normalizations = [
            cstudio_core::contact_normalization::ContactNormalization::Kr,
            cstudio_core::contact_normalization::ContactNormalization::Ice,
            cstudio_core::contact_normalization::ContactNormalization::Vc,
            cstudio_core::contact_normalization::ContactNormalization::VcSqrt,
        ];
        let mut prepared = 0_usize;
        let mut failed = 0_usize;
        let mut cancelled = false;
        let pixels_prepared = match resolutions.first().copied() {
            Some(resolution) => {
                match cstudio_core::cool::prewarm_contact_pixels_at_resolution_cancellable(
                    &cool_path,
                    Some(resolution),
                    &should_cancel,
                ) {
                    Ok(prepared) => prepared,
                    Err(cstudio_core::CStudioError::RequestCancelled) => {
                        cancelled = true;
                        false
                    }
                    Err(error) => {
                        failed = failed.saturating_add(1);
                        if contact_tile_perf_logging_enabled() {
                            eprintln!(
                                "CSTUDIO_PERF event=contact_pixel_prewarm status=error request_id={} generation={} resolution={} error={:?}",
                                request_id, generation, resolution, error,
                            );
                        }
                        false
                    }
                }
            }
            None => false,
        };

        'resolutions: for resolution in resolutions {
            if cancelled {
                break;
            }
            for normalization in normalizations {
                match cstudio_core::cool::prewarm_contact_normalization_at_resolution_cancellable(
                    &cool_path,
                    Some(resolution),
                    normalization,
                    &should_cancel,
                ) {
                    Ok(()) => prepared = prepared.saturating_add(1),
                    Err(cstudio_core::CStudioError::RequestCancelled) => {
                        cancelled = true;
                        break 'resolutions;
                    }
                    Err(error) => {
                        failed = failed.saturating_add(1);
                        if contact_tile_perf_logging_enabled() {
                            eprintln!(
                                "CSTUDIO_PERF event=normalization_prewarm status=method_error request_id={} generation={} resolution={} normalization={} error={:?}",
                                request_id,
                                generation,
                                resolution,
                                normalization.as_str(),
                                error,
                            );
                        }
                    }
                }
            }
        }

        if contact_tile_perf_logging_enabled() {
            eprintln!(
                "CSTUDIO_PERF event=normalization_prewarm status={} request_id={} generation={} pixels_prepared={} prepared={} failed={} elapsed_ms={}",
                if cancelled { "cancelled" } else { "complete" },
                request_id,
                generation,
                pixels_prepared,
                prepared,
                failed,
                started.elapsed().as_millis(),
            );
        }
        PrewarmContactNormalizationsResponse {
            pixels_prepared,
            prepared,
            failed,
            cancelled,
        }
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_contact_normalization_prewarm(
    request: CancelContactNormalizationPrewarmRequest,
    request_state: tauri::State<'_, ContactTileRequestState>,
) {
    request_state.finish(request.request_id);
}

#[tauri::command]
pub async fn get_contact_map_tiles_from_cool(
    request: ContactMapTilesFromCoolRequest,
    layout_registry_state: tauri::State<'_, ContactLayoutRegistryState>,
    source_cache_state: tauri::State<'_, SourceContactCacheState>,
    tile_cache_state: tauri::State<'_, ContactTileCacheState>,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<Vec<ContactMapTileResponse>, String> {
    let command_started = Instant::now();
    // Resolve and clone the immutable layout before generation registration.
    // An unknown handle must not advance the generation clock, and later LRU
    // eviction cannot invalidate the Arc held by this in-flight request.
    let request = resolve_contact_tile_request(request, Some(layout_registry_state.inner()))?;
    let request_id = request.request_id;
    let generation = request.generation;
    let purpose = request.purpose;
    let target_resolution = request.target_resolution;
    let requested_tiles = request.tiles.len();
    request_state.register_for_purpose(request_id, generation, purpose)?;
    let _request_guard = ContactTileRequestGuard {
        state: request_state.inner().clone(),
        request_id,
    };
    let source_cache = Arc::clone(&source_cache_state.inner().cache);
    let tile_cache = Arc::clone(&tile_cache_state.inner().cache);
    let task_request_state = request_state.inner().clone();
    let tiles = tauri::async_runtime::spawn_blocking(move || {
        get_contact_map_tiles_from_cool_with_cache_cancellable(
            request,
            source_cache.as_ref(),
            tile_cache.as_ref(),
            &|| task_request_state.is_cancelled(request_id),
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    let command_us = command_started.elapsed().as_micros();
    if contact_tile_perf_logging_enabled() {
        eprintln!(
            "{}",
            contact_tile_command_perf_line(ContactTileCommandPerfContext {
                scenario: purpose.scenario_key(),
                request_id,
                generation,
                target_resolution,
                requested_tiles,
                returned_tiles: tiles.len(),
                response_cells: tiles.iter().map(|tile| tile.cells.len()).sum(),
                command_us,
            })
        );
    }
    Ok(tiles)
}

/// Populate the process-level visual tile cache without serializing the tile
/// payload back into the WebView. Pan gestures use this command so HDF5 and
/// projection can overlap pointer movement without IPC decoding or GPU uploads
/// competing with animation frames.
#[tauri::command]
pub async fn prefetch_contact_map_tiles_from_cool(
    request: ContactMapTilesFromCoolRequest,
    layout_registry_state: tauri::State<'_, ContactLayoutRegistryState>,
    source_cache_state: tauri::State<'_, SourceContactCacheState>,
    tile_cache_state: tauri::State<'_, ContactTileCacheState>,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<ContactTilePrefetchResponse, String> {
    let request = resolve_contact_tile_request(request, Some(layout_registry_state.inner()))?;
    if request.purpose != ContactTileRequestPurpose::SpatialPrefetch {
        return Err("pan tile prefetch requires spatial_prefetch purpose".to_string());
    }
    let request_id = request.request_id;
    let generation = request.generation;
    request_state.register_current_generation(request_id, generation)?;
    let _request_guard = ContactTileRequestGuard {
        state: request_state.inner().clone(),
        request_id,
    };
    let source_cache = Arc::clone(&source_cache_state.inner().cache);
    let tile_cache = Arc::clone(&tile_cache_state.inner().cache);
    let task_request_state = request_state.inner().clone();
    let cached_tiles = tauri::async_runtime::spawn_blocking(move || {
        let should_cancel = || task_request_state.is_cancelled(request_id);
        get_contact_map_tiles_from_cool_with_cache_cancellable(
            request,
            source_cache.as_ref(),
            tile_cache.as_ref(),
            &should_cancel,
        )
        .map(|tiles| tiles.len())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(ContactTilePrefetchResponse { cached_tiles })
}

#[tauri::command]
pub async fn get_contact_map_tiles_from_cool_binary_v1(
    request: ContactMapTilesFromCoolRequest,
    app_handle: tauri::AppHandle,
    layout_registry_state: tauri::State<'_, ContactLayoutRegistryState>,
    source_cache_state: tauri::State<'_, SourceContactCacheState>,
    tile_cache_state: tauri::State<'_, ContactTileCacheState>,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<tauri::ipc::Response, String> {
    let command_started = Instant::now();
    // Match the JSON command's handle, generation, cancellation, and cache
    // semantics exactly. Only the final response representation differs.
    let request = resolve_contact_tile_request(request, Some(layout_registry_state.inner()))?;
    let request_id = request.request_id;
    let generation = request.generation;
    let purpose = request.purpose;
    let target_resolution = request.target_resolution;
    let tile_size_bins = request.tile_size_bins;
    let requested_tiles = request.tiles.len();
    request_state.register_for_purpose(request_id, generation, purpose)?;
    let _request_guard = ContactTileRequestGuard {
        state: request_state.inner().clone(),
        request_id,
    };
    let source_cache = Arc::clone(&source_cache_state.inner().cache);
    let tile_cache = Arc::clone(&tile_cache_state.inner().cache);
    let task_request_state = request_state.inner().clone();
    let display_cache_context = persistent_display_cache_context(&app_handle, &request)?;
    let display_cache_plans = display_cache_context
        .as_ref()
        .map(|context| persistent_display_tile_plans(context, &request))
        .transpose()?
        .unwrap_or_default();
    let display_store_context = display_cache_context.clone();
    let (bytes, returned_tiles, response_cells, display_cache_stats, pending_display_store) =
        tauri::async_runtime::spawn_blocking(move || {
            let should_cancel = || task_request_state.is_cancelled(request_id);
            if let Some(context) = display_cache_context.as_ref() {
                let (cached_tiles, missing_plans, display_cache_stats) =
                    load_persistent_display_tiles(
                        context,
                        &request,
                        display_cache_plans.clone(),
                        &should_cancel,
                    )?;
                let mut compute_request = request;
                compute_request.tiles = missing_plans
                    .iter()
                    .map(|plan| ContactMapTileKeyRequest {
                        tile_x: plan.tile_x,
                        tile_y: plan.tile_y,
                    })
                    .collect();
                let computed_tiles = if compute_request.tiles.is_empty() {
                    Vec::new()
                } else {
                    get_contact_map_tiles_from_cool_with_cache_cancellable(
                        compute_request,
                        source_cache.as_ref(),
                        tile_cache.as_ref(),
                        &should_cancel,
                    )?
                };
                ensure_contact_tile_request_active(&should_cancel)?;
                let pending_display_store = pending_display_tiles_from_complete_tiles(
                    tile_size_bins,
                    &missing_plans,
                    &computed_tiles,
                )?;
                let dense_tiles = ordered_persistent_display_tiles(
                    &display_cache_plans,
                    cached_tiles,
                    &pending_display_store,
                )?;
                let returned_tiles = dense_tiles.len();
                let response_cells = dense_tiles.iter().map(display_tile_occupied_cells).sum();
                let bytes = encode_contact_map_dense_tiles_binary_v1(
                    &dense_tiles,
                    tile_size_bins,
                    &should_cancel,
                )?;
                return Ok::<_, String>((
                    bytes,
                    returned_tiles,
                    response_cells,
                    display_cache_stats,
                    Some(pending_display_store),
                ));
            }

            let tiles = get_contact_map_tiles_from_cool_with_cache_cancellable(
                request,
                source_cache.as_ref(),
                tile_cache.as_ref(),
                &should_cancel,
            )?;
            let returned_tiles = tiles.len();
            let response_cells = tiles.iter().map(|tile| tile.cells.len()).sum();
            let bytes = encode_contact_map_tiles_binary_v1(&tiles, tile_size_bins, &should_cancel)?;
            Ok::<_, String>((
                bytes,
                returned_tiles,
                response_cells,
                PersistentDisplayCacheLookupStats::default(),
                None,
            ))
        })
        .await
        .map_err(|error| error.to_string())??;
    if let (Some(context), Some(pending)) = (display_store_context, pending_display_store) {
        if !pending.is_empty() {
            tauri::async_runtime::spawn_blocking(move || {
                store_persistent_display_tiles(context, pending);
            });
        }
    }
    let response_bytes = bytes.len();
    let command_us = command_started.elapsed().as_micros();
    if contact_tile_perf_logging_enabled() {
        emit_contact_tile_perf_line(&contact_tile_binary_command_perf_line(
            ContactTileBinaryCommandPerfContext {
                scenario: purpose.scenario_key(),
                request_id,
                generation,
                target_resolution,
                requested_tiles,
                returned_tiles,
                response_cells,
                response_bytes,
                command_us,
            },
        ));
        emit_contact_tile_perf_line(&format!(
            "CSTUDIO_PERF event=contact_display_cache status=lookup transport=binary scenario={} request_id={} generation={} target_resolution={} requested_tiles={} hits={} misses={} corrupt={} read_us={} command_us={}",
            purpose.scenario_key(),
            request_id,
            generation,
            target_resolution,
            requested_tiles,
            display_cache_stats.hits,
            display_cache_stats.misses,
            display_cache_stats.corrupt,
            display_cache_stats.read.as_micros(),
            command_us,
        ));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn stream_contact_map_tiles_from_cool_binary_v1(
    request: ContactMapTilesFromCoolRequest,
    chunks: Vec<Vec<ContactMapTileKeyRequest>>,
    on_chunk: tauri::ipc::Channel<tauri::ipc::Response>,
    layout_registry_state: tauri::State<'_, ContactLayoutRegistryState>,
    source_cache_state: tauri::State<'_, SourceContactCacheState>,
    tile_cache_state: tauri::State<'_, ContactTileCacheState>,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<(), String> {
    let command_started = Instant::now();
    let request = resolve_contact_tile_request(request, Some(layout_registry_state.inner()))?;
    // Validate the complete plan before generation registration or cache mutation.
    // The frontend orders these chunks from the viewport center outwards; retain
    // that order so the first useful tiles can be painted before outer tiles are
    // even computed.
    let chunks = validate_contact_tile_stream_chunks(&request.tiles, &chunks)?;
    let request_id = request.request_id;
    let generation = request.generation;
    let purpose = request.purpose;
    let target_resolution = request.target_resolution;
    let tile_size_bins = request.tile_size_bins;
    let requested_tiles = request.tiles.len();
    request_state.register_for_purpose(request_id, generation, purpose)?;
    let _request_guard = ContactTileRequestGuard {
        state: request_state.inner().clone(),
        request_id,
    };
    let source_cache = Arc::clone(&source_cache_state.inner().cache);
    let tile_cache = Arc::clone(&tile_cache_state.inner().cache);
    let task_request_state = request_state.inner().clone();
    let (returned_tiles, response_cells, response_bytes) =
        tauri::async_runtime::spawn_blocking(move || {
            let should_cancel = || task_request_state.is_cancelled(request_id);
            compute_contact_tile_chunks_progressively(
                request,
                &chunks,
                source_cache.as_ref(),
                tile_cache.as_ref(),
                &should_cancel,
                command_started,
                |chunk| {
                    let bytes =
                        encode_contact_map_tiles_binary_v1(chunk, tile_size_bins, &should_cancel)?;
                    let response_bytes = bytes.len();
                    on_chunk
                        .send(tauri::ipc::Response::new(bytes))
                        .map_err(|error| error.to_string())?;
                    Ok(response_bytes)
                },
            )
        })
        .await
        .map_err(|error| error.to_string())??;
    let command_us = command_started.elapsed().as_micros();
    if contact_tile_perf_logging_enabled() {
        eprintln!(
            "{}",
            contact_tile_binary_command_perf_line(ContactTileBinaryCommandPerfContext {
                scenario: purpose.scenario_key(),
                request_id,
                generation,
                target_resolution,
                requested_tiles,
                returned_tiles,
                response_cells,
                response_bytes,
                command_us,
            })
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Default)]
struct PersistentDisplayCacheLookupStats {
    hits: usize,
    misses: usize,
    corrupt: usize,
    read: Duration,
}

#[derive(Debug)]
struct PendingDisplayCacheStore {
    key: Vec<u8>,
    tile: DisplayCacheTile,
}

struct DisplayTileBuild {
    counts: Vec<f64>,
    occupied: Vec<u8>,
}

struct PersistentDisplayTileAccumulator {
    tile_size_bins: u64,
    tiles: BTreeMap<(u64, u64), DisplayTileBuild>,
}

impl PersistentDisplayTileAccumulator {
    fn new(tile_size_bins: u64, plans: &[PersistentDisplayTilePlan]) -> Result<Self, String> {
        let tile_size = usize::try_from(tile_size_bins)
            .map_err(|_| "display cache tile size exceeds platform range".to_string())?;
        let cell_count = tile_size
            .checked_mul(tile_size)
            .ok_or_else(|| "display cache tile cell count overflowed".to_string())?;
        let tiles = plans
            .iter()
            .map(|plan| {
                (
                    (plan.tile_x, plan.tile_y),
                    DisplayTileBuild {
                        counts: vec![0.0; cell_count],
                        occupied: vec![0; cell_count],
                    },
                )
            })
            .collect();
        Ok(Self {
            tile_size_bins,
            tiles,
        })
    }

    fn merge(&mut self, deltas: &[ContactMapTileResponse]) -> Result<(), String> {
        let tile_size = usize::try_from(self.tile_size_bins)
            .map_err(|_| "display cache tile size exceeds platform range".to_string())?;
        for delta in deltas {
            let coordinate = if delta.tile_x <= delta.tile_y {
                (delta.tile_x, delta.tile_y)
            } else {
                (delta.tile_y, delta.tile_x)
            };
            let Some(target) = self.tiles.get_mut(&coordinate) else {
                return Err(format!(
                    "display cache delta contains unrequested tile {}:{}",
                    coordinate.0, coordinate.1
                ));
            };
            let origin_x = coordinate
                .0
                .checked_mul(self.tile_size_bins)
                .ok_or_else(|| "display cache tile X origin overflowed".to_string())?;
            let origin_y = coordinate
                .1
                .checked_mul(self.tile_size_bins)
                .ok_or_else(|| "display cache tile Y origin overflowed".to_string())?;
            for cell in &delta.cells {
                let x_local = cell
                    .x_bin
                    .checked_sub(origin_x)
                    .ok_or_else(|| "display cache cell is before tile X origin".to_string())?;
                let y_local = cell
                    .y_bin
                    .checked_sub(origin_y)
                    .ok_or_else(|| "display cache cell is before tile Y origin".to_string())?;
                if x_local >= self.tile_size_bins || y_local >= self.tile_size_bins {
                    return Err("display cache cell is outside its tile".to_string());
                }
                let index = usize::try_from(y_local)
                    .ok()
                    .and_then(|y| y.checked_mul(tile_size))
                    .and_then(|offset| {
                        usize::try_from(x_local)
                            .ok()
                            .and_then(|x| offset.checked_add(x))
                    })
                    .ok_or_else(|| "display cache cell index overflowed".to_string())?;
                if target.occupied[index] == 0 {
                    target.occupied[index] = 1;
                }
                target.counts[index] += cell.count;
            }
        }
        Ok(())
    }

    fn finish(
        self,
        plans: &[PersistentDisplayTilePlan],
    ) -> Result<Vec<PendingDisplayCacheStore>, String> {
        let tile_size_bins = u32::try_from(self.tile_size_bins)
            .map_err(|_| "display cache tile size exceeds u32".to_string())?;
        let mut tiles = self.tiles;
        plans
            .iter()
            .map(|plan| {
                let built = tiles
                    .remove(&(plan.tile_x, plan.tile_y))
                    .ok_or_else(|| "display cache terminal tile is missing".to_string())?;
                let mut values = vec![-1.0_f32; built.counts.len()];
                for ((value, count), occupied) in values
                    .iter_mut()
                    .zip(built.counts.iter())
                    .zip(built.occupied.iter())
                {
                    if *occupied == 0 {
                        continue;
                    }
                    let display_value = *count as f32;
                    if !display_value.is_finite() || display_value == -1.0 {
                        return Err(format!(
                            "display cache tile {}:{} contains a value outside Float32 display range",
                            plan.tile_x, plan.tile_y
                        ));
                    }
                    *value = display_value;
                }
                Ok(PendingDisplayCacheStore {
                    key: plan.key.clone(),
                    tile: DisplayCacheTile {
                        tile_size_bins,
                        tile_x: plan.tile_x,
                        tile_y: plan.tile_y,
                        values: DisplayCacheValues::Float32(values),
                    },
                })
            })
            .collect()
    }
}

fn pending_display_tiles_from_complete_tiles(
    tile_size_bins: u64,
    plans: &[PersistentDisplayTilePlan],
    tiles: &[ContactMapTileResponse],
) -> Result<Vec<PendingDisplayCacheStore>, String> {
    let mut accumulator = PersistentDisplayTileAccumulator::new(tile_size_bins, plans)?;
    accumulator.merge(tiles)?;
    accumulator.finish(plans)
}

fn ordered_persistent_display_tiles(
    plans: &[PersistentDisplayTilePlan],
    cached_tiles: Vec<DisplayCacheTile>,
    pending: &[PendingDisplayCacheStore],
) -> Result<Vec<DisplayCacheTile>, String> {
    let mut tiles = cached_tiles
        .into_iter()
        .map(|tile| ((tile.tile_x, tile.tile_y), tile))
        .collect::<BTreeMap<_, _>>();
    for entry in pending {
        let coordinate = (entry.tile.tile_x, entry.tile.tile_y);
        if tiles.insert(coordinate, entry.tile.clone()).is_some() {
            return Err(format!(
                "display cache produced duplicate terminal tile {}:{}",
                coordinate.0, coordinate.1,
            ));
        }
    }
    plans
        .iter()
        .map(|plan| {
            tiles.remove(&(plan.tile_x, plan.tile_y)).ok_or_else(|| {
                format!(
                    "display cache terminal response is missing tile {}:{}",
                    plan.tile_x, plan.tile_y,
                )
            })
        })
        .collect()
}

fn display_tile_occupied_cells(tile: &DisplayCacheTile) -> usize {
    tile.occupied_count()
}

fn load_persistent_display_tiles(
    context: &PersistentDisplayCacheContext,
    request: &ResolvedContactMapTilesFromCoolRequest,
    plans: Vec<PersistentDisplayTilePlan>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<
    (
        Vec<DisplayCacheTile>,
        Vec<PersistentDisplayTilePlan>,
        PersistentDisplayCacheLookupStats,
    ),
    String,
> {
    let started = Instant::now();
    let mut cached_tiles = Vec::new();
    let mut missing_plans = Vec::new();
    let mut stats = PersistentDisplayCacheLookupStats::default();
    for plan in plans {
        ensure_contact_tile_request_active(should_cancel)?;
        match contact_display_cache::load(&context.dataset_root, &plan.key) {
            Ok(Some(cached)) => {
                if u64::from(cached.tile_size_bins) == request.tile_size_bins
                    && cached.tile_x == plan.tile_x
                    && cached.tile_y == plan.tile_y
                {
                    stats.hits = stats.hits.saturating_add(1);
                    cached_tiles.push(cached);
                    continue;
                }
                stats.corrupt = stats.corrupt.saturating_add(1);
                if contact_tile_perf_logging_enabled() {
                    eprintln!(
                        "CSTUDIO_PERF event=contact_display_cache status=corrupt tile_x={} tile_y={} error=display cache tile identity mismatch",
                        plan.tile_x, plan.tile_y,
                    );
                }
            }
            Ok(None) => {}
            Err(error) => {
                stats.corrupt = stats.corrupt.saturating_add(1);
                if contact_tile_perf_logging_enabled() {
                    eprintln!(
                        "CSTUDIO_PERF event=contact_display_cache status=corrupt tile_x={} tile_y={} error={error}",
                        plan.tile_x, plan.tile_y,
                    );
                }
            }
        }
        let _ = contact_display_cache::remove_entry(&context.dataset_root, &plan.key);
        stats.misses = stats.misses.saturating_add(1);
        missing_plans.push(plan);
    }
    stats.read = started.elapsed();
    Ok((cached_tiles, missing_plans, stats))
}

fn store_persistent_display_tiles(
    context: PersistentDisplayCacheContext,
    pending: Vec<PendingDisplayCacheStore>,
) {
    let started = Instant::now();
    let mut stored = 0_usize;
    let mut stored_bytes = 0_u64;
    let mut failed = 0_usize;
    for entry in pending {
        match contact_display_cache::store_atomic_with_format(
            &context.dataset_root,
            &entry.key,
            &entry.tile,
            persistent_display_cache_storage_format(),
        ) {
            Ok(path) => {
                stored = stored.saturating_add(1);
                stored_bytes = stored_bytes
                    .saturating_add(fs::metadata(path).map_or(0, |metadata| metadata.len()));
            }
            Err(error) => {
                failed = failed.saturating_add(1);
                if contact_tile_perf_logging_enabled() {
                    eprintln!(
                        "CSTUDIO_PERF event=contact_display_cache status=store_failed tile_x={} tile_y={} error={error}",
                        entry.tile.tile_x, entry.tile.tile_y,
                    );
                }
            }
        }
    }
    let dataset_prune = contact_display_cache::prune_tree(
        &context.dataset_root,
        persistent_display_cache_dataset_budget_bytes(),
        DISPLAY_CACHE_MAX_DATASET_ENTRIES,
    );
    let global_prune = contact_display_cache::prune_tree(
        &context.global_root,
        persistent_display_cache_global_budget_bytes(),
        DISPLAY_CACHE_MAX_GLOBAL_ENTRIES,
    );
    if contact_tile_perf_logging_enabled() {
        eprintln!(
            "CSTUDIO_PERF event=contact_display_cache status=stored tiles={} bytes={} failed={} write_us={} dataset_pruned_entries={} dataset_pruned_bytes={} global_pruned_entries={} global_pruned_bytes={}",
            stored,
            stored_bytes,
            failed,
            started.elapsed().as_micros(),
            dataset_prune.as_ref().map_or(0, |stats| stats.removed_entries),
            dataset_prune.as_ref().map_or(0, |stats| stats.removed_bytes),
            global_prune.as_ref().map_or(0, |stats| stats.removed_entries),
            global_prune.as_ref().map_or(0, |stats| stats.removed_bytes),
        );
        if let Err(error) = dataset_prune {
            eprintln!(
                "CSTUDIO_PERF event=contact_display_cache status=dataset_prune_failed error={error}"
            );
        }
        if let Err(error) = global_prune {
            eprintln!(
                "CSTUDIO_PERF event=contact_display_cache status=global_prune_failed error={error}"
            );
        }
    }
}

#[tauri::command]
pub async fn stream_contact_map_tile_deltas_from_cool_binary_v1(
    request: ContactMapTilesFromCoolRequest,
    on_chunk: tauri::ipc::Channel<tauri::ipc::Response>,
    app_handle: tauri::AppHandle,
    layout_registry_state: tauri::State<'_, ContactLayoutRegistryState>,
    request_state: tauri::State<'_, ContactTileRequestState>,
) -> Result<(), String> {
    let command_started = Instant::now();
    let request = resolve_contact_tile_request(request, Some(layout_registry_state.inner()))?;
    let request_id = request.request_id;
    let generation = request.generation;
    let purpose = request.purpose;
    let target_resolution = request.target_resolution;
    let tile_size_bins = request.tile_size_bins;
    let requested_tiles = request.tiles.len();
    request_state.register_for_purpose(request_id, generation, purpose)?;
    let _request_guard = ContactTileRequestGuard {
        state: request_state.inner().clone(),
        request_id,
    };
    let task_request_state = request_state.inner().clone();
    let display_cache_context = persistent_display_cache_context(&app_handle, &request)?;
    let display_cache_plans = display_cache_context
        .as_ref()
        .map(|context| persistent_display_tile_plans(context, &request))
        .transpose()?
        .unwrap_or_default();
    let display_store_context = display_cache_context.clone();
    let (stats, display_cache_stats, pending_display_store) =
        tauri::async_runtime::spawn_blocking(move || {
            let should_cancel = || task_request_state.is_cancelled(request_id);
            let (cached_tiles, missing_plans, display_cache_stats) =
                if let Some(context) = display_cache_context.as_ref() {
                    load_persistent_display_tiles(
                        context,
                        &request,
                        display_cache_plans,
                        &should_cancel,
                    )?
                } else {
                    (
                        Vec::new(),
                        Vec::new(),
                        PersistentDisplayCacheLookupStats::default(),
                    )
                };
            ensure_contact_tile_request_active(&should_cancel)?;

            let mut cached_emitted_chunks = 0_usize;
            let mut cached_response_cells = 0_usize;
            let mut cached_response_bytes = 0_usize;
            let mut cached_encode_send = Duration::ZERO;
            let mut cached_first_emit_us = None;
            if !cached_tiles.is_empty() {
                cached_response_cells = cached_tiles
                    .iter()
                    .map(DisplayCacheTile::occupied_count)
                    .sum();
                let emit_started = Instant::now();
                let bytes = encode_contact_map_dense_tiles_binary_v1(
                    &cached_tiles,
                    tile_size_bins,
                    &should_cancel,
                )?;
                cached_response_bytes = bytes.len();
                on_chunk
                    .send(tauri::ipc::Response::new(bytes))
                    .map_err(|error| error.to_string())?;
                cached_encode_send = emit_started.elapsed();
                cached_emitted_chunks = 1;
                cached_first_emit_us = Some(command_started.elapsed().as_micros());
            }

            let cache_enabled = display_cache_context.is_some();
            let mut compute_request = request;
            let mut accumulator = if cache_enabled {
                compute_request.tiles = missing_plans
                    .iter()
                    .map(|plan| ContactMapTileKeyRequest {
                        tile_x: plan.tile_x,
                        tile_y: plan.tile_y,
                    })
                    .collect();
                Some(PersistentDisplayTileAccumulator::new(
                    tile_size_bins,
                    &missing_plans,
                )?)
            } else {
                None
            };

            let mut stats = if compute_request.tiles.is_empty() {
                let emit_started = Instant::now();
                let bytes =
                    encode_contact_map_tiles_binary_v1(&[], tile_size_bins, &should_cancel)?;
                cached_response_bytes = cached_response_bytes.saturating_add(bytes.len());
                on_chunk
                    .send(tauri::ipc::Response::new(bytes))
                    .map_err(|error| error.to_string())?;
                cached_encode_send += emit_started.elapsed();
                ContactTileDeltaStreamStats::default()
            } else {
                compute_contact_tile_deltas_single_scan(compute_request, &should_cancel, |tiles| {
                    if !tiles.is_empty() {
                        if let Some(accumulator) = accumulator.as_mut() {
                            accumulator.merge(tiles)?;
                        }
                    }
                    let bytes =
                        encode_contact_map_tiles_binary_v1(tiles, tile_size_bins, &should_cancel)?;
                    let byte_len = bytes.len();
                    on_chunk
                        .send(tauri::ipc::Response::new(bytes))
                        .map_err(|error| error.to_string())?;
                    Ok(byte_len)
                })?
            };
            stats.emitted_chunks = stats.emitted_chunks.saturating_add(cached_emitted_chunks);
            stats.response_cells = stats.response_cells.saturating_add(cached_response_cells);
            stats.response_bytes = stats.response_bytes.saturating_add(cached_response_bytes);
            stats.encode_send += cached_encode_send;
            if cached_first_emit_us.is_some() {
                stats.first_emit_us = cached_first_emit_us;
            } else if let Some(first_emit_us) = stats.first_emit_us.as_mut() {
                *first_emit_us = first_emit_us.saturating_add(display_cache_stats.read.as_micros());
            }
            let pending_display_store = accumulator
                .map(|accumulator| accumulator.finish(&missing_plans))
                .transpose()?;
            Ok::<_, String>((stats, display_cache_stats, pending_display_store))
        })
        .await
        .map_err(|error| error.to_string())??;

    if let (Some(context), Some(pending)) = (display_store_context, pending_display_store) {
        if !pending.is_empty() {
            tauri::async_runtime::spawn_blocking(move || {
                store_persistent_display_tiles(context, pending);
            });
        }
    }

    if contact_tile_perf_logging_enabled() {
        emit_contact_tile_perf_line(&format!(
            "CSTUDIO_PERF event=contact_tile_delta_stream status=ok scenario={} request_id={} \
             generation={} target_resolution={} requested_tiles={} emitted_chunks={} \
             response_cells={} response_bytes={} display_cache_hits={} display_cache_misses={} \
             display_cache_corrupt={} display_cache_read_us={} indexed_visitor={} first_emit_cell_threshold={} \
             emit_cell_threshold={} \
             hdf5_chunks={} scanned_pixels={} visited_contacts={} prepare_us={} \
             hdf5_read_us={} scan_project_us={} finish_chunk_us={} encode_send_us={} \
             first_emit_us={} command_us={}",
            purpose.scenario_key(),
            request_id,
            generation,
            target_resolution,
            requested_tiles,
            stats.emitted_chunks,
            stats.response_cells,
            stats.response_bytes,
            display_cache_stats.hits,
            display_cache_stats.misses,
            display_cache_stats.corrupt,
            display_cache_stats.read.as_micros(),
            stats.indexed_visitor,
            stats.first_emit_cell_threshold,
            stats.emit_cell_threshold,
            stats.visit_timings.hdf5_chunks,
            stats.visit_timings.scanned_pixels,
            stats.visited_contacts,
            stats.visit_timings.prepare.as_micros(),
            stats.visit_timings.hdf5_read.as_micros(),
            stats.visit_timings.scan_project.as_micros(),
            stats.visit_timings.finish_chunk.as_micros(),
            stats.encode_send.as_micros(),
            stats.first_emit_us.unwrap_or(0),
            command_started.elapsed().as_micros(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ContactTileDeltaStreamStats {
    emitted_chunks: usize,
    response_cells: usize,
    response_bytes: usize,
    visited_contacts: usize,
    first_emit_us: Option<u128>,
    indexed_visitor: bool,
    first_emit_cell_threshold: usize,
    emit_cell_threshold: usize,
    visit_timings: cstudio_core::cool::CoolContactVisitTimings,
    encode_send: Duration,
}

const DEFAULT_CONTACT_TILE_DELTA_EMIT_CELL_THRESHOLD: usize = 32_768;
// Source-resolution LOD projection can revisit the same target cell across
// many HDF5 chunks. After the immediate first patch, aggregate the remaining
// work into one large update to avoid repeatedly shipping cumulative tiles.
const DEFAULT_CONTACT_TILE_DELTA_LOD_EMIT_CELL_THRESHOLD: usize = 1_048_576;
// The first non-empty HDF5 chunk should become visible immediately. This adds
// at most one small IPC message because subsequent chunks return to the steady
// aggregation threshold below.
const DEFAULT_CONTACT_TILE_DELTA_FIRST_EMIT_CELL_THRESHOLD: usize = 1;

fn contact_tile_delta_indexed_visitor_enabled() -> bool {
    std::env::var("CSTUDIO_CONTACT_DELTA_INDEXED").as_deref() != Ok("0")
}

fn contact_tile_delta_emit_cell_threshold() -> usize {
    std::env::var("CSTUDIO_CONTACT_DELTA_EMIT_CELLS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=1_048_576).contains(value))
        .unwrap_or(DEFAULT_CONTACT_TILE_DELTA_EMIT_CELL_THRESHOLD)
}

fn contact_tile_delta_lod_emit_cell_threshold() -> usize {
    std::env::var("CSTUDIO_CONTACT_DELTA_LOD_EMIT_CELLS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=1_048_576).contains(value))
        .unwrap_or(DEFAULT_CONTACT_TILE_DELTA_LOD_EMIT_CELL_THRESHOLD)
}

fn contact_tile_delta_first_emit_cell_threshold(emit_cell_threshold: usize) -> usize {
    std::env::var("CSTUDIO_CONTACT_DELTA_FIRST_EMIT_CELLS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=1_048_576).contains(value))
        .unwrap_or(DEFAULT_CONTACT_TILE_DELTA_FIRST_EMIT_CELL_THRESHOLD)
        .min(emit_cell_threshold)
}

fn contact_tile_delta_flush_threshold(
    has_emitted: bool,
    first_emit_cell_threshold: usize,
    emit_cell_threshold: usize,
) -> usize {
    if has_emitted {
        emit_cell_threshold
    } else {
        first_emit_cell_threshold
    }
}

fn compute_contact_tile_deltas_single_scan<F>(
    request: ResolvedContactMapTilesFromCoolRequest,
    should_cancel: &dyn Fn() -> bool,
    mut emit_chunk: F,
) -> Result<ContactTileDeltaStreamStats, String>
where
    F: FnMut(&[ContactMapTileResponse]) -> Result<usize, String>,
{
    ensure_contact_tile_request_active(should_cancel)?;
    if request.tiles.is_empty() {
        return Err("contact tile delta stream requires at least one tile".to_string());
    }
    let adaptive_requested = adaptive_mcool_refinement_requested(&request, &request.tiles);
    if adaptive_requested {
        return Err(
            "single-scan delta stream is unavailable for adaptive 2.5 Mb mcool refinement"
                .to_string(),
        );
    }

    let requested_tiles = request
        .tiles
        .iter()
        .map(canonical_contact_tile_coordinate)
        .collect::<BTreeSet<_>>();
    let tile_span = request
        .tile_size_bins
        .saturating_mul(request.target_resolution);
    let min_tile_x = requested_tiles.iter().map(|key| key.0).min().unwrap_or(0);
    let max_tile_x = requested_tiles
        .iter()
        .map(|key| key.0)
        .max()
        .unwrap_or(min_tile_x);
    let min_tile_y = requested_tiles.iter().map(|key| key.1).min().unwrap_or(0);
    let max_tile_y = requested_tiles
        .iter()
        .map(|key| key.1)
        .max()
        .unwrap_or(min_tile_y);
    let viewport = ContactMapViewportRequest {
        x_start: min_tile_x.saturating_mul(tile_span),
        x_end: max_tile_x.saturating_add(1).saturating_mul(tile_span),
        y_start: min_tile_y.saturating_mul(tile_span),
        y_end: max_tile_y.saturating_add(1).saturating_mul(tile_span),
    };
    let source_ranges = source_ranges_for_contact_viewport(&viewport, &request.layout_blocks);
    let query = contact_map_query_from_parts(
        request.base_resolution,
        request.target_resolution,
        viewport,
        request.layout_blocks.as_ref().clone(),
    )?;
    let projector = RefCell::new(
        cstudio_core::contact_map::ContactMapChunkProjector::new_for_tiles(
            &query,
            request.tile_size_bins,
            requested_tiles.iter().copied(),
        )
        .map_err(|error| error.to_string())?,
    );
    let stats = RefCell::new(ContactTileDeltaStreamStats::default());
    let stream_started = Instant::now();
    let indexed_visitor = contact_tile_delta_indexed_visitor_enabled();
    let source_resolution = request
        .source_resolution
        .unwrap_or(request.target_resolution);
    if source_resolution == 0 || request.target_resolution % source_resolution != 0 {
        return Err(format!(
            "contact tile delta source resolution {} must divide target resolution {}",
            source_resolution, request.target_resolution,
        ));
    }
    let emit_cell_threshold = if request.source_resolution.is_some() {
        contact_tile_delta_lod_emit_cell_threshold()
    } else {
        contact_tile_delta_emit_cell_threshold()
    };
    let first_emit_cell_threshold =
        contact_tile_delta_first_emit_cell_threshold(emit_cell_threshold);
    let mut flush_projected_delta = || -> cstudio_core::CStudioResult<()> {
        let view = projector.borrow_mut().take_view();
        if view.cells.is_empty() {
            return Ok(());
        }
        let mut tiles = contact_map_tiles_from_view_cancellable(
            view,
            request.tile_size_bins,
            &requested_tiles,
            should_cancel,
        )
        .map_err(cstudio_core::CStudioError::InvalidContactMapQuery)?;
        tiles.retain(|tile| !tile.cells.is_empty());
        if tiles.is_empty() {
            return Ok(());
        }
        let response_cells = tiles.iter().map(|tile| tile.cells.len()).sum::<usize>();
        let emit_started = Instant::now();
        let response_bytes =
            emit_chunk(&tiles).map_err(cstudio_core::CStudioError::InvalidContactMapQuery)?;
        let encode_send = emit_started.elapsed();
        let mut current = stats.borrow_mut();
        if current.first_emit_us.is_none() {
            current.first_emit_us = Some(stream_started.elapsed().as_micros());
        }
        current.emitted_chunks = current.emitted_chunks.saturating_add(1);
        current.response_cells = current.response_cells.saturating_add(response_cells);
        current.response_bytes = current.response_bytes.saturating_add(response_bytes);
        current.encode_send += encode_send;
        Ok(())
    };

    let mut visit_timings = cstudio_core::cool::CoolContactVisitTimings::default();
    let visited_contacts = if indexed_visitor {
        cstudio_core::cool::visit_cool_contact_chunks_indexed_profiled_for_source_ranges_at_resolution_with_normalization_cancellable(
            &request.cool_path,
            &source_ranges,
            Some(source_resolution),
            request.normalization.into(),
            should_cancel,
            &mut visit_timings,
            |source1_index, source1, start1, source2_index, source2, start2, count| {
                projector.borrow_mut().push_indexed_contact(
                    source1_index,
                    source1,
                    start1,
                    source2_index,
                    source2,
                    start2,
                    count,
                );
                Ok(())
            },
            || {
                let threshold = contact_tile_delta_flush_threshold(
                    stats.borrow().first_emit_us.is_some(),
                    first_emit_cell_threshold,
                    emit_cell_threshold,
                );
                if projector.borrow().pending_cell_count() < threshold {
                    return Ok(());
                }
                flush_projected_delta()
            },
        )
    } else {
        cstudio_core::cool::visit_cool_contact_chunks_profiled_for_source_ranges_at_resolution_with_normalization_cancellable(
            &request.cool_path,
            &source_ranges,
            Some(source_resolution),
            request.normalization.into(),
            should_cancel,
            &mut visit_timings,
            |source1, start1, source2, start2, count| {
                projector
                    .borrow_mut()
                    .push_contact(source1, start1, source2, start2, count);
                Ok(())
            },
            || {
                let threshold = contact_tile_delta_flush_threshold(
                    stats.borrow().first_emit_us.is_some(),
                    first_emit_cell_threshold,
                    emit_cell_threshold,
                );
                if projector.borrow().pending_cell_count() < threshold {
                    return Ok(());
                }
                flush_projected_delta()
            },
        )
    }
    .map_err(|error| error.to_string())?;

    ensure_contact_tile_request_active(should_cancel)?;
    flush_projected_delta().map_err(|error| error.to_string())?;
    drop(flush_projected_delta);
    // An empty CST1 response is the explicit end-of-stream marker. Requested
    // empty tiles are materialized by the frontend accumulator at this point.
    let final_emit_started = Instant::now();
    let final_bytes = emit_chunk(&[])?;
    let final_encode_send = final_emit_started.elapsed();
    let mut stats = stats.into_inner();
    stats.response_bytes = stats.response_bytes.saturating_add(final_bytes);
    stats.encode_send += final_encode_send;
    stats.visited_contacts = visited_contacts;
    stats.indexed_visitor = indexed_visitor;
    stats.first_emit_cell_threshold = first_emit_cell_threshold;
    stats.emit_cell_threshold = emit_cell_threshold;
    stats.visit_timings = visit_timings;
    Ok(stats)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ContactTileProgressiveStats {
    returned_tiles: usize,
    response_cells: usize,
    response_bytes: usize,
}

fn compute_contact_tile_chunks_progressively<F>(
    request: ResolvedContactMapTilesFromCoolRequest,
    chunks: &[Vec<ContactMapTileKeyRequest>],
    source_cache: &Mutex<SourceContactCache>,
    tile_cache: &Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>,
    should_cancel: &dyn Fn() -> bool,
    command_started: Instant,
    mut emit_chunk: F,
) -> Result<(usize, usize, usize), String>
where
    F: FnMut(&[ContactMapTileResponse]) -> Result<usize, String>,
{
    let mut stats = ContactTileProgressiveStats::default();
    if request.source_resolution.is_some() {
        // Screen-scale LOD tiles all derive from one stored Cooler level. Scan
        // and project the complete visible tile set once, then serialize the
        // already-computed tiles in the frontend's center-first chunk order.
        // This preserves reusable tile identities without paying one HDF5 scan
        // per two-tile presentation batch.
        let (tiles, timings) =
            profile_contact_tile_request(request.clone(), source_cache, tile_cache, should_cancel);
        let ordered_chunks = contact_tile_response_chunks(tiles?, chunks)?;
        if contact_tile_perf_logging_enabled() {
            eprintln!(
                "{}",
                timings.line(ContactTilePerfContext {
                    scenario: request.purpose.scenario_key(),
                    request_id: request.request_id,
                    generation: request.generation,
                    base_resolution: request.base_resolution,
                    target_resolution: request.target_resolution,
                    tile_size_bins: request.tile_size_bins,
                    normalization: request.normalization,
                    layout_blocks: request.layout_blocks.len(),
                    requested_tiles: request.tiles.len(),
                    returned_tiles: ordered_chunks.iter().map(Vec::len).sum(),
                })
            );
        }
        for (chunk_offset, ordered_tiles) in ordered_chunks.iter().enumerate() {
            ensure_contact_tile_request_active(should_cancel)?;
            let response_cells = ordered_tiles
                .iter()
                .map(|tile| tile.cells.len())
                .sum::<usize>();
            let emit_started = Instant::now();
            let response_bytes = emit_chunk(ordered_tiles)?;
            let encode_send_us = emit_started.elapsed().as_micros();
            stats.returned_tiles = stats.returned_tiles.saturating_add(ordered_tiles.len());
            stats.response_cells = stats.response_cells.saturating_add(response_cells);
            stats.response_bytes = stats.response_bytes.saturating_add(response_bytes);
            if contact_tile_perf_logging_enabled() {
                eprintln!(
                    "{}",
                    contact_tile_progressive_chunk_perf_line(
                        ContactTileProgressiveChunkPerfContext {
                            scenario: request.purpose.scenario_key(),
                            request_id: request.request_id,
                            generation: request.generation,
                            target_resolution: request.target_resolution,
                            chunk_index: chunk_offset + 1,
                            chunk_count: chunks.len(),
                            requested_tiles: ordered_tiles.len(),
                            returned_tiles: ordered_tiles.len(),
                            response_cells,
                            response_bytes,
                            compute_us: if chunk_offset == 0 {
                                timings.total.get().as_micros()
                            } else {
                                0
                            },
                            encode_send_us,
                            elapsed_us: command_started.elapsed().as_micros(),
                        },
                    )
                );
            }
        }
        return Ok((
            stats.returned_tiles,
            stats.response_cells,
            stats.response_bytes,
        ));
    }
    for (chunk_offset, chunk) in chunks.iter().enumerate() {
        ensure_contact_tile_request_active(should_cancel)?;
        let chunk_started = Instant::now();
        let mut chunk_request = request.clone();
        chunk_request.tiles = chunk.clone();
        let (tiles, timings) =
            profile_contact_tile_request(chunk_request, source_cache, tile_cache, should_cancel);
        let tiles = tiles?;
        let mut ordered_chunks = contact_tile_response_chunks(tiles, std::slice::from_ref(chunk))?;
        let ordered_tiles = ordered_chunks
            .pop()
            .expect("validated non-empty stream chunk produces one response chunk");
        let response_cells = ordered_tiles
            .iter()
            .map(|tile| tile.cells.len())
            .sum::<usize>();
        let compute_us = timings.total.get().as_micros();

        ensure_contact_tile_request_active(should_cancel)?;
        let emit_started = Instant::now();
        let response_bytes = emit_chunk(&ordered_tiles)?;
        let encode_send_us = emit_started.elapsed().as_micros();

        stats.returned_tiles = stats.returned_tiles.saturating_add(ordered_tiles.len());
        stats.response_cells = stats.response_cells.saturating_add(response_cells);
        stats.response_bytes = stats.response_bytes.saturating_add(response_bytes);
        if contact_tile_perf_logging_enabled() {
            eprintln!(
                "{}",
                contact_tile_progressive_chunk_perf_line(ContactTileProgressiveChunkPerfContext {
                    scenario: request.purpose.scenario_key(),
                    request_id: request.request_id,
                    generation: request.generation,
                    target_resolution: request.target_resolution,
                    chunk_index: chunk_offset + 1,
                    chunk_count: chunks.len(),
                    requested_tiles: chunk.len(),
                    returned_tiles: ordered_tiles.len(),
                    response_cells,
                    response_bytes,
                    compute_us,
                    encode_send_us,
                    elapsed_us: command_started.elapsed().as_micros(),
                },)
            );
        }
        debug_assert!(chunk_started.elapsed().as_micros() >= compute_us);
    }
    Ok((
        stats.returned_tiles,
        stats.response_cells,
        stats.response_bytes,
    ))
}

fn validate_contact_tile_stream_chunks(
    requested_tiles: &[ContactMapTileKeyRequest],
    chunks: &[Vec<ContactMapTileKeyRequest>],
) -> Result<Vec<Vec<ContactMapTileKeyRequest>>, String> {
    let expected = requested_tiles
        .iter()
        .map(canonical_contact_tile_coordinate)
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut validated = Vec::with_capacity(chunks.len());

    for chunk in chunks {
        if chunk.is_empty() {
            continue;
        }
        let mut validated_chunk = Vec::with_capacity(chunk.len());
        for tile in chunk {
            let key = canonical_contact_tile_coordinate(tile);
            if !expected.contains(&key) {
                return Err(format!(
                    "contact tile stream chunk contains unrequested response {}:{}",
                    key.0, key.1
                ));
            }
            if !seen.insert(key) {
                return Err(format!(
                    "contact tile stream chunks duplicate response {}:{}",
                    key.0, key.1
                ));
            }
            validated_chunk.push(ContactMapTileKeyRequest {
                tile_x: key.0,
                tile_y: key.1,
            });
        }
        validated.push(validated_chunk);
    }

    if let Some(key) = expected.difference(&seen).next() {
        return Err(format!(
            "contact tile stream chunks omitted response {}:{}",
            key.0, key.1
        ));
    }
    Ok(validated)
}

fn canonical_contact_tile_coordinate(tile: &ContactMapTileKeyRequest) -> (u64, u64) {
    (tile.tile_x.min(tile.tile_y), tile.tile_x.max(tile.tile_y))
}

fn contact_tile_response_chunks(
    tiles: Vec<ContactMapTileResponse>,
    chunks: &[Vec<ContactMapTileKeyRequest>],
) -> Result<Vec<Vec<ContactMapTileResponse>>, String> {
    let mut tiles_by_key = tiles
        .into_iter()
        .map(|tile| {
            (
                canonical_contact_tile_coordinate(&ContactMapTileKeyRequest {
                    tile_x: tile.tile_x,
                    tile_y: tile.tile_y,
                }),
                tile,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut response_chunks = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        if chunk.is_empty() {
            continue;
        }
        let mut response_chunk = Vec::with_capacity(chunk.len());
        for tile in chunk {
            let key = canonical_contact_tile_coordinate(tile);
            let response = tiles_by_key.remove(&key).ok_or_else(|| {
                format!("contact tile stream response missing {}:{}", key.0, key.1)
            })?;
            response_chunk.push(response);
        }
        response_chunks.push(response_chunk);
    }
    if let Some((key, _)) = tiles_by_key.first_key_value() {
        return Err(format!(
            "contact tile stream chunks omitted response {}:{}",
            key.0, key.1
        ));
    }
    Ok(response_chunks)
}

#[cfg(test)]
fn get_contact_map_tiles_from_cool_with_cache(
    request: ContactMapTilesFromCoolRequest,
    source_cache: &Mutex<SourceContactCache>,
    tile_cache: &Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>,
) -> Result<Vec<ContactMapTileResponse>, String> {
    let request = resolve_contact_tile_request(request, None)?;
    get_contact_map_tiles_from_cool_with_cache_cancellable(
        request,
        source_cache,
        tile_cache,
        &|| false,
    )
}

fn get_contact_map_tiles_from_cool_with_cache_cancellable(
    request: ResolvedContactMapTilesFromCoolRequest,
    source_cache: &Mutex<SourceContactCache>,
    tile_cache: &Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<ContactMapTileResponse>, String> {
    let request_id = request.request_id;
    let generation = request.generation;
    let purpose = request.purpose;
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
                    scenario: purpose.scenario_key(),
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
    request: ResolvedContactMapTilesFromCoolRequest,
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
    mut request: ResolvedContactMapTilesFromCoolRequest,
    source_cache: &Mutex<SourceContactCache>,
    tile_cache: &Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>,
    should_cancel: &dyn Fn() -> bool,
    timings: &ContactTileStageTimings,
) -> Result<Vec<ContactMapTileResponse>, String> {
    let source_resolution = request
        .source_resolution
        .unwrap_or(request.target_resolution);
    if request.base_resolution == 0
        || source_resolution == 0
        || source_resolution % request.base_resolution != 0
        || request.target_resolution % source_resolution != 0
    {
        return Err(format!(
            "invalid contact tile source resolution: base={}, source={}, target={}",
            request.base_resolution, source_resolution, request.target_resolution,
        ));
    }
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
                source_resolution,
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
        return Ok(std::mem::take(&mut request.tiles)
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
    if work_regions.len() > 1
        && (request.source_resolution.is_none()
            || request.purpose != ContactTileRequestPurpose::Visible)
    {
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
        return Ok(std::mem::take(&mut request.tiles)
            .into_iter()
            .filter_map(|tile| cached_tiles.remove(&(tile.tile_x, tile.tile_y)))
            .collect());
    }

    let adaptive_requested = adaptive_mcool_refinement_requested(&request, &request.tiles);
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
            request.layout_blocks.as_ref().clone(),
        )?;
        // 180 windows produce 16,290 upper-triangle pairs. The next window would
        // exceed the 16,384-pair cache budget. Stop collecting at that point so a
        // deliberately wide or very fragmented viewport cannot first allocate a
        // huge source-window vector only to bypass the cache afterwards.
        const MAX_CACHE_WINDOWS_PER_REQUEST: usize = 180;
        let source_windows = if adaptive_requested || request.source_resolution.is_some() {
            None
        } else {
            source_windows_for_ranges_with_limit(
                &source_ranges,
                tile_span,
                MAX_CACHE_WINDOWS_PER_REQUEST,
            )
        };
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
                source_resolution,
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

    let cached_snapshot = if let Some(keys) = source_cache_keys.as_ref() {
        let mut source_cache = {
            let _stage = ContactTileStageSpan::new(&timings.source_cache);
            let source_cache = source_cache
                .lock()
                .map_err(|_| "source contact cache lock poisoned".to_string())?;
            source_cache
        };
        source_cache
            .snapshot_for_keys_cancellable(keys, should_cancel)
            .map_err(|error| error.to_string())?
    } else {
        None
    };
    let cached_view = if let Some(snapshot) = cached_snapshot {
        timings
            .source_hits
            .set(timings.source_hits.get().saturating_add(1));
        let _stage = ContactTileStageSpan::new(&timings.projection);
        Some(
            snapshot
                .build_view_cancellable(&query, should_cancel)
                .map_err(|error| error.to_string())?,
        )
    } else {
        if source_cache_keys.is_some() {
            timings
                .source_misses
                .set(timings.source_misses.get().saturating_add(1));
        }
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
        let tiled_lod_view = if request.source_resolution.is_some() {
            let x_bins = query
                .viewport
                .x_end
                .div_ceil(query.target_resolution)
                .saturating_sub(query.viewport.x_start / query.target_resolution);
            let y_bins = query
                .viewport
                .y_end
                .div_ceil(query.target_resolution)
                .saturating_sub(query.viewport.y_start / query.target_resolution);
            let aggregate_cell_bound = x_bins
                .checked_mul(y_bins)
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| "tiled LOD aggregate cell bound overflowed".to_string())?;
            if aggregate_cell_bound > MAX_CONTACT_OVERVIEW_AGGREGATE_CELLS as usize {
                return Err(format!(
                    "tiled LOD aggregate could contain {aggregate_cell_bound} cells, exceeding bounded aggregate limit {MAX_CONTACT_OVERVIEW_AGGREGATE_CELLS}"
                ));
            }
            let mut projector =
                cstudio_core::contact_map::ContactMapChunkProjector::new_for_bounded_view(
                    &query,
                    aggregate_cell_bound,
                )
                .map_err(|error| error.to_string())?;
            let mut visit_timings = cstudio_core::cool::CoolContactVisitTimings::default();
            timings
                .cool_reads
                .set(timings.cool_reads.get().saturating_add(1));
            cstudio_core::cool::visit_cool_contact_chunks_indexed_profiled_for_source_ranges_at_resolution_with_normalization_cancellable(
                &request.cool_path,
                &source_ranges,
                Some(source_resolution),
                request.normalization.into(),
                should_cancel,
                &mut visit_timings,
                |source1_index, source1, start1, source2_index, source2, start2, count| {
                    projector.push_indexed_contact(
                        source1_index,
                        source1,
                        start1,
                        source2_index,
                        source2,
                        start2,
                        count,
                    );
                    Ok(())
                },
                || Ok(()),
            )
            .map_err(|error| error.to_string())?;
            timings.cool_read.set(
                timings
                    .cool_read
                    .get()
                    .saturating_add(visit_timings.prepare + visit_timings.hdf5_read),
            );
            timings.projection.set(
                timings
                    .projection
                    .get()
                    .saturating_add(visit_timings.scan_project + visit_timings.finish_chunk),
            );
            Some(projector.take_view())
        } else {
            None
        };
        if let Some(tiled_lod_view) = tiled_lod_view {
            tiled_lod_view
        } else {
            let adaptive_result = if adaptive_requested {
                timings
                    .cool_reads
                    .set(timings.cool_reads.get().saturating_add(1));
                let _stage = ContactTileStageSpan::new(&timings.cool_read);
                cstudio_core::cool::build_contact_map_view_from_mcool_adaptive_raw_cancellable(
                    &request.cool_path,
                    &source_ranges,
                    &query,
                    should_cancel,
                )
                .map_err(|error| error.to_string())?
            } else {
                None
            };
            if let Some(adaptive_result) = adaptive_result {
                if contact_tile_perf_logging_enabled() {
                    eprintln!(
                        "CSTUDIO_PERF event=adaptive_mcool status=ok target_resolution={} \
                     candidate_pixels={} child_rows_read={} bin2_ids_scanned={} \
                     child_blocks_requested={} child_blocks_cached={}",
                        request.target_resolution,
                        adaptive_result.stats.candidate_pixels,
                        adaptive_result.stats.child_rows_read,
                        adaptive_result.stats.bin2_ids_scanned,
                        adaptive_result.stats.child_blocks_requested,
                        adaptive_result.stats.child_blocks_cached,
                    );
                }
                adaptive_result.view
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
                Some(source_resolution),
                request.normalization.into(),
                should_cancel,
            )
            .map_err(|error| error.to_string())?
                };
                ensure_contact_tile_request_active(should_cancel)?;

                let conventional_view = if let (Some(_keys), Some(source_windows)) =
                    (source_cache_keys.as_ref(), source_windows.as_ref())
                {
                    let prepared = {
                        let _stage = ContactTileStageSpan::new(&timings.source_cache);
                        SourceContactCache::prepare_contacts_for_windows_cancellable(
                            &source_cache_path,
                            request.target_resolution,
                            source_windows,
                            &contacts,
                            should_cancel,
                        )
                        .map_err(|error| error.to_string())?
                    };
                    {
                        let _stage = ContactTileStageSpan::new(&timings.source_cache);
                        let mut source_cache = source_cache
                            .lock()
                            .map_err(|_| "source contact cache lock poisoned".to_string())?;
                        source_cache
                            .insert_prepared_cancellable(prepared, should_cancel)
                            .map_err(|error| error.to_string())?;
                    }
                    ensure_contact_tile_request_active(should_cancel)?;
                    let _stage = ContactTileStageSpan::new(&timings.projection);
                    cstudio_core::contact_map::build_contact_map_view_from_contacts_cancellable(
                        &query,
                        contacts,
                        should_cancel,
                    )
                    .map_err(|error| error.to_string())?
                } else {
                    let _stage = ContactTileStageSpan::new(&timings.projection);
                    cstudio_core::contact_map::build_contact_map_view_from_contacts_cancellable(
                        &query,
                        contacts,
                        should_cancel,
                    )
                    .map_err(|error| error.to_string())?
                };
                conventional_view
            }
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
                    source_resolution,
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
    Ok(std::mem::take(&mut request.tiles)
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
    let mut source_shares_by_id = HashMap::<&str, Vec<(u64, u64)>>::new();
    for block in layout_blocks {
        if block.source_start < block.source_end {
            source_shares_by_id
                .entry(block.source_id.as_str())
                .or_default()
                .push((block.source_start, block.source_end));
        }
    }
    for source_shares in source_shares_by_id.values_mut() {
        source_shares.sort_unstable();
    }

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
            let mut source_shares = source_shares_by_id
                .get(block.source_id.as_str())
                .into_iter()
                .flatten()
                .filter(|(candidate_start, candidate_end)| {
                    *candidate_start < source_end && *candidate_end > source_start
                })
                .map(|(candidate_start, candidate_end)| {
                    (
                        (*candidate_start).max(source_start),
                        (*candidate_end).min(source_end),
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

    let mut records = Vec::new();

    for line in open_text_reader(Path::new(&request.bedgraph_path))?.lines() {
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
        available_resolutions: cstudio_core::cool::list_contact_resolutions(
            path.to_string_lossy().as_ref(),
        )
        .map_err(|error| error.to_string())?,
        sources: contact_sources_from_path(path)?,
    })
}

fn contact_sources_from_path(path: &Path) -> Result<Vec<ContactSourceMetadataResponse>, String> {
    cstudio_core::cool::list_contact_sources(path.to_string_lossy().as_ref())
        .map(|sources| {
            sources
                .into_iter()
                .map(|source| ContactSourceMetadataResponse {
                    name: source.name,
                    length: source.length,
                })
                .collect()
        })
        .map_err(|error| error.to_string())
}

fn lowercase_data_suffix(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn has_data_suffix(path: &Path, suffixes: &[&str]) -> bool {
    let name = lowercase_data_suffix(path);
    suffixes.iter().any(|suffix| {
        name.ends_with(&format!(".{suffix}")) || name.ends_with(&format!(".{suffix}.gz"))
    })
}

fn has_plain_suffix(path: &Path, suffixes: &[&str]) -> bool {
    let name = lowercase_data_suffix(path);
    suffixes
        .iter()
        .any(|suffix| name.ends_with(&format!(".{suffix}")))
}

fn open_text_reader(path: &Path) -> Result<Box<dyn BufRead>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("gz"))
    {
        Ok(Box::new(BufReader::new(MultiGzDecoder::new(file))))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

fn read_text_file(path: &Path) -> Result<String, String> {
    let mut reader = open_text_reader(path)?;
    let mut text = String::new();
    reader
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    Ok(text)
}

fn imported_text_file(path: &Path) -> Result<ImportedProjectTextFile, String> {
    Ok(ImportedProjectTextFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("data")
            .to_string(),
        text: read_text_file(path)?,
    })
}

fn history_sidecar_path(agp_path: &Path) -> PathBuf {
    let filename = agp_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("assembly.agp");
    let without_compression = if filename.to_ascii_lowercase().ends_with(".gz") {
        &filename[..filename.len().saturating_sub(3)]
    } else {
        filename
    };
    let lowercase = without_compression.to_ascii_lowercase();
    let prefix_length = if lowercase.ends_with(".agp") || lowercase.ends_with(".txt") {
        without_compression.len().saturating_sub(4)
    } else {
        without_compression.len()
    };
    let prefix = &without_compression[..prefix_length];
    agp_path.with_file_name(format!(
        "{}.history.json",
        if prefix.is_empty() {
            "assembly"
        } else {
            prefix
        }
    ))
}

fn sort_project_contact_candidates(candidates: &mut [PathBuf]) {
    candidates.sort_by_key(|path| {
        (
            if has_plain_suffix(path, &["mcool"]) {
                0
            } else {
                1
            },
            lowercase_data_suffix(path),
        )
    });
}

fn scan_project_directory(directory: &Path) -> Result<ImportedProjectDirectory, String> {
    if !directory.is_dir() {
        return Err("selected project path is not a directory".to_string());
    }
    let mut files = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    files.sort_by_key(|path| lowercase_data_suffix(path));

    let mut agp = Vec::new();
    let mut gfa = Vec::new();
    let mut paf = Vec::new();
    let mut coverage = Vec::new();
    let mut contact = Vec::new();
    for path in files {
        if has_data_suffix(&path, &["agp"]) {
            agp.push(path);
        } else if has_data_suffix(&path, &["gfa", "gfa1"]) {
            gfa.push(path);
        } else if has_data_suffix(&path, &["paf"]) {
            paf.push(path);
        } else if has_data_suffix(&path, &["depth", "bedgraph", "bg"]) {
            coverage.push(path);
        } else if has_plain_suffix(&path, &["cool", "mcool"]) {
            contact.push(path);
        }
    }
    sort_project_contact_candidates(&mut contact);

    let mut ignored_candidates = Vec::new();
    for candidates in [&agp, &gfa, &paf, &coverage, &contact] {
        ignored_candidates.extend(
            candidates
                .iter()
                .skip(1)
                .map(|path| path.to_string_lossy().to_string()),
        );
    }
    let selected_agp = agp
        .first()
        .map(|path| imported_text_file(path))
        .transpose()?;
    let selected_history = agp.first().and_then(|path| {
        let history_path = history_sidecar_path(path);
        history_path.is_file().then_some(history_path)
    });
    let selected_history = selected_history
        .as_deref()
        .map(imported_text_file)
        .transpose()?;
    let selected_gfa = gfa
        .first()
        .map(|path| imported_text_file(path))
        .transpose()?;
    let selected_paf = paf
        .first()
        .map(|path| paf_file_from_path(path))
        .transpose()?;
    let selected_coverage = coverage
        .first()
        .map(|path| coverage_file_from_path(path))
        .transpose()?;
    let selected_contact = contact
        .first()
        .map(|path| contact_file_from_path(path))
        .transpose()?;
    if selected_agp.is_none()
        && selected_gfa.is_none()
        && selected_paf.is_none()
        && selected_coverage.is_none()
        && selected_contact.is_none()
    {
        return Err("no supported project files found (.agp, .gfa, .paf, .depth/.bedgraph/.bg, .cool/.mcool, optionally .gz)".to_string());
    }
    Ok(ImportedProjectDirectory {
        directory: directory.to_string_lossy().to_string(),
        agp: selected_agp,
        history: selected_history,
        gfa: selected_gfa,
        paf: selected_paf,
        coverage: selected_coverage,
        contact: selected_contact,
        ignored_candidates,
    })
}

fn coverage_file_from_path(path: &Path) -> Result<ImportedContactFile, String> {
    if !has_data_suffix(path, &["depth", "bedgraph", "bg", "txt"]) {
        return Err(
            "selected file must end with .depth, .bedgraph, .bg, .txt, or their .gz form"
                .to_string(),
        );
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
        available_resolutions: Vec::new(),
        sources: Vec::new(),
    })
}

fn paf_file_from_path(path: &Path) -> Result<ImportedContactFile, String> {
    if !has_data_suffix(path, &["paf", "txt"]) {
        return Err("selected file must end with .paf, .txt, or their .gz form".to_string());
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
        available_resolutions: Vec::new(),
        sources: Vec::new(),
    })
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

    let mut records = Vec::new();

    for line in open_text_reader(Path::new(&request.paf_path))?.lines() {
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
    use flate2::{write::GzEncoder, Compression};
    use std::cell::Cell;
    use std::collections::{BTreeMap, BTreeSet, HashMap};
    use std::fs;
    use std::io::{BufRead, Write};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    use cstudio_core::{
        contact_cache::ContactCache,
        contact_map::{ContactMapCell, ContactMapView, Viewport},
        coverage_cache::CoverageCache,
        source_contact_cache::SourceContactCache,
    };

    use super::{
        build_contact_map_view, build_coverage_view, build_coverage_view_from_bedgraph_with_cache,
        build_synteny_view, contact_overview_aggregate_cell_bound, get_app_status,
        history_sidecar_path, layout_gfa_bandage_response, load_agp_bundle, load_project_directory,
        open_text_reader, persistent_contact_lod_cache_enabled_for_path,
        persistent_display_tile_plans, persistent_lod_cache_key, sort_project_contact_candidates,
        write_agp_bundle, write_agp_file, write_existing_agp_path, BedGraphRecordRequest,
        ContactMapBinRequest, ContactMapCellResponse, ContactMapLayoutBlockRequest,
        ContactMapOverviewFromCoolRequest, ContactMapTileKeyRequest, ContactMapTileResponse,
        ContactMapTilesFromCoolRequest, ContactMapViewFromCoolRequest, ContactMapViewRequest,
        ContactMapViewportRequest, ContactNormalizationRequest, ContactTileRequestPurpose,
        CoverageViewFromBedGraphRequest, CoverageViewRequest, GfaBandageLayoutEdgeRequest,
        GfaBandageLayoutNodeRequest, GfaBandageLayoutRequest, PafRecordRequest,
        PersistentDisplayCacheContext, PersistentDisplayTileAccumulator, PersistentDisplayTilePlan,
        SyntenyViewRequest, DISPLAY_CACHE_COPY_SEMANTICS_VERSION,
        MAX_CONTACT_OVERVIEW_AGGREGATE_CELLS,
    };

    #[test]
    fn contact_tile_delta_stream_uses_a_small_first_chunk_then_the_steady_threshold() {
        assert_eq!(
            super::contact_tile_delta_flush_threshold(false, 1, 32_768),
            1
        );
        assert_eq!(
            super::contact_tile_delta_flush_threshold(true, 1, 32_768),
            32_768
        );
        assert_eq!(
            super::DEFAULT_CONTACT_TILE_DELTA_LOD_EMIT_CELL_THRESHOLD,
            1_048_576
        );
    }

    #[test]
    fn gfa_bandage_layout_command_maps_nodes_edges_and_orientation() {
        let response = layout_gfa_bandage_response(GfaBandageLayoutRequest {
            nodes: vec![
                GfaBandageLayoutNodeRequest {
                    id: "a".to_string(),
                    width: 120.0,
                    orientation: "+".to_string(),
                    layout_unit_id: "unitig:a".to_string(),
                    layout_order: 0,
                },
                GfaBandageLayoutNodeRequest {
                    id: "b".to_string(),
                    width: 192.0,
                    orientation: "-".to_string(),
                    layout_unit_id: "unitig:b".to_string(),
                    layout_order: 0,
                },
            ],
            edges: vec![GfaBandageLayoutEdgeRequest {
                source: "a".to_string(),
                target: "b".to_string(),
                source_side: "end".to_string(),
                target_side: "end".to_string(),
            }],
        })
        .unwrap();

        assert_eq!(response.algorithm, "cstudio-rust-multilevel-v1");
        assert_eq!(response.paths.len(), 2);
        assert_eq!(response.paths[0].id, "a");
        assert_eq!(response.paths[1].id, "b");
        assert!(response.paths.iter().all(|path| {
            path.points.len() >= 2
                && path
                    .points
                    .iter()
                    .all(|point| point.x.is_finite() && point.y.is_finite())
        }));
    }

    #[test]
    fn gfa_bandage_layout_command_rejects_duplicate_ids_and_invalid_sides() {
        let duplicate = layout_gfa_bandage_response(GfaBandageLayoutRequest {
            nodes: vec![
                GfaBandageLayoutNodeRequest {
                    id: "a".to_string(),
                    width: 80.0,
                    orientation: "+".to_string(),
                    layout_unit_id: "unitig:a".to_string(),
                    layout_order: 0,
                },
                GfaBandageLayoutNodeRequest {
                    id: "a".to_string(),
                    width: 80.0,
                    orientation: "+".to_string(),
                    layout_unit_id: "unitig:a".to_string(),
                    layout_order: 0,
                },
            ],
            edges: vec![],
        })
        .unwrap_err();
        assert!(duplicate.contains("duplicate GFA layout node id"));

        let invalid_side = layout_gfa_bandage_response(GfaBandageLayoutRequest {
            nodes: vec![
                GfaBandageLayoutNodeRequest {
                    id: "a".to_string(),
                    width: 80.0,
                    orientation: "+".to_string(),
                    layout_unit_id: "unitig:a".to_string(),
                    layout_order: 0,
                },
                GfaBandageLayoutNodeRequest {
                    id: "b".to_string(),
                    width: 80.0,
                    orientation: "+".to_string(),
                    layout_unit_id: "unitig:b".to_string(),
                    layout_order: 0,
                },
            ],
            edges: vec![GfaBandageLayoutEdgeRequest {
                source: "a".to_string(),
                target: "b".to_string(),
                source_side: "left".to_string(),
                target_side: "start".to_string(),
            }],
        })
        .unwrap_err();
        assert!(invalid_side.contains("invalid GFA layout side"));
    }

    #[test]
    fn scans_project_directory_and_reads_gzip_text_inputs() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "c-studio-project-scan-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("z.agp"), "chr1\t1\t10\t1\tW\tctg1\t1\t10\t+\n").unwrap();
        fs::write(root.join("a.agp"), "chr1\t1\t20\t1\tW\tctg1\t1\t20\t+\n").unwrap();
        fs::write(root.join("a.history.json"), "{\"version\":1}").unwrap();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(b"S\tctg1\tACGT\n").unwrap();
        fs::write(root.join("graph.gfa.gz"), encoder.finish().unwrap()).unwrap();
        fs::write(root.join("reads.paf.gz"), b"").unwrap();
        fs::write(root.join("track.depth.gz"), b"").unwrap();

        let project = load_project_directory(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(project.agp.as_ref().unwrap().name, "a.agp");
        assert_eq!(project.history.as_ref().unwrap().name, "a.history.json");
        assert_eq!(project.history.as_ref().unwrap().text, "{\"version\":1}");
        assert_eq!(project.gfa.as_ref().unwrap().text, "S\tctg1\tACGT\n");
        assert_eq!(project.paf.as_ref().unwrap().name, "reads.paf.gz");
        assert_eq!(project.coverage.as_ref().unwrap().name, "track.depth.gz");
        assert_eq!(project.ignored_candidates.len(), 1);
        assert_eq!(
            open_text_reader(&root.join("graph.gfa.gz"))
                .unwrap()
                .lines()
                .count(),
            1
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_contact_candidates_prefer_mcool_then_sort_by_name() {
        let mut candidates = [
            PathBuf::from("a.cool"),
            PathBuf::from("z.mcool"),
            PathBuf::from("z.cool"),
            PathBuf::from("b.mcool"),
        ];

        sort_project_contact_candidates(&mut candidates);

        assert_eq!(
            candidates.map(|path| path.to_string_lossy().to_string()),
            ["b.mcool", "z.mcool", "a.cool", "z.cool"],
        );
    }

    #[test]
    fn persistent_contact_lod_cache_accepts_cool_and_mcool_files() {
        assert!(persistent_contact_lod_cache_enabled_for_path("input.cool"));
        assert!(persistent_contact_lod_cache_enabled_for_path(
            "input.q0.mcool"
        ));
        assert!(persistent_contact_lod_cache_enabled_for_path("INPUT.MCOOL"));
        assert!(!persistent_contact_lod_cache_enabled_for_path("input.hic"));
        assert!(!persistent_contact_lod_cache_enabled_for_path("input"));
    }

    fn test_layout_block(id: &str, visual_start: u64) -> ContactMapLayoutBlockRequest {
        ContactMapLayoutBlockRequest {
            id: id.to_string(),
            source_id: format!("source-{id}"),
            source_start: 0,
            source_end: 1_000,
            visual_start,
            orientation: "+".to_string(),
        }
    }

    #[test]
    fn bounds_overview_aggregation_by_target_grid_before_reading_cool() {
        let request = ContactMapOverviewFromCoolRequest {
            request_id: 1,
            generation: 1,
            cool_path: "/tmp/input.cool".to_string(),
            source_resolution: 1_000,
            target_resolution: 1_000,
            normalization: ContactNormalizationRequest::Raw,
            viewport: ContactMapViewportRequest {
                x_start: 0,
                x_end: 320_000,
                y_start: 0,
                y_end: 320_000,
            },
            layout_handle: None,
            layout_blocks: Vec::new(),
        };

        assert_eq!(
            contact_overview_aggregate_cell_bound(&request).unwrap(),
            320 * 320,
        );

        let exact_limit = ContactMapOverviewFromCoolRequest {
            viewport: ContactMapViewportRequest {
                x_start: 0,
                x_end: 1_024_000,
                y_start: 0,
                y_end: 1_024_000,
            },
            ..request.clone()
        };
        assert_eq!(
            contact_overview_aggregate_cell_bound(&exact_limit).unwrap(),
            MAX_CONTACT_OVERVIEW_AGGREGATE_CELLS as usize,
        );

        let oversized = ContactMapOverviewFromCoolRequest {
            viewport: ContactMapViewportRequest {
                x_start: 0,
                x_end: 1_025_000,
                y_start: 0,
                y_end: 1_025_000,
            },
            ..request
        };
        let error = contact_overview_aggregate_cell_bound(&oversized)
            .expect_err("oversized overview target grid should be rejected before I/O");
        assert!(error.contains("exceeding bounded aggregate limit"));
        assert!(error.contains("coarser targetResolution"));
    }

    fn test_contact_tile_request(
        layout_handle: Option<String>,
        layout_blocks: Vec<ContactMapLayoutBlockRequest>,
    ) -> ContactMapTilesFromCoolRequest {
        ContactMapTilesFromCoolRequest {
            request_id: 1,
            generation: 1,
            purpose: ContactTileRequestPurpose::Visible,
            cool_path: "/tmp/input.cool".to_string(),
            base_resolution: 1_000,
            source_resolution: None,
            target_resolution: 1_000,
            tile_size_bins: 256,
            normalization: ContactNormalizationRequest::Raw,
            adaptive_refinement: false,
            tiles: vec![ContactMapTileKeyRequest {
                tile_x: 0,
                tile_y: 0,
            }],
            layout_handle,
            layout_blocks,
        }
    }

    #[test]
    fn adaptive_mcool_refinement_requires_explicit_local_visible_request() {
        let mut request = test_contact_tile_request(None, Vec::new());
        request.cool_path = "/tmp/input.mcool".to_string();
        request.target_resolution = 2_500_000;
        request.adaptive_refinement = true;
        request.tiles = vec![
            ContactMapTileKeyRequest {
                tile_x: 10,
                tile_y: 10,
            },
            ContactMapTileKeyRequest {
                tile_x: 10,
                tile_y: 11,
            },
            ContactMapTileKeyRequest {
                tile_x: 11,
                tile_y: 10,
            },
            ContactMapTileKeyRequest {
                tile_x: 11,
                tile_y: 11,
            },
        ];
        let mut resolved = super::resolve_contact_tile_request(request, None).unwrap();

        assert!(super::adaptive_mcool_refinement_requested(
            &resolved,
            &resolved.tiles,
        ));

        resolved.adaptive_refinement = false;
        assert!(!super::adaptive_mcool_refinement_requested(
            &resolved,
            &resolved.tiles,
        ));
        resolved.adaptive_refinement = true;
        resolved.purpose = ContactTileRequestPurpose::SpatialPrefetch;
        assert!(!super::adaptive_mcool_refinement_requested(
            &resolved,
            &resolved.tiles,
        ));
        resolved.purpose = ContactTileRequestPurpose::Visible;
        resolved.tiles.push(ContactMapTileKeyRequest {
            tile_x: 12,
            tile_y: 12,
        });
        assert!(!super::adaptive_mcool_refinement_requested(
            &resolved,
            &resolved.tiles,
        ));
        resolved.tiles.truncate(4);
        resolved.tiles[3] = ContactMapTileKeyRequest {
            tile_x: 15,
            tile_y: 15,
        };
        assert!(!super::adaptive_mcool_refinement_requested(
            &resolved,
            &resolved.tiles,
        ));
    }

    #[test]
    fn persistent_lod_key_invalidates_file_resolution_normalization_viewport_and_layout() {
        let path = std::env::temp_dir().join(format!(
            "cstudio-lod-key-{}-{}.cool",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::write(&path, b"source-a").unwrap();
        let request = ContactMapOverviewFromCoolRequest {
            request_id: 1,
            generation: 1,
            cool_path: path.to_string_lossy().into_owned(),
            source_resolution: 1_000,
            target_resolution: 10_000,
            normalization: ContactNormalizationRequest::Raw,
            viewport: ContactMapViewportRequest {
                x_start: 0,
                x_end: 10_000,
                y_start: 0,
                y_end: 10_000,
            },
            layout_handle: None,
            layout_blocks: Vec::new(),
        };
        let layout = vec![test_layout_block("a", 0)];
        let baseline = persistent_lod_cache_key(&request, &layout).unwrap();

        let mut changed = request.clone();
        changed.target_resolution = 20_000;
        assert_ne!(
            baseline,
            persistent_lod_cache_key(&changed, &layout).unwrap()
        );
        let mut changed = request.clone();
        changed.normalization = ContactNormalizationRequest::Vc;
        assert_ne!(
            baseline,
            persistent_lod_cache_key(&changed, &layout).unwrap()
        );
        let mut changed = request.clone();
        changed.viewport.x_end += 1;
        assert_ne!(
            baseline,
            persistent_lod_cache_key(&changed, &layout).unwrap()
        );
        let mut changed_layout = layout.clone();
        changed_layout[0].orientation = "-".to_string();
        assert_ne!(
            baseline,
            persistent_lod_cache_key(&request, &changed_layout).unwrap()
        );
        fs::write(&path, b"source-b-larger").unwrap();
        assert_ne!(
            baseline,
            persistent_lod_cache_key(&request, &layout).unwrap()
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn display_tile_key_covers_file_resolutions_normalization_projection_and_copy_semantics() {
        let root = std::env::temp_dir().join("cstudio-display-key-test");
        let context = PersistentDisplayCacheContext {
            global_root: root.clone(),
            dataset_root: root.join("dataset-a"),
            file_fingerprint: b"file-a:size:mtime".to_vec(),
        };
        let layout = vec![test_layout_block("a", 0)];
        let mut request = test_contact_tile_request(None, layout.clone());
        request.source_resolution = Some(1_000);
        request.target_resolution = 10_000;
        request.tiles = vec![
            ContactMapTileKeyRequest {
                tile_x: 0,
                tile_y: 0,
            },
            ContactMapTileKeyRequest {
                tile_x: 0,
                tile_y: 1,
            },
        ];
        let resolved = super::resolve_contact_tile_request(request.clone(), None).unwrap();
        let baseline = persistent_display_tile_plans(&context, &resolved).unwrap();
        assert_eq!(baseline.len(), 2);
        assert!(baseline[0]
            .key
            .windows(DISPLAY_CACHE_COPY_SEMANTICS_VERSION.len())
            .any(|window| window == DISPLAY_CACHE_COPY_SEMANTICS_VERSION));

        let mut changed = request.clone();
        changed.normalization = ContactNormalizationRequest::Vc;
        let changed = super::resolve_contact_tile_request(changed, None).unwrap();
        assert_ne!(
            baseline[0].key,
            persistent_display_tile_plans(&context, &changed).unwrap()[0].key
        );

        let mut changed = request.clone();
        changed.source_resolution = Some(5_000);
        let changed = super::resolve_contact_tile_request(changed, None).unwrap();
        assert_ne!(
            baseline[0].key,
            persistent_display_tile_plans(&context, &changed).unwrap()[0].key
        );

        let mut changed_context = context.clone();
        changed_context.file_fingerprint = b"file-b:size:mtime".to_vec();
        assert_ne!(
            baseline[0].key,
            persistent_display_tile_plans(&changed_context, &resolved).unwrap()[0].key
        );

        let mut copied_layout = layout.clone();
        let mut copy = test_layout_block("copy", 2_000);
        copy.source_id = copied_layout[0].source_id.clone();
        copied_layout.push(copy);
        let copied = super::resolve_contact_tile_request(
            ContactMapTilesFromCoolRequest {
                layout_blocks: copied_layout,
                ..request.clone()
            },
            None,
        )
        .unwrap();
        assert_ne!(
            baseline[0].key,
            persistent_display_tile_plans(&context, &copied).unwrap()[0].key
        );

        let mut renamed_layout = layout;
        renamed_layout[0].id = "label-only-change".to_string();
        let renamed = super::resolve_contact_tile_request(
            ContactMapTilesFromCoolRequest {
                layout_blocks: renamed_layout,
                ..request
            },
            None,
        )
        .unwrap();
        assert_eq!(
            baseline[0].key,
            persistent_display_tile_plans(&context, &renamed).unwrap()[0].key
        );

        let mut implicit_request = test_contact_tile_request(None, vec![test_layout_block("a", 0)]);
        implicit_request.target_resolution = 1_000;
        let implicit_exact =
            super::resolve_contact_tile_request(implicit_request.clone(), None).unwrap();
        let implicit_key = persistent_display_tile_plans(&context, &implicit_exact).unwrap();
        let explicit_exact = super::resolve_contact_tile_request(
            ContactMapTilesFromCoolRequest {
                source_resolution: Some(1_000),
                ..implicit_request.clone()
            },
            None,
        )
        .unwrap();
        assert_eq!(
            implicit_key[0].key,
            persistent_display_tile_plans(&context, &explicit_exact).unwrap()[0].key,
            "fine exact tiles must use targetResolution as their effective source level",
        );

        let adaptive_request = ContactMapTilesFromCoolRequest {
            cool_path: "/tmp/input.mcool".to_string(),
            target_resolution: 2_500_000,
            adaptive_refinement: true,
            ..implicit_request
        };
        let adaptive = super::resolve_contact_tile_request(adaptive_request.clone(), None).unwrap();
        let conventional = super::resolve_contact_tile_request(
            ContactMapTilesFromCoolRequest {
                adaptive_refinement: false,
                ..adaptive_request
            },
            None,
        )
        .unwrap();
        assert_ne!(
            persistent_display_tile_plans(&context, &adaptive).unwrap()[0].key,
            persistent_display_tile_plans(&context, &conventional).unwrap()[0].key,
            "adaptive and conventional fine tiles must not share a persistent entry",
        );
    }

    #[test]
    fn display_tile_accumulator_persists_only_terminal_complete_float32_tiles() {
        let plans = vec![
            PersistentDisplayTilePlan {
                tile_x: 0,
                tile_y: 0,
                key: b"tile-0-0".to_vec(),
            },
            PersistentDisplayTilePlan {
                tile_x: 0,
                tile_y: 1,
                key: b"tile-0-1".to_vec(),
            },
        ];
        let mut accumulator = PersistentDisplayTileAccumulator::new(4, &plans).unwrap();
        accumulator
            .merge(&[ContactMapTileResponse {
                tile_x: 0,
                tile_y: 0,
                cells: vec![ContactMapCellResponse {
                    x_bin: 1,
                    y_bin: 2,
                    count: 1.25,
                }],
            }])
            .unwrap();
        accumulator
            .merge(&[ContactMapTileResponse {
                tile_x: 0,
                tile_y: 0,
                cells: vec![ContactMapCellResponse {
                    x_bin: 1,
                    y_bin: 2,
                    count: 2.25,
                }],
            }])
            .unwrap();

        let stored = accumulator.finish(&plans).unwrap();
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].tile.float32_values()[2 * 4 + 1], 3.5);
        assert!(stored[0]
            .tile
            .float32_values()
            .iter()
            .enumerate()
            .all(|(index, value)| index == 2 * 4 + 1 || *value == -1.0));
        assert!(stored[1]
            .tile
            .float32_values()
            .iter()
            .all(|value| *value == -1.0));
    }

    #[test]
    fn display_cache_binary_merge_restores_requested_tile_order() {
        let plans = vec![
            PersistentDisplayTilePlan {
                tile_x: 0,
                tile_y: 0,
                key: b"tile-0-0".to_vec(),
            },
            PersistentDisplayTilePlan {
                tile_x: 0,
                tile_y: 1,
                key: b"tile-0-1".to_vec(),
            },
        ];
        let cached = vec![crate::contact_display_cache::DisplayCacheTile {
            tile_size_bins: 2,
            tile_x: 0,
            tile_y: 1,
            values: crate::contact_display_cache::DisplayCacheValues::Float32(vec![
                -1.0, 2.0, -1.0, -1.0,
            ]),
        }];
        let pending = vec![super::PendingDisplayCacheStore {
            key: plans[0].key.clone(),
            tile: crate::contact_display_cache::DisplayCacheTile {
                tile_size_bins: 2,
                tile_x: 0,
                tile_y: 0,
                values: crate::contact_display_cache::DisplayCacheValues::Float32(vec![
                    1.0, -1.0, -1.0, -1.0,
                ]),
            },
        }];

        let merged = super::ordered_persistent_display_tiles(&plans, cached, &pending).unwrap();
        assert_eq!(
            merged
                .iter()
                .map(|tile| (tile.tile_x, tile.tile_y))
                .collect::<Vec<_>>(),
            vec![(0, 0), (0, 1)],
        );
        assert_eq!(
            merged
                .iter()
                .map(super::display_tile_occupied_cells)
                .sum::<usize>(),
            2
        );
    }

    #[test]
    fn display_cache_hit_skips_complete_empty_tiles_and_returns_only_real_misses() {
        let root = std::env::temp_dir().join(format!(
            "cstudio-display-hit-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let context = PersistentDisplayCacheContext {
            global_root: root.clone(),
            dataset_root: root.join("dataset"),
            file_fingerprint: b"file".to_vec(),
        };
        let layout = vec![test_layout_block("a", 0)];
        let mut request = test_contact_tile_request(None, layout);
        request.source_resolution = Some(1_000);
        request.target_resolution = 10_000;
        request.tile_size_bins = 4;
        request.tiles = vec![
            ContactMapTileKeyRequest {
                tile_x: 0,
                tile_y: 0,
            },
            ContactMapTileKeyRequest {
                tile_x: 0,
                tile_y: 1,
            },
        ];
        let resolved = super::resolve_contact_tile_request(request, None).unwrap();
        let plans = persistent_display_tile_plans(&context, &resolved).unwrap();
        crate::contact_display_cache::store_atomic(
            &context.dataset_root,
            &plans[0].key,
            &crate::contact_display_cache::DisplayCacheTile {
                tile_size_bins: 4,
                tile_x: plans[0].tile_x,
                tile_y: plans[0].tile_y,
                values: crate::contact_display_cache::DisplayCacheValues::Float32(vec![-1.0; 16]),
            },
        )
        .unwrap();

        let (cached, missing, stats) =
            super::load_persistent_display_tiles(&context, &resolved, plans.clone(), &|| false)
                .unwrap();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.corrupt, 0);
        assert_eq!(cached.len(), 1);
        assert!(cached[0]
            .float32_values()
            .iter()
            .all(|value| *value == -1.0));
        assert_eq!(missing.len(), 1);
        assert_eq!((missing[0].tile_x, missing[0].tile_y), (0, 1));
        assert_eq!(
            super::load_persistent_display_tiles(&context, &resolved, plans, &|| true).unwrap_err(),
            "contact tile request cancelled"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn read_binary_u16(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
    }

    fn read_binary_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    fn read_binary_u64(bytes: &[u8], offset: usize) -> u64 {
        u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }

    fn read_binary_f64(bytes: &[u8], offset: usize) -> f64 {
        f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }

    fn read_binary_f32(bytes: &[u8], offset: usize) -> f32 {
        f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn formats_contact_tile_command_performance_with_request_identity() {
        let line = super::contact_tile_command_perf_line(super::ContactTileCommandPerfContext {
            scenario: "visible",
            request_id: 41,
            generation: 7,
            target_resolution: 10_000,
            requested_tiles: 2,
            returned_tiles: 2,
            response_cells: 321,
            command_us: 4_500,
        });

        assert_eq!(
            line,
            "CSTUDIO_PERF event=contact_tiles_command scenario=visible status=ok \
             request_id=41 generation=7 target_resolution=10000 requested_tiles=2 \
             returned_tiles=2 response_cells=321 command_us=4500"
        );
    }

    #[test]
    fn formats_binary_contact_tile_command_performance_with_response_bytes() {
        let line = super::contact_tile_binary_command_perf_line(
            super::ContactTileBinaryCommandPerfContext {
                scenario: "visible",
                request_id: 41,
                generation: 7,
                target_resolution: 10_000,
                requested_tiles: 2,
                returned_tiles: 2,
                response_cells: 321,
                response_bytes: 3_916,
                command_us: 4_700,
            },
        );

        assert_eq!(
            line,
            "CSTUDIO_PERF event=contact_tiles_binary_command scenario=visible status=ok \
             request_id=41 generation=7 target_resolution=10000 requested_tiles=2 \
             returned_tiles=2 response_cells=321 response_bytes=3916 command_us=4700"
        );
    }

    #[test]
    fn formats_progressive_chunk_performance_with_first_chunk_identity() {
        let line = super::contact_tile_progressive_chunk_perf_line(
            super::ContactTileProgressiveChunkPerfContext {
                scenario: "visible",
                request_id: 41,
                generation: 7,
                target_resolution: 10_000,
                chunk_index: 1,
                chunk_count: 3,
                requested_tiles: 2,
                returned_tiles: 2,
                response_cells: 321,
                response_bytes: 3_916,
                compute_us: 2_700,
                encode_send_us: 400,
                elapsed_us: 3_400,
            },
        );

        assert_eq!(
            line,
            "CSTUDIO_PERF event=contact_tiles_progressive_chunk scenario=visible status=ok \
             request_id=41 generation=7 target_resolution=10000 chunk_index=1 chunk_count=3 \
             requested_tiles=2 returned_tiles=2 response_cells=321 response_bytes=3916 \
             compute_us=2700 encode_send_us=400 elapsed_us=3400"
        );
    }

    #[test]
    fn validates_the_complete_stream_plan_before_progressive_work() {
        let key = |tile_x, tile_y| ContactMapTileKeyRequest { tile_x, tile_y };
        let validated = super::validate_contact_tile_stream_chunks(
            &[key(3, 1), key(2, 2), key(4, 5)],
            &[vec![key(3, 1), key(2, 2)], vec![], vec![key(4, 5)]],
        )
        .unwrap();

        assert_eq!(validated, vec![vec![key(1, 3), key(2, 2)], vec![key(4, 5)]]);
        assert!(super::validate_contact_tile_stream_chunks(
            &[key(0, 0), key(1, 1)],
            &[vec![key(0, 0)]]
        )
        .unwrap_err()
        .contains("omitted response 1:1"));
        assert!(super::validate_contact_tile_stream_chunks(
            &[key(0, 1)],
            &[vec![key(0, 1)], vec![key(1, 0)]]
        )
        .unwrap_err()
        .contains("duplicate response 0:1"));
        assert!(
            super::validate_contact_tile_stream_chunks(&[key(0, 0)], &[vec![key(2, 2)]])
                .unwrap_err()
                .contains("unrequested response 2:2")
        );
    }

    #[test]
    fn partitions_streamed_contact_tiles_by_requested_chunk_order() {
        let tile = |tile_x, tile_y| super::ContactMapTileResponse {
            tile_x,
            tile_y,
            cells: Vec::new(),
        };
        let key = |tile_x, tile_y| ContactMapTileKeyRequest { tile_x, tile_y };
        let chunks = super::contact_tile_response_chunks(
            vec![tile(4, 5), tile(1, 2), tile(3, 3)],
            &[vec![key(2, 1), key(3, 3)], vec![key(4, 5)]],
        )
        .unwrap();

        assert_eq!(chunks.len(), 2);
        assert_eq!(
            chunks[0]
                .iter()
                .map(|tile| (tile.tile_x, tile.tile_y))
                .collect::<Vec<_>>(),
            vec![(1, 2), (3, 3)]
        );
        assert_eq!(
            chunks[1]
                .iter()
                .map(|tile| (tile.tile_x, tile.tile_y))
                .collect::<Vec<_>>(),
            vec![(4, 5)]
        );
    }

    #[test]
    fn computes_and_emits_center_first_chunks_before_outer_tiles() {
        let summary = super::load_example_dataset().expect("example dataset should load");
        let layout_blocks = summary
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
            .collect::<Vec<_>>();
        let key = |tile_x, tile_y| ContactMapTileKeyRequest { tile_x, tile_y };
        let center = key(10_001, 10_001);
        let near = key(10_001, 10_002);
        let outer = key(10_003, 10_003);
        let chunks = vec![vec![center, near], vec![outer]];
        let request = super::resolve_contact_tile_request(
            ContactMapTilesFromCoolRequest {
                request_id: 11,
                generation: 4,
                purpose: ContactTileRequestPurpose::Visible,
                cool_path: summary.cool_path,
                base_resolution: 1_000,
                source_resolution: None,
                target_resolution: 10_000,
                tile_size_bins: 256,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
                tiles: chunks.iter().flatten().copied().collect(),
                layout_handle: None,
                layout_blocks,
            },
            None,
        )
        .expect("legacy layout blocks should resolve");
        let source_cache = Mutex::new(SourceContactCache::new(16 * 1024 * 1024));
        let tile_cache = Mutex::new(HashMap::new());
        let mut emitted = Vec::new();

        let stats = super::compute_contact_tile_chunks_progressively(
            request.clone(),
            &chunks,
            &source_cache,
            &tile_cache,
            &|| false,
            Instant::now(),
            |tiles| {
                let coordinates = tiles
                    .iter()
                    .map(|tile| (tile.tile_x, tile.tile_y))
                    .collect::<Vec<_>>();
                if emitted.is_empty() {
                    let cached = tile_cache.lock().expect("tile cache lock");
                    let cached_coordinates = cached
                        .values()
                        .map(|tile| (tile.tile_x, tile.tile_y))
                        .collect::<BTreeSet<_>>();
                    assert_eq!(
                        cached_coordinates,
                        BTreeSet::from([
                            (center.tile_x, center.tile_y),
                            (near.tile_x, near.tile_y)
                        ])
                    );
                    assert!(!cached_coordinates.contains(&(outer.tile_x, outer.tile_y)));
                }
                emitted.push(coordinates);
                Ok(tiles.len())
            },
        )
        .expect("progressive chunks should render");

        assert_eq!(
            emitted,
            vec![
                vec![(center.tile_x, center.tile_y), (near.tile_x, near.tile_y)],
                vec![(outer.tile_x, outer.tile_y)],
            ]
        );
        assert_eq!(stats, (3, 0, 3));
        assert_eq!(tile_cache.lock().expect("tile cache lock").len(), 3);

        let mut lod_request = request.clone();
        lod_request.source_resolution = Some(10_000);
        let lod_source_cache = Mutex::new(SourceContactCache::new(16 * 1024 * 1024));
        let lod_tile_cache = Mutex::new(HashMap::new());
        let mut lod_emitted = Vec::new();
        let lod_stats = super::compute_contact_tile_chunks_progressively(
            lod_request,
            &chunks,
            &lod_source_cache,
            &lod_tile_cache,
            &|| false,
            Instant::now(),
            |tiles| {
                // Coarse LOD scans once, caches the whole visible set, and then
                // preserves the center-first presentation order.
                assert_eq!(lod_tile_cache.lock().expect("LOD tile cache lock").len(), 3);
                lod_emitted.push(
                    tiles
                        .iter()
                        .map(|tile| (tile.tile_x, tile.tile_y))
                        .collect::<Vec<_>>(),
                );
                Ok(tiles.len())
            },
        )
        .expect("single-scan LOD chunks should render");
        assert_eq!(lod_emitted, emitted);
        assert_eq!(lod_stats, (3, 0, 3));

        let cancelled = Cell::new(false);
        let cancelled_source_cache = Mutex::new(SourceContactCache::new(16 * 1024 * 1024));
        let cancelled_tile_cache = Mutex::new(HashMap::new());
        let mut cancelled_emissions = 0;
        let error = super::compute_contact_tile_chunks_progressively(
            request,
            &chunks,
            &cancelled_source_cache,
            &cancelled_tile_cache,
            &|| cancelled.get(),
            Instant::now(),
            |tiles| {
                cancelled_emissions += 1;
                cancelled.set(true);
                Ok(tiles.len())
            },
        )
        .expect_err("cancellation after the first chunk must stop outer tile work");
        assert_eq!(error, "contact tile request cancelled");
        assert_eq!(cancelled_emissions, 1);
        assert_eq!(
            cancelled_tile_cache.lock().expect("tile cache lock").len(),
            2
        );
    }

    #[test]
    fn rejects_stream_chunk_sets_that_do_not_exactly_cover_the_response() {
        let tiles = vec![
            super::ContactMapTileResponse {
                tile_x: 0,
                tile_y: 0,
                cells: Vec::new(),
            },
            super::ContactMapTileResponse {
                tile_x: 1,
                tile_y: 1,
                cells: Vec::new(),
            },
        ];

        let error = super::contact_tile_response_chunks(
            tiles,
            &[vec![ContactMapTileKeyRequest {
                tile_x: 0,
                tile_y: 0,
            }]],
        )
        .unwrap_err();

        assert!(error.contains("omitted response 1:1"));
    }

    #[test]
    fn encodes_binary_contact_tiles_with_empty_tile_local_columns_and_f64_bits() {
        let nan = f64::from_bits(0x7ff8_0000_0000_1234);
        let tiles = vec![
            super::ContactMapTileResponse {
                tile_x: 0,
                tile_y: 0,
                cells: Vec::new(),
            },
            super::ContactMapTileResponse {
                tile_x: 1,
                tile_y: 2,
                cells: vec![
                    super::ContactMapCellResponse {
                        x_bin: 256,
                        y_bin: 512,
                        count: 1.5,
                    },
                    super::ContactMapCellResponse {
                        x_bin: 511,
                        y_bin: 767,
                        count: nan,
                    },
                    super::ContactMapCellResponse {
                        x_bin: 263,
                        y_bin: 530,
                        count: f64::INFINITY,
                    },
                    super::ContactMapCellResponse {
                        x_bin: 300,
                        y_bin: 600,
                        count: f64::NEG_INFINITY,
                    },
                ],
            },
        ];

        let bytes = super::encode_contact_map_tiles_binary_v1(&tiles, 256, &|| false).unwrap();

        assert_eq!(&bytes[0..4], b"CST1");
        assert_eq!(read_binary_u16(&bytes, 4), 1);
        assert_eq!(read_binary_u16(&bytes, 6), 0);
        assert_eq!(read_binary_u32(&bytes, 8), 256);
        assert_eq!(read_binary_u32(&bytes, 12), 2);

        assert_eq!(read_binary_u64(&bytes, 16), 0);
        assert_eq!(read_binary_u64(&bytes, 24), 0);
        assert_eq!(read_binary_u32(&bytes, 32), 0);
        assert_eq!(read_binary_u32(&bytes, 36), 64);
        assert_eq!(read_binary_u64(&bytes, 40), 1);
        assert_eq!(read_binary_u64(&bytes, 48), 2);
        assert_eq!(read_binary_u32(&bytes, 56), 4);
        assert_eq!(read_binary_u32(&bytes, 60), 64);

        assert_eq!(
            (0..4)
                .map(|index| read_binary_u16(&bytes, 64 + index * 2))
                .collect::<Vec<_>>(),
            vec![0, 255, 7, 44]
        );
        assert_eq!(
            (0..4)
                .map(|index| read_binary_u16(&bytes, 72 + index * 2))
                .collect::<Vec<_>>(),
            vec![0, 255, 18, 88]
        );
        assert_eq!(read_binary_f64(&bytes, 80), 1.5);
        assert_eq!(read_binary_f64(&bytes, 88).to_bits(), nan.to_bits());
        assert_eq!(read_binary_f64(&bytes, 96), f64::INFINITY);
        assert_eq!(read_binary_f64(&bytes, 104), f64::NEG_INFINITY);
        assert_eq!(bytes.len(), 112);
    }

    #[test]
    fn encodes_dense_float32_display_tiles_without_sparse_round_trip() {
        let tiles = vec![crate::contact_display_cache::DisplayCacheTile {
            tile_size_bins: 2,
            tile_x: 3,
            tile_y: 7,
            values: crate::contact_display_cache::DisplayCacheValues::Float32(vec![
                -1.0, 1.5, 2.25, 0.0,
            ]),
        }];

        let bytes = super::encode_contact_map_dense_tiles_binary_v1(&tiles, 2, &|| false).unwrap();

        assert_eq!(&bytes[0..4], b"CST1");
        assert_eq!(read_binary_u16(&bytes, 4), 1);
        assert_eq!(read_binary_u16(&bytes, 6), 1);
        assert_eq!(read_binary_u32(&bytes, 8), 2);
        assert_eq!(read_binary_u32(&bytes, 12), 1);
        assert_eq!(read_binary_u64(&bytes, 16), 3);
        assert_eq!(read_binary_u64(&bytes, 24), 7);
        assert_eq!(read_binary_u32(&bytes, 32), 4);
        assert_eq!(read_binary_u32(&bytes, 36), 40);
        assert_eq!(read_binary_f32(&bytes, 40), -1.0);
        assert_eq!(read_binary_f32(&bytes, 44), 1.5);
        assert_eq!(read_binary_f32(&bytes, 48), 2.25);
        assert_eq!(read_binary_f32(&bytes, 52), 0.0);
        assert_eq!(bytes.len(), 56);
    }

    #[test]
    fn encodes_gpu_ready_dense_r16f_display_tiles() {
        let tiles = vec![crate::contact_display_cache::DisplayCacheTile {
            tile_size_bins: 2,
            tile_x: 3,
            tile_y: 7,
            values: crate::contact_display_cache::DisplayCacheValues::R16f(vec![
                crate::contact_display_cache::R16F_EMPTY_SENTINEL,
                crate::contact_display_cache::f32_to_r16f_bits(1.5).unwrap(),
                crate::contact_display_cache::f32_to_r16f_bits(2.25).unwrap(),
                crate::contact_display_cache::f32_to_r16f_bits(0.0).unwrap(),
            ]),
        }];

        let bytes = super::encode_contact_map_dense_tiles_binary_v1(&tiles, 2, &|| false).unwrap();

        assert_eq!(&bytes[0..4], b"CST1");
        assert_eq!(read_binary_u16(&bytes, 6), 2);
        assert_eq!(read_binary_u32(&bytes, 32), 4);
        assert_eq!(read_binary_u32(&bytes, 36), 40);
        assert_eq!(read_binary_u16(&bytes, 40), 0xbc00);
        assert_eq!(read_binary_u16(&bytes, 42), 0x3e00);
        assert_eq!(read_binary_u16(&bytes, 44), 0x4080);
        assert_eq!(read_binary_u16(&bytes, 46), 0);
        assert_eq!(bytes.len(), 48);
    }

    #[test]
    fn encodes_mixed_dense_tiles_without_expanding_r16f_tiles() {
        let tiles = vec![
            crate::contact_display_cache::DisplayCacheTile {
                tile_size_bins: 2,
                tile_x: 0,
                tile_y: 0,
                values: crate::contact_display_cache::DisplayCacheValues::R16f(vec![
                    0xbc00, 0x3c00, 0x4000, 0,
                ]),
            },
            crate::contact_display_cache::DisplayCacheTile {
                tile_size_bins: 2,
                tile_x: 0,
                tile_y: 1,
                values: crate::contact_display_cache::DisplayCacheValues::Float32(vec![
                    -1.0, 70_000.0, 2.0, 0.0,
                ]),
            },
        ];

        let bytes = super::encode_contact_map_dense_tiles_binary_v1(&tiles, 2, &|| false).unwrap();

        assert_eq!(read_binary_u16(&bytes, 6), 3);
        assert_eq!(read_binary_u32(&bytes, 32), 0x8000_0004);
        assert_eq!(read_binary_u32(&bytes, 36), 64);
        assert_eq!(read_binary_u32(&bytes, 56), 4);
        assert_eq!(read_binary_u32(&bytes, 60), 72);
        assert_eq!(read_binary_u16(&bytes, 64), 0xbc00);
        assert_eq!(read_binary_f32(&bytes, 72), -1.0);
        assert_eq!(read_binary_f32(&bytes, 76), 70_000.0);
        assert_eq!(bytes.len(), 88);

        let odd = vec![
            crate::contact_display_cache::DisplayCacheTile {
                tile_size_bins: 1,
                tile_x: 0,
                tile_y: 0,
                values: crate::contact_display_cache::DisplayCacheValues::R16f(vec![0x3c00]),
            },
            crate::contact_display_cache::DisplayCacheTile {
                tile_size_bins: 1,
                tile_x: 0,
                tile_y: 1,
                values: crate::contact_display_cache::DisplayCacheValues::Float32(vec![70_000.0]),
            },
        ];
        let odd_bytes =
            super::encode_contact_map_dense_tiles_binary_v1(&odd, 1, &|| false).unwrap();
        assert_eq!(read_binary_u32(&odd_bytes, 36), 64);
        assert_eq!(read_binary_u32(&odd_bytes, 60), 68);
        assert_eq!(odd_bytes.len(), 72);
    }

    #[test]
    fn encodes_binary_contact_tile_u16_boundary_and_deterministically() {
        let tiles = vec![super::ContactMapTileResponse {
            tile_x: 1,
            tile_y: 1,
            cells: vec![super::ContactMapCellResponse {
                x_bin: 131_071,
                y_bin: 131_071,
                count: 42.25,
            }],
        }];

        let first = super::encode_contact_map_tiles_binary_v1(&tiles, 65_536, &|| false).unwrap();
        let second = super::encode_contact_map_tiles_binary_v1(&tiles, 65_536, &|| false).unwrap();

        assert_eq!(first, second);
        assert_eq!(read_binary_u32(&first, 8), 65_536);
        assert_eq!(read_binary_u32(&first, 36), 40);
        assert_eq!(read_binary_u16(&first, 40), u16::MAX);
        assert_eq!(read_binary_u16(&first, 42), u16::MAX);
        assert_eq!(&first[44..48], &[0, 0, 0, 0]);
        assert_eq!(read_binary_f64(&first, 48), 42.25);
        assert_eq!(first.len(), 56);
    }

    #[test]
    fn rejects_binary_contact_cells_outside_their_tile_and_invalid_tile_sizes() {
        let outside_x = vec![super::ContactMapTileResponse {
            tile_x: 1,
            tile_y: 2,
            cells: vec![super::ContactMapCellResponse {
                x_bin: 255,
                y_bin: 512,
                count: 1.0,
            }],
        }];
        let outside_y = vec![super::ContactMapTileResponse {
            tile_x: 1,
            tile_y: 2,
            cells: vec![super::ContactMapCellResponse {
                x_bin: 256,
                y_bin: 768,
                count: 1.0,
            }],
        }];

        assert!(
            super::encode_contact_map_tiles_binary_v1(&outside_x, 256, &|| false)
                .unwrap_err()
                .contains("X bin 255 is outside tile (1, 2)")
        );
        assert!(
            super::encode_contact_map_tiles_binary_v1(&outside_y, 256, &|| false)
                .unwrap_err()
                .contains("Y bin 768 is outside tile (1, 2)")
        );
        assert!(super::encode_contact_map_tiles_binary_v1(&[], 0, &|| false)
            .unwrap_err()
            .contains("between 1 and 65536"));
        assert!(
            super::encode_contact_map_tiles_binary_v1(&[], 65_537, &|| false)
                .unwrap_err()
                .contains("between 1 and 65536")
        );
    }

    #[test]
    fn binary_contact_tile_encoding_observes_cancellation() {
        assert_eq!(
            super::encode_contact_map_tiles_binary_v1(&[], 256, &|| true).unwrap_err(),
            "contact tile request cancelled"
        );
    }

    #[test]
    fn formats_frontend_invoke_performance_with_attempt() {
        let line = super::contact_tile_frontend_ipc_perf_line(
            &super::ContactTileFrontendIpcPerformanceRequest {
                request_id: 41,
                generation: 7,
                purpose: ContactTileRequestPurpose::Overview,
                attempt: 2,
                target_resolution: 10_000,
                requested_tiles: 2,
                returned_tiles: 0,
                response_cells: 0,
                response_bytes: 3_916,
                decode_us: 275,
                transport: super::ContactTileFrontendIpcTransport::ArrayBuffer,
                invoke_us: 8_250,
                status: super::ContactTileFrontendIpcStatus::Error,
            },
        );

        assert_eq!(
            line,
            "CSTUDIO_PERF event=contact_tiles_invoke scenario=overview status=error \
             request_id=41 generation=7 attempt=2 target_resolution=10000 requested_tiles=2 \
             returned_tiles=0 response_cells=0 response_bytes=3916 decode_us=275 \
             transport=array_buffer invoke_us=8250"
        );
    }

    #[test]
    fn formats_contact_pan_pipeline_with_nullable_stages() {
        let line =
            super::contact_pan_frontend_perf_line(&super::ContactPanFrontendPerformanceRequest {
                status: super::ContactPanFrontendStatus::Ok,
                generation: 8,
                pan_sequence: 3,
                visible_tiles: 6,
                cache_hit: false,
                pointer_to_generation_ms: 2.5,
                pointer_to_ipc_start_ms: Some(3.25),
                ipc_ms: Some(12.75),
                pointer_to_cache_merge_ms: Some(17.5),
                pointer_to_gpu_paint_ms: None,
                total_ms: None,
            });

        assert_eq!(
            line,
            "CSTUDIO_PERF event=contact_pan_pipeline status=ok pan_sequence=3 generation=8 \
             visible_tiles=6 cache_hit=false pointer_to_generation_ms=2.5 \
             pointer_to_ipc_start_ms=3.25 ipc_ms=12.75 pointer_to_cache_merge_ms=17.5 \
             pointer_to_gpu_paint_ms=null total_ms=null"
        );
    }

    #[test]
    fn returns_core_engine_status() {
        let status = get_app_status();

        assert_eq!(status.engine, "cstudio-core");
        assert_eq!(status.version, env!("CARGO_PKG_VERSION"));
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
    fn overwrites_only_an_existing_agp_save_target() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the Unix epoch")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("c-studio-save-{}-{unique}.agp", std::process::id()));

        assert!(!write_existing_agp_path(&path, "new")
            .expect("a missing target should request Save As"));
        fs::write(&path, "old").expect("test target should be created");
        assert!(write_existing_agp_path(&path, "new").expect("target should be overwritten"));
        assert_eq!(
            fs::read_to_string(&path).expect("saved AGP should be readable"),
            "new"
        );

        fs::remove_file(path).expect("test target should be removed");
    }

    #[test]
    fn writes_a_new_agp_save_target_selected_by_the_dialog() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "c-studio-save-as-{}-{unique}.agp",
            std::process::id()
        ));

        let saved_path = write_agp_file(path.to_string_lossy().into_owned(), "new".to_string())
            .expect("a selected Save As target should be written");
        assert_eq!(saved_path, path.to_string_lossy());
        assert_eq!(
            fs::read_to_string(&path).expect("saved AGP should be readable"),
            "new"
        );

        fs::remove_file(path).expect("test target should be removed");
    }

    #[test]
    fn writes_and_loads_a_same_prefix_history_sidecar() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "c-studio-history-save-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("sample.edited.agp");
        let saved_path = write_agp_bundle(
            path.to_string_lossy().into_owned(),
            "chr1\t1\t10\t1\tW\tctg1\t1\t10\t+\n".to_string(),
            "{\"format\":\"c-studio-operation-history\"}\n".to_string(),
        )
        .expect("AGP bundle should be written");

        assert_eq!(saved_path, path.to_string_lossy());
        assert_eq!(
            history_sidecar_path(&path).file_name().unwrap(),
            "sample.edited.history.json"
        );
        let loaded = load_agp_bundle(saved_path).expect("AGP bundle should load");
        assert_eq!(loaded.agp.name, "sample.edited.agp");
        assert_eq!(
            loaded.history.expect("history sidecar should load").name,
            "sample.edited.history.json"
        );

        fs::remove_dir_all(root).expect("test bundle should be removed");
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
        assert_eq!(
            ContactNormalizationRequest::Kr.cache_key(),
            "kr_assembly_v1"
        );
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
        assert_eq!(request.purpose, ContactTileRequestPurpose::Visible);
        assert_eq!(request.source_resolution, None);
        assert!(!request.adaptive_refinement);
        assert_eq!(request.layout_handle, None);
    }

    #[test]
    fn contact_tile_request_accepts_a_handle_without_legacy_layout_blocks() {
        let request: ContactMapTilesFromCoolRequest = serde_json::from_value(serde_json::json!({
            "requestId": 1,
            "generation": 1,
            "coolPath": "/tmp/input.cool",
            "baseResolution": 1_000,
            "targetResolution": 10_000,
            "tileSizeBins": 256,
            "tiles": [],
            "layoutHandle": "layout-0000000000000001",
        }))
        .expect("handle-backed request without legacy blocks");

        assert_eq!(
            request.layout_handle.as_deref(),
            Some("layout-0000000000000001")
        );
        assert!(request.layout_blocks.is_empty());
    }

    #[test]
    fn contact_layout_registry_is_immutable_lru_and_resolved_arcs_survive_eviction() {
        let registry = super::ContactLayoutRegistryState::with_capacity(2);
        let first = registry
            .register(vec![test_layout_block("first", 0)])
            .expect("first layout registers");
        let second = registry
            .register(vec![test_layout_block("second", 1_000)])
            .expect("second layout registers");
        assert_ne!(first, second);

        let retained_first = registry.resolve(&first).expect("first layout resolves");
        let third = registry
            .register(vec![test_layout_block("third", 2_000)])
            .expect("third layout registers");

        assert_eq!(retained_first[0].id, "first");
        assert_eq!(registry.resolve(&first).unwrap()[0].id, "first");
        assert_eq!(registry.resolve(&third).unwrap()[0].id, "third");
        assert_eq!(
            registry.resolve(&second).unwrap_err(),
            format!("{}: {second}", super::UNKNOWN_CONTACT_LAYOUT_HANDLE_PREFIX)
        );
    }

    #[test]
    fn handle_resolution_is_authoritative_and_unknown_handles_fail_closed() {
        let registry = super::ContactLayoutRegistryState::with_capacity(2);
        let registered_blocks = vec![test_layout_block("registered", 0)];
        let handle = registry
            .register(registered_blocks.clone())
            .expect("layout registers");
        let registered_arc = registry.resolve(&handle).expect("layout resolves");
        let resolved = super::resolve_contact_tile_request(
            test_contact_tile_request(
                Some(handle),
                vec![test_layout_block("conflicting-legacy", 10_000)],
            ),
            Some(&registry),
        )
        .expect("known handle resolves");

        assert!(std::sync::Arc::ptr_eq(
            &registered_arc,
            &resolved.layout_blocks
        ));
        assert_eq!(resolved.layout_blocks.as_ref(), &registered_blocks);
        assert!(resolved.request.layout_blocks.is_empty());

        let missing = "layout-000000000000ffff";
        let error = super::resolve_contact_tile_request(
            test_contact_tile_request(
                Some(missing.to_string()),
                vec![test_layout_block("must-not-fallback", 0)],
            ),
            Some(&registry),
        )
        .expect_err("unknown handle must not use a conflicting legacy payload");
        assert_eq!(
            error,
            format!("{}: {missing}", super::UNKNOWN_CONTACT_LAYOUT_HANDLE_PREFIX)
        );
    }

    #[test]
    fn legacy_layout_blocks_still_resolve_without_a_handle() {
        let blocks = vec![test_layout_block("legacy", 0)];
        let resolved = super::resolve_contact_tile_request(
            test_contact_tile_request(None, blocks.clone()),
            None,
        )
        .expect("legacy request resolves");

        assert_eq!(resolved.layout_blocks.as_ref(), &blocks);
        assert!(resolved.request.layout_blocks.is_empty());
    }

    #[test]
    fn unknown_layout_handle_cannot_advance_the_contact_generation() {
        let registry = super::ContactLayoutRegistryState::with_capacity(1);
        let request_state = super::ContactTileRequestState::default();
        request_state
            .retain_and_begin_generation(7, &[])
            .expect("generation begins");
        let mut request = test_contact_tile_request(Some("layout-missing".to_string()), Vec::new());
        request.generation = 8;

        assert!(super::resolve_contact_tile_request(request, Some(&registry)).is_err());
        assert_eq!(
            request_state
                .latest_generation
                .load(std::sync::atomic::Ordering::SeqCst),
            7
        );
    }

    #[test]
    fn contact_tile_request_purpose_uses_stable_wire_values() {
        for (wire_value, expected) in [
            ("visible", ContactTileRequestPurpose::Visible),
            (
                "spatial_prefetch",
                ContactTileRequestPurpose::SpatialPrefetch,
            ),
            (
                "adjacent_prefetch",
                ContactTileRequestPurpose::AdjacentPrefetch,
            ),
            ("overview", ContactTileRequestPurpose::Overview),
            (
                "endpoint_evidence",
                ContactTileRequestPurpose::EndpointEvidence,
            ),
        ] {
            let parsed: ContactTileRequestPurpose =
                serde_json::from_str(format!("\"{wire_value}\"").as_str())
                    .expect("known contact tile purpose");
            assert_eq!(parsed, expected);
            assert_eq!(parsed.scenario_key(), wire_value);
        }
        assert!(serde_json::from_str::<ContactTileRequestPurpose>("\"unknown\"").is_err());
    }

    #[test]
    fn contact_tile_cache_identity_includes_source_resolution_and_normalization() {
        let raw = super::ContactTileCacheKey {
            path: "/tmp/input.cool".to_string(),
            source_resolution: 10_000,
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
        let coarser_source = super::ContactTileCacheKey {
            source_resolution: 2_500,
            ..raw.clone()
        };

        assert_ne!(raw, kr);
        assert_ne!(raw, coarser_source);
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
    fn background_tiles_join_only_the_started_generation_and_never_advance_it() {
        let state = super::ContactTileRequestState::default();
        state
            .retain_and_begin_generation(7, &[])
            .expect("visible generation begins");
        state
            .register_for_purpose(70, 7, ContactTileRequestPurpose::Visible)
            .expect("foreground request registers");
        for (request_id, purpose) in [
            (71, ContactTileRequestPurpose::SpatialPrefetch),
            (72, ContactTileRequestPurpose::AdjacentPrefetch),
            (73, ContactTileRequestPurpose::Overview),
            (76, ContactTileRequestPurpose::EndpointEvidence),
        ] {
            state
                .register_for_purpose(request_id, 7, purpose)
                .expect("background request joins the current generation");
        }

        assert!(!state.is_cancelled(70));
        assert!(!state.is_cancelled(71));
        assert_eq!(
            state
                .register_for_purpose(74, 8, ContactTileRequestPurpose::SpatialPrefetch)
                .expect_err("prefetch cannot advance the generation clock"),
            "contact tile request cancelled"
        );
        assert!(!state.is_cancelled(70));

        state
            .register_for_purpose(75, 8, ContactTileRequestPurpose::Visible)
            .expect("next visible request advances the generation");
        assert!(!state.is_cancelled(75));
        assert!(state.is_cancelled(70));
        assert!(state.is_cancelled(71));
        assert!(state.is_cancelled(72));
        assert!(state.is_cancelled(73));
        assert!(state.is_cancelled(76));
    }

    #[test]
    fn normalization_prewarm_yields_to_any_other_contact_request() {
        let state = super::ContactTileRequestState::default();
        state
            .retain_and_begin_generation(7, &[])
            .expect("visible generation begins");
        state
            .register_current_generation(80, 7)
            .expect("prewarm joins current generation");
        assert!(!state.is_normalization_prewarm_cancelled(80));

        state
            .register_for_purpose(81, 7, ContactTileRequestPurpose::Overview)
            .expect("foreground-related work joins current generation");
        assert!(state.is_normalization_prewarm_cancelled(80));

        state.finish(81);
        assert!(!state.is_normalization_prewarm_cancelled(80));
        state
            .retain_and_begin_generation(8, &[])
            .expect("new interaction advances generation");
        assert!(state.is_normalization_prewarm_cancelled(80));
    }

    #[test]
    fn cancelled_contact_tile_request_stops_before_io_or_cache_mutation() {
        let source_cache = Mutex::new(SourceContactCache::new(1024));
        let tile_cache = Mutex::new(HashMap::new());
        let request = super::resolve_contact_tile_request(
            ContactMapTilesFromCoolRequest {
                request_id: 1,
                generation: 1,
                purpose: ContactTileRequestPurpose::Visible,
                cool_path: "/path/that/does/not/exist.cool".to_string(),
                base_resolution: 1_000,
                source_resolution: None,
                target_resolution: 1_000,
                tile_size_bins: 256,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
                tiles: vec![ContactMapTileKeyRequest {
                    tile_x: 0,
                    tile_y: 0,
                }],
                layout_handle: None,
                layout_blocks: Vec::new(),
            },
            None,
        )
        .expect("legacy layout blocks should resolve");
        let result = super::get_contact_map_tiles_from_cool_with_cache_cancellable(
            request,
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
        let gfa_text = super::load_example_gfa_text().expect("example GFA should load");

        assert_eq!(summary.agp_lines, 1_177);
        assert_eq!(summary.agp_objects, 192);
        assert_eq!(summary.agp_components, 798);
        assert_eq!(summary.agp_gaps, 379);
        assert_eq!(summary.max_object_span, 31_529_557);
        assert!(summary.mcool_size_bytes > 1_000_000);
        let coverage_path = summary
            .coverage_path
            .as_deref()
            .expect("example coverage path");
        let paf_path = summary.paf_path.as_deref().expect("example PAF path");
        assert!(coverage_path.ends_with("examples/hifi.asm.bp.p_utg.noseq.depth"));
        assert!(paf_path.ends_with("examples/mono.hifi.asm.bp.p_utg.paf"));
        assert!(std::path::Path::new(coverage_path).is_absolute());
        assert!(std::path::Path::new(paf_path).is_absolute());
        assert!(std::path::Path::new(coverage_path).is_file());
        assert!(std::path::Path::new(paf_path).is_file());
        assert!(summary
            .cool_path
            .ends_with("examples/input.1k_allres.mcool"));
        assert!(summary
            .mcool_path
            .ends_with("examples/input.1k_allres.mcool"));
        assert_eq!(
            summary.available_resolutions,
            vec![
                2_500_000, 2_000_000, 1_000_000, 500_000, 250_000, 100_000, 50_000, 25_000, 10_000,
                5_000, 1_000,
            ],
        );
        assert!(!summary.contact_sources.is_empty());
        assert!(summary
            .contact_sources
            .iter()
            .all(|source| !source.name.is_empty() && source.length > 0));
        assert_eq!(summary.agp_layout.blocks.len(), 798);
        assert!(summary.agp_layout.total_span > summary.max_object_span);
        assert_eq!(summary.agp_layout.blocks[0].object_id, "Chr01g1");
        assert_eq!(summary.agp_layout.blocks[0].component_type, "W");
        assert_eq!(summary.agp_layout.blocks[0].gap_before, None);
        assert!(gfa_text.lines().any(|line| line.starts_with("S\t")));
        assert!(gfa_text.lines().any(|line| line.starts_with("L\t")));
        assert_eq!(
            summary.agp_layout.blocks[1].gap_before,
            Some(super::AgpGapMetadataResponse {
                component_type: "U".to_string(),
                length: 100,
                gap_type: "scaffold".to_string(),
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

    #[test]
    fn builds_example_overview_without_ordinary_contact_tiles() {
        let summary = super::load_example_dataset().expect("example dataset should load");
        let source_resolution = *summary
            .available_resolutions
            .last()
            .expect("example contact resolution");
        let total_span = summary.agp_layout.total_span;
        let target_resolution = total_span
            .div_ceil(320)
            .div_ceil(source_resolution)
            .saturating_mul(source_resolution);
        let layout_blocks = Arc::new(
            summary
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
        );
        let response = super::build_contact_map_overview_from_cool_inner(
            ContactMapOverviewFromCoolRequest {
                request_id: 1,
                generation: 1,
                cool_path: summary.cool_path,
                source_resolution,
                target_resolution,
                normalization: ContactNormalizationRequest::Raw,
                viewport: ContactMapViewportRequest {
                    x_start: 0,
                    x_end: total_span,
                    y_start: 0,
                    y_end: total_span,
                },
                layout_handle: None,
                layout_blocks: Vec::new(),
            },
            layout_blocks,
            &|| false,
        )
        .expect("dedicated overview should render");

        assert_eq!(response.source_resolution, source_resolution);
        assert_eq!(response.resolution, target_resolution);
        assert_eq!(response.viewport.x_end, total_span);
        assert!(!response.cells.is_empty());
        assert!(response.cells.len() <= 320 * 320);
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
                source_resolution: target_resolution,
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
                purpose: ContactTileRequestPurpose::Visible,
                cool_path: cool_path.clone(),
                base_resolution: target_resolution,
                source_resolution: None,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
                tiles: vec![unaffected_tile],
                layout_handle: None,
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
                source_resolution: target_resolution,
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
                purpose: ContactTileRequestPurpose::Visible,
                cool_path,
                base_resolution: target_resolution,
                source_resolution: None,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
                tiles: vec![affected_tile],
                layout_handle: None,
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
                source_resolution: target_resolution,
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
                purpose: ContactTileRequestPurpose::Visible,
                cool_path,
                base_resolution: 1_000,
                source_resolution: None,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
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
                layout_handle: None,
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
    fn spatial_prefetch_populates_visual_cache_for_visible_request() {
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
                purpose: ContactTileRequestPurpose::SpatialPrefetch,
                cool_path: summary.cool_path.clone(),
                base_resolution: 1_000,
                source_resolution: None,
                target_resolution: 10_000,
                tile_size_bins: 256,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
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
                layout_handle: None,
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
                purpose: ContactTileRequestPurpose::Visible,
                cool_path: summary.cool_path,
                base_resolution: 1_000,
                source_resolution: None,
                target_resolution: 10_000,
                tile_size_bins: 256,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
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
                layout_handle: None,
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
            let request = super::resolve_contact_tile_request(request, None)
                .expect("benchmark legacy layout blocks should resolve");
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
            purpose: ContactTileRequestPurpose::Visible,
            cool_path: summary.cool_path.clone(),
            base_resolution: 1_000,
            source_resolution: None,
            target_resolution,
            tile_size_bins,
            normalization: ContactNormalizationRequest::Raw,
            adaptive_refinement: false,
            tiles: vec![ContactMapTileKeyRequest { tile_x, tile_y }],
            layout_handle: None,
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
    #[ignore = "run explicitly against the local POJ benchmark dataset"]
    fn poj_whole_genome_lod_vs_tiles_release_benchmark() {
        assert!(
            !cfg!(debug_assertions)
                || std::env::var("CSTUDIO_POJ_ALLOW_DEV_BENCH").as_deref() == Ok("1"),
            "POJ contact-map timings require --release unless CSTUDIO_POJ_ALLOW_DEV_BENCH=1 is set for an explicitly optimized dev profile"
        );

        let scenario = std::env::var("CSTUDIO_POJ_BENCH_SCENARIO")
            .unwrap_or_else(|_| "overview_mcool".to_string());
        let sample_count = std::env::var("CSTUDIO_POJ_BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or_else(|| {
                if scenario.starts_with("overview_") {
                    5
                } else {
                    1
                }
            })
            .max(1);
        let benchmark_root = super::project_root()
            .parent()
            .expect("project checkout should have a benchmark parent")
            .join("benchmark/poj");
        let agp_path = std::env::var("CSTUDIO_POJ_BENCH_AGP")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| benchmark_root.join("groups.final.agp"));
        let cool_path = match scenario.as_str() {
            "overview_mcool" | "overview_mcool_cache" | "tiles_mcool" | "lod_tiles_mcool" | "delta_mcool_visible" | "display_cache_mcool" => std::env::var("CSTUDIO_POJ_BENCH_CONTACT")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| benchmark_root.join("input.q1.1k_allres.mcool")),
            "overview_cool" | "overview_cool_cache" | "tiles_cool" | "lod_tiles_cool" | "delta_cool" => std::env::var("CSTUDIO_POJ_BENCH_CONTACT")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| benchmark_root.join("input.q1.1k.cool")),
            other => panic!(
                "unknown CSTUDIO_POJ_BENCH_SCENARIO={other}; expected overview_mcool, overview_mcool_cache, overview_cool, overview_cool_cache, lod_tiles_mcool, lod_tiles_cool, tiles_mcool, delta_mcool_visible, display_cache_mcool, delta_cool, or tiles_cool"
            ),
        };

        let agp_text = fs::read_to_string(&agp_path).expect("POJ AGP should be readable");
        let layout = super::parse_agp_layout_for_response(&agp_text)
            .expect("POJ AGP should parse into a contact-map layout");
        let total_span = layout.total_span;
        let layout_blocks = Arc::new(
            layout
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
                .collect::<Vec<_>>(),
        );
        let viewport = ContactMapViewportRequest {
            x_start: 0,
            x_end: total_span,
            y_start: 0,
            y_end: total_span,
        };
        let source_resolution = if matches!(
            scenario.as_str(),
            "overview_mcool"
                | "overview_mcool_cache"
                | "tiles_mcool"
                | "lod_tiles_mcool"
                | "delta_mcool_visible"
                | "display_cache_mcool"
        ) {
            2_500_000
        } else {
            1_000
        };
        let target_bins = std::env::var("CSTUDIO_POJ_BENCH_TARGET_BINS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(320)
            .max(1);
        let raw_overview_resolution = total_span.div_ceil(target_bins);
        let overview_resolution = raw_overview_resolution
            .div_ceil(source_resolution)
            .saturating_mul(source_resolution);

        println!(
            "CSTUDIO_POJ_BENCH metadata scenario={} samples={} path={} total_span={} layout_blocks={} source_resolution={} overview_resolution={} target_bins={}",
            scenario,
            sample_count,
            cool_path.display(),
            total_span,
            layout_blocks.len(),
            source_resolution,
            overview_resolution,
            target_bins,
        );

        if scenario.starts_with("overview_") {
            if matches!(
                scenario.as_str(),
                "overview_cool_cache" | "overview_mcool_cache"
            ) {
                let cache_root = std::env::temp_dir().join(format!(
                    "cstudio-poj-lod-cache-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .expect("system time after epoch")
                        .as_nanos(),
                ));
                let request = ContactMapOverviewFromCoolRequest {
                    request_id: 99_999,
                    generation: 1,
                    cool_path: cool_path.to_string_lossy().into_owned(),
                    source_resolution,
                    target_resolution: overview_resolution,
                    normalization: ContactNormalizationRequest::Raw,
                    viewport: viewport.clone(),
                    layout_handle: None,
                    layout_blocks: Vec::new(),
                };
                let key = super::persistent_lod_cache_key(&request, layout_blocks.as_ref())
                    .expect("POJ persistent LOD key");
                let compute_started = Instant::now();
                let response = super::build_contact_map_overview_from_cool_inner(
                    request,
                    Arc::clone(&layout_blocks),
                    &|| false,
                )
                .expect("POJ overview cache miss should render");
                let compute_us = compute_started.elapsed().as_micros();
                let payload = super::lod_payload_from_contact_overview(&response);
                let write_started = Instant::now();
                let path = crate::contact_lod_cache::store_atomic(&cache_root, &key, &payload)
                    .expect("POJ persistent LOD should store");
                println!(
                    "CSTUDIO_POJ_BENCH result scenario={} phase=miss compute_us={} write_us={} cache_bytes={} response_cells={}",
                    scenario,
                    compute_us,
                    write_started.elapsed().as_micros(),
                    fs::metadata(path).map_or(0, |metadata| metadata.len()),
                    response.cells.len(),
                );
                for sample in 0..sample_count {
                    let load_started = Instant::now();
                    let cached = crate::contact_lod_cache::load(&cache_root, &key)
                        .expect("POJ persistent LOD should read")
                        .expect("POJ persistent LOD should hit");
                    let cached = super::contact_overview_response_from_lod_payload(cached);
                    println!(
                        "CSTUDIO_POJ_BENCH result scenario={} phase=hit sample={} load_us={} response_cells={}",
                        scenario,
                        sample + 1,
                        load_started.elapsed().as_micros(),
                        cached.cells.len(),
                    );
                    assert_eq!(cached, response);
                }
                fs::remove_dir_all(cache_root).expect("remove POJ temporary LOD cache");
                return;
            }
            for sample in 0..sample_count {
                let started = Instant::now();
                let response = super::build_contact_map_overview_from_cool_inner(
                    ContactMapOverviewFromCoolRequest {
                        request_id: 100_000 + sample as u64,
                        generation: 1,
                        cool_path: cool_path.to_string_lossy().into_owned(),
                        source_resolution,
                        target_resolution: overview_resolution,
                        normalization: ContactNormalizationRequest::Raw,
                        viewport: viewport.clone(),
                        layout_handle: None,
                        layout_blocks: Vec::new(),
                    },
                    Arc::clone(&layout_blocks),
                    &|| false,
                )
                .expect("POJ overview should render");
                println!(
                    "CSTUDIO_POJ_BENCH result scenario={} sample={} total_us={} response_cells={} target_bins={}",
                    scenario,
                    sample + 1,
                    started.elapsed().as_micros(),
                    response.cells.len(),
                    total_span.div_ceil(response.resolution),
                );
            }
            return;
        }

        let tile_size_bins = 256_u64;
        let target_resolution =
            if scenario.starts_with("lod_tiles_") || scenario == "display_cache_mcool" {
                std::env::var("CSTUDIO_POJ_BENCH_TARGET_RESOLUTION")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or_else(|| {
                        total_span
                            .div_ceil(640)
                            .div_ceil(source_resolution)
                            .saturating_mul(source_resolution)
                    })
                    .max(source_resolution)
            } else if scenario == "delta_mcool_visible" {
                std::env::var("CSTUDIO_POJ_BENCH_TARGET_RESOLUTION")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(25_000)
                    .max(1)
            } else {
                2_500_000
            };
        let mut tiles = if scenario == "delta_mcool_visible" {
            let viewport = std::env::var("CSTUDIO_POJ_BENCH_VIEWPORT")
                .unwrap_or_else(|_| "5316000000,5401000000,4882000000,4963000000".to_string())
                .split(',')
                .map(|value| value.parse::<u64>().expect("POJ viewport coordinate"))
                .collect::<Vec<_>>();
            assert_eq!(
                viewport.len(),
                4,
                "POJ viewport requires x_start,x_end,y_start,y_end"
            );
            let tile_span = target_resolution.saturating_mul(tile_size_bins);
            let x_start = viewport[0] / tile_span;
            let x_end = viewport[1].saturating_sub(1) / tile_span;
            let y_start = viewport[2] / tile_span;
            let y_end = viewport[3].saturating_sub(1) / tile_span;
            let mut visible = BTreeSet::new();
            for tile_y in y_start..=y_end {
                for tile_x in x_start..=x_end {
                    visible.insert(if tile_x <= tile_y {
                        (tile_x, tile_y)
                    } else {
                        (tile_y, tile_x)
                    });
                }
            }
            visible
                .into_iter()
                .map(|(tile_x, tile_y)| ContactMapTileKeyRequest { tile_x, tile_y })
                .collect::<Vec<_>>()
        } else {
            let axis_tiles = total_span.div_ceil(target_resolution.saturating_mul(tile_size_bins));
            let center = axis_tiles as f64 / 2.0;
            let mut whole_genome = (0..axis_tiles)
                .flat_map(|tile_y| {
                    (0..=tile_y).map(move |tile_x| ContactMapTileKeyRequest { tile_x, tile_y })
                })
                .collect::<Vec<_>>();
            whole_genome.sort_by(|left, right| {
                let distance = |tile: &ContactMapTileKeyRequest| {
                    let x = tile.tile_x as f64 + 0.5 - center;
                    let y = tile.tile_y as f64 + 0.5 - center;
                    x * x + y * y
                };
                distance(left)
                    .total_cmp(&distance(right))
                    .then_with(|| left.tile_y.cmp(&right.tile_y))
                    .then_with(|| left.tile_x.cmp(&right.tile_x))
            });
            assert_eq!(whole_genome.len() as u64, axis_tiles * (axis_tiles + 1) / 2);
            whole_genome
        };
        if let Some(tile_limit) = std::env::var("CSTUDIO_POJ_BENCH_TILE_LIMIT")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
        {
            tiles.truncate(tile_limit.max(1));
        }

        if scenario == "display_cache_mcool" {
            let cache_root = std::env::temp_dir().join(format!(
                "cstudio-display-benchmark-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system time after epoch")
                    .as_nanos(),
            ));
            let context = super::PersistentDisplayCacheContext {
                global_root: cache_root.clone(),
                dataset_root: cache_root.join("dataset"),
                file_fingerprint: cool_path.to_string_lossy().as_bytes().to_vec(),
            };
            let request = super::ResolvedContactMapTilesFromCoolRequest {
                request: ContactMapTilesFromCoolRequest {
                    request_id: 195_000,
                    generation: 1,
                    purpose: ContactTileRequestPurpose::Visible,
                    cool_path: cool_path.to_string_lossy().into_owned(),
                    base_resolution: source_resolution,
                    source_resolution: Some(source_resolution),
                    target_resolution,
                    tile_size_bins,
                    normalization: ContactNormalizationRequest::Raw,
                    adaptive_refinement: false,
                    tiles: tiles.clone(),
                    layout_handle: None,
                    layout_blocks: Vec::new(),
                },
                layout_blocks: Arc::clone(&layout_blocks),
            };
            let plans = super::persistent_display_tile_plans(&context, &request)
                .expect("display cache benchmark keys");
            let mut accumulator =
                super::PersistentDisplayTileAccumulator::new(tile_size_bins, &plans)
                    .expect("display cache benchmark accumulator");
            let cold_started = Instant::now();
            let stats = super::compute_contact_tile_deltas_single_scan(
                request.clone(),
                &|| false,
                |delta_tiles| {
                    if !delta_tiles.is_empty() {
                        accumulator.merge(delta_tiles)?;
                    }
                    Ok(super::encode_contact_map_tiles_binary_v1(
                        delta_tiles,
                        tile_size_bins,
                        &|| false,
                    )?
                    .len())
                },
            )
            .expect("display cache cold render");
            let cold_us = cold_started.elapsed().as_micros();
            let pending = accumulator
                .finish(&plans)
                .expect("display cache terminal payloads");
            let expected_values = pending
                .iter()
                .map(|entry| {
                    (
                        (entry.tile.tile_x, entry.tile.tile_y),
                        entry.tile.float32_values().into_owned(),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            let write_started = Instant::now();
            let mut cache_bytes = 0_u64;
            for entry in pending {
                let path = crate::contact_display_cache::store_atomic_with_format(
                    &context.dataset_root,
                    &entry.key,
                    &entry.tile,
                    super::persistent_display_cache_storage_format(),
                )
                .expect("display cache benchmark store");
                cache_bytes = cache_bytes
                    .saturating_add(fs::metadata(path).map_or(0, |metadata| metadata.len()));
            }
            let write_us = write_started.elapsed().as_micros();
            println!(
                "CSTUDIO_POJ_BENCH result scenario={} phase=miss compute_us={} write_us={} cache_bytes={} requested_tiles={} response_cells={} visited_contacts={}",
                scenario,
                cold_us,
                write_us,
                cache_bytes,
                tiles.len(),
                stats.response_cells,
                stats.visited_contacts,
            );
            for sample in 0..sample_count {
                let hit_started = Instant::now();
                let (cached, missing, cache_stats) = super::load_persistent_display_tiles(
                    &context,
                    &request,
                    plans.clone(),
                    &|| false,
                )
                .expect("display cache benchmark warm load");
                assert!(missing.is_empty());
                let mut quantized_values = 0_usize;
                let mut maximum_absolute_error = 0.0_f64;
                let mut maximum_relative_error = 0.0_f64;
                for tile in &cached {
                    let expected = expected_values
                        .get(&(tile.tile_x, tile.tile_y))
                        .expect("display cache benchmark expected tile");
                    let actual = tile.float32_values();
                    assert_eq!(actual.len(), expected.len());
                    for (actual, expected) in actual.iter().zip(expected.iter()) {
                        if *expected == -1.0 {
                            assert_eq!(*actual, -1.0);
                            continue;
                        }
                        let absolute_error = f64::from((*actual - *expected).abs());
                        if absolute_error > 0.0 {
                            quantized_values = quantized_values.saturating_add(1);
                            maximum_absolute_error = maximum_absolute_error.max(absolute_error);
                            if *expected != 0.0 {
                                maximum_relative_error = maximum_relative_error
                                    .max(absolute_error / f64::from(expected.abs()));
                            }
                        }
                    }
                }
                let bytes = super::encode_contact_map_dense_tiles_binary_v1(
                    &cached,
                    tile_size_bins,
                    &|| false,
                )
                .expect("display cache benchmark warm encode")
                .len();
                println!(
                    "CSTUDIO_POJ_BENCH result scenario={} phase=hit sample={} total_us={} read_us={} hits={} response_cells={} response_bytes={} quantized_values={} max_abs_error={:.6} max_relative_error={:.9}",
                    scenario,
                    sample + 1,
                    hit_started.elapsed().as_micros(),
                    cache_stats.read.as_micros(),
                    cache_stats.hits,
                    cached
                        .iter()
                        .map(crate::contact_display_cache::DisplayCacheTile::occupied_count)
                        .sum::<usize>(),
                    bytes,
                    quantized_values,
                    maximum_absolute_error,
                    maximum_relative_error,
                );
            }
            fs::remove_dir_all(cache_root).expect("remove display cache benchmark directory");
            return;
        }

        if scenario == "delta_cool" || scenario == "delta_mcool_visible" {
            for sample in 0..sample_count {
                let request = super::ResolvedContactMapTilesFromCoolRequest {
                    request: ContactMapTilesFromCoolRequest {
                        request_id: 190_000 + sample as u64,
                        generation: 1,
                        purpose: ContactTileRequestPurpose::Visible,
                        cool_path: cool_path.to_string_lossy().into_owned(),
                        base_resolution: 1_000,
                        source_resolution: None,
                        target_resolution,
                        tile_size_bins,
                        normalization: ContactNormalizationRequest::Raw,
                        adaptive_refinement: false,
                        tiles: tiles.clone(),
                        layout_handle: None,
                        layout_blocks: Vec::new(),
                    },
                    layout_blocks: Arc::clone(&layout_blocks),
                };
                let started = Instant::now();
                let mut aggregate = BTreeMap::<(u64, u64, u64, u64), f64>::new();
                let stats = super::compute_contact_tile_deltas_single_scan(
                    request,
                    &|| false,
                    |delta_tiles| {
                        for tile in delta_tiles {
                            for cell in &tile.cells {
                                *aggregate
                                    .entry((tile.tile_x, tile.tile_y, cell.x_bin, cell.y_bin))
                                    .or_insert(0.0) += cell.count;
                            }
                        }
                        Ok(super::encode_contact_map_tiles_binary_v1(
                            delta_tiles,
                            tile_size_bins,
                            &|| false,
                        )?
                        .len())
                    },
                )
                .expect("POJ single-scan deltas should render");
                let final_count = aggregate.values().copied().sum::<f64>();
                println!(
                    "CSTUDIO_POJ_BENCH result scenario={} sample={} total_us={} requested_tiles={} emitted_chunks={} first_emit_us={} response_delta_cells={} final_cells={} final_count={} response_bytes={} indexed_visitor={} first_emit_cell_threshold={} emit_cell_threshold={} hdf5_chunks={} scanned_pixels={} visited_contacts={} prepare_us={} hdf5_read_us={} scan_project_us={} finish_chunk_us={} encode_send_us={}",
                    scenario,
                    sample + 1,
                    started.elapsed().as_micros(),
                    tiles.len(),
                    stats.emitted_chunks,
                    stats.first_emit_us.unwrap_or(0),
                    stats.response_cells,
                    aggregate.len(),
                    final_count,
                    stats.response_bytes,
                    stats.indexed_visitor,
                    stats.first_emit_cell_threshold,
                    stats.emit_cell_threshold,
                    stats.visit_timings.hdf5_chunks,
                    stats.visit_timings.scanned_pixels,
                    stats.visited_contacts,
                    stats.visit_timings.prepare.as_micros(),
                    stats.visit_timings.hdf5_read.as_micros(),
                    stats.visit_timings.scan_project.as_micros(),
                    stats.visit_timings.finish_chunk.as_micros(),
                    stats.encode_send.as_micros(),
                );
            }
            return;
        }

        let source_cache = Mutex::new(SourceContactCache::new(256 * 1024 * 1024));
        if scenario.starts_with("lod_tiles_") {
            let chunks = tiles
                .chunks(2)
                .map(|chunk| chunk.to_vec())
                .collect::<Vec<_>>();
            for sample in 0..sample_count {
                let visual_cache = Mutex::new(HashMap::new());
                let request = super::ResolvedContactMapTilesFromCoolRequest {
                    request: ContactMapTilesFromCoolRequest {
                        request_id: 195_000 + sample as u64,
                        generation: 1,
                        purpose: ContactTileRequestPurpose::Visible,
                        cool_path: cool_path.to_string_lossy().into_owned(),
                        base_resolution: source_resolution,
                        source_resolution: Some(source_resolution),
                        target_resolution,
                        tile_size_bins,
                        normalization: ContactNormalizationRequest::Raw,
                        adaptive_refinement: false,
                        tiles: tiles.clone(),
                        layout_handle: None,
                        layout_blocks: Vec::new(),
                    },
                    layout_blocks: Arc::clone(&layout_blocks),
                };
                let started = Instant::now();
                if std::env::var("CSTUDIO_POJ_BENCH_LOD_DELTA").as_deref() == Ok("1") {
                    let mut aggregate = BTreeMap::<(u64, u64, u64, u64), f64>::new();
                    let stats = super::compute_contact_tile_deltas_single_scan(
                        request,
                        &|| false,
                        |delta_tiles| {
                            for tile in delta_tiles {
                                for cell in &tile.cells {
                                    *aggregate
                                        .entry((tile.tile_x, tile.tile_y, cell.x_bin, cell.y_bin))
                                        .or_insert(0.0) += cell.count;
                                }
                            }
                            super::encode_contact_map_tiles_binary_v1(
                                delta_tiles,
                                tile_size_bins,
                                &|| false,
                            )
                            .map(|bytes| bytes.len())
                        },
                    )
                    .expect("POJ tiled LOD delta stream should render");
                    println!(
                        "CSTUDIO_POJ_BENCH result scenario={} mode=delta sample={} total_us={} first_batch_us={} requested_tiles={} returned_tiles={} batches={} response_cells={} response_count={} response_bytes={}",
                        scenario,
                        sample + 1,
                        started.elapsed().as_micros(),
                        stats.first_emit_us.unwrap_or(0),
                        tiles.len(),
                        tiles.len(),
                        stats.emitted_chunks,
                        aggregate.len(),
                        aggregate.values().sum::<f64>(),
                        stats.response_bytes,
                    );
                    continue;
                }
                let mut first_chunk_us = None;
                let mut response_count = 0_f64;
                let (returned_tiles, response_cells, response_bytes) =
                    super::compute_contact_tile_chunks_progressively(
                        request,
                        &chunks,
                        &source_cache,
                        &visual_cache,
                        &|| false,
                        started,
                        |chunk| {
                            first_chunk_us.get_or_insert_with(|| started.elapsed().as_micros());
                            response_count += chunk
                                .iter()
                                .flat_map(|tile| tile.cells.iter())
                                .map(|cell| cell.count)
                                .sum::<f64>();
                            super::encode_contact_map_tiles_binary_v1(
                                chunk,
                                tile_size_bins,
                                &|| false,
                            )
                            .map(|bytes| bytes.len())
                        },
                    )
                    .expect("POJ tiled LOD should render progressively");
                println!(
                    "CSTUDIO_POJ_BENCH result scenario={} sample={} total_us={} first_batch_us={} requested_tiles={} returned_tiles={} batches={} response_cells={} response_count={} response_bytes={}",
                    scenario,
                    sample + 1,
                    started.elapsed().as_micros(),
                    first_chunk_us.unwrap_or(0),
                    tiles.len(),
                    returned_tiles,
                    chunks.len(),
                    response_cells,
                    response_count,
                    response_bytes,
                );
            }
            return;
        }

        let request_batch_size = 8;
        for sample in 0..sample_count {
            // A new visual cache models a new whole-genome generation while the
            // process-level source/adaptive caches remain warm after sample 1.
            let visual_cache = Mutex::new(HashMap::new());
            let started = Instant::now();
            let mut response_cells = 0_usize;
            let mut response_count = 0_f64;
            let mut returned_tiles = 0_usize;
            let mut cool_read_us = 0_u128;
            let mut projection_us = 0_u128;
            let mut first_batch_us = None;
            for (batch_index, batch) in tiles.chunks(request_batch_size).enumerate() {
                let request = super::ResolvedContactMapTilesFromCoolRequest {
                    request: ContactMapTilesFromCoolRequest {
                        request_id: 200_000 + sample as u64 * 1_000 + batch_index as u64,
                        generation: 1,
                        purpose: ContactTileRequestPurpose::Visible,
                        cool_path: cool_path.to_string_lossy().into_owned(),
                        base_resolution: if scenario.starts_with("lod_tiles_") {
                            source_resolution
                        } else {
                            1_000
                        },
                        source_resolution: scenario
                            .starts_with("lod_tiles_")
                            .then_some(source_resolution),
                        target_resolution,
                        tile_size_bins,
                        normalization: ContactNormalizationRequest::Raw,
                        adaptive_refinement: tiles.len() <= super::MAX_ADAPTIVE_MCOOL_EXACT_TILES,
                        tiles: batch.to_vec(),
                        layout_handle: None,
                        layout_blocks: Vec::new(),
                    },
                    layout_blocks: Arc::clone(&layout_blocks),
                };
                let (result, timings) = super::profile_contact_tile_request(
                    request,
                    &source_cache,
                    &visual_cache,
                    &|| false,
                );
                let batch_tiles = result.expect("POJ ordinary tile batch should render");
                response_cells += batch_tiles
                    .iter()
                    .map(|tile| tile.cells.len())
                    .sum::<usize>();
                response_count += batch_tiles
                    .iter()
                    .flat_map(|tile| tile.cells.iter())
                    .map(|cell| cell.count)
                    .sum::<f64>();
                returned_tiles += batch_tiles.len();
                cool_read_us += timings.cool_read.get().as_micros();
                projection_us += timings.projection.get().as_micros();
                if first_batch_us.is_none() {
                    first_batch_us = Some(started.elapsed().as_micros());
                }
            }
            println!(
                "CSTUDIO_POJ_BENCH result scenario={} sample={} total_us={} first_batch_us={} requested_tiles={} returned_tiles={} batches={} response_cells={} response_count={} cool_read_us={} projection_us={}",
                scenario,
                sample + 1,
                started.elapsed().as_micros(),
                first_batch_us.unwrap_or(0),
                tiles.len(),
                returned_tiles,
                tiles.len().div_ceil(request_batch_size),
                response_cells,
                response_count,
                cool_read_us,
                projection_us,
            );
        }
    }

    #[test]
    fn coarse_tiles_read_an_explicit_mcool_source_resolution() {
        let summary = super::load_example_dataset().expect("example dataset should load");
        let layout_blocks = summary
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
        let source_cache = Mutex::new(SourceContactCache::new(16 * 1024 * 1024));
        let tile_cache = Mutex::new(HashMap::new());
        let response = super::get_contact_map_tiles_from_cool_with_cache(
            ContactMapTilesFromCoolRequest {
                request_id: 2,
                generation: 1,
                purpose: ContactTileRequestPurpose::Visible,
                cool_path: summary.cool_path,
                base_resolution: 1_000,
                source_resolution: Some(1_000),
                // This synthetic LOD level is intentionally absent from the
                // .mcool hierarchy; contacts must come from the 1 kb group.
                target_resolution: 7_000,
                tile_size_bins: 256,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
                tiles: vec![ContactMapTileKeyRequest {
                    tile_x: 0,
                    tile_y: 0,
                }],
                layout_handle: None,
                layout_blocks,
            },
            &source_cache,
            &tile_cache,
        )
        .expect("coarse tile should aggregate from the explicit stored source group");

        assert_eq!(response.len(), 1);
        assert_eq!((response[0].tile_x, response[0].tile_y), (0, 0));
        assert!(!response[0].cells.is_empty());
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
                purpose: ContactTileRequestPurpose::Visible,
                cool_path: summary.cool_path.clone(),
                base_resolution: 1_000,
                source_resolution: None,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
                tiles: vec![ContactMapTileKeyRequest {
                    tile_x: 0,
                    tile_y: 0,
                }],
                layout_handle: None,
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
                purpose: ContactTileRequestPurpose::Visible,
                cool_path: summary.cool_path,
                base_resolution: 1_000,
                source_resolution: None,
                target_resolution,
                tile_size_bins,
                normalization: ContactNormalizationRequest::Raw,
                adaptive_refinement: false,
                tiles: vec![ContactMapTileKeyRequest {
                    tile_x: 1,
                    tile_y: 1,
                }],
                layout_handle: None,
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
                    .join("examples/hifi.asm.bp.p_utg.noseq.depth")
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
                    source_id: "utg000001l".to_string(),
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
                    .join("examples/hifi.asm.bp.p_utg.noseq.depth")
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
                    source_id: "utg000001l".to_string(),
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
