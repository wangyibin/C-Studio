import type { ContactMapTile } from "../App";
import { contactColorLut } from "../state/contactColor";
import { contactTileCellCount, validatedPackedContactTileCells } from "../state/contactTileData";
import type { ContactViewport } from "../state/contactViewport";
import type {
  ContactTileCanvasDescriptor,
  ContactTileRenderStyle,
} from "./ContactTileLayer";

export const contactTileGpuTextureBudgetBytes = 96 * 1024 * 1024;

export interface ContactTileGpuScene {
  descriptors: readonly ContactTileCanvasDescriptor[];
  resolution: number;
  tileSizeBins: number;
  viewport: ContactViewport;
  renderStyle: ContactTileRenderStyle;
}

export interface ContactTileGpuRenderer {
  setScene: (scene: ContactTileGpuScene) => boolean;
  setPanOffset: (x: number, y: number) => void;
  resetPanOffset: () => void;
  redraw: () => boolean;
  destroy: () => void;
}

interface GpuTextureEntry {
  texture: WebGLTexture;
  tile: ContactMapTile;
  bytes: number;
  lastUsed: number;
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

  const textureCache = new Map<string, GpuTextureEntry>();
  const safeTextureBudget = Math.max(1, Math.floor(textureBudgetBytes));
  let textureBytes = 0;
  let useCounter = 0;
  let scene: ContactTileGpuScene | null = null;
  let panOffsetX = 0;
  let panOffsetY = 0;
  let destroyed = false;
  let lutColormap: ContactTileRenderStyle["colormap"] | null = null;

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const draw = (): boolean => {
    if (destroyed || !scene || gl.isContextLost()) {
      return false;
    }
    resizeCanvasToDisplaySize(canvas, gl);
    updateLutTexture(gl, resources.lutTexture, scene.renderStyle, lutColormap);
    lutColormap = scene.renderStyle.colormap;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(resources.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.quadBuffer);
    gl.enableVertexAttribArray(resources.positionLocation);
    gl.vertexAttribPointer(resources.positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(resources.canvasSizeLocation, canvas.width, canvas.height);

    const minimum = Math.max(0, scene.renderStyle.colorScale.min);
    const maximum = Math.max(minimum, scene.renderStyle.colorScale.max);
    gl.uniform4f(
      resources.scaleLocation,
      minimum,
      maximum,
      scene.renderStyle.colorScale.log ? 1 : 0,
      0,
    );
    gl.uniform1f(
      resources.paletteStopCountLocation,
      paletteStopCount(scene.renderStyle.colormap),
    );
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, resources.lutTexture);
    gl.uniform1i(resources.lutTextureLocation, 1);

    const viewportWidth = Math.max(1, scene.viewport.xEnd - scene.viewport.xStart);
    const viewportHeight = Math.max(1, scene.viewport.yEnd - scene.viewport.yStart);
    const tileSpanBp = scene.resolution * scene.tileSizeBins;
    const cssWidth = Math.max(1, canvas.clientWidth || canvas.width);
    const cssHeight = Math.max(1, canvas.clientHeight || canvas.height);
    const scaleX = canvas.width / cssWidth;
    const scaleY = canvas.height / cssHeight;
    const protectedKeys = new Set<string>();

    for (const descriptor of scene.descriptors) {
      if (contactTileCellCount(descriptor.tile) === 0) {
        continue;
      }
      const textureKey = gpuTextureKey(scene, descriptor.tile);
      protectedKeys.add(textureKey);
      const entry = ensureTileTexture(
        gl,
        textureCache,
        textureKey,
        descriptor.tile,
        scene.tileSizeBins,
        ++useCounter,
      );
      if (!entry) {
        continue;
      }
      if (!textureCache.has(textureKey)) {
        continue;
      }
      textureBytes = cachedTextureBytes(textureCache);

      const renderedTileX = descriptor.transpose ? descriptor.tile.tileY : descriptor.tile.tileX;
      const renderedTileY = descriptor.transpose ? descriptor.tile.tileX : descriptor.tile.tileY;
      const left = (
        ((renderedTileX * tileSpanBp - scene.viewport.xStart) / viewportWidth) * cssWidth
        + panOffsetX
      ) * scaleX;
      const top = (
        ((renderedTileY * tileSpanBp - scene.viewport.yStart) / viewportHeight) * cssHeight
        + panOffsetY
      ) * scaleY;
      const width = (tileSpanBp / viewportWidth) * canvas.width;
      const height = (tileSpanBp / viewportHeight) * canvas.height;

      gl.uniform4f(resources.rectLocation, left, top, width, height);
      gl.uniform1i(resources.transposeLocation, descriptor.transpose ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.uniform1i(resources.tileTextureLocation, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    if (textureBytes > safeTextureBudget) {
      textureBytes = evictLeastRecentlyUsedTextures(
        gl,
        textureCache,
        textureBytes,
        safeTextureBudget,
        protectedKeys,
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return gl.getError() === gl.NO_ERROR;
  };

  return {
    setScene: (nextScene) => {
      const viewportChanged = !scene || !sameViewport(scene.viewport, nextScene.viewport);
      scene = nextScene;
      if (viewportChanged) {
        panOffsetX = 0;
        panOffsetY = 0;
      }
      return draw();
    },
    setPanOffset: (x, y) => {
      panOffsetX = Number.isFinite(x) ? x : 0;
      panOffsetY = Number.isFinite(y) ? y : 0;
      draw();
    },
    resetPanOffset: () => {
      if (panOffsetX === 0 && panOffsetY === 0) {
        return;
      }
      panOffsetX = 0;
      panOffsetY = 0;
      draw();
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
      gl.deleteTexture(resources.lutTexture);
      gl.deleteBuffer(resources.quadBuffer);
      gl.deleteProgram(resources.program);
    },
  };
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
  tileSizeBins: number,
  lastUsed: number,
): GpuTextureEntry | null {
  // Tile textures exclusively occupy unit 0. Without this reset the first
  // upload can replace the LUT bound to unit 1, producing black texelFetch
  // results when the shader addresses the 4x4/256x256 tile as a 256x1 LUT.
  gl.activeTexture(gl.TEXTURE0);
  const cached = cache.get(key);
  if (cached?.tile === tile) {
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
    bytes: tileSizeBins * tileSizeBins * Float32Array.BYTES_PER_ELEMENT,
    lastUsed,
  };
  cache.set(key, entry);
  return entry;
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
  const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round((canvas.clientWidth || 1) * pixelRatio));
  const height = Math.max(1, Math.round((canvas.clientHeight || 1) * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

function gpuTextureKey(scene: ContactTileGpuScene, tile: ContactMapTile) {
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

function sameViewport(left: ContactViewport, right: ContactViewport) {
  return left.xStart === right.xStart
    && left.xEnd === right.xEnd
    && left.yStart === right.yStart
    && left.yEnd === right.yEnd;
}

function paletteStopCount(colormap: ContactTileRenderStyle["colormap"]) {
  if (colormap === "Reds") return 0;
  if (colormap === "Turbo") return 5;
  return 4;
}
