import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import handler from '../api/atm-range.js';
import {buildOCCSymbol,easternCloseMs} from '../lib/option-preview.mjs';

const expiry=()=>new Date(Date.now()+45*86400000).toISOString().slice(0,10);
const req=(query={},method='GET')=>({method,query:{ticker:'BBW',expiry:expiry(),...query},
 headers:{origin:'https://swing-risk-desk-vercel-v11.vercel.app'}});
const res=()=>({statusCode:200,headers:{},
 setHeader(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},
 json(v){this.body=v;return this;}});
const contract=(strike,type='call',adjusted=false)=>({
 status:'active',underlying_symbol:'BBW',expiration_date:expiry(),strike_price:String(strike),
 type,size:'100',symbol:(adjusted?'ADJUSTED':'')+buildOCCSymbol({ticker:'BBW',expiry:expiry(),strike,
  optionType:type==='call'?'Call':'Put'})
});
async function withCredentials(fetchMock,callback){
 const old={id:process.env.ALPACA_DATA_KEY_ID,secret:process.env.ALPACA_DATA_SECRET_KEY,
  fetch:globalThis.fetch};
 process.env.ALPACA_DATA_KEY_ID='FAKE_ATM_TEST';
 process.env.ALPACA_DATA_SECRET_KEY='FAKE_ATM_SECRET';
 globalThis.fetch=fetchMock;
 try{return await callback();}finally{
  globalThis.fetch=old.fetch;
  if(old.id===undefined)delete process.env.ALPACA_DATA_KEY_ID;
  else process.env.ALPACA_DATA_KEY_ID=old.id;
  if(old.secret===undefined)delete process.env.ALPACA_DATA_SECRET_KEY;
  else process.env.ALPACA_DATA_SECRET_KEY=old.secret;
 }
}
const provider=(data={})=>async url=>{
 const u=new URL(url);
 if(u.pathname.endsWith('/stocks/BBW/trades/latest'))return {ok:true,json:async()=>({
  trade:data.trade===undefined?{p:34.8,t:new Date().toISOString()}:data.trade
 })};
 if(u.pathname.endsWith('/v2/options/contracts'))return {ok:true,json:async()=>({
  option_contracts:data.contracts===undefined?[contract(35,'call'),contract(35,'put'),
   contract(40,'call'),contract(40,'put')]:data.contracts,
  next_page_token:data.next||null
 })};
 if(u.pathname.endsWith('/options/snapshots')){
  const symbols=u.searchParams.get('symbols')?.split(',')||[];
  return {ok:true,json:async()=>({snapshots:Object.fromEntries(symbols.map(symbol=>[
   symbol,{impliedVolatility:symbol.includes('C00035000')?data.callIV??.36:data.putIV??.4,
    latestQuote:{t:new Date().toISOString()}}
  ])),next_page_token:data.snapNext||null})};
 }
 throw Error('Unexpected provider '+url);
};
test('ATM range verifies underlying spot and nearest standard call/put IV, not chosen strike',async()=>{
 const seen=[];
 await withCredentials(async (url,options)=>{
  seen.push(new URL(url));assert.equal(options.headers['APCA-API-KEY-ID'],'FAKE_ATM_TEST');
  return provider()(url);
 },async()=>{
  const out=res();await handler(req({strike:'500',type:'put'}),out);
  assert.equal(out.statusCode,200);assert.equal(out.body.status,'ok');
  assert.equal(out.body.spotUsd,34.8);
  assert.equal(out.body.atmStrike,35);
  assert.equal(out.body.atmIvPct,38);
  assert.equal(out.body.ivMethod,'ATM call/put mean');
  assert.ok(out.body.range.lower<34.8&&out.body.range.upper>34.8);
  const days=(easternCloseMs(expiry())-Date.parse(out.body.checkedAt))/86400000;
  const move=34.8*.38*Math.sqrt(days/365.2425);
  assert.ok(Math.abs(out.body.range.move-move)<.0001);
  assert.ok(Math.abs(out.body.range.lower-(34.8-move))<.0001);
  assert.ok(Math.abs(out.body.range.upper-(34.8+move))<.0001);
  assert.ok(!JSON.stringify(out.body).includes('FAKE_ATM_SECRET'));
 });
 assert.equal(seen.length,3,'stock trade, narrowed contract metadata, two ATM snapshots');
 const stock=seen.find(x=>x.pathname.endsWith('/trades/latest'));
 assert.equal(stock.searchParams.get('feed'),'iex');
 const metadata=seen.find(x=>x.pathname==='/v2/options/contracts');
 assert.ok(metadata.searchParams.has('strike_price_gte'));
 assert.ok(Number(metadata.searchParams.get('strike_price_gte'))<34.8);
 assert.ok(Number(metadata.searchParams.get('strike_price_lte'))>34.8);
 assert.equal(metadata.searchParams.has('strike'),false);
 const snapshots=seen.find(x=>x.pathname.endsWith('/options/snapshots'));
 assert.equal(snapshots.searchParams.get('feed'),'indicative');
 assert.equal(snapshots.searchParams.get('symbols')?.split(',').length,2);
});
test('one valid ATM side is labeled, without substituting other strikes or manual option IV',async()=>{
 await withCredentials(provider({callIV:0,putIV:.42}),async()=>{
  const out=res();await handler(req(),out);
  assert.equal(out.body.status,'ok');assert.equal(out.body.atmIvPct,42);
  assert.equal(out.body.ivMethod,'ATM put IV only');
 });
});
test('no underlying trade returns unavailable and never uses median listed strike as spot',async()=>{
 let calls=0;
 await withCredentials(async url=>{calls++;return {ok:true,json:async()=>({trade:{p:null}})};},async()=>{
  const out=res();await handler(req(),out);
  assert.equal(out.statusCode,200);
  assert.equal(out.body.status,'unavailable');
  assert.match(out.body.reason,/No proxy price used/);
  assert.equal(out.body.range,undefined);
 });
 assert.equal(calls,1);
});
test('missing ATM IV returns unavailable; distant wing IV and adjusted roots never substitute',async()=>{
 await withCredentials(provider({callIV:-.2,putIV:0}),async()=>{
  const out=res();await handler(req(),out);
  assert.equal(out.body.status,'unavailable');
  assert.match(out.body.reason,/no wing-IV fallback/);
  assert.equal(out.body.range,undefined);
 });
 await withCredentials(provider({contracts:[contract(35,'call',true),contract(35,'put',true),
  contract(50,'call'),contract(50,'put')]}),async()=>{
  const out=res();await handler(req(),out);
  assert.equal(out.body.status,'unavailable');
  assert.match(out.body.reason,/No standard near-the-money/);
 });
});
test('stale stock time and incomplete provider pages fail closed',async()=>{
 const stale=new Date(Date.now()-11*86400000).toISOString();
 await withCredentials(provider({trade:{p:34.8,t:stale}}),async()=>{
  const out=res();await handler(req(),out);
  assert.equal(out.body.status,'unavailable');assert.match(out.body.reason,/stale/);
 });
 let count=0;
 await withCredentials(async url=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/trades/latest'))return {ok:true,json:async()=>({trade:{p:34.8}})};
  count++;
  return {ok:true,json:async()=>({option_contracts:[contract(35,'call')],
   next_page_token:'repeat'})};
 },async()=>{
  const out=res();await handler(req(),out);
  assert.equal(out.statusCode,502);assert.equal(out.body.code,'ATM_DATA_UNAVAILABLE');
 });
 assert.ok(count>=2);
});
test('GET-only, valid ticker/expiry, allowed origin, credentials checked',async()=>{
 let out=res();await handler(req({ticker:'../bad'}),out);
 assert.equal(out.statusCode,400);
 out=res();await handler(req({expiry:'2026-99-22'}),out);
 assert.equal(out.statusCode,400);
 out=res();await handler(req({},'POST'),out);
 assert.equal(out.statusCode,405);
 out=res();await handler({...req(),headers:{origin:'https://evil.example'}},out);
 assert.equal(out.statusCode,403);
 const old=process.env.ALPACA_DATA_KEY_ID;delete process.env.ALPACA_DATA_KEY_ID;
 try{
  out=res();await handler(req(),out);
  assert.equal(out.statusCode,503);assert.equal(out.body.code,'NOT_CONFIGURED');
 }finally{if(old!==undefined)process.env.ALPACA_DATA_KEY_ID=old;}
});
test('both panels use the same strike-independent browser cache and unavailable indicator',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const chain=readFileSync(new URL('../lib/chain-view.mjs',import.meta.url),'utf8');
 assert.match(app,/const atmRangeCache=new Map\(\)/);
 assert.match(app,/return \/\^\[A-Z\]\[A-Z0-9\.\-\]\{0,10\}\$\/.test\(ticker\)&&parseDay\(expiry\)\?ticker\+'\|'\+expiry/);
 assert.match(app,/atmRange:expectedRangeDisplay\(idea\)/);
 assert.match(app,/const expectedRange=expectedRangeDisplay\(idea\);/);
 assert.match(app,/data\.spotUsd<=0\|\|data\.atmStrike<=0/);
 assert.match(app,/pendingAtmRanges\.get\(key\)\?\.abort\(\)/);
 assert.match(chain,/data-range-status/);
 assert.match(chain,/chain-atm-range/);
 assert.match(app,/label:'Range unavailable'/);
 assert.doesNotMatch(app,/expectedUnderlyingRange\(\{spot:p\.spot,ivPct:p\.ivPct/);
});
