import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import handler from '../api/option-expirations.js';
import {buildOCCSymbol} from '../lib/option-preview.mjs';
import {expirationLookupKey,normalizeListedDates,expirationListingStatus,nearestListedExpirations} from '../lib/expiry-listings.mjs';

const today=()=>new Date().toISOString().slice(0,10);
const after=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const req=(query={ticker:'BBW',strike:'30',type:'put'},method='GET')=>({query,method,headers:{origin:'https://swing-risk-desk-vercel-v11.vercel.app'}});
const res=()=>({statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}});
const contract=(expiry,type='Put',ticker='BBW',strike=30)=>({
 symbol:buildOCCSymbol({ticker,expiry,strike,optionType:type}),
 status:'active',expiration_date:expiry,type:type.toLowerCase(),underlying_symbol:ticker,strike_price:String(strike),size:100
});
function withCredentials(fetchMock,fn){
 const before={id:process.env.ALPACA_DATA_KEY_ID,secret:process.env.ALPACA_DATA_SECRET_KEY,fetch:globalThis.fetch};
 process.env.ALPACA_DATA_KEY_ID='FAKE_TEST_ONLY';process.env.ALPACA_DATA_SECRET_KEY='FAKE_TEST_ONLY';
 globalThis.fetch=fetchMock;
 return Promise.resolve().then(fn).finally(()=>{
  globalThis.fetch=before.fetch;
  if(before.id===undefined)delete process.env.ALPACA_DATA_KEY_ID;else process.env.ALPACA_DATA_KEY_ID=before.id;
  if(before.secret===undefined)delete process.env.ALPACA_DATA_SECRET_KEY;else process.env.ALPACA_DATA_SECRET_KEY=before.secret;
 });
}

test('read-only option expiration API validates input without Alpaca credentials',async()=>{
 const old=process.env.ALPACA_DATA_KEY_ID;delete process.env.ALPACA_DATA_KEY_ID;
 try{
  let out=res();await handler(req(),out);
  assert.equal(out.statusCode,503);assert.equal(out.body.code,'NOT_CONFIGURED');
  out=res();await handler(req({ticker:'BBW',strike:'bad',type:'put'}),out);
  assert.equal(out.statusCode,400);
  out=res();await handler(req(undefined,'POST'),out);
  assert.equal(out.statusCode,405);
  assert.equal(out.headers['Cache-Control'],'no-store, max-age=0');
 }finally{if(old!==undefined)process.env.ALPACA_DATA_KEY_ID=old;}
});

test('listing API enumerates every active standard expiration for exact BBW strike/type across pages, including unusual dates',async()=>{
 const first=after(30),second=after(43),seen=[];
 await withCredentials(async url=>{
  const u=new URL(url);seen.push(u);
  if(!u.searchParams.get('page_token'))return {ok:true,json:async()=>({
   option_contracts:[contract(first),{...contract(first),symbol:'ADJUSTED'+contract(first).symbol},
    contract(after(31),'Call'),contract(after(32),'Put','BBW',35)],next_page_token:'next-page'
  })};
  return {ok:true,json:async()=>({option_contracts:[contract(second)],next_page_token:null})};
 },async()=>{
  const out=res();await handler(req(),out);
  assert.equal(out.statusCode,200);
  assert.equal(out.body.status,'verified');
  assert.deepEqual(out.body.expirations,[first,second]);
  assert.equal(out.body.strike,30);assert.equal(out.body.type,'put');
  assert.equal(seen.length,2);
  const q=seen[0].searchParams;
  assert.equal(q.get('underlying_symbols'),'BBW');
  assert.equal(q.get('strike_price_gte'),'30');
  assert.equal(q.get('strike_price_lte'),'30');
  assert.equal(q.get('type'),'put');
  assert.equal(q.get('status'),'active');
  assert.equal(q.get('expiration_date_gte'),today());
  assert.ok(q.has('expiration_date_lte'),'Alpaca defaults to next weekend if lte omitted');
 });
});

test('empty active listing is verified empty but provider failure never claims nonexistent',async()=>{
 await withCredentials(async()=>({ok:true,json:async()=>({option_contracts:[],next_page_token:null})}),async()=>{
  const out=res();await handler(req(),out);
  assert.equal(out.statusCode,200);assert.deepEqual(out.body.expirations,[]);
 });
 await withCredentials(async()=>({ok:false,status:503}),async()=>{
  const out=res();await handler(req(),out);
  assert.equal(out.statusCode,502);assert.equal(out.body.code,'PROVIDER_UNAVAILABLE');
 });
});

