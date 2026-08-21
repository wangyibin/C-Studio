import { describe, expect, it, vi } from "vitest";
import {
  buildContactGpuLayoutMap,
  buildContactSourceAddressSpace,
} from "../state/contactSourceLayout";
import {
  contactOverviewFloatTextureData,
  contactOverviewTextureBytes,
  contactTileDenseFloatTextureData,
  contactTileFloatTextureData,
  contactTileGpuFloatValuesFitR16f,
  contactTileGpuBoundaryInstanceData,
  contactTileGpuDrawCoverageIsComplete,
  contactTileGpuTexturePreference,
  contactTileGpuUploadBatch,
  contactTileGpuUploadPlan,
  contactTileGpuVirtualTextureBudgetBytes,
  contactTileGpuVirtualTextureEnabled,
  contactTileSourcePagePlan,
  contactTileVirtualCamera,
  contactTileVirtualPageExactFlag,
  contactTileVirtualPagePlan,
  contactTileVirtualPageTableData,
  contactTileVirtualPageTransposeFlag,
  createContactTileGpuRenderer,
} from "./contactTileGpu";

function mockWebGlCanvas() {
  const texImage2D = vi.fn();
  const texSubImage2D = vi.fn();
  const texImage3D = vi.fn();
  const texSubImage3D = vi.fn();
  const getError = vi.fn(() => 0);
  const drawArrays = vi.fn();
  const drawArraysInstanced = vi.fn();
  const bufferData = vi.fn();
  const clear = vi.fn();
  const scissor = vi.fn();
  const uniform4f = vi.fn();
  const blitFramebuffer = vi.fn();
  const fenceSync = vi.fn(() => ({}));
  const clientWaitSync = vi.fn(() => 52);
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
    HALF_FLOAT: 55,
    DEPTH_TEST: 8,
    CULL_FACE: 9,
    BLEND: 10,
    SCISSOR_TEST: 28,
    UNPACK_ALIGNMENT: 11,
    TEXTURE0: 12,
    TEXTURE1: 13,
    TEXTURE2: 35,
    TEXTURE3: 36,
    TEXTURE4: 44,
    TEXTURE5: 45,
    TEXTURE6: 46,
    TEXTURE7: 47,
    TEXTURE_2D: 14,
    TEXTURE_2D_ARRAY: 37,
    TEXTURE_MIN_FILTER: 15,
    TEXTURE_MAG_FILTER: 16,
    TEXTURE_WRAP_S: 17,
    TEXTURE_WRAP_T: 18,
    TEXTURE_WRAP_R: 38,
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
    RG32UI: 39,
    RG_INTEGER: 40,
    RGBA32UI: 48,
    RGBA_INTEGER: 49,
    UNSIGNED_INT: 41,
    MAX_ARRAY_TEXTURE_LAYERS: 42,
    MAX_TEXTURE_SIZE: 43,
    NO_ERROR: 0,
    SYNC_GPU_COMMANDS_COMPLETE: 50,
    ALREADY_SIGNALED: 51,
    CONDITION_SATISFIED: 52,
    TIMEOUT_EXPIRED: 53,
    WAIT_FAILED: 54,
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
    getParameter: vi.fn(() => 256),
    deleteBuffer: vi.fn(),
    deleteTexture: vi.fn(),
    deleteFramebuffer: vi.fn(),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 34),
    blitFramebuffer,
    fenceSync,
    clientWaitSync,
    deleteSync: vi.fn(),
    flush: vi.fn(),
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
    uniform2i: vi.fn(),
    uniform4f,
    uniform1f: vi.fn(),
    uniform1i: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D,
    texSubImage2D,
    texImage3D,
    texSubImage3D,
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
    getContext: canvas.getContext as ReturnType<typeof vi.fn>,
    blitFramebuffer,
    clientWaitSync,
    bufferData,
    clear,
    clientHeightRead,
    clientWidthRead,
    drawArrays,
    drawArraysInstanced,
    getError,
    fenceSync,
    scissor,
    texImage2D,
    texImage3D,
    texSubImage2D,
    texSubImage3D,
    uniform4f,
  };
}

