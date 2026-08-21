import type { ContactMapTile, ContactMapView } from "../App";
import { contactColorLut } from "../state/contactColor";
import type { ContactTileDenseDeltaBuffer } from "../state/contactTileDelta";
import {
  contactTileCellCount,
  validatedDenseContactTileValues,
  validatedPackedContactTileCells,
} from "../state/contactTileData";
import { contactTileKey } from "../state/contactTiles";
import type { ContactViewport } from "../state/contactViewport";
import { isContactTilePerformanceEnabled } from "../state/contactTilePerformance";
import type {
  ContactTileCanvasDescriptor,
  ContactTileRenderStyle,
} from "./ContactTileLayer";

export const contactTileGpuTextureBudgetBytes = 96 * 1024 * 1024;
export const contactTileGpuVirtualTextureBudgetBytes = 32 * 1024 * 1024;
export const contactOverviewTextureBins = 320;
export const contactTileGpuR16fMaximum = 65_504;

export type ContactTileGpuTextureFormat = "r16f" | "r32f";
export type ContactTileGpuTexturePreference = ContactTileGpuTextureFormat;

export interface ContactTileGpuPerformanceSnapshot {
  texturePreference: ContactTileGpuTexturePreference;
  uploads: number;
  fullUploads: number;
  subUploads: number;
  r16fUploads: number;
  r32fUploads: number;
  rangeFallbacks: number;
  uploadErrorFallbacks: number;
  uploadMilliseconds: number;
  evictions: number;
  evictedBytes: number;
  cacheEntries: number;
  cacheBytes: number;
  scenePromotions: number;
  scenePromotionMisses: number;
  scenePromotionMilliseconds: number;
  virtualTextureDraws: number;
  virtualTextureFallbacks: number;
  virtualTextureUploads: number;
  virtualTexturePages: number;
  virtualTextureLayers: number;
  virtualTextureBytes: number;
}

export interface ContactTileGpuRendererOptions {
  texturePreference?: ContactTileGpuTexturePreference;
  virtualTextureEnabled?: boolean;
  performanceEnabled?: boolean;
  emitPerformance?: (line: string) => void;
  clock?: () => number;
}

export interface ContactTileGpuOverview {
  values: Float32Array;
  width: number;
  height: number;
  viewport: ContactViewport;
  /**
   * The whole-assembly overview is aggregated at a much coarser resolution
   * than the exact surface. Reusing the exact scale saturates raw counts and
   * exposes a solid-red sheet while new pan tiles are arriving.
   */
  colorScale?: ContactTileRenderStyle["colorScale"];
}

/** A diagonal assembly interval retained in world coordinates on the GPU. */
export interface ContactTileGpuBoundary {
  visualStart: number;
  visualEnd: number;
  color: readonly [red: number, green: number, blue: number];
  lineWidthCssPx: number;
  minimumSpanCssPx: number;
}

export interface ContactTileGpuScene {
  boundaries?: readonly ContactTileGpuBoundary[];
  descriptors: readonly ContactTileCanvasDescriptor[];
  generation?: number;
  overview?: ContactTileGpuOverview | null;
  /** Only a terminal visible layer may replace coarse overview pixels with exact zeros. */
  visibleLayerComplete?: boolean;
  resolution: number;
  tileSizeBins: number;
  viewport: ContactViewport;
  renderStyle: ContactTileRenderStyle;
}

export interface ContactTileGpuDeltaScene {
  boundaries?: readonly ContactTileGpuBoundary[];
  buffers: readonly ContactTileDenseDeltaBuffer[];
  /** Accumulate into mutable CPU buffers and upload only during terminal promotion. */
  deferTextureUpdates?: boolean;
  descriptors: readonly ContactTileCanvasDescriptor[];
  generation: number;
  overview?: ContactTileGpuOverview | null;
  resolution: number;
  tileSizeBins: number;
  viewport: ContactViewport;
  renderStyle: ContactTileRenderStyle;
}

export interface ContactTileGpuRenderer {
  setScene: (scene: ContactTileGpuScene) => boolean;
  /**
   * Atomically replace the current scene only when every populated target tile
   * is already resident in this WebGL context. A miss leaves the visible frame
   * untouched so the caller can retain the DOM back-buffer fallback.
   */
  promoteScene: (scene: ContactTileGpuScene) => boolean;
  appendSceneDescriptors: (input: {
    descriptors: readonly ContactTileCanvasDescriptor[];
    generation: number;
    resolution: number;
    tileSizeBins: number;
  }) => boolean;
  /** Present newly appended or refreshed pan-prefetch descriptors in place. */
  presentAppendedSceneDescriptors: () => boolean;
  setDeltaScene: (scene: ContactTileGpuDeltaScene) => boolean;
  updateDeltaTiles: (changedTileKeys: readonly string[]) => boolean;
  /** Move the one live GPU camera during pointer navigation. */
  setPanViewport: (viewport: ContactViewport) => void;
  redraw: () => boolean;
  performanceSnapshot: () => ContactTileGpuPerformanceSnapshot;
  destroy: () => void;
}

/**
 * A WebGL frame is presentable only when every populated descriptor reached a
 * draw call. Empty tiles are already represented by the white framebuffer
 * clear, but silently skipping one failed texture upload would leave a false
 * rectangular hole and must force the 2D fallback instead.
 */
export function contactTileGpuDrawCoverageIsComplete(
  descriptors: readonly ContactTileCanvasDescriptor[],
  drawnDescriptorKeys: ReadonlySet<string>,
  requiresExplicitEmptyCoverage = false,
): boolean {
  return descriptors.every((descriptor) => (
    (!requiresExplicitEmptyCoverage && contactTileCellCount(descriptor.tile) === 0)
    || drawnDescriptorKeys.has(descriptor.key)
  ));
}

export const contactTileVirtualPageTransposeFlag = 1;
export const contactTileVirtualPageExactFlag = 2;

export interface ContactTileVirtualPage {
  pageX: number;
  pageY: number;
  tileKey: string;
  tile: ContactMapTile;
  transpose: boolean;
}

export interface ContactTileVirtualPagePlan {
  originX: number;
  originY: number;
  width: number;
  height: number;
  pages: readonly ContactTileVirtualPage[];
  populatedTiles: readonly { key: string; tile: ContactMapTile }[];
}

/** Build the compact world-page rectangle sampled by the pointer shader. */
export function contactTileVirtualPagePlan(
  descriptors: readonly ContactTileCanvasDescriptor[],
): ContactTileVirtualPagePlan | null {
  if (descriptors.length === 0) {
    return null;
  }
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  const pagesByCoordinate = new Map<string, ContactTileVirtualPage>();
  const populatedTiles = new Map<string, ContactMapTile>();
  for (const descriptor of descriptors) {
    const pageX = descriptor.transpose ? descriptor.tile.tileY : descriptor.tile.tileX;
    const pageY = descriptor.transpose ? descriptor.tile.tileX : descriptor.tile.tileY;
    if (!Number.isSafeInteger(pageX) || !Number.isSafeInteger(pageY) || pageX < 0 || pageY < 0) {
      return null;
    }
    const tileKey = contactTileKey(descriptor.tile);
    pagesByCoordinate.set(`${pageX}:${pageY}`, {
      pageX,
      pageY,
      tileKey,
      tile: descriptor.tile,
      transpose: descriptor.transpose,
    });
    if (contactTileCellCount(descriptor.tile) > 0) {
      populatedTiles.set(tileKey, descriptor.tile);
    }
    minimumX = Math.min(minimumX, pageX);
    maximumX = Math.max(maximumX, pageX);
    minimumY = Math.min(minimumY, pageY);
    maximumY = Math.max(maximumY, pageY);
  }
  const width = maximumX - minimumX + 1;
  const height = maximumY - minimumY + 1;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    originX: minimumX,
    originY: minimumY,
    width,
    height,
    pages: [...pagesByCoordinate.values()],
    populatedTiles: [...populatedTiles].map(([key, tile]) => ({ key, tile })),
  };
}

export function contactTileVirtualPageTableData(
  plan: ContactTileVirtualPagePlan,
  layerByTileKey: ReadonlyMap<string, number>,
): Uint32Array | null {
  const values = new Uint32Array(plan.width * plan.height * 2);
  for (const page of plan.pages) {
    const offset = (
      (page.pageY - plan.originY) * plan.width
      + page.pageX - plan.originX
    ) * 2;
    const populated = contactTileCellCount(page.tile) > 0;
    const layer = populated ? layerByTileKey.get(page.tileKey) : undefined;
    if (populated && layer === undefined) {
      return null;
    }
    values[offset] = populated ? layer! + 1 : 0;
    values[offset + 1] = (
      (page.transpose ? contactTileVirtualPageTransposeFlag : 0)
      | contactTileVirtualPageExactFlag
    );
  }
  return values;
}

export interface ContactTileVirtualCamera {
  pageX: number;
  pageY: number;
  localX: number;
  localY: number;
  spanX: number;
  spanY: number;
}

/** Split large genome coordinates into exact integer pages and small shader floats. */
export function contactTileVirtualCamera(
  viewport: ContactViewport,
  resolution: number,
  tileSizeBins: number,
): ContactTileVirtualCamera {
  const tileSpan = resolution * tileSizeBins;
  if (!Number.isSafeInteger(tileSpan) || tileSpan <= 0) {
    throw new RangeError("virtual texture tile span must be a positive safe integer");
  }
  const pageX = Math.floor(viewport.xStart / tileSpan);
  const pageY = Math.floor(viewport.yStart / tileSpan);
  return {
    pageX,
    pageY,
    localX: viewport.xStart / tileSpan - pageX,
    localY: viewport.yStart / tileSpan - pageY,
    spanX: (viewport.xEnd - viewport.xStart) / tileSpan,
    spanY: (viewport.yEnd - viewport.yStart) / tileSpan,
  };
}

interface GpuTextureEntry {
  texture: WebGLTexture;
  format: ContactTileGpuTextureFormat;
  tile: ContactMapTile | null;
  deltaBuffer?: ContactTileDenseDeltaBuffer;
  panPrefetchSnapshot?: boolean;
  generation?: number;
  bytes: number;
  lastUsed: number;
}

interface GpuOverviewTextureEntry {
  texture: WebGLTexture;
  format: ContactTileGpuTextureFormat;
  values: Float32Array;
  width: number;
  height: number;
}

interface RendererResources {
  program: WebGLProgram;
  quadBuffer: WebGLBuffer;
  lutTexture: WebGLTexture;
  positionLocation: number;
  rectLocation: WebGLUniformLocation;
  canvasSizeLocation: WebGLUniformLocation;
  transposeLocation: WebGLUniformLocation;
  tileTextureLocation: WebGLUniformLocation;
  lutTextureLocation: WebGLUniformLocation;
  scaleLocation: WebGLUniformLocation;
  paletteStopCountLocation: WebGLUniformLocation;
}

interface BoundaryRendererResources {
  program: WebGLProgram;
  geometryBuffer: WebGLBuffer;
  instanceBuffer: WebGLBuffer;
  edgeLocation: number;
  intervalLocation: number;
  colorLocation: number;
  styleLocation: number;
  viewportLocation: WebGLUniformLocation;
  canvasSizeLocation: WebGLUniformLocation;
  cssSizeLocation: WebGLUniformLocation;
  cssScaleLocation: WebGLUniformLocation;
}

