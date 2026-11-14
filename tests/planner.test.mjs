import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPlanIdea,parsePlannedContract,calculatePlanBasket,MAX_PLAN_IDEAS} from '../lib/planner.mjs';
const a={fx:1.4,mode:'stress',stressPct:70,roundStep:25,ideaCapCad:200};
const row=(id,qty,price,fee='0',stress='70')=>({id,qty:String(qty),price:String(price),fee,stress});

test('planner starts with one compact idea and supports 8 maximum',()=>{
 assert.equal(defaultPlanIdea('a',70,true).qty,'1');
 assert.equal(defaultPlanIdea('a',70,true).price,'');
 assert.equal(defaultPlanIdea('b',70).price,'');
 assert.equal(MAX_PLAN_IDEAS,8);
});
test('parse user example INTC Jan 15 2027 70C without guessing other idea labels',()=>{
 assert.deepEqual(parsePlannedContract('INTC 1/15/27 70c'),{ticker:'INTC',expiry:'2027-01-15',strike:70,optionType:'Call'});
 assert.deepEqual(parsePlannedContract('INTC 2027-01-15 70P'),{ticker:'INTC',expiry:'2027-01-15',strike:70,optionType:'Put'});
 assert.deepEqual(parsePlannedContract('INTC'),{ticker:'INTC'});
 assert.deepEqual(parsePlannedContract('INTC 2/29/27 70C'),{ticker:'INTC'});
 assert.deepEqual(parsePlannedContract('two different contracts'),{});
});
test('independent per-position rounding and cumulative remaining risk',()=>{
 const b=calculatePlanBasket([row('a',1,'0.50'),row('b',1,'0.50'),row('c',1,'0.50')],a,200);
 // Each $70 CAD debit at 70% = $49 -> $50 after $25-step rounding.
 assert.deepEqual(b.rows.map(r=>r.reserveCad),[50,50,50]);
 assert.deepEqual(b.rows.map(r=>r.remainingCad),[150,100,50]);
 assert.equal(b.plannedReserveCad,150);assert.equal(b.remainingCad,50);assert.equal(b.complete,true);
});
test('2/3/4 planned options show aggregate budget and warn at breach',()=>{
 const drafts=[row('a',1,'0.50'),row('b',1,'0.50'),row('c',1,'0.50'),row('d',1,'0.50')];
 for(const n of [2,3,4]){
  const result=calculatePlanBasket(drafts.slice(0,n),a,100);
  assert.equal(result.rows.length,n);
  assert.equal(result.plannedReserveCad,50*n);
  assert.equal(result.remainingCad,100-50*n);
  assert.equal(result.overBudget,n>2);
 }
});
test('empty unpriced entries do not get counted or falsely declare full basket fit',()=>{
 const b=calculatePlanBasket([row('a',1,'0.50'),defaultPlanIdea('new')],a,70);
 assert.equal(b.priced,1);assert.equal(b.total,2);assert.equal(b.complete,false);
 assert.equal(b.remainingCad,20);assert.equal(b.rows[1].valid,false);
});
test('strict account mode ignores stress percentage and rounds full debit separately',()=>{
 const b=calculatePlanBasket([row('a',1,'0.50','0','10'),row('b',1,'0.50','0','100')],{...a,mode:'strict'},150);
 assert.deepEqual(b.rows.map(r=>r.reserveCad),[75,75]);assert.equal(b.remainingCad,0);
});
test('per-idea reserve cap is indicated independently from rolling portfolio capacity',()=>{
 const b=calculatePlanBasket([row('a',2,'1.50','1.50','70')],a,600);
 assert.equal(b.rows[0].reserveCad,300);assert.equal(b.rows[0].overIdeaCap,true);
 assert.equal(b.overBudget,false);assert.equal(b.remainingCad,300);
});
test('invalid inputs never consume risk or silently turn into a saved position',()=>{
 const b=calculatePlanBasket([row('a',2,'1.50'),row('b','1.5','0.50'),row('c',1,'-2')],a,600);
 assert.equal(b.priced,1);assert.equal(b.rows[1].valid,false);assert.equal(b.rows[2].valid,false);
 assert.equal(b.plannedReserveCad,300);
});