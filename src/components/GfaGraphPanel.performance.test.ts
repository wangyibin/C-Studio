import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { parseGfaText } from "../state/gfa";
import * as hic from "../state/gfaHiCLinks";
import * as evidence from "../state/gfaCurationEvidence";
import type { ContactMapLayoutBlock } from "../state/importers";
import { createInitialUiState } from "../state/uiState";
import { GfaGraphPanel } from "./GfaGraphPanel";

afterEach(() => vi.restoreAllMocks());

it("keeps the contact toggle available without computing hidden contact or review layers", () => {
  const layoutCheck = vi.spyOn(hic, "gfaHiCContactMapUsesLayout");
  const aggregate = vi.spyOn(hic, "buildLengthNormalizedGfaHiCLinks");
  const review = vi.spyOn(evidence, "buildGfaCurationIssues");
  const blocks: ContactMapLayoutBlock[] = ["a", "b"].map((id, i) => ({
    id, sourceId: id, objectId: "Chr01g1", sourceStart: 0, sourceEnd: 100,
    visualStart: i * 100, visualEnd: (i + 1) * 100, orientation: "+",
  }));
  const html = renderToStaticMarkup(createElement(GfaGraphPanel, {
    document: parseGfaText("S\ta\t*\tLN:i:100\nS\tb\t*\tLN:i:100\nL\ta\t+\tb\t+\t0M\n"),
    assemblyBlocks: blocks,
    contactMap: {
      resolution: 100, cells: [{ xBin: 0, yBin: 1, count: 10 }], layoutBlocks: blocks,
      viewport: { xStart: 0, xEnd: 200, yStart: 0, yEnd: 200 },
    },
    selectedAssemblyBlockIds: [],
    homologPattern: "(Chr\\d+)g(\\d+)",
    visibleScaffoldIds: new Set(["Chr01g1"]),
    visibleContigIds: new Set(["a", "b"]),
    chromosomeFilterActive: false,
    onClose: () => undefined,
    onSelectOccurrences: () => undefined,
    onUiAction: () => undefined,
    uiState: createInitialUiState("Ready"),
  }));
  expect(html).toContain("GFA Assembly Graph");
  const contactToggle = html.match(/<button[^>]*aria-label="Toggle endpoint 3D contact links"[^>]*>/)?.[0];
  expect(contactToggle).toBeDefined();
  expect(contactToggle).not.toContain("disabled");
  expect(layoutCheck).toHaveBeenCalledOnce();
  expect(aggregate).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
});
