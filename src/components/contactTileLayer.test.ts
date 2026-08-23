import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createInitialUiState } from "../state/uiState";
import { ContactTileDeltaAccumulator } from "../state/contactTileDelta";
import {
  canonicalTilesForRendering,
  canPromoteContactTilePanInPlace,
  ContactTileLayer,
  contactTileDeltaStagingSlot,
  contactTileGpuSharedTextureBudgetBytes,
  contactTileGpuPresentationRetryDelay,
  contactTileGpuSlotTextureBudgetBytes,
  contactTileCanvasBox,
  contactTileCanvasDescriptorsForViewport,
  contactTileCanvasPaintDependencyValues,
  contactTileViewportForBufferedSurface,
  contactVisibleTileIdentitySignature,
  createContactTileLayerBufferState,
  createContactTilePaintCoordinator,
  discardContactTileStagingBuffer,
  deferContactTileGpuDeltaUpdates,
  drawTileCanvas,
  revealContactTileLayerBuffer,
  syncContactTileLayerBuffer,
  type ContactTileLayerFrame,
  type ContactTilePaintCoordinator,
  type ContactTileRenderStyle,
} from "./ContactTileLayer";
import { contactTileGpuTextureBudgetBytes } from "./contactTileGpu";

function initialRenderStyle(): ContactTileRenderStyle {
  const uiState = createInitialUiState("ready");
  return {
    colormap: uiState.contact.colormap,
    colorScale: uiState.contact.colorScale,
  };
}

function contactTileFrame(
  generation: number,
  resolution: number,
  max = 10,
  visibleLayerComplete = true,
): ContactTileLayerFrame {
  return {
    contactMap: {
      resolution,
      viewport: { xStart: 0, xEnd: resolution * 256, yStart: 0, yEnd: resolution * 256 },
      cells: [],
      tileSizeBins: 256,
      tiles: [{ tileX: 0, tileY: 0, cells: [] }],
      visibleLayerComplete,
      renderGeneration: generation,
      layoutScope: `scope:${resolution}`,
    },
    renderStyle: {
      colormap: "Reds",
      colorScale: { log: false, min: 0, max },
    },
  };
}

describe("contact tile GPU presentation retry", () => {
  it("backs off transient misses without growing beyond a quarter second", () => {
    expect([
      contactTileGpuPresentationRetryDelay(0),
      contactTileGpuPresentationRetryDelay(1),
      contactTileGpuPresentationRetryDelay(2),
      contactTileGpuPresentationRetryDelay(3),
      contactTileGpuPresentationRetryDelay(4),
      contactTileGpuPresentationRetryDelay(50),
    ]).toEqual([16, 32, 64, 128, 250, 250]);
  });

  it("normalizes negative and fractional attempts", () => {
    expect(contactTileGpuPresentationRetryDelay(-4)).toBe(16);
    expect(contactTileGpuPresentationRetryDelay(2.9)).toBe(64);
  });
});

