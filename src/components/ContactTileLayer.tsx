import { useEffect, useMemo, useRef } from "react";
import type { ContactMapTile, ContactMapView } from "../App";
import { contactColorCss } from "../state/contactColor";
import { normalizeContactValue } from "../state/contactColorScale";
import { contactRenderGeometry } from "../state/contactRenderGeometry";
import { canonicalContactTile, contactTileKey } from "../state/contactTiles";
import type { ContactViewport } from "../state/contactViewport";
import type { UiState } from "../state/uiState";

interface ContactTileLayerProps {
  contactMap: ContactMapView | null;
  uiState: UiState;
  layerRef: React.RefObject<HTMLDivElement>;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
}

interface ContactTileCanvasBoxInput {
  tileX: number;
  tileY: number;
  resolution: number;
  tileSizeBins: number;
  viewport: ContactViewport;
  viewportPixelSize: number;
}

export function ContactTileLayer({
  contactMap,
  layerRef,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  uiState,
}: ContactTileLayerProps) {
  const rawTiles = contactMap?.cachedTiles ?? contactMap?.tiles;
  const tiles = useMemo(() => canonicalTilesForRendering(rawTiles ?? []), [rawTiles]);
  const tileSizeBins = contactMap?.tileSizeBins ?? 256;

  return (
    <div
      className="contact-tile-viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div ref={layerRef} className="contact-tile-layer">
        {contactMap
          ? tiles.flatMap((tile) => {
            const canvases = [
              <ContactTileCanvas
                key={`${tile.tileX}:${tile.tileY}:source`}
                contactMap={contactMap}
                tile={tile}
                tileSizeBins={tileSizeBins}
                transpose={false}
                uiState={uiState}
              />,
            ];
            if (tile.tileX !== tile.tileY) {
              canvases.push(
                <ContactTileCanvas
                  key={`${tile.tileX}:${tile.tileY}:mirror`}
                  contactMap={contactMap}
                  tile={tile}
                  tileSizeBins={tileSizeBins}
                  transpose
                  uiState={uiState}
                />,
              );
            }
            return canvases;
          })
          : null}
      </div>
    </div>
  );
}

export function canonicalTilesForRendering(tiles: ContactMapTile[]): ContactMapTile[] {
  const unique = new Map<string, ContactMapTile>();
  for (const tile of tiles) {
    const canonical = canonicalContactTile(tile);
    const normalized = tile.tileX <= tile.tileY
      ? tile
      : {
          tileX: canonical.tileX,
          tileY: canonical.tileY,
          cells: tile.cells.map((cell) => ({
            xBin: cell.yBin,
            yBin: cell.xBin,
            count: cell.count,
          })),
        };
    const key = contactTileKey(canonical);
    const existing = unique.get(key);
    if (!existing || normalized.cells.length > existing.cells.length) {
      unique.set(key, normalized);
    }
  }
  return [...unique.values()];
}

export function contactTileCanvasBox({
  resolution,
  tileSizeBins,
  tileX,
  tileY,
  viewport,
  viewportPixelSize,
}: ContactTileCanvasBoxInput) {
  const viewportWidth = Math.max(1, viewport.xEnd - viewport.xStart);
  const viewportHeight = Math.max(1, viewport.yEnd - viewport.yStart);
  const tileSpanBp = tileSizeBins * resolution;
  const left = ((tileX * tileSpanBp - viewport.xStart) / viewportWidth) * viewportPixelSize;
  const top = ((tileY * tileSpanBp - viewport.yStart) / viewportHeight) * viewportPixelSize;
  const width = (tileSpanBp / viewportWidth) * viewportPixelSize;
  const height = (tileSpanBp / viewportHeight) * viewportPixelSize;

  return { left, top, width, height };
}

function ContactTileCanvas({
  contactMap,
  tile,
  tileSizeBins,
  transpose,
  uiState,
}: {
  contactMap: ContactMapView;
  tile: ContactMapTile;
  tileSizeBins: number;
  transpose: boolean;
  uiState: UiState;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const box = contactTileCanvasBox({
    tileX: transpose ? tile.tileY : tile.tileX,
    tileY: transpose ? tile.tileX : tile.tileY,
    resolution: contactMap.resolution,
    tileSizeBins,
    viewport: contactMap.viewport,
    viewportPixelSize: 100,
  });

  useEffect(() => {
    drawTileCanvas(canvasRef.current, contactMap.resolution, tile, tileSizeBins, transpose, uiState);
  }, [contactMap.resolution, tile, tileSizeBins, transpose, uiState.contact.colormap, uiState.contact.colorScale]);

  return (
    <canvas
      ref={canvasRef}
      className="contact-tile-canvas"
      width={tileSizeBins}
      height={tileSizeBins}
      style={{
        left: `${box.left}%`,
        top: `${box.top}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
      }}
    />
  );
}

function drawTileCanvas(
  canvas: HTMLCanvasElement | null,
  resolution: number,
  tile: ContactMapTile,
  tileSizeBins: number,
  transpose: boolean,
  uiState: UiState,
) {
  if (!canvas) {
    return;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  const tileSpanBp = tileSizeBins * resolution;
  const geometry = contactRenderGeometry({
    resolution,
    viewportWidth: tileSpanBp,
    viewportHeight: tileSpanBp,
    canvasWidth: width,
    canvasHeight: height,
  });
  context.clearRect(0, 0, width, height);

  for (const cell of tile.cells) {
    const xBin = transpose
      ? cell.yBin - tile.tileY * tileSizeBins
      : cell.xBin - tile.tileX * tileSizeBins;
    const yBin = transpose
      ? cell.xBin - tile.tileX * tileSizeBins
      : cell.yBin - tile.tileY * tileSizeBins;
    if (xBin < 0 || yBin < 0 || xBin >= tileSizeBins || yBin >= tileSizeBins) {
      continue;
    }

    const intensity = normalizeContactValue(cell.count, uiState.contact.colorScale);
    context.fillStyle = contactColorCss(uiState.contact.colormap, intensity, 0.88);
    context.fillRect(
      (xBin / tileSizeBins) * width,
      (yBin / tileSizeBins) * height,
      geometry.widthPx,
      geometry.heightPx,
    );
    if (!transpose && tile.tileX === tile.tileY && xBin !== yBin) {
      context.fillRect(
        (yBin / tileSizeBins) * width,
        (xBin / tileSizeBins) * height,
        geometry.widthPx,
        geometry.heightPx,
      );
    }
  }
}