interface FramePresentationResources {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

interface VirtualTextureRendererResources {
  program: WebGLProgram;
  positionLocation: number;
  tileArrayLocation: WebGLUniformLocation;
  pageTableLocation: WebGLUniformLocation;
  lutTextureLocation: WebGLUniformLocation;
  overviewTextureLocation: WebGLUniformLocation;
  cameraTilesLocation: WebGLUniformLocation;
  cameraPageLocation: WebGLUniformLocation;
  pageOriginLocation: WebGLUniformLocation;
  pageSizeLocation: WebGLUniformLocation;
  overviewUvRectLocation: WebGLUniformLocation;
  hasOverviewLocation: WebGLUniformLocation;
  scaleLocation: WebGLUniformLocation;
  overviewScaleLocation: WebGLUniformLocation;
  paletteStopCountLocation: WebGLUniformLocation;
}

interface VirtualTextureState {
  tileArray: WebGLTexture;
  pageTable: WebGLTexture;
  capacity: number;
  resolution: number;
  tileSizeBins: number;
  layerByTileKey: Map<string, number>;
  tileByTileKey: Map<string, ContactMapTile>;
  plan: ContactTileVirtualPagePlan;
  pageTableData: Uint32Array;
  bytes: number;
}

const vertexShaderSource = `#version 300 es
in vec2 a_position;
uniform vec4 u_rect;
uniform vec2 u_canvas_size;
uniform bool u_transpose;
out vec2 v_uv;

void main() {
  vec2 pixel = u_rect.xy + a_position * u_rect.zw;
  vec2 clip = (pixel / u_canvas_size) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = u_transpose ? a_position.yx : a_position;
}
`;

const fragmentShaderSource = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_tile;
uniform sampler2D u_lut;
uniform vec4 u_scale;
uniform float u_palette_stop_count;
in vec2 v_uv;
out vec4 out_color;

void main() {
  float value = texture(u_tile, v_uv).r;
  if (value < 0.0) {
    discard;
  }

  float minimum = u_scale.x;
  float maximum = u_scale.y;
  float intensity;
  if (maximum == minimum) {
    intensity = value >= maximum ? 1.0 : 0.0;
  } else if (u_scale.z > 0.5) {
    float log_minimum = log(minimum + 1.0) / log(10.0);
    float log_range = log(maximum + 1.0) / log(10.0) - log_minimum;
    intensity = (log(value + 1.0) / log(10.0) - log_minimum) / log_range;
  } else {
    intensity = (value - minimum) / (maximum - minimum);
  }
  intensity = clamp(intensity, 0.0, 1.0);

  float lut_index;
  if (u_palette_stop_count > 0.5) {
    float stop_index = min(
      u_palette_stop_count - 1.0,
      floor(intensity * u_palette_stop_count)
    );
    float representative = (stop_index + 0.5) / u_palette_stop_count;
    lut_index = floor(representative * 255.0);
  } else {
    lut_index = floor(intensity * 255.0);
  }
  vec4 color = texelFetch(u_lut, ivec2(int(lut_index), 0), 0);
  // The heatmap surface is white. Resolve palette alpha here instead of
  // relying on WKWebView to composite a transparent WebGL framebuffer; the
  // latter can expose black clear pixels and also applies alpha twice.
  out_color = vec4(mix(vec3(1.0), color.rgb, color.a), 1.0);
}
`;

const virtualTextureVertexShaderSource = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  vec2 clip = a_position * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_position;
}
`;

const virtualTextureFragmentShaderSource = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;

uniform sampler2DArray u_tile_array;
uniform usampler2D u_page_table;
uniform sampler2D u_lut;
uniform sampler2D u_overview;
uniform vec4 u_camera_tiles;
uniform ivec2 u_camera_page;
uniform ivec2 u_page_origin;
uniform ivec2 u_page_size;
uniform vec4 u_overview_uv_rect;
uniform bool u_has_overview;
uniform vec4 u_scale;
uniform vec4 u_overview_scale;
uniform float u_palette_stop_count;
in vec2 v_uv;
out vec4 out_color;

float sample_overview(vec2 viewport_uv) {
  if (!u_has_overview) {
    return -1.0;
  }
  vec2 uv = vec2(
    u_overview_uv_rect.x + viewport_uv.x * u_overview_uv_rect.y,
    u_overview_uv_rect.z + viewport_uv.y * u_overview_uv_rect.w
  );
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) {
    return -1.0;
  }
  return texture(u_overview, uv).r;
}

vec4 palette(float value, vec4 scale) {
  float minimum = scale.x;
  float maximum = scale.y;
  float intensity;
  if (maximum == minimum) {
    intensity = value >= maximum ? 1.0 : 0.0;
  } else if (scale.z > 0.5) {
    float log_minimum = log(minimum + 1.0) / log(10.0);
    float log_range = log(maximum + 1.0) / log(10.0) - log_minimum;
    intensity = (log(value + 1.0) / log(10.0) - log_minimum) / log_range;
  } else {
    intensity = (value - minimum) / (maximum - minimum);
  }
  intensity = clamp(intensity, 0.0, 1.0);
  float lut_index;
  if (u_palette_stop_count > 0.5) {
    float stop_index = min(
      u_palette_stop_count - 1.0,
      floor(intensity * u_palette_stop_count)
    );
    float representative = (stop_index + 0.5) / u_palette_stop_count;
    lut_index = floor(representative * 255.0);
  } else {
    lut_index = floor(intensity * 255.0);
  }
  vec4 color = texelFetch(u_lut, ivec2(int(lut_index), 0), 0);
  return vec4(mix(vec3(1.0), color.rgb, color.a), 1.0);
}

void main() {
  vec2 relative_tile = vec2(
    u_camera_tiles.x + v_uv.x * u_camera_tiles.y,
    u_camera_tiles.z + v_uv.y * u_camera_tiles.w
  );
  ivec2 world_page = u_camera_page + ivec2(floor(relative_tile));
  ivec2 page = world_page - u_page_origin;
  bool page_in_range = all(greaterThanEqual(page, ivec2(0)))
    && all(lessThan(page, u_page_size));
  uvec2 entry = page_in_range
    ? texelFetch(u_page_table, page, 0).rg
    : uvec2(0u);
  bool exact_page = (entry.g & 2u) != 0u;
  float value = -1.0;
  if (entry.r > 0u) {
    vec2 local = fract(relative_tile);
    if ((entry.g & 1u) != 0u) {
      local = local.yx;
    }
    value = texture(u_tile_array, vec3(local, float(entry.r - 1u))).r;
  }
  if (value >= 0.0) {
    out_color = palette(value, u_scale);
    return;
  }
  if (exact_page) {
    out_color = vec4(1.0);
    return;
  }
  float overview_value = sample_overview(v_uv);
  out_color = overview_value >= 0.0
    ? palette(overview_value, u_overview_scale)
    : vec4(1.0);
}
`;

const boundaryVertexShaderSource = `#version 300 es
in vec4 a_edge;
in vec2 a_interval;
in vec3 a_color;
in vec2 a_style;
uniform vec4 u_viewport;
uniform vec2 u_canvas_size;
uniform vec2 u_css_size;
uniform vec2 u_css_scale;
out vec3 v_color;

void main() {
  float axis = a_edge.x;
  float side = a_edge.y;
  float along = a_edge.z;
  float across = a_edge.w;
  float start = a_interval.x;
  float end = a_interval.y;
  float span = max(0.0, end - start);
  float span_pixels = min(
    (span / max(1.0, u_viewport.y)) * u_css_size.x,
    (span / max(1.0, u_viewport.w)) * u_css_size.y
  );
  if (span <= 0.0 || span_pixels < a_style.y) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    v_color = a_color;
    return;
  }

  float edge_coordinate = mix(start, end, side);
  float along_coordinate = mix(start, end, along);
  vec2 world = axis < 0.5
    ? vec2(along_coordinate, edge_coordinate)
    : vec2(edge_coordinate, along_coordinate);
  vec2 normalized = vec2(
    (world.x - u_viewport.x) / max(1.0, u_viewport.y),
    (world.y - u_viewport.z) / max(1.0, u_viewport.w)
  );
  vec2 clip = normalized * 2.0 - 1.0;
  vec2 pixel_offset = axis < 0.5
    ? vec2(0.0, across * a_style.x * u_css_scale.y)
    : vec2(across * a_style.x * u_css_scale.x, 0.0);
  clip += vec2(
    (pixel_offset.x / u_canvas_size.x) * 2.0,
    (pixel_offset.y / u_canvas_size.y) * 2.0
  );
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}
`;

const boundaryFragmentShaderSource = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 out_color;

void main() {
  out_color = vec4(v_color, 1.0);
}
`;

const boundaryInstanceStrideFloats = 7;

/** Pack immutable world-space boundaries once; pointer pans reuse this buffer. */
export function contactTileGpuBoundaryInstanceData(
  boundaries: readonly ContactTileGpuBoundary[],
): Float32Array {
  const values = new Float32Array(boundaries.length * boundaryInstanceStrideFloats);
  let offset = 0;
  for (const boundary of boundaries) {
    values[offset] = boundary.visualStart;
    values[offset + 1] = boundary.visualEnd;
    values[offset + 2] = boundary.color[0];
    values[offset + 3] = boundary.color[1];
    values[offset + 4] = boundary.color[2];
    values[offset + 5] = Math.max(0.5, boundary.lineWidthCssPx);
    values[offset + 6] = Math.max(0, boundary.minimumSpanCssPx);
    offset += boundaryInstanceStrideFloats;
  }
  return values;
}

/**
 * Build a dense single-channel count texture. -1 marks a missing contact so
 * the shader can distinguish it from a real zero without a second occupancy
 * texture. Diagonal tiles are completed here; off-diagonal mirrors reuse the
 * same GPU texture with transposed UV coordinates.
 */
export function contactTileFloatTextureData(
  tile: ContactMapTile,
  tileSizeBins: number,
): Float32Array {
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    throw new RangeError("contact tile size must be a positive integer");
  }
  const cellCount = tileSizeBins * tileSizeBins;
  const dense = validatedDenseContactTileValues(tile);
  if (dense) {
    if (dense.values.length !== cellCount) {
      throw new RangeError("dense contact tile does not match tile size");
    }
    if (tile.tileX !== tile.tileY) {
      return dense.values;
    }
    const mirrored = dense.values.slice();
    for (let index = 0; index < cellCount; index += 1) {
      const value = dense.values[index];
      if (value === -1) {
        continue;
      }
      const x = index % tileSizeBins;
      const y = Math.floor(index / tileSizeBins);
      if (x !== y) {
        mirrored[x * tileSizeBins + y] = value;
      }
    }
    return mirrored;
  }
  const values = new Float32Array(cellCount);
  values.fill(-1);
  const packed = validatedPackedContactTileCells(tile);
  const mirrorsDiagonal = tile.tileX === tile.tileY;

  const write = (x: number, y: number, value: number) => {
    if (
      x < 0
      || y < 0
      || x >= tileSizeBins
      || y >= tileSizeBins
      || !Number.isInteger(x)
      || !Number.isInteger(y)
    ) {
      return;
    }
    values[y * tileSizeBins + x] = value;
    if (mirrorsDiagonal && x !== y) {
      values[x * tileSizeBins + y] = value;
    }
  };

  if (packed) {
    for (let index = 0; index < packed.counts.length; index += 1) {
      write(packed.xLocal[index], packed.yLocal[index], packed.counts[index]);
    }
    return values;
  }

  const tileStartX = tile.tileX * tileSizeBins;
  const tileStartY = tile.tileY * tileSizeBins;
  for (const cell of tile.cells) {
    write(cell.xBin - tileStartX, cell.yBin - tileStartY, cell.count);
  }
  return values;
}

