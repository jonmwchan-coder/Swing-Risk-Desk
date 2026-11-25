import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDraftMarketQuote,markDraftQuoteFailed} from '../lib/planner-workflows.mjs';
import {calculatePlanBasket,defaultPlanIdea} from '../lib/planner.mjs';
import {emptyPreview} from '../lib/option-preview.mjs';

const day='2026-11-25',symbol='SMH261218C00350000';
const idea=(extra={})=>({...defaultPlanIdea('d'),ticker:'SMH',expiry:'2026-12-18',strike:'350',qty:'2',price:'1.50',priceManual:true,fee:'2',plannedLossPct:'35',preview:{...emptyPreview(day),targets:[{id:'stop',name:'Stop',price:'340'},{id:'tp1',name:'TP1',price:'365'},{id:'tp2',name:'TP2',price:'380'}],dates:['2026-11-27','2026-12-01'],intradayMinutes:[3,15]},...extra});
const quote={symbol,spotUsd:352,ivPct:42,optionBidUsd:1.8,optionAskUsd:2,quoteAt:'2026-11-25T17:00:00Z',provider:'Alpaca indicative'};
const account={id:'a',fx:1.4,stressPct:70,mode:'stress',roundStep:25};

test('explicit premium refresh replaces a manual price, recalculates sizing, and preserves all plan fields',()=>{
 const d=idea(),before=calculatePlanBasket([d],account,1000),saved=JSON.stringify({targets:d.preview.targets,dates:d.preview.dates,minutes:d.preview.intradayMinutes,qty:d.qty,loss:d.plannedLossPct,expiry:d.expiry,strike:d.strike});
 const r=applyDraftMarketQuote(d,quote,symbol,{useMidpoint:true});
 assert.equal(r.valid,true);assert.equal(d.price,'1.9');assert.equal(d.priceManual,false);assert.equal(d.marketMid,'1.9');assert.equal(d.preview.spot,'352');assert.equal(d.preview.ivPct,'42');assert.equal(d.preview.bid,'1.8');assert.equal(d.preview.ask,'2');assert.equal(d.preview.quoteAt,quote.quoteAt);
 assert.equal(JSON.stringify({targets:d.preview.targets,dates:d.preview.dates,minutes:d.preview.intradayMinutes,qty:d.qty,loss:d.plannedLossPct,expiry:d.expiry,strike:d.strike}),saved);
 const after=calculatePlanBasket([d],account,1000);assert.ok(after.plannedReserveCad>before.plannedReserveCad);assert.ok(after.remainingCad<before.remainingCad);
});
test('analysis refresh preserves manual purchase premium and broker-entered IV',()=>{
 const d=idea();d.preview.ivManual=true;d.preview.ivPct='55';
 applyDraftMarketQuote(d,quote,symbol);
 assert.equal(d.price,'1.50');assert.equal(d.priceManual,true);assert.equal(d.preview.ivPct,'55');assert.equal(d.marketMid,'1.9');
 assert.match(d.quoteMessage,/manual buy premium retained/);
});
test('automatic premium updates unless the user changed it manually while waiting',()=>{
 const d=idea({priceManual:false});applyDraftMarketQuote(d,quote,symbol);assert.equal(d.price,'1.9');
 const edited=idea({price:'2.25',priceManual:true});
 applyDraftMarketQuote(edited,quote,symbol,{useMidpoint:true,initialPrice:'1.50',initialManual:true});
 assert.equal(edited.price,'2.25');assert.equal(edited.priceManual,true);
});
test('wrong exact contract response cannot mutate idea',()=>{
 const d=idea(),before=JSON.stringify(d);
 assert.throws(()=>applyDraftMarketQuote(d,{...quote,symbol:'OTHER'},symbol),/did not match/);
 assert.equal(JSON.stringify(d),before);
});
test('missing data and invalid spread do not fabricate quote or replace existing premium',()=>{
 for(const inputs of [{optionBidUsd:null},{optionAskUsd:1},{optionBidUsd:0},{optionBidUsd:undefined}]){
  const d=idea();d.preview.spot='350';d.preview.ivPct='40';
  const r=applyDraftMarketQuote(d,{...quote,spotUsd:null,ivPct:null,...inputs},symbol,{useMidpoint:true});
  assert.equal(r.valid,false);assert.equal(d.price,'1.50');assert.equal(d.priceManual,true);assert.equal(d.marketMid,'');
  assert.equal(d.quoteStatus,'unavailable');assert.equal(d.preview.spot,'');assert.equal(d.preview.ivPct,'');
 }
});
test('failure preserves prior planned premium, target assumptions and last quote time, while visibly warning',()=>{
 const d=idea();applyDraftMarketQuote(d,quote,symbol,{useMidpoint:true});const before=JSON.stringify(d.preview.targets);
 markDraftQuoteFailed(d,new Error('timeout'));
 assert.equal(d.price,'1.9');assert.equal(d.quoteStatus,'unavailable');assert.equal(d.preview.quoteAt,quote.quoteAt);
 assert.match(d.preview.quoteSource,/previous reference/);assert.match(d.quoteMessage,/timeout/);assert.equal(JSON.stringify(d.preview.targets),before);
});
