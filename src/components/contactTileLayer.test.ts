import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialUiState } from "../state/uiState";
import {
  canonicalTilesForRendering,
  ContactTileLayer,
  contactTileCanvasBox,
} from "./ContactTileLayer";

describe("contactTileCanvasBox", () => {
  it("deduplicates symmetric tiles and keeps the populated canonical tile", () => {
    expect(canonicalTilesForRendering([
      { tileX: 2, tileY: 1, cells: [] },
      { tileX: 1, tileY: 2, cells: [{ xBin: 260, yBin: 520, count: 4 }] },
    ])).toEqual([
      { tileX: 1, tileY: 2, cells: [{ xBin: 260, yBin: 520, count: 4 }] },
    ]);
  });

  it("positions a tile canvas relative to the current viewport", () => {
    expect(contactTileCanvasBox({
      tileX: 2,
      tileY: 1,
      resolution: 1_000,
      tileSizeBins: 256,
      viewport: { xStart: 256_000, xEnd: 768_000, yStart: 0, yEnd: 512_000 },
      viewportPixelSize: 1024,
    })).toEqual({
      left: 512,
      top: 512,
      width: 512,
      height: 512,
    });
  });

  it("sizes tile width and height independently for a rectangular viewport", () => {
    expect(contactTileCanvasBox({
      tileX: 0,
      tileY: 0,
      resolution: 1_000,
      tileSizeBins: 256,
      viewport: { xStart: 0, xEnd: 512_000, yStart: 0, yEnd: 256_000 },
      viewportPixelSize: 100,
    })).toEqual({
      left: 0,
      top: 0,
      width: 50,
      height: 100,
    });
  });

  it("allows a 512 Mb tile to extend beyond a 200 Mb viewport without rescaling", () => {
    expect(contactTileCanvasBox({
      tileX: 0,
      tileY: 0,
      resolution: 2_000_000,
      tileSizeBins: 256,
      viewport: { xStart: 0, xEnd: 200_000_000, yStart: 0, yEnd: 200_000_000 },
      viewportPixelSize: 100,
    })).toEqual({
      left: 0,
      top: 0,
      width: 256,
      height: 256,
    });
  });

  it("renders one cached source tile plus its symmetric mirror without rebuilding a global canvas", () => {
    const markup = renderToStaticMarkup(
      createElement(ContactTileLayer, {
        contactMap: {
          resolution: 1_000,
          viewport: { xStart: 0, xEnd: 512_000, yStart: 0, yEnd: 512_000 },
          cells: [],
          tileSizeBins: 256,
          tiles: [],
          cachedTiles: [{
            tileX: 0,
            tileY: 1,
            cells: [{ xBin: 4, yBin: 260, count: 5 }],
          }],
        },
        uiState: createInitialUiState("ready"),
        layerRef: createRef<HTMLDivElement>(),
        onPointerDown: () => undefined,
        onPointerMove: () => undefined,
        onPointerUp: () => undefined,
        onPointerCancel: () => undefined,
      }),
    );

    expect(markup.match(/contact-tile-canvas/g)).toHaveLength(2);
    expect(markup).toContain("left:0%;top:50%");
    expect(markup).toContain("left:50%;top:0%");
  });

  it("positions existing tiles against a live resized viewport instead of a stale response viewport", () => {
    const markup = renderToStaticMarkup(
      createElement(ContactTileLayer, {
        contactMap: {
          resolution: 1_000,
          viewport: { xStart: 0, xEnd: 512_000, yStart: 0, yEnd: 512_000 },
          cells: [],
          tileSizeBins: 256,
          tiles: [],
          cachedTiles: [{
            tileX: 0,
            tileY: 1,
            cells: [{ xBin: 4, yBin: 260, count: 5 }],
          }],
        },
        viewport: { xStart: 0, xEnd: 1_024_000, yStart: 0, yEnd: 512_000 },
        uiState: createInitialUiState("ready"),
        layerRef: createRef<HTMLDivElement>(),
        onPointerDown: () => undefined,
        onPointerMove: () => undefined,
        onPointerUp: () => undefined,
        onPointerCancel: () => undefined,
      }),
    );

    expect(markup).toContain("left:0%;top:50%;width:25%;height:50%");
    expect(markup).toContain("left:25%;top:0%;width:25%;height:50%");
  });
});
