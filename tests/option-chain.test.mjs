import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import handler from '../api/option-chain.js';
import {buildOCCSymbol} from '../lib/option-preview.mjs';
import {aroundStrike,heatLevels,numericOrNull,symbolBatches} from '../lib/chain-liquidity.mjs';
import {renderChainPanel} from '../lib/chain-view.mjs';

const date=()=>new Date(Date.now()+29*86400000).toISOString().slice(0,10);
const request=(query={},method='GET')=>({method,query:{ticker:'BBW',expiry:date(),strike:'35',...query},headers:{origin:'https://swing-risk-desk-vercel-v11.vercel.app'}});
const response=()=>({statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}});
const makeContract=(strike,type,oi=null)=>({status:'active',underlying_symbol:'BBW',expiration_date:date(),strike_price:String(strike),size:'100',type,
 symbol:buildOCCSymbol({ticker:'BBW',expiry:date(),strike,optionType:type==='call'?'Call':'Put'}),open_interest:oi===null?null:String(oi),open_interest_date:'2026-11-20'});
const withCredentials=async(fetchMock,callback)=>{
 const old={id:process.env.ALPACA_DATA_KEY_ID,secret:process.env.ALPACA_DATA_SECRET_KEY,fetch:globalThis.fetch};
 process.env.ALPACA_DATA_KEY_ID='TEST_OPTION_CHAIN_KEY';process.env.ALPACA_DATA_SECRET_KEY='TEST_ONLY_OPTION_CHAIN_SECRET';globalThis.fetch=fetchMock;
 try{return await callback();}finally{
  globalThis.fetch=old.fetch;
  if(old.id===undefined)delete process.env.ALPACA_DATA_KEY_ID;else process.env.ALPACA_DATA_KEY_ID=old.id;
  if(old.secret===undefined)delete process.env.ALPACA_DATA_SECRET_KEY;else process.env.ALPACA_DATA_SECRET_KEY=old.secret;
 }
};

test('strike range stays centered around chosen strike and OI/volume heat is relative to visible rows',()=>{
 const strikes=Array.from({length:70},(_,i)=>(i+1)*2.5);
 const around=aroundStrike(strikes,35,11);
 assert.equal(around.length,11);assert.ok(around.includes(35));
 assert.equal(around[0],22.5);assert.equal(around.at(-1),47.5);
 assert.deepEqual(aroundStrike([35,35,40,30],35),[30,35,40]);
 assert.equal(numericOrNull(null),null);assert.equal(numericOrNull(''),null);
 assert.equal(numericOrNull('0'),0);assert.equal(numericOrNull('1234'),1234);
 const rows=[2,16,22,45,60].map((n,i)=>({strike:20+i*5,call:{openInterest:n,volume:n*2},put:{openInterest:75-n,volume:n}}));
 const marked=heatLevels(rows);
 assert.equal(marked[3].call.oiHeat,2);
 assert.equal(marked[4].call.oiHeat,3);
 assert.equal(marked[0].put.oiHeat,3);
 assert.equal(marked[4].call.volumeHeat,3);
 assert.equal(marked[4].put.volumeHeat,3);
});

test('read-only API rejects invalid or unconfigured requests and discloses no keys',async()=>{
 const old=process.env.ALPACA_DATA_KEY_ID;delete process.env.ALPACA_DATA_KEY_ID;
 try{
  let r=response();await handler(request(),r);
  assert.equal(r.statusCode,503);assert.equal(r.body.code,'NOT_CONFIGURED');
  r=response();await handler(request({expiry:'2022-01-01'}),r);
  assert.equal(r.statusCode,400);
  r=response();await handler(request({ticker:'../bad'}),r);
  assert.equal(r.statusCode,400);
  r=response();await handler(request({},'POST'),r);
  assert.equal(r.statusCode,405);
  assert.equal(r.headers['Cache-Control'],'no-store, max-age=0');
 }finally{if(old!==undefined)process.env.ALPACA_DATA_KEY_ID=old;}
});