describe("contact tile paint epochs", () => {
  it("waits for commit and every unique canvas paint regardless of effect order", () => {
    const callbacks: string[] = [];
    let active: ContactTilePaintCoordinator | null = null;
    let coordinator!: ContactTilePaintCoordinator;
    coordinator = createContactTilePaintCoordinator({
      event: { renderEpoch: 7, canvasCount: 2, paintRevision: 42 },
      canvasKeys: ["0:0:source", "0:1:mirror"],
      isCurrent: () => active === coordinator,
      onCommit: ({ renderEpoch, canvasCount, paintRevision, commitTimestamp }) => {
        callbacks.push(`commit:${renderEpoch}:${canvasCount}:${paintRevision}:${commitTimestamp}`);
      },
      onComplete: ({ renderEpoch, canvasCount, paintRevision, commitTimestamp }) => {
        callbacks.push(`complete:${renderEpoch}:${canvasCount}:${paintRevision}:${commitTimestamp}`);
      },
    });

    // Child layout effects may run before their parent layout effect.
    coordinator.reportCanvasPaint("0:0:source");
    active = coordinator;
    coordinator.prepareCommit(123.5);
    coordinator.commit();
    expect(callbacks).toEqual(["commit:7:2:42:123.5"]);

    coordinator.reportCanvasPaint("0:0:source");
    coordinator.reportCanvasPaint("not-current");
    expect(callbacks).toEqual(["commit:7:2:42:123.5"]);

    coordinator.reportCanvasPaint("0:1:mirror");
    coordinator.reportCanvasPaint("0:1:mirror");
    expect(callbacks).toEqual([
      "commit:7:2:42:123.5",
      "complete:7:2:42:123.5",
    ]);
  });

  it("completes an empty layer immediately after its commit", () => {
    const callbacks: string[] = [];
    let active: ContactTilePaintCoordinator | null = null;
    let coordinator!: ContactTilePaintCoordinator;
    coordinator = createContactTilePaintCoordinator({
      event: { renderEpoch: 8, canvasCount: 0 },
      canvasKeys: [],
      isCurrent: () => active === coordinator,
      onCommit: () => callbacks.push("commit"),
      onComplete: () => callbacks.push("complete"),
    });

    active = coordinator;
    coordinator.commit();

    expect(callbacks).toEqual(["commit", "complete"]);
  });

  it("does not let a superseded epoch report completion", () => {
    const callbacks: string[] = [];
    let active: ContactTilePaintCoordinator | null = null;
    const createEpoch = (renderEpoch: number) => {
      let coordinator!: ContactTilePaintCoordinator;
      coordinator = createContactTilePaintCoordinator({
        event: { renderEpoch, canvasCount: 2 },
        canvasKeys: ["source", "mirror"],
        isCurrent: () => active === coordinator,
        onCommit: ({ renderEpoch: epoch }) => callbacks.push(`commit:${epoch}`),
        onComplete: ({ renderEpoch: epoch }) => callbacks.push(`complete:${epoch}`),
      });
      return coordinator;
    };
    const oldEpoch = createEpoch(9);
    active = oldEpoch;
    oldEpoch.commit();
    oldEpoch.reportCanvasPaint("source");

    const currentEpoch = createEpoch(10);
    active = currentEpoch;
    currentEpoch.commit();
    oldEpoch.reportCanvasPaint("mirror");
    oldEpoch.cancel();
    currentEpoch.reportCanvasPaint("source");
    currentEpoch.reportCanvasPaint("mirror");

    expect(callbacks).toEqual(["commit:9", "commit:10", "complete:10"]);
  });

  it("fails closed when an expected canvas has no drawing context", () => {
    const callbacks: string[] = [];
    let active: ContactTilePaintCoordinator | null = null;
    let coordinator!: ContactTilePaintCoordinator;
    coordinator = createContactTilePaintCoordinator({
      event: { renderEpoch: 11, canvasCount: 1 },
      canvasKeys: ["source"],
      isCurrent: () => active === coordinator,
      onCommit: () => callbacks.push("commit"),
      onComplete: () => callbacks.push("complete"),
      onUnavailable: () => callbacks.push("unavailable"),
    });

    active = coordinator;
    coordinator.reportCanvasUnavailable("source");
    coordinator.commit();
    coordinator.reportCanvasPaint("source");

    expect(callbacks).toEqual(["unavailable"]);
  });
});