/** Fixed-size whole-assembly base texture used by the main viewport. */
export function contactOverviewFloatTextureData(
  map: Pick<ContactMapView, "cells" | "resolution" | "viewport">,
  targetBins = contactOverviewTextureBins,
  colorScale?: ContactTileRenderStyle["colorScale"],
): ContactTileGpuOverview {
  if (!Number.isSafeInteger(targetBins) || targetBins <= 0) {
    throw new RangeError("contact overview size must be a positive integer");
  }
  if (!Number.isFinite(map.resolution) || map.resolution <= 0) {
    throw new RangeError("contact overview resolution must be positive");
  }
  const xSpan = map.viewport.xEnd - map.viewport.xStart;
  const ySpan = map.viewport.yEnd - map.viewport.yStart;
  if (!(xSpan > 0) || !(ySpan > 0)) {
    throw new RangeError("contact overview viewport must have positive area");
  }

  const values = new Float32Array(targetBins * targetBins);
  values.fill(-1);
  const writeRectangle = (
    xStartBp: number,
    xEndBp: number,
    yStartBp: number,
    yEndBp: number,
    value: number,
  ) => {
    const left = Math.max(0, Math.floor(
      ((xStartBp - map.viewport.xStart) / xSpan) * targetBins,
    ));
    const right = Math.min(targetBins, Math.ceil(
      ((xEndBp - map.viewport.xStart) / xSpan) * targetBins,
    ));
    const top = Math.max(0, Math.floor(
      ((yStartBp - map.viewport.yStart) / ySpan) * targetBins,
    ));
    const bottom = Math.min(targetBins, Math.ceil(
      ((yEndBp - map.viewport.yStart) / ySpan) * targetBins,
    ));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const index = y * targetBins + x;
        values[index] = values[index] < 0 ? value : Math.max(values[index], value);
      }
    }
  };

  for (const cell of map.cells) {
    if (
      !Number.isFinite(cell.xBin)
      || !Number.isFinite(cell.yBin)
      || !Number.isFinite(cell.count)
    ) {
      continue;
    }
    const xStartBp = cell.xBin * map.resolution;
    const yStartBp = cell.yBin * map.resolution;
    writeRectangle(
      xStartBp,
      xStartBp + map.resolution,
      yStartBp,
      yStartBp + map.resolution,
      cell.count,
    );
    if (cell.xBin !== cell.yBin) {
      writeRectangle(
        yStartBp,
        yStartBp + map.resolution,
        xStartBp,
        xStartBp + map.resolution,
        cell.count,
      );
    }
  }

  return {
    values,
    width: targetBins,
    height: targetBins,
    viewport: map.viewport,
    colorScale,
  };
}

export function contactOverviewTextureBytes(
  width = contactOverviewTextureBins,
  height = contactOverviewTextureBins,
  format: ContactTileGpuTextureFormat = "r16f",
) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("contact overview dimensions must be positive integers");
  }
  return width * height * contactTileGpuBytesPerTexel(format);
}

export function contactTileGpuBytesPerTexel(format: ContactTileGpuTextureFormat) {
  return format === "r16f" ? 2 : Float32Array.BYTES_PER_ELEMENT;
}

export function contactTileGpuFloatValuesFitR16f(values: Float32Array) {
  for (const value of values) {
    if (!Number.isFinite(value) || Math.abs(value) > contactTileGpuR16fMaximum) {
      return false;
    }
  }
  return true;
}

export function contactTileGpuTexturePreference(
  search = typeof location === "undefined" ? "" : location.search,
): ContactTileGpuTexturePreference {
  return new URLSearchParams(search).get("cstudioGpuTexture") === "r32f"
    ? "r32f"
    : "r16f";
}

export function contactTileGpuVirtualTextureEnabled(
  search = typeof location === "undefined" ? "" : location.search,
) {
  return new URLSearchParams(search).get("cstudioVirtualTexture") !== "0";
}

/** Convert the mutable streamed accumulator into the single-channel texture layout. */
export function contactTileDenseFloatTextureData(
  buffer: ContactTileDenseDeltaBuffer,
  tileSizeBins: number,
  target?: Float32Array,
): Float32Array {
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    throw new RangeError("contact tile size must be a positive integer");
  }
  const cellCount = tileSizeBins * tileSizeBins;
  if (buffer.completeValues) {
    if (buffer.completeValues.length !== cellCount) {
      throw new RangeError("completed dense contact tile does not match tile size");
    }
    if (buffer.tile.tileX !== buffer.tile.tileY) {
      return buffer.completeValues;
    }
    const values = target ?? new Float32Array(cellCount);
    values.set(buffer.completeValues);
    for (let index = 0; index < cellCount; index += 1) {
      const value = buffer.completeValues[index];
      if (value === -1) {
        continue;
      }
      const x = index % tileSizeBins;
      const y = Math.floor(index / tileSizeBins);
      if (x !== y) {
        values[x * tileSizeBins + y] = value;
      }
    }
    return values;
  }
  if (buffer.counts.length !== cellCount || buffer.occupied.length !== cellCount) {
    throw new RangeError("contact delta buffer does not match tile size");
  }
  const values = target ?? new Float32Array(cellCount);
  if (values.length !== cellCount) {
    throw new RangeError("contact delta texture target does not match tile size");
  }
  values.fill(-1);
  const mirrorsDiagonal = buffer.tile.tileX === buffer.tile.tileY;
  for (let index = 0; index < cellCount; index += 1) {
    if (buffer.occupied[index] === 0) {
      continue;
    }
    const value = buffer.counts[index];
    values[index] = value;
    if (mirrorsDiagonal) {
      const x = index % tileSizeBins;
      const y = Math.floor(index / tileSizeBins);
      if (x !== y) {
        values[x * tileSizeBins + y] = value;
      }
    }
  }
  return values;
}

interface ContactTileGpuMutablePerformance extends ContactTileGpuPerformanceSnapshot {
  lastEmissionSignature: string;
}

interface ContactTileGpuUploadContext {
  preference: ContactTileGpuTexturePreference;
  performance: ContactTileGpuMutablePerformance;
  clock: () => number;
}

interface ContactTileGpuUploadResult {
  format: ContactTileGpuTextureFormat;
  bytes: number;
}

function initialContactTileGpuPerformance(
  texturePreference: ContactTileGpuTexturePreference,
): ContactTileGpuMutablePerformance {
  return {
    texturePreference,
    uploads: 0,
    fullUploads: 0,
    subUploads: 0,
    r16fUploads: 0,
    r32fUploads: 0,
    rangeFallbacks: 0,
    uploadErrorFallbacks: 0,
    uploadMilliseconds: 0,
    evictions: 0,
    evictedBytes: 0,
    cacheEntries: 0,
    cacheBytes: 0,
    scenePromotions: 0,
    scenePromotionMisses: 0,
    scenePromotionMilliseconds: 0,
    virtualTextureDraws: 0,
    virtualTextureFallbacks: 0,
    virtualTextureUploads: 0,
    virtualTexturePages: 0,
    virtualTextureLayers: 0,
    virtualTextureBytes: 0,
    lastEmissionSignature: "",
  };
}

function contactTileGpuPerformanceSnapshot(
  performance: ContactTileGpuMutablePerformance,
): ContactTileGpuPerformanceSnapshot {
  const { lastEmissionSignature: _lastEmissionSignature, ...snapshot } = performance;
  return { ...snapshot };
}

function formatContactTileGpuPerformanceLog(
  snapshot: ContactTileGpuPerformanceSnapshot,
  generation: number | null,
) {
  return [
    "CSTUDIO_PERF",
    "event=contact_gpu_texture",
    `generation=${generation ?? "null"}`,
    `texture_preference=${snapshot.texturePreference}`,
    `uploads=${snapshot.uploads}`,
    `full_uploads=${snapshot.fullUploads}`,
    `sub_uploads=${snapshot.subUploads}`,
    `r16f_uploads=${snapshot.r16fUploads}`,
    `r32f_uploads=${snapshot.r32fUploads}`,
    `range_fallbacks=${snapshot.rangeFallbacks}`,
    `upload_error_fallbacks=${snapshot.uploadErrorFallbacks}`,
    `upload_ms=${roundGpuMilliseconds(snapshot.uploadMilliseconds)}`,
    `evictions=${snapshot.evictions}`,
    `evicted_bytes=${snapshot.evictedBytes}`,
    `cache_entries=${snapshot.cacheEntries}`,
    `cache_bytes=${snapshot.cacheBytes}`,
    `scene_promotions=${snapshot.scenePromotions}`,
    `scene_promotion_misses=${snapshot.scenePromotionMisses}`,
    `scene_promotion_ms=${roundGpuMilliseconds(snapshot.scenePromotionMilliseconds)}`,
    `virtual_texture_draws=${snapshot.virtualTextureDraws}`,
    `virtual_texture_fallbacks=${snapshot.virtualTextureFallbacks}`,
    `virtual_texture_uploads=${snapshot.virtualTextureUploads}`,
    `virtual_texture_pages=${snapshot.virtualTexturePages}`,
    `virtual_texture_layers=${snapshot.virtualTextureLayers}`,
    `virtual_texture_bytes=${snapshot.virtualTextureBytes}`,
  ].join(" ");
}

