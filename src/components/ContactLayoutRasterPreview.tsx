import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type {
  ContactLayoutRasterSegment,
  ContactLayoutRasterSlice,
} from "../state/contactLayoutPreview";
import { contactLayoutRasterSlice } from "../state/contactLayoutPreview";
import type { ContactViewport } from "../state/contactViewport";

const maxRasterPreviewDimension = 1_600;
const usePrePaintEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ContactLayoutRasterPreviewProps {
  sourceLayerRef: RefObject<HTMLDivElement>;
  segments: ContactLayoutRasterSegment[];
  viewport: ContactViewport;
  sourceRevision: string;
}

/**
 * Reorders the last complete authoritative raster before the browser paints.
 * X and Y are transformed separately, so work scales with the number of
 * visible contigs rather than the number of contact cells or contig pairs.
 */
export function ContactLayoutRasterPreview({
  segments,
  sourceLayerRef,
  sourceRevision,
  viewport,
}: ContactLayoutRasterPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceRasterRef = useRef<HTMLCanvasElement | null>(null);
  const xRasterRef = useRef<HTMLCanvasElement | null>(null);

  usePrePaintEffect(() => {
    const canvas = canvasRef.current;
    const sourceLayer = sourceLayerRef.current;
    const sourceViewport = sourceLayer?.parentElement;
    if (!canvas || !sourceLayer || !sourceViewport || segments.length === 0) {
      return;
    }

    const bounds = sourceViewport.getBoundingClientRect();
    const scale = Math.min(
      1,
      maxRasterPreviewDimension / Math.max(1, bounds.width, bounds.height),
    );
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    canvas.width = width;
    canvas.height = height;

    const sourceRaster = sourceRasterRef.current ?? document.createElement("canvas");
    const xRaster = xRasterRef.current ?? document.createElement("canvas");
    sourceRasterRef.current = sourceRaster;
    xRasterRef.current = xRaster;
    sourceRaster.width = width;
    sourceRaster.height = height;
    xRaster.width = width;
    xRaster.height = height;

    const sourceContext = sourceRaster.getContext("2d");
    const xContext = xRaster.getContext("2d");
    const targetContext = canvas.getContext("2d");
    if (!sourceContext || !xContext || !targetContext) {
      return;
    }

    prepareRasterContext(sourceContext, width, height);
    const renderedTiles = sourceLayer.querySelectorAll<HTMLCanvasElement>(
      "canvas.contact-tile-canvas",
    );
    if (renderedTiles.length === 0) {
      return;
    }
    for (const tileCanvas of renderedTiles) {
      const tileBounds = tileCanvas.getBoundingClientRect();
      sourceContext.drawImage(
        tileCanvas,
        (tileBounds.left - bounds.left) * scale,
        (tileBounds.top - bounds.top) * scale,
        tileBounds.width * scale,
        tileBounds.height * scale,
      );
    }

    prepareRasterContext(xContext, width, height);
    for (const segment of segments) {
      const slice = contactLayoutRasterSlice(
        segment,
        viewport.xStart,
        viewport.xEnd,
        width,
      );
      if (!slice) {
        continue;
      }
      drawHorizontalStrip(xContext, sourceRaster, slice, height);
    }

    prepareRasterContext(targetContext, width, height);
    for (const segment of segments) {
      const slice = contactLayoutRasterSlice(
        segment,
        viewport.yStart,
        viewport.yEnd,
        height,
      );
      if (!slice) {
        continue;
      }
      drawVerticalStrip(targetContext, xRaster, slice, width);
    }
  }, [
    segments,
    sourceLayerRef,
    sourceRevision,
    viewport.xEnd,
    viewport.xStart,
    viewport.yEnd,
    viewport.yStart,
  ]);

  return <canvas ref={canvasRef} className="contact-layout-raster-preview" aria-hidden="true" />;
}

function prepareRasterContext(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = false;
}

function drawHorizontalStrip(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  slice: ContactLayoutRasterSlice,
  height: number,
) {
  const sourceWidth = slice.sourceEndPx - slice.sourceStartPx;
  const targetWidth = slice.targetEndPx - slice.targetStartPx;
  if (sourceWidth <= 0 || targetWidth <= 0) {
    return;
  }

  context.save();
  context.translate(slice.flipped ? slice.targetEndPx : slice.targetStartPx, 0);
  context.scale(slice.flipped ? -1 : 1, 1);
  context.drawImage(
    source,
    slice.sourceStartPx,
    0,
    sourceWidth,
    height,
    0,
    0,
    targetWidth,
    height,
  );
  context.restore();
}

function drawVerticalStrip(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  slice: ContactLayoutRasterSlice,
  width: number,
) {
  const sourceHeight = slice.sourceEndPx - slice.sourceStartPx;
  const targetHeight = slice.targetEndPx - slice.targetStartPx;
  if (sourceHeight <= 0 || targetHeight <= 0) {
    return;
  }

  context.save();
  context.translate(0, slice.flipped ? slice.targetEndPx : slice.targetStartPx);
  context.scale(1, slice.flipped ? -1 : 1);
  context.drawImage(
    source,
    0,
    slice.sourceStartPx,
    width,
    sourceHeight,
    0,
    0,
    width,
    targetHeight,
  );
  context.restore();
}
