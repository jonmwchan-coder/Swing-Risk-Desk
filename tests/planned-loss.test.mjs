import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePosition,calculateAccount} from '../lib/risk.mjs';
import {normalizeLedger,mergeFullBackup} from '../lib/ledger.mjs';

const day='2026-11-24';
const account={id:'a',name:'A',equityCad:20000,riskPct:3,fx:1.4,stressPct:70,roundStep:25,window:5,mode:'stress',equityCheckpoints:[{id:'e',date:'2026-11-01',equityCad:20000,realizedPnlCad:0}]};
const position={id:'p',accountId:'a',ticker:'SMH',expiry:'2026-12-18',strike:350,optionType:'Call',fills:[{id:'f1',date:'2026-11-20',time:'10:00',qty:3,price:1.10,fee:3,fx:1.4}],exits:[]};
const ledger=p=>normalizeLedger({accounts:[account],positions:[p],adjustments:[]});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);

test('planned percentage uses full USD entry cost including fees; reserve and budget unchanged',()=>{
 const before=calculateAccount(ledger(position),'a',day),after=calculateAccount(ledger({...position,plannedLossPct:35}),'a',day),z=after.positions[0].metrics;
 near(z.planLossUsd,333*.35);near(z.planLoss,333*.35*1.4);assert.equal(z.plannedLossPct,35);
 assert.equal(after.reserveCad,before.reserveCad);assert.equal(after.availableCad,before.availableCad);
});
test('partial exits leave the total entry denominator intact; scale-ins increase it',()=>{
 const p={...position,plannedLossPct:40,exits:[{id:'x',date:'2026-11-23',time:'12:00',qty:1,price:1.2,fee:1,fx:1.4}]};
 const before=calculatePosition(p,account,day);near(before.planLossUsd,333*.4);near(before.remainingCostUsd,222);
 const after=calculatePosition({...p,fills:[...p.fills,{id:'f2',date:day,time:'10:00',qty:2,price:.9,fee:2,fx:1.4}]},account,day);
 near(after.totalEntryDebitUsd,515);near(after.planLossUsd,515*.4);near(after.remainingCostUsd,404);assert.equal(after.qty,4);
});
test('zero percent is valid; absent or invalid percent retains legacy stop estimate',()=>{
 const p={...position,stopPremiumUsd:.6};
 near(calculatePosition(p,account,day).planLossUsd,153);
 near(calculatePosition({...p,plannedLossPct:0},account,day).planLossUsd,0);
 near(calculatePosition({...p,plannedLossPct:101},account,day).planLossUsd,153);
 assert.equal(calculatePosition(position,account,day).planLossUsd,null);
});
test('planned percentage does not override strict mode or a fixed reserve floor',()=>{
 const p={...position,plannedLossPct:20,fixedReserveCad:550};
 const z=calculatePosition(p,{...account,mode:'strict'},day);
 assert.equal(z.reservePct,100);assert.equal(z.reserveCad,550);near(z.planLossUsd,66.6);
});
test('newer explicit planned loss survives cloud reconciliation in both directions',()=>{
 const older=ledger({...position,plannedLossPct:30,plannedLossEditedAt:'2026-11-23T16:00:00Z'});
 const newer=ledger({...position,plannedLossPct:45,plannedLossEditedAt:'2026-11-24T16:00:00Z'});
 for(const [a,b] of [[older,newer],[newer,older]]){
  const x=mergeFullBackup(a,b).next.positions[0];assert.equal(x.plannedLossPct,45);assert.equal(x.plannedLossEditedAt,'2026-11-24T16:00:00Z');
 }
});
test('explicit clear remains cleared when an older backup is imported',()=>{
 const older=ledger({...position,plannedLossPct:30,plannedLossEditedAt:'2026-11-23T16:00:00Z'});
 const newer=ledger({...position,plannedLossPct:null,plannedLossEditedAt:'2026-11-24T16:00:00Z'});
 for(const [a,b] of [[older,newer],[newer,older]])assert.equal(mergeFullBackup(a,b).next.positions[0].plannedLossPct,null);
});