test('server composes both sides from contract OI, indicative snapshots, and most recent delayed-volume session',async()=>{
 const strikes=[25,27.5,30,32.5,35,37.5,40];
 const contracts=strikes.flatMap((n,i)=>[makeContract(n,'call',i*100+50),makeContract(n,'put',i*125+100)]);
 const quotes=Object.fromEntries(contracts.map(c=>[c.symbol,{latestQuote:{bp:1.5,ap:1.75,t:'2026-11-20T19:58:00Z'},impliedVolatility:0.8,greeks:{delta:c.type==='put'?-0.45:0.55}}]));
 const volumeBars=Object.fromEntries(contracts.map((c,i)=>[c.symbol,[{t:'2026-11-20T05:00:00Z',v:i*3}]]));
 const visited=[];
 await withCredentials(async(url,init)=>{
  const u=new URL(String(url));visited.push(u);
  assert.equal(init.headers['APCA-API-KEY-ID'],'TEST_OPTION_CHAIN_KEY');
  if(u.pathname==='/v2/options/contracts')return {ok:true,json:async()=>({option_contracts:contracts,next_page_token:null})};
  if(u.pathname.endsWith('/options/snapshots'))return {ok:true,json:async()=>({snapshots:quotes,next_page_token:null})};
  if(u.pathname.endsWith('/options/bars'))return {ok:true,json:async()=>({bars:volumeBars,next_page_token:null})};
  throw Error('Unexpected URL '+url);
 },async()=>{
  const r=response();await handler(request(),r);
  assert.equal(r.statusCode,200);
  assert.equal(r.body.status,'ok');
  assert.equal(r.body.rows.length,7);
  assert.equal(r.body.rows.find(x=>x.strike===35).call.openInterest,450);
  assert.equal(r.body.rows.find(x=>x.strike===35).put.openInterest,600);
  assert.equal(r.body.rows.find(x=>x.strike===35).put.volume,27);
  assert.equal(r.body.rows.find(x=>x.strike===35).call.bid,1.5);
  assert.equal(r.body.rows.find(x=>x.strike===35).put.delta,-0.45);
  assert.equal(r.body.volumeDate,'2026-11-20');
  assert.equal(r.body.quoteStatus,'indicative');
  assert.equal(r.body.quoteAsOf,'2026-11-20T19:58:00Z');
  assert.equal(r.body.oiDates[0],'2026-11-20');
  assert.equal(r.body.rows.at(-1).put.oiHeat,3);
  assert.ok(!JSON.stringify(r.body).includes('TEST_ONLY_OPTION_CHAIN_SECRET'));
 });
 assert.equal(visited.length,3);
 assert.equal(visited.filter(x=>x.pathname.endsWith('/options/bars')).length,1);
 assert.equal(visited.find(x=>x.pathname.endsWith('/options/bars')).searchParams.get('timeframe'),'1Day');
 assert.equal(visited.find(x=>x.pathname==='/v2/options/contracts').searchParams.get('expiration_date'),date());
});

test('missing volume or quote provider still retains dated OI and no fictitious zero for missing fields',async()=>{
 const c=makeContract(35,'put',28);
 await withCredentials(async url=>{
  const u=new URL(url);
  if(u.pathname==='/v2/options/contracts')return {ok:true,json:async()=>({option_contracts:[c],next_page_token:null})};
  return {ok:false,status:503};
 },async()=>{
  const r=response();await handler(request(),r);
  assert.equal(r.statusCode,200);
  assert.equal(r.body.rows.length,1);
  assert.equal(r.body.rows[0].put.openInterest,28);
  assert.equal(r.body.rows[0].put.volume,null);
  assert.equal(r.body.rows[0].put.bid,null);
  assert.equal(r.body.volumeStatus,'unavailable');
  assert.equal(r.body.quoteStatus,'unavailable');
  assert.equal(r.body.rows[0].put.oiHeat,undefined);
 });
});

test('incomplete metadata pagination never creates misleading liquidity rankings',async()=>{
 let calls=0;
 await withCredentials(async(url)=>{
  calls++;
  return {ok:true,json:async()=>({option_contracts:[makeContract(35,'call',40)],next_page_token:'repeat'})};
 },async()=>{
  const r=response();await handler(request(),r);
  assert.equal(r.statusCode,502);assert.equal(r.body.code,'CONTRACTS_UNAVAILABLE');
  assert.ok(calls>=2);
 });
});

