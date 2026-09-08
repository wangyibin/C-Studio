use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path as AxumPath, State},
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderMap, HeaderValue, Method, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use cstudio_core::{
    agp::Orientation,
    contact_map::{
        build_contact_map_view_from_contacts, ContactMapCell, ContactMapQuery, LayoutBlock,
        Viewport,
    },
    contact_normalization::ContactNormalization,
    cool::{
        list_contact_resolutions, list_contact_sources,
        read_cool_contacts_for_source_ranges_at_resolution_with_normalization,
        visit_cool_contact_chunks_indexed_for_source_ranges_at_resolution_with_normalization_cancellable,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};

const API_VERSION: u16 = 1;
const MAX_LAYOUT_BLOCKS: usize = 200_000;
const MAX_TILES_PER_REQUEST: usize = 256;
const MAX_TILE_SIZE_BINS: u64 = u16::MAX as u64 + 1;
const MAX_OVERVIEW_CELLS: u64 = 1_048_576;
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind: SocketAddr,
    pub dataset_specs: Vec<String>,
    pub token_file: Option<PathBuf>,
    pub allow_unauthenticated_remote: bool,
}

#[derive(Debug, Clone)]
struct AppState {
    datasets: Arc<BTreeMap<String, Arc<Dataset>>>,
    bearer_token: Option<Arc<str>>,
}

