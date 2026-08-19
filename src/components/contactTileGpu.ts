import type { ContactMapTile, ContactMapView } from "../App";
import { contactColorLut } from "../state/contactColor";
import type { ContactTileDenseDeltaBuffer } from "../state/contactTileDelta";
import { contactTileCellCount, validatedPackedContactTileCells } from "../state/contactTileData";
import { contactTileKey } from "../state/contactTiles";
import type { ContactViewport } from "../state/contactViewport";
import type {
  ContactTileCanvasDescriptor,
  ContactTileRenderStyle,
} from "./ContactTileLayer";

export const contactTileGpuTextureBudgetBytes = 96 * 1024 * 1024;
export const contactOverviewTextureBins = 320;

export interface ContactTileGpuOverview {
  values: Float32Array;
  width: number;
  height: number;
  viewport: ContactViewport;
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

interface GpuTextureEntry {
  texture: WebGLTexture;
  tile: ContactMapTile | null;
  deltaBuffer?: ContactTileDenseDeltaBuffer;
  panPrefetchSnapshot?: boolean;
  generation?: number;
  bytes: number;
  lastUsed: number;
}

interface GpuOverviewTextureEntry {
  texture: WebGLTexture;
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
  const values = new Float32Array(tileSizeBins * tileSizeBins);
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

/** Fixed-size R32F whole-assembly base texture used by the main viewport. */
export function contactOverviewFloatTextureData(
  map: Pick<ContactMapView, "cells" | "resolution" | "viewport">,
  targetBins = contactOverviewTextureBins,
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
  };
}

export function contactOverviewTextureBytes(
  width = contactOverviewTextureBins,
  height = contactOverviewTextureBins,
) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("contact overview dimensions must be positive integers");
  }
  return width * height * Float32Array.BYTES_PER_ELEMENT;
}

