import type { ContactMapLayoutBlock } from "./importers";
import type { ContactNormalization } from "./uiState";

export interface RemoteContactMetadata {
  apiVersion: number;
  id: string;
  name: string;
  format: "cool" | "mcool";
  sizeBytes: number;
  availableResolutions: number[];
  sources: Array<{ name: string; length: number }>;
}

export interface RemoteContactTileRequest {
  requestId: number;
  generation: number;
  purpose: string;
  coolPath: string;
  baseResolution: number;
  sourceResolution?: number;
  targetResolution: number;
  tileSizeBins: number;
  normalization: ContactNormalization;
  tiles: Array<{ tileX: number; tileY: number }>;
  adaptiveRefinement?: boolean;
}

export interface RemoteContactOverviewRequest {
  requestId: number;
  generation: number;
  coolPath: string;
  sourceResolution: number;
  targetResolution: number;
  normalization: ContactNormalization;
  viewport: {
    xStart: number;
    xEnd: number;
    yStart: number;
    yEnd: number;
  };
}

export interface RemoteContactOverviewResponse {
  sourceResolution: number;
  resolution: number;
  viewport: RemoteContactOverviewRequest["viewport"];
  cells: Array<{ xBin: number; yBin: number; count: number }>;
}

interface RemoteContactSource {
  datasetUrl: string;
  bearerToken?: string;
}

const remoteContactSources = new Map<string, RemoteContactSource>();
const remoteContactPathPattern = /\/contact\.(?:m?cool)$/i;
const explicitRemoteUrlPattern = /^[a-z][a-z\d+.-]*:\/\//i;

export function normalizeRemoteSourceUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Enter a remote project, file, or dataset address");
  }
  const address = explicitRemoteUrlPattern.test(trimmed)
    ? trimmed
    : trimmed.startsWith("//")
      ? `http:${trimmed}`
      : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("The remote address is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The remote address must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Put credentials in the bearer token field, not in the URL");
  }
  url.hash = "";
  return url.toString();
}

export function normalizeRemoteDatasetUrl(input: string): string {
  const url = new URL(normalizeRemoteSourceUrl(input));
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = url.pathname.replace(/\/metadata$/i, "");
  url.pathname = url.pathname.replace(remoteContactPathPattern, "");
  if (!/\/v1\/datasets\/[^/]+$/i.test(url.pathname)) {
    throw new Error("Use a dataset URL ending in /v1/datasets/<dataset-id>");
  }
  return url.toString().replace(/\/$/, "");
}

export function isRemoteContactServiceUrl(input: string): boolean {
  try {
    normalizeRemoteDatasetUrl(input);
    return true;
  } catch {
    return false;
  }
}

export function remoteContactIdentifier(
  datasetUrl: string,
  format: RemoteContactMetadata["format"],
): string {
  return `${normalizeRemoteDatasetUrl(datasetUrl)}/contact.${format}`;
}

export function isRemoteContactPath(path: string | null | undefined): path is string {
  if (!path) return false;
  try {
    const url = new URL(path);
    return (url.protocol === "http:" || url.protocol === "https:")
      && remoteContactPathPattern.test(url.pathname);
  } catch {
    return false;
  }
}

export function rememberRemoteContactSource(
  identifier: string,
  source: { datasetUrl: string; bearerToken?: string },
) {
  if (!isRemoteContactPath(identifier)) {
    throw new Error("Remote contact identifier must end in contact.cool or contact.mcool");
  }
  const bearerToken = source.bearerToken?.trim();
  remoteContactSources.set(identifier, {
    datasetUrl: normalizeRemoteDatasetUrl(source.datasetUrl),
    ...(bearerToken ? { bearerToken } : {}),
  });
}

export function forgetRemoteContactSource(identifier: string | null | undefined) {
  if (identifier) remoteContactSources.delete(identifier);
}

function sourceFor(identifier: string): RemoteContactSource {
  const source = remoteContactSources.get(identifier);
  if (!source) {
    throw new Error("The remote contact session is no longer available; reconnect to the service");
  }
  return source;
}

function headersFor(source: RemoteContactSource, json = false): HeadersInit {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(source.bearerToken ? { Authorization: `Bearer ${source.bearerToken}` } : {}),
  };
}

