import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import handler from '../api/option-expirations.js';
import {buildOCCSymbol} from '../lib/option-preview.mjs';
import {expirationLookupKey,normalizeListedDates,expirationListingStatus,nearestListedExpirations,regularExpirationKind,onlyRegularListedDates} from '../lib/expiry-listings.mjs';

const today=()=>new Date().toISOString().slice(0,10);
const after=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const req=(query={ticker:'BBW',type:'put'},method='GET')=>({query,method,headers:{origin:'https://swing-risk-desk-vercel-v11.vercel.app'}});
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

test('read-only ticker/type expiration API validates input without credentials or strike',async()=>{
 const old=process.env.ALPACA_DATA_KEY_ID;delete process.env.ALPACA_DATA_KEY_ID;
 try{
  let out=res();await handler(req(),out);
  assert.equal(out.statusCode,503);assert.equal(out.body.code,'NOT_CONFIGURED');
  out=res();await handler(req({ticker:'../bad',type:'put'}),out);
  assert.equal(out.statusCode,400);
  out=res();await handler(req({ticker:'BBW',type:'invalid'}),out);
  assert.equal(out.statusCode,400);
  out=res();await handler(req(undefined,'POST'),out);
  assert.equal(out.statusCode,405);
  assert.equal(out.headers['Cache-Control'],'no-store, max-age=0');
 }finally{if(old!==undefined)process.env.ALPACA_DATA_KEY_ID=old;}
});

test('All mode discovers active standard expirations across strikes/pages without requiring strike',async()=>{
 const first=after(30),second=after(43),seen=[];
 await withCredentials(async url=>{
  const u=new URL(url);seen.push(u);
  if(!u.searchParams.get('page_token'))return {ok:true,json:async()=>({
   option_contracts:[contract(first),{...contract(first),symbol:'ADJUSTED'+contract(first).symbol},
    contract(after(31),'Call'),contract(after(32),'Put','ABC',35)],next_page_token:'next-page'
  })};
  return {ok:true,json:async()=>({option_contracts:[contract(second,'Put','BBW',35)],next_page_token:null})};
 },async()=>{
  const out=res();await handler(req({ticker:'BBW',type:'put',scope:'all'}),out);
  assert.equal(out.statusCode,200);
  assert.equal(out.body.status,'verified');
  assert.deepEqual(out.body.expirations,[first,second]);
  assert.equal(out.body.type,'put');
  assert.equal(out.body.strike,undefined);
  assert.equal(seen.length,2);
  const q=seen[0].searchParams;
  assert.equal(q.get('underlying_symbols'),'BBW');
  assert.equal(q.has('strike_price_gte'),false);
  assert.equal(q.has('strike_price_lte'),false);
  assert.equal(q.get('type'),'put');
  assert.equal(q.get('status'),'active');
  assert.equal(q.get('expiration_date_gte'),today());
  assert.ok(q.has('expiration_date_lte'));
 });
});

test('empty active listing is verified empty, provider failure is not reported as zero dates',async()=>{
 await withCredentials(async()=>({ok:true,json:async()=>({option_contracts:[],next_page_token:null})}),async()=>{
  const out=res();await handler(req({ticker:'BBW',type:'put',scope:'all'}),out);
  assert.equal(out.statusCode,200);assert.deepEqual(out.body.expirations,[]);
 });
 await withCredentials(async()=>({ok:false,status:503}),async()=>{
  const out=res();await handler(req({ticker:'BBW',type:'put',scope:'all'}),out);
  assert.equal(out.statusCode,502);assert.equal(out.body.code,'RESULT_INCOMPLETE');
 });
});