test('chain panel mirrors calls and puts, labels heat as relative, and selects only known contracts',()=>{
 const idea={id:'idea1',ticker:'BBW',expiry:date(),strike:'35',optionType:'Put'};
 const rows=heatLevels([30,32.5,35,37.5].map((strike,i)=>({
  strike,call:{openInterest:i*50+10,volume:i*20+1,bid:1.5,ask:1.8,delta:.35,ivPct:70},
  put:{openInterest:i*40+20,volume:i*30+2,bid:1,ask:1.5,delta:-.35,ivPct:85}
 })));
 const html=renderChainPanel({idea,side:'Put',data:{status:'ok',rows,quoteStatus:'indicative',volumeDate:'2026-11-20',oiDates:['2026-11-20'],displayedStrikeCount:4}});
 for(const text of ['CALLS','PUTS','STRIKE','VOL','OI','BID','ASK','IV','Analyze %','data-action="pick-chain-contract"',
  'data-action="refresh-option-chain"','data-action="chain-show-side"','chain-heat-3','Latest volume session','not OPRA'])
  assert.ok(html.includes(text),'Missing '+text);
 assert.ok(html.includes('data-strike="35"'));
 assert.ok(html.includes('data-side="Put"'));
 assert.ok(!html.includes('TEST_ONLY_OPTION_CHAIN_SECRET'));
});

test('UI adds chain access without replacing Analyze, editing journal records or modifying risk math',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
 const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
 assert.ok(app.includes('data-action="view-option-chain"'));
 assert.ok(app.includes("case 'pick-chain-contract':pickChainContract(el);break;"));
 assert.ok(app.includes("case 'open-chain-analyze':"));
 assert.ok(app.includes("case 'chain-show-side':"));
 assert.ok(app.includes("case 'analyze-idea':"));
 assert.ok(app.includes("if(optionPanelMode==='chain'){renderChainPreview(idea);return;}"));
 assert.ok(app.includes("idea.price='';idea.priceManual=false;"));
 assert.ok(app.includes('const changed=Number(idea.strike)!==strike||idea.optionType!==side;'));
 assert.ok(app.includes('Never carry a stale manually entered premium across a strike/side change'));
 assert.ok(app.includes("if(valid&&!idea.priceManual)idea.price=idea.marketMid"));
 assert.ok(css.includes('.chain-mobile'));
 assert.ok(css.includes('.chain-desktop'));
 assert.ok(sw.includes('/lib/chain-view.mjs'));
 assert.ok(!app.includes('cloudController.saveChain'));
});


test('sparse liquidity marks only first, second and third highest positive cells in each independent column',()=>{
 const rows=Array.from({length:31},(_,i)=>({
  strike:10+i,call:{openInterest:100+i*10,volume:1000-i*11},
  put:{openInterest:3200-i*12,volume:50+i*13}
 }));
 const marked=heatLevels(rows);
 for(const side of ['call','put']){
  for(const key of ['oiHeat','volumeHeat']){
   const active=marked.filter(row=>Number(row[side]?.[key])>0);
   assert.equal(active.length,3,side+'/'+key+' must highlight only three of 31 rows');
   assert.deepEqual(active.map(row=>row[side][key]).sort((a,b)=>b-a),[3,2,1]);
   assert.equal(marked.filter(row=>!row[side]?.[key]).length,28);
  }
 }
 assert.equal(marked[30].call.oiHeat,3);
 assert.equal(marked[29].call.oiHeat,2);
 assert.equal(marked[28].call.oiHeat,1);
 assert.equal(marked[0].call.oiHeat,undefined,'fourth and lower stays unhighlighted');
});