function roundGpuMilliseconds(value: number) {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

export function createContactTileGpuRenderer(
  canvas: HTMLCanvasElement,
  textureBudgetBytes = contactTileGpuTextureBudgetBytes,
  options: ContactTileGpuRendererOptions = {},
): ContactTileGpuRenderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    desynchronized: true,
    failIfMajorPerformanceCaveat: false,
    powerPreference: "high-performance",
    premultipliedAlpha: true,
    // ContactLayoutRasterPreview reads the last complete authoritative frame
    // during AGP edits. The default buffer therefore remains readable, while
    // the offscreen framebuffer below prevents partial scene presentation.
    preserveDrawingBuffer: true,
    stencil: false,
  });
  if (!gl) {
    return null;
  }

  const resources = createRendererResources(gl);
  if (!resources) {
    return null;
  }
  const boundaryResources = createBoundaryRendererResources(gl);
  if (!boundaryResources) {
    gl.deleteTexture(resources.lutTexture);
    gl.deleteBuffer(resources.quadBuffer);
    gl.deleteProgram(resources.program);
    return null;
  }
  // The virtual-texture program is an optional WebGL2 acceleration path. A
  // driver/compiler miss leaves the established per-tile renderer available.
  const virtualTextureEnabled = options.virtualTextureEnabled
    ?? contactTileGpuVirtualTextureEnabled();
  const virtualResources = virtualTextureEnabled
    ? createVirtualTextureRendererResources(gl)
    : null;

  const texturePreference = options.texturePreference ?? contactTileGpuTexturePreference();
  const performanceEnabled = options.performanceEnabled ?? isContactTilePerformanceEnabled();
  const emitPerformance = options.emitPerformance ?? ((line: string) => console.info(line));
  const uploadContext: ContactTileGpuUploadContext = {
    preference: texturePreference,
    performance: initialContactTileGpuPerformance(texturePreference),
    clock: options.clock ?? (() => (
      typeof performance === "undefined" ? Date.now() : performance.now()
    )),
  };
  const textureCache = new Map<string, GpuTextureEntry>();
  const safeTextureBudget = Math.max(1, Math.floor(textureBudgetBytes));
  let textureBytes = 0;
  let useCounter = 0;
  let scene: ContactTileGpuScene | null = null;
  let deltaScene: ContactTileGpuDeltaScene | null = null;
  let deltaBuffers = new Map<string, ContactTileDenseDeltaBuffer>();
  let deltaScratch = new Float32Array(0);
  const pendingAppendedDescriptors = new Map<string, ContactTileCanvasDescriptor>();
  let overviewTextureEntry: GpuOverviewTextureEntry | null = null;
  let destroyed = false;
  let lutColormap: ContactTileRenderStyle["colormap"] | null = null;
  let presentedCssWidth = 1;
  let presentedCssHeight = 1;
  let uploadedBoundaries: readonly ContactTileGpuBoundary[] | null = null;
  let uploadedBoundaryCount = 0;
  let framePresentation: FramePresentationResources | null = null;
  let virtualTextureState: VirtualTextureState | null = null;

  const updatePerformanceCacheState = () => {
    uploadContext.performance.cacheEntries = textureCache.size;
    uploadContext.performance.cacheBytes = textureBytes;
  };
  const emitPerformanceIfChanged = () => {
    if (!performanceEnabled) {
      return;
    }
    updatePerformanceCacheState();
    const signature = `${uploadContext.performance.uploads}:${uploadContext.performance.evictions}:${uploadContext.performance.scenePromotions}:${uploadContext.performance.scenePromotionMisses}:${uploadContext.performance.virtualTextureUploads}:${uploadContext.performance.virtualTextureFallbacks}:${textureCache.size}:${textureBytes}`;
    if (signature === uploadContext.performance.lastEmissionSignature) {
      return;
    }
    uploadContext.performance.lastEmissionSignature = signature;
    try {
      emitPerformance(formatContactTileGpuPerformanceLog(
        contactTileGpuPerformanceSnapshot(uploadContext.performance),
        (deltaScene ?? scene)?.generation ?? null,
      ));
    } catch {
      // Diagnostics must never interrupt heatmap presentation.
    }
  };

  const deleteVirtualTextureState = (state: VirtualTextureState | null) => {
    if (!state) {
      return;
    }
    gl.deleteTexture(state.tileArray);
    gl.deleteTexture(state.pageTable);
  };

  const maximumVirtualTextureLayers = (tileSizeBins: number, pageBytes: number) => {
    const driverMaximum = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS));
    if (!Number.isFinite(driverMaximum) || driverMaximum < 1) {
      return 0;
    }
    const bytesPerLayer = tileSizeBins * tileSizeBins * Float32Array.BYTES_PER_ELEMENT;
    const budget = Math.max(
      0,
      Math.min(safeTextureBudget, contactTileGpuVirtualTextureBudgetBytes) - pageBytes,
    );
    return Math.max(0, Math.min(
      Math.floor(driverMaximum),
      Math.floor(budget / Math.max(1, bytesPerLayer)),
    ));
  };

  const virtualPagePlanFits = (plan: ContactTileVirtualPagePlan) => {
    const maximumTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const pageBytes = plan.width * plan.height * 2 * Uint32Array.BYTES_PER_ELEMENT;
    return Number.isFinite(maximumTextureSize)
      && plan.width <= maximumTextureSize
      && plan.height <= maximumTextureSize
      && Number.isSafeInteger(pageBytes)
      && pageBytes <= Math.min(4 * 1024 * 1024, contactTileGpuVirtualTextureBudgetBytes / 4);
  };

  const virtualTextureCapacity = (required: number, maximum: number) => {
    if (required > maximum || maximum <= 0) {
      return 0;
    }
    let capacity = 1;
    const target = Math.min(maximum, Math.max(required, required + 16));
    while (capacity < target && capacity < maximum) {
      capacity *= 2;
    }
    return Math.min(maximum, Math.max(required, capacity));
  };

  const rebuildVirtualTextureState = (activeScene: ContactTileGpuScene) => {
    if (!virtualResources || activeScene.visibleLayerComplete !== true) {
      return false;
    }
    const plan = contactTileVirtualPagePlan(activeScene.descriptors);
    if (!plan || !virtualPagePlanFits(plan)) {
      return false;
    }
    const pageBytes = plan.width * plan.height * 2 * Uint32Array.BYTES_PER_ELEMENT;
    const maximumLayers = maximumVirtualTextureLayers(activeScene.tileSizeBins, pageBytes);
    const capacity = virtualTextureCapacity(plan.populatedTiles.length, maximumLayers);
    if (capacity === 0) {
      return false;
    }
    const tileArray = gl.createTexture();
    const pageTable = gl.createTexture();
    if (!tileArray || !pageTable) {
      if (tileArray) gl.deleteTexture(tileArray);
      if (pageTable) gl.deleteTexture(pageTable);
      return false;
    }

    const layerByTileKey = new Map<string, number>();
    const tileByTileKey = new Map<string, ContactMapTile>();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tileArray);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      gl.R32F,
      activeScene.tileSizeBins,
      activeScene.tileSizeBins,
      capacity,
      0,
      gl.RED,
      gl.FLOAT,
      null,
    );
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(tileArray);
      gl.deleteTexture(pageTable);
      return false;
    }
    for (let layer = 0; layer < plan.populatedTiles.length; layer += 1) {
      const { key, tile } = plan.populatedTiles[layer]!;
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        layer,
        activeScene.tileSizeBins,
        activeScene.tileSizeBins,
        1,
        gl.RED,
        gl.FLOAT,
        contactTileFloatTextureData(tile, activeScene.tileSizeBins),
      );
      layerByTileKey.set(key, layer);
      tileByTileKey.set(key, tile);
    }
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(tileArray);
      gl.deleteTexture(pageTable);
      return false;
    }
    const pageTableData = contactTileVirtualPageTableData(plan, layerByTileKey);
    if (!pageTableData) {
      gl.deleteTexture(tileArray);
      gl.deleteTexture(pageTable);
      return false;
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, pageTable);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG32UI,
      plan.width,
      plan.height,
      0,
      gl.RG_INTEGER,
      gl.UNSIGNED_INT,
      pageTableData,
    );
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(tileArray);
      gl.deleteTexture(pageTable);
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    const nextState: VirtualTextureState = {
      tileArray,
      pageTable,
      capacity,
      resolution: activeScene.resolution,
      tileSizeBins: activeScene.tileSizeBins,
      layerByTileKey,
      tileByTileKey,
      plan,
      pageTableData,
      bytes: (
        capacity
        * activeScene.tileSizeBins
        * activeScene.tileSizeBins
        * Float32Array.BYTES_PER_ELEMENT
      ) + pageTableData.byteLength,
    };
    deleteVirtualTextureState(virtualTextureState);
    virtualTextureState = nextState;
    uploadContext.performance.virtualTextureUploads += plan.populatedTiles.length;
    uploadContext.performance.virtualTexturePages = plan.pages.length;
    uploadContext.performance.virtualTextureLayers = layerByTileKey.size;
    uploadContext.performance.virtualTextureBytes = nextState.bytes;
    return true;
  };

  const appendVirtualTextureScene = (activeScene: ContactTileGpuScene) => {
    const current = virtualTextureState;
    if (
      !current
      || current.resolution !== activeScene.resolution
      || current.tileSizeBins !== activeScene.tileSizeBins
      || activeScene.visibleLayerComplete !== true
    ) {
      return rebuildVirtualTextureState(activeScene);
    }
    const plan = contactTileVirtualPagePlan(activeScene.descriptors);
    if (!plan || !virtualPagePlanFits(plan)) {
      return false;
    }
    const missingLayerKeys = plan.populatedTiles.filter(
      ({ key }) => !current.layerByTileKey.has(key),
    );
    if (current.layerByTileKey.size + missingLayerKeys.length > current.capacity) {
      return rebuildVirtualTextureState(activeScene);
    }
    const pageBytes = plan.width * plan.height * 2 * Uint32Array.BYTES_PER_ELEMENT;
    const layerBytes = current.capacity
      * activeScene.tileSizeBins
      * activeScene.tileSizeBins
      * Float32Array.BYTES_PER_ELEMENT;
    if (
      layerBytes + pageBytes
      > Math.min(safeTextureBudget, contactTileGpuVirtualTextureBudgetBytes)
    ) {
      return rebuildVirtualTextureState(activeScene);
    }
    const nextLayers = new Map(current.layerByTileKey);
    const nextTiles = new Map(current.tileByTileKey);
    let uploaded = 0;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, current.tileArray);
    for (const { key, tile } of plan.populatedTiles) {
      let layer = nextLayers.get(key);
      if (layer === undefined) {
        layer = nextLayers.size;
        nextLayers.set(key, layer);
      }
      if (nextTiles.get(key) === tile) {
        continue;
      }
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        layer,
        activeScene.tileSizeBins,
        activeScene.tileSizeBins,
        1,
        gl.RED,
        gl.FLOAT,
        contactTileFloatTextureData(tile, activeScene.tileSizeBins),
      );
      nextTiles.set(key, tile);
      uploaded += 1;
    }
    if (uploaded > 0 && gl.getError() !== gl.NO_ERROR) {
      return false;
    }
    const pageTableData = contactTileVirtualPageTableData(plan, nextLayers);
    if (!pageTableData) {
      return false;
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, current.pageTable);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG32UI,
      plan.width,
      plan.height,
      0,
      gl.RG_INTEGER,
      gl.UNSIGNED_INT,
      pageTableData,
    );
    if (gl.getError() !== gl.NO_ERROR) {
      return false;
    }
    current.layerByTileKey = nextLayers;
    current.tileByTileKey = nextTiles;
    current.plan = plan;
    current.pageTableData = pageTableData;
    current.bytes = (
      current.capacity
      * activeScene.tileSizeBins
      * activeScene.tileSizeBins
      * Float32Array.BYTES_PER_ELEMENT
    ) + pageTableData.byteLength;
    uploadContext.performance.virtualTextureUploads += uploaded;
    uploadContext.performance.virtualTexturePages = plan.pages.length;
    uploadContext.performance.virtualTextureLayers = nextLayers.size;
    uploadContext.performance.virtualTextureBytes = current.bytes;
    return true;
  };

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const virtualTextureCoversViewport = (
    state: VirtualTextureState,
    viewport: ContactViewport,
    overview: ContactTileGpuOverview | null,
  ) => {
    const tileSpan = state.resolution * state.tileSizeBins;
    const firstX = Math.floor(viewport.xStart / tileSpan);
    const lastX = Math.ceil(viewport.xEnd / tileSpan) - 1;
    const firstY = Math.floor(viewport.yStart / tileSpan);
    const lastY = Math.ceil(viewport.yEnd / tileSpan) - 1;
    const overviewCoversViewport = Boolean(
      overview
      && overview.viewport.xStart <= viewport.xStart
      && overview.viewport.xEnd >= viewport.xEnd
      && overview.viewport.yStart <= viewport.yStart
      && overview.viewport.yEnd >= viewport.yEnd,
    );
    for (let pageY = firstY; pageY <= lastY; pageY += 1) {
      for (let pageX = firstX; pageX <= lastX; pageX += 1) {
        const localX = pageX - state.plan.originX;
        const localY = pageY - state.plan.originY;
        const pageInRange = localX >= 0
          && localX < state.plan.width
          && localY >= 0
          && localY < state.plan.height;
        const flags = pageInRange
          ? state.pageTableData[(localY * state.plan.width + localX) * 2 + 1]
          : 0;
        if ((flags & contactTileVirtualPageExactFlag) === 0 && !overviewCoversViewport) {
          return false;
        }
      }
    }
    return true;
  };

  const drawVirtualTexturePan = (activeScene: ContactTileGpuScene) => {
    const state = virtualTextureState;
    if (
      !virtualResources
      || !state
      || activeScene.visibleLayerComplete !== true
      || state.resolution !== activeScene.resolution
      || state.tileSizeBins !== activeScene.tileSizeBins
      || !framePresentation
      || !virtualTextureCoversViewport(state, activeScene.viewport, activeScene.overview ?? null)
    ) {
      uploadContext.performance.virtualTextureFallbacks += 1;
      return false;
    }
    const overview = activeScene.overview ?? null;
    if (overview && !overviewTextureEntry) {
      uploadContext.performance.virtualTextureFallbacks += 1;
      return false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framePresentation.framebuffer);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(virtualResources.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.quadBuffer);
    gl.enableVertexAttribArray(virtualResources.positionLocation);
    gl.vertexAttribPointer(virtualResources.positionLocation, 2, gl.FLOAT, false, 0, 0);
    const camera = contactTileVirtualCamera(
      activeScene.viewport,
      activeScene.resolution,
      activeScene.tileSizeBins,
    );
    gl.uniform4f(
      virtualResources.cameraTilesLocation,
      camera.localX,
      camera.spanX,
      camera.localY,
      camera.spanY,
    );
    gl.uniform2i(
      virtualResources.cameraPageLocation,
      camera.pageX,
      camera.pageY,
    );
    gl.uniform2i(
      virtualResources.pageOriginLocation,
      state.plan.originX,
      state.plan.originY,
    );
    gl.uniform2i(
      virtualResources.pageSizeLocation,
      state.plan.width,
      state.plan.height,
    );
    const exactScale = activeScene.renderStyle.colorScale;
    const overviewScale = overview?.colorScale ?? exactScale;
    gl.uniform4f(
      virtualResources.scaleLocation,
      Math.max(0, exactScale.min),
      Math.max(Math.max(0, exactScale.min), exactScale.max),
      exactScale.log ? 1 : 0,
      0,
    );
    gl.uniform4f(
      virtualResources.overviewScaleLocation,
      Math.max(0, overviewScale.min),
      Math.max(Math.max(0, overviewScale.min), overviewScale.max),
      overviewScale.log ? 1 : 0,
      0,
    );
    gl.uniform1f(
      virtualResources.paletteStopCountLocation,
      paletteStopCount(activeScene.renderStyle.colormap),
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, state.tileArray);
    gl.uniform1i(virtualResources.tileArrayLocation, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, resources.lutTexture);
    gl.uniform1i(virtualResources.lutTextureLocation, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, state.pageTable);
    gl.uniform1i(virtualResources.pageTableLocation, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, overviewTextureEntry?.texture ?? null);
    gl.uniform1i(virtualResources.overviewTextureLocation, 3);
    gl.uniform1i(virtualResources.hasOverviewLocation, overview ? 1 : 0);
    const overviewXSpan = overview
      ? Math.max(1, overview.viewport.xEnd - overview.viewport.xStart)
      : 1;
    const overviewYSpan = overview
      ? Math.max(1, overview.viewport.yEnd - overview.viewport.yStart)
      : 1;
    gl.uniform4f(
      virtualResources.overviewUvRectLocation,
      overview ? (activeScene.viewport.xStart - overview.viewport.xStart) / overviewXSpan : 0,
      overview
        ? (activeScene.viewport.xEnd - activeScene.viewport.xStart) / overviewXSpan
        : 1,
      overview ? (activeScene.viewport.yStart - overview.viewport.yStart) / overviewYSpan : 0,
      overview
        ? (activeScene.viewport.yEnd - activeScene.viewport.yStart) / overviewYSpan
        : 1,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const boundaries = activeScene.boundaries ?? [];
    if (!drawBoundaryScene(
      gl,
      boundaryResources,
      boundaries,
      activeScene.viewport,
      canvas.width,
      canvas.height,
      presentedCssWidth,
      presentedCssHeight,
      uploadedBoundaries,
      uploadedBoundaryCount,
    )) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      uploadContext.performance.virtualTextureFallbacks += 1;
      return false;
    }
    if (uploadedBoundaries !== boundaries) {
      uploadedBoundaries = boundaries;
      uploadedBoundaryCount = boundaries.length;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    presentFramePresentation(gl, framePresentation, canvas.width, canvas.height);
    uploadContext.performance.virtualTextureDraws += 1;
    return true;
  };

  const draw = (
    panOnly = false,
    descriptors: readonly ContactTileCanvasDescriptor[] | null = null,
    preserveFramebuffer = false,
  ): boolean => {
    const activeScene = deltaScene ?? scene;
    if (destroyed || !activeScene || gl.isContextLost()) {
      return false;
    }
    // A retained front frame completely covers this staging canvas. Uploading
    // every streamed chunk here cannot improve what the user sees; defer the
    // first texture allocation until the terminal scene is promoted.
    if (deltaScene?.deferTextureUpdates) {
      return true;
    }
    if (!panOnly) {
      resizeCanvasToDisplaySize(canvas, gl);
      presentedCssWidth = Math.max(1, canvas.clientWidth || canvas.width);
      presentedCssHeight = Math.max(1, canvas.clientHeight || canvas.height);
      updateLutTexture(gl, resources.lutTexture, activeScene.renderStyle, lutColormap);
      lutColormap = activeScene.renderStyle.colormap;
    }

    framePresentation = ensureFramePresentationResources(
      gl,
      framePresentation,
      canvas.width,
      canvas.height,
    );
    if (!framePresentation) {
      return false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framePresentation.framebuffer);
    const abandonFrame = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    };

    gl.viewport(0, 0, canvas.width, canvas.height);
    if (!preserveFramebuffer) {
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.useProgram(resources.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.quadBuffer);
    gl.enableVertexAttribArray(resources.positionLocation);
    gl.vertexAttribPointer(resources.positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(resources.canvasSizeLocation, canvas.width, canvas.height);

    applyColorScaleUniforms(gl, resources, activeScene.renderStyle.colorScale);
    gl.uniform1f(
      resources.paletteStopCountLocation,
      paletteStopCount(activeScene.renderStyle.colormap),
    );
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, resources.lutTexture);
    gl.uniform1i(resources.lutTextureLocation, 1);

    const viewportWidth = Math.max(1, activeScene.viewport.xEnd - activeScene.viewport.xStart);
    const viewportHeight = Math.max(1, activeScene.viewport.yEnd - activeScene.viewport.yStart);
    const tileSpanBp = activeScene.resolution * activeScene.tileSizeBins;
    // Pointer pans reuse the dimensions captured by the last complete scene
    // draw. Reading clientWidth/clientHeight in every animation frame can force
    // synchronous layout in WebView2, while ResizeObserver already schedules a
    // complete redraw whenever those dimensions actually change.
    const cssWidth = presentedCssWidth;
    const cssHeight = presentedCssHeight;
    const scaleX = canvas.width / cssWidth;
    const scaleY = canvas.height / cssHeight;
    const protectedKeys = panOnly ? null : new Set<string>();
    const validatesCompleteCoverage = !panOnly
      && descriptors === null
      && deltaScene === null
      && scene?.visibleLayerComplete === true;
    const drawnDescriptorKeys = validatesCompleteCoverage ? new Set<string>() : null;
    const overview = activeScene.overview ?? null;

    if (!preserveFramebuffer && overview) {
      overviewTextureEntry = ensureOverviewTexture(
        gl,
        overviewTextureEntry,
        overview,
        uploadContext,
      );
      if (!overviewTextureEntry) {
        return abandonFrame();
      }
      if (overview.colorScale) {
        applyColorScaleUniforms(gl, resources, overview.colorScale);
      }
      const left = (
        ((overview.viewport.xStart - activeScene.viewport.xStart) / viewportWidth) * cssWidth
      ) * scaleX;
      const top = (
        ((overview.viewport.yStart - activeScene.viewport.yStart) / viewportHeight) * cssHeight
      ) * scaleY;
      const width = (
        (overview.viewport.xEnd - overview.viewport.xStart) / viewportWidth
      ) * canvas.width;
      const height = (
        (overview.viewport.yEnd - overview.viewport.yStart) / viewportHeight
      ) * canvas.height;
      drawTextureQuad(
        gl,
        resources,
        overviewTextureEntry.texture,
        left,
        top,
        width,
        height,
        false,
      );
      if (overview.colorScale) {
        applyColorScaleUniforms(gl, resources, activeScene.renderStyle.colorScale);
      }
    } else if (!overview && overviewTextureEntry) {
      gl.deleteTexture(overviewTextureEntry.texture);
      overviewTextureEntry = null;
    }

    for (const descriptor of descriptors ?? activeScene.descriptors) {
      const deltaBuffer = deltaScene
        ? deltaBuffers.get(contactTileKey(descriptor.tile))
        : undefined;
      const renderedTileX = descriptor.transpose ? descriptor.tile.tileY : descriptor.tile.tileX;
      const renderedTileY = descriptor.transpose ? descriptor.tile.tileX : descriptor.tile.tileY;
      const left = (
        ((renderedTileX * tileSpanBp - activeScene.viewport.xStart) / viewportWidth) * cssWidth
      ) * scaleX;
      const top = (
        ((renderedTileY * tileSpanBp - activeScene.viewport.yStart) / viewportHeight) * cssHeight
      ) * scaleY;
      const width = (tileSpanBp / viewportWidth) * canvas.width;
      const height = (tileSpanBp / viewportHeight) * canvas.height;

      // A terminal exact tile owns its full rectangle, including sparse zero
      // pixels. Mask the coarse base before drawing it. Streamed partial tiles
      // deliberately skip this mask so the overview remains visible where the
      // current batch has not arrived yet.
      const explicitlyMasksOverview = Boolean(
        overview
        && deltaScene === null
        && !preserveFramebuffer
        && scene?.visibleLayerComplete === true,
      );
      if (explicitlyMasksOverview) {
        clearCanvasRectToWhite(gl, canvas.width, canvas.height, left, top, width, height);
      }
      if (deltaScene ? !deltaBuffer || deltaBuffer.occupiedCount === 0 : contactTileCellCount(descriptor.tile) === 0) {
        if (explicitlyMasksOverview) {
          drawnDescriptorKeys?.add(descriptor.key);
        }
        continue;
      }

      const textureKey = gpuTextureKey(activeScene, descriptor.tile);
      protectedKeys?.add(textureKey);
      const cachedEntry = panOnly ? textureCache.get(textureKey) : undefined;
      const cachedEntryMatches = cachedEntry && (deltaScene && deltaBuffer
        ? cachedEntry.generation === deltaScene.generation
          && cachedEntry.deltaBuffer === deltaBuffer
        : cachedEntry.tile === descriptor.tile);
      if (panOnly && !cachedEntryMatches) {
        // Scene changes normally run a complete draw before pointer input can
        // reach this path. Fall back defensively if that ordering is ever
        // broken instead of presenting a partially translated surface.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return draw();
      }
      const entry = cachedEntryMatches
        ? cachedEntry
        : deltaScene && deltaBuffer
          ? ensureDeltaTileTexture(
              gl,
              textureCache,
              textureKey,
              deltaBuffer,
              deltaScene.generation,
              deltaScene.tileSizeBins,
              ++useCounter,
              deltaScratch,
              uploadContext,
            )
          : ensureTileTexture(
              gl,
              textureCache,
              textureKey,
              descriptor.tile,
              activeScene.generation,
              activeScene.tileSizeBins,
              ++useCounter,
              uploadContext,
            );
      if (!entry || !textureCache.has(textureKey)) {
        continue;
      }
      drawTextureQuad(
        gl,
        resources,
        entry.texture,
        left,
        top,
        width,
        height,
        descriptor.transpose,
      );
      drawnDescriptorKeys?.add(descriptor.key);
    }

    // Cache size is independent of descriptor count. Recomputing it inside the
    // tile loop made a pan frame O(visible tiles * cached textures), which is
    // particularly costly in Windows WebView2/ANGLE. A pointer-only redraw
    // cannot change the cache at all, so it skips accounting and eviction.
    if (!panOnly) {
      textureBytes = cachedTextureBytes(textureCache);
    }
    if (!panOnly && textureBytes > safeTextureBudget) {
      const eviction = evictLeastRecentlyUsedTextures(
        gl,
        textureCache,
        textureBytes,
        safeTextureBudget,
        protectedKeys!,
      );
      textureBytes = eviction.bytes;
      uploadContext.performance.evictions += eviction.count;
      uploadContext.performance.evictedBytes += eviction.evictedBytes;
    }
    const boundaries = activeScene.boundaries ?? [];
    if (!drawBoundaryScene(
      gl,
      boundaryResources,
      boundaries,
      activeScene.viewport,
      canvas.width,
      canvas.height,
      presentedCssWidth,
      presentedCssHeight,
      uploadedBoundaries,
      uploadedBoundaryCount,
    )) {
      return abandonFrame();
    }
    if (uploadedBoundaries !== boundaries) {
      uploadedBoundaries = boundaries;
      uploadedBoundaryCount = boundaries.length;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (panOnly) {
      presentFramePresentation(gl, framePresentation, canvas.width, canvas.height);
      return true;
    }
    emitPerformanceIfChanged();
    // Texture uploads and framebuffer creation validate their own failures.
    // Avoid a scene-wide getError() here: ANGLE may flush the command stream,
    // which turns an otherwise cache-only pan commit into a CPU/GPU sync point.
    const complete = !gl.isContextLost() && (
      deltaScene !== null
      || !validatesCompleteCoverage
      || contactTileGpuDrawCoverageIsComplete(
        activeScene.descriptors,
        drawnDescriptorKeys!,
        overview !== null,
      )
    );
    if (!complete) {
      return abandonFrame();
    }
    presentFramePresentation(gl, framePresentation, canvas.width, canvas.height);
    return true;
  };

  return {
    setScene: (nextScene) => {
      if (
        !deltaScene
        && scene
        && sameContactTileGpuScene(scene, nextScene)
      ) {
        // ContactTileLayer publishes the already-promoted frame through React
        // immediately after promoteScene(). Do not clear, upload, or draw the
        // same pixels a second time in the child layout effect.
        scene = nextScene;
        return true;
      }
      if (
        deltaScene
        && nextScene.generation !== undefined
        && deltaScene.generation === nextScene.generation
      ) {
        for (const buffer of deltaBuffers.values()) {
          if (buffer.occupiedCount === 0) {
            continue;
          }
          const textureKey = gpuTextureKey(deltaScene, {
            tileX: buffer.tile.tileX,
            tileY: buffer.tile.tileY,
          });
          const cached = textureCache.get(textureKey);
          const cachedMatchesBuffer = cached?.generation === deltaScene.generation
            && cached.deltaBuffer === buffer;
          const entry = ensureDeltaTileTexture(
            gl,
            textureCache,
            textureKey,
            buffer,
            deltaScene.generation,
            deltaScene.tileSizeBins,
            ++useCounter,
            deltaScratch,
            uploadContext,
          );
          if (
            !entry
            || (cachedMatchesBuffer && !updateDeltaTileTexture(
              gl,
              entry,
              buffer,
              deltaScene.tileSizeBins,
              deltaScratch,
              uploadContext,
            ))
          ) {
            return false;
          }
        }
      }
      deltaScene = null;
      deltaBuffers = new Map();
      pendingAppendedDescriptors.clear();
      scene = nextScene;
      const drawn = draw();
      if (drawn) {
        rebuildVirtualTextureState(nextScene);
      }
      return drawn;
    },
    promoteScene: (nextScene) => {
      const startedAt = uploadContext.clock();
      const fail = () => {
        uploadContext.performance.scenePromotionMisses += 1;
        emitPerformanceIfChanged();
        return false;
      };
      if (
        destroyed
        || !scene
        || deltaScene
        || gl.isContextLost()
        || scene.resolution !== nextScene.resolution
        || scene.tileSizeBins !== nextScene.tileSizeBins
        || nextScene.visibleLayerComplete !== true
        || !sameContactTileGpuOverview(scene.overview ?? null, nextScene.overview ?? null)
      ) {
        return fail();
      }

      const promotableEntries: Array<{
        entry: GpuTextureEntry;
        tile: ContactMapTile;
      }> = [];
      for (const descriptor of nextScene.descriptors) {
        if (contactTileCellCount(descriptor.tile) === 0) {
          continue;
        }
        const entry = textureCache.get(gpuTextureKey(nextScene, descriptor.tile));
        const exactTile = entry?.tile === descriptor.tile;
        const residentCellCount = entry?.tile
          ? contactTileCellCount(entry.tile)
          : entry?.deltaBuffer?.occupiedCount;
        const matchingPrefetch = Boolean(
          entry
          && nextScene.generation !== undefined
          && entry.generation === nextScene.generation
          && (entry.panPrefetchSnapshot || entry.deltaBuffer)
          && residentCellCount === contactTileCellCount(descriptor.tile)
        );
        if (!entry || (!exactTile && !matchingPrefetch)) {
          return fail();
        }
        promotableEntries.push({ entry, tile: descriptor.tile });
      }

      const previousScene = scene;
      const previousPendingDescriptors = new Map(pendingAppendedDescriptors);
      const previousEntryState = promotableEntries.map(({ entry }) => ({
        entry,
        tile: entry.tile,
        deltaBuffer: entry.deltaBuffer,
        panPrefetchSnapshot: entry.panPrefetchSnapshot,
        generation: entry.generation,
        lastUsed: entry.lastUsed,
      }));
      for (const { entry, tile } of promotableEntries) {
        entry.tile = tile;
        entry.deltaBuffer = undefined;
        entry.panPrefetchSnapshot = false;
        entry.generation = nextScene.generation;
        entry.lastUsed = ++useCounter;
      }
      pendingAppendedDescriptors.clear();
      scene = nextScene;
      const uploadsBeforePromotion = uploadContext.performance.uploads;
      const promoted = draw();
      if (!promoted || uploadContext.performance.uploads !== uploadsBeforePromotion) {
        scene = previousScene;
        pendingAppendedDescriptors.clear();
        for (const [key, descriptor] of previousPendingDescriptors) {
          pendingAppendedDescriptors.set(key, descriptor);
        }
        for (const previous of previousEntryState) {
          previous.entry.tile = previous.tile;
          previous.entry.deltaBuffer = previous.deltaBuffer;
          previous.entry.panPrefetchSnapshot = previous.panPrefetchSnapshot;
          previous.entry.generation = previous.generation;
          previous.entry.lastUsed = previous.lastUsed;
        }
        return fail();
      }

      uploadContext.performance.scenePromotions += 1;
      uploadContext.performance.scenePromotionMilliseconds += Math.max(
        0,
        uploadContext.clock() - startedAt,
      );
      emitPerformanceIfChanged();
      return true;
    },
    appendSceneDescriptors: (input) => {
      if (
        destroyed
        || !scene
        || deltaScene
        || gl.isContextLost()
        || scene.resolution !== input.resolution
        || scene.tileSizeBins !== input.tileSizeBins
      ) {
        return false;
      }
      const currentScene = scene;

      const bytesPerTile = Math.max(
        1,
        currentScene.tileSizeBins
          * currentScene.tileSizeBins
          * contactTileGpuBytesPerTexel(texturePreference),
      );
      const maximumUniqueTiles = Math.max(1, Math.floor(safeTextureBudget / bytesPerTile));
      const retainedDescriptors = [...currentScene.descriptors];
      const retainedDescriptorKeys = new Set(
        retainedDescriptors.map((descriptor) => descriptor.key),
      );
      const retainedTiles = new Map<string, ContactMapTile>();
      for (const descriptor of retainedDescriptors) {
        retainedTiles.set(contactTileKey(descriptor.tile), descriptor.tile);
      }
      const incomingTiles = new Map<string, ContactMapTile>();
      for (const descriptor of input.descriptors) {
        incomingTiles.set(contactTileKey(descriptor.tile), descriptor.tile);
      }
      const refreshedTiles = new Map<string, ContactMapTile>();
      for (const [tileKey, tile] of incomingTiles) {
        const textureKey = gpuTextureKey(currentScene, tile);
        const cached = textureCache.get(textureKey);
        if (cached?.generation === input.generation) {
          if (
            cached.tile !== tile
            && !updateTileTexture(
              gl,
              cached,
              tile,
              input.generation,
              currentScene.tileSizeBins,
              ++useCounter,
              uploadContext,
            )
          ) {
            return false;
          }
          retainedTiles.set(tileKey, tile);
          refreshedTiles.set(tileKey, tile);
          continue;
        }
        // A complete tile already owned by the presented generation is more
        // authoritative than a partial snapshot from the next pan generation.
        if (retainedTiles.has(tileKey)) {
          continue;
        }
        if (retainedTiles.size >= maximumUniqueTiles) {
          continue;
        }
        if (contactTileCellCount(tile) > 0) {
          const entry = ensureTileTexture(
            gl,
            textureCache,
            textureKey,
            tile,
            input.generation,
            currentScene.tileSizeBins,
            ++useCounter,
            uploadContext,
          );
          if (!entry) {
            return false;
          }
          entry.panPrefetchSnapshot = true;
        }
        retainedTiles.set(tileKey, tile);
        refreshedTiles.set(tileKey, tile);
      }

      // Replace every source/mirror descriptor for a refreshed tile. Pointer
      // pans require descriptor identity to match the cache entry; otherwise a
      // later pan frame would fall back to the stale full-scene texture.
      for (let index = 0; index < retainedDescriptors.length; index += 1) {
        const descriptor = retainedDescriptors[index]!;
        const tile = refreshedTiles.get(contactTileKey(descriptor.tile));
        if (!tile) {
          continue;
        }
        const refreshed = { ...descriptor, tile };
        retainedDescriptors[index] = refreshed;
        if (contactTileCellCount(tile) > 0) {
          pendingAppendedDescriptors.set(refreshed.key, refreshed);
        }
      }

      for (const descriptor of input.descriptors) {
        if (retainedDescriptorKeys.has(descriptor.key)) {
          continue;
        }
        const tile = retainedTiles.get(contactTileKey(descriptor.tile));
        if (!tile) {
          continue;
        }
        const retainedDescriptor = { ...descriptor, tile };
        retainedDescriptors.push(retainedDescriptor);
        retainedDescriptorKeys.add(retainedDescriptor.key);
        if (contactTileCellCount(tile) > 0) {
          pendingAppendedDescriptors.set(retainedDescriptor.key, retainedDescriptor);
        }
      }

      // Extend the active pointer camera in place. Do not clear or redraw the
      // framebuffer here; the next requestAnimationFrame pan uses the expanded
      // descriptor set, while a stationary pointer keeps the current frame.
      scene = { ...currentScene, descriptors: retainedDescriptors };
      if (!appendVirtualTextureScene(scene)) {
        uploadContext.performance.virtualTextureFallbacks += 1;
      }
      textureBytes = cachedTextureBytes(textureCache);
      if (textureBytes > safeTextureBudget) {
        const protectedKeys = new Set(
          retainedDescriptors.map((descriptor) => gpuTextureKey(currentScene, descriptor.tile)),
        );
        const eviction = evictLeastRecentlyUsedTextures(
          gl,
          textureCache,
          textureBytes,
          safeTextureBudget,
          protectedKeys,
        );
        textureBytes = eviction.bytes;
        uploadContext.performance.evictions += eviction.count;
        uploadContext.performance.evictedBytes += eviction.evictedBytes;
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      emitPerformanceIfChanged();
      return true;
    },
    presentAppendedSceneDescriptors: () => {
      if (
        destroyed
        || !scene
        || deltaScene
        || gl.isContextLost()
      ) {
        return false;
      }
      const descriptors = [...pendingAppendedDescriptors.values()];
      pendingAppendedDescriptors.clear();
      if (descriptors.length === 0) {
        return true;
      }
      // The framebuffer already contains the pointer-translated front scene.
      // Draw only appended or refreshed quads into the existing framebuffer:
      // no resize, clear, React state change, or full-scene replacement.
      return draw(true, descriptors, true);
    },
    setDeltaScene: (nextScene) => {
      scene = null;
      pendingAppendedDescriptors.clear();
      deltaScene = nextScene;
      deltaBuffers = new Map(
        nextScene.buffers.map((buffer) => [contactTileKey(buffer.tile), buffer]),
      );
      const requiredScratchLength = nextScene.tileSizeBins * nextScene.tileSizeBins;
      if (deltaScratch.length !== requiredScratchLength) {
        deltaScratch = new Float32Array(requiredScratchLength);
      }
      return draw();
    },
    updateDeltaTiles: (changedTileKeys) => {
      if (!deltaScene || destroyed || gl.isContextLost()) {
        return false;
      }
      if (deltaScene.deferTextureUpdates) {
        return true;
      }
      const changed = new Set(changedTileKeys);
      for (const [key, buffer] of deltaBuffers) {
        if (!changed.has(key)) {
          continue;
        }
        const textureKey = gpuTextureKey(deltaScene, {
          tileX: buffer.tile.tileX,
          tileY: buffer.tile.tileY,
        });
        const entry = ensureDeltaTileTexture(
          gl,
          textureCache,
          textureKey,
          buffer,
          deltaScene.generation,
          deltaScene.tileSizeBins,
          ++useCounter,
          deltaScratch,
          uploadContext,
        );
        if (!entry || !updateDeltaTileTexture(
          gl,
          entry,
          buffer,
          deltaScene.tileSizeBins,
          deltaScratch,
          uploadContext,
        )) {
          return false;
        }
      }
      return draw();
    },
    setPanViewport: (viewport) => {
      if (destroyed || gl.isContextLost()) {
        return;
      }
      if (deltaScene) {
        deltaScene = { ...deltaScene, viewport };
      } else if (scene) {
        scene = { ...scene, viewport };
      } else {
        return;
      }
      // Pretext/Juicebox-style camera navigation: the visible textures are
      // sampled through one page-table draw. The established per-tile path is
      // retained only for unsupported drivers or incomplete page coverage.
      const activeScene = scene;
      if (
        (activeScene && drawVirtualTexturePan(activeScene))
        || draw(true)
      ) {
        pendingAppendedDescriptors.clear();
      }
    },
    redraw: () => {
      const drawn = draw();
      if (drawn && scene) {
        rebuildVirtualTextureState(scene);
      }
      return drawn;
    },
    performanceSnapshot: () => {
      updatePerformanceCacheState();
      return contactTileGpuPerformanceSnapshot(uploadContext.performance);
    },
    destroy: () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      for (const entry of textureCache.values()) {
        gl.deleteTexture(entry.texture);
      }
      textureCache.clear();
      if (overviewTextureEntry) {
        gl.deleteTexture(overviewTextureEntry.texture);
        overviewTextureEntry = null;
      }
      pendingAppendedDescriptors.clear();
      if (framePresentation) {
        gl.deleteFramebuffer(framePresentation.framebuffer);
        gl.deleteTexture(framePresentation.texture);
        framePresentation = null;
      }
      deleteVirtualTextureState(virtualTextureState);
      virtualTextureState = null;
      if (virtualResources) {
        gl.deleteProgram(virtualResources.program);
      }
      gl.deleteTexture(resources.lutTexture);
      gl.deleteBuffer(resources.quadBuffer);
      gl.deleteProgram(resources.program);
      gl.deleteBuffer(boundaryResources.geometryBuffer);
      gl.deleteBuffer(boundaryResources.instanceBuffer);
      gl.deleteProgram(boundaryResources.program);
    },
  };
}

function recordContactTileGpuUpload(
  context: ContactTileGpuUploadContext,
  format: ContactTileGpuTextureFormat,
  fullUpload: boolean,
  startedAt: number,
) {
  const performance = context.performance;
  performance.uploads += 1;
  if (fullUpload) {
    performance.fullUploads += 1;
  } else {
    performance.subUploads += 1;
  }
  if (format === "r16f") {
    performance.r16fUploads += 1;
  } else {
    performance.r32fUploads += 1;
  }
  performance.uploadMilliseconds += Math.max(0, context.clock() - startedAt);
}

function uploadContactTileGpuTextureImage(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  values: Float32Array,
  context: ContactTileGpuUploadContext,
  startedAt = context.clock(),
): ContactTileGpuUploadResult | null {
  const wantsR16f = context.preference === "r16f";
  const fitsR16f = !wantsR16f || contactTileGpuFloatValuesFitR16f(values);
  if (wantsR16f && !fitsR16f) {
    context.performance.rangeFallbacks += 1;
  }

  if (wantsR16f && fitsR16f) {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16F,
      width,
      height,
      0,
      gl.RED,
      gl.FLOAT,
      values,
    );
    if (gl.getError() === gl.NO_ERROR) {
      recordContactTileGpuUpload(context, "r16f", true, startedAt);
      return { format: "r16f", bytes: values.length * contactTileGpuBytesPerTexel("r16f") };
    }
    context.performance.uploadErrorFallbacks += 1;
  }

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    width,
    height,
    0,
    gl.RED,
    gl.FLOAT,
    values,
  );
  if (gl.getError() !== gl.NO_ERROR) {
    return null;
  }
  recordContactTileGpuUpload(context, "r32f", true, startedAt);
  return { format: "r32f", bytes: values.length * contactTileGpuBytesPerTexel("r32f") };
}

