import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateAccount,calculatePosition,budgetRunway,lossReleases,round2,summarizeRollingLosses} from '../lib/risk.mjs';

const create=()=>({accounts:[{id:'a',equityCad:20000,riskPct:3,window:5,stressPct:70,roundStep:25,mode:'stress',fx:1.4}],positions:[],adjustments:[],customClosed:[]});
function position(id,buyDate='2026-11-13',qty=2,fee=0){return {id,accountId:'a',ticker:'SYNTH',ideaId:'SHARED-THESIS',fills:[{id:`${id}-b`,date:buyDate,time:'10:00',qty,price:1,fee,fx:1.4}],exits:[]};}
function sale(id,date,time,price,fee=0){return {id,date,time,qty:1,price,fee,fx:1.4};}
function check(s,day='2026-11-18'){return calculateAccount(s,'a',day);}

test('30% winner and 30% losing runner cancel at position level before commissions',()=>{
 const s=create();const p=position('p');p.exits=[sale('tp','2026-11-16','10:00',1.30),sale('runner','2026-11-17','10:00',.70)];s.positions=[p];
 const a=check(s);
 assert.equal(a.realizedLossCad,0);
 assert.equal(a.grossRealizedLossCad,42);
 assert.equal(a.currentEquityCad,20000);
 assert.equal(a.budgetCad,600);
 assert.equal(a.reserveCad,0);
 assert.equal(a.availableCad,600);
 assert.equal(a.realizedProfitCad,0);
 assert.equal(a.positionAttempts.length,1);
 assert.equal(a.lossesByDate['2026-11-17'],0);
});

test('same partial/runner with fees charges only actual net loss; never raw runner loss',()=>{
 const s=create();const p=position('p','2026-11-13',2,1.54);
 p.exits=[sale('tp','2026-11-16','10:00',1.3,1),sale('runner','2026-11-17','10:00',.7,1)];s.positions=[p];
 const a=check(s);
 assert.equal(a.grossRealizedLossCad,44.48);
 assert.equal(a.realizedLossCad,4.96);
 assert.equal(a.currentEquityCad,19995.04);
 assert.equal(a.budgetCad,599.85);
 assert.equal(a.availableCad,594.89);
 assert.equal(round2(Object.values(a.lossesByDate).reduce((x,y)=>x+y,0)),4.96);
 assert.equal(a.lossesByDate['2026-11-17'],4.96);
});

test('after TP1, remaining contracts still reserve stress loss and never count hypothetical runner as realized',()=>{
 const s=create();const p=position('p');p.exits=[sale('tp','2026-11-16','10:00',1.3)];s.positions=[p];
 const a=check(s,'2026-11-16');
 assert.equal(a.realizedLossCad,0);
 assert.equal(a.reserveCad,100);
 assert.equal(a.currentEquityCad,20042);
 assert.equal(a.budgetCad,601.26);
 assert.equal(a.availableCad,501.26);
});

test('independent attempts with identical ticker and ideaId never net across positions',()=>{
 const s=create();const p=position('p','2026-11-13',1);p.exits=[sale('win','2026-11-16','10:00',1.30)];
 const q=position('q','2026-11-13',1);q.exits=[sale('loss','2026-11-17','10:00',.70)];
 s.positions=[p,q];const a=check(s);
 assert.equal(a.realizedLossCad,42);
 assert.equal(a.realizedProfitCad,42);
 assert.equal(a.grossRealizedLossCad,42);
 assert.equal(a.currentEquityCad,20000);
 assert.equal(a.availableCad,558);
 assert.equal(a.positionAttempts.length,2);
});

test('re-buy after completely flat is a fresh attempt even inside the same saved position',()=>{
 const s=create();const p=position('p','2026-11-13',1);
 p.exits=[sale('win','2026-11-16','10:00',1.3),sale('loss','2026-11-17','10:00',.7)];
 p.fills.push({id:'again',date:'2026-11-17',time:'09:00',qty:1,price:1,fee:0,fx:1.4});s.positions=[p];
 const a=check(s);
 assert.deepEqual(a.sales.map(e=>e.attemptIndex),[1,2]);
 assert.equal(a.realizedLossCad,42);
 assert.equal(a.grossRealizedLossCad,42);
 assert.equal(a.realizedProfitCad,42);
 assert.equal(a.positionAttempts.length,2);
});