describe("contact tile presentation buffer", () => {
  it("keeps an initial streamed partial layer off the presented surface", () => {
    const partial = contactTileFrame(1, 1_000, 10, false);
    const initial = createContactTileLayerBufferState(partial);

    expect(initial.slots).toEqual([null, null]);
    expect(initial.frontSlot).toBeNull();
    expect(initial.stagingSlot).toBeNull();

    const complete = contactTileFrame(1, 1_000, 10, true);
    const ready = syncContactTileLayerBuffer(initial, complete, false);
    expect(ready.slots).toEqual([complete, null]);
    expect(ready.frontSlot).toBe(0);
  });

  it("retains a complete same-viewport front while its replacement is partial", () => {
    const presented = contactTileFrame(1, 1_000);
    const partial = contactTileFrame(2, 1_000, 10, false);
    const initial = createContactTileLayerBufferState(presented);

    expect(syncContactTileLayerBuffer(initial, partial, false)).toBe(initial);
  });

  it("reserves one persistent back slot for a retained delta generation", () => {
    const presented = contactTileFrame(1, 1_000);
    const target = contactTileFrame(2, 1_000_000);
    const stream = {
      generation: 2,
      resolution: 1_000_000,
      viewport: target.contactMap.viewport,
      accumulator: new ContactTileDeltaAccumulator([{ tileX: 0, tileY: 0 }], 256),
      retainPreviousFrame: true,
    };
    const initial = createContactTileLayerBufferState(presented);
    const staged = syncContactTileLayerBuffer(initial, target, false);
    const revealed = revealContactTileLayerBuffer(
      staged,
      1,
      target,
      { renderEpoch: 1, canvasCount: 1, paintRevision: 2 },
    );

    expect(contactTileDeltaStagingSlot(initial, stream)).toBe(1);
    expect(contactTileDeltaStagingSlot(staged, stream)).toBe(1);
    expect(contactTileDeltaStagingSlot(revealed, stream)).toBe(1);
    expect(contactTileDeltaStagingSlot(initial, { ...stream, retainPreviousFrame: false })).toBeNull();
  });

  it("gives the shared context the global budget and keeps the legacy slot cap bounded", () => {
    expect(contactTileGpuSharedTextureBudgetBytes).toBe(contactTileGpuTextureBudgetBytes);
    expect(contactTileGpuSlotTextureBudgetBytes * 2).toBe(contactTileGpuTextureBudgetBytes);
  });

  it("defers GPU updates only while an old front frame covers the staging stream", () => {
    expect(deferContactTileGpuDeltaUpdates({ retainPreviousFrame: true })).toBe(true);
    expect(deferContactTileGpuDeltaUpdates({ retainPreviousFrame: false })).toBe(false);
    expect(deferContactTileGpuDeltaUpdates({})).toBe(false);
  });

  it("keeps each buffer slot in its own viewport during a fine-to-coarse swap", () => {
    const fine = contactTileFrame(1, 1_000);
    fine.contactMap.requestedResolution = 1_000;
    fine.contactMap.viewport = {
      xStart: 236_000_000,
      xEnd: 237_200_000,
      yStart: 236_000_000,
      yEnd: 237_200_000,
    };
    const coarse = contactTileFrame(2, 1_000_000);
    coarse.contactMap.requestedResolution = 1_000_000;
    coarse.contactMap.viewport = {
      xStart: 0,
      xEnd: 473_741_399,
      yStart: 0,
      yEnd: 473_741_399,
    };

    expect(contactTileViewportForBufferedSurface(
      "presented",
      fine,
      coarse,
      coarse.contactMap.viewport,
    )).toBe(fine.contactMap.viewport);
    expect(contactTileViewportForBufferedSurface(
      "staging",
      coarse,
      coarse,
      coarse.contactMap.viewport,
    )).toBe(coarse.contactMap.viewport);
    expect(contactTileViewportForBufferedSurface(
      "presented",
      coarse,
      coarse,
      coarse.contactMap.viewport,
    )).toBe(coarse.contactMap.viewport);
  });

  it("never restores the source GPU camera while a committed pan target arrives", () => {
    const presented = contactTileFrame(1, 1_000);
    const target = contactTileFrame(2, 1_000, 10, false);
    target.contactMap.viewport = {
      xStart: 128_000,
      xEnd: 384_000,
      yStart: 64_000,
      yEnd: 320_000,
    };
    const committedCamera = { ...target.contactMap.viewport };

    expect(contactTileViewportForBufferedSurface(
      "presented",
      presented,
      target,
      presented.contactMap.viewport,
      committedCamera,
    )).toBe(committedCamera);
    expect(contactTileViewportForBufferedSurface(
      "staging",
      target,
      target,
      committedCamera,
      committedCamera,
    )).toBe(target.contactMap.viewport);
  });

  it("stages a selected-resolution change even when both choices reuse one LOD resolution", () => {
    const fineChoice = contactTileFrame(1, 500_000);
    fineChoice.contactMap.requestedResolution = 1_000;
    const coarseChoice = contactTileFrame(2, 500_000);
    coarseChoice.contactMap.requestedResolution = 5_000;

    const staged = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(fineChoice),
      coarseChoice,
      false,
    );

    expect(staged.frontSlot).toBe(0);
    expect(staged.stagingSlot).toBe(1);
    expect(staged.slots).toEqual([fineChoice, coarseChoice]);
  });

  it("keeps a translated pan frame until complete, then stages an atomic reveal", () => {
    const presented = contactTileFrame(1, 1_000);
    const partial = contactTileFrame(2, 1_000, 10, false);
    partial.contactMap.viewport = {
      xStart: 128_000,
      xEnd: 384_000,
      yStart: 64_000,
      yEnd: 320_000,
    };
    const initial = createContactTileLayerBufferState(presented);

    expect(syncContactTileLayerBuffer(initial, partial, false)).toBe(initial);

    const complete: ContactTileLayerFrame = {
      ...partial,
      contactMap: { ...partial.contactMap, visibleLayerComplete: true },
    };
    const staged = syncContactTileLayerBuffer(initial, complete, false);

    expect(staged.frontSlot).toBe(0);
    expect(staged.stagingSlot).toBe(1);
    expect(staged.slots).toEqual([presented, complete]);
    expect(contactTileViewportForBufferedSurface(
      "staging",
      complete,
      complete,
      complete.contactMap.viewport,
    )).toBe(complete.contactMap.viewport);
  });

  it("reuses the presented slot after a complete pure-pan target is promoted on its GPU", () => {
    const presented = contactTileFrame(1, 1_000);
    const target = contactTileFrame(2, 1_000);
    target.contactMap.viewport = {
      xStart: 128_000,
      xEnd: 384_000,
      yStart: 64_000,
      yEnd: 320_000,
    };
    const initial = createContactTileLayerBufferState(presented);

    expect(canPromoteContactTilePanInPlace(presented, target)).toBe(true);
    const promoted = syncContactTileLayerBuffer(initial, target, false, true);
    expect(promoted.frontSlot).toBe(0);
    expect(promoted.stagingSlot).toBeNull();
    expect(promoted.slots).toEqual([target, null]);
  });

  it("does not use the GPU pan fast path for a resolution change", () => {
    const presented = contactTileFrame(1, 1_000);
    const target = contactTileFrame(2, 2_000);

    expect(canPromoteContactTilePanInPlace(presented, target)).toBe(false);
    const staged = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(presented),
      target,
      false,
      true,
    );
    expect(staged.frontSlot).toBe(0);
    expect(staged.stagingSlot).toBe(1);
  });

  it("keeps the presented frame and its color scale frozen while a target is loading", () => {
    const presented = contactTileFrame(1, 1_000, 10);
    const initial = createContactTileLayerBufferState(presented);
    const targetStyle = {
      contactMap: presented.contactMap,
      renderStyle: {
        ...presented.renderStyle,
        colorScale: { ...presented.renderStyle.colorScale, max: 99 },
      },
    } satisfies ContactTileLayerFrame;

    const frozen = syncContactTileLayerBuffer(initial, targetStyle, true);

    expect(frozen).toBe(initial);
    expect(frozen.slots[frozen.frontSlot!]?.renderStyle.colorScale.max).toBe(10);
    expect(frozen.stagingSlot).toBeNull();
  });

  it("uses the first complete map when a freeze begins before any frame was presented", () => {
    const partial = contactTileFrame(2, 1_000, 10, false);
    const completeFallback = contactTileFrame(1, 1_000, 99, true);
    const restored = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(partial),
      completeFallback,
      true,
    );

    expect(restored.frontSlot).toBe(0);
    expect(restored.stagingSlot).toBeNull();
    expect(restored.slots[0]?.contactMap).toBe(completeFallback.contactMap);
    expect(restored.slots[0]?.renderStyle).toBe(completeFallback.renderStyle);
    expect(restored.slots[0]?.renderStyle.colorScale.max).toBe(99);
  });

  it("keeps an incomplete resolution in the back end and stages only a complete frame", () => {
    const presented = contactTileFrame(1, 1_000);
    const initial = createContactTileLayerBufferState(presented);
    const partial = contactTileFrame(2, 2_000, 20, false);

    expect(syncContactTileLayerBuffer(initial, partial, false)).toBe(initial);

    const complete = contactTileFrame(2, 2_000, 20, true);
    const staged = syncContactTileLayerBuffer(initial, complete, false);
    expect(staged.frontSlot).toBe(0);
    expect(staged.stagingSlot).toBe(1);
    expect(staged.slots).toEqual([presented, complete]);
  });

  it("atomically reveals a ready staged frame and removes the old surface", () => {
    const presented = contactTileFrame(1, 1_000);
    const target = contactTileFrame(2, 2_000);
    const staged = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(presented),
      target,
      false,
    );
    const event = { renderEpoch: 4, canvasCount: 1, paintRevision: 2 };

    const revealed = revealContactTileLayerBuffer(staged, 1, target, event);

    expect(revealed).toEqual({
      slots: [null, target],
      frontSlot: 1,
      stagingSlot: null,
      revealRevision: 1,
      revealEvent: event,
    });
  });

  it("rejects a late generation after a newer target replaced the staging slot", () => {
    const presented = contactTileFrame(1, 1_000);
    const staleTarget = contactTileFrame(2, 2_000);
    const currentTarget = contactTileFrame(3, 4_000);
    const staged = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(presented),
      staleTarget,
      false,
    );
    const replaced = syncContactTileLayerBuffer(staged, currentTarget, false);

    expect(revealContactTileLayerBuffer(
      replaced,
      1,
      staleTarget,
      { renderEpoch: 1, canvasCount: 1, paintRevision: 2 },
    )).toBe(replaced);
    expect(revealContactTileLayerBuffer(
      replaced,
      1,
      currentTarget,
      { renderEpoch: 1, canvasCount: 1, paintRevision: 3 },
    ).frontSlot).toBe(1);
  });

  it("rejects a stale style epoch even when the generation is unchanged", () => {
    const presented = contactTileFrame(7, 1_000, 10);
    const style20: ContactTileLayerFrame = {
      contactMap: presented.contactMap,
      renderStyle: {
        ...presented.renderStyle,
        colorScale: { ...presented.renderStyle.colorScale, max: 20 },
      },
    };
    const style30: ContactTileLayerFrame = {
      contactMap: presented.contactMap,
      renderStyle: {
        ...presented.renderStyle,
        colorScale: { ...presented.renderStyle.colorScale, max: 30 },
      },
    };
    const staged20 = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(presented),
      style20,
      false,
    );
    const staged30 = syncContactTileLayerBuffer(staged20, style30, false);
    const event = { renderEpoch: 2, canvasCount: 1, paintRevision: 7 };

    expect(revealContactTileLayerBuffer(staged30, 1, style20, event)).toBe(staged30);
    expect(revealContactTileLayerBuffer(staged30, 1, style30, event).frontSlot).toBe(1);
  });

  it("keeps same-presentation map updates on the front surface", () => {
    const presented = contactTileFrame(1, 1_000);
    const updated = contactTileFrame(2, 1_000);

    const next = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(presented),
      updated,
      false,
    );

    expect(next.frontSlot).toBe(0);
    expect(next.stagingSlot).toBeNull();
    expect(next.slots).toEqual([updated, null]);
  });

  it("keeps layout-preview publication on the existing front surface", () => {
    const presented = contactTileFrame(1, 1_000);
    const nextGeneration = contactTileFrame(2, 1_000);
    const updated: ContactTileLayerFrame = {
      ...nextGeneration,
      contactMap: {
        ...nextGeneration.contactMap,
        layoutScope: "scope:edited-layout",
      },
    };

    const next = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(presented),
      updated,
      false,
    );

    expect(next.frontSlot).toBe(0);
    expect(next.stagingSlot).toBeNull();
    expect(next.slots).toEqual([updated, null]);
  });

  it("discards an in-flight staging surface when presentation freezing resumes", () => {
    const presented = contactTileFrame(1, 1_000);
    const target = contactTileFrame(2, 2_000);
    const staged = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(presented),
      target,
      false,
    );

    const frozen = syncContactTileLayerBuffer(staged, target, true);

    expect(frozen.slots).toEqual([presented, null]);
    expect(frozen.frontSlot).toBe(0);
    expect(frozen.stagingSlot).toBeNull();
  });

  it("removes a failed staging surface without replacing the presented frame", () => {
    const presented = contactTileFrame(1, 1_000);
    const target = contactTileFrame(2, 2_000);
    const staged = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(presented),
      target,
      false,
    );

    const discarded = discardContactTileStagingBuffer(staged, 1, target);

    expect(discarded.slots).toEqual([presented, null]);
    expect(discarded.frontSlot).toBe(0);
    expect(discarded.stagingSlot).toBeNull();
    expect(discardContactTileStagingBuffer(staged, 0, presented)).toBe(staged);
  });

  it("keeps reveal revisions monotonic across an empty buffer", () => {
    const presented = contactTileFrame(1, 1_000);
    const target = contactTileFrame(2, 2_000);
    const staged = syncContactTileLayerBuffer(
      createContactTileLayerBufferState(presented),
      target,
      false,
    );
    const revealed = revealContactTileLayerBuffer(
      staged,
      1,
      target,
      { renderEpoch: 1, canvasCount: 1, paintRevision: 2 },
    );

    const empty = syncContactTileLayerBuffer(revealed, null, false);
    const reloaded = syncContactTileLayerBuffer(empty, contactTileFrame(3, 1_000), false);

    expect(empty.revealRevision).toBe(1);
    expect(reloaded.revealRevision).toBe(1);
  });
});