async function responseError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`.trim();
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) message = body.error;
  } catch {
    // Keep the HTTP status when a proxy returns a non-JSON error page.
  }
  return new Error(`Remote contact service: ${message}`);
}

async function fetchChecked(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`Could not reach the remote contact service: ${String(error)}`);
  }
  if (!response.ok) throw await responseError(response);
  return response;
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Remote contact metadata has an invalid ${field}`);
  }
}

function validateMetadata(value: unknown): RemoteContactMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("Remote contact metadata is not an object");
  }
  const metadata = value as Partial<RemoteContactMetadata>;
  if (metadata.apiVersion !== 1) {
    throw new Error(`Unsupported remote contact API version: ${String(metadata.apiVersion)}`);
  }
  if (typeof metadata.id !== "string" || !metadata.id) {
    throw new Error("Remote contact metadata is missing its dataset id");
  }
  if (typeof metadata.name !== "string" || !metadata.name) {
    throw new Error("Remote contact metadata is missing its dataset name");
  }
  if (metadata.format !== "cool" && metadata.format !== "mcool") {
    throw new Error("Remote contact metadata has an unsupported format");
  }
  assertNonNegativeInteger(metadata.sizeBytes, "sizeBytes");
  if (!Array.isArray(metadata.availableResolutions) || metadata.availableResolutions.length === 0) {
    throw new Error("Remote contact metadata has no resolutions");
  }
  metadata.availableResolutions.forEach((resolution) => {
    assertNonNegativeInteger(resolution, "resolution");
    if (resolution === 0) throw new Error("Remote contact resolution must be positive");
  });
  if (!Array.isArray(metadata.sources) || metadata.sources.length === 0) {
    throw new Error("Remote contact metadata has no chromosome/source records");
  }
  metadata.sources.forEach((source) => {
    if (!source || typeof source.name !== "string" || !source.name) {
      throw new Error("Remote contact metadata has an invalid source name");
    }
    assertNonNegativeInteger(source.length, "source length");
  });
  return metadata as RemoteContactMetadata;
}

export async function loadRemoteContactMetadata(
  input: string,
  bearerToken?: string,
): Promise<{ datasetUrl: string; metadata: RemoteContactMetadata }> {
  const datasetUrl = normalizeRemoteDatasetUrl(input);
  const source: RemoteContactSource = {
    datasetUrl,
    ...(bearerToken?.trim() ? { bearerToken: bearerToken.trim() } : {}),
  };
  const response = await fetchChecked(`${datasetUrl}/metadata`, {
    method: "GET",
    headers: headersFor(source),
  });
  return { datasetUrl, metadata: validateMetadata(await response.json()) };
}

function layoutPayload(layoutBlocks: ContactMapLayoutBlock[]) {
  return layoutBlocks.map((block) => ({
    id: block.id,
    sourceId: block.sourceId,
    sourceStart: block.sourceStart,
    sourceEnd: block.sourceEnd,
    visualStart: block.visualStart,
    orientation: block.orientation,
  }));
}

export async function loadRemoteContactTiles(
  layoutBlocks: ContactMapLayoutBlock[],
  request: RemoteContactTileRequest,
): Promise<ArrayBuffer> {
  const source = sourceFor(request.coolPath);
  const response = await fetchChecked(`${source.datasetUrl}/tiles`, {
    method: "POST",
    headers: headersFor(source, true),
    body: JSON.stringify({
      baseResolution: request.baseResolution,
      sourceResolution: request.sourceResolution,
      targetResolution: request.targetResolution,
      tileSizeBins: request.tileSizeBins,
      normalization: request.normalization,
      tiles: request.tiles,
      layoutBlocks: layoutPayload(layoutBlocks),
    }),
  });
  return response.arrayBuffer();
}

export async function loadRemoteContactOverview(
  layoutBlocks: ContactMapLayoutBlock[],
  request: RemoteContactOverviewRequest,
): Promise<RemoteContactOverviewResponse> {
  const source = sourceFor(request.coolPath);
  const response = await fetchChecked(`${source.datasetUrl}/overview`, {
    method: "POST",
    headers: headersFor(source, true),
    body: JSON.stringify({
      sourceResolution: request.sourceResolution,
      targetResolution: request.targetResolution,
      normalization: request.normalization,
      viewport: request.viewport,
      layoutBlocks: layoutPayload(layoutBlocks),
    }),
  });
  return response.json() as Promise<RemoteContactOverviewResponse>;
}
