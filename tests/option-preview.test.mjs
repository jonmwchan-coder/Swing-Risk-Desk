import test from 'node:test';
import assert from 'node:assert/strict';
import {blackScholes,buildOCCSymbol,emptyPreview,normalizePreview,projectOptionReturns,standardPreviewDates,easternCloseMs} from '../lib/option-preview.mjs';
const contract={ticker:'INTC',strike:70,expiry:'2027-01-15',optionType:'Call'};
const current=new Date('2026-11-19T15:00:00Z');
const withPreview=(overrides={},option=contract)=>projectOptionReturns({contract:option,preview:{...emptyPreview('2026-11-19'),spot:'70',ivPct:'50',bid:'5.0',ask:'5.2',targets:[{id:'stop',name:'Stop',price:'65'},{id:'tp1',name:'TP1',price:'80'}],dates:['2026-11-20','2026-11-23'],...overrides},qty:2,entryPremium:5.2,entryFeeUsd:1.54,sellFeePerContractUsd:1,asOf:current});
test('Black Scholes call and put reference and put-call parity',()=>{
 const call=blackScholes({spot:100,strike:100,years:1,iv:.2,rate:.05});
 const put=blackScholes({spot:100,strike:100,years:1,iv:.2,rate:.05,type:'Put'});
 assert.ok(Math.abs(call-10.4506)<0.001);
 assert.ok(Math.abs(put-5.5735)<0.001);
 assert.ok(Math.abs(call-put-(100-100*Math.exp(-.05)))<0.001);
});
test('intrinsic value at expiry, no negative option values',()=>{
 assert.equal(blackScholes({spot:110,strike:100,years:0,iv:0.8,type:'Call'}),10);
 assert.equal(blackScholes({spot:90,strike:100,years:0,iv:0.8,type:'Put'}),10);
 assert.equal(blackScholes({spot:90,strike:100,years:0,iv:0.8,type:'Call'}),0);
 assert.equal(blackScholes({spot:-1,strike:100,years:1,iv:.2,type:'Put'}),null);
});
test('date-aware model includes fee-inclusive % and calendar-time theta across Friday-Monday',()=>{
 const out=withPreview();assert.equal(out.valid,true);assert.equal(out.baseCostUsd,1041.54);
 assert.ok(out.thetaNextCalendarDayUsdPerContract<0);
 assert.deepEqual(out.dateHeaders,['2026-11-20','2026-11-23']);
 assert.equal(out.rows[0].name,'No stock move');
 const noMove=out.rows[0].values;assert.ok(noMove[1].modelPremium<noMove[0].modelPremium);
 const tp=out.rows[2].values;assert.ok(tp[0].returnPct>out.rows[1].values[0].returnPct);
 assert.ok(Math.abs(out.spread-0.2)<1e-9);
 assert.equal(out.quoted,true);assert.ok(Math.abs(out.anchorMid-5.1)<0.000001);
 assert.ok(out.rows[0].values[0].returnPct<0,'unchanged underlying after entry at ask should not falsely appear profitable when bid/ask quoted');
 assert.ok(Math.abs(tp[0].usedHalfSpreadUsd-.1)<1e-9);
 assert.equal(tp[0].totalCostUsd,1041.54);
});
test('fixed IV does NOT drift to a guess as dates change; user-added TP and dates are arbitrary',()=>{
 const out=withPreview({ivPct:'31.9',dates:['2026-11-23','2026-12-07','2027-01-15'],targets:[{id:'custom',name:'TP3',price:'88'}]});
 assert.equal(out.valid,true);assert.equal(out.ivPct,31.9);assert.equal(out.rows.length,2);
 assert.equal(out.rows[1].values.length,3);
 assert.equal(out.rows[1].values[2].dateAtExpiry,true);
 assert.ok(Math.abs(out.rows[1].values[2].modelPremium-18)<.01);
});
test('invalid contract, old exit, no premium, bad spot or missing IV never generate fabricated returns',()=>{
 assert.match(withPreview({ivPct:''}).reason,/IV/);
 assert.match(withPreview({spot:'0'}).reason,/current underlying/);
 assert.match(withPreview({dates:['2027-02-01']}).rows[0].values[0].reason,/After expiry/);
 assert.equal(projectOptionReturns({contract,preview:emptyPreview('2026-11-19'),qty:2,entryPremium:0}).valid,false);
 assert.equal(buildOCCSymbol({ticker:'BAD',expiry:'not-a-day',strike:100,optionType:'Call'}),null);
});
test('OCC formatter and DST-safe 4pm ET conversion',()=>{
 assert.equal(buildOCCSymbol(contract),'INTC270115C00070000');
 assert.equal(easternCloseMs('2026-11-20'),Date.parse('2026-11-20T21:00:00Z'));
 assert.equal(easternCloseMs('2027-03-15'),Date.parse('2027-03-15T20:00:00Z'));
});
test('next 2 NYSE sessions skip holiday and weekend, but model uses calendar days for time',()=>{
 assert.deepEqual(standardPreviewDates('2026-11-25'),['2026-11-27','2026-11-30']);
 assert.deepEqual(standardPreviewDates('2026-11-19'),['2026-11-20','2026-11-23']);
});
test('preview storage is bounded and preserves only valid field values',()=>{
 const p=normalizePreview({spot:'10',ivPct:'41',dates:['2026-11-20','2026-11-20','invalid'],targets:[{id:'tp3',name:'TP3',price:'20'}]},'2026-11-19');
 assert.deepEqual(p.dates,['2026-11-20']);assert.equal(p.targets[0].name,'TP3');
});

test('manual IV provenance persists across local draft serialization and missing-data refreshes',()=>{
 const original=emptyPreview('2026-11-19');
 assert.equal(original.ivManual,false);
 const manual=normalizePreview({...original,ivPct:'48.3',ivManual:true},'2026-11-19');
 assert.equal(manual.ivManual,true);
 assert.equal(manual.ivPct,'48.3');
 assert.equal(normalizePreview(manual,'2026-11-19').ivManual,true);
 assert.equal(normalizePreview({...manual,ivManual:false},'2026-11-19').ivManual,false);
});

test('without bid or ask, user proposed entry is an unverified anchor rather than an invented real quote',()=>{const out=withPreview({bid:'',ask:''});assert.equal(out.valid,true);assert.equal(out.quoted,false);assert.match(out.anchorLabel,/UNVERIFIED/);assert.equal(out.anchorMid,5.2);});
