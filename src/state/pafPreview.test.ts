import { describe, expect, it } from "vitest";
import { buildPafSyntenyPreview, summarizePafText } from "./pafPreview";

describe("buildPafSyntenyPreview", () => {
  it("builds preview blocks from PAF alignments", () => {
    const preview = buildPafSyntenyPreview(
      [
        "ctgA\t2000\t100\t1300\t+\tchr1\t3000\t700\t1900\t1140\t1200\t60",
        "ctgB\t1800\t0\t1100\t-\tchr2\t2600\t50\t1150\t1000\t1100\t42",
      ].join("\n"),
      1_000,
    );

    expect(preview.records).toHaveLength(2);
    expect(preview.records[0]).toMatchObject({
      queryName: "ctgA",
      targetName: "chr1",
      strand: "+",
      mapq: 60,
    });
    expect(preview.querySpan).toBe(2000);
    expect(preview.targetSpan).toBe(3000);
  });

  it("reports ignored invalid PAF lines", () => {
    const preview = buildPafSyntenyPreview("bad\tline\n\n# comment");

    expect(preview.records).toEqual([]);
    expect(preview.ignoredLines).toBe(1);
  });

  it("parses standard optional tags used for alignment confidence", () => {
    const preview = buildPafSyntenyPreview(
      "ctgA\t2000\t0\t1200\t+\tchr1\t3000\t100\t1300\t1150\t1200\t60"
      + "\ttp:A:P\tNM:i:50\tcg:Z:1150M50I\tcs:Z::1150+ac",
      1_000,
    );

    expect(preview.records[0]).toMatchObject({
      alignmentType: "primary",
      editDistance: 50,
      cigar: "1150M50I",
      differenceString: ":1150+ac",
    });
  });

  it("summarizes imported PAF text", () => {
    expect(
      summarizePafText(
        [
          "ctgA\t20000\t1000\t13000\t+\tchr1\t30000\t7000\t19000\t11400\t12000\t60",
          "bad\tline",
          "# comment",
        ].join("\n"),
      ),
    ).toEqual({
      alignmentCount: 1,
      ignoredLines: 1,
      queryCount: 1,
      targetCount: 1,
      chainCount: 1,
      discardedAlignmentCount: 0,
    });
  });

  it("uses short collinear fragments to extend the best split chain after LIS", () => {
    const preview = buildPafSyntenyPreview([
      "ctgA\t10000\t0\t2000\t+\tchr1\t20000\t1000\t3000\t1900\t2000\t60\ttp:A:P",
      "ctgA\t10000\t1900\t4000\t+\tchr1\t20000\t2900\t5000\t1850\t2000\t50\ttp:A:P",
      "ctgA\t10000\t4500\t4700\t+\tchr1\t20000\t6000\t6200\t180\t200\t60\ttp:A:P",
      "ctgA\t10000\t0\t1500\t-\tchr1\t20000\t15000\t16500\t1400\t1500\t60\ttp:A:S",
    ].join("\n"), 1_000);

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      queryName: "ctgA",
      queryStart: 0,
      queryEnd: 4700,
      targetName: "chr1",
      targetStart: 1000,
      targetEnd: 6200,
      strand: "+",
      residueMatches: 3842,
      alignmentBlockLen: 4105,
      alignmentCount: 3,
    });
    expect(preview.records[0].fragments).toHaveLength(3);
    expect(preview.inputAlignmentCount).toBe(4);
    expect(preview.retainedAlignmentCount).toBe(3);
    expect(preview.discardedAlignmentCount).toBe(1);
  });

  it("keeps one best target per overlapping query interval", () => {
    const preview = buildPafSyntenyPreview([
      "ctgA\t10000\t0\t3000\t+\tchr1\t20000\t1000\t4000\t2850\t3000\t10",
      "ctgA\t10000\t1000\t2000\t+\tchr2\t20000\t5000\t6000\t900\t1000\t60",
    ].join("\n"), 1_000);

    expect(preview.records).toHaveLength(2);
    expect(preview.records.find((record) => record.targetName === "chr1")?.fragments).toEqual([
      expect.objectContaining({ queryStart: 0, queryEnd: 1000 }),
      expect.objectContaining({ queryStart: 2000, queryEnd: 3000 }),
    ]);
    expect(preview.records.find((record) => record.targetName === "chr2")?.fragments).toEqual([
      expect.objectContaining({ queryStart: 1000, queryEnd: 2000 }),
    ]);
  });

  it("removes sub-10 kb chains after LIS before interval arbitration", () => {
    const preview = buildPafSyntenyPreview([
      "ctgA\t100000\t0\t10000\t+\tchr1\t200000\t10000\t20000\t9500\t10000\t10",
      "ctgA\t100000\t0\t9000\t+\tchr2\t200000\t50000\t59000\t8900\t9000\t60",
    ].join("\n"));

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0].targetName).toBe("chr1");
    expect(preview.retainedAlignmentCount).toBe(1);
    expect(preview.discardedAlignmentCount).toBe(1);
  });

  it("retains a chain whose short collinear fragments sum to at least 10 kb", () => {
    const preview = buildPafSyntenyPreview([
      "ctgA\t100000\t0\t4000\t+\tchr1\t200000\t10000\t14000\t3800\t4000\t60",
      "ctgA\t100000\t5000\t9000\t+\tchr1\t200000\t15000\t19000\t3700\t4000\t60",
      "ctgA\t100000\t10000\t14000\t+\tchr1\t200000\t20000\t24000\t3600\t4000\t60",
    ].join("\n"));

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0]).toMatchObject({
      queryStart: 0,
      queryEnd: 14_000,
      targetStart: 10_000,
      targetEnd: 24_000,
      alignmentCount: 3,
    });
    expect(preview.records[0].fragments).toHaveLength(3);
    expect(preview.retainedAlignmentCount).toBe(3);
    expect(preview.discardedAlignmentCount).toBe(0);
  });

  it("allows disjoint query intervals to map to different targets", () => {
    const preview = buildPafSyntenyPreview([
      "ctgA\t10000\t0\t1000\t+\tchr1\t20000\t1000\t2000\t950\t1000\t20",
      "ctgA\t10000\t2000\t3000\t+\tchr2\t20000\t5000\t6000\t900\t1000\t60",
    ].join("\n"), 1_000);

    expect(preview.records.map((record) => [
      record.targetName,
      record.queryStart,
      record.queryEnd,
    ])).toEqual([
      ["chr1", 0, 1000],
      ["chr2", 2000, 3000],
    ]);
  });

  it("applies HapHiC-style global chain support before interval arbitration", () => {
    const preview = buildPafSyntenyPreview([
      "ctgA\t20000\t0\t5000\t+\tchr1\t30000\t0\t5000\t4800\t5000\t60",
      "ctgA\t20000\t5000\t10000\t+\tchr1\t30000\t5000\t10000\t4700\t5000\t60",
      "ctgA\t20000\t12000\t13900\t+\tchr2\t30000\t1000\t2900\t1800\t1900\t60",
      "ctgA\t20000\t15000\t17000\t+\tchr3\t30000\t2000\t4000\t1900\t2000\t60",
    ].join("\n"), 1_000);

    expect(preview.records.map((record) => record.targetName)).toEqual(["chr1", "chr3"]);
    expect(preview.retainedAlignmentCount).toBe(3);
    expect(preview.discardedAlignmentCount).toBe(1);
  });

  it("chains reverse-strand splits in decreasing target order", () => {
    const preview = buildPafSyntenyPreview([
      "ctgA\t10000\t0\t2000\t-\tchr1\t20000\t8000\t10000\t1900\t2000\t60",
      "ctgA\t10000\t2000\t4000\t-\tchr1\t20000\t6000\t8000\t1850\t2000\t50",
    ].join("\n"), 1_000);

    expect(preview.records[0]).toMatchObject({
      queryStart: 0,
      queryEnd: 4000,
      targetStart: 6000,
      targetEnd: 10000,
      strand: "-",
      alignmentCount: 2,
    });
  });
});