function updateContactTileGpuTextureImage(
  gl: WebGL2RenderingContext,
  entry: GpuTextureEntry,
  width: number,
  height: number,
  values: Float32Array,
  context: ContactTileGpuUploadContext,
) {
  const startedAt = context.clock();
  if (entry.format === "r16f" && !contactTileGpuFloatValuesFitR16f(values)) {
    context.performance.rangeFallbacks += 1;
    const uploaded = uploadContactTileGpuTextureImage(
      gl,
      width,
      height,
      values,
      { ...context, preference: "r32f" },
      startedAt,
    );
    if (!uploaded) {
      return false;
    }
    entry.format = uploaded.format;
    entry.bytes = uploaded.bytes;
    return true;
  }

  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    width,
    height,
    gl.RED,
    gl.FLOAT,
    values,
  );
  if (gl.getError() === gl.NO_ERROR) {
    recordContactTileGpuUpload(context, entry.format, false, startedAt);
    return true;
  }
  if (entry.format !== "r16f") {
    return false;
  }

  context.performance.uploadErrorFallbacks += 1;
  const uploaded = uploadContactTileGpuTextureImage(
    gl,
    width,
    height,
    values,
    { ...context, preference: "r32f" },
    startedAt,
  );
  if (!uploaded) {
    return false;
  }
  entry.format = uploaded.format;
  entry.bytes = uploaded.bytes;
  return true;
}

