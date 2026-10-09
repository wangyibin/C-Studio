import {describe,it,expect} from 'vitest';
import {remoteRenderPlan} from './remoteRenderPlan';
import {buildContactMainLodPlan,contactMainLodPlanChangesSampling} from './contactMainLod';
import {contactTilesForViewport} from './contactTiles';
import {rasterizeContactMapCells} from './contactMapRaster';
import {contactColorLut} from './contactColor';
import type {ContactColormap} from './uiState';
import fixtures from '../../tests/fixtures/remote-render-parity.json';

describe('shared local and remote display rules',()=>{
 it('chooses the same stored and display levels over zooms and off-diagonal views',()=>{
  const available=[1000,5000,10000,50000,500000,1000000,2500000];
  for(const span of [100000,30000000,3179259998]) for(const selected of available) for(const offset of [0,123456]) {
   const viewport={xStart:offset,xEnd:offset+span,yStart:0,yEnd:span};
   const total=span+offset;
   const count = span / selected > 100000 ? 100000 : contactTilesForViewport(viewport,selected,256,total).length;
   const candidate=buildContactMainLodPlan({viewport,selectedResolution:selected,viewportWidthPx:512,viewportHeightPx:512,visibleTileCount:count,exactTileLimit:selected===2500000?4:16},available);
   const local=candidate&&(selected===2500000||contactMainLodPlanChangesSampling(candidate,selected))?candidate:null;
   const remote=remoteRenderPlan(viewport,selected,512,512,total,available,true);
   expect(remote.sourceResolution).toBe(local?.sourceResolution??selected);
   expect(remote.targetResolution).toBe(local?.targetResolution??selected);
  }
 });
 it('matches the committed cross-language RGB fixtures',()=>{
  for(const fixture of fixtures){
   const r=fixture.request;
   const pixels=rasterizeContactMapCells({cells:fixture.cells,resolution:r.sourceResolution,viewport:r.viewport,width:r.width,height:r.height,colorScale:r.colorScale,colormap:fixture.colormap as ContactColormap,colorLut:contactColorLut(fixture.colormap as ContactColormap,0.88)});
   expect(Array.from(pixels).filter((_,i)=>i%4!==3)).toEqual(fixture.rgb);
  }
 });
});