test('equal ranks have equal heat; zeros and missing OI/VOL never get highlights',()=>{
 const rows=[
  {strike:10,call:{openInterest:900,volume:0},put:{openInterest:null,volume:0}},
  {strike:11,call:{openInterest:600,volume:3},put:{openInterest:0,volume:null}},
  {strike:12,call:{openInterest:600,volume:12},put:{openInterest:null,volume:0}},
  {strike:13,call:{openInterest:400,volume:11},put:{openInterest:4,volume:0}},
  {strike:14,call:{openInterest:200,volume:10},put:{openInterest:0,volume:0}},
 ];
 const marked=heatLevels(rows);
 assert.equal(marked[0].call.oiHeat,3);
 assert.equal(marked[1].call.oiHeat,2);
 assert.equal(marked[2].call.oiHeat,2,'tied second place does not imply an artificial third place');
 assert.equal(marked[3].call.oiHeat,undefined);
 assert.equal(marked[0].call.volumeHeat,undefined);
 assert.equal(marked[2].call.volumeHeat,3);
 assert.equal(marked[3].call.volumeHeat,2);
 assert.equal(marked[4].call.volumeHeat,1);
 assert.equal(marked[1].call.volumeHeat,undefined,'fourth place stays uncolored');
 assert.equal(marked[3].put.oiHeat,undefined,'one reported OI value is insufficient to rank a side');
 assert.equal(marked[0].put.volumeHeat,undefined);
 assert.ok(marked.every(row=>row.put.volumeHeat===undefined));
});

test('chain uses an uncluttered table without highest secondary tertiary legend',()=>{
 const idea={id:'i',ticker:'IREN',expiry:date(),strike:'14',optionType:'Call'};
 const rows=heatLevels(Array.from({length:15},(_,i)=>({
  strike:10+i,call:{volume:100+i,openInterest:200+i},
  put:{volume:350-i,openInterest:450-i}
 })));
 const html=renderChainPanel({idea,data:{status:'ok',rows,quoteStatus:'indicative',
  volumeDate:'2026-11-20',oiDates:['2026-11-19'],displayedStrikeCount:15}});
 assert.doesNotMatch(html,/chain-legend|chain-swatch|Highest|Secondary|Tertiary|Heat is relative within displayed strikes/i);
 for(const side of ['call','put']){
  for(const key of ['oiHeat','volumeHeat']){
   assert.equal(rows.filter(row=>Boolean(row[side]?.[key])).length,3);
  }
 }
});


test('All strikes returns every listed standard strike, while Nearby keeps 31 and fetches batched OI/VOL/quotes',async()=>{
 const strikes=Array.from({length:52},(_,i)=>10+i);
 const contracts=strikes.flatMap((strike,i)=>[
  makeContract(strike,'call',i+100),
  makeContract(strike,'put',i+200)
 ]);
 const seen={snapshots:[],bars:[],contracts:0};
 await withCredentials(async url=>{
  const u=new URL(url);
  if(u.pathname==='/v2/options/contracts'){
   seen.contracts++;
   return {ok:true,json:async()=>({option_contracts:contracts,next_page_token:null})};
  }
  const symbols=(u.searchParams.get('symbols')||'').split(',').filter(Boolean);
  if(u.pathname.endsWith('/options/snapshots')){
   seen.snapshots.push(symbols);
   return {ok:true,json:async()=>({snapshots:Object.fromEntries(symbols.map(symbol=>[
    symbol,{latestQuote:{bp:2,ap:2.2,t:'2026-11-20T19:59:00Z'},impliedVolatility:0.8,greeks:{delta:.5}}
   ]))})};
  }
  if(u.pathname.endsWith('/options/bars')){
   seen.bars.push(symbols);
   return {ok:true,json:async()=>({bars:Object.fromEntries(symbols.map(symbol=>[
    symbol,[{t:'2026-11-20T05:00:00Z',v:400}]
   ]))})};
  }
  throw Error('Unexpected API '+url);
 },async()=>{
  const full=response();await handler(request({scope:'all'}),full);
  assert.equal(full.statusCode,200);
  assert.equal(full.body.status,'ok');
  assert.equal(full.body.scope,'all');
  assert.equal(full.body.totalStrikeCount,52);
  assert.equal(full.body.displayedStrikeCount,52);
  assert.deepEqual(full.body.rows.map(row=>row.strike),strikes);
  assert.equal(full.body.rows[51].call.openInterest,151);
  assert.equal(full.body.rows[51].put.openInterest,251);
  assert.equal(full.body.rows[51].put.volume,400);
  assert.equal(full.body.rows[0].call.bid,2);
  assert.equal(full.body.volumeStatus,'available');
  assert.equal(full.body.quoteStatus,'indicative');
  assert.equal(full.body.rows.filter(r=>r.call.oiHeat>0).length,3);
  assert.equal(full.body.rows.filter(r=>r.put.oiHeat>0).length,3);
  assert.equal(full.body.rows[51].call.oiHeat,3);
  assert.equal(seen.snapshots.length,2,'full chain snapshots must be batched');
  assert.equal(seen.bars.length,2,'full chain daily volume must be batched');
  assert.equal(seen.snapshots.flat().length,104);
  assert.equal(seen.bars.flat().length,104);
  assert.ok(seen.snapshots.every(group=>group.length<=75));
  assert.ok(seen.bars.every(group=>group.length<=75));
  const compact=response();await handler(request(),compact);
  assert.equal(compact.statusCode,200);
  assert.equal(compact.body.scope,'nearby');
  assert.equal(compact.body.displayedStrikeCount,31);
  assert.equal(compact.body.totalStrikeCount,52);
  assert.equal(compact.body.rows.find(row=>row.strike===35)?.strike,35);
 });
 const invalid=response();await handler(request({scope:'none'}),invalid);
 assert.equal(invalid.statusCode,400);
 assert.equal(invalid.body.code,'BAD_SCOPE');
 assert.deepEqual(symbolBatches([1,2,3,4,5],2),[[1,2],[3,4],[5]]);
});