function ensureOverviewTexture(
  gl: WebGL2RenderingContext,
  current: GpuOverviewTextureEntry | null,
  overview: ContactTileGpuOverview,
  uploadContext: ContactTileGpuUploadContext,
): GpuOverviewTextureEntry | null {
  if (
    current
    && current.values === overview.values
    && current.width === overview.width
    && current.height === overview.height
  ) {
    return current;
  }
  if (
    overview.values.length !== overview.width * overview.height
    || overview.width <= 0
    || overview.height <= 0
  ) {
    return null;
  }
  if (current) {
    gl.deleteTexture(current.texture);
  }
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const uploaded = uploadContactTileGpuTextureImage(
    gl,
    overview.width,
    overview.height,
    overview.values,
    uploadContext,
  );
  if (!uploaded) {
    gl.deleteTexture(texture);
    return null;
  }
  return {
    texture,
    format: uploaded.format,
    values: overview.values,
    width: overview.width,
    height: overview.height,
  };
}

function drawBoundaryScene(
  gl: WebGL2RenderingContext,
  resources: BoundaryRendererResources,
  boundaries: readonly ContactTileGpuBoundary[],
  viewport: ContactViewport,
  canvasWidth: number,
  canvasHeight: number,
  cssWidth: number,
  cssHeight: number,
  uploadedBoundaries: readonly ContactTileGpuBoundary[] | null,
  uploadedBoundaryCount: number,
) {
  if (boundaries.length === 0) {
    return true;
  }
  const uploadsNewBuffer = uploadedBoundaries !== boundaries;
  if (uploadsNewBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.instanceBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      contactTileGpuBoundaryInstanceData(boundaries),
      gl.STATIC_DRAW,
    );
  }

  gl.useProgram(resources.program);
  gl.uniform4f(
    resources.viewportLocation,
    viewport.xStart,
    Math.max(1, viewport.xEnd - viewport.xStart),
    viewport.yStart,
    Math.max(1, viewport.yEnd - viewport.yStart),
  );
  gl.uniform2f(resources.canvasSizeLocation, canvasWidth, canvasHeight);
  gl.uniform2f(resources.cssSizeLocation, cssWidth, cssHeight);
  gl.uniform2f(
    resources.cssScaleLocation,
    canvasWidth / Math.max(1, cssWidth),
    canvasHeight / Math.max(1, cssHeight),
  );

  gl.bindBuffer(gl.ARRAY_BUFFER, resources.geometryBuffer);
  gl.enableVertexAttribArray(resources.edgeLocation);
  gl.vertexAttribPointer(resources.edgeLocation, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(resources.edgeLocation, 0);

  const stride = boundaryInstanceStrideFloats * Float32Array.BYTES_PER_ELEMENT;
  gl.bindBuffer(gl.ARRAY_BUFFER, resources.instanceBuffer);
  gl.enableVertexAttribArray(resources.intervalLocation);
  gl.vertexAttribPointer(resources.intervalLocation, 2, gl.FLOAT, false, stride, 0);
  gl.vertexAttribDivisor(resources.intervalLocation, 1);
  gl.enableVertexAttribArray(resources.colorLocation);
  gl.vertexAttribPointer(
    resources.colorLocation,
    3,
    gl.FLOAT,
    false,
    stride,
    2 * Float32Array.BYTES_PER_ELEMENT,
  );
  gl.vertexAttribDivisor(resources.colorLocation, 1);
  gl.enableVertexAttribArray(resources.styleLocation);
  gl.vertexAttribPointer(
    resources.styleLocation,
    2,
    gl.FLOAT,
    false,
    stride,
    5 * Float32Array.BYTES_PER_ELEMENT,
  );
  gl.vertexAttribDivisor(resources.styleLocation, 1);

  gl.drawArraysInstanced(
    gl.TRIANGLES,
    0,
    24,
    uploadsNewBuffer ? boundaries.length : uploadedBoundaryCount,
  );

  gl.vertexAttribDivisor(resources.intervalLocation, 0);
  gl.vertexAttribDivisor(resources.colorLocation, 0);
  gl.vertexAttribDivisor(resources.styleLocation, 0);
  gl.disableVertexAttribArray(resources.edgeLocation);
  gl.disableVertexAttribArray(resources.intervalLocation);
  gl.disableVertexAttribArray(resources.colorLocation);
  gl.disableVertexAttribArray(resources.styleLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return true;
}

function createBoundaryRendererResources(
  gl: WebGL2RenderingContext,
): BoundaryRendererResources | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, boundaryVertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, boundaryFragmentShaderSource);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const geometryBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();
  if (!geometryBuffer || !instanceBuffer) {
    if (geometryBuffer) gl.deleteBuffer(geometryBuffer);
    if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
    gl.deleteProgram(program);
    return null;
  }
  const edgeVertices: number[] = [];
  const quad = [
    [0, -0.5], [1, -0.5], [0, 0.5],
    [0, 0.5], [1, -0.5], [1, 0.5],
  ] as const;
  for (const axis of [0, 1]) {
    for (const side of [0, 1]) {
      for (const [along, across] of quad) {
        edgeVertices.push(axis, side, along, across);
      }
    }
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, geometryBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edgeVertices), gl.STATIC_DRAW);

  const edgeLocation = gl.getAttribLocation(program, "a_edge");
  const intervalLocation = gl.getAttribLocation(program, "a_interval");
  const colorLocation = gl.getAttribLocation(program, "a_color");
  const styleLocation = gl.getAttribLocation(program, "a_style");
  const viewportLocation = gl.getUniformLocation(program, "u_viewport");
  const canvasSizeLocation = gl.getUniformLocation(program, "u_canvas_size");
  const cssSizeLocation = gl.getUniformLocation(program, "u_css_size");
  const cssScaleLocation = gl.getUniformLocation(program, "u_css_scale");
  if (
    edgeLocation < 0
    || intervalLocation < 0
    || colorLocation < 0
    || styleLocation < 0
    || !viewportLocation
    || !canvasSizeLocation
    || !cssSizeLocation
    || !cssScaleLocation
  ) {
    gl.deleteBuffer(geometryBuffer);
    gl.deleteBuffer(instanceBuffer);
    gl.deleteProgram(program);
    return null;
  }
  return {
    program,
    geometryBuffer,
    instanceBuffer,
    edgeLocation,
    intervalLocation,
    colorLocation,
    styleLocation,
    viewportLocation,
    canvasSizeLocation,
    cssSizeLocation,
    cssScaleLocation,
  };
}

