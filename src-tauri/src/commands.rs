use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

use cstudio_core::contact_cache::{ContactCache, ContactCacheKey};
use cstudio_core::coverage_cache::{CoverageCache, CoverageCacheKey};
use cstudio_core::source_contact_cache::{
    source_windows_for_ranges, SourceContactCache, DEFAULT_SOURCE_CONTACT_CACHE_BYTES,
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
    layout_fingerprint: String,
    tile_x: u64,
    tile_y: u64,
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
pub struct ContactMapLayoutBlockResponse {
    pub id: String,
    pub source_id: String,
    pub source_start: u64,
    pub source_end: u64,
    pub visual_start: u64,
    pub orientation: String,
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
    pub viewport: ContactMapViewportRequest,
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactMapTilesFromCoolRequest {
    pub cool_path: String,
    pub base_resolution: u64,
    pub target_resolution: u64,
    pub tile_size_bins: u64,
    pub tiles: Vec<ContactMapTileKeyRequest>,
    pub layout_blocks: Vec<ContactMapLayoutBlockRequest>,
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
    let contact_name = contact_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("input.q1.1k.cool");

    Ok(ExampleDatasetSummary {
        agp_path: "examples/groups.agp".to_string(),
        mcool_path: format!("examples/{contact_name}"),
        cool_path: contact_path.to_string_lossy().to_string(),
        agp_lines: agp_summary.line_count,
        agp_objects: agp_summary.object_count,
        agp_components: agp_summary.component_count,
        agp_gaps: agp_summary.gap_count,
        max_object_span: agp_summary.max_object_span,
        mcool_size_bytes,
        coverage_path: None,
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
pub async fn get_contact_map_tiles_from_cool(
    request: ContactMapTilesFromCoolRequest,
    source_cache_state: tauri::State<'_, SourceContactCacheState>,
    tile_cache_state: tauri::State<'_, ContactTileCacheState>,
) -> Result<Vec<ContactMapTileResponse>, String> {
    let source_cache = Arc::clone(&source_cache_state.inner().cache);
    let tile_cache = Arc::clone(&tile_cache_state.inner().cache);
    tauri::async_runtime::spawn_blocking(move || {
        get_contact_map_tiles_from_cool_with_cache(
            request,
            source_cache.as_ref(),
            tile_cache.as_ref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn get_contact_map_tiles_from_cool_with_cache(
    mut request: ContactMapTilesFromCoolRequest,
    source_cache: &Mutex<SourceContactCache>,
    tile_cache: &Mutex<HashMap<ContactTileCacheKey, ContactMapTileResponse>>,
) -> Result<Vec<ContactMapTileResponse>, String> {
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

    if request.tiles.is_empty() {
        return Ok(Vec::new());
    }

    let layout_fingerprint = contact_layout_fingerprint(&request.layout_blocks);
    let requested_tile_keys = request
        .tiles
        .iter()
        .map(|tile| ContactTileCacheKey {
            path: request.cool_path.clone(),
            resolution: request.target_resolution,
            tile_size_bins: request.tile_size_bins,
            layout_fingerprint: layout_fingerprint.clone(),
            tile_x: tile.tile_x,
            tile_y: tile.tile_y,
        })
        .collect::<Vec<_>>();

    let mut cached_tiles = BTreeMap::new();
    let mut missing_tiles = Vec::new();
    {
        let tile_cache = tile_cache
            .lock()
            .map_err(|_| "contact tile cache lock poisoned".to_string())?;
        for (tile, key) in request.tiles.iter().zip(requested_tile_keys.iter()) {
            if let Some(cached_tile) = tile_cache.get(key) {
                cached_tiles.insert((tile.tile_x, tile.tile_y), cached_tile.clone());
            } else {
                missing_tiles.push(tile.clone());
            }
        }
    }

    if missing_tiles.is_empty() {
        return Ok(request
            .tiles
            .into_iter()
            .filter_map(|tile| cached_tiles.remove(&(tile.tile_x, tile.tile_y)))
            .collect());
    }

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
    let tile_span = request.tile_size_bins * request.target_resolution;
    let viewport = ContactMapViewportRequest {
        x_start: min_tile_x * tile_span,
        x_end: (max_tile_x + 1) * tile_span,
        y_start: min_tile_y * tile_span,
        y_end: (max_tile_y + 1) * tile_span,
    };

    let source_ranges = source_ranges_for_contact_viewport(&viewport, &request.layout_blocks);
    let query = contact_map_query_from_parts(
        request.base_resolution,
        request.target_resolution,
        viewport,
        request.layout_blocks.clone(),
    )?;
    let source_windows = source_windows_for_ranges(&source_ranges, tile_span);
    let source_cache_path = fs::metadata(&request.cool_path)
        .map(|metadata| {
            let modified_nanos = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            format!(
                "{}|{}|{}",
                request.cool_path,
                metadata.len(),
                modified_nanos
            )
        })
        .unwrap_or_else(|_| request.cool_path.clone());
    const MAX_CACHE_PAIRS_PER_REQUEST: usize = 16_384;
    let pair_count = source_windows
        .len()
        .checked_mul(source_windows.len().saturating_add(1))
        .and_then(|value| value.checked_div(2))
        .unwrap_or(usize::MAX);
    let cacheable = pair_count <= MAX_CACHE_PAIRS_PER_REQUEST;
    let source_cache_keys = cacheable.then(|| {
        SourceContactCache::keys_for_windows(
            &source_cache_path,
            request.target_resolution,
            &source_windows,
        )
    });

    let cached_view = if let Some(keys) = source_cache_keys.as_ref() {
        source_cache
            .lock()
            .map_err(|_| "source contact cache lock poisoned".to_string())?
            .build_cached_view(keys, &query)
            .map_err(|error| error.to_string())?
    } else {
        None
    };

    let view = if let Some(view) = cached_view {
        view
    } else if source_ranges.is_empty() {
        cstudio_core::contact_map::build_contact_map_view(&query, Vec::new())
            .map_err(|error| error.to_string())?
    } else {
        let read_ranges = if cacheable {
            source_windows
                .iter()
                .map(|window| (window.source_id.clone(), window.start, window.end))
                .collect::<Vec<_>>()
        } else {
            source_ranges.clone()
        };
        let contacts = cstudio_core::cool::read_cool_contacts_for_source_ranges_at_resolution(
            &request.cool_path,
            &read_ranges,
            Some(request.target_resolution),
        )
        .map_err(|error| error.to_string())?;

        if let Some(keys) = source_cache_keys.as_ref() {
            let mut source_cache = source_cache
                .lock()
                .map_err(|_| "source contact cache lock poisoned".to_string())?;
            source_cache.insert_contacts_for_windows(
                &source_cache_path,
                request.target_resolution,
                &source_windows,
                &contacts,
            );
            if let Some(view) = source_cache
                .build_cached_view(keys, &query)
                .map_err(|error| error.to_string())?
            {
                view
            } else {
                cstudio_core::contact_map::build_contact_map_view(&query, contacts)
                    .map_err(|error| error.to_string())?
            }
        } else {
            cstudio_core::contact_map::build_contact_map_view(&query, contacts)
                .map_err(|error| error.to_string())?
        }
    };
    let response = contact_map_response_from_view(view)?;
    let missing = missing_tiles
        .into_iter()
        .map(|tile| (tile.tile_x, tile.tile_y))
        .collect::<std::collections::BTreeSet<_>>();

    let mut response_tiles = response
        .tiles
        .into_iter()
        .filter(|tile| missing.contains(&(tile.tile_x, tile.tile_y)))
        .map(|tile| ((tile.tile_x, tile.tile_y), tile.cells))
        .collect::<std::collections::BTreeMap<_, _>>();

    {
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
        for (tile_x, tile_y) in missing {
            let tile = ContactMapTileResponse {
                tile_x,
                tile_y,
                cells: response_tiles.remove(&(tile_x, tile_y)).unwrap_or_default(),
            };
            tile_cache.insert(
                ContactTileCacheKey {
                    path: request.cool_path.clone(),
                    resolution: request.target_resolution,
                    tile_size_bins: request.tile_size_bins,
                    layout_fingerprint: layout_fingerprint.clone(),
                    tile_x,
                    tile_y,
                },
                tile.clone(),
            );
            cached_tiles.insert((tile_x, tile_y), tile);
        }
    }

    Ok(request
        .tiles
        .into_iter()
        .filter_map(|tile| cached_tiles.remove(&(tile.tile_x, tile.tile_y)))
        .collect())
}

fn build_contact_map_view_from_cool_with_cache(
    request: ContactMapViewFromCoolRequest,
    cache: &Mutex<ContactCache>,
) -> Result<ContactMapViewResponse, String> {
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
        path: request.cool_path,
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

    let contacts = cstudio_core::cool::read_cool_contacts_for_sources_at_resolution(
        &key.path,
        &key.source_ids,
        Some(key.resolution),
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

fn contact_layout_fingerprint(layout_blocks: &[ContactMapLayoutBlockRequest]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for block in layout_blocks {
        block.id.hash(&mut hasher);
        block.source_id.hash(&mut hasher);
        block.source_start.hash(&mut hasher);
        block.source_end.hash(&mut hasher);
        block.visual_start.hash(&mut hasher);
        block.orientation.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

fn source_ranges_for_contact_viewport(
    viewport: &ContactMapViewportRequest,
    layout_blocks: &[ContactMapLayoutBlockRequest],
) -> Vec<(String, u64, u64)> {
    let visual_start = viewport.x_start.min(viewport.y_start);
    let visual_end = viewport.x_end.max(viewport.y_end);
    let mut ranges = Vec::new();

    for block in layout_blocks {
        let block_span = block.source_end.saturating_sub(block.source_start);
        let block_visual_start = block.visual_start;
        let block_visual_end = block.visual_start.saturating_add(block_span);
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

        ranges.push((block.source_id.clone(), source_start, source_end));
    }

    ranges.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });

    let mut merged: Vec<(String, u64, u64)> = Vec::new();
    for (source_id, source_start, source_end) in ranges {
        if let Some((last_source_id, _last_start, last_end)) = merged.last_mut() {
            if *last_source_id == source_id && source_start <= *last_end {
                *last_end = (*last_end).max(source_end);
                continue;
            }
        }
        merged.push((source_id, source_start, source_end));
    }

    merged
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
    let tile_size_bins = 256;
    let cells = view
        .cells
        .into_iter()
        .map(|cell| ContactMapCellResponse {
            x_bin: cell.x_bin,
            y_bin: cell.y_bin,
            count: cell.count,
        })
        .collect::<Vec<_>>();
    let mut tiles_by_key =
        std::collections::BTreeMap::<(u64, u64), Vec<ContactMapCellResponse>>::new();

    for cell in cells.iter().cloned() {
        tiles_by_key
            .entry((cell.x_bin / tile_size_bins, cell.y_bin / tile_size_bins))
            .or_default()
            .push(cell);
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
        tiles: tiles_by_key
            .into_iter()
            .map(|((tile_x, tile_y), cells)| ContactMapTileResponse {
                tile_x,
                tile_y,
                cells,
            })
            .collect(),
    })
}

fn parse_agp_layout_for_response(text: &str) -> Result<AgpLayoutResponse, String> {
    let mut object_offsets = std::collections::HashMap::<String, u64>::new();
    let mut object_order = Vec::<String>::new();
    let mut object_ends = std::collections::HashMap::<String, u64>::new();
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
            source_id: columns[5].to_string(),
            source_start: component_start,
            source_end: component_end,
            visual_start: object_offsets.get(&object_id).copied().unwrap_or(0) + object_start,
            orientation: normalize_agp_orientation(columns[8]).to_string(),
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
        "?" | "unknown" | "Unknown" => Ok(cstudio_core::agp::Orientation::Unknown),
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
    use std::collections::HashMap;
    use std::sync::Mutex;

    use cstudio_core::{
        contact_cache::ContactCache, coverage_cache::CoverageCache,
        source_contact_cache::SourceContactCache,
    };

    use super::{
        build_contact_map_view, build_coverage_view, build_coverage_view_from_bedgraph_with_cache,
        build_synteny_view, get_app_status, BedGraphRecordRequest, ContactMapBinRequest,
        ContactMapLayoutBlockRequest, ContactMapTileKeyRequest, ContactMapTilesFromCoolRequest,
        ContactMapViewFromCoolRequest, ContactMapViewRequest, ContactMapViewportRequest,
        CoverageViewFromBedGraphRequest, CoverageViewRequest, PafRecordRequest, SyntenyViewRequest,
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
    fn loads_example_dataset_summary() {
        let summary = super::load_example_dataset().expect("example dataset should load");

        assert_eq!(summary.agp_lines, 2_576);
        assert_eq!(summary.agp_objects, 20);
        assert_eq!(summary.agp_components, 1_298);
        assert_eq!(summary.agp_gaps, 1_278);
        assert_eq!(summary.max_object_span, 30_436_571);
        assert!(summary.mcool_size_bytes > 1_000_000);
        assert!(
            summary.cool_path.ends_with("examples/input.q1.mcool")
                || summary.cool_path.ends_with("examples/input.q1.1k.cool")
        );
        assert_eq!(summary.agp_layout.blocks.len(), 1_298);
        assert!(summary.agp_layout.total_span > summary.max_object_span);
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
                cool_path: summary.cool_path.clone(),
                base_resolution: 1_000,
                target_resolution: 10_000,
                tile_size_bins: 256,
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
                cool_path: summary.cool_path,
                base_resolution: 1_000,
                target_resolution: 10_000,
                tile_size_bins: 256,
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
                cool_path: summary.cool_path.clone(),
                base_resolution: 1_000,
                target_resolution,
                tile_size_bins,
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
                cool_path: summary.cool_path,
                base_resolution: 1_000,
                target_resolution,
                tile_size_bins,
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
                ("ctg-forward".to_string(), 10_500, 16_500),
                ("ctg-reverse".to_string(), 38_500, 40_000),
            ]
        );
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
        assert_eq!(response.blocks[0].alignment_count, 2);
    }
}
