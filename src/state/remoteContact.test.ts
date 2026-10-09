import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetRemoteContactSource,
  isRemoteContactPath,
  isRemoteContactServiceUrl,
  loadRemoteContactMetadata,
  loadRemoteContactTiles,
  normalizeRemoteDatasetUrl,
  normalizeRemoteSourceUrl,
  rememberRemoteContactSource,
  remoteContactIdentifier,
} from "./remoteContact";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote contact dataset URLs", () => {
  it("adds HTTP when the remote address omits a protocol", () => {
    expect(normalizeRemoteSourceUrl("localhost:2222/")).toBe("http://localhost:2222/");
    expect(normalizeRemoteSourceUrl("host.example/project/input.mcool"))
      .toBe("http://host.example/project/input.mcool");
    expect(normalizeRemoteSourceUrl("https://host.example/project/#view"))
      .toBe("https://host.example/project/");
    expect(normalizeRemoteDatasetUrl("localhost:2222/v1/datasets/alfalfa"))
      .toBe("http://localhost:2222/v1/datasets/alfalfa");
  });

  it("normalizes dataset, metadata, and synthetic contact URLs", () => {
    const expected = "https://contact.example.org/v1/datasets/alfalfa";
    expect(normalizeRemoteDatasetUrl(`${expected}/`)).toBe(expected);
    expect(normalizeRemoteDatasetUrl(`${expected}/metadata?ignored=1`)).toBe(expected);
    expect(normalizeRemoteDatasetUrl(`${expected}/contact.mcool`)).toBe(expected);
  });

  it("rejects file URLs, embedded credentials, and non-dataset endpoints", () => {
    expect(() => normalizeRemoteDatasetUrl("file:///tmp/example.mcool")).toThrow(/HTTP/);
    expect(() => normalizeRemoteDatasetUrl("https://user:pass@example.org/v1/datasets/a"))
      .toThrow(/bearer token/);
    expect(() => normalizeRemoteDatasetUrl("https://example.org/example.mcool"))
      .toThrow(/v1\/datasets/);
  });

  it("distinguishes tile-service endpoints from downloadable project and file URLs", () => {
    expect(isRemoteContactServiceUrl(
      "https://contact.example.org/v1/datasets/alfalfa",
    )).toBe(true);
    expect(isRemoteContactServiceUrl(
      "https://contact.example.org/v1/datasets/alfalfa/metadata",
    )).toBe(true);
    expect(isRemoteContactServiceUrl(
      "localhost:2222/v1/datasets/alfalfa",
    )).toBe(true);
    expect(isRemoteContactServiceUrl("http://localhost:2222/")).toBe(false);
    expect(isRemoteContactServiceUrl("http://localhost:2222/input.mcool")).toBe(false);
  });

  it("uses a synthetic extension so the existing resolution behavior stays compatible", () => {
    const identifier = remoteContactIdentifier(
      "https://contact.example.org/v1/datasets/alfalfa",
      "mcool",
    );
    expect(identifier).toBe(
      "https://contact.example.org/v1/datasets/alfalfa/contact.mcool",
    );
    expect(isRemoteContactPath(identifier)).toBe(true);
    expect(isRemoteContactPath("/local/example.mcool")).toBe(false);
  });

  it("loads and validates versioned service metadata", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      apiVersion: 1,
      id: "alfalfa",
      name: "alfalfa.mcool",
      format: "mcool",
      sizeBytes: 1024,
      availableResolutions: [1_000, 5_000],
      sources: [{ name: "Chr1", length: 100_000 }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadRemoteContactMetadata(
      "https://contact.example.org/v1/datasets/alfalfa",
      "secret",
    );

    expect(result.metadata.availableResolutions).toEqual([1_000, 5_000]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://contact.example.org/v1/datasets/alfalfa/metadata",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("sends only the server tile contract and keeps credentials in headers", async () => {
    const datasetUrl = "https://contact.example.org/v1/datasets/alfalfa";
    const identifier = remoteContactIdentifier(datasetUrl, "mcool");
    rememberRemoteContactSource(identifier, { datasetUrl, bearerToken: "secret" });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([67, 83, 84, 49]), {
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await loadRemoteContactTiles([{
      id: "block-1",
      objectId: "Chr1",
      visualStart: 0,
      visualEnd: 100_000,
      sourceId: "Chr1",
      sourceStart: 0,
      sourceEnd: 100_000,
      orientation: "+",
      componentType: "W",
    }], {
      requestId: 12,
      generation: 7,
      purpose: "visible",
      coolPath: identifier,
      baseResolution: 1_000,
      sourceResolution: 5_000,
      targetResolution: 5_000,
      tileSizeBins: 256,
      normalization: "raw",
      tiles: [{ tileX: 0, tileY: 0 }],
      adaptiveRefinement: true,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: "Bearer secret" }));
    expect(body).toEqual(expect.objectContaining({
      baseResolution: 1_000,
      sourceResolution: 5_000,
      targetResolution: 5_000,
      tileSizeBins: 256,
      normalization: "raw",
      tiles: [{ tileX: 0, tileY: 0 }],
    }));
    expect(body.layoutBlocks[0]).toEqual(expect.objectContaining({
      sourceId: "Chr1",
      sourceStart: 0,
      sourceEnd: 100_000,
      orientation: "+",
    }));
    expect(body).not.toHaveProperty("coolPath");
    expect(body).not.toHaveProperty("requestId");
    expect(body).not.toHaveProperty("generation");
    expect(body).not.toHaveProperty("purpose");
    expect(body).not.toHaveProperty("adaptiveRefinement");
    forgetRemoteContactSource(identifier);
  });
});

describe("remote assembly", () => {
  it("loads the authenticated dataset AGP without downloading the matrix", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({name:"groups.agp", text:"agp contents"})));
    vi.stubGlobal("fetch", fetchMock);
    const { loadRemoteAssembly } = await import("./remoteContact");
    expect(await loadRemoteAssembly("https://example.org/v1/datasets/a", "secret"))
      .toEqual({name:"groups.agp", text:"agp contents"});
    expect(fetchMock).toHaveBeenCalledWith("https://example.org/v1/datasets/a/assembly", {
      headers: {Authorization: "Bearer secret"},
    });
  });
  it("surfaces missing and invalid AGP responses", async () => {
    const { loadRemoteAssembly } = await import("./remoteContact");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":"No AGP"}', {status:404})));
    await expect(loadRemoteAssembly("https://example.org/v1/datasets/a")).rejects.toThrow("No AGP");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"name":"a.agp","text":""}')));
    await expect(loadRemoteAssembly("https://example.org/v1/datasets/a")).rejects.toThrow("empty or invalid");
  });
});
