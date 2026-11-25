import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyPreview,projectOptionReturns,easternCloseMs,expiryDayColumns,expectedUnderlyingRange} from '../lib/option-preview.mjs';
import {modelPositionAnalysis} from '../lib/position-analysis.mjs';
const day='2026-11-25',asOf='2026-11-25T17:00:00Z';
const contract={ticker:'NVDA',expiry:'2026-11-27',strike:185,optionType:'Call'};
const preview={...emptyPreview(day),dates:['2026-11-27'],spot:'183',ivPct:'80',bid:'1.6',ask:'1.8',targets:[{id:'stop',name:'Stop',price:'180'},{id:'tp1',name:'TP1',price:'184.5'},{id:'tp2',name:'TP2',price:'187'}]};
const input={contract,preview,qty:2,entryPremium:1.8,entryFeeUsd:2,sellFeePerContractUsd:1,asOf};
const calc=(overrides={})=>projectOptionReturns({...input,...overrides});
test('future Black Friday expiration automatically expands to 10 AM, 11 AM, noon and 1 PM ET',()=>{
 const result=calc();
 assert.equal(result.valid,true);assert.equal(result.intraday,null);assert.equal(result.hasExpiryDayTimes,true);
 assert.equal(result.expiryCutoffLabel,'1 PM ET');
 assert.deepEqual(result.columns.map(c=>c.date),['2026-11-27T15:00:00.000Z','2026-11-27T16:00:00.000Z','2026-11-27T17:00:00.000Z','2026-11-27T18:00:00.000Z']);
 assert.equal(easternCloseMs(contract.expiry),Date.parse('2026-11-27T18:00:00Z'));
 assert.deepEqual(preview.dates,['2026-11-27']);
});
test('near-strike OTM option retains morning time value; at expiration only intrinsic remains',()=>{
 const result=calc(),otm=result.rows.find(r=>r.id==='tp1').values,itm=result.rows.find(r=>r.id==='tp2').values;
 assert.ok(otm[0].modelPremium>0);assert.ok(otm[0].returnPct>-100);
 assert.equal(otm.at(-1).modelPremium,0);assert.equal(otm.at(-1).intrinsicPremium,0);
 assert.equal(itm.at(-1).modelPremium,2);assert.equal(itm.at(-1).intrinsicPremium,2);
 assert.ok(itm.at(-1).returnPct>-100);
 assert.equal(itm.at(-1).dateAtExpiry,true);
 assert.ok(itm.slice(0,-1).every(x=>x.modelPremium>=x.intrinsicPremium));
});
test('standard equity/ETF quote calibration cannot erase intrinsic value before expiry',()=>{
 const v=calc({preview:{...preview,spot:'200',bid:'0.01',ask:'0.03',targets:[{id:'tp',name:'TP',price:'190'}]}});
 assert.equal(v.valid,true);assert.ok(v.rows[1].values.every(x=>x.modelPremium>=5));
 const put=calc({contract:{...contract,optionType:'Put'},preview:{...preview,spot:'160',bid:'0.01',ask:'0.03',targets:[{id:'tp',name:'TP',price:'180'}]}});
 assert.ok(put.rows[1].values.every(x=>x.modelPremium>=5));
 assert.equal(calc({preview:{...preview,bid:'0',ask:'0'}}).quoted,false);
});
test('normal future expiration uses normal close and other dates keep one column each',()=>{
 const normal={...contract,expiry:'2026-12-04'},result=calc({contract:normal,preview:{...preview,dates:['2026-11-27','2026-12-04']}});
 assert.equal(result.columns.length,5);
 assert.equal(result.columns[0].t,Date.parse('2026-11-27T18:00:00Z'));
 assert.deepEqual(result.columns.slice(1).map(c=>c.date),['2026-12-04T15:00:00.000Z','2026-12-04T17:00:00.000Z','2026-12-04T19:00:00.000Z','2026-12-04T21:00:00.000Z']);
 assert.deepEqual(expiryDayColumns('2027-06-18').map(c=>c.t).slice(-1),[Date.parse('2027-06-18T20:00:00Z')]);
});
test('same-day mode remains minute-based and never projects past the early close',()=>{
 const r=calc({asOf:'2026-11-27T17:45:00Z'});
 assert.ok(r.intraday);assert.equal(r.hasExpiryDayTimes,false);assert.equal(r.intraday.remainingMinutes,15);
 assert.deepEqual(r.rows[0].values.map(c=>c.valid),[true,true,false,false,true]);
});
test('holiday or custom closed date is unavailable; future expected range uses 1 PM cutoff',()=>{
 const r=calc({contract:{...contract,expiry:'2026-12-04'},preview:{...preview,dates:['2026-11-26','2026-11-27']},closed:['2026-11-27']});
 assert.ok(r.rows[0].values.every(x=>!x.valid&&x.reason==='Market closed on selected date'));
 const range=expectedUnderlyingRange({spot:183,ivPct:80,expiry:contract.expiry,asOf});
 assert.equal(range.cutoffLabel,'1 PM ET');assert.ok(Math.abs(range.days*24-49)<1e-8);
});
test('recorded position scenario gets identical future expiry horizons using actual basis',()=>{
 const r=modelPositionAnalysis({contract,preview,asOf,basis:{qty:2,price:1.8,fee:2,sellFee:1}});
 assert.equal(r.valid,true);assert.equal(r.baseCostUsd,362);assert.equal(r.columns.length,4);
 assert.equal(r.rows[3].values.at(-1).intrinsicPremium,2);
 assert.deepEqual(r.columns.map(c=>c.date),calc().columns.map(c=>c.date));
});