#[derive(Debug)]
struct Dataset {
    path: PathBuf,
    metadata: DatasetMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMetadata {
    pub api_version: u16,
    pub id: String,
    pub name: String,
    pub format: String,
    pub size_bytes: u64,
    pub available_resolutions: Vec<u64>,
    pub sources: Vec<ContactSourceMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContactSourceMetadata {
    pub name: String,
    pub length: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    api_version: u16,
    datasets: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatasetListResponse {
    api_version: u16,
    datasets: Vec<DatasetMetadata>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizationRequest {
    #[default]
    Raw,
    Ice,
    Kr,
    Vc,
    VcSqrt,
}

impl From<NormalizationRequest> for ContactNormalization {
    fn from(value: NormalizationRequest) -> Self {
        match value {
            NormalizationRequest::Raw => ContactNormalization::Raw,
            NormalizationRequest::Ice => ContactNormalization::Ice,
            NormalizationRequest::Kr => ContactNormalization::Kr,
            NormalizationRequest::Vc => ContactNormalization::Vc,
            NormalizationRequest::VcSqrt => ContactNormalization::VcSqrt,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileKeyRequest {
    pub tile_x: u64,
    pub tile_y: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportRequest {
    pub x_start: u64,
    pub x_end: u64,
    pub y_start: u64,
    pub y_end: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutBlockRequest {
    pub id: String,
    pub source_id: String,
    pub source_start: u64,
    pub source_end: u64,
    pub visual_start: u64,
    pub orientation: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileRequest {
    pub base_resolution: u64,
    #[serde(default)]
    pub source_resolution: Option<u64>,
    pub target_resolution: u64,
    pub tile_size_bins: u64,
    #[serde(default)]
    pub normalization: NormalizationRequest,
    pub tiles: Vec<TileKeyRequest>,
    pub layout_blocks: Vec<LayoutBlockRequest>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewRequest {
    pub source_resolution: u64,
    pub target_resolution: u64,
    #[serde(default)]
    pub normalization: NormalizationRequest,
    pub viewport: ViewportRequest,
    pub layout_blocks: Vec<LayoutBlockRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellResponse {
    pub x_bin: u64,
    pub y_bin: u64,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewResponse {
    pub source_resolution: u64,
    pub resolution: u64,
    pub viewport: ViewportRequest,
    pub cells: Vec<CellResponse>,
}

#[derive(Debug, Clone, PartialEq)]
struct TileResponse {
    tile_x: u64,
    tile_y: u64,
    cells: Vec<CellResponse>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: "missing or invalid bearer token".to_string(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: self.message,
            }),
        )
            .into_response()
    }
}

pub async fn serve(config: ServerConfig) -> Result<(), Box<dyn std::error::Error>> {
    let state = build_state(&config)?;
    if !config.bind.ip().is_loopback()
        && state.bearer_token.is_none()
        && !config.allow_unauthenticated_remote
    {
        return Err(
            "refusing an unauthenticated non-loopback listener; provide --token-file or explicitly pass --allow-unauthenticated-remote"
                .into(),
        );
    }

    let dataset_ids = state.datasets.keys().cloned().collect::<Vec<_>>();
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let address = listener.local_addr()?;
    tracing::info!(%address, datasets = ?dataset_ids, "C-Studio data service listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE]);
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/datasets", get(list_datasets_handler))
        .route("/v1/datasets/{id}/metadata", get(metadata_handler))
        .route("/v1/datasets/{id}/tiles", post(tiles_handler))
        .route("/v1/datasets/{id}/overview", post(overview_handler))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn build_state(config: &ServerConfig) -> Result<AppState, Box<dyn std::error::Error>> {
    let mut datasets = BTreeMap::new();
    for spec in &config.dataset_specs {
        let (id, path) = parse_dataset_spec(spec)?;
        let dataset = Arc::new(Dataset::open(id.clone(), path)?);
        if datasets.insert(id.clone(), dataset).is_some() {
            return Err(format!("duplicate dataset id: {id}").into());
        }
    }
    if datasets.is_empty() {
        return Err("at least one --dataset ID=PATH mapping is required".into());
    }
    let bearer_token = config
        .token_file
        .as_deref()
        .map(read_bearer_token)
        .transpose()?
        .map(Arc::<str>::from);
    Ok(AppState {
        datasets: Arc::new(datasets),
        bearer_token,
    })
}

fn parse_dataset_spec(spec: &str) -> Result<(String, PathBuf), Box<dyn std::error::Error>> {
    let (id, path) = spec
        .split_once('=')
        .ok_or("dataset mapping must use ID=PATH")?;
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(format!(
            "invalid dataset id {id:?}; use ASCII letters, numbers, '.', '_' or '-'"
        )
        .into());
    }
    if path.is_empty() {
        return Err(format!("dataset {id:?} has an empty path").into());
    }
    Ok((id.to_string(), PathBuf::from(path)))
}

fn read_bearer_token(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let token = fs::read_to_string(path)?.trim().to_string();
    if token.is_empty() {
        return Err(format!("token file {} is empty", path.display()).into());
    }
    Ok(token)
}

impl Dataset {
    fn open(id: String, path: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let path = fs::canonicalize(&path)?;
        if !path.is_file() {
            return Err(format!("dataset path is not a file: {}", path.display()).into());
        }
        let format = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if format != "cool" && format != "mcool" {
            return Err(format!("dataset {id:?} must end with .cool or .mcool").into());
        }
        let path_text = path.to_string_lossy();
        let mut available_resolutions = list_contact_resolutions(path_text.as_ref())?;
        available_resolutions.sort_unstable();
        available_resolutions.dedup();
        let sources = list_contact_sources(path_text.as_ref())?
            .into_iter()
            .map(|source| ContactSourceMetadata {
                name: source.name,
                length: source.length,
            })
            .collect();
        let metadata = DatasetMetadata {
            api_version: API_VERSION,
            id,
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("contact.mcool")
                .to_string(),
            format,
            size_bytes: fs::metadata(&path)?.len(),
            available_resolutions,
            sources,
        };
        Ok(Self { path, metadata })
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        api_version: API_VERSION,
        datasets: state.datasets.len(),
    })
}

async fn list_datasets_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DatasetListResponse>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(DatasetListResponse {
        api_version: API_VERSION,
        datasets: state
            .datasets
            .values()
            .map(|dataset| dataset.metadata.clone())
            .collect(),
    }))
}

async fn metadata_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<DatasetMetadata>, ApiError> {
    authorize(&headers, &state)?;
    Ok(Json(dataset(&state, &id)?.metadata.clone()))
}

async fn tiles_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<TileRequest>,
) -> Result<Response, ApiError> {
    authorize(&headers, &state)?;
    let dataset = Arc::clone(dataset(&state, &id)?);
    let bytes = tokio::task::spawn_blocking(move || compute_tiles(&dataset, request))
        .await
        .map_err(|error| ApiError::internal(format!("tile worker failed: {error}")))??;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.cstudio.contact-tiles.v1"),
    );
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

async fn overview_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(request): Json<OverviewRequest>,
) -> Result<Json<OverviewResponse>, ApiError> {
    authorize(&headers, &state)?;
    let dataset = Arc::clone(dataset(&state, &id)?);
    let response = tokio::task::spawn_blocking(move || compute_overview(&dataset, request))
        .await
        .map_err(|error| ApiError::internal(format!("overview worker failed: {error}")))??;
    Ok(Json(response))
}

fn dataset<'a>(state: &'a AppState, id: &str) -> Result<&'a Arc<Dataset>, ApiError> {
    state
        .datasets
        .get(id)
        .ok_or_else(|| ApiError::not_found(format!("unknown dataset id: {id}")))
}

fn authorize(headers: &HeaderMap, state: &AppState) -> Result<(), ApiError> {
    let Some(expected) = state.bearer_token.as_deref() else {
        return Ok(());
    };
    let Some(actual) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return Err(ApiError::unauthorized());
    };
    if constant_time_equal(actual.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

fn compute_tiles(dataset: &Dataset, request: TileRequest) -> Result<Vec<u8>, ApiError> {
    validate_layout(&request.layout_blocks)?;
    if request.tiles.len() > MAX_TILES_PER_REQUEST {
        return Err(ApiError::bad_request(format!(
            "tile request exceeds the {MAX_TILES_PER_REQUEST}-tile limit"
        )));
    }
    if request.tile_size_bins == 0 || request.tile_size_bins > MAX_TILE_SIZE_BINS {
        return Err(ApiError::bad_request(format!(
            "tileSizeBins must be between 1 and {MAX_TILE_SIZE_BINS}"
        )));
    }
    let source_resolution = request
        .source_resolution
        .unwrap_or(request.target_resolution);
    validate_resolutions(
        dataset,
        request.base_resolution,
        source_resolution,
        request.target_resolution,
    )?;

    let requested_tiles = request
        .tiles
        .iter()
        .map(|tile| canonical_tile(tile.tile_x, tile.tile_y))
        .collect::<BTreeSet<_>>();
    if requested_tiles.is_empty() {
        return encode_tiles(&[], request.tile_size_bins);
    }
    let tile_span = request
        .tile_size_bins
        .checked_mul(request.target_resolution)
        .ok_or_else(|| ApiError::bad_request("tile span overflowed"))?;
    let min_x = requested_tiles.iter().map(|tile| tile.0).min().unwrap_or(0);
    let max_x = requested_tiles
        .iter()
        .map(|tile| tile.0)
        .max()
        .unwrap_or(min_x);
    let min_y = requested_tiles.iter().map(|tile| tile.1).min().unwrap_or(0);
    let max_y = requested_tiles
        .iter()
        .map(|tile| tile.1)
        .max()
        .unwrap_or(min_y);
    let viewport = ViewportRequest {
        x_start: checked_axis_start(min_x, tile_span)?,
        x_end: checked_axis_end(max_x, tile_span)?,
        y_start: checked_axis_start(min_y, tile_span)?,
        y_end: checked_axis_end(max_y, tile_span)?,
    };
    let source_ranges = source_ranges_for_viewport(&viewport, &request.layout_blocks);
    let query = contact_query(
        request.base_resolution,
        request.target_resolution,
        viewport,
        &request.layout_blocks,
    )?;
    let stored_resolution = (dataset.metadata.format == "mcool").then_some(source_resolution);
    let contacts = if source_ranges.is_empty() {
        Vec::new()
    } else {
        read_cool_contacts_for_source_ranges_at_resolution_with_normalization(
            dataset.path.to_string_lossy().as_ref(),
            &source_ranges,
            stored_resolution,
            request.normalization.into(),
        )
        .map_err(|error| ApiError::bad_request(error.to_string()))?
    };
    let view = build_contact_map_view_from_contacts(&query, contacts)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let tiles = tiles_from_cells(view.cells, request.tile_size_bins, &requested_tiles)?;
    encode_tiles(&tiles, request.tile_size_bins)
}

fn compute_overview(
    dataset: &Dataset,
    request: OverviewRequest,
) -> Result<OverviewResponse, ApiError> {
    validate_layout(&request.layout_blocks)?;
    if request.source_resolution == 0
        || request.target_resolution == 0
        || request.target_resolution % request.source_resolution != 0
    {
        return Err(ApiError::bad_request(
            "targetResolution must be a positive multiple of sourceResolution",
        ));
    }
    validate_dataset_resolution(dataset, request.source_resolution)?;
    validate_viewport(request.viewport)?;
    let x_bins = request
        .viewport
        .x_end
        .div_ceil(request.target_resolution)
        .saturating_sub(request.viewport.x_start / request.target_resolution);
    let y_bins = request
        .viewport
        .y_end
        .div_ceil(request.target_resolution)
        .saturating_sub(request.viewport.y_start / request.target_resolution);
    let aggregate_cells = x_bins
        .checked_mul(y_bins)
        .ok_or_else(|| ApiError::bad_request("overview grid overflowed"))?;
    if aggregate_cells > MAX_OVERVIEW_CELLS {
        return Err(ApiError::bad_request(format!(
            "overview grid exceeds the {MAX_OVERVIEW_CELLS}-cell limit"
        )));
    }
    let aggregate_cells = usize::try_from(aggregate_cells)
        .map_err(|_| ApiError::bad_request("overview grid exceeds platform limits"))?;
    let query = contact_query(
        request.source_resolution,
        request.target_resolution,
        request.viewport,
        &request.layout_blocks,
    )?;
    let source_ranges = source_ranges_for_viewport(&request.viewport, &request.layout_blocks);
    let mut projector = cstudio_core::contact_map::ContactMapChunkProjector::new_for_bounded_view(
        &query,
        aggregate_cells,
    )
    .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let stored_resolution =
        (dataset.metadata.format == "mcool").then_some(request.source_resolution);
    if !source_ranges.is_empty() {
        visit_cool_contact_chunks_indexed_for_source_ranges_at_resolution_with_normalization_cancellable(
            dataset.path.to_string_lossy().as_ref(),
            &source_ranges,
            stored_resolution,
            request.normalization.into(),
            &|| false,
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
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    }
    let view = projector.take_view();
    Ok(OverviewResponse {
        source_resolution: request.source_resolution,
        resolution: view.resolution,
        viewport: request.viewport,
        cells: view
            .cells
            .into_iter()
            .map(|cell| CellResponse {
                x_bin: cell.x_bin,
                y_bin: cell.y_bin,
                count: cell.count,
            })
            .collect(),
    })
}

fn validate_resolutions(
    dataset: &Dataset,
    base_resolution: u64,
    source_resolution: u64,
    target_resolution: u64,
) -> Result<(), ApiError> {
    if base_resolution == 0
        || source_resolution == 0
        || source_resolution % base_resolution != 0
        || target_resolution == 0
        || target_resolution % source_resolution != 0
    {
        return Err(ApiError::bad_request(format!(
            "invalid resolution chain: base={base_resolution}, source={source_resolution}, target={target_resolution}"
        )));
    }
    validate_dataset_resolution(dataset, source_resolution)
}

fn validate_dataset_resolution(dataset: &Dataset, resolution: u64) -> Result<(), ApiError> {
    if dataset.metadata.format == "mcool"
        && !dataset.metadata.available_resolutions.contains(&resolution)
    {
        return Err(ApiError::bad_request(format!(
            "resolution {resolution} is not stored in dataset {}",
            dataset.metadata.id
        )));
    }
    Ok(())
}

fn validate_layout(blocks: &[LayoutBlockRequest]) -> Result<(), ApiError> {
    if blocks.len() > MAX_LAYOUT_BLOCKS {
        return Err(ApiError::bad_request(format!(
            "layout exceeds the {MAX_LAYOUT_BLOCKS}-block limit"
        )));
    }
    for block in blocks {
        if block.source_id.is_empty() {
            return Err(ApiError::bad_request(
                "layout block sourceId cannot be empty",
            ));
        }
        if block.source_start >= block.source_end {
            return Err(ApiError::bad_request(format!(
                "layout block {:?} has an empty or reversed source interval",
                block.id
            )));
        }
        parse_orientation(&block.orientation)?;
    }
    Ok(())
}

fn validate_viewport(viewport: ViewportRequest) -> Result<(), ApiError> {
    if viewport.x_start >= viewport.x_end || viewport.y_start >= viewport.y_end {
        return Err(ApiError::bad_request(
            "viewport axes must use non-empty half-open intervals",
        ));
    }
    Ok(())
}

fn contact_query(
    base_resolution: u64,
    target_resolution: u64,
    viewport: ViewportRequest,
    blocks: &[LayoutBlockRequest],
) -> Result<ContactMapQuery, ApiError> {
    validate_viewport(viewport)?;
    Ok(ContactMapQuery {
        base_resolution,
        target_resolution,
        viewport: Viewport {
            x_start: viewport.x_start,
            x_end: viewport.x_end,
            y_start: viewport.y_start,
            y_end: viewport.y_end,
        },
        layout_blocks: blocks
            .iter()
            .map(|block| {
                Ok(LayoutBlock {
                    id: block.id.clone(),
                    source_id: block.source_id.clone(),
                    source_start: block.source_start,
                    source_end: block.source_end,
                    visual_start: block.visual_start,
                    orientation: parse_orientation(&block.orientation)?,
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?,
    })
}

fn parse_orientation(value: &str) -> Result<Orientation, ApiError> {
    match value {
        "+" | "forward" | "Forward" => Ok(Orientation::Forward),
        "-" | "reverse" | "Reverse" => Ok(Orientation::Reverse),
        "?" | "0" | "na" | "unknown" | "Unknown" => Ok(Orientation::Unknown),
        _ => Err(ApiError::bad_request(format!(
            "invalid orientation: {value}"
        ))),
    }
}

fn source_ranges_for_viewport(
    viewport: &ViewportRequest,
    blocks: &[LayoutBlockRequest],
) -> Vec<(String, u64, u64)> {
    let mut visual_ranges = [
        (viewport.x_start, viewport.x_end),
        (viewport.y_start, viewport.y_end),
    ];
    visual_ranges.sort_unstable();
    let visual_range_count = if visual_ranges[0].1 >= visual_ranges[1].0 {
        visual_ranges[0].1 = visual_ranges[0].1.max(visual_ranges[1].1);
        1
    } else {
        2
    };

    let mut ranges = Vec::<(&str, u64, u64)>::new();
    for block in blocks {
        let block_span = block.source_end.saturating_sub(block.source_start);
        if block_span == 0 {
            continue;
        }
        let block_visual_end = block.visual_start.saturating_add(block_span);
        for &(visual_start, visual_end) in &visual_ranges[..visual_range_count] {
            let overlap_start = visual_start.max(block.visual_start);
            let overlap_end = visual_end.min(block_visual_end);
            if overlap_start >= overlap_end {
                continue;
            }
            let offset_start = overlap_start - block.visual_start;
            let offset_end = overlap_end - block.visual_start;
            let reverse =
                block.orientation == "-" || block.orientation.eq_ignore_ascii_case("reverse");
            let (source_start, source_end) = if reverse {
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
            let (last_source_id, _, last_end) = &mut ranges[write_index - 1];
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
        .map(|(source_id, start, end)| (source_id.to_string(), start, end))
        .collect()
}

fn tiles_from_cells(
    cells: Vec<ContactMapCell>,
    tile_size_bins: u64,
    requested_tiles: &BTreeSet<(u64, u64)>,
) -> Result<Vec<TileResponse>, ApiError> {
    let mut tiles = requested_tiles
        .iter()
        .copied()
        .map(|key| (key, Vec::new()))
        .collect::<BTreeMap<_, Vec<CellResponse>>>();
    for cell in cells {
        let key = canonical_tile(cell.x_bin / tile_size_bins, cell.y_bin / tile_size_bins);
        if let Some(tile) = tiles.get_mut(&key) {
            tile.push(CellResponse {
                x_bin: cell.x_bin,
                y_bin: cell.y_bin,
                count: cell.count,
            });
        }
    }
    Ok(tiles
        .into_iter()
        .map(|((tile_x, tile_y), cells)| TileResponse {
            tile_x,
            tile_y,
            cells,
        })
        .collect())
}

fn canonical_tile(tile_x: u64, tile_y: u64) -> (u64, u64) {
    if tile_x <= tile_y {
        (tile_x, tile_y)
    } else {
        (tile_y, tile_x)
    }
}

fn checked_axis_start(axis: u64, tile_span: u64) -> Result<u64, ApiError> {
    axis.checked_mul(tile_span)
        .ok_or_else(|| ApiError::bad_request("tile viewport start overflowed"))
}

fn checked_axis_end(axis: u64, tile_span: u64) -> Result<u64, ApiError> {
    axis.checked_add(1)
        .and_then(|value| value.checked_mul(tile_span))
        .ok_or_else(|| ApiError::bad_request("tile viewport end overflowed"))
}

fn encode_tiles(tiles: &[TileResponse], tile_size_bins: u64) -> Result<Vec<u8>, ApiError> {
    const HEADER_BYTES: usize = 16;
    const DIRECTORY_BYTES: usize = 24;
    let tile_count = u32::try_from(tiles.len())
        .map_err(|_| ApiError::bad_request("tile count exceeds binary format limits"))?;
    let metadata_len = HEADER_BYTES
        .checked_add(tiles.len().saturating_mul(DIRECTORY_BYTES))
        .ok_or_else(|| ApiError::bad_request("tile metadata size overflowed"))?;
    let mut bytes = vec![0; metadata_len];
    bytes[0..4].copy_from_slice(b"CST1");
    bytes[4..6].copy_from_slice(&1_u16.to_le_bytes());
    bytes[6..8].copy_from_slice(&0_u16.to_le_bytes());
    bytes[8..12].copy_from_slice(&(tile_size_bins as u32).to_le_bytes());
    bytes[12..16].copy_from_slice(&tile_count.to_le_bytes());

    for (tile_index, tile) in tiles.iter().enumerate() {
        let tile_start_x = tile
            .tile_x
            .checked_mul(tile_size_bins)
            .ok_or_else(|| ApiError::bad_request("tile X origin overflowed"))?;
        let tile_start_y = tile
            .tile_y
            .checked_mul(tile_size_bins)
            .ok_or_else(|| ApiError::bad_request("tile Y origin overflowed"))?;
        let data_offset = u32::try_from(bytes.len())
            .map_err(|_| ApiError::bad_request("tile response exceeds binary format limits"))?;
        let cell_count = u32::try_from(tile.cells.len())
            .map_err(|_| ApiError::bad_request("tile cell count exceeds binary format limits"))?;
        let directory_offset = HEADER_BYTES + tile_index * DIRECTORY_BYTES;
        bytes[directory_offset..directory_offset + 8].copy_from_slice(&tile.tile_x.to_le_bytes());
        bytes[directory_offset + 8..directory_offset + 16]
            .copy_from_slice(&tile.tile_y.to_le_bytes());
        bytes[directory_offset + 16..directory_offset + 20]
            .copy_from_slice(&cell_count.to_le_bytes());
        bytes[directory_offset + 20..directory_offset + 24]
            .copy_from_slice(&data_offset.to_le_bytes());

        for cell in &tile.cells {
            let local = local_bin(cell.x_bin, tile_start_x, tile_size_bins, "X")?;
            bytes.extend_from_slice(&local.to_le_bytes());
        }
        for cell in &tile.cells {
            let local = local_bin(cell.y_bin, tile_start_y, tile_size_bins, "Y")?;
            bytes.extend_from_slice(&local.to_le_bytes());
        }
        while bytes.len() % std::mem::align_of::<f64>() != 0 {
            bytes.push(0);
        }
        for cell in &tile.cells {
            bytes.extend_from_slice(&cell.count.to_le_bytes());
        }
    }
    if bytes.len() > u32::MAX as usize {
        return Err(ApiError::bad_request(
            "tile response exceeds binary format limits",
        ));
    }
    Ok(bytes)
}

fn local_bin(bin: u64, tile_start: u64, tile_size_bins: u64, axis: &str) -> Result<u16, ApiError> {
    let local = bin.checked_sub(tile_start).ok_or_else(|| {
        ApiError::internal(format!("tile {axis} coordinate precedes its tile origin"))
    })?;
    if local >= tile_size_bins || local > u64::from(u16::MAX) {
        return Err(ApiError::internal(format!(
            "tile {axis} coordinate lies outside its tile"
        )));
    }
    Ok(local as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dataset_specs_reject_paths_as_ids() {
        assert!(parse_dataset_spec("../secret=/data/test.mcool").is_err());
        assert!(parse_dataset_spec("alpha=/data/test.mcool").is_ok());
    }

    #[test]
    fn bearer_comparison_does_not_accept_prefixes() {
        assert!(constant_time_equal(b"secret", b"secret"));
        assert!(!constant_time_equal(b"secret", b"secret-long"));
        assert!(!constant_time_equal(b"Secret", b"secret"));
    }

    #[test]
    fn source_ranges_merge_overlapping_axes_and_respect_reverse_orientation() {
        let blocks = vec![LayoutBlockRequest {
            id: "block-1".to_string(),
            source_id: "ctg1".to_string(),
            source_start: 100,
            source_end: 1_100,
            visual_start: 0,
            orientation: "-".to_string(),
        }];
        let ranges = source_ranges_for_viewport(
            &ViewportRequest {
                x_start: 0,
                x_end: 400,
                y_start: 200,
                y_end: 600,
            },
            &blocks,
        );
        assert_eq!(ranges, vec![("ctg1".to_string(), 500, 1_100)]);
    }

    #[test]
    fn cst1_encoder_writes_sparse_tiles_compatible_with_the_frontend_contract() {
        let bytes = encode_tiles(
            &[TileResponse {
                tile_x: 2,
                tile_y: 3,
                cells: vec![CellResponse {
                    x_bin: 9,
                    y_bin: 13,
                    count: 2.5,
                }],
            }],
            4,
        )
        .expect("tile should encode");
        assert_eq!(&bytes[0..4], b"CST1");
        assert_eq!(u16::from_le_bytes(bytes[4..6].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 4);
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 1);
        assert_eq!(u64::from_le_bytes(bytes[16..24].try_into().unwrap()), 2);
        assert_eq!(u64::from_le_bytes(bytes[24..32].try_into().unwrap()), 3);
        assert_eq!(u16::from_le_bytes(bytes[40..42].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(bytes[42..44].try_into().unwrap()), 1);
        assert_eq!(f64::from_le_bytes(bytes[48..56].try_into().unwrap()), 2.5);
    }
}
