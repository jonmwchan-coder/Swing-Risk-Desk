import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLedger,planOpenPositionMerge,mergeFullBackup} from '../lib/ledger.mjs';
import {calculateAccount,calculatePosition} from '../lib/risk.mjs';
import {calculatePlanBasket,remainingDraftQuantity} from '../lib/planner.mjs';

const day='2026-11-24';
const account={id:'a',name:'A',equityCad:20000,riskPct:3,fx:1.4,stressPct:70,roundStep:25,window:5,mode:'stress',equityCheckpoints:[{id:'e',date:'2026-11-01',equityCad:20000,realizedPnlCad:0}]};
const contract={ticker:'SMH',expiry:'2026-12-18',strike:350,optionType:'Call',accountId:'a',multiplier:100};
const fill=(id,qty,price,date='2026-11-20')=>({id,date,time:'10:00',qty,price,fee:1,fx:1.4});
const position=(id,qty,price,extra={})=>({...contract,id,ideaId:id,fills:[fill('f'+id,qty,price)],exits:[],...extra});
const ledger=positions=>normalizeLedger({accounts:[account],positions,adjustments:[]});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);

test('retroactive merge combines fills and weighted average without modifying original state',()=>{
 const s=ledger([position('p1',2,1),position('p2',1,1.5)]),m=planOpenPositionMerge(s,'a','p1',['p2'],day);
 assert.equal(m.metrics.qty,3);near(m.metrics.averageEntryUsd,350/300);near(m.metrics.totalEntryDebitUsd,352);
 assert.equal(m.next.positions.length,1);assert.equal(m.next.positions[0].fills.length,2);
 assert.equal(s.positions.length,2);assert.equal(m.next.archive.length,2);assert.equal(m.metrics.reserveCad,350);
});
test('different option side, expiry, strike or account cannot be merged',()=>{
 for(const extra of [{optionType:'Put'},{expiry:'2026-12-11'},{strike:355},{accountId:'b'}]){
  const s=ledger([position('p1',2,1),position('p2',1,1.5,extra)]);
  assert.throws(()=>planOpenPositionMerge(s,'a','p1',['p2'],day),/must match|missing or belongs/);
 }
});
test('duplicate execution IDs are rejected',()=>{
 const s=ledger([position('p1',2,1),position('p2',1,1.5,{fills:[fill('fp1',2,1)]})]);
 assert.throws(()=>planOpenPositionMerge(s,'a','p1',['p2'],day),/duplicate execution/i);
});
test('partial exit broker override preserved; changed basis flagged',()=>{
 const s=ledger([position('p1',2,1,{exits:[{id:'x1',date:'2026-11-23',time:'12:00',qty:1,price:1.8,fee:1,fx:1.4,brokerPnlCad:100}]}),position('p2',1,1.5)]);
 const m=planOpenPositionMerge(s,'a','p1',['p2'],day);
 assert.equal(m.metrics.qty,2);assert.equal(m.metrics.realizedTotal,100);assert.ok(m.recalculatedExits);assert.equal(m.metrics.closes[0].pnlCad,100);
});
test('higher stress and summed reserve floors survive both cloud reconciliation directions',()=>{
 const s=ledger([position('p1',2,1,{stressPct:50,fixedReserveCad:200}),position('p2',1,1.5,{stressPct:80,fixedReserveCad:150})]);
 const m=planOpenPositionMerge(s,'a','p1',['p2'],day);
 assert.equal(m.metrics.stressPct,80);assert.equal(m.next.positions[0].fixedReserveCad,350);
 for(const [current,incoming] of [[s,m.next],[m.next,s]]){
  const b=mergeFullBackup(current,incoming),next=b.state||b.next||b.ledger||b;
  assert.equal(next.positions.length,1);assert.equal(next.positions[0].stressPct,80);assert.equal(next.positions[0].fixedReserveCad,350);assert.equal(next.positions[0].fills.length,2);
 }
});
test('changed source position fails closed when synchronizing stale backups',()=>{
 const s=ledger([position('p1',2,1),position('p2',1,1.5)]),m=planOpenPositionMerge(s,'a','p1',['p2'],day);
 s.positions[1].notes='Newer note';
 assert.throws(()=>mergeFullBackup(m.next,s),/differs in another backup/);
});
test('scale-in charges only incremental rounded reserve',()=>{
 const s=ledger([position('p1',2,1)]),b=calculateAccount(s,'a',day);
 const r=calculatePlanBasket([{...contract,id:'i',qty:'1',price:'1.5',fee:'1'}],b.account,b.availableCad,b.positions).rows[0];
 const expected=calculatePosition({...s.positions[0],fills:[...s.positions[0].fills,fill('fnew',1,1.5)]},b.account,day);
 assert.equal(r.totalReserveCad,expected.reserveCad);assert.equal(r.reserveCad,expected.reserveCad-b.positions[0].metrics.reserveCad);
 assert.equal(r.existingQty,2);assert.equal(remainingDraftQuantity(3,1),2);
});
test('ambiguous duplicate positions block planner additions pending manual merge',()=>{
 const s=ledger([position('p1',2,1),position('p2',1,1.5)]),b=calculateAccount(s,'a',day);
 const r=calculatePlanBasket([{...contract,id:'i',qty:'1',price:'1.5',fee:'1'}],b.account,b.availableCad,b.positions).rows[0];
 assert.ok(r.ambiguous&&!r.valid);
});
