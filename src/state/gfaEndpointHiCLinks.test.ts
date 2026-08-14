import { describe, expect, it } from "vitest";
import type { ContactMapLayoutBlock } from "./importers";
import type { GfaEndpointHiCLoadResult } from "./gfaEndpointHiC";
import type { GfaHiCLink } from "./gfaHiCLinks";
import {
  buildRankedGfaEndpointHiCLinks,
  defaultGfaEndpointHiCLinkLimit,
  gfaEndpointHiCPairCacheKey,
  normalizeGfaEndpointHiCLinkLimit,
  selectGfaEndpointHiCCandidates,
} from "./gfaEndpointHiCLinks";

function block(
  id: string,
  visualStart: number,
  orientation: ContactMapLayoutBlock["orientation"] = "+",
): ContactMapLayoutBlock {
  return {
    id,
    objectId: "Chr01g1",
    sourceId: id,
    sourceStart: 0,
    sourceEnd: 1_000_000,
    visualStart,
    visualEnd: visualStart + 1_000_000,
    orientation,
  };
}

function overviewLink(index: number, score = 100 - index): GfaHiCLink {
  return {
    id: `hic:u${index}:v${index}`,
    source: `u${index}`,
    target: `v${index}`,
    rawCount: score,
    normalizedCountPerMb2: score,
    lineWidth: 1,
  };
}

function readyResult(
  sourceBlockId: string,
  targetBlockId: string,
  score: number,
  sourceEndpoint: "left" | "right" = "right",
  targetEndpoint: "left" | "right" = "left",
  complete = true,
  otherQuadrants: Array<{
    sourceEndpoint: "left" | "right";
    targetEndpoint: "left" | "right";
    normalizedCountPerMb2: number;
  }> = [],
): GfaEndpointHiCLoadResult {
  const bestQuadrant = {
    sourceEndpoint,
    targetEndpoint,
    rawCount: score / 10,
    normalizedCountPerMb2: score,
  };
  return {
    status: "ready",
    evidence: {
      sourceBlockId,
      targetBlockId,
      resolution: 10_000,
      normalization: "raw",
      sourceWindowBp: 250_000,
      targetWindowBp: 250_000,
      quadrants: [
        bestQuadrant,
        ...otherQuadrants.map((quadrant) => ({
          ...quadrant,
          rawCount: quadrant.normalizedCountPerMb2 / 10,
        })),
      ],
      bestQuadrant,
      contrastToNext: 2,
      observedCellCount: 4,
      complete,
      missingTileCount: complete ? 0 : 1,
    },
  };
}

