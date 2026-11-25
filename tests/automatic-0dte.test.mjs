import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyPreview,normalizePreview,parseIntradayMinutes,intradayTiming,projectOptionReturns,easternCloseMs,blackScholes} from '../lib/option-preview.mjs';
import {captureDraftAnalysis,workingAnalysisPreview,modelPositionAnalysis,appendAnalysisRevision,currentAnalysisBasis} from '../lib/position-analysis.mjs';
import {calculatePosition} from '../lib/risk.mjs';
import {normalizePlannerDrafts} from '../lib/planner-storage.mjs';

const day='2026-11-25',at='2026-11-25T15:00:00Z';
const contract={ticker:'QQQ',expiry:day,strike:600,optionType:'Call'};
const preview={...emptyPreview(day),spot:'600',ivPct:'25',bid:'2.90',ask:'3.10',quoteAt:'2026-11-25T14:55:00Z',targets:[{id:'stop',name:'Stop',price:'598'},{id:'tp1',name:'TP1',price:'602'},{id:'tp2',name:'TP2',price:'604'}]};
const calc=(overrides={})=>projectOptionReturns({contract,preview,qty:2,entryPremium:3.1,entryFeeUsd:2,sellFeePerContractUsd:1,asOf:at,...overrides});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('same-day contract automatically ignores swing dates and uses editable minute offsets',()=>{
 const out=calc();
 assert.equal(out.valid,true);assert.ok(out.intraday);assert.equal(out.intraday.remainingMinutes,360);
 assert.deepEqual(out.columns.map(c=>c.label),['+5m','+15m','+30m','+60m','Close']);
 assert.equal(out.columns[0].date,'2026-11-25T15:05:00.000Z');
 assert.equal(out.columns.at(-1).date,'2026-11-25T21:00:00.000Z');
 assert.equal(out.rows.length,4);assert.equal(out.rows[0].values.length,5);
 assert.equal(out.baseCostUsd,622);assert.equal(out.quoteAgeMinutes,5);
 const custom=calc({preview:{...preview,intradayMinutes:[20,2,10]}});
 assert.deepEqual(custom.columns.map(c=>c.label),['+2m','+10m','+20m','Close']);
});
test('same model reprices nonlinear decay; targets and fees remain meaningful',()=>{
 const o=calc();
 const noMove=o.rows[0].values;
 assert.ok(noMove[0].modelPremium>noMove[1].modelPremium);
 assert.ok(noMove[1].modelPremium>noMove[3].modelPremium);
 assert.ok(o.rows[2].values[0].returnPct>o.rows[1].values[0].returnPct);
 assert.equal(o.rows[3].values.at(-1).modelPremium,4);
 const close=o.rows[3].values.at(-1);
 near(close.netUsd,(4-.1)*200-2-622);
 near(close.returnPct,close.netUsd/622*100);
 assert.deepEqual(o.thetaIntraday.map(v=>v.minutes),[5,15,30]);
 assert.ok(o.thetaIntraday.every(v=>v.usdPerContract<0));
});
test('minutes beyond cutoff unavailable, exact close valid, at/after close rejected',()=>{
 const o=calc({asOf:'2026-11-25T20:50:00Z',preview:{...preview,intradayMinutes:[5,10,15,30]}});
 assert.deepEqual(o.rows[0].values.map(v=>v.valid),[true,true,false,false,true]);
 assert.equal(o.rows[0].values[2].reason,'After same-day model cutoff');
 assert.equal(o.thetaIntraday[1].usdPerContract,null);
 assert.equal(o.rows[2].values[1].dateAtExpiry,true);
 for(const t of ['2026-11-25T21:00:00Z','2026-11-25T23:00:00Z','2026-11-26T00:10:00Z'])assert.equal(calc({asOf:t}).valid,false);
});
test('ET date, DST, official early-close days and custom closures are respected',()=>{
 const early={...contract,expiry:'2026-11-27'},t='2026-11-27T17:50:00Z';
 const timing=intradayTiming(early,t);assert.equal(timing.cutoffLabel,'1 PM ET');assert.equal(timing.remainingMinutes,10);
 const o=calc({contract:early,asOf:t});assert.equal(o.valid,true);assert.equal(o.rows[0].values[1].valid,false);
 assert.equal(calc({contract:early,asOf:'2026-11-27T18:01:00Z'}).valid,false);
 const summer={...contract,expiry:'2027-06-16'};
 assert.equal(intradayTiming(summer,'2027-06-16T15:00:00Z').cutoffMs,Date.parse('2027-06-16T20:00:00Z'));
 assert.equal(intradayTiming(summer,'2027-06-17T00:30:00Z').expired,true);
 assert.equal(intradayTiming(summer,'2027-06-17T04:01:00Z'),null);
 assert.equal(calc({closed:[day]}).valid,false);
 assert.equal(calc({contract:{...contract,expiry:'2026-11-26'},asOf:'2026-11-26T15:00:00Z'}).valid,false);
});
test('premarket columns explicitly identified; unsupported index roots fail closed',()=>{
 const o=calc({asOf:'2026-11-25T14:20:00Z'});
 assert.equal(o.intraday.beforeOpen,true);assert.equal(o.columns[0].beforeOpen,true);assert.equal(o.columns[1].beforeOpen,false);
 for(const ticker of ['SPX','SPXW','NDX','VIX'])assert.match(calc({contract:{...contract,ticker}}).reason,/index option settlement/);
});
test('non-expiration swing dates retain one column each, with the correct session close',()=>{
 const future={...contract,expiry:'2026-12-04'};
 const dates=['2026-11-27','2026-12-01'];
 const o=calc({contract:future,preview:{...preview,dates,intradayMinutes:[5,15]}});
 assert.equal(o.valid,true);assert.equal(o.intraday,null);assert.deepEqual(o.dateHeaders,dates);
 assert.equal(o.columns[0].t,easternCloseMs(dates[0]));
 assert.equal(o.thetaIntraday.length,0);
});
test('interval preferences validate, persist independently and older drafts retain swing dates',()=>{
 assert.deepEqual(parseIntradayMinutes('30, 5, 15'),[5,15,30]);
 for(const invalid of ['', '5,5','-1','0','1.5','1441','5,','1,2,3,4,5,6,7',[true],[null]])assert.equal(parseIntradayMinutes(invalid),null);
 const v=normalizePreview({...preview,intradayMinutes:[7,21]},day);
 assert.deepEqual(v.intradayMinutes,[7,21]);assert.deepEqual(v.dates,preview.dates);
 const old={...preview};delete old.intradayMinutes;
 assert.deepEqual(normalizePreview(old,day).intradayMinutes,[5,15,30,60]);
 const drafts=normalizePlannerDrafts({a:[{id:'d',...contract,preview:v}]});
 assert.deepEqual(drafts.a[0].preview.intradayMinutes,[7,21]);
});
test('recorded 0DTE entry and saved revisions use captured time and actual basis; current view stays independent',()=>{
 const account={id:'a',fx:1.4,stressPct:70,mode:'stress',roundStep:25,sellFeePerContractUsd:1};
 const fill={id:'f',date:day,time:'10:00',qty:2,price:3.1,fee:2,fx:1.4};
 const p={...contract,id:'p',accountId:'a',fills:[fill],exits:[]};
 const d={...contract,draftId:'d',analysisCapturedAt:at,preview:{...preview,intradayMinutes:[3,17]}};
 const e=captureDraftAnalysis(p,d,fill,account,at);
 d.preview.intradayMinutes[0]=99;
 assert.deepEqual(e.preview.intradayMinutes,[3,17]);
 const recorded=modelPositionAnalysis({contract:e.contract,preview:e.preview,basis:e.basis,asOf:e.capturedAt});
 assert.equal(recorded.valid,true);assert.equal(recorded.columns[0].date,'2026-11-25T15:03:00.000Z');assert.equal(recorded.baseCostUsd,622);
 const working=workingAnalysisPreview(p,day).preview;
 assert.deepEqual(working.intradayMinutes,[3,17]);assert.equal(working.quoteAt,'');
 const basis=currentAnalysisBasis(p,calculatePosition(p,account,day),account,day);
 const later=appendAnalysisRevision(p,{...working,spot:'601',ivPct:'25',intradayMinutes:[2,8]},basis,'rev','2026-11-25T16:00:00Z');
 assert.equal(modelPositionAnalysis({contract:later.contract,preview:later.preview,basis:later.basis,asOf:later.capturedAt}).columns[0].date,'2026-11-25T16:02:00.000Z');
 assert.deepEqual(p.analysisHistory[0].preview.intradayMinutes,[3,17]);
});
