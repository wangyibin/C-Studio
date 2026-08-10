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
    "/examples/input.1000.coverage.bedgraph",
    readFileSync(
      new URL("../../examples/input.1000.coverage.bedgraph", import.meta.url),
      "utf8",
    ),
  ],
  [
    "/examples/ref_vs_contig.paf",
    readFileSync(new URL("../../examples/ref_vs_contig.paf", import.meta.url), "utf8"),
  ],
]);

describe("loadBrowserExampleBundle", () => {
  it("loads assembly, coverage depth and PAF as one browser example", async () => {
    const requestedPaths: string[] = [];
    const bundle = await loadBrowserExampleBundle(async (path) => {
      requestedPaths.push(path);
      const body = exampleFiles.get(path);
      return new Response(body ?? "", { status: body === undefined ? 404 : 200 });
    });

    expect(requestedPaths).toEqual([
      "/examples/groups.agp",
      "/examples/input.1000.coverage.bedgraph",
      "/examples/ref_vs_contig.paf",
    ]);
    expect(bundle.dataset).toMatchObject({
      agp_path: "examples/groups.agp",
      mcool_path: "examples/input.q1.1k.cool",
      coverage_path: "examples/input.1000.coverage.bedgraph",
      paf_path: "examples/ref_vs_contig.paf",
      agp_lines: 2_576,
      agp_components: 1_298,
    });
    expect(bundle.coverageRecords).toHaveLength(48_298);
    expect(summarizePafText(bundle.pafText)).toMatchObject({
      alignmentCount: 1_304,
      queryCount: 1_298,
      targetCount: 5,
    });
  });

  it("fails the combined load when the example PAF is unavailable", async () => {
    await expect(
      loadBrowserExampleBundle(async (path) => {
        if (path === "/examples/ref_vs_contig.paf") {
          return new Response("", { status: 404 });
        }
        return new Response(exampleFiles.get(path) ?? "", { status: 200 });
      }),
    ).rejects.toThrow("Failed to load example PAF: 404");
  });
});