describe("contactTileCanvasBox", () => {
  it("deduplicates symmetric tiles and keeps the populated canonical tile", () => {
    expect(canonicalTilesForRendering([
      { tileX: 2, tileY: 1, cells: [] },
      { tileX: 1, tileY: 2, cells: [{ xBin: 260, yBin: 520, count: 4 }] },
    ])).toEqual([
      { tileX: 1, tileY: 2, cells: [{ xBin: 260, yBin: 520, count: 4 }] },
    ]);
  });

  it("swaps both tile and cell coordinates for a populated lower-triangle tile", () => {
    expect(canonicalTilesForRendering([{
      tileX: 2,
      tileY: 1,
      cells: [{ xBin: 520, yBin: 260, count: 4 }],
    }])).toEqual([{
      tileX: 1,
      tileY: 2,
      cells: [{ xBin: 260, yBin: 520, count: 4 }],
    }]);
  });

  it("canonicalizes packed lower-triangle tiles by swapping local coordinate arrays", () => {
    const counts = new Float64Array([4, 7]);
    const [tile] = canonicalTilesForRendering([{
      tileX: 2,
      tileY: 1,
      cells: [],
      packedCells: {
        xLocal: new Uint16Array([8, 9]),
        yLocal: new Uint16Array([4, 5]),
        counts,
      },
    }]);

    expect(tile.tileX).toBe(1);
    expect(tile.tileY).toBe(2);
    expect(Array.from(tile.packedCells?.xLocal ?? [])).toEqual([4, 5]);
    expect(Array.from(tile.packedCells?.yLocal ?? [])).toEqual([8, 9]);
    expect(tile.packedCells?.counts).toBe(counts);
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

  it("renders only visible canvases plus one tile on the active overscan axes", () => {
    const cachedTiles = [
      { tileX: 0, tileY: 1, cells: [] },
      { tileX: 0, tileY: 2, cells: [] },
      { tileX: 1, tileY: 1, cells: [] },
    ];
    const viewport = {
      xStart: 0,
      xEnd: 256_000,
      yStart: 256_000,
      yEnd: 512_000,
    };
    const keysFor = (x: -1 | 0 | 1, y: -1 | 0 | 1) => (
      contactTileCanvasDescriptorsForViewport(
        cachedTiles,
        1_000,
        256,
        viewport,
        { x, y },
      ).map(({ key }) => key)
    );

    expect(keysFor(0, 0)).toEqual(["0:1:source"]);
    expect(keysFor(1, 0)).toEqual(["0:1:source", "1:1:source"]);
    expect(keysFor(0, 1)).toEqual(["0:1:source", "0:2:source"]);
    expect(keysFor(1, -1)).toEqual([
      "0:1:source",
      "0:1:mirror",
      "1:1:source",
    ]);
    expect(contactTileCanvasDescriptorsForViewport(
      cachedTiles,
      1_000,
      256,
      viewport,
      "all",
    ).map(({ key }) => key)).toEqual([
      "0:1:source",
      "0:1:mirror",
      "0:2:source",
      "1:1:source",
    ]);
  });

  it("drops a symmetric mirror when only the canonical source intersects the viewport", () => {
    const descriptors = contactTileCanvasDescriptorsForViewport(
      [{ tileX: 2, tileY: 5, cells: [] }],
      1_000,
      256,
      {
        xStart: 2 * 256_000,
        xEnd: 3 * 256_000,
        yStart: 5 * 256_000,
        yEnd: 6 * 256_000,
      },
      { x: 0, y: 0 },
    );

    expect(descriptors).toHaveLength(1);
    const [source] = descriptors;
    expect(source).toMatchObject({ key: "2:5:source", transpose: false });
  });

  it.each([1_000, 5_000])(
    "covers every visible 4 by 4 screen tile at %s bp without rectangular holes",
    (resolution) => {
      const tileSizeBins = 256;
      const axisTiles = 4;
      const tileSpan = resolution * tileSizeBins;
      const canonicalTiles = [];
      for (let tileY = 0; tileY < axisTiles; tileY += 1) {
        for (let tileX = 0; tileX <= tileY; tileX += 1) {
          canonicalTiles.push({
            tileX,
            tileY,
            cells: [{
              xBin: tileX * tileSizeBins,
              yBin: tileY * tileSizeBins,
              count: 1,
            }],
          });
        }
      }

      const descriptors = contactTileCanvasDescriptorsForViewport(
        canonicalTiles,
        resolution,
        tileSizeBins,
        {
          xStart: 0,
          xEnd: axisTiles * tileSpan,
          yStart: 0,
          yEnd: axisTiles * tileSpan,
        },
        { x: 0, y: 0 },
      );
      const covered = new Set(descriptors.map(({ tile, transpose }) => (
        transpose
          ? `${tile.tileY}:${tile.tileX}`
          : `${tile.tileX}:${tile.tileY}`
      )));

      expect(descriptors).toHaveLength(axisTiles * axisTiles);
      expect(covered).toEqual(new Set(
        Array.from({ length: axisTiles * axisTiles }, (_, index) => (
          `${index % axisTiles}:${Math.floor(index / axisTiles)}`
        )),
      ));
    },
  );

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
        renderStyle: initialRenderStyle(),
        layerRef: createRef<HTMLDivElement>(),
        onPointerDown: () => undefined,
        onPointerMove: () => undefined,
        onPointerUp: () => undefined,
        onPointerCancel: () => undefined,
      }),
    );

    expect(markup.match(/contact-tile-canvas/g)).toHaveLength(2);
    expect(markup.match(/contact-tile-surface/g)).toHaveLength(1);
    expect(markup).toContain('data-phase="presented"');
    expect(markup).not.toContain('data-phase="staging"');
    expect(markup).toContain("left:0%;top:50%");
    expect(markup).toContain("left:50%;top:0%");
  });

  it("mounts one shared GPU canvas for the production front/staging path", () => {
    vi.stubGlobal("document", {});
    try {
      const markup = renderToStaticMarkup(
        createElement(ContactTileLayer, {
          contactMap: {
            resolution: 1_000,
            viewport: { xStart: 0, xEnd: 256_000, yStart: 0, yEnd: 256_000 },
            cells: [],
            tileSizeBins: 256,
            visibleLayerComplete: true,
            tiles: [{
              tileX: 0,
              tileY: 0,
              cells: [{ xBin: 0, yBin: 0, count: 5 }],
            }],
          },
          renderStyle: initialRenderStyle(),
          layerRef: createRef<HTMLDivElement>(),
          onPointerDown: () => undefined,
          onPointerMove: () => undefined,
          onPointerUp: () => undefined,
          onPointerCancel: () => undefined,
        }),
      );

      expect(markup.match(/data-gpu-context="shared"/g)).toHaveLength(1);
      expect(markup.match(/contact-tile-gpu-canvas/g)).toHaveLength(1);
      expect(markup.match(/contact-tile-surface/g)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
        renderStyle: initialRenderStyle(),
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

  it("keeps loaded preview tiles mounted against the stable drag camera", () => {
    const markup = renderToStaticMarkup(
      createElement(ContactTileLayer, {
        contactMap: {
          resolution: 1_000,
          viewport: {
            xStart: 512_000,
            xEnd: 768_000,
            yStart: 512_000,
            yEnd: 768_000,
          },
          cells: [],
          tileSizeBins: 256,
          tiles: [{
            tileX: 2,
            tileY: 2,
            cells: [{ xBin: 520, yBin: 520, count: 5 }],
          }],
          cachedTiles: [{
            tileX: 2,
            tileY: 2,
            cells: [{ xBin: 520, yBin: 520, count: 5 }],
          }],
        },
        viewport: {
          xStart: 0,
          xEnd: 256_000,
          yStart: 0,
          yEnd: 256_000,
        },
        overscanDirection: { x: 0, y: 0 },
        renderStyle: initialRenderStyle(),
        layerRef: createRef<HTMLDivElement>(),
        onPointerDown: () => undefined,
        onPointerMove: () => undefined,
        onPointerUp: () => undefined,
        onPointerCancel: () => undefined,
      }),
    );

    expect(markup.match(/contact-tile-canvas/g)).toHaveLength(1);
    expect(markup).toContain("left:200%;top:200%;width:100%;height:100%");
  });
});

describe("drawTileCanvas", () => {
  it("tracks visible tile replacement without coupling epochs to padding-array rebuilds", () => {
    const visibleTile = {
      tileX: 0,
      tileY: 0,
      cells: [{ xBin: 1, yBin: 2, count: 3 }],
    };
    const firstPadding = [{ tileX: 0, tileY: 1, cells: [] }];
    const rebuiltPadding = [{ tileX: 0, tileY: 1, cells: [] }];
    const initial = contactVisibleTileIdentitySignature([visibleTile], firstPadding);

    expect(contactVisibleTileIdentitySignature([visibleTile], rebuiltPadding)).toBe(initial);
    expect(contactVisibleTileIdentitySignature([{ ...visibleTile }], rebuiltPadding)).not.toBe(initial);
  });

  it("keeps equivalent color-scale objects on the same paint dependency epoch", () => {
    const tile = { tileX: 0, tileY: 0, cells: [{ xBin: 1, yBin: 2, count: 3 }] };
    const style = initialRenderStyle();
    const initial = contactTileCanvasPaintDependencyValues(1_000, tile, 256, false, style);
    const equivalent = contactTileCanvasPaintDependencyValues(1_000, tile, 256, false, {
      colormap: style.colormap,
      colorScale: { ...style.colorScale },
    });

    expect(equivalent).not.toBe(initial);
    expect(equivalent.every((value, index) => Object.is(value, initial[index]))).toBe(true);
  });

  it.each([
    ["resolution", (style: ContactTileRenderStyle, tile: Parameters<typeof contactTileCanvasPaintDependencyValues>[1]) =>
      contactTileCanvasPaintDependencyValues(2_000, tile, 256, false, style)],
    ["tile data", (style: ContactTileRenderStyle, tile: Parameters<typeof contactTileCanvasPaintDependencyValues>[1]) =>
      contactTileCanvasPaintDependencyValues(1_000, { ...tile, cells: [...tile.cells] }, 256, false, style)],
    ["tile size", (style: ContactTileRenderStyle, tile: Parameters<typeof contactTileCanvasPaintDependencyValues>[1]) =>
      contactTileCanvasPaintDependencyValues(1_000, tile, 512, false, style)],
    ["transpose", (style: ContactTileRenderStyle, tile: Parameters<typeof contactTileCanvasPaintDependencyValues>[1]) =>
      contactTileCanvasPaintDependencyValues(1_000, tile, 256, true, style)],
    ["colormap", (style: ContactTileRenderStyle, tile: Parameters<typeof contactTileCanvasPaintDependencyValues>[1]) =>
      contactTileCanvasPaintDependencyValues(1_000, tile, 256, false, { ...style, colormap: "Viridis" })],
    ["log scale", (style: ContactTileRenderStyle, tile: Parameters<typeof contactTileCanvasPaintDependencyValues>[1]) =>
      contactTileCanvasPaintDependencyValues(1_000, tile, 256, false, {
        ...style,
        colorScale: { ...style.colorScale, log: !style.colorScale.log },
      })],
    ["minimum", (style: ContactTileRenderStyle, tile: Parameters<typeof contactTileCanvasPaintDependencyValues>[1]) =>
      contactTileCanvasPaintDependencyValues(1_000, tile, 256, false, {
        ...style,
        colorScale: { ...style.colorScale, min: style.colorScale.min + 1 },
      })],
    ["maximum", (style: ContactTileRenderStyle, tile: Parameters<typeof contactTileCanvasPaintDependencyValues>[1]) =>
      contactTileCanvasPaintDependencyValues(1_000, tile, 256, false, {
        ...style,
        colorScale: { ...style.colorScale, max: style.colorScale.max + 1 },
      })],
  ])("invalidates the paint dependency epoch when %s changes", (_label, change) => {
    const tile = { tileX: 0, tileY: 0, cells: [{ xBin: 1, yBin: 2, count: 3 }] };
    const style = initialRenderStyle();
    const initial = contactTileCanvasPaintDependencyValues(1_000, tile, 256, false, style);
    const changed = change(style, tile);

    expect(changed.some((value, index) => !Object.is(value, initial[index]))).toBe(true);
  });

  it("reuses one complete ImageData raster instead of issuing per-cell canvas draws", () => {
    const imageData = {
      data: new Uint8ClampedArray(4 * 4 * 4),
      width: 4,
      height: 4,
      colorSpace: "srgb",
    } as ImageData;
    const context = {
      createImageData: vi.fn(() => imageData),
      putImageData: vi.fn(),
    };
    const canvas = {
      width: 4,
      height: 4,
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;

    expect(drawTileCanvas(
      canvas,
      {
        tileX: 0,
        tileY: 0,
        cells: [],
        packedCells: {
          xLocal: new Uint16Array([1]),
          yLocal: new Uint16Array([2]),
          counts: new Float64Array([1]),
        },
      },
      4,
      false,
      initialRenderStyle(),
    )).toBe("painted");
    expect(drawTileCanvas(
      canvas,
      { tileX: 0, tileY: 0, cells: [{ xBin: 1, yBin: 2, count: 1 }] },
      4,
      false,
      initialRenderStyle(),
    )).toBe("painted");

    expect(context.createImageData).toHaveBeenCalledOnce();
    expect(context.createImageData).toHaveBeenCalledWith(4, 4);
    expect(context.putImageData).toHaveBeenCalledTimes(2);
    expect(context.putImageData).toHaveBeenLastCalledWith(imageData, 0, 0);
    expect(Array.from(imageData.data.slice((2 * 4 + 1) * 4, (2 * 4 + 2) * 4))).toEqual(
      [255, 0, 0, 255],
    );
    expect(Array.from(imageData.data.slice((1 * 4 + 2) * 4, (1 * 4 + 3) * 4))).toEqual(
      [255, 0, 0, 255],
    );
  });

  it("clears an empty tile without allocating or uploading an RGBA buffer", () => {
    const context = {
      clearRect: vi.fn(),
      createImageData: vi.fn(),
      putImageData: vi.fn(),
    };
    const canvas = {
      width: 4,
      height: 4,
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;

    expect(drawTileCanvas(
      canvas,
      { tileX: 0, tileY: 0, cells: [] },
      4,
      false,
      initialRenderStyle(),
    )).toBe("cleared");

    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 4, 4);
    expect(context.createImageData).not.toHaveBeenCalled();
    expect(context.putImageData).not.toHaveBeenCalled();
  });

  it("does not mark a canvas ready when its 2D context is unavailable", () => {
    const canvas = {
      width: 4,
      height: 4,
      getContext: vi.fn(() => null),
    } as unknown as HTMLCanvasElement;

    expect(drawTileCanvas(
      canvas,
      { tileX: 0, tileY: 0, cells: [] },
      4,
      false,
      initialRenderStyle(),
    )).toBe("unavailable");
  });

  it("rejects a backing canvas whose dimensions no longer match one bin per pixel", () => {
    const canvas = {
      width: 8,
      height: 8,
      getContext: vi.fn(),
    } as unknown as HTMLCanvasElement;

    expect(() => drawTileCanvas(
      canvas,
      { tileX: 0, tileY: 0, cells: [] },
      4,
      false,
      initialRenderStyle(),
    )).toThrow(/backing size/);
    expect(canvas.getContext).not.toHaveBeenCalled();
  });
});