test('manual external realized P/L entries stay independent and cannot cancel each other',()=>{
 const s=create();s.adjustments=[{id:'win',accountId:'a',date:'2026-11-16',pnlCad:150,note:'Elsewhere'},{id:'loss',accountId:'a',date:'2026-11-17',pnlCad:-80,note:'Elsewhere'}];
 const a=check(s);
 assert.equal(a.realizedLossCad,80);
 assert.equal(a.realizedProfitCad,150);
 assert.equal(a.currentEquityCad,20070);
 assert.equal(a.budgetCad,602.1);
 assert.equal(a.availableCad,522.1);
});

test('different portfolios do not offset even if positionId collides',()=>{
 const s=create();s.accounts.push({...s.accounts[0],id:'b'});
 const p=position('p','2026-11-13',1);p.exits=[sale('win','2026-11-16','10:00',1.3)];
 const q=position('p','2026-11-13',1);q.accountId='b';q.exits=[sale('loss','2026-11-17','10:00',.7)];s.positions=[p,q];
 assert.equal(calculateAccount(s,'a','2026-11-18').realizedLossCad,0);
 assert.equal(calculateAccount(s,'b','2026-11-18').realizedLossCad,42);
});

test('a winning partial that ages out first makes its later runner loss chargeable; projection shows increase then release',()=>{
 const s=create();const p=position('p','2026-11-13');
 p.exits=[sale('win','2026-11-16','10:00',1.5),sale('loss','2026-11-18','10:00',.65)];s.positions=[p];
 const today=check(s,'2026-11-20');
 assert.equal(today.realizedLossCad,0);
 assert.equal(today.grossRealizedLossCad,49);
 const changes=lossReleases(s,'a','2026-11-20');
 assert.deepEqual(changes.map(x=>({date:x.releaseDate,kind:x.kind,amount:x.changeCad})),[
   {date:'2026-11-23',kind:'increase',amount:-49},
   {date:'2026-11-25',kind:'release',amount:49}
 ]);
 const future=budgetRunway(s,'a','2026-11-20',5);
 assert.deepEqual(future.map(x=>x.losses),[0,49,49,0,0]);
 assert.equal(future[1].available,round2(today.budgetCad-49));
 assert.equal(future[3].available,today.budgetCad);
});

test('older profitable partial cannot offset a later losing exit outside the same five-session window',()=>{
 const s=create();const p=position('p','2026-11-13');
 p.exits=[sale('win','2026-11-16','10:00',1.30),sale('loss','2026-11-23','10:00',.70)];s.positions=[p];
 const a=check(s,'2026-11-23');
 assert.equal(a.realizedLossCad,42);
 assert.equal(a.grossRealizedLossCad,42);
 assert.equal(a.lossesByDate['2026-11-23'],42);
});

test('sale after future as-of date must not influence either accounting or reserve',()=>{
 const s=create();const p=position('p');p.exits=[sale('tp','2026-11-16','10:00',1.3),sale('runner','2026-11-19','10:00',.7)];s.positions=[p];
 const a=check(s,'2026-11-17');
 assert.equal(a.realizedLossCad,0);
 assert.equal(a.reserveCad,100);
 assert.equal(a.sales.length,1);
});

test('gross-loss diagnostic can be nonzero while rolling net position loss is zero, with two separate loss dates',()=>{
 const summary=summarizeRollingLosses([
  {id:'a',positionId:'same',attemptIndex:1,date:'2026-11-16',pnlCad:-20},
  {id:'b',positionId:'same',attemptIndex:1,date:'2026-11-17',pnlCad:-35},
  {id:'c',positionId:'same',attemptIndex:1,date:'2026-11-18',pnlCad:55},
 ],['2026-11-16','2026-11-17','2026-11-18']);
 assert.equal(summary.grossRealizedLossCad,55);
 assert.equal(summary.realizedLossCad,0);
 assert.deepEqual(Object.values(summary.lossesByDate),[0,0,0]);
});