test('expiration lookup key depends on ticker/type, never strike',()=>{
 assert.equal(expirationLookupKey({ticker:'bbw',strike:'30',optionType:'Put'}),'BBW|Put');
 assert.equal(expirationLookupKey({ticker:'BBW',strike:'',optionType:'Put'}),'BBW|Put');
 assert.equal(expirationLookupKey({ticker:'BBW',strike:'30.0001',optionType:'Put'}),'BBW|Put');
 assert.equal(expirationLookupKey({ticker:'BBW',strike:'',optionType:'Call'}),'BBW|Call');
 assert.equal(expirationLookupKey({ticker:'',optionType:'Put'}),'');
 assert.equal(expirationLookupKey({ticker:'BBW',optionType:'Option'}),'');
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
 for(const snippet of ['Checking dates','Not listed','Lookup unavailable','Choose listed expiration',
  'name="listedExpiry"','__manual__','data-expiration-field','data-listing-badge',
  'data-action="refresh-listed-expirations"','ensureListedExpirations','showInlineQuoteLoading','mini-spin'])
  assert.ok(app.includes(snippet),'Missing '+snippet);
 assert.ok(!app.includes('✓ Expiry listed'),'successful lookup should not clutter the contract header');
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


test('Quick size check contract row is ticker -> type -> expiration -> strike',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const start=app.indexOf('<div class="draft-contract-fields">');
 assert.ok(start>0);
 const row=app.slice(start,start+1100);
 const indices=['name="ticker"','name="optionType"','expirationField(idea)','name="strike"'].map(x=>row.indexOf(x));
 assert.ok(indices.every(i=>i>=0));
 assert.deepEqual([...indices].sort((a,b)=>a-b),indices);
 assert.ok(row.includes('placeholder="Choose in chain"'));
 assert.ok(!row.includes('<input type="date" name="expiry"'),'no extra calendar');
});

test('both mobile and desktop show verified-only dropdown by default, never an arbitrary native calendar',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
 const start=app.indexOf('function expirationField(idea){');
 const end=app.indexOf('function updateListingCard(idea)',start);
 assert.ok(start>=0&&end>start);
 const field=app.slice(start,end);
 assert.ok(field.includes('const manual=manualExpiryIds.has(idea.id);'));
 assert.ok(!field.includes('const manual=manualExpiryIds.has(idea.id)||!selectable;'));
 assert.ok(field.includes('if(manual){'),'native date input exists ONLY in opt-in manual branch');
 assert.ok(field.indexOf('input type="date"')>field.indexOf('if(manual){'));
 assert.ok(field.indexOf('input type="date"')<field.indexOf('}else{'));
 assert.ok(field.includes('select name="listedExpiry"'));
 assert.ok(field.includes('const disabled=!verified||!dates.length'));
 assert.ok(field.includes('<option value="" disabled selected>'));
 assert.ok(field.includes('Enter ticker first'));
 assert.ok(field.includes('Checking listed dates…'));
 assert.ok(field.includes('Unable to verify · Retry'));
 assert.ok(field.includes('No listed dates for this contract'));
 assert.ok(field.includes('Choose listed expiration…'));
 assert.ok(field.includes('· Not listed'));
 assert.ok(field.includes('Enter date manually (unverified)…'));
 assert.ok(field.includes('data-action="enter-manual-expiry"'));
 assert.ok(field.includes('data-action="use-listed-expirations"'));
 assert.ok(field.includes('data-action="refresh-listed-expirations"'));
 assert.ok(app.includes("case 'enter-manual-expiry'"));
 assert.ok(app.includes("if(e.target.value==='__manual__')"));
 assert.ok(app.includes("manualExpiryIds.add(node.dataset.draftId)"));
 assert.ok(app.includes("manualExpiryIds.delete(el.dataset.planId)"));
 assert.ok(app.includes("if(['ticker','optionType'].includes(name))manualExpiryIds.delete(idea.id);"),
  'new ticker/strike/direction should go back to verified-only dropdown');
 assert.ok(app.includes('data-expiration-field'));
 assert.match(css,/\.draft-expiration-field select:disabled/);
 assert.match(css,/@media\(max-width:690px\)/);
});

test('verified selection updates quote and risk from a still-connected hidden expiry field',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const start=app.indexOf('function applyListedExpiry(ideaId,date){');
 const end=app.indexOf('function renderPlanner(m){',start);
 const code=app.slice(start,end);
 assert.ok(code.includes('listing.expirations.includes(date)'), 'only verified dates may be selected');
 assert.ok(code.includes("wrapper.dataset.dispatchingExpiry='true'"));
 assert.ok(code.includes("field.dispatchEvent(new Event('input',{bubbles:true}))"));
 assert.ok(code.includes("field.dispatchEvent(new Event('change',{bubbles:true}))"));
 assert.ok(code.indexOf("field.dispatchEvent(new Event('input',{bubbles:true}))")<
  code.indexOf("field.dispatchEvent(new Event('change',{bubbles:true}))"));
 assert.ok(code.includes('delete wrapper.dataset.dispatchingExpiry'));
 assert.ok(app.includes("field.dataset.dispatchingExpiry!=='true'"));
 const handler=app.slice(app.indexOf("$('quickPlanner').addEventListener('change'"));
 assert.ok(handler.includes("if(draftContract(idea))"));
 assert.ok(handler.includes("void refreshDraftPremium(idea)"));
 assert.ok(handler.includes("void refreshOptionQuote()"));
});

test('calendar labels weekly, holiday-shifted weekly, monthly and quarter-end regular dates',()=>{
 assert.equal(regularExpirationKind('2026-12-18'),'weekly'); // Third Friday monthly
 assert.equal(regularExpirationKind('2026-12-31'),'quarterly'); // Calendar quarter end
 assert.equal(regularExpirationKind('2027-03-31'),'quarterly');
 assert.equal(regularExpirationKind('2027-03-25'),'weekly'); // Good Friday 3/26 is closed
 assert.equal(regularExpirationKind('2026-11-27'),'weekly'); // Friday after Thanksgiving
 assert.equal(regularExpirationKind('2026-12-17'),null); // ordinary daily
 assert.equal(regularExpirationKind('2026-12-25'),null); // market closed
 assert.deepEqual(onlyRegularListedDates(['2026-12-17','2026-12-18','2026-12-31','2026-12-18']),['2026-12-18','2026-12-31']);
 const filtered={status:'verified',scope:'regular',checkedFrom:'2026-12-01',checkedThrough:'2027-12-01',expirations:['2026-12-18']};
 assert.equal(expirationListingStatus('2026-12-17',filtered),'filtered');
 assert.equal(expirationListingStatus('2026-12-18',filtered),'listed');
 assert.equal(expirationListingStatus('2027-12-17',filtered),'outside-range');
});