describe("GFA endpoint Hi-C link overlay", () => {
  it("defaults to Top 1 per endpoint and screens partners fairly for every contig", () => {
    const contigs = Array.from({ length: 30 }, (_, index) => `dense-${index}`);
    const links: GfaHiCLink[] = [];
    for (let sourceIndex = 0; sourceIndex < contigs.length; sourceIndex += 1) {
      for (let targetIndex = sourceIndex + 1; targetIndex < contigs.length; targetIndex += 1) {
        links.push({
          ...overviewLink(links.length, 1_000 - links.length),
          source: contigs[sourceIndex],
          target: contigs[targetIndex],
        });
      }
    }
    links.push({ ...overviewLink(links.length, 1), source: contigs[0], target: "weak-leaf" });
    const candidates = selectGfaEndpointHiCCandidates(links, 1);

    expect(defaultGfaEndpointHiCLinkLimit).toBe(1);
    expect(candidates.map((candidate) => candidate.link.target)).toContain("weak-leaf");
  });

  it("does not drop unitigs behind a global candidate cap", () => {
    const links = Array.from({ length: 500 }, (_, index) => overviewLink(index));

    const candidates = selectGfaEndpointHiCCandidates(links, 1);

    expect(candidates).toHaveLength(500);
    expect(new Set(candidates.flatMap(({ link }) => [link.source, link.target])).size).toBe(1_000);
  });

  it("keeps preferred cross-focus candidates and ranks them before stronger local links", () => {
    const local = { ...overviewLink(0, 500), source: "selected", target: "local" };
    const cross = { ...overviewLink(1, 10), source: "selected", target: "refreshed" };
    const candidates = selectGfaEndpointHiCCandidates(
      [local, cross],
      1,
      new Set([cross.id]),
    );
    expect(candidates.find((candidate) => candidate.link.id === cross.id)?.preferred).toBe(true);

    const links = buildRankedGfaEndpointHiCLinks(candidates.map((candidate) => ({
      candidate,
      result: readyResult(candidate.link.source, candidate.link.target,
        candidate.link.id === cross.id ? 10 : 500),
    })), [block("selected", 0), block("local", 2_000_000), block("refreshed", 4_000_000)], 1);

    expect(links.map((link) => link.target)).toContain("refreshed");
    expect(links.map((link) => link.target)).not.toContain("local");
  });

  it("clamps invalid user limits to the supported range", () => {
    expect(normalizeGfaEndpointHiCLinkLimit(Number.NaN)).toBe(1);
    expect(normalizeGfaEndpointHiCLinkLimit(0)).toBe(1);
    expect(normalizeGfaEndpointHiCLinkLimit(99)).toBe(50);
  });

  it("uses endpoint evidence for per-port ranking and maps displayed ends to physical sides", () => {
    const first = overviewLink(0, 500);
    const second = overviewLink(1, 300);
    const blocks = [
      block(first.source, 0, "-"),
      block(first.target, 2_000_000, "+"),
      block(second.source, 4_000_000, "+"),
      block(second.target, 6_000_000, "-"),
    ];
    const links = buildRankedGfaEndpointHiCLinks([
      {
        candidate: { link: first, overviewRank: 1 },
        result: readyResult(first.source, first.target, 80, "left", "right"),
      },
      {
        candidate: { link: second, overviewRank: 2 },
        result: readyResult(second.source, second.target, 240, "right", "left"),
      },
    ], blocks, 1);

    expect(links.map((link) => [link.source, link.sourceEndpointRank])).toEqual([
      [second.source, 1],
      [first.source, 1],
    ]);
    expect(links[0]).toMatchObject({ sourceSide: "end", targetSide: "end" });
    expect(links[1]).toMatchObject({ sourceSide: "end", targetSide: "end" });
    expect(links[0].lineWidth).toBeGreaterThan(links[1].lineWidth);
  });

  it("draws only mutual Top 1 pairs so every physical contig end has at most one link", () => {
    const ab = { ...overviewLink(0, 300), source: "a", target: "b", id: "hic:a:b" };
    const ac = { ...overviewLink(1, 200), source: "a", target: "c", id: "hic:a:c" };
    const blocks = [block("a", 0), block("b", 2_000_000), block("c", 4_000_000)];
    const links = buildRankedGfaEndpointHiCLinks([
      {
        candidate: { link: ab, overviewRank: 1 },
        result: readyResult("a", "b", 100, "left", "right", true, [
          { sourceEndpoint: "right", targetEndpoint: "left", normalizedCountPerMb2: 70 },
        ]),
      },
      {
        candidate: { link: ac, overviewRank: 2 },
        result: readyResult("a", "c", 90, "left", "left", true, [
          { sourceEndpoint: "right", targetEndpoint: "right", normalizedCountPerMb2: 80 },
        ]),
      },
    ], blocks, 1);

    // a:start keeps only a-b (100), so c:start choosing a-start does not add a
    // second line to a:start. The same strict cap applies independently to a:end.
    expect(links.map((link) => link.id)).toEqual([
      "endpoint-hic:a:start:b:end",
      "endpoint-hic:a:end:c:end",
    ]);
    expect(new Set(links.map((link) => link.id)).size).toBe(links.length);
    expect(links.every((link) => (
      link.sourceEndpointRank === 1 && link.targetEndpointRank === 1
    ))).toBe(true);

    const degreeByEndpoint = new Map<string, number>();
    for (const link of links) {
      for (const endpoint of [
        `${link.source}:${link.sourceSide}`,
        `${link.target}:${link.targetSide}`,
      ]) {
        degreeByEndpoint.set(endpoint, (degreeByEndpoint.get(endpoint) ?? 0) + 1);
      }
    }
    expect(Math.max(...degreeByEndpoint.values())).toBe(1);
  });

  it("does not draw incomplete evidence or invent ports for unknown orientations", () => {
    const completeUnknown = overviewLink(0);
    const incomplete = overviewLink(1);
    const blocks = [
      block(completeUnknown.source, 0, "?"),
      block(completeUnknown.target, 2_000_000),
      block(incomplete.source, 4_000_000),
      block(incomplete.target, 6_000_000),
    ];

    expect(buildRankedGfaEndpointHiCLinks([
      {
        candidate: { link: completeUnknown, overviewRank: 1 },
        result: readyResult(completeUnknown.source, completeUnknown.target, 100),
      },
      {
        candidate: { link: incomplete, overviewRank: 2 },
        result: readyResult(incomplete.source, incomplete.target, 100, "right", "left", false),
      },
    ], blocks, 5)).toEqual([]);
  });

  it("invalidates cached endpoint evidence after placement edits or normalization changes", () => {
    const source = block("source", 0);
    const target = block("target", 2_000_000);
    const initial = gfaEndpointHiCPairCacheKey(source, target, "layout-a", "raw");
    const moved = gfaEndpointHiCPairCacheKey(
      source,
      { ...target, visualStart: 3_000_000, visualEnd: 4_000_000 },
      "layout-a",
      "raw",
    );

    expect(moved).not.toBe(initial);
    expect(gfaEndpointHiCPairCacheKey(source, target, "layout-a", "KR")).not.toBe(initial);
  });
});
