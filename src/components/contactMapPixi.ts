import { Application, Graphics } from "pixi.js";
import type { ContactMapView } from "../App";
import { contactColorAt, contactColorHex } from "../state/contactColor";
import { normalizeContactValue } from "../state/contactColorScale";
import { contactCellsForViewport } from "../state/contactMapView";
import { contactRenderGeometry } from "../state/contactRenderGeometry";
import type { UiState } from "../state/uiState";

export interface ContactMapPixiRenderer {
  app: Application;
  layer: Graphics;
}

export async function createContactMapPixiRenderer(
  host: HTMLElement,
): Promise<ContactMapPixiRenderer> {
  const app = new Application();
  await app.init({
    antialias: false,
    autoDensity: true,
    background: "#ffffff",
    resizeTo: host,
  });
  app.canvas.className = "contact-map-pixi-canvas";
  host.appendChild(app.canvas);

  const layer = new Graphics();
  app.stage.addChild(layer);
  return { app, layer };
}

export function destroyContactMapPixiRenderer(renderer: ContactMapPixiRenderer | null) {
  renderer?.app.destroy(true, { children: true, texture: true });
}

export function drawContactMapPixi(
  renderer: ContactMapPixiRenderer,
  contactMap: ContactMapView | null,
  uiState: UiState,
) {
  const { app, layer } = renderer;
  const width = app.renderer.width;
  const height = app.renderer.height;
  if (
    contactMap
    && contactMap.tiles
    && contactMap.tiles.length === 0
    && (contactMap.cachedTiles?.length ?? 0) === 0
    && contactMap.cells.length === 0
  ) {
    return;
  }

  layer.clear();

  layer.rect(0, 0, width, height).fill("#ffffff");
  if (!contactMap) {
    return;
  }
  const viewportWidth = Math.max(1, contactMap.viewport.xEnd - contactMap.viewport.xStart);
  const viewportHeight = Math.max(1, contactMap.viewport.yEnd - contactMap.viewport.yStart);
  const geometry = contactRenderGeometry({
    resolution: contactMap.resolution,
    viewportWidth,
    viewportHeight,
    canvasWidth: width,
    canvasHeight: height,
  });
  const cells = contactCellsForViewport(contactMap);

  for (const cell of cells) {
    drawCell(layer, contactMap, uiState, cell.xBin, cell.yBin, cell.count, geometry.widthPx, geometry.heightPx, width, height);
    if (cell.xBin !== cell.yBin) {
      drawCell(layer, contactMap, uiState, cell.yBin, cell.xBin, cell.count, geometry.widthPx, geometry.heightPx, width, height);
    }
  }
}

export function translateContactMapPixi(renderer: ContactMapPixiRenderer | null, deltaX: number) {
  if (!renderer) {
    return;
  }
  renderer.layer.x = deltaX;
}

export function resetContactMapPixiTranslation(renderer: ContactMapPixiRenderer | null) {
  translateContactMapPixi(renderer, 0);
}

function drawCell(
  layer: Graphics,
  contactMap: ContactMapView,
  uiState: UiState,
  xBin: number,
  yBin: number,
  count: number,
  binPixelWidth: number,
  binPixelHeight: number,
  width: number,
  height: number,
) {
  const viewportWidth = Math.max(1, contactMap.viewport.xEnd - contactMap.viewport.xStart);
  const viewportHeight = Math.max(1, contactMap.viewport.yEnd - contactMap.viewport.yStart);
  const x = ((xBin * contactMap.resolution - contactMap.viewport.xStart) / viewportWidth) * width;
  const y = ((yBin * contactMap.resolution - contactMap.viewport.yStart) / viewportHeight) * height;
  const intensity = normalizeContactValue(count, uiState.contact.colorScale);
  const color = contactColorAt(uiState.contact.colormap, intensity);
  layer.rect(x, y, binPixelWidth, binPixelHeight).fill({
    color: contactColorHex(color),
    alpha: color.alpha,
  });
}
