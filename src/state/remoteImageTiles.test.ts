import { describe, expect, it, vi } from "vitest";
import { RemoteImageTileLayer, remoteImageTileGrid, remoteImageTiles } from "./remoteImageTiles";
import type { RemoteRasterFrame } from "./remoteContactRaster";
const view={xStart:0,xEnd:512,yStart:0,yEnd:512};
const grid=remoteImageTileGrid(view,512,512,1);
const image=()=>({src:"test",naturalWidth:512,naturalHeight:512} as HTMLImageElement);
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
describe("remote fixed image grid",()=>{
 it("keeps overlap keys and pixel dimensions while panning, including edges",()=>{
  const a=remoteImageTiles(view,grid,3000);
  const b=remoteImageTiles({...view,xStart:30,xEnd:542},grid,3000);
  expect(a[0]).toEqual(b[0]);expect(b.map(t=>t.key)).toEqual(["0:0","1:0"]);
  expect(remoteImageTiles({...view,xStart:2900,xEnd:3500},grid,3000)).toHaveLength(1);
 });
 it("bounds queues on pathological zooms and grids",()=>{
  expect(remoteImageTiles({...view,xEnd:1e12,yEnd:1e12},grid,1e12)).toEqual([]);
  expect(remoteImageTiles(view,{...grid,width:1e5},1e6)).toEqual([]);
 });
 it("publishes completed tiles during an active gesture, reuses them and bounds concurrency",async()=>{
  const completions:Array<()=>void>=[];let inFlight=0,max=0;
  const load=vi.fn((tile)=>new Promise<RemoteRasterFrame>(resolve=>{
   inFlight++;max=Math.max(max,inFlight);
   completions.push(()=>{inFlight--;resolve({image:image(),viewport:tile.viewport,scaleMax:10});});
  }));
  const layer=new RemoteImageTileLayer(grid,4000,load,2*1024*1024);
  const painted=vi.fn();layer.subscribe(painted);layer.prefetch(view);
  expect(load).toHaveBeenCalledTimes(2);
  completions.shift()!();await flush();expect(painted).toHaveBeenCalledOnce();
  const first=load.mock.calls[0][0].key;
  layer.prefetch({...view,xStart:10,xEnd:522});
  expect(load.mock.calls.filter(c=>c[0].key===first)).toHaveLength(1);
  while(completions.length){completions.shift()!();await flush();}
  expect(max).toBeLessThanOrEqual(2);expect(layer.stats().bytes).toBeLessThanOrEqual(2*1024*1024);
  layer.dispose();expect(layer.stats().entries).toBe(0);
 });
 it("discards late images after layout/style disposal",async()=>{
  let resolve!:(frame:RemoteRasterFrame)=>void;
  const layer=new RemoteImageTileLayer(grid,512,()=>new Promise(r=>{resolve=r;}));
  const painted=vi.fn();layer.subscribe(painted);layer.prefetch(view);layer.dispose();
  const frame={image:image(),viewport:view,scaleMax:10};resolve(frame);await flush();
  expect(painted).not.toHaveBeenCalled();expect(frame.image.src).toBe("");expect(layer.stats().bytes).toBe(0);
 });
 it("rejects late tiles outside the new camera after a large direction change",async()=>{
  const tasks:Array<{signal:AbortSignal;done:(value:RemoteRasterFrame)=>void}>=[];
  const layer=new RemoteImageTileLayer(grid,12000,(_tile,signal)=>new Promise(done=>tasks.push({signal,done})));
  const painted=vi.fn();layer.subscribe(painted);layer.prefetch(view);
  layer.prefetch({xStart:8000,xEnd:8512,yStart:8000,yEnd:8512});
  expect(tasks[0].signal.aborted).toBe(true);
  const frame={image:image(),viewport:view,scaleMax:10};tasks[0].done(frame);await flush();
  expect(painted).not.toHaveBeenCalled();expect(frame.image.src).toBe("");layer.dispose();
 });
 it("pauses queued prefetch for a settled foreground request without aborting useful work",async()=>{
  let resolve!:(frame:RemoteRasterFrame)=>void;
  const load=vi.fn(()=>new Promise<RemoteRasterFrame>(r=>{resolve=r;}));
  const layer=new RemoteImageTileLayer(grid,4000,load);layer.prefetch(view);layer.pause();
  resolve({image:image(),viewport:view,scaleMax:10});await flush();
  expect(load).toHaveBeenCalledTimes(2);expect(layer.stats().pending).toBe(0);layer.dispose();
 });
});