test('if any full-chain data batch fails, all listed strikes and dated OI survive without partial-volume rankings',async()=>{
 const strikes=Array.from({length:45},(_,i)=>10+i);
 const contracts=strikes.flatMap(strike=>[makeContract(strike,'call',100+strike),makeContract(strike,'put',200+strike)]);
 let barsRequested=0,snapsRequested=0;
 await withCredentials(async url=>{
  const u=new URL(url);
  if(u.pathname==='/v2/options/contracts')return {ok:true,json:async()=>({option_contracts:contracts,next_page_token:null})};
  if(u.pathname.endsWith('/options/snapshots')){
   snapsRequested++;
   if(snapsRequested===2)return {ok:false,status:503};
   const symbols=(u.searchParams.get('symbols')||'').split(',');
   return {ok:true,json:async()=>({snapshots:Object.fromEntries(symbols.map(symbol=>[
    symbol,{latestQuote:{bp:1.2,ap:1.3},impliedVolatility:.6}
   ]))})};
  }
  if(u.pathname.endsWith('/options/bars')){
   barsRequested++;
   if(barsRequested===2)return {ok:false,status:503};
   const symbols=(u.searchParams.get('symbols')||'').split(',');
   return {ok:true,json:async()=>({bars:Object.fromEntries(symbols.map(symbol=>[
    symbol,[{t:'2026-11-20T00:00:00Z',v:111}]
   ]))})};
  }
  throw Error('Unexpected URL '+url);
 },async()=>{
  const out=response();await handler(request({scope:'all'}),out);
  assert.equal(out.statusCode,200);
  assert.equal(out.body.rows.length,45);
  assert.equal(out.body.rows[0].call.openInterest,110);
  assert.equal(out.body.rows[0].call.volume,null);
  assert.equal(out.body.rows[0].call.bid,null);
  assert.equal(out.body.volumeStatus,'unavailable');
  assert.equal(out.body.quoteStatus,'unavailable');
  assert.ok(out.body.rows.every(row=>row.call.volumeHeat===undefined),'never rank incomplete volume');
 });
 assert.equal(barsRequested,2);
 assert.equal(snapsRequested,2);
});

test('all-strikes control is subtle, reversible and does not resurrect removed heat legend',()=>{
 const idea={id:'plan',ticker:'IREN',expiry:date(),strike:'14',optionType:'Put'};
 const rows=heatLevels(Array.from({length:45},(_,i)=>({strike:10+i,
  call:{openInterest:100+i,volume:200+i},put:{openInterest:900-i,volume:850-i}
 })));
 const data={status:'ok',rows,scope:'all',displayedStrikeCount:45,quoteStatus:'indicative',
  oiDates:['2026-11-20'],volumeDate:'2026-11-20'};
 const full=renderChainPanel({idea,data,side:'Put',scope:'all'});
 const nearby=renderChainPanel({idea,data:{...data,displayedStrikeCount:31},side:'Put',scope:'nearby'});
 assert.match(full,/data-action="toggle-chain-range"/);
 assert.match(full,/aria-pressed="true"/);
 assert.match(full,/Nearby strikes/);
 assert.match(full,/Showing all 45 listed standard strikes/);
 assert.match(nearby,/All strikes/);
 assert.match(nearby,/aria-pressed="false"/);
 assert.match(nearby,/Showing 31 nearby strikes/);
 assert.doesNotMatch(full,/chain-legend|chain-swatch|Highest|Secondary|Tertiary|Heat is relative within displayed strikes/i);
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(app,/case 'toggle-chain-range':/);
 assert.match(app,/optionChainRange=optionChainRange==='all'\?'nearby':'all'/);
 assert.match(app,/scope:parts\[3\]/);
 assert.match(app,/optionPanelMode='chain';if\(opening\)optionChainRange='nearby'/);
});