test('only exact ticker, positive strike and side produce listing keys',()=>{
 assert.equal(expirationLookupKey({ticker:'bbw',strike:'30',optionType:'Put'}),'BBW|30.000|Put');
 assert.equal(expirationLookupKey({ticker:'BBW',strike:'',optionType:'Put'}),'');
 assert.equal(expirationLookupKey({ticker:'BBW',strike:'30.0001',optionType:'Put'}),'');
 assert.equal(expirationLookupKey({ticker:'BBW',strike:'30',optionType:'Option'}),'');
});

test('dates are sorted and status distinguishes not-listed from provider failure',()=>{
 const dates=['2026-12-18','2026-12-16','2026-12-18'];
 assert.deepEqual(normalizeListedDates(dates),['2026-12-16','2026-12-18']);
 const listing={status:'verified',checkedFrom:'2026-11-22',checkedThrough:'2028-11-22',expirations:normalizeListedDates(dates)};
 assert.equal(expirationListingStatus('2026-12-16',listing),'listed');
 assert.equal(expirationListingStatus('2026-12-17',listing),'not-listed');
 assert.equal(expirationListingStatus('2030-12-18',listing),'outside-range');
 assert.equal(expirationListingStatus('2026-12-17',{status:'error',expirations:[]}), 'unverified');
 assert.equal(expirationListingStatus('',listing),'unselected');
 assert.deepEqual(nearestListedExpirations(listing.expirations,'2026-12-17',2),['2026-12-16','2026-12-18']);
});

test('UI discloses loading, listed, not-listed, unavailable, and direct alternatives',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
 const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
 for(const snippet of ['Checking dates','Not listed','Lookup unavailable','✓ Listed','Choose expiration',
  'name="listedExpiry"','__manual__','data-expiration-field','data-listing-badge',
  'data-action="refresh-listed-expirations"','ensureListedExpirations','showInlineQuoteLoading','mini-spin'])
  assert.ok(app.includes(snippet),'Missing '+snippet);
 assert.ok(app.includes("field.dispatchEvent(new Event('change',{bubbles:true}))"));
 assert.ok(app.includes('function expirationField(idea)'));
 assert.ok(app.includes('data-action="use-listed-expirations"'));
 assert.ok(!app.includes('function listingPanel(idea)'));
 assert.ok(!app.includes('data-listing-panel'));
 assert.ok(!css.includes('.draft-listing-panel{'));
 assert.match(css,/prefers-reduced-motion/);
 assert.match(css,/\.mini-spin/);
 assert.ok(sw.includes('/lib/expiry-listings.mjs'));
});


test('contract row has exactly one contextual expiration control after ticker/strike/type',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const start=app.indexOf('<div class="draft-contract-fields">');
 assert.ok(start>0);
 const row=app.slice(start,start+900);
 const indices=['name="ticker"','name="strike"','name="optionType"','expirationField(idea)'].map(x=>row.indexOf(x));
 assert.ok(indices.every(i=>i>=0));
 assert.deepEqual([...indices].sort((a,b)=>a-b),indices);
 assert.ok(!row.includes('<input type="date" name="expiry"'),'no separate always-visible calendar');
 assert.ok(!row.includes('listingPanel(idea)'),'no duplicate listed-expiration panel');
});

test('verified dates replace manual picker; fallback is explicit and non-destructive',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const start=app.indexOf('function expirationField(idea){');
 const end=app.indexOf('function updateListingCard(idea)',start);
 const field=app.slice(start,end);
 assert.ok(field.includes('if(!manual)'));
 assert.ok(field.includes('select name="listedExpiry"'));
 assert.ok(field.includes('input type="date" name="expiry"'));
 assert.ok(field.includes('<input type="hidden" name="expiry"'));
 assert.ok(field.includes('manualExpiryIds.has(idea.id)'));
 assert.ok(field.includes('disabled selected'));
 assert.ok(field.includes('Enter date manually…'));
 assert.ok(field.includes('expirationListingStatus'));
 assert.ok(app.includes("if(e.target.value==='__manual__')"));
 assert.ok(app.includes("manualExpiryIds.add(node.dataset.draftId)"));
 assert.ok(app.includes("manualExpiryIds.delete(el.dataset.planId)"));
 assert.ok(app.includes("field.dispatchEvent(new Event('input',{bubbles:true}))"));
 assert.ok(app.includes("field.dispatchEvent(new Event('change',{bubbles:true}))"));
});
