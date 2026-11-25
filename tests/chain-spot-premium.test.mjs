import test from 'node:test';
import assert from 'node:assert/strict';
import {chainSpotLocation,renderChainPanel} from '../lib/chain-view.mjs';
import {seedDraftFromChainQuote,applyDraftMarketQuote,markDraftQuoteFailed} from '../lib/planner-workflows.mjs';
const idea=()=>({id:'r',ticker:'RIOT',expiry:'2026-11-27',optionType:'Call',strike:'18',price:'',priceManual:false,preview:{targets:[{id:'tp1',name:'TP1',price:'19'}],dates:['2026-11-25']}});
const symbol='RIOT261127C00018000',at='2026-11-25T18:00:00Z';
const rows=[16,17,18].map(strike=>({strike,call:{symbol:strike===18?symbol:'other',bid:.4,ask:.6,ivPct:60,quoteAt:at},put:{bid:.5,ask:.7}}));
const data={ticker:'RIOT',expiry:'2026-11-27',underlyingSpotUsd:16.87,underlyingAt:at,underlyingSource:'IEX last trade',rows,quoteStatus:'indicative'};
test('price marker is inserted at actual spot, including exact match and outside range',()=>{
 assert.deepEqual(chainSpotLocation(rows,16.87),{index:1,relation:'between'});
 assert.deepEqual(chainSpotLocation(rows,17),{index:1,relation:'at'});
 assert.deepEqual(chainSpotLocation(rows,15),{index:0,relation:'below'});
 assert.deepEqual(chainSpotLocation(rows,19),{index:3,relation:'above'});
 for(const spot of [null,undefined,0,NaN,'16.87'])assert.equal(chainSpotLocation(rows,spot),null);
});
test('both desktop and mobile render distinct spot and selected markers',()=>{
 const html=renderChainPanel({idea:idea(),data,side:'Call'});
 assert.equal((html.match(/class="chain-spot-marker"/g)||[]).length,2);
 assert.equal((html.match(/class="chain-selected-row"/g)||[]).length,2);
 assert.match(html,/RIOT underlying \$16\.87/);
 assert.match(html,/Selected contract: \$18 Call/);
 assert.match(html,/IEX last trade/);
 const tables=html.split('<tbody>').slice(1);
 for(const table of tables){
  assert.ok(table.indexOf('chain-strike">16')<table.indexOf('chain-spot-marker"'));
  assert.ok(table.indexOf('chain-spot-marker"')<table.indexOf('chain-strike">17'));
 }
 assert.match(html,/colspan="15"/);assert.match(html,/colspan="7"/);
});
test('missing underlying never fabricates a marker or selected-strike price',()=>{
 const html=renderChainPanel({idea:idea(),data:{...data,underlyingSpotUsd:null}});
 assert.doesNotMatch(html,/class="chain-spot-marker"/);
 assert.match(html,/underlying unavailable/);assert.match(html,/Selected contract: \$18 Call/);
});
test('recent exact-contract chain midpoint seeds blank price without changing targets',()=>{
 const d=idea(),before=JSON.stringify(d.preview.targets);
 assert.equal(seedDraftFromChainQuote(d,data,rows[2],'Call',symbol,at),true);
 assert.equal(Number(d.price),.5);assert.equal(d.priceManual,false);assert.equal(Number(d.preview.spot),16.87);
 assert.equal(d.preview.quoteAt,at);assert.equal(JSON.stringify(d.preview.targets),before);
 markDraftQuoteFailed(d,new Error('Timeout'));
 assert.equal(Number(d.price),.5);assert.equal(d.quoteStatus,'unavailable');
});
test('seed rejects wrong contracts, stale/undated/missing quotes and manual premium',()=>{
 const now='2026-11-25T18:16:00Z';
 assert.equal(seedDraftFromChainQuote(idea(),data,rows[2],'Call',symbol,now),false);
 for(const rec of [{symbol:'OTHER'},{quoteAt:null},{bid:null},{bid:0},{ask:.1}]){
  const d=idea(),row={...rows[2],call:{...rows[2].call,...rec}};
  assert.equal(seedDraftFromChainQuote(d,data,row,'Call',symbol,at),false);assert.equal(d.price,'');
 }
 const d={...idea(),price:'0.75',priceManual:true};
 assert.equal(seedDraftFromChainQuote(d,data,rows[2],'Call',symbol,at),false);assert.equal(d.price,'0.75');
 assert.equal(seedDraftFromChainQuote(idea(),{...data,expiry:'2026-12-04'},rows[2],'Call',symbol,at),false);
});
