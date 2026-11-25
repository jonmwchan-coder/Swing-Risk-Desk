import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePosition,sortPositions,POSITION_SORT_MODES} from '../lib/risk.mjs';
const account={fx:1.4,mode:'stress',stressPct:70,roundStep:25};
const day='2026-11-25';
const fill=(id,date,time,qty=1)=>({id,date,time,qty,price:2,fee:1,fx:1.4});
const exit=(id,date,time,pnl,qty=1)=>({...fill(id,date,time,qty),brokerPnlCad:pnl});
const pos=(id,fills,exits=[])=>({id,ticker:id,fills,exits});
const raw=[
 pos('old-winner',[fill('a','2026-11-10','10:00')],[exit('b','2026-11-18','10:00',300)]),
 pos('open-partial',[fill('c','2026-11-12','10:00',2)],[exit('d','2026-11-25','11:00',-30)]),
 pos('new-loser',[fill('e','2026-11-24','10:00')],[exit('f','2026-11-25','09:45',-150)]),
 pos('new-open',[fill('g','2026-11-25','10:00')]),
 pos('old-open',[fill('h','2026-11-09','10:00'),fill('i','2026-11-25','09:00')]),
 pos('unknown',[]),
];
const rows=(asOf=day)=>raw.map(position=>({position,metrics:calculatePosition(position,account,asOf)}));
const ids=(list,mode,asOf=day)=>sortPositions(list,mode,asOf).map(x=>x.position.id);
test('most recent means latest actual entry or exit; sort does not change ledger or input ordering',()=>{
 const list=rows(),before=JSON.stringify(list);
 assert.deepEqual(ids(list,'recent'),['open-partial','new-open','new-loser','old-open','old-winner','unknown']);
 assert.deepEqual(ids(list,'invalid'),ids(list,'recent'));
 assert.equal(JSON.stringify(list),before);
});
test('realized ascending and descending use CAD net P/L, including partial exits and zero',()=>{
 const list=rows();
 assert.deepEqual(ids(list,'realized-desc'),['old-winner','new-open','old-open','unknown','open-partial','new-loser']);
 assert.deepEqual(ids(list,'realized-asc'),['new-loser','open-partial','new-open','old-open','unknown','old-winner']);
});
test('entry date is first buy, and close date only applies to fully closed positions',()=>{
 const list=rows();
 assert.deepEqual(ids(list,'entry-desc'),['new-open','new-loser','open-partial','old-winner','old-open','unknown']);
 assert.deepEqual(ids(list,'entry-asc'),['old-open','old-winner','open-partial','new-loser','new-open','unknown']);
 assert.deepEqual(ids(list,'close-desc'),['new-loser','old-winner','open-partial','new-open','old-open','unknown']);
 assert.deepEqual(ids(list,'close-asc'),['old-winner','new-loser','open-partial','new-open','old-open','unknown']);
});
test('historical as-of excludes future fills/exits, and invalid over-quantity exits do not affect recency',()=>{
 const list=rows('2026-11-24');
 assert.deepEqual(ids(list,'recent','2026-11-24'),['new-loser','old-winner','open-partial','old-open','new-open','unknown']);
 const invalid=pos('invalid-exit',[fill('a1','2026-11-10','09:00')],[exit('b1','2026-11-25','13:00',50,2)]);
 const both=[{position:invalid,metrics:calculatePosition(invalid,account,day)},list[0]];
 assert.deepEqual(ids(both,'recent'),['old-winner','invalid-exit']);
});
test('open/closed filtering independent of ordering; modes are complete',()=>{
 const list=rows();
 assert.deepEqual(ids(list.filter(x=>x.metrics.qty>0),'recent'),['open-partial','new-open','old-open']);
 assert.deepEqual(ids(list.filter(x=>x.metrics.qty===0),'realized-desc'),['old-winner','unknown','new-loser']);
 assert.equal(POSITION_SORT_MODES.length,7);
});
