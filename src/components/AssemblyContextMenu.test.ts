import { describe, expect, it } from "vitest";

import type { ContactMapLayoutBlock } from "../state/importers";
import {
  assemblyDeleteCopyStatus,
  fitContextMenuToViewport,
} from "./AssemblyContextMenu";

describe("fitContextMenuToViewport", () => {
  const menu = { width: 198, height: 256 };
  const viewport = { width: 1_000, height: 700 };

  it("opens below and to the right when there is enough space", () => {
    expect(fitContextMenuToViewport({ x: 100, y: 120 }, menu, viewport)).toEqual({
      x: 108,
      y: 128,
    });
  });

  it("flips to the left and above near the viewport edges", () => {
    expect(fitContextMenuToViewport({ x: 990, y: 690 }, menu, viewport)).toEqual({
      x: 784,
      y: 426,
    });
  });

  it("keeps the menu inside the viewport margin at every corner", () => {
    expect(fitContextMenuToViewport({ x: 0, y: 0 }, menu, viewport)).toEqual({
      x: 8,
      y: 8,
    });
  });

  it("distinguishes an only copy from one selected copy of an exact source interval", () => {
    const blocks: ContactMapLayoutBlock[] = [
      {
        id: "Chr01:a",
        objectId: "Chr01",
        sourceId: "utg1",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 0,
        visualEnd: 50,
        orientation: "+",
      },
      {
        id: "Chr02:a",
        objectId: "Chr02",
        sourceId: "utg1",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 50,
        visualEnd: 100,
        orientation: "+",
      },
      {
        id: "debris:a",
        objectId: "debris",
        sourceId: "utg1",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 100,
        visualEnd: 150,
        orientation: "-",
      },
      {
        id: "Chr01:b",
        objectId: "Chr01",
        sourceId: "utg1",
        sourceStart: 50,
        sourceEnd: 100,
        visualStart: 150,
        visualEnd: 200,
        orientation: "+",
      },
    ];

    expect(assemblyDeleteCopyStatus(blocks, new Set(["Chr01:a"]), blocks[0]!)).toEqual({
      totalCopies: 3,
      selectedCopies: 1,
      remainingCopies: 2,
    });
    expect(assemblyDeleteCopyStatus(blocks, new Set(["Chr01:b"]), blocks[3]!)).toEqual({
      totalCopies: 1,
      selectedCopies: 1,
      remainingCopies: 0,
    });
    expect(assemblyDeleteCopyStatus(
      blocks,
      new Set(["Chr01:a", "Chr02:a", "debris:a"]),
      blocks[0]!,
    )).toEqual({
      totalCopies: 3,
      selectedCopies: 3,
      remainingCopies: 0,
    });
  });

  it("treats two split segments as one copy when their union covers the interval", () => {
    const blocks: ContactMapLayoutBlock[] = [
      {
        id: "Chr01:1:utg1",
        objectId: "Chr01",
        sourceId: "utg1",
        sourceStart: 0,
        sourceEnd: 100,
        visualStart: 0,
        visualEnd: 100,
        orientation: "+",
      },
      {
        id: "Chr02:1:utg1_d2:left",
        objectId: "Chr02",
        sourceId: "utg1",
        sourceStart: 0,
        sourceEnd: 50,
        visualStart: 100,
        visualEnd: 150,
        orientation: "+",
      },
      {
        id: "Chr02:1:utg1_d2:right",
        objectId: "Chr02",
        sourceId: "utg1",
        sourceStart: 50,
        sourceEnd: 100,
        visualStart: 150,
        visualEnd: 200,
        orientation: "+",
      },
    ];

    expect(assemblyDeleteCopyStatus(
      blocks,
      new Set(["Chr02:1:utg1_d2:left"]),
      blocks[1]!,
    )).toEqual({
      totalCopies: 2,
      selectedCopies: 1,
      remainingCopies: 1,
    });
    expect(assemblyDeleteCopyStatus(
      blocks,
      new Set(["Chr01:1:utg1"]),
      blocks[0]!,
    )).toEqual({
      totalCopies: 2,
      selectedCopies: 1,
      remainingCopies: 1,
    });
  });
});