/** Convert the mutable streamed accumulator into the R32F texture layout. */
export function contactTileDenseFloatTextureData(
  buffer: ContactTileDenseDeltaBuffer,
  tileSizeBins: number,
  target?: Float32Array,
): Float32Array {
  if (!Number.isSafeInteger(tileSizeBins) || tileSizeBins <= 0) {
    throw new RangeError("contact tile size must be a positive integer");
  }
  const cellCount = tileSizeBins * tileSizeBins;
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

export function createContactTileGpuRenderer(
  canvas: HTMLCanvasElement,
  textureBudgetBytes = contactTileGpuTextureBudgetBytes,
): ContactTileGpuRenderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    desynchronized: true,
    failIfMajorPerformanceCaveat: false,
    powerPreference: "low-power",
    premultipliedAlpha: true,
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

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

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

    const minimum = Math.max(0, activeScene.renderStyle.colorScale.min);
    const maximum = Math.max(minimum, activeScene.renderStyle.colorScale.max);
    gl.uniform4f(
      resources.scaleLocation,
      minimum,
      maximum,
      activeScene.renderStyle.colorScale.log ? 1 : 0,
      0,
    );
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
    const validatesCompleteCoverage = !panOnly && descriptors === null;
    const drawnDescriptorKeys = validatesCompleteCoverage ? new Set<string>() : null;
    const overview = activeScene.overview ?? null;

    if (!preserveFramebuffer && overview) {
      overviewTextureEntry = ensureOverviewTexture(gl, overviewTextureEntry, overview);
      if (!overviewTextureEntry) {
        return false;
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
        && !preserveFramebuffer,
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
            )
          : ensureTileTexture(
              gl,
              textureCache,
              textureKey,
              descriptor.tile,
              activeScene.generation,
              activeScene.tileSizeBins,
              ++useCounter,
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
      textureBytes = evictLeastRecentlyUsedTextures(
        gl,
        textureCache,
        textureBytes,
        safeTextureBudget,
        protectedKeys!,
      );
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
      return false;
    }
    if (uploadedBoundaries !== boundaries) {
      uploadedBoundaries = boundaries;
      uploadedBoundaryCount = boundaries.length;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (panOnly) {
      return true;
    }
    const glSucceeded = gl.getError() === gl.NO_ERROR;
    return glSucceeded && (
      deltaScene !== null
      || !validatesCompleteCoverage
      || contactTileGpuDrawCoverageIsComplete(
        activeScene.descriptors,
        drawnDescriptorKeys!,
        overview !== null,
      )
    );
  };

  return {
    setScene: (nextScene) => {
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
          );
          if (
            !entry
            || (cachedMatchesBuffer && !updateDeltaTileTexture(
              gl,
              entry,
              buffer,
              deltaScene.tileSizeBins,
              deltaScratch,
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
      return draw();
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
        currentScene.tileSizeBins * currentScene.tileSizeBins * Float32Array.BYTES_PER_ELEMENT,
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
      textureBytes = cachedTextureBytes(textureCache);
      if (textureBytes > safeTextureBudget) {
        const protectedKeys = new Set(
          retainedDescriptors.map((descriptor) => gpuTextureKey(currentScene, descriptor.tile)),
        );
        textureBytes = evictLeastRecentlyUsedTextures(
          gl,
          textureCache,
          textureBytes,
          safeTextureBudget,
          protectedKeys,
        );
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
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
        );
        if (!entry || !updateDeltaTileTexture(
          gl,
          entry,
          buffer,
          deltaScene.tileSizeBins,
          deltaScratch,
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
      // always projected by the current camera. There is no second pixel
      // translation to clear when the pointer is released.
      if (draw(true)) {
        pendingAppendedDescriptors.clear();
      }
    },
    redraw: draw,
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
      gl.deleteTexture(resources.lutTexture);
      gl.deleteBuffer(resources.quadBuffer);
      gl.deleteProgram(resources.program);
      gl.deleteBuffer(boundaryResources.geometryBuffer);
      gl.deleteBuffer(boundaryResources.instanceBuffer);
      gl.deleteProgram(boundaryResources.program);
    },
  };
}

function ensureOverviewTexture(
  gl: WebGL2RenderingContext,
  current: GpuOverviewTextureEntry | null,
  overview: ContactTileGpuOverview,
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
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    overview.width,
    overview.height,
    0,
    gl.RED,
    gl.FLOAT,
    overview.values,
  );
  if (gl.getError() !== gl.NO_ERROR) {
    gl.deleteTexture(texture);
    return null;
  }
  return {
    texture,
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
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    tileSizeBins,
    tileSizeBins,
    0,
    gl.RED,
    gl.FLOAT,
    contactTileFloatTextureData(tile, tileSizeBins),
  );
  if (gl.getError() !== gl.NO_ERROR) {
    gl.deleteTexture(texture);
    return null;
  }
  const entry = {
    texture,
    tile,
    generation,
    bytes: tileSizeBins * tileSizeBins * Float32Array.BYTES_PER_ELEMENT,
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
) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    tileSizeBins,
    tileSizeBins,
    gl.RED,
    gl.FLOAT,
    contactTileFloatTextureData(tile, tileSizeBins),
  );
  if (gl.getError() !== gl.NO_ERROR) {
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
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    tileSizeBins,
    tileSizeBins,
    0,
    gl.RED,
    gl.FLOAT,
    contactTileDenseFloatTextureData(buffer, tileSizeBins, scratch),
  );
  if (gl.getError() !== gl.NO_ERROR) {
    gl.deleteTexture(texture);
    return null;
  }
  const entry: GpuTextureEntry = {
    texture,
    tile: null,
    deltaBuffer: buffer,
    generation,
    bytes: tileSizeBins * tileSizeBins * Float32Array.BYTES_PER_ELEMENT,
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
) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    tileSizeBins,
    tileSizeBins,
    gl.RED,
    gl.FLOAT,
    contactTileDenseFloatTextureData(buffer, tileSizeBins, scratch),
  );
  return gl.getError() === gl.NO_ERROR;
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
  for (const [key, entry] of candidates) {
    if (bytes <= budgetBytes) {
      break;
    }
    gl.deleteTexture(entry.texture);
    cache.delete(key);
    bytes -= entry.bytes;
  }
  return bytes;
}

function paletteStopCount(colormap: ContactTileRenderStyle["colormap"]) {
  if (colormap === "Reds") return 0;
  if (colormap === "Turbo") return 5;
  return 4;
}
