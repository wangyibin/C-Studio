import { describe, expect, it, vi } from "vitest";
import { RemoteRasterFlight } from "./remoteRasterFlight";

const viewport = { xStart: 10, xEnd: 20, yStart: 10, yEnd: 20 };
const imageViewport = { xStart: 0, xEnd: 30, yStart: 0, yEnd: 30 };
const outside = { xStart: 40, xEnd: 50, yStart: 40, yEnd: 50 };

describe("remote pan image flight", () => {
  it("hands the pending preview request to pointer-up without a second fetch", async () => {
    const flight = new RemoteRasterFlight<string>();
    let finish!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const input = { key: "raw|500k", layout: {}, viewport, imageViewport, preview: true, load };
    const pending = flight.request(input);
    const settled = flight.request({ ...input, preview: false, viewport: { ...viewport, xEnd: 25 } });
    expect(settled).toBe(pending);
    expect(load).toHaveBeenCalledTimes(1);
    finish("pixels");
    expect(await settled).toBe("pixels");
    expect(flight.request({ ...input, preview: false })).toBe(pending);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("bounds preview work and lets an uncovered settled camera replace it", () => {
    const flight = new RemoteRasterFlight<string>();
    let signal!: AbortSignal;
    const load = vi.fn((s: AbortSignal) => { signal = s; return new Promise<string>(() => {}); });
    const input = { key: "raw", layout: {}, viewport, imageViewport, preview: true, load };
    flight.request(input);
    const oldSignal = signal;
    expect(flight.request({ ...input, viewport: outside })).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    flight.request({ ...input, viewport: outside, imageViewport: outside, preview: false });
    expect(oldSignal.aborted).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(["layout", "style"])("invalidates an image after a %s change", async (change) => {
    const flight = new RemoteRasterFlight<string>();
    const load = vi.fn(async () => "pixels");
    const input = { key: "raw", layout: {}, viewport, imageViewport, preview: true, load };
    await flight.request(input);
    await flight.request({ ...input, ...(change === "layout" ? { layout: {} } : { key: "ice" }) });
    expect(load).toHaveBeenCalledTimes(2);
    flight.clear();
    await flight.request(input);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("retries a failed preview when the camera settles", async () => {
    const flight = new RemoteRasterFlight<string>();
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("pixels");
    const input = { key: "raw", layout: {}, viewport, imageViewport, preview: true, load };
    await expect(flight.request(input)).rejects.toThrow("offline");
    await expect(flight.request({ ...input, preview: false })).resolves.toBe("pixels");
  });
});
