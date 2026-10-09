import type { RemoteImageTileLayer } from "./remoteImageTiles";
import { contactTilesForViewport } from "./contactTiles";
import type { ContactMapView } from "../App";
import type { ContactMapLayoutBlock } from "./importers";
import type { ContactColorScale } from "./contactColorScale";
import type { ContactColormap } from "./uiState";
import { contactColorLut, contactPaletteStopCount } from "./contactColor";
import { fetchRemoteRender } from "./remoteContact";
import type { ContactViewport } from "./contactViewport";

export interface RemoteRasterFrame {
  image: HTMLImageElement;
  tileLayer?: RemoteImageTileLayer;
  /** Dataset identity for retaining a front frame while a new layout renders. */
  sourcePath?: string;
  /** Immutable image coordinates, independent of the live pan camera. */
  viewport: ContactViewport;
  scaleMax: number;
}

/** Keep the complete front frame, including its original layout and camera. */
export function retainRemoteContactFrame(
  current: ContactMapView | null,
  path: string,
  nextLayout: readonly ContactMapLayoutBlock[],
): ContactMapView | null {
  return nextLayout.length > 0 && current?.raster?.sourcePath === path ? current : null;
}

export function remoteRasterSize(width: number, height: number) {
  const w = Math.max(1, Number.isFinite(width) ? width : 1);
  const h = Math.max(1, Number.isFinite(height) ? height : 1);
  const factor = Math.min(1, 2048 / w, 2048 / h, Math.sqrt(1_048_576 / (w * h)));
  return { width: Math.max(1, Math.floor(w * factor)), height: Math.max(1, Math.floor(h * factor)) };
}

export async function loadRemoteRaster(input: {
  path: string;
  layoutBlocks: ContactMapLayoutBlock[];
  viewport: ContactViewport;
  sourceResolution: number;
  targetResolution?: number;
  overview?: boolean;
  tileSizeBins?: number;
  adaptiveRefinement?: boolean;
  scaleTiles?: Array<{tileX:number;tileY:number}>;
  width: number;
  height: number;
  normalization: "raw" | "ice" | "kr" | "vc" | "vc_sqrt";
  colormap: ContactColormap;
  colorScale: ContactColorScale;
}, signal: AbortSignal): Promise<ContactMapView> {
  const colorLut = Array.from(contactColorLut(input.colormap, input.overview ? 0.9 : 0.88));
  const size = remoteRasterSize(input.width, input.height);
  const response = await fetchRemoteRender(input.path, {
    sourceResolution: input.sourceResolution,
    targetResolution: input.targetResolution,
    paletteStopCount: contactPaletteStopCount(input.colormap),
    overview: input.overview ?? false,
    tileSizeBins: input.tileSizeBins ?? 256,
    adaptiveRefinement: input.adaptiveRefinement ?? false,
    tiles: input.targetResolution ? contactTilesForViewport(input.viewport, input.targetResolution, input.tileSizeBins ?? 256) : undefined,
    scaleTiles: input.scaleTiles,
    viewport: input.viewport,
    normalization: input.normalization,
    ...size, colorScale: input.colorScale, colorLut,
  }, signal, input.layoutBlocks);
  if (input.targetResolution && (response.headers.get("x-cstudio-render-contract") !== "desktop-v1"
    || Number(response.headers.get("x-cstudio-resolution")) !== input.targetResolution)) {
    throw new Error("Update the remote server: its display rules do not match this client");
  }
  const resolution = Number(response.headers.get("x-cstudio-resolution"));
  const scaleMax = Number(response.headers.get("x-cstudio-scale-max"));
  if (response.headers.get("content-type")?.split(";")[0] !== "image/png"
    || !Number.isFinite(scaleMax) || scaleMax < 0
    || !Number.isSafeInteger(resolution) || resolution < input.sourceResolution) {
    throw new Error("Invalid server-rendered contact image response");
  }
  const blob = await response.blob();
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const abort = () => { image.src = ""; };
  try {
    signal.addEventListener("abort", abort, { once: true });
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    if (image.naturalWidth !== size.width || image.naturalHeight !== size.height) {
      throw new Error("Server-rendered contact image dimensions do not match request");
    }
    return {
      resolution, requestedResolution: input.sourceResolution,
      normalization: input.normalization, viewport: input.viewport,
      cells: [], visibleLayerComplete: true,
      raster: { image, viewport: input.viewport, scaleMax, sourcePath: input.path },
    };
  } finally {
    signal.removeEventListener("abort", abort);
    URL.revokeObjectURL(url);
  }
}

