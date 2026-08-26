import { describe, expect, it } from "vitest";
import { buildPafSyntenyPreview, summarizePafText } from "./pafPreview";

describe("buildPafSyntenyPreview", () => {
  it("builds preview blocks from PAF alignments", () => {
    const preview = buildPafSyntenyPreview(
      [
        "ctgA\t1000\t100\t500\t+\tchr1\t2000\t700\t1100\t380\t400\t60",
        "ctgB\t800\t0\t300\t-\tchr2\t1600\t50\t350\t280\t300\t42",
      ].join("\n"),
    );

    expect(preview.records).toHaveLength(2);
    expect(preview.records[0]).toMatchObject({
      queryName: "ctgA",
      targetName: "chr1",
      strand: "+",
      mapq: 60,
    });
    expect(preview.querySpan).toBe(1000);
    expect(preview.targetSpan).toBe(2000);
  });

  it("reports ignored invalid PAF lines", () => {
    const preview = buildPafSyntenyPreview("bad\tline\n\n# comment");

    expect(preview.records).toEqual([]);
    expect(preview.ignoredLines).toBe(1);
  });

  it("parses standard optional tags used for alignment confidence", () => {
    const preview = buildPafSyntenyPreview(
      "ctgA\t1000\t0\t900\t+\tchr1\t2000\t100\t1000\t850\t900\t60"
      + "\ttp:A:P\tNM:i:50\tcg:Z:850M50I\tcs:Z::850+ac",
    );

    expect(preview.records[0]).toMatchObject({
      alignmentType: "primary",
      editDistance: 50,
      cigar: "850M50I",
      differenceString: ":850+ac",
    });
  });

  it("summarizes imported PAF text", () => {
    expect(
      summarizePafText(
        [
          "ctgA\t1000\t100\t500\t+\tchr1\t2000\t700\t1100\t380\t400\t60",
          "bad\tline",
          "# comment",
        ].join("\n"),
      ),
    ).toEqual({
      alignmentCount: 1,
      ignoredLines: 1,
      queryCount: 1,
      targetCount: 1,
    });
  });
});
