import { buildContactMainLodPlan, contactMainLodPlanChangesSampling, maxAdaptiveMcoolExactTiles, maxExactMainContactTiles } from './contactMainLod';
import { contactTilesForViewport, contactTileSizeBins } from './contactTiles';
import type { ContactViewport } from './contactViewport';

/** Same LOD decision as the local main surface, without enumerating a huge exact grid. */
export function remoteRenderPlan(viewport: ContactViewport, selectedResolution: number,
  width: number, height: number, totalSpan: number, available: readonly number[], mcool: boolean,
  lodEnabled = true) {
  const span = selectedResolution * contactTileSizeBins;
  const x0 = Math.floor(viewport.xStart / span), x1 = Math.ceil(Math.min(totalSpan, viewport.xEnd) / span);
  const y0 = Math.floor(viewport.yStart / span), y1 = Math.ceil(Math.min(totalSpan, viewport.yEnd) / span);
  const overlap = Math.max(0, Math.min(x1,y1)-Math.max(x0,y0));
  const count = Math.max(0,x1-x0)*Math.max(0,y1-y0)-overlap*(overlap-1)/2;
  const coarse = mcool && selectedResolution === 2_500_000;
  const candidate = lodEnabled || coarse ? buildContactMainLodPlan({ viewport, selectedResolution,
    viewportWidthPx:width, viewportHeightPx:height, visibleTileCount:count,
    exactTileLimit:coarse ? maxAdaptiveMcoolExactTiles : maxExactMainContactTiles },available) : null;
  const lod = candidate && (coarse || contactMainLodPlanChangesSampling(candidate,selectedResolution)) ? candidate : null;
  const sourceResolution = lod?.sourceResolution ?? selectedResolution;
  const targetResolution = lod?.targetResolution ?? selectedResolution;
  return {sourceResolution,targetResolution,
    adaptiveRefinement:!lod && coarse && count<=maxAdaptiveMcoolExactTiles,
    scaleTiles:contactTilesForViewport(viewport,targetResolution,contactTileSizeBins,totalSpan)};
}