/** Draw only image pixels; never build a matrix texture or a cell array locally. */
export function drawRemoteRaster(
  context: CanvasRenderingContext2D, raster: RemoteRasterFrame,
  viewport: ContactViewport, x: number, y: number, width: number, height: number,
) {
  // Paint fixed tiles underneath the exact settled image. Only newly exposed
  // areas use the tile grid; the authoritative viewport retains pixel parity.
  for (const frame of raster.tileLayer?.frames() ?? []) {
    if (frame.viewport.xEnd > viewport.xStart && frame.viewport.xStart < viewport.xEnd
      && frame.viewport.yEnd > viewport.yStart && frame.viewport.yStart < viewport.yEnd) {
      drawRemoteRaster(context, frame, viewport, x, y, width, height);
    }
  }
  const xs = Math.max(1, viewport.xEnd - viewport.xStart);
  const ys = Math.max(1, viewport.yEnd - viewport.yStart);
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  context.imageSmoothingEnabled = false;
  context.drawImage(raster.image,
    x + (raster.viewport.xStart - viewport.xStart) / xs * width,
    y + (raster.viewport.yStart - viewport.yStart) / ys * height,
    (raster.viewport.xEnd - raster.viewport.xStart) / xs * width,
    (raster.viewport.yEnd - raster.viewport.yStart) / ys * height);
  context.restore();
}

/** A bounded 25% margin per side; retain screen density until the PNG cap applies. */
export function remotePanRequest(viewport: ContactViewport, width: number, height: number, totalSpan: number) {
  const xs = Math.max(1, viewport.xEnd - viewport.xStart);
  const ys = Math.max(1, viewport.yEnd - viewport.yStart);
  // Spend remaining image capacity on margins; never reduce visible density
  // merely to prefetch more area.
  const expansion = Math.max(1, Math.min(1.5, 2048 / width, 2048 / height,
    Math.sqrt(1_048_576 / (width * height))));
  const margin = (expansion - 1) / 2;
  const expanded = {
    xStart: Math.max(0, Math.floor(viewport.xStart - xs * margin)),
    xEnd: Math.min(totalSpan, Math.ceil(viewport.xEnd + xs * margin)),
    yStart: Math.max(0, Math.floor(viewport.yStart - ys * margin)),
    yEnd: Math.min(totalSpan, Math.ceil(viewport.yEnd + ys * margin)),
  };
  return { viewport: expanded,
    ...remoteRasterSize(width * (expanded.xEnd - expanded.xStart) / xs,
      height * (expanded.yEnd - expanded.yStart) / ys) };
}

export function remoteRasterCovers(frame: ContactViewport, viewport: ContactViewport) {
  return frame.xStart <= viewport.xStart && frame.xEnd >= viewport.xEnd
    && frame.yStart <= viewport.yStart && frame.yEnd >= viewport.yEnd;
}

/** Start warming before the last 10% of retained image padding is consumed. */
export function remotePanWarmViewport(viewport: ContactViewport, totalSpan: number): ContactViewport {
  const x = (viewport.xEnd - viewport.xStart) * 0.1;
  const y = (viewport.yEnd - viewport.yStart) * 0.1;
  return { xStart: Math.max(0, viewport.xStart - x), xEnd: Math.min(totalSpan, viewport.xEnd + x),
    yStart: Math.max(0, viewport.yStart - y), yEnd: Math.min(totalSpan, viewport.yEnd + y) };
}
