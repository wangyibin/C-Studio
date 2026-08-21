import { describe, expect, it, vi } from "vitest";
import {
  contactOverviewFloatTextureData,
  contactOverviewTextureBytes,
  contactTileDenseFloatTextureData,
  contactTileFloatTextureData,
  contactTileGpuFloatValuesFitR16f,
  contactTileGpuBoundaryInstanceData,
  contactTileGpuDrawCoverageIsComplete,
  contactTileGpuTexturePreference,
  createContactTileGpuRenderer,
} from "./contactTileGpu";

function mockWebGlCanvas() {
  const texImage2D = vi.fn();
  const texSubImage2D = vi.fn();
  const getError = vi.fn(() => 0);
  const drawArrays = vi.fn();
  const drawArraysInstanced = vi.fn();
  const bufferData = vi.fn();
  const clear = vi.fn();
  const scissor = vi.fn();
  const uniform4f = vi.fn();
  const blitFramebuffer = vi.fn();
  const clientWidthRead = vi.fn(() => 256);
  const clientHeightRead = vi.fn(() => 256);
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    DEPTH_TEST: 8,
    CULL_FACE: 9,
    BLEND: 10,
    SCISSOR_TEST: 28,
    UNPACK_ALIGNMENT: 11,
    TEXTURE0: 12,
    TEXTURE1: 13,
    TEXTURE_2D: 14,
    TEXTURE_MIN_FILTER: 15,
    TEXTURE_MAG_FILTER: 16,
    TEXTURE_WRAP_S: 17,
    TEXTURE_WRAP_T: 18,
    NEAREST: 19,
    CLAMP_TO_EDGE: 20,
    R32F: 21,
    R16F: 29,
    RED: 22,
    RGBA8: 23,
    RGBA: 24,
    UNSIGNED_BYTE: 25,
    COLOR_BUFFER_BIT: 26,
    TRIANGLES: 27,
    FRAMEBUFFER: 30,
    READ_FRAMEBUFFER: 31,
    DRAW_FRAMEBUFFER: 32,
    COLOR_ATTACHMENT0: 33,
    FRAMEBUFFER_COMPLETE: 34,
    NO_ERROR: 0,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({})),
    createFramebuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData,
    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    deleteTexture: vi.fn(),
    deleteFramebuffer: vi.fn(),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 34),
    blitFramebuffer,
    disable: vi.fn(),
    enable: vi.fn(),
    pixelStorei: vi.fn(),
    isContextLost: vi.fn(() => false),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear,
    scissor,
    useProgram: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    disableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribDivisor: vi.fn(),
    uniform2f: vi.fn(),
    uniform4f,
    uniform1f: vi.fn(),
    uniform1i: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D,
    texSubImage2D,
    drawArrays,
    drawArraysInstanced,
    getError,
  };
  const canvas = {
    width: 256,
    height: 256,
    getContext: vi.fn(() => gl),
  } as unknown as HTMLCanvasElement;
  Object.defineProperty(canvas, "clientWidth", { get: clientWidthRead });
  Object.defineProperty(canvas, "clientHeight", { get: clientHeightRead });
  return {
    canvas,
    blitFramebuffer,
    bufferData,
    clear,
    clientHeightRead,
    clientWidthRead,
    drawArrays,
    drawArraysInstanced,
    getError,
    scissor,
    texImage2D,
    texSubImage2D,
    uniform4f,
  };
}