function drawTextureQuad(
  gl: WebGL2RenderingContext,
  resources: RendererResources,
  texture: WebGLTexture,
  left: number,
  top: number,
  width: number,
  height: number,
  transpose: boolean,
) {
  gl.uniform4f(resources.rectLocation, left, top, width, height);
  gl.uniform1i(resources.transposeLocation, transpose ? 1 : 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(resources.tileTextureLocation, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function clearCanvasRectToWhite(
  gl: WebGL2RenderingContext,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  const xStart = Math.max(0, Math.floor(left));
  const xEnd = Math.min(canvasWidth, Math.ceil(left + width));
  const yStartFromTop = Math.max(0, Math.floor(top));
  const yEndFromTop = Math.min(canvasHeight, Math.ceil(top + height));
  if (xEnd <= xStart || yEndFromTop <= yStartFromTop) {
    return;
  }
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(
    xStart,
    canvasHeight - yEndFromTop,
    xEnd - xStart,
    yEndFromTop - yStartFromTop,
  );
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.SCISSOR_TEST);
}

function applyColorScaleUniforms(
  gl: WebGL2RenderingContext,
  resources: RendererResources,
  colorScale: ContactTileRenderStyle["colorScale"],
) {
  const minimum = Math.max(0, colorScale.min);
  const maximum = Math.max(minimum, colorScale.max);
  gl.uniform4f(
    resources.scaleLocation,
    minimum,
    maximum,
    colorScale.log ? 1 : 0,
    0,
  );
}

function createRendererResources(gl: WebGL2RenderingContext): RendererResources | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const quadBuffer = gl.createBuffer();
  const lutTexture = gl.createTexture();
  if (!quadBuffer || !lutTexture) {
    if (quadBuffer) gl.deleteBuffer(quadBuffer);
    if (lutTexture) gl.deleteTexture(lutTexture);
    gl.deleteProgram(program);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0, 1, 0, 0, 1,
    0, 1, 1, 0, 1, 1,
  ]), gl.STATIC_DRAW);

  const positionLocation = gl.getAttribLocation(program, "a_position");
  const rectLocation = gl.getUniformLocation(program, "u_rect");
  const canvasSizeLocation = gl.getUniformLocation(program, "u_canvas_size");
  const transposeLocation = gl.getUniformLocation(program, "u_transpose");
  const tileTextureLocation = gl.getUniformLocation(program, "u_tile");
  const lutTextureLocation = gl.getUniformLocation(program, "u_lut");
  const scaleLocation = gl.getUniformLocation(program, "u_scale");
  const paletteStopCountLocation = gl.getUniformLocation(program, "u_palette_stop_count");
  if (
    positionLocation < 0
    || !rectLocation
    || !canvasSizeLocation
    || !transposeLocation
    || !tileTextureLocation
    || !lutTextureLocation
    || !scaleLocation
    || !paletteStopCountLocation
  ) {
    gl.deleteTexture(lutTexture);
    gl.deleteBuffer(quadBuffer);
    gl.deleteProgram(program);
    return null;
  }

  return {
    program,
    quadBuffer,
    lutTexture,
    positionLocation,
    rectLocation,
    canvasSizeLocation,
    transposeLocation,
    tileTextureLocation,
    lutTextureLocation,
    scaleLocation,
    paletteStopCountLocation,
  };
}

