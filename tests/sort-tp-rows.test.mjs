import test from 'node:test';
import assert from 'node:assert/strict';
import {sortScenarioRows,emptyPreview,projectOptionReturns,scenarioProjectionGroups} from '../lib/option-preview.mjs';

test('new lower TP moves into numeric ascending order without renaming or mutating targets',()=>{
 const rows=[{id:'no-move',spotPrice:145},{id:'stop',spotPrice:143},...['147','147.5','150','146'].map((x,i)=>({id:'tp'+(i+1),name:'TP'+(i+1),spotPrice:Number(x),values:[{returnPct:i}]}))];
 const before=JSON.stringify(rows),sorted=sortScenarioRows(rows);
 assert.deepEqual(sorted.map(x=>x.id),['no-move','stop','tp4','tp1','tp2','tp3']);
 assert.deepEqual(sorted.slice(2).map(x=>x.spotPrice),[146,147,147.5,150]);
 assert.equal(sorted[2],rows[5]);
 assert.equal(sorted[2].values[0].returnPct,3);
 assert.equal(JSON.stringify(rows),before);
});
test('blank or invalid targets last, equal prices stable; no move and stop stay pinned',()=>{
 const rows=[{id:'no-move',spotPrice:150},{id:'stop',spotPrice:155},{id:'tp1',spotPrice:null},{id:'tp2',spotPrice:147.5},{id:'tp3',spotPrice:147.5},{id:'tp4',spotPrice:146},{id:'tp5',spotPrice:-1},{id:'tp6',spotPrice:9},{id:'tp7',spotPrice:100}];
 assert.deepEqual(sortScenarioRows(rows).map(r=>r.id),['no-move','stop','tp6','tp7','tp4','tp2','tp3','tp1','tp5']);
 assert.deepEqual(sortScenarioRows([]),[]);
});
test('daily, future-expiry and 0DTE projections retain every computed cell for calls and puts',()=>{
 const targets=[{id:'stop',name:'Stop',price:'144'},...['147','147.5','150','146'].map((price,i)=>({id:'tp'+(i+1),name:'TP'+(i+1),price}))];
 const p={...emptyPreview('2026-11-25'),spot:'145',ivPct:'50',bid:'2',ask:'2.2',dates:['2026-11-25','2026-11-27'],targets};
 for(const optionType of ['Call','Put'])for(const asOf of ['2026-11-25T15:00:00Z','2026-11-27T15:00:00Z']){
  const contract={ticker:'NVDA',optionType,strike:147,expiry:'2026-11-27'};
  const r=projectOptionReturns({contract,preview:p,qty:2,entryPremium:2.2,asOf,includeExpiryDay:true});
  assert.equal(r.valid,true);
  const sorted=sortScenarioRows(r.rows);
  assert.deepEqual(sorted.map(x=>x.id),['no-move','stop','tp4','tp1','tp2','tp3']);
  for(const row of sorted)assert.equal(row,r.rows.find(x=>x.id===row.id));
  const g=scenarioProjectionGroups(r,contract);
  for(const indices of [g.daily,g.expiry,g.intraday])for(const row of sorted)for(const i of indices)assert.equal(row.values[i],r.rows.find(x=>x.id===row.id).values[i]);
 }
 assert.deepEqual(p.targets.slice(1).map(x=>x.price),['147','147.5','150','146']);
});