function mockFrameScheduler() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    requestFrame: (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle: number) => {
      callbacks.delete(handle);
    },
    pending: () => callbacks.size,
    flushOne: () => {
      const frame = [...callbacks.entries()];
      callbacks.clear();
      for (const [handle, callback] of frame) {
        callback(handle * 16.7);
      }
    },
    flushAll: () => {
      while (callbacks.size > 0) {
        const frame = [...callbacks.entries()];
        callbacks.clear();
        for (const [handle, callback] of frame) {
          callback(handle * 16.7);
        }
      }
    },
  };
}

describe("contactTileFloatTextureData", () => {
  it("compacts sparse source tile ids into one NxN page table", () => {
    const tile = {
      tileX: 7,
      tileY: 42,
      cells: [{ xBin: 29, yBin: 169, count: 5 }],
    };
    const plan = contactTileSourcePagePlan([7, 42], [
      { key: "source", tile, transpose: false },
      { key: "mirror", tile, transpose: true },
    ]);
    expect(plan).toMatchObject({ originX: 0, originY: 0, width: 2, height: 2 });
    expect(plan?.pages.map((page) => [page.pageX, page.pageY, page.transpose])).toEqual([
      [0, 1, false],
      [1, 0, true],
    ]);
    expect(plan?.populatedTiles).toHaveLength(1);
  });

  it("renders an exact source layout before the projected layer is complete", () => {
    const { canvas } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024);
    const addressSpace = buildContactSourceAddressSpace([{ name: "a", length: 4_000 }]);
    const layoutBlocks = [{
      id: "a",
      objectId: "chr1",
      sourceId: "a",
      sourceStart: 0,
      sourceEnd: 4_000,
      visualStart: 0,
      visualEnd: 4_000,
      orientation: "+" as const,
    }];
    const map = buildContactGpuLayoutMap({
      addressSpace,
      layoutBlocks,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 4_000 },
    });
    const tile = {
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 1, yBin: 0, count: 8 }],
    };
    expect(renderer?.setScene({
      descriptors: [],
      generation: 9,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      visibleLayerComplete: false,
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
      sourceLayout: {
        dataScope: "source-test",
        descriptors: [{ key: "source", tile, transpose: false }],
        generation: 9,
        sourceTiles: [0],
        xMap: map,
        yMap: map,
      },
    })).toBe(true);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      sourceLayoutDraws: 1,
      sourceLayoutUploads: 1,
      sourceLayoutBytes: map.addressData.byteLength * 2 + map.weightData.byteLength * 2,
    });
    renderer?.destroy();
  });

  it("builds a compact virtual page table with one shared layer for mirrors", () => {
    const populatedTile = {
      tileX: 2,
      tileY: 3,
      cells: [{ xBin: 8, yBin: 12, count: 5 }],
    };
    const emptyTile = { tileX: 4, tileY: 3, cells: [] };
    const plan = contactTileVirtualPagePlan([
      { key: "2:3", tile: populatedTile, transpose: false },
      { key: "3:2", tile: populatedTile, transpose: true },
      { key: "4:3", tile: emptyTile, transpose: false },
    ]);
    expect(plan).toMatchObject({
      originX: 2,
      originY: 2,
      width: 3,
      height: 2,
    });
    expect(plan?.populatedTiles).toHaveLength(1);
    const table = contactTileVirtualPageTableData(
      plan!,
      new Map([["2:3", 6]]),
    );
    const entry = (x: number, y: number) => {
      const offset = ((y - plan!.originY) * plan!.width + x - plan!.originX) * 2;
      return [table![offset], table![offset + 1]];
    };
    expect(entry(2, 3)).toEqual([7, contactTileVirtualPageExactFlag]);
    expect(entry(3, 2)).toEqual([
      7,
      contactTileVirtualPageExactFlag | contactTileVirtualPageTransposeFlag,
    ]);
    expect(entry(4, 3)).toEqual([0, contactTileVirtualPageExactFlag]);
  });

  it("orders center tiles before visible edges and prefetch pages", () => {
    const makeDescriptor = (tileX: number) => ({
      key: `${tileX}:0:source`,
      tile: {
        tileX,
        tileY: 0,
        cells: [{ xBin: tileX * 4, yBin: 0, count: tileX + 1 }],
      },
      transpose: false,
    });
    const plan = contactTileGpuUploadPlan({
      descriptors: [makeDescriptor(4), makeDescriptor(0), makeDescriptor(1)],
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 0, xEnd: 16_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    });
    expect(plan.map(({ key, priority }) => [key, priority])).toEqual([
      ["0:1", "center"],
      ["0:0", "edge"],
      ["0:4", "prefetch"],
    ]);
    expect(contactTileGpuUploadBatch(plan, 128).map(({ key }) => key)).toEqual([
      "0:1",
      "0:0",
    ]);
  });

  it("prioritizes source atlas pages through visual AGP addresses", () => {
    const addressSpace = buildContactSourceAddressSpace([{ name: "a", length: 20_000 }]);
    const map = buildContactGpuLayoutMap({
      addressSpace,
      layoutBlocks: [{
        id: "moved",
        objectId: "chr1",
        sourceId: "a",
        sourceStart: 8_000,
        sourceEnd: 16_000,
        visualStart: 0,
        visualEnd: 8_000,
        orientation: "+",
      }],
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 8_000 },
      overscanBins: 4,
    });
    const visible = {
      tileX: 2,
      tileY: 2,
      cells: [{ xBin: 8, yBin: 8, count: 4 }],
    };
    const unrelatedSourcePage = {
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 0, yBin: 0, count: 9 }],
    };
    const plan = contactTileGpuUploadPlan({
      descriptors: [],
      generation: 3,
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 8_000, yStart: 0, yEnd: 8_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
      sourceLayout: {
        dataScope: "source-priority",
        descriptors: [
          { key: "visible", tile: visible, transpose: false },
          { key: "unrelated", tile: unrelatedSourcePage, transpose: false },
        ],
        generation: 3,
        sourceTiles: [0, 2, 3],
        xMap: map,
        yMap: map,
      },
    });
    expect(plan.map(({ key, priority }) => [key, priority])).toEqual([
      ["2:2", "center"],
      ["0:0", "prefetch"],
    ]);
  });

  it("submits at most one byte-budgeted atlas layer per scheduled frame", () => {
    const { canvas, texSubImage3D } = mockWebGlCanvas();
    const frames = mockFrameScheduler();
    const presented = vi.fn();
    const descriptors = Array.from({ length: 6 }, (_, tileX) => ({
      key: `${tileX}:0:source`,
      tile: {
        tileX,
        tileY: 0,
        cells: [{ xBin: tileX * 4, yBin: 0, count: tileX + 1 }],
      },
      transpose: false,
    }));
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      performanceEnabled: false,
      virtualTextureEnabled: true,
      uploadBudgetBytes: 64,
      uploadBudgetMilliseconds: 100,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    expect(renderer?.setScene({
      descriptors,
      generation: 1,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 0, xEnd: 24_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    }, presented)).toBe(true);
    expect(texSubImage3D).toHaveBeenCalledOnce();
    expect(presented).not.toHaveBeenCalled();
    for (let uploaded = 2; uploaded <= 6; uploaded += 1) {
      expect(frames.pending()).toBe(1);
      frames.flushOne();
      expect(texSubImage3D).toHaveBeenCalledTimes(uploaded);
    }
    expect(presented).toHaveBeenCalledWith(true);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      uploadQueueFrames: 6,
      uploadQueueDeferredFrames: 5,
      uploadQueueMaxDepth: 6,
      uploadQueueBytes: 384,
    });
    renderer?.destroy();
  });

  it("retains the front until a staging GPU fence signals completion", () => {
    const {
      canvas,
      blitFramebuffer,
      clientWaitSync,
      fenceSync,
    } = mockWebGlCanvas();
    clientWaitSync.mockReturnValueOnce(53).mockReturnValue(52);
    const frames = mockFrameScheduler();
    const presented = vi.fn();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      performanceEnabled: false,
      virtualTextureEnabled: true,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    expect(renderer?.setScene({
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 0, yBin: 0, count: 4 }] },
        transpose: false,
      }],
      generation: 1,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    }, presented)).toBe(true);
    expect(fenceSync).toHaveBeenCalledOnce();
    expect(blitFramebuffer).not.toHaveBeenCalled();
    expect(presented).not.toHaveBeenCalled();
    frames.flushOne();
    expect(blitFramebuffer).toHaveBeenCalledOnce();
    expect(presented).toHaveBeenCalledWith(true);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      uploadFencePolls: 2,
      uploadFenceWaitFrames: 1,
      uploadFenceSignals: 1,
      uploadFenceFailures: 0,
    });
    renderer?.destroy();
  });

  it("rejects virtual pages outside the non-negative safe tile grid", () => {
    expect(contactTileVirtualPagePlan([{
      key: "invalid",
      tile: { tileX: -1, tileY: 0, cells: [] },
      transpose: false,
    }])).toBeNull();
  });

  it("keeps 10 Gb cameras precise by sending only page-local floats to the shader", () => {
    const viewport = {
      xStart: 9_737_100_000,
      xEnd: 9_911_600_000,
      yStart: 9_737_100_000,
      yEnd: 9_911_600_000,
    };
    const camera = contactTileVirtualCamera(viewport, 1_000, 256);
    expect(camera.localX).toBeGreaterThanOrEqual(0);
    expect(camera.localX).toBeLessThan(1);
    expect(camera.localY).toBeGreaterThanOrEqual(0);
    expect(camera.localY).toBeLessThan(1);
    expect((camera.pageX + camera.localX) * 256_000).toBeCloseTo(viewport.xStart, 5);
    expect((camera.pageY + camera.localY) * 256_000).toBeCloseTo(viewport.yStart, 5);
    expect(camera.spanX * 256_000).toBeCloseTo(viewport.xEnd - viewport.xStart, 5);
  });

  it("reduces a multi-tile pointer frame to one draw with a legacy fallback switch", () => {
    const descriptors = Array.from({ length: 8 }, (_, index) => {
      const tileX = index % 4;
      const tileY = Math.floor(index / 4);
      return {
        key: `${tileX}:${tileY}`,
        tile: {
          tileX,
          tileY,
          cells: [{ xBin: tileX * 4, yBin: tileY * 4, count: index + 1 }],
        },
        transpose: false,
      };
    });
    const scene = {
      descriptors,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 0, xEnd: 15_900, yStart: 0, yEnd: 7_900 },
      renderStyle: {
        colormap: "Reds" as const,
        colorScale: { log: false, min: 0, max: 10 },
      },
    };

    const virtualMock = mockWebGlCanvas();
    const virtualRenderer = createContactTileGpuRenderer(
      virtualMock.canvas,
      4 * 1024 * 1024,
      { performanceEnabled: false, virtualTextureEnabled: true },
    );
    expect(virtualRenderer?.setScene(scene)).toBe(true);
    const virtualDrawsBeforePan = virtualMock.drawArrays.mock.calls.length;
    const virtualTextureDrawsBeforePan = virtualRenderer?.performanceSnapshot()
      .virtualTextureDraws ?? 0;
    virtualRenderer?.setPanViewport({ xStart: 100, xEnd: 16_000, yStart: 0, yEnd: 7_900 });
    expect(virtualMock.drawArrays).toHaveBeenCalledTimes(virtualDrawsBeforePan + 1);
    expect(virtualRenderer?.performanceSnapshot().virtualTextureDraws)
      .toBe(virtualTextureDrawsBeforePan + 1);
    expect(virtualRenderer?.performanceSnapshot().virtualTextureBytes)
      .toBeLessThanOrEqual(contactTileGpuVirtualTextureBudgetBytes);

    const legacyMock = mockWebGlCanvas();
    const legacyRenderer = createContactTileGpuRenderer(
      legacyMock.canvas,
      4 * 1024 * 1024,
      { performanceEnabled: false, virtualTextureEnabled: false },
    );
    expect(legacyRenderer?.setScene(scene)).toBe(true);
    const legacyDrawsBeforePan = legacyMock.drawArrays.mock.calls.length;
    legacyRenderer?.setPanViewport({ xStart: 100, xEnd: 16_000, yStart: 0, yEnd: 7_900 });
    expect(legacyMock.drawArrays).toHaveBeenCalledTimes(legacyDrawsBeforePan + 8);
    expect(legacyRenderer?.performanceSnapshot().virtualTextureDraws).toBe(0);
    virtualRenderer?.destroy();
    legacyRenderer?.destroy();
  });

  it("stages a replacement through a second FBO without creating another context or atlas", () => {
    const {
      canvas,
      getContext,
      blitFramebuffer,
      texImage3D,
      texSubImage3D,
    } = mockWebGlCanvas();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      performanceEnabled: false,
      virtualTextureEnabled: true,
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
      generation: 1,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 },
      renderStyle,
    })).toBe(true);
    const atlasAllocations = texImage3D.mock.calls.length;
    const atlasUploads = texSubImage3D.mock.calls.length;
    const presentations = blitFramebuffer.mock.calls.length;

    expect(renderer?.stageScene({
      descriptors: [{
        key: "1:0:source",
        tile: { tileX: 1, tileY: 0, cells: [{ xBin: 4, yBin: 0, count: 7 }] },
        transpose: false,
      }],
      generation: 2,
      resolution: 2_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: { xStart: 8_000, xEnd: 16_000, yStart: 0, yEnd: 8_000 },
      renderStyle,
    })).toBe(true);

    expect(getContext).toHaveBeenCalledOnce();
    expect(texImage3D).toHaveBeenCalledTimes(atlasAllocations);
    expect(texSubImage3D).toHaveBeenCalledTimes(atlasUploads + 1);
    expect(blitFramebuffer).toHaveBeenCalledTimes(presentations + 1);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      cacheBytes: 0,
      framebufferSwaps: 1,
      stagedSceneDraws: 1,
      virtualTextureRebuilds: 1,
      virtualTextureLayers: 2,
    });
    renderer?.destroy();
  });

  it("reuses LRU atlas slots at capacity instead of reallocating the array", () => {
    const { canvas, texImage3D, texSubImage3D } = mockWebGlCanvas();
    // A 256-byte budget leaves three 4x4 R32F atlas layers after page-table reserve.
    const renderer = createContactTileGpuRenderer(canvas, 256, {
      performanceEnabled: false,
      virtualTextureEnabled: true,
      texturePreference: "r32f",
    });
    const renderStyle = {
      colormap: "Reds" as const,
      colorScale: { log: false, min: 0, max: 10 },
    };
    const scene = (generation: number, tileXs: number[]) => ({
      descriptors: tileXs.map((tileX) => ({
        key: `${tileX}:0:source`,
        tile: {
          tileX,
          tileY: 0,
          cells: [{ xBin: tileX * 4, yBin: 0, count: tileX + 1 }],
        },
        transpose: false,
      })),
      generation,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport: {
        xStart: Math.min(...tileXs) * 4_000,
        xEnd: (Math.max(...tileXs) + 1) * 4_000,
        yStart: 0,
        yEnd: 4_000,
      },
      renderStyle,
    });

    expect(renderer?.setScene(scene(1, [0, 1]))).toBe(true);
    const allocations = texImage3D.mock.calls.length;
    const uploads = texSubImage3D.mock.calls.length;
    expect(renderer?.stageScene(scene(2, [2, 3]))).toBe(true);

    expect(texImage3D).toHaveBeenCalledTimes(allocations);
    expect(texSubImage3D).toHaveBeenCalledTimes(uploads + 2);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      virtualTextureRebuilds: 1,
      virtualTextureLayers: 3,
      evictions: 1,
    });
    renderer?.destroy();
  });

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

  it("enables the virtual texture path by default with an explicit diagnostic opt-out", () => {
    expect(contactTileGpuVirtualTextureEnabled("")).toBe(true);
    expect(contactTileGpuVirtualTextureEnabled("?cstudioVirtualTexture=1")).toBe(true);
    expect(contactTileGpuVirtualTextureEnabled("?cstudioVirtualTexture=0")).toBe(false);
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

  it("uploads cached R16F bits directly with HALF_FLOAT", () => {
    const { canvas, texImage2D } = mockWebGlCanvas();
    const values = new Uint16Array([
      0x3c00, 0xbc00, 0xbc00, 0xbc00,
      0xbc00, 0xbc00, 0xbc00, 0xbc00,
      0xbc00, 0xbc00, 0xbc00, 0xbc00,
      0xbc00, 0xbc00, 0xbc00, 0xbc00,
    ]);
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      texturePreference: "r16f",
      virtualTextureEnabled: false,
      performanceEnabled: false,
    });

    expect(renderer?.setScene({
      descriptors: [{
        key: "0:1:source",
        tile: {
          tileX: 0,
          tileY: 1,
          cells: [],
          denseR16fValues: values,
          denseOccupiedCount: 1,
        },
        transpose: false,
      }],
      resolution: 1_000,
      tileSizeBins: 4,
      viewport: { xStart: 0, xEnd: 4_000, yStart: 4_000, yEnd: 8_000 },
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);

    const upload = texImage2D.mock.calls.find((call) => call[2] === 29 && call[8] === values);
    expect(upload?.[7]).toBe(55);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      r16fUploads: 1,
      cacheBytes: values.byteLength,
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
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      virtualTextureEnabled: false,
    });
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
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      virtualTextureEnabled: false,
    });
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
      texImage3D,
      texSubImage2D,
      texSubImage3D,
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

  it("presents an updated virtual page table without waiting for another pointer frame", () => {
    const { canvas, blitFramebuffer } = mockWebGlCanvas();
    const frames = mockFrameScheduler();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      virtualTextureEnabled: true,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    const viewport = { xStart: 0, xEnd: 4_000, yStart: 0, yEnd: 4_000 };
    expect(renderer?.setScene({
      descriptors: [{
        key: "0:0:source",
        tile: { tileX: 0, tileY: 0, cells: [{ xBin: 1, yBin: 0, count: 9 }] },
        transpose: false,
      }],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
      visibleLayerComplete: true,
      viewport,
      renderStyle: {
        colormap: "Reds",
        colorScale: { log: false, min: 0, max: 10 },
      },
    })).toBe(true);
    renderer?.setPanViewport({ xStart: 500, xEnd: 4_500, yStart: 500, yEnd: 4_500 });
    const virtualDrawsBeforeAppend = renderer?.performanceSnapshot().virtualTextureDraws ?? 0;
    const blitsBeforeAppend = blitFramebuffer.mock.calls.length;

    const offDiagonalTile = {
      tileX: 0,
      tileY: 1,
      cells: [{ xBin: 1, yBin: 4, count: 6 }],
    };
    expect(renderer?.appendSceneDescriptors({
      descriptors: [{
        key: "0:1:source",
        tile: offDiagonalTile,
        transpose: false,
      }, {
        key: "1:0:mirror",
        tile: offDiagonalTile,
        transpose: true,
      }, {
        key: "1:1:source",
        tile: { tileX: 1, tileY: 1, cells: [{ xBin: 5, yBin: 4, count: 7 }] },
        transpose: false,
      }],
      generation: 7,
      resolution: 1_000,
      tileSizeBins: 4,
    })).toBe(true);
    expect(renderer?.presentAppendedSceneDescriptors()).toBe(true);
    frames.flushAll();
    expect(renderer?.performanceSnapshot().virtualTextureDraws)
      .toBe(virtualDrawsBeforeAppend + 1);
    expect(blitFramebuffer.mock.calls.length).toBe(blitsBeforeAppend + 1);
  });

  it("atomically promotes a fully prefetched pan scene with zero new tile uploads", () => {
    const {
      canvas,
      blitFramebuffer,
      clientHeightRead,
      clientWidthRead,
      drawArrays,
      texImage2D,
      texImage3D,
      texSubImage2D,
      texSubImage3D,
    } = mockWebGlCanvas();
    const frames = mockFrameScheduler();
    const renderer = createContactTileGpuRenderer(canvas, 4 * 1024 * 1024, {
      performanceEnabled: false,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
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
    const arrayAllocationsBeforePointer = texImage3D.mock.calls.length;
    const subUploadsBeforePointer = texSubImage2D.mock.calls.length;
    const arrayUploadsBeforePointer = texSubImage3D.mock.calls.length;
    const layoutReadsBeforePointer = clientWidthRead.mock.calls.length
      + clientHeightRead.mock.calls.length;
    frames.flushAll();
    renderer?.setPanViewport({ xStart: 4_000, xEnd: 8_000, yStart: 0, yEnd: 4_000 });
    expect(drawArrays).toHaveBeenCalledTimes(drawsBeforePrefetch + 1);
    expect(blitFramebuffer).toHaveBeenCalledTimes(presentationsBeforePrefetch + 1);
    // The upload frame publishes one compact page table after the atlas layer
    // becomes resident; pointer sampling itself performs no texture upload.
    expect(texImage2D).toHaveBeenCalledTimes(imageUploadsBeforePointer + 1);
    expect(texSubImage2D).toHaveBeenCalledTimes(subUploadsBeforePointer);
    expect(texImage3D).toHaveBeenCalledTimes(arrayAllocationsBeforePointer);
    expect(texSubImage3D).toHaveBeenCalledTimes(arrayUploadsBeforePointer + 1);
    expect(clientWidthRead.mock.calls.length + clientHeightRead.mock.calls.length)
      .toBe(layoutReadsBeforePointer);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      virtualTextureDraws: 2,
      virtualTextureFallbacks: 1,
      virtualTexturePages: 2,
      virtualTextureLayers: 2,
    });

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
    const atlasUploadsBeforePromotion = texSubImage3D.mock.calls.length;
    const presentationsBeforePromotion = blitFramebuffer.mock.calls.length;

    expect(renderer?.promoteScene(targetScene)).toBe(true);
    expect(renderer?.performanceSnapshot()).toMatchObject({
      fullUploads: uploadsBeforePromotion,
      scenePromotions: 1,
      scenePromotionMisses: 0,
    });
    // Promotion updates only the tiny page table; resident atlas layers are
    // neither allocated nor uploaded again.
    expect(texImage2D).toHaveBeenCalledTimes(imageUploadsBeforePromotion + 1);
    expect(texSubImage3D).toHaveBeenCalledTimes(atlasUploadsBeforePromotion);
    expect(blitFramebuffer).toHaveBeenCalledTimes(presentationsBeforePromotion + 1);

    // React publishes the promoted frame after the imperative commit. The
    // child setScene call recognizes it and performs no second GPU paint.
    expect(renderer?.setScene(targetScene)).toBe(true);
    expect(texImage2D).toHaveBeenCalledTimes(imageUploadsBeforePromotion + 1);
    expect(texSubImage3D).toHaveBeenCalledTimes(atlasUploadsBeforePromotion);
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