test('expiry-first option chain works with blank strike and centers nearby rows on underlying spot',async()=>{
 const contracts=Array.from({length:65},(_,i)=>makeContract(i+10,'put',20+i));
 const visited=[];
 await withCredentials(async url=>{
  const u=new URL(url);visited.push(u);
  if(u.pathname==='/v2/options/contracts')return {ok:true,json:async()=>({option_contracts:contracts,next_page_token:null})};
  if(u.pathname.endsWith('/stocks/BBW/snapshot'))return {ok:true,json:async()=>({latestTrade:{p:52}})};
  if(u.pathname.endsWith('/options/snapshots'))return {ok:true,json:async()=>({snapshots:{},next_page_token:null})};
  if(u.pathname.endsWith('/options/bars'))return {ok:true,json:async()=>({bars:{},next_page_token:null})};
  throw Error('Unexpected provider URL '+url);
 },async()=>{
  const nearby=response();await handler(request({strike:''}),nearby);
  assert.equal(nearby.statusCode,200);assert.equal(nearby.body.status,'ok');
  assert.equal(nearby.body.centerStrike,52);
  assert.equal(nearby.body.centerSource,'latest IEX underlying price');
  assert.equal(nearby.body.displayedStrikeCount,31);
  assert.equal(nearby.body.rows.find(x=>x.strike===52).put.openInterest,62);
  const whole=response();await handler(request({strike:'',scope:'all'}),whole);
  assert.equal(whole.statusCode,200);
  assert.equal(whole.body.displayedStrikeCount,65);
  assert.equal(whole.body.scope,'all');
 });
 assert.equal(visited.filter(u=>u.pathname.endsWith('/stocks/BBW/snapshot')).length,1);
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.ok(app.includes("(rawStrike?strike:'')"));
 assert.ok(app.includes("if(parts[2])qs.set('strike',parts[2]);"));
 assert.ok(app.includes("case 'pick-chain-contract':pickChainContract(el);break;"));
});

test('chain expiration header shows shared ATM range before strike selection, with unavailable safeguard',()=>{
 const idea={id:'sample',ticker:'BBW',expiry:date(),strike:'',optionType:'Call'};
 const ok={state:'ok',label:'ATM 1σ underlying: $30.00–$40.00 (±$5.00, 14.3%)',
  title:'Actual IEX $35 and nearest standard ATM strike $35'};
 const html=renderChainPanel({idea,atmRange:ok,loading:true});
 assert.match(html,/class="chain-atm-range"/);
 assert.match(html,/data-expected-range/);
 assert.match(html,/data-range-status="ok"/);
 assert.match(html,/30\.00–\$40\.00/);
 assert.ok(html.indexOf('chain-atm-range')<html.indexOf('Loading strike ladder'));
 const missing=renderChainPanel({idea,atmRange:{state:'unavailable',label:'Range unavailable',title:'No spot price'},data:null});
 assert.match(missing,/Range unavailable/);
 assert.match(missing,/data-range-status="unavailable"/);
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(app,/atmRange:expectedRangeDisplay\(idea\)/);
 assert.match(app,/case 'refresh-option-chain':void ensureAtmRange\(currentPreviewIdea\(\),true\)/);
 assert.match(app,/function atmRangeKey\(idea\)/);
 assert.match(app,/ticker\+'\|'\+expiry/);
 const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
 assert.match(css,/\.chain-date-range-row\{/);
 assert.match(css,/\.chain-atm-range\[data-range-status="unavailable"\]/);
});
