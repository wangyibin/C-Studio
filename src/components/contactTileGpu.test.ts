import { describe, expect, it, vi } from "vitest";
import {
  contactTileDenseFloatTextureData,
  contactTileFloatTextureData,
  contactTileGpuDrawCoverageIsComplete,
  createContactTileGpuRenderer,
} from "./contactTileGpu";

function mockWebGlCanvas() {
  const texImage2D = vi.fn();
  const texSubImage2D = vi.fn();
  const getError = vi.fn(() => 0);
  const drawArrays = vi.fn();
  const clear = vi.fn();
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
    RED: 22,
    RGBA8: 23,
    RGBA: 24,
    UNSIGNED_BYTE: 25,
    COLOR_BUFFER_BIT: 26,
    TRIANGLES: 27,
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
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn(() => ({})),
    deleteBuffer: vi.fn(),
    deleteTexture: vi.fn(),
    disable: vi.fn(),
    pixelStorei: vi.fn(),
    isContextLost: vi.fn(() => false),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear,
    useProgram: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    uniform2f: vi.fn(),
    uniform4f: vi.fn(),
    uniform1f: vi.fn(),
    uniform1i: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D,
    texSubImage2D,
    drawArrays,
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
    clear,
    clientHeightRead,
    clientWidthRead,
    drawArrays,
    getError,
    texImage2D,
    texSubImage2D,
  };
}

describe("contactTileFloatTextureData", () => {
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

    renderer?.setPanOffset(12, -8);

    expect(clientWidthRead.mock.calls.length + clientHeightRead.mock.calls.length)
      .toBe(layoutReadsBeforePan);
    expect(texImage2D).toHaveBeenCalledTimes(uploadsBeforePan);
    expect(getError).toHaveBeenCalledTimes(validationsBeforePan);
    expect(drawArrays.mock.calls.length).toBe(drawsBeforePan + 1);
    renderer?.destroy();
  });

  it("appends pan-prefetch textures without clearing or redrawing the scene", () => {
    const {
      canvas,
      clear,
      clientHeightRead,
      clientWidthRead,
      drawArrays,
      texImage2D,
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
    const clearsBeforeAppend = clear.mock.calls.length;
    const drawsBeforeAppend = drawArrays.mock.calls.length;
    const uploadsBeforeAppend = texImage2D.mock.calls.length;
    const layoutReadsBeforeAppend = clientWidthRead.mock.calls.length
      + clientHeightRead.mock.calls.length;

    expect(renderer?.appendSceneDescriptors({
      descriptors: [{ key: "1:1:source", tile: nextTile, transpose: false }],
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);
    expect(texImage2D.mock.calls.length).toBe(uploadsBeforeAppend + 1);
    expect(clear).toHaveBeenCalledTimes(clearsBeforeAppend);
    expect(drawArrays).toHaveBeenCalledTimes(drawsBeforeAppend);
    expect(clientWidthRead.mock.calls.length + clientHeightRead.mock.calls.length)
      .toBe(layoutReadsBeforeAppend);

    expect(renderer?.appendSceneDescriptors({
      descriptors: [{
        key: "0:0:source",
        tile: { ...firstTile, cells: [{ xBin: 1, yBin: 0, count: 99 }] },
        transpose: false,
      }],
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);
    expect(texImage2D.mock.calls.length).toBe(uploadsBeforeAppend + 1);

    renderer?.setPanOffset(4, 4);
    expect(drawArrays.mock.calls.length).toBe(drawsBeforeAppend + 2);
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
    const r32fUploads = () => texImage2D.mock.calls.filter((call) => call[2] === 21).length;

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
    expect(r32fUploads()).toBe(0);
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
    expect(r32fUploads()).toBe(1);
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
    expect(contactTileGpuDrawCoverageIsComplete([{
      key: "empty:source",
      tile: { tileX: 0, tileY: 0, cells: [] },
      transpose: false,
    }], new Set())).toBe(true);
  });
});
