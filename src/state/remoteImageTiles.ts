import type { ContactViewport } from "./contactViewport";
import type { RemoteRasterFrame } from "./remoteContactRaster";

export interface RemoteImageTile {
  key: string;
  viewport: ContactViewport;
  width: number;
  height: number;
}

/** Fixed genomic grid for one zoom/style/layout, independent of pan position. */
export function remoteImageTileGrid(viewport: ContactViewport, width: number, height: number, resolution: number) {
  const xDensity = width / Math.max(1, viewport.xEnd - viewport.xStart);
  const yDensity = height / Math.max(1, viewport.yEnd - viewport.yStart);
  const xSpan = Math.max(1, Math.ceil(512 / (resolution * xDensity))) * resolution;
  const ySpan = Math.max(1, Math.ceil(512 / (resolution * yDensity))) * resolution;
  return { xSpan, ySpan, width: Math.ceil(xSpan * xDensity), height: Math.ceil(ySpan * yDensity) };
}
export function remoteImageTiles(viewport: ContactViewport, grid: ReturnType<typeof remoteImageTileGrid>, totalSpan: number) {
  if (grid.width > 1024 || grid.height > 1024 || !Number.isFinite(grid.xSpan + grid.ySpan)) return [];
  const x0 = Math.max(0, Math.floor(viewport.xStart / grid.xSpan));
  const y0 = Math.max(0, Math.floor(viewport.yStart / grid.ySpan));
  const x1 = Math.ceil(Math.min(totalSpan, viewport.xEnd) / grid.xSpan);
  const y1 = Math.ceil(Math.min(totalSpan, viewport.yEnd) / grid.ySpan);
  if ((x1-x0)*(y1-y0)>48) return [];
  const tiles: RemoteImageTile[]=[];
  for (let y=y0; y<y1; y++) for (let x=x0; x<x1; x++) tiles.push({
    key:`${x}:${y}`,width:grid.width,height:grid.height,
    viewport:{xStart:x*grid.xSpan,xEnd:(x+1)*grid.xSpan,yStart:y*grid.ySpan,yEnd:(y+1)*grid.ySpan},
  });
  return tiles;
}

/** No React updates or matrix arrays. Scope changes create a new layer. */
export class RemoteImageTileLayer {
  private cache = new Map<string, RemoteRasterFrame>();
  private active = new Map<string, AbortController>();
  private pending: RemoteImageTile[] = [];
  private wanted = new Set<string>();
  private visible = new Set<string>();
  private listeners = new Set<() => void>();
  private bytes = 0;
  private closed = false;
  private paused = false;
  private previous: {viewport: ContactViewport; time: number} | null = null;
  private latency = 200;
  private retryAfter = new Map<string, number>();
  constructor(
    readonly grid: ReturnType<typeof remoteImageTileGrid>,
    private totalSpan: number,
    private load: (tile: RemoteImageTile, signal: AbortSignal) => Promise<RemoteRasterFrame>,
    private budget = 32*1024*1024,
  ) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  frames() { return Array.from(this.cache.values()); }
  stats() { return {entries:this.cache.size, bytes:this.bytes, active:this.active.size, pending:this.pending.length}; }
  pause() { this.paused=true; this.pending=[]; }
  prefetch(viewport: ContactViewport) {
    if (this.closed) return;
    this.paused=false;
    const now=performance.now(), previous=this.previous;
    const dt=Math.max(16,now-(previous?.time ?? now));
    const dx=previous ? (viewport.xStart-previous.viewport.xStart)/dt*this.latency : 0;
    const dy=previous ? (viewport.yStart-previous.viewport.yStart)/dt*this.latency : 0;
    const gx=this.grid.xSpan, gy=this.grid.ySpan;
    const leadX=Math.max(-2*gx,Math.min(2*gx,dx)),leadY=Math.max(-2*gy,Math.min(2*gy,dy));
    this.previous={viewport,time:now};
    const visible=remoteImageTiles(viewport,this.grid,this.totalSpan);
    this.visible=new Set(visible.map(t=>t.key));
    const ahead=remoteImageTiles({xStart:Math.max(0,viewport.xStart-gx+Math.min(0,leadX)),
      xEnd:viewport.xEnd+gx+Math.max(0,leadX),yStart:Math.max(0,viewport.yStart-gy+Math.min(0,leadY)),
      yEnd:viewport.yEnd+gy+Math.max(0,leadY)},this.grid,this.totalSpan);
    const desired=Array.from(new Map([...visible,...ahead].map(t=>[t.key,t])).values()).slice(0,48);
    this.wanted=new Set(desired.map(t=>t.key));
    // Only unrelated work is cancelled. Reversals reuse every retained image.
    for(const [key,controller] of this.active) if(!this.wanted.has(key)) controller.abort();
    for(const t of visible) { const value=this.cache.get(t.key); if(value) {this.cache.delete(t.key);this.cache.set(t.key,value);} }
    this.pending=desired.filter(t=>!this.cache.has(t.key)&&!this.active.has(t.key)&&(this.retryAfter.get(t.key)??0)<=now);
    this.pump();
  }
  dispose() {
    this.closed=true;this.pending=[];
    for(const c of this.active.values()) c.abort();
    this.active.clear();
    for(const frame of this.cache.values()) frame.image.src="";
    this.cache.clear();this.bytes=0;this.listeners.clear();this.retryAfter.clear();
  }
  private pump() {
    while(!this.closed&&!this.paused&&this.active.size<2&&this.pending.length) {
      const tile=this.pending.shift()!;
      const controller=new AbortController();this.active.set(tile.key,controller);
      const started=performance.now();
      void this.load(tile,controller.signal).then(frame=>{
        if(this.closed||controller.signal.aborted||!this.wanted.has(tile.key)) {frame.image.src="";return;}
        this.latency=this.latency*.8+(performance.now()-started)*.2;
        const size=frame.image.naturalWidth*frame.image.naturalHeight*4;
        if(size>this.budget) {frame.image.src="";return;}
        while(this.bytes+size>this.budget && this.cache.size) {
          const key=Array.from(this.cache.keys()).find(k=>!this.visible.has(k)) ?? this.cache.keys().next().value!;const old=this.cache.get(key)!;
          this.bytes-=old.image.naturalWidth*old.image.naturalHeight*4;old.image.src="";this.cache.delete(key);
        }
        this.cache.set(tile.key,frame);this.bytes+=size;
        for(const listener of this.listeners) listener();
      }).catch(()=>{
        if(!controller.signal.aborted&&!this.closed) {
          if(this.retryAfter.size>=48) this.retryAfter.delete(this.retryAfter.keys().next().value!);
          this.retryAfter.set(tile.key,performance.now()+1000);
        }
      }).finally(()=>{this.active.delete(tile.key);this.pump();});
    }
  }
}
