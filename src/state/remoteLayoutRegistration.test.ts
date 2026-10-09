import {afterEach,describe,it,expect,vi} from 'vitest';
import {fetchRemoteRender,rememberRemoteContactSource,forgetRemoteContactSource,remoteContactIdentifier} from './remoteContact';
const url='http://localhost:8787/v1/datasets/layout-test'; const path=remoteContactIdentifier(url,'mcool');
afterEach(()=>{forgetRemoteContactSource(path);vi.unstubAllGlobals();});
function setup(){rememberRemoteContactSource(path,{datasetUrl:url,bearerToken:'test'});}
const signal=()=>new AbortController().signal;
describe('remote layout revisions',()=>{
 it('registers once across concurrent views and sends only the revision thereafter',async()=>{
  setup();const blocks:[]=[];const fetch=vi.fn(async(url:string)=>url.endsWith('/layouts')?new Response('{"layoutId":"a"}'):new Response('png'));vi.stubGlobal('fetch',fetch);
  await Promise.all([fetchRemoteRender(path,{width:1},signal(),blocks),fetchRemoteRender(path,{width:2},signal(),blocks)]);
  expect(fetch.mock.calls.filter(c=>c[0].endsWith('/layouts'))).toHaveLength(1);
  const calls=(fetch.mock.calls as unknown as [string,RequestInit][]).filter(c=>c[0].endsWith('/render'));
  expect(calls.map(c=>JSON.parse(c[1].body as string))).toEqual([{width:1,layoutId:'a'},{width:2,layoutId:'a'}]);
  await fetchRemoteRender(path,{},signal(),[]);expect(fetch.mock.calls.filter(c=>c[0].endsWith('/layouts'))).toHaveLength(1);
 });
 it('renews an evicted or restarted revision once',async()=>{
  setup();const fetch=vi.fn().mockResolvedValueOnce(new Response('{"layoutId":"old"}')).mockResolvedValueOnce(new Response('',{status:410})).mockResolvedValueOnce(new Response('{"layoutId":"new"}')).mockResolvedValueOnce(new Response('png'));vi.stubGlobal('fetch',fetch);
  await fetchRemoteRender(path,{},signal(),[]);expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({layoutId:'new'});
 });
 it('falls back on older servers but never hides authentication errors',async()=>{
  setup();const fetch=vi.fn().mockResolvedValueOnce(new Response('',{status:404})).mockResolvedValue(new Response('png'));vi.stubGlobal('fetch',fetch);
  await fetchRemoteRender(path,{},signal(),[]);expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({layoutBlocks:[]});
  setup();fetch.mockReset().mockResolvedValue(new Response('unauthorized',{status:401}));await expect(fetchRemoteRender(path,{},signal(),[])).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
 });
});