function createVirtualTextureRendererResources(
  gl: WebGL2RenderingContext,
): VirtualTextureRendererResources | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, virtualTextureVertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, virtualTextureFragmentShaderSource);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const positionLocation = gl.getAttribLocation(program, "a_position");
  const tileArrayLocation = gl.getUniformLocation(program, "u_tile_array");
  const pageTableLocation = gl.getUniformLocation(program, "u_page_table");
  const lutTextureLocation = gl.getUniformLocation(program, "u_lut");
  const overviewTextureLocation = gl.getUniformLocation(program, "u_overview");
  const cameraTilesLocation = gl.getUniformLocation(program, "u_camera_tiles");
  const cameraPageLocation = gl.getUniformLocation(program, "u_camera_page");
  const pageOriginLocation = gl.getUniformLocation(program, "u_page_origin");
  const pageSizeLocation = gl.getUniformLocation(program, "u_page_size");
  const overviewUvRectLocation = gl.getUniformLocation(program, "u_overview_uv_rect");
  const hasOverviewLocation = gl.getUniformLocation(program, "u_has_overview");
  const scaleLocation = gl.getUniformLocation(program, "u_scale");
  const overviewScaleLocation = gl.getUniformLocation(program, "u_overview_scale");
  const paletteStopCountLocation = gl.getUniformLocation(program, "u_palette_stop_count");
  if (
    positionLocation < 0
    || !tileArrayLocation
    || !pageTableLocation
    || !lutTextureLocation
    || !overviewTextureLocation
    || !cameraTilesLocation
    || !cameraPageLocation
    || !pageOriginLocation
    || !pageSizeLocation
    || !overviewUvRectLocation
    || !hasOverviewLocation
    || !scaleLocation
    || !overviewScaleLocation
    || !paletteStopCountLocation
  ) {
    gl.deleteProgram(program);
    return null;
  }
  return {
    program,
    positionLocation,
    tileArrayLocation,
    pageTableLocation,
    lutTextureLocation,
    overviewTextureLocation,
    cameraTilesLocation,
    cameraPageLocation,
    pageOriginLocation,
    pageSizeLocation,
    overviewUvRectLocation,
    hasOverviewLocation,
    scaleLocation,
    overviewScaleLocation,
    paletteStopCountLocation,
  };
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function ensureTileTexture(
  gl: WebGL2RenderingContext,
  cache: Map<string, GpuTextureEntry>,
  key: string,
  tile: ContactMapTile,
  generation: number | undefined,
  tileSizeBins: number,
  lastUsed: number,
  uploadContext: ContactTileGpuUploadContext,
): GpuTextureEntry | null {
  // Tile textures exclusively occupy unit 0. Without this reset the first
  // upload can replace the LUT bound to unit 1, producing black texelFetch
  // results when the shader addresses the 4x4/256x256 tile as a 256x1 LUT.
  gl.activeTexture(gl.TEXTURE0);
  const cached = cache.get(key);
  if (cached?.tile === tile) {
    cached.panPrefetchSnapshot = false;
    cached.lastUsed = lastUsed;
    return cached;
  }
  if (
    cached
    && generation !== undefined
    && cached.generation === generation
    && (cached.deltaBuffer || cached.panPrefetchSnapshot)
  ) {
    cached.tile = tile;
    cached.deltaBuffer = undefined;
    cached.panPrefetchSnapshot = false;
    cached.lastUsed = lastUsed;
    return cached;
  }
  if (cached) {
    gl.deleteTexture(cached.texture);
    cache.delete(key);
  }

  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const values = contactTileFloatTextureData(tile, tileSizeBins);
  const uploaded = uploadContactTileGpuTextureImage(
    gl,
    tileSizeBins,
    tileSizeBins,
    values,
    uploadContext,
  );
  if (!uploaded) {
    gl.deleteTexture(texture);
    return null;
  }
  const entry = {
    texture,
    format: uploaded.format,
    tile,
    generation,
    bytes: uploaded.bytes,
    lastUsed,
  };
  cache.set(key, entry);
  return entry;
}

function updateTileTexture(
  gl: WebGL2RenderingContext,
  entry: GpuTextureEntry,
  tile: ContactMapTile,
  generation: number,
  tileSizeBins: number,
  lastUsed: number,
  uploadContext: ContactTileGpuUploadContext,
) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  const values = contactTileFloatTextureData(tile, tileSizeBins);
  if (!updateContactTileGpuTextureImage(
    gl,
    entry,
    tileSizeBins,
    tileSizeBins,
    values,
    uploadContext,
  )) {
    return false;
  }
  entry.tile = tile;
  entry.deltaBuffer = undefined;
  entry.panPrefetchSnapshot = true;
  entry.generation = generation;
  entry.lastUsed = lastUsed;
  return true;
}

function ensureDeltaTileTexture(
  gl: WebGL2RenderingContext,
  cache: Map<string, GpuTextureEntry>,
  key: string,
  buffer: ContactTileDenseDeltaBuffer,
  generation: number,
  tileSizeBins: number,
  lastUsed: number,
  scratch: Float32Array,
  uploadContext: ContactTileGpuUploadContext,
): GpuTextureEntry | null {
  gl.activeTexture(gl.TEXTURE0);
  const cached = cache.get(key);
  if (
    cached?.generation === generation
    && cached.deltaBuffer === buffer
  ) {
    cached.lastUsed = lastUsed;
    return cached;
  }
  if (cached) {
    gl.deleteTexture(cached.texture);
    cache.delete(key);
  }
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const values = contactTileDenseFloatTextureData(buffer, tileSizeBins, scratch);
  const uploaded = uploadContactTileGpuTextureImage(
    gl,
    tileSizeBins,
    tileSizeBins,
    values,
    uploadContext,
  );
  if (!uploaded) {
    gl.deleteTexture(texture);
    return null;
  }
  const entry: GpuTextureEntry = {
    texture,
    format: uploaded.format,
    tile: null,
    deltaBuffer: buffer,
    generation,
    bytes: uploaded.bytes,
    lastUsed,
  };
  cache.set(key, entry);
  return entry;
}

function updateDeltaTileTexture(
  gl: WebGL2RenderingContext,
  entry: GpuTextureEntry,
  buffer: ContactTileDenseDeltaBuffer,
  tileSizeBins: number,
  scratch: Float32Array,
  uploadContext: ContactTileGpuUploadContext,
) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  const values = contactTileDenseFloatTextureData(buffer, tileSizeBins, scratch);
  return updateContactTileGpuTextureImage(
    gl,
    entry,
    tileSizeBins,
    tileSizeBins,
    values,
    uploadContext,
  );
}

function updateLutTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  renderStyle: ContactTileRenderStyle,
  previousColormap: ContactTileRenderStyle["colormap"] | null,
) {
  if (previousColormap === renderStyle.colormap) {
    return;
  }
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    256,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    contactColorLut(renderStyle.colormap, 0.88),
  );
}

function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
  const pixelRatio = typeof window === "undefined"
    ? 1
    : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round((canvas.clientWidth || 1) * pixelRatio));
  const height = Math.max(1, Math.round((canvas.clientHeight || 1) * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

function ensureFramePresentationResources(
  gl: WebGL2RenderingContext,
  current: FramePresentationResources | null,
  width: number,
  height: number,
): FramePresentationResources | null {
  if (current?.width === width && current.height === height) {
    return current;
  }
  if (current) {
    gl.deleteFramebuffer(current.framebuffer);
    gl.deleteTexture(current.texture);
  }

  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    return null;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }
  return { framebuffer, texture, width, height };
}

function presentFramePresentation(
  gl: WebGL2RenderingContext,
  frame: FramePresentationResources,
  width: number,
  height: number,
) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frame.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(
    0,
    0,
    width,
    height,
    0,
    0,
    width,
    height,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function sameContactTileGpuOverview(
  left: ContactTileGpuOverview | null,
  right: ContactTileGpuOverview | null,
) {
  return left === right || Boolean(
    left
    && right
    && left.values === right.values
    && left.width === right.width
    && left.height === right.height,
  );
}

function sameContactTileGpuScene(left: ContactTileGpuScene, right: ContactTileGpuScene) {
  if (
    left.generation !== right.generation
    || left.resolution !== right.resolution
    || left.tileSizeBins !== right.tileSizeBins
    || left.visibleLayerComplete !== right.visibleLayerComplete
    || !sameContactTileGpuOverview(left.overview ?? null, right.overview ?? null)
    || left.viewport.xStart !== right.viewport.xStart
    || left.viewport.xEnd !== right.viewport.xEnd
    || left.viewport.yStart !== right.viewport.yStart
    || left.viewport.yEnd !== right.viewport.yEnd
    || left.renderStyle.colormap !== right.renderStyle.colormap
    || left.renderStyle.colorScale.log !== right.renderStyle.colorScale.log
    || left.renderStyle.colorScale.min !== right.renderStyle.colorScale.min
    || left.renderStyle.colorScale.max !== right.renderStyle.colorScale.max
    || left.boundaries !== right.boundaries
    || left.descriptors.length !== right.descriptors.length
  ) {
    return false;
  }
  return left.descriptors.every((descriptor, index) => {
    const candidate = right.descriptors[index];
    return candidate?.key === descriptor.key
      && candidate.transpose === descriptor.transpose
      && candidate.tile === descriptor.tile;
  });
}

function gpuTextureKey(
  scene: Pick<ContactTileGpuScene, "resolution" | "tileSizeBins">,
  tile: Pick<ContactMapTile, "tileX" | "tileY">,
) {
  return `${scene.resolution}:${scene.tileSizeBins}:${tile.tileX}:${tile.tileY}`;
}

function cachedTextureBytes(cache: Map<string, GpuTextureEntry>) {
  let bytes = 0;
  for (const entry of cache.values()) {
    bytes += entry.bytes;
  }
  return bytes;
}

function evictLeastRecentlyUsedTextures(
  gl: WebGL2RenderingContext,
  cache: Map<string, GpuTextureEntry>,
  currentBytes: number,
  budgetBytes: number,
  protectedKeys: ReadonlySet<string>,
) {
  const candidates = [...cache.entries()]
    .filter(([key]) => !protectedKeys.has(key))
    .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
  let bytes = currentBytes;
  let count = 0;
  let evictedBytes = 0;
  for (const [key, entry] of candidates) {
    if (bytes <= budgetBytes) {
      break;
    }
    gl.deleteTexture(entry.texture);
    cache.delete(key);
    bytes -= entry.bytes;
    count += 1;
    evictedBytes += entry.bytes;
  }
  return { bytes, count, evictedBytes };
}

function paletteStopCount(colormap: ContactTileRenderStyle["colormap"]) {
  if (colormap === "Reds") return 0;
  if (colormap === "Turbo") return 5;
  return 4;
}
