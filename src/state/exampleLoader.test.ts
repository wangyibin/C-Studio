// @ts-expect-error Vitest executes this test in Node; the app tsconfig intentionally omits Node globals.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBrowserExampleBundle } from "../App";
import { summarizePafText } from "./pafPreview";

const exampleFiles = new Map([
  [
    "/examples/groups.agp",
    readFileSync(new URL("../../examples/groups.agp", import.meta.url), "utf8"),
  ],
  [
    "/examples/hifi.asm.bp.p_utg.noseq.depth",
    readFileSync(
      new URL("../../examples/hifi.asm.bp.p_utg.noseq.depth", import.meta.url),
      "utf8",
    ),
  ],
  [
    "/examples/mono.hifi.asm.bp.p_utg.paf",
    readFileSync(new URL("../../examples/mono.hifi.asm.bp.p_utg.paf", import.meta.url), "utf8"),
  ],
  [
    "/examples/hifi.asm.bp.p_utg.noseq.gfa",
    readFileSync(new URL("../../examples/hifi.asm.bp.p_utg.noseq.gfa", import.meta.url), "utf8"),
  ],
]);

describe("loadBrowserExampleBundle", () => {
  it("loads assembly, contact metadata, coverage depth, PAF and GFA as one browser example", async () => {
    const requestedPaths: string[] = [];
    const bundle = await loadBrowserExampleBundle(async (path) => {
      requestedPaths.push(path);
      const body = exampleFiles.get(path);
      return new Response(body ?? "", { status: body === undefined ? 404 : 200 });
    });

    expect(requestedPaths).toEqual([
      "/examples/groups.agp",
      "/examples/hifi.asm.bp.p_utg.noseq.depth",
      "/examples/mono.hifi.asm.bp.p_utg.paf",
      "/examples/hifi.asm.bp.p_utg.noseq.gfa",
    ]);
    expect(bundle.dataset).toMatchObject({
      agp_path: "examples/groups.agp",
      mcool_path: "examples/input.1k.cool",
      coverage_path: "examples/hifi.asm.bp.p_utg.noseq.depth",
      paf_path: "examples/mono.hifi.asm.bp.p_utg.paf",
      agp_lines: 1_177,
      agp_components: 798,
    });
    expect(bundle.coverageRecords).toHaveLength(40_633);
    expect(summarizePafText(bundle.pafText)).toMatchObject({
      alignmentCount: 825,
      queryCount: 819,
      targetCount: 5,
    });
    expect(bundle.gfaDocument.summary).toMatchObject({
      segmentCount: 887,
      aRecordCount: 28_840,
    });
  });

  it("fails the combined load when the example PAF is unavailable", async () => {
    await expect(
      loadBrowserExampleBundle(async (path) => {
        if (path === "/examples/mono.hifi.asm.bp.p_utg.paf") {
          return new Response("", { status: 404 });
        }
        return new Response(exampleFiles.get(path) ?? "", { status: 200 });
      }),
    ).rejects.toThrow("Failed to load example PAF: 404");
  });
});
