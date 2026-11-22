import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import handler from '../api/option-chain.js';
import {buildOCCSymbol} from '../lib/option-preview.mjs';
import {aroundStrike,heatLevels,numericOrNull} from '../lib/chain-liquidity.mjs';
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
 assert.ok(app.includes("if(!idea.priceManual)idea.price=''"));
 assert.ok(css.includes('.chain-mobile'));
 assert.ok(css.includes('.chain-desktop'));
 assert.ok(sw.includes('/lib/chain-view.mjs'));
 assert.ok(!app.includes('cloudController.saveChain'));
});