describe("contactTileFloatTextureData", () => {
  it("builds one fixed overview and accounts preferred R16F storage", () => {
    const overview = contactOverviewFloatTextureData({
      resolution: 100,
      viewport: { xStart: 0, xEnd: 400, yStart: 0, yEnd: 400 },
      cells: [{ xBin: 0, yBin: 1, count: 7 }],
    }, 4);

    expect(overview.width).toBe(4);
    expect(overview.height).toBe(4);
    expect(overview.values[4]).toBe(7);
    expect(overview.values[1]).toBe(7);
    expect(overview.values[0]).toBe(-1);
    expect(contactOverviewTextureBytes()).toBe(320 * 320 * 2);
    expect(contactOverviewTextureBytes(320, 320, "r32f")).toBe(320 * 320 * 4);
  });

  it("selects R16F by default and allows an explicit R32F benchmark override", () => {
    expect(contactTileGpuTexturePreference("")).toBe("r16f");
    expect(contactTileGpuTexturePreference("?cstudioGpuTexture=r16f")).toBe("r16f");
    expect(contactTileGpuTexturePreference("?cstudioGpuTexture=r32f")).toBe("r32f");
  });

  it("accepts finite half-float values and rejects overflow or non-finite values", () => {
    expect(contactTileGpuFloatValuesFitR16f(new Float32Array([-1, 0, 65_504]))).toBe(true);
    expect(contactTileGpuFloatValuesFitR16f(new Float32Array([65_505]))).toBe(false);
    expect(contactTileGpuFloatValuesFitR16f(new Float32Array([Number.NaN]))).toBe(false);
  });

  it("uploads eligible tiles as R16F and accounts two bytes per texel", () => {
    const { canvas, texImage2D } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      texturePreference: "r16f",
      performanceEnabled: false,
    });

    expect(renderer?.setScene({
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 0, yBin: 0, count: 9 }] },
        transpose: false,
      }],
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);

    expect(texImage2D.mock.calls.some((call) => call[2] === 29)).toBe(true);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      r16fUploads: 1,
      r32fUploads: 0,
      cacheEntries: 1,
      cacheBytes: 4 * 4 * 2,
    });
    renderer?.destroy();
  });

  it("falls back to R32F when a tile exceeds the finite R16F range", () => {
    const { canvas, texImage2D } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      texturePreference: "r16f",
      performanceEnabled: false,
    });

    expect(renderer?.setScene({
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 0, yBin: 0, count: 70_000 }] },
        transpose: false,
      }],
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 70_000 },
      },
    })).toBe(true);

    expect(texImage2D.mock.calls.some((call) => call[2] === 21)).toBe(true);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      r16fUploads: 0,
      r32fUploads: 1,
      rangeFallbacks: 1,
      cacheBytes: 4 * 4 * 4,
    });
    renderer?.destroy();
  });

  it("retries R32F when the driver rejects an eligible R16F upload", () => {
    const { canvas, getError, texImage2D } = mockWebGlCanvas();
    getError.mockImplementationOnce(() => 1).mockImplementation(() => 0);
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      texturePreference: "r16f",
      performanceEnabled: false,
    });

    expect(renderer?.setScene({
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 0, yBin: 0, count: 9 }] },
        transpose: false,
      }],
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);

    const scalarUploads = texImage2D.mock.calls.filter((call) => call[2] === 29 || call[2] === 21);
    expect(scalarUploads.map((call) => call[2])).toEqual([29, 21]);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      r16fUploads: 0,
      r32fUploads: 1,
      uploadErrorFallbacks: 1,
      cacheBytes: 4 * 4 * 4,
    });
    renderer?.destroy();
  });

  it("upgrades an existing R16F texture to R32F when refreshed values overflow", () => {
    const { canvas, texImage2D, texSubImage2D } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      texturePreference: "r16f",
      performanceEnabled: false,
    });
    const viewport = { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 };
    const renderStyle = {
      colormap: "Reds" as const,
      colorScale: { log: false, min: 0, max: 70_000 },
    };
    const tile = { tileX: 0, tileY: 0, cells: [{ xBin: 0, yBin: 0, count: 9 }] };

    expect(renderer?.setScene({
      descriptors: [{ key: "0:0:source", tile, transpose: false }],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport,
      renderStyle,
    })).toBe(true);
    expect(renderer?.appendSceneDescriptors({
      descriptors: [{
        key: "0:0:source",
        tile: { ...tile, cells: [{ xBin: 0, yBin: 0, count: 70_000 }] },
        transpose: false,
      }],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);

    const scalarUploads = texImage2D.mock.calls.filter((call) => call[2] === 29 || call[2] === 21);
    expect(scalarUploads.map((call) => call[2])).toEqual([29, 21]);
    expect(texSubImage2D).not.toHaveBeenCalled();
    expect(renderer?.performanceSnapshot()).toMatchObject({
      r16fUploads: 1,
      r32fUploads: 1,
      rangeFallbacks: 1,
      cacheBytes: 4 * 4 * 4,
    });
    renderer?.destroy();
  });

  it("counts R16F LRU evictions using actual two-byte texture sizes", () => {
    const { canvas } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 4 * 2, {
      texturePreference: "r16f",
      performanceEnabled: false,
    });
    const scene = (tileX: number) => ({
      descriptors: [{
        key: `${tileX}:0:source`,
        tile: { tileX, tileY: 0, cells: [{ xBin: tileX * 4, yBin: 0, count: 9 }] },
        transpose: false,
      }],
      generation: tileX + 1,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: {
        xStart: tileX * 4_000,
        xEnd: (tileX + 1) * 4_000,
        yStart: 0,
        yEnd: 4_000,
      },
      renderStyle: {
        colormap: "Reds" as const,
        colorScale: { log: false, min: 0, max: 10 },
      },
    });

    expect(renderer?.setScene(scene(0))).toBe(true);
    expect(renderer?.setScene(scene(1))).toBe(true);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      evictions: 1,
      evictedBytes: 4 * 4 * 2,
      cacheEntries: 1,
      cacheBytes: 4 * 4 * 2,
    });
    renderer?.destroy();
  });

  it("emits cumulative upload, format, and cache diagnostics", () => {
    const { canvas } = mockWebGlCanvas();
    const emitPerformance = vi.fn();
    const clock = vi.fn()
      .mockReturnValueOnce(5)
      .mockReturnValueOnce(7);
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      texturePreference: "r16f",
      performanceEnabled: true,
      emitPerformance,
      clock,
    });

    expect(renderer?.setScene({
      generation: 42,
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 0, yBin: 0, count: 9 }] },
        transpose: false,
      }],
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);

    const lastCall = emitPerformance.mock.calls[emitPerformance.mock.calls.length - 1];
    const log = lastCall?.[0] as string;
    expect(log).toContain("event=contact_gpu_texture");
    expect(log).toContain("generation=42");
    expect(log).toContain("r16f_uploads=1");
    expect(log).toContain("r32f_uploads=0");
    expect(log).toContain("upload_ms=2");
    expect(log).toContain("evictions=0");
    expect(log).toContain("cache_bytes=32");
    renderer?.destroy();
  });

  it("draws the overview first, masks terminal exact tiles, and reuses its texture", () => {
    const { canvas, drawArrays, scissor, texImage2D } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024);
    const overview = contactOverviewFloatTextureData({
      resolution: 100,
      viewport: { xStart: 0, xEnd: 400, yStart: 0, yEnd: 400 },
      cells: [{ xBin: 0, yBin: 1, count: 7 }],
    }, 4);

    expect(renderer?.setScene({
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 0, yBin: 0, count: 9 }] },
        transpose: false,
      }, {
        key: "1:0:source",
        tile: { tileX: 1, tileY: 0, cells: [] },
        transpose: false,
      }],
      overview,
      resolution: 100,
      tileSizeBins: 2,
      visibleLayerComplete: true,
      viewport: { xStart: 0, xEnd: 400, yStart: 0, yEnd: 400 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);

    expect(drawArrays).toHaveBeenCalledTimes(2);
    expect(scissor).toHaveBeenCalledTimes(2);
    const uploadsAfterFirstDraw = texImage2D.mock.calls.length;
    renderer?.setPanViewport({ xStart: 100, xEnd: 500, yStart: 0, yEnd: 400 });
    expect(drawArrays).toHaveBeenCalledTimes(4);
    expect(texImage2D).toHaveBeenCalledTimes(uploadsAfterFirstDraw);
  });

  it("uses an independent coarse scale for the overview, then restores the exact scale", () => {
    const { canvas, uniform4f } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024);
    const overview = contactOverviewFloatTextureData({
      resolution: 10_000,
      viewport: { xStart: 0, xEnd: 40_000, yStart: 0, yEnd: 40_000 },
      cells: [{ xBin: 0, yBin: 1, count: 700 }],
    }, 4, { log: false, min: 0, max: 1_000 });

    expect(renderer?.setScene({
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 0, yBin: 0, count: 9 }] },
        transpose: false,
      }],
      overview,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);

    const scales = uniform4f.mock.calls
      .filter((call) => call[3] === 0 && call[4] === 0)
      .map((call) => call.slice(1));
    expect(scales).toEqual([
      [0, 10, 0, 0],
      [0, 1_000, 0, 0],
      [0, 10, 0, 0],
    ]);
    renderer?.destroy();
  });

  it("keeps the overview visible beneath an incomplete exact layer", () => {
    const { canvas, scissor } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024);
    const overview = contactOverviewFloatTextureData({
      resolution: 100,
      viewport: { xStart: 0, xEnd: 400, yStart: 0, yEnd: 400 },
      cells: [{ xBin: 0, yBin: 0, count: 7 }],
    }, 4);

    expect(renderer?.setScene({
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [] },
        transpose: false,
      }],
      overview,
      resolution: 100,
      tileSizeBins: 2,
      visibleLayerComplete: false,
      viewport: { xStart: 0, xEnd: 400, yStart: 0, yEnd: 400 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);

    expect(scissor).not.toHaveBeenCalled();
  });

  it("keeps pointer-only pans off layout, upload, and GL validation paths", () => {
    const {
      canvas,
      clientHeightRead,
      clientWidthRead,
      drawArrays,
      getError,
      texImage2D,
    } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024);
    const tile = {
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 1, yBin: 0, count: 9 }],
    };

    expect(renderer?.setScene({
      descriptors: [{ key: "0:0:source", tile, transpose: false }],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);

    const layoutReadsBeforePan = clientWidthRead.mock.calls.length
      + clientHeightRead.mock.calls.length;
    const uploadsBeforePan = texImage2D.mock.calls.length;
    const validationsBeforePan = getError.mock.calls.length;
    const drawsBeforePan = drawArrays.mock.calls.length;

    renderer?.setPanViewport({
      xStart: 1_000,
      xEnd: 5_000,
      yStart: 2_000,
      yEnd: 6_000,
    });

    expect(clientWidthRead.mock.calls.length + clientHeightRead.mock.calls.length)
      .toBe(layoutReadsBeforePan);
    expect(texImage2D).toHaveBeenCalledTimes(uploadsBeforePan);
    expect(getError).toHaveBeenCalledTimes(validationsBeforePan);
    expect(drawArrays.mock.calls.length).toBe(drawsBeforePan + 1);
    renderer?.destroy();
  });

  it("uploads world-space boundaries once and pans them with the live GPU camera", () => {
    const {
      bufferData,
      canvas,
      clientHeightRead,
      clientWidthRead,
      drawArraysInstanced,
      texImage2D,
    } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024);
    const bufferUploadsBeforeScene = bufferData.mock.calls.length;
    const boundaries = [{
      visualStart: 500,
      visualEnd: 2_500,
      color: [0.22, 0.65, 1] as const,
      lineWidthCssPx: 1,
      minimumSpanCssPx: 0,
    }];

    expect(renderer?.setScene({
      boundaries,
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 1, yBin: 0, count: 9 }] },
        transpose: false,
      }],
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);

    expect(bufferData).toHaveBeenCalledTimes(bufferUploadsBeforeScene + 1);
    expect(drawArraysInstanced).toHaveBeenCalledWith(27, 0, 24, 1);
    const instancedDrawsBeforePan = drawArraysInstanced.mock.calls.length;
    const textureUploadsBeforePan = texImage2D.mock.calls.length;
    const layoutReadsBeforePan = clientWidthRead.mock.calls.length
      + clientHeightRead.mock.calls.length;

    renderer?.setPanViewport({ xStart: 1_000, xEnd: 5_000, yStart: 750, yEnd: 4_750 });

    expect(bufferData).toHaveBeenCalledTimes(bufferUploadsBeforeScene + 1);
    expect(drawArraysInstanced).toHaveBeenCalledTimes(instancedDrawsBeforePan + 1);
    expect(texImage2D).toHaveBeenCalledTimes(textureUploadsBeforePan);
    expect(clientWidthRead.mock.calls.length + clientHeightRead.mock.calls.length)
      .toBe(layoutReadsBeforePan);
    renderer?.destroy();
  });

  it("packs boundary geometry into one immutable instance buffer", () => {
    const packed = contactTileGpuBoundaryInstanceData([{
      visualStart: 100,
      visualEnd: 300,
      color: [0.2, 0.4, 0.6],
      lineWidthCssPx: 0,
      minimumSpanCssPx: -1,
    }]);
    expect(Array.from(packed.slice(0, 2))).toEqual([100, 300]);
    expect(packed[2]).toBeCloseTo(0.2);
    expect(packed[3]).toBeCloseTo(0.4);
    expect(packed[4]).toBeCloseTo(0.6);
    expect(Array.from(packed.slice(5))).toEqual([0.5, 0]);
  });

  it("presents appended pan-prefetch textures without clearing or replacing the scene", () => {
    const {
      canvas,
      clear,
      clientHeightRead,
      clientWidthRead,
      drawArrays,
      texImage2D,
      texSubImage2D,
    } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024);
    const firstTile = {
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 1, yBin: 0, count: 9 }],
    };
    const nextTile = {
      tileX: 1,
      tileY: 1,
      cells: [{ xBin: 5, yBin: 4, count: 7 }],
    };
    const viewport = { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 };

    expect(renderer?.setScene({
      descriptors: [{ key: "0:0:source", tile: firstTile, transpose: false }],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport,
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);
    // Model the stopped-wheel frame: the one live camera is already at the
    // preview viewport while background tiles continue arriving.
    renderer?.setPanViewport({
      xStart: 500,
      xEnd: 4_500,
      yStart: 750,
      yEnd: 4_750,
    });
    const clearsBeforeAppend = clear.mock.calls.length;
    const drawsBeforeAppend = drawArrays.mock.calls.length;
    const uploadsBeforeAppend = texImage2D.mock.calls.length;
    const layoutReadsBeforeAppend = clientWidthRead.mock.calls.length
      + clientHeightRead.mock.calls.length;

    expect(renderer?.appendSceneDescriptors({
      descriptors: [{ key: "1:1:source", tile: nextTile, transpose: false }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);
    expect(texImage2D.mock.calls.length).toBe(uploadsBeforeAppend + 1);
    expect(clear).toHaveBeenCalledTimes(clearsBeforeAppend);
    expect(drawArrays).toHaveBeenCalledTimes(drawsBeforeAppend);
    expect(clientWidthRead.mock.calls.length + clientHeightRead.mock.calls.length)
      .toBe(layoutReadsBeforeAppend);

    const updatedNextTile = {
      ...nextTile,
      cells: [{ xBin: 5, yBin: 4, count: 11 }],
    };
    expect(renderer?.appendSceneDescriptors({
      descriptors: [{ key: "1:1:source", tile: updatedNextTile, transpose: false }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);
    expect(texImage2D.mock.calls.length).toBe(uploadsBeforeAppend + 1);
    expect(texSubImage2D).toHaveBeenCalledOnce();

    // Never replace an already complete tile from the presented generation
    // with a partial snapshot from the next pan generation.
    expect(renderer?.appendSceneDescriptors({
      descriptors: [{
        key: "0:0:source",
        tile: { ...firstTile, cells: [{ xBin: 1, yBin: 0, count: 99 }] },
        transpose: false,
      }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);
    expect(texImage2D.mock.calls.length).toBe(uploadsBeforeAppend + 1);
    expect(texSubImage2D).toHaveBeenCalledOnce();

    expect(renderer?.presentAppendedSceneDescriptors()).toBe(true);
    expect(clear).toHaveBeenCalledTimes(clearsBeforeAppend);
    expect(drawArrays.mock.calls.length).toBe(drawsBeforeAppend + 1);
    expect(clientWidthRead.mock.calls.length + clientHeightRead.mock.calls.length)
      .toBe(layoutReadsBeforeAppend);
    expect(texImage2D).toHaveBeenCalledTimes(uploadsBeforeAppend + 1);
    expect(renderer?.presentAppendedSceneDescriptors()).toBe(true);
    expect(drawArrays).toHaveBeenCalledTimes(drawsBeforeAppend + 1);

    const uploadsBeforePromotion = texImage2D.mock.calls.length;
    expect(renderer?.setScene({
      descriptors: [{
        key: "1:1:source",
        tile: { ...updatedNextTile, cells: [...updatedNextTile.cells] },
        transpose: false,
      }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport,
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);
    expect(texImage2D).toHaveBeenCalledTimes(uploadsBeforePromotion);

    // Promotion is one-shot: an unrelated same-generation replacement must
    // upload its own content instead of inheriting the preview texture.
    expect(renderer?.setScene({
      descriptors: [{
        key: "1:1:source",
        tile: { ...updatedNextTile, cells: [{ xBin: 5, yBin: 4, count: 13 }] },
        transpose: false,
      }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport,
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);
    expect(texImage2D).toHaveBeenCalledTimes(uploadsBeforePromotion + 1);
    renderer?.destroy();
  });

  it("atomically promotes a fully prefetched pan scene with zero new tile uploads", () => {
    const {
      canvas,
      blitFramebuffer,
      clientHeightRead,
      clientWidthRead,
      drawArrays,
      texImage2D,
      texSubImage2D,
    } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      performanceEnabled: false,
    });
    const renderStyle = {
      colormap: "Reds" as const,
      colorScale: { log: false, min: 0, max: 10 },
    };
    const firstTile = {
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 0, yBin: 0, count: 9 }],
    };
    const prefetchedTile = {
      tileX: 1,
      tileY: 0,
      cells: [{ xBin: 4, yBin: 0, count: 7 }],
    };
    expect(renderer?.setScene({
      descriptors: [{ key: "0:0:source", tile: firstTile, transpose: false }],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle,
    })).toBe(true);
    renderer?.setPanViewport({ xStart: 4_000, xEnd: 8_000, yStart: 0, yEnd: 4_000 });
    const drawsBeforePrefetch = drawArrays.mock.calls.length;
    const presentationsBeforePrefetch = blitFramebuffer.mock.calls.length;
    expect(renderer?.appendSceneDescriptors({
      descriptors: [{ key: "1:0:source", tile: prefetchedTile, transpose: false }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);
    expect(drawArrays).toHaveBeenCalledTimes(drawsBeforePrefetch);
    expect(blitFramebuffer).toHaveBeenCalledTimes(presentationsBeforePrefetch);

    const completedPrefetchedTile = {
      ...prefetchedTile,
      cells: [
        ...prefetchedTile.cells,
        { xBin: 5, yBin: 1, count: 3 },
      ],
    };
    expect(renderer?.appendSceneDescriptors({
      descriptors: [{ key: "1:0:source", tile: completedPrefetchedTile, transpose: false }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);
    expect(drawArrays).toHaveBeenCalledTimes(drawsBeforePrefetch);
    expect(blitFramebuffer).toHaveBeenCalledTimes(presentationsBeforePrefetch);

    // Prefetch never presents asynchronously, but it is armed in the active
    // scene so the next pointer frame can draw the old front and new edge tile
    // together without waiting for the terminal target generation.
    const imageUploadsBeforePointer = texImage2D.mock.calls.length;
    const subUploadsBeforePointer = texSubImage2D.mock.calls.length;
    const layoutReadsBeforePointer = clientWidthRead.mock.calls.length
      + clientHeightRead.mock.calls.length;
    renderer?.setPanViewport({ xStart: 4_250, xEnd: 8_250, yStart: 0, yEnd: 4_000 });
    expect(drawArrays).toHaveBeenCalledTimes(drawsBeforePrefetch + 2);
    expect(blitFramebuffer).toHaveBeenCalledTimes(presentationsBeforePrefetch + 1);
    expect(texImage2D).toHaveBeenCalledTimes(imageUploadsBeforePointer);
    expect(texSubImage2D).toHaveBeenCalledTimes(subUploadsBeforePointer);
    expect(clientWidthRead.mock.calls.length + clientHeightRead.mock.calls.length)
      .toBe(layoutReadsBeforePointer);

    const targetTile = {
      ...completedPrefetchedTile,
      cells: [...completedPrefetchedTile.cells],
    };
    const targetScene = {
      descriptors: [{ key: "1:0:source", tile: targetTile, transpose: false }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 4_000, xEnd: 8_000, yStart: 0, yEnd: 4_000 },
      renderStyle,
    };
    const uploadsBeforePromotion = renderer?.performanceSnapshot().fullUploads;
    const imageUploadsBeforePromotion = texImage2D.mock.calls.length;
    const presentationsBeforePromotion = blitFramebuffer.mock.calls.length;

    expect(renderer?.promoteScene(targetScene)).toBe(true);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      fullUploads: uploadsBeforePromotion,
      scenePromotions: 1,
      scenePromotionMisses: 0,
    });
    expect(texImage2D).toHaveBeenCalledTimes(imageUploadsBeforePromotion);
    expect(blitFramebuffer).toHaveBeenCalledTimes(presentationsBeforePromotion + 1);

    // React publishes the promoted frame after the imperative commit. The
    // child setScene call recognizes it and performs no second GPU paint.
    expect(renderer?.setScene(targetScene)).toBe(true);
    expect(texImage2D).toHaveBeenCalledTimes(imageUploadsBeforePromotion);
    expect(blitFramebuffer).toHaveBeenCalledTimes(presentationsBeforePromotion + 1);
    renderer?.destroy();
  });

  it("keeps the current presentation untouched when GPU cache has only a partial target", () => {
    const { canvas, blitFramebuffer } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      performanceEnabled: false,
    });
    const renderStyle = {
      colormap: "Reds" as const,
      colorScale: { log: false, min: 0, max: 10 },
    };
    expect(renderer?.setScene({
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 0, yBin: 0, count: 9 }] },
        transpose: false,
      }],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle,
    })).toBe(true);
    expect(renderer?.appendSceneDescriptors({
      descriptors: [{
        key: "1:0:source",
        tile: { tileX: 1, tileY: 0, cells: [{ xBin: 4, yBin: 0, count: 5 }] },
        transpose: false,
      }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);
    const presentationsBeforeMiss = blitFramebuffer.mock.calls.length;

    expect(renderer?.promoteScene({
      descriptors: [{
        key: "1:0:source",
        tile: {
          tileX: 1,
          tileY: 0,
          cells: [
            { xBin: 4, yBin: 0, count: 5 },
            { xBin: 5, yBin: 0, count: 3 },
          ],
        },
        transpose: false,
      }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 4_000, xEnd: 8_000, yStart: 0, yEnd: 4_000 },
      renderStyle,
    })).toBe(false);
    expect(blitFramebuffer).toHaveBeenCalledTimes(presentationsBeforeMiss);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      scenePromotions: 0,
      scenePromotionMisses: 1,
    });
    renderer?.destroy();
  });

  it("updates a visible delta texture with texSubImage2D and promotes it without texImage2D", () => {
    const { canvas, texImage2D, texSubImage2D } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024);
    const counts = new Float64Array(16);
    const occupied = new Uint8Array(16);
    counts[1] = 3;
    occupied[1] = 1;
    const buffer = {
      tile: { tileX: 0, tileY: 0 },
      counts,
      occupied,
      occupiedCount: 1,
    };
    const descriptor = {
      key: "0:0:source",
      tile: { tileX: 0, tileY: 0, cells: [] },
      transpose: false,
    };
    const renderStyle = {
      colormap: "Reds" as const,
      colorScale: { log: false, min: 0, max: 10 },
    };
    const viewport = { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 };

    expect(renderer?.setDeltaScene({
      buffers: [buffer],
      descriptors: [descriptor],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport,
      renderStyle,
    })).toBe(true);
    counts[1] = 9;
    expect(renderer?.updateDeltaTiles(["0:0"])).toBe(true);
    expect(texSubImage2D).toHaveBeenCalled();
    const fullUploadsBeforePromotion = texImage2D.mock.calls.length;

    expect(renderer?.setScene({
      descriptors: [{
        ...descriptor,
        tile: {
          tileX: 0,
          tileY: 0,
          cells: [{ xBin: 1, yBin: 0, count: 9 }],
        },
      }],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport,
      renderStyle,
    })).toBe(true);
    expect(texImage2D).toHaveBeenCalledTimes(fullUploadsBeforePromotion);
    expect(texSubImage2D.mock.calls.length).toBeGreaterThanOrEqual(2);
    renderer?.destroy();
  });

  it("uploads a hidden retained delta tile only once during terminal promotion", () => {
    const { canvas, texImage2D, texSubImage2D } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024);
    const counts = new Float64Array(16);
    const occupied = new Uint8Array(16);
    counts[1] = 3;
    occupied[1] = 1;
    const buffer = {
      tile: { tileX: 0, tileY: 0 },
      counts,
      occupied,
      occupiedCount: 1,
    };
    const descriptor = {
      key: "0:0:source",
      tile: { tileX: 0, tileY: 0, cells: [] },
      transpose: false,
    };
    const renderStyle = {
      colormap: "Reds" as const,
      colorScale: { log: false, min: 0, max: 10 },
    };
    const viewport = { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 };
    const r16fUploads = () => texImage2D.mock.calls.filter((call) => call[2] === 29).length;

    expect(renderer?.setDeltaScene({
      buffers: [buffer],
      deferTextureUpdates: true,
      descriptors: [descriptor],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport,
      renderStyle,
    })).toBe(true);
    counts[1] = 9;
    expect(renderer?.updateDeltaTiles(["0:0"])).toBe(true);
    expect(r16fUploads()).toBe(0);
    expect(texSubImage2D).not.toHaveBeenCalled();

    expect(renderer?.setScene({
      descriptors: [{
        ...descriptor,
        tile: {
          tileX: 0,
          tileY: 0,
          cells: [{ xBin: 1, yBin: 0, count: 9 }],
        },
      }],
      generation: 8,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport,
      renderStyle,
    })).toBe(true);
    expect(r16fUploads()).toBe(1);
    expect(texSubImage2D).not.toHaveBeenCalled();
    renderer?.destroy();
  });

  it("converts a mutable delta buffer into one reusable diagonal R32F upload", () => {
    const target = new Float32Array(16);
    const counts = new Float64Array(16);
    const occupied = new Uint8Array(16);
    counts[2 * 4 + 1] = 7.5;
    counts[3 * 4 + 3] = 11;
    occupied[2 * 4 + 1] = 1;
    occupied[3 * 4 + 3] = 1;

    const values = contactTileDenseFloatTextureData({
      tile: { tileX: 2, tileY: 2 },
      counts,
      occupied,
      occupiedCount: 2,
    }, 4, target);

    expect(values).toBe(target);
    expect(values[2 * 4 + 1]).toBe(7.5);
    expect(values[1 * 4 + 2]).toBe(7.5);
    expect(values[3 * 4 + 3]).toBe(11);
    expect(values[0]).toBe(-1);
  });

  it("rejects a per-tile scratch buffer with the wrong dimensions", () => {
    expect(() => contactTileDenseFloatTextureData({
      tile: { tileX: 0, tileY: 1 },
      counts: new Float64Array(16),
      occupied: new Uint8Array(16),
      occupiedCount: 0,
    }, 4, new Float32Array(15))).toThrow(/target does not match/);
  });

  it("packs typed tile counts and completes a diagonal tile symmetrically", () => {
    const values = contactTileFloatTextureData({
      tileX: 2,
      tileY: 2,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([1, 3]),
        yLocal: new Uint16Array([2, 3]),
        counts: new Float64Array([7.5, 11]),
      },
    }, 4);

    expect(values[2 * 4 + 1]).toBe(7.5);
    expect(values[1 * 4 + 2]).toBe(7.5);
    expect(values[3 * 4 + 3]).toBe(11);
    expect(values[0]).toBe(-1);
  });

  it("uploads completed off-diagonal Float32 cache tiles without re-densifying", () => {
    const denseValues = new Float32Array(16);
    denseValues.fill(-1);
    denseValues[9] = 7.5;

    expect(contactTileFloatTextureData({
      tileX: 1,
      tileY: 2,
      cells: [],
      denseValues,
      denseOccupiedCount: 1,
    }, 4)).toBe(denseValues);
    expect(contactTileDenseFloatTextureData({
      tile: { tileX: 1, tileY: 2 },
      counts: new Float64Array(16),
      occupied: new Uint8Array(16),
      occupiedCount: 1,
      completeValues: denseValues,
    }, 4, new Float32Array(16))).toBe(denseValues);
  });

  it("keeps an off-diagonal source texture canonical for UV mirror reuse", () => {
    const values = contactTileFloatTextureData({
      tileX: 1,
      tileY: 3,
      cells: [{ xBin: 5, yBin: 14, count: 9 }],
    }, 4);

    expect(values[2 * 4 + 1]).toBe(9);
    expect(values[1 * 4 + 2]).toBe(-1);
  });

  it("rejects invalid texture dimensions", () => {
    expect(() => contactTileFloatTextureData({
      tileX: 0,
      tileY: 0,
      cells: [],
    }, 0)).toThrow(/positive integer/);
  });

  it("rejects a frame when one populated high-resolution tile was skipped", () => {
    const descriptors = Array.from({ length: 16 }, (_, index) => ({
      key: `${index}:source`,
      tile: {
        tileX: index % 4,
        tileY: Math.floor(index / 4) + 8,
        cells: [{ xBin: index % 4, yBin: index, count: index + 1 }],
      },
      transpose: false,
    }));
    const allDrawn = new Set(descriptors.map(({ key }) => key));
    const oneMissing = new Set(allDrawn);
    oneMissing.delete("7:source");

    expect(contactTileGpuDrawCoverageIsComplete(descriptors, allDrawn)).toBe(true);
    expect(contactTileGpuDrawCoverageIsComplete(descriptors, oneMissing)).toBe(false);
  });

  it("allows explicit empty tiles to use the white framebuffer clear", () => {
    const descriptors = [{
      key: "empty:source",
      tile: { tileX: 0, tileY: 0, cells: [] },
      transpose: false,
    }];
    expect(contactTileGpuDrawCoverageIsComplete(descriptors, new Set())).toBe(true);
    expect(contactTileGpuDrawCoverageIsComplete(descriptors, new Set(), true)).toBe(false);
    expect(contactTileGpuDrawCoverageIsComplete(
      descriptors,
      new Set(["empty:source"]),
      true,
    )).toBe(true);
  });
});