test('Regular discovers verified dates by ticker/type only; All restores special dates',async()=>{
 const dates=['2026-12-17','2026-12-18','2026-12-31'],seen=[];
 await withCredentials(async url=>{
  const u=new URL(url);seen.push(u);
  const day=u.searchParams.get('expiration_date');
  const listed=day?dates.filter(d=>d===day):dates;
  return {ok:true,json:async()=>({option_contracts:listed.map(d=>contract(d)),next_page_token:null})};
 },async()=>{
  const regular=res();await handler(req({ticker:'BBW',type:'put',scope:'regular'}),regular);
  assert.equal(regular.statusCode,200);
  assert.equal(regular.body.scope,'regular');
  assert.deepEqual(regular.body.expirations,['2026-12-18','2026-12-31']);
  assert.ok(Date.parse(regular.body.checkedThrough)-Date.parse(regular.body.checkedFrom)<370*86400000);
  const every=res();await handler(req({ticker:'BBW',type:'put',scope:'all'}),every);
  assert.equal(every.statusCode,200);assert.equal(every.body.scope,'all');
  assert.deepEqual(every.body.expirations,dates);
  assert.ok(Date.parse(every.body.checkedThrough)-Date.parse(every.body.checkedFrom)>1000*86400000);
  assert.ok(seen.length>10,'regular probes check individual dates without downloading every strike');
  assert.ok(seen.every(u=>!u.searchParams.has('strike_price_gte')&&!u.searchParams.has('strike_price_lte')));
  assert.ok(seen.some(u=>u.searchParams.get('expiration_date')==='2026-12-18'));
  assert.ok(seen.some(u=>u.searchParams.get('limit')==='10000'));
 });
 const invalid=res();await handler(req({ticker:'BBW',type:'put',scope:'wrong'}),invalid);
 assert.equal(invalid.statusCode,400);assert.equal(invalid.body.code,'BAD_SCOPE');
});

test('regular-only checkbox defaults on, labels regular dates, and has separate lookup caches',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
 const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
 assert.match(app,/let regularExpiriesOnly=true;/);
 assert.match(app,/const scopedExpirationKey=idea/);
 assert.match(app,/data\.scope!==scope/);
 assert.match(app,/name="regularExpiriesOnly"/);
 assert.match(app,/Regular only/);
 assert.match(app,/\(Regular\)/);
 assert.match(app,/status==='filtered'/);
 assert.match(app,/Hidden by filter/);
 assert.match(app,/case 'refresh-listed-expirations'/);
 assert.match(app,/if\(e\.target\.name==='regularExpiriesOnly'\)/);
 assert.match(app,/regularExpiriesOnly=next/);
 assert.match(app,/renderPlanner\(analytics\(\)\)/);
 assert.match(app,/scope\}\);/);
 assert.match(css,/\.expiry-regular-toggle/);
 assert.match(sw,/swing-risk-desk-shell-v3\.12-contract-identity/);
 assert.match(html,/SWING RISK DESK \/ v3\.12 clear contract identity/);
});

test('refresh can restart a stalled expiration request; strike edits never refetch dates',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
 assert.ok(app.includes('pendingListingRequests.get(key)?.controller.abort()'));
 assert.ok(app.includes("setTimeout(()=>controller.abort(),12500)"));
 assert.ok(app.includes('data-action="refresh-listed-expirations"'));
 assert.ok(app.includes('expiry-refresh-icon'));
 assert.ok(app.includes("const [ticker,type,scope]=key.split('|')"));
 assert.ok(!app.includes('strike:String(Number(strike)),type:type.toLowerCase(),scope'));
 assert.ok(app.includes("if(['ticker','optionType'].includes(name))queueListedExpirations(idea);"));
 assert.ok(app.includes("if(['ticker','optionType'].includes(e.target.name))queueListedExpirations(idea,true);"));
 assert.ok(!app.includes("if(['ticker','strike','optionType'].includes(name))queueListedExpirations(idea);"));
 assert.ok(css.includes('.expiry-select-row'));
 assert.ok(css.includes('.expiry-refresh-icon'));
});

test('quick size check shows buy fees alone and clearer remaining risk label without altering calculations',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.ok(app.includes('<span>Estimated buy fees (USD)</span><strong>${usd(r.fee)}</strong>'));
 assert.ok(app.includes('<span>Remaining Risk Budget (CAD)</span><strong>${cad(r.remainingCad)}</strong>'));
 assert.ok(!app.includes('<span>Est. total cash to buy (USD)</span>'));
 assert.ok(app.includes('Total cash to buy all ideas · premiums + fees (USD)'),'detailed portfolio breakdown retains complete debit');
});