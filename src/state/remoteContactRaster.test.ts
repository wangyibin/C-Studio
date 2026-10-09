import { afterEach, describe, expect, it, vi } from "vitest";
import { drawRemoteRaster, loadRemoteRaster, remoteRasterSize } from "./remoteContactRaster";
import { rememberRemoteContactSource, forgetRemoteContactSource, remoteContactIdentifier, usesRemoteRendering } from "./remoteContact";

const datasetUrl = "http://localhost:8787/v1/datasets/test";
const path = remoteContactIdentifier(datasetUrl, "mcool");
const viewport = { xStart: 0, yStart: 0, xEnd: 40, yEnd: 40 };
const input = { path, layoutBlocks: [], viewport, sourceResolution: 10, width: 4, height: 4,
  normalization: "raw" as const, colormap: "Reds" as const,
  colorScale: { min: 0, max: 10, auto: false, log: false } };
afterEach(() => { forgetRemoteContactSource(path); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  rememberRemoteContactSource(path, { datasetUrl, bearerToken: "secret", serverRendering: true });
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:frame");
  vi.stubGlobal("Image", class {
    src = ""; naturalWidth = 4; naturalHeight = 4;
    decode = async () => {};
  });
  return revoke;
}
function response() {
  return new Response(new Blob(["png fixture"]), { headers: {
    "content-type": "image/png", "x-cstudio-resolution": "10", "x-cstudio-scale-max": "10",
  } });
}

describe("remote raster transport and presentation", () => {
  it("bounds decoded frame memory even on large or invalid displays", () => {
    for (const [w, h] of [[8000, 6000], [1, 9000], [NaN, 0], [1024, 1024]]) {
      const size = remoteRasterSize(w, h);
      expect(size.width * size.height).toBeLessThanOrEqual(1_048_576);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048);
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(1);
    }
  });
  it("negotiates capabilities and releases session state", () => {
    expect(usesRemoteRendering(path)).toBe(false);
    setup(); expect(usesRemoteRendering(path)).toBe(true);
    forgetRemoteContactSource(path); expect(usesRemoteRendering(path)).toBe(false);
  });
  it("requests an authenticated PNG without retaining matrix payloads and revokes the blob URL", async () => {
    const revoke = setup();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({layoutId:"v1"}))).mockResolvedValue(response()); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const map = await loadRemoteRaster(input, controller.signal);
    expect(fetch.mock.calls[0][0]).toBe(`${datasetUrl}/layouts`);
    expect(fetch.mock.calls[1][0]).toBe(`${datasetUrl}/render`);
    const options = fetch.mock.calls[1][1];
    expect(JSON.parse(options.body).layoutId).toBe("v1");
    expect(JSON.parse(options.body).layoutBlocks).toBeUndefined();
    expect(options.headers.Authorization).toBe("Bearer secret");
    expect(options.signal).toBe(controller.signal);
    expect(JSON.parse(options.body).colorLut).toHaveLength(1024);
    expect(map.cells).toEqual([]); expect(map.tiles).toBeUndefined();
    expect(map.raster?.image).toBeDefined();
    expect(revoke).toHaveBeenCalledWith("blob:frame");
  });
  it("releases URLs after decode errors", async () => {
    const revoke = setup();
    vi.stubGlobal("Image", class { src = ""; decode = async () => { throw new Error("bad PNG"); }; });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({layoutId:"v1"}))).mockResolvedValue(response()));
    await expect(loadRemoteRaster(input, new AbortController().signal)).rejects.toThrow("bad PNG");
    expect(revoke).toHaveBeenCalledOnce();
  });
  it("rejects an aborted late response before allocating a displayed image", async () => {
    const revoke = setup(); const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { controller.abort(); return response(); }));
    await expect(loadRemoteRaster(input, controller.signal)).rejects.toThrow();
    expect(revoke).not.toHaveBeenCalled();
  });
  it("keeps immutable image coordinates when the live viewport pans", () => {
    const context = { save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      drawImage: vi.fn(), restore: vi.fn() };
    const image = {} as HTMLImageElement;
    drawRemoteRaster(context as unknown as CanvasRenderingContext2D, { image, viewport, scaleMax: 10 },
      { ...viewport, xStart: 10, xEnd: 50 }, 100, 100, 400, 400);
    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 100, 400, 400);
    expect(context.clip).toHaveBeenCalledOnce();
    expect(context.restore).toHaveBeenCalledOnce();
  });
});

describe("remote pan margins", () => {
  it("reuses an interior pan but not a viewport outside the prefetched image", async () => {
    const {remotePanRequest, remoteRasterCovers} = await import("./remoteContactRaster");
    const frame = remotePanRequest({xStart:100, xEnd:500, yStart:100, yEnd:500}, 400, 400, 1000);
    expect(frame).toEqual({viewport:{xStart:0,xEnd:600,yStart:0,yEnd:600},width:600,height:600});
    expect(remoteRasterCovers(frame.viewport,{xStart:150,xEnd:550,yStart:150,yEnd:550})).toBe(true);
    expect(remoteRasterCovers(frame.viewport,{xStart:250,xEnd:650,yStart:150,yEnd:550})).toBe(false);
  });
  it("clips assembly boundaries and keeps expanded images within the memory limit", async () => {
    const {remotePanRequest} = await import("./remoteContactRaster");
    const frame = remotePanRequest({xStart:0,xEnd:900,yStart:800,yEnd:1000}, 4000, 3000, 1000);
    expect(frame.viewport).toEqual({xStart:0,xEnd:900,yStart:800,yEnd:1000});
    expect(frame.width*frame.height).toBeLessThanOrEqual(1_048_576);
  });
});
