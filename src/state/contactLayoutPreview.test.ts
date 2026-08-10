import { describe, expect, it } from "vitest";
import type { ContactMapLayoutBlock } from "./importers";
import {
  buildContactLayoutRasterPlan,
  contactLayoutRasterPlanCoversViewport,
  contactLayoutRasterSlice,
} from "./contactLayoutPreview";

const previousBlocks: ContactMapLayoutBlock[] = [
  {
    id: "chr1:1:a",
    objectId: "chr1",
    sourceId: "a",
    sourceStart: 0,
    sourceEnd: 100,
    visualStart: 0,
    visualEnd: 100,
    orientation: "+",
  },
  {
    id: "chr1:2:b",
    objectId: "chr1",
    sourceId: "b",
    sourceStart: 0,
    sourceEnd: 150,
    visualStart: 100,
    visualEnd: 250,
    orientation: "-",
  },
  {
    id: "chr2:1:c",
    objectId: "chr2",
    sourceId: "c",
    sourceStart: 0,
    sourceEnd: 50,
    visualStart: 250,
    visualEnd: 300,
    orientation: "+",
  },
];

describe("contact layout raster preview", () => {
  it("builds stable axis strips for a move without touching contact cells", () => {
    const moved = [
      previousBlocks[0],
      { ...previousBlocks[2], visualStart: 100, visualEnd: 150 },
      { ...previousBlocks[1], visualStart: 150, visualEnd: 300 },
    ];

    expect(buildContactLayoutRasterPlan(previousBlocks, moved)).toEqual({
      changesPixels: true,
      segments: [
        { sourceStart: 0, sourceEnd: 100, targetStart: 0, targetEnd: 100, flipped: false },
        { sourceStart: 100, sourceEnd: 250, targetStart: 150, targetEnd: 300, flipped: false },
        { sourceStart: 250, sourceEnd: 300, targetStart: 100, targetEnd: 150, flipped: false },
      ],
    });
  });

  it("marks each reversed source strip for a raster mirror", () => {
    const reversed = [
      previousBlocks[0],
      { ...previousBlocks[2], visualStart: 100, visualEnd: 150, orientation: "-" as const },
      { ...previousBlocks[1], visualStart: 150, visualEnd: 300, orientation: "+" as const },
    ];
    const plan = buildContactLayoutRasterPlan(previousBlocks, reversed);

    expect(plan?.changesPixels).toBe(true);
    expect(plan?.segments.map((segment) => segment.flipped)).toEqual([false, true, true]);
  });

  it("keeps metadata-only changes compatible without showing a pixel preview", () => {
    const relabeled = previousBlocks.map((block) => ({ ...block, objectId: "new-chromosome" }));

    expect(buildContactLayoutRasterPlan(previousBlocks, relabeled)?.changesPixels).toBe(false);
  });

  it("rejects split, copy, and changed source intervals", () => {
    expect(buildContactLayoutRasterPlan(previousBlocks, previousBlocks.slice(0, 2))).toBeNull();
    expect(buildContactLayoutRasterPlan(previousBlocks, [
      { ...previousBlocks[0], sourceEnd: 90, visualEnd: 90 },
      previousBlocks[1],
      previousBlocks[2],
    ])).toBeNull();
  });

  it("does not preview data moved into the viewport from outside the source raster", () => {
    const moved = [
      previousBlocks[0],
      { ...previousBlocks[2], visualStart: 100, visualEnd: 150 },
      { ...previousBlocks[1], visualStart: 150, visualEnd: 300 },
    ];
    const plan = buildContactLayoutRasterPlan(previousBlocks, moved);

    expect(plan).not.toBeNull();
    expect(contactLayoutRasterPlanCoversViewport(plan!, 0, 300)).toBe(true);
    expect(contactLayoutRasterPlanCoversViewport(plan!, 0, 200)).toBe(false);
  });

  it("maps and clips a flipped strip in raster coordinates", () => {
    expect(contactLayoutRasterSlice(
      {
        sourceStart: 100,
        sourceEnd: 200,
        targetStart: 300,
        targetEnd: 400,
        flipped: true,
      },
      150,
      400,
      250,
    )).toEqual({
      sourceStartPx: 0,
      sourceEndPx: 50,
      targetStartPx: 150,
      targetEndPx: 200,
      flipped: true,
    });
  });
});
