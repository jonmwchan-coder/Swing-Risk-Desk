import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyPreview,normalizePreview,parseExpiryDayTimes,expiryDayTimeSelection,scenarioProjectionGroups,projectOptionReturns} from '../lib/option-preview.mjs';
import {modelPositionAnalysis,captureDraftAnalysis,workingAnalysisPreview} from '../lib/position-analysis.mjs';
import {savePlannerDrafts,loadPlannerDrafts} from '../lib/planner-storage.mjs';
const contract={ticker:'NVDA',expiry:'2026-11-27',strike:185,optionType:'Call'};
const at='2026-11-25T15:00:00Z';
const preview={...emptyPreview('2026-11-25'),spot:'183',ivPct:'80',bid:'1.6',ask:'1.8',dates:['2026-11-25','2026-11-26'],targets:[{id:'tp1',name:'TP1',price:'187'}]};
const calc=(extra={})=>projectOptionReturns({contract,preview,qty:2,entryPremium:1.8,entryFeeUsd:2,sellFeePerContractUsd:1,asOf:at,includeExpiryDay:true,...extra});
test('future expiry section is available independently of selected daily dates and skips closed sessions',()=>{
 const r=calc(),g=scenarioProjectionGroups(r,contract);
 assert.equal(r.valid,true);assert.equal(r.expiryDaySelected,false);assert.deepEqual(g.daily,[0]);assert.deepEqual(g.excluded,[1]);assert.deepEqual(g.expiry,[2,3,4,5]);
 assert.deepEqual(g.expiry.map(i=>r.columns[i].date),['2026-11-27T15:00:00.000Z','2026-11-27T16:00:00.000Z','2026-11-27T17:00:00.000Z','2026-11-27T18:00:00.000Z']);
 assert.deepEqual(preview.dates,['2026-11-25','2026-11-26']);
 const selected=calc({preview:{...preview,dates:[...preview.dates,contract.expiry]}}),sg=scenarioProjectionGroups(selected,contract);
 assert.equal(selected.expiryDaySelected,true);assert.deepEqual(sg,g);assert.deepEqual(selected.rows,r.rows);
});
test('custom clock times validated and exact early-close horizon appended',()=>{
 assert.deepEqual(parseExpiryDayTimes('12:15, 09:30','2026-11-27'),['09:30','12:15']);
 for(const value of ['13:00','14:00','09:29','10:60','10:00,10:00','9:30',''])assert.equal(parseExpiryDayTimes(value,contract.expiry),null);
 const p={...preview,expiryDayTimes:['09:45','12:15']},r=calc({preview:p}),g=scenarioProjectionGroups(r,contract);
 assert.deepEqual(g.expiry.map(i=>r.columns[i].date),['2026-11-27T14:45:00.000Z','2026-11-27T17:15:00.000Z','2026-11-27T18:00:00.000Z']);
 assert.equal(r.rows[1].values.at(-1).intrinsicPremium,2);assert.deepEqual(p.expiryDayTimes,['09:45','12:15']);
});
test('normal-day saved times do not leak past early close and default reset is safe',()=>{
 const normal=expiryDayTimeSelection('2026-12-04',['14:00','15:30']);
 assert.deepEqual(normal.times,['14:00','15:30']);
 const early=expiryDayTimeSelection(contract.expiry,['14:00','15:30']);
 assert.deepEqual(early.times,['10:00','11:00','12:00']);assert.deepEqual(early.excluded,['14:00','15:30']);assert.equal(early.usesDefaults,true);
 assert.deepEqual(expiryDayTimeSelection(contract.expiry,['11:00','14:00']).times,['11:00']);
 assert.deepEqual(normalizePreview({...preview,expiryDayTimes:['14:00','10:00']},'2026-11-25').expiryDayTimes,['10:00','14:00']);
 assert.deepEqual(normalizePreview(preview,'2026-11-25').expiryDayTimes,[]);
});
test('same-day 0DTE keeps only minute offsets; index roots do not acquire a new unsupported expiry mode',()=>{
 const r=calc({asOf:'2026-11-27T16:00:00Z',preview:{...preview,expiryDayTimes:['09:45'],intradayMinutes:[3,17]}});
 const g=scenarioProjectionGroups(r,contract);
 assert.deepEqual(g.intraday,[0,1,2]);assert.deepEqual(g.expiry,[]);assert.deepEqual(g.daily,[]);assert.equal(r.columns[0].label,'+3m');
 const index={...contract,ticker:'SPXW'},q=calc({contract:index});
 assert.equal(q.hasExpiryDayTimes,false);assert.deepEqual(scenarioProjectionGroups(q,index).expiry,[]);
});
test('recorded position and planned trade use identical split columns and unchanged acquisition basis',()=>{
 const r=calc(),p=modelPositionAnalysis({contract,preview,asOf:at,basis:{qty:2,price:1.8,fee:2,sellFee:1},includeExpiryDay:true});
 assert.deepEqual(p.columns,r.columns);assert.deepEqual(p.rows,r.rows);assert.equal(p.baseCostUsd,362);
});
test('custom closed expiry and after-expiry dates are omitted from displayed sections, without changing saved plans',()=>{
 const p={...preview,dates:['2026-11-25','2026-11-27','2026-11-30']},r=calc({preview:p,closed:['2026-11-27']});
 const g=scenarioProjectionGroups(r,contract);
 assert.deepEqual(g.daily,[0]);assert.deepEqual(g.expiry,[]);assert.deepEqual(g.excluded,[1,2]);assert.equal(p.dates.length,3);
});
