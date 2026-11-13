import { describe, expect, it, vi } from "vitest";
import { coveragePanTransform, createCoveragePanLoader } from "./coveragePan";
import type { CoverageView, CoverageViewportLoader } from "./coverageView";

const viewport = (start: number) => ({ xStart: start, xEnd: start + 100, yStart: 0, yEnd: 100 });
const base: CoverageView = { resolution: 10, viewport: viewport(100), bins: [] };
const viewFor = (request: Parameters<CoverageViewportLoader>[0]): CoverageView => ({
  resolution: request.displayResolution, viewport: request.viewport, bins: [],
});
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("live coverage panning", () => {
  it("aligns an overscanned track with the heatmap without moving the depth axis", () => {
    expect(coveragePanTransform(viewport(100), viewport(125))).toEqual({
      width: "100%", transform: "translateX(-25%)",
    });
    expect(coveragePanTransform({ ...viewport(50), xEnd: 250 }, viewport(125))).toEqual({
      width: "200%", transform: "translateX(-37.5%)",
    });
    expect(coveragePanTransform(viewport(100), { ...viewport(100), yStart: 500, yEnd: 600 })).toEqual({
      width: "100%", transform: "translateX(0%)",
    });
  });

  it("reuses coverage and its read-ahead margin during continuous movement", async () => {
    const load = vi.fn(async (request: Parameters<CoverageViewportLoader>[0]) => viewFor(request));
    const publish = vi.fn();
    const loader = createCoveragePanLoader(load, publish);
    loader.request({ ...base.viewport, yStart: 500, yEnd: 600 }, base);
    expect(load).not.toHaveBeenCalled();
    loader.request(viewport(110), base);
    await settle();
    expect(publish).toHaveBeenCalledOnce();
    for (let start = 111; start <= 150; start++) loader.request(viewport(start), base);
    expect(load).toHaveBeenCalledOnce();
    expect(load.mock.calls[0][0].viewport).toMatchObject({ xStart: 60, xEnd: 260 });
    loader.dispose();
  });

  it("keeps one active read and only the latest pending camera", async () => {
    const reads: Array<{ request: Parameters<CoverageViewportLoader>[0]; finish: (view: CoverageView) => void }> = [];
    const load: CoverageViewportLoader = request => new Promise(resolve => reads.push({ request, finish: resolve }));
    const publish = vi.fn();
    const loader = createCoveragePanLoader(load, publish);
    loader.request(viewport(300), base);
    for (let start = 500; start <= 900; start += 10) loader.request(viewport(start), base);
    expect(reads).toHaveLength(1);
    reads[0].finish(viewFor(reads[0].request));
    await settle();
    expect(publish).not.toHaveBeenCalled(); // obsolete read is outside the live view
    expect(reads).toHaveLength(2);
    expect(reads[1].request.viewport).toMatchObject({ xStart: 850, xEnd: 1_050 });
    reads[1].finish(viewFor(reads[1].request));
    await settle();
    expect(publish).toHaveBeenCalledOnce();
    loader.dispose();
  });

  it.each(["cancel", "dispose"] as const)("rejects late data and queued work after %s", async (action) => {
    let finish!: (view: CoverageView) => void;
    const load = vi.fn(() => new Promise<CoverageView>(resolve => { finish = resolve; }));
    const publish = vi.fn();
    const loader = createCoveragePanLoader(load, publish);
    loader.request(viewport(300), base);
    loader.request(viewport(350), base);
    loader[action]();
    finish({ ...base, viewport: { ...viewport(250), xEnd: 500 } });
    await settle();
    expect(publish).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
    loader.dispose();
  });
});
