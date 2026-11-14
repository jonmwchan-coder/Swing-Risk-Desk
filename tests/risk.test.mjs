import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateAccount,calculatePosition,simulateExit,budgetRunway,lossReleases,round2} from '../lib/risk.mjs';
import {isSession,sessionWindow,afterSessions} from '../lib/calendar.mjs';
const base=()=>({accounts:[{id:'demo-account',equityCad:20000,riskPct:3,fx:1.4,stressPct:70,roundStep:25,window:5,mode:'stress'}],positions:[{id:'demo-position',accountId:'demo-account',ticker:'DEMO',fills:[{id:'f1',date:'2026-11-13',time:'13:45',qty:1,price:1.50,fee:0.8,fx:1.4},{id:'f2',date:'2026-11-13',time:'15:59',qty:1,price:1.52,fee:0.8,fx:1.4}],exits:[]}],adjustments:[],customClosed:[]});
test('NYSE sessions exclude Thanksgiving and include early close',()=>{
 assert.equal(isSession('2026-11-26'),false);
 assert.equal(isSession('2026-11-27'),true);
 assert.equal(isSession('2026-11-14'),false);
 assert.equal(isSession('2026-11-11'),true);
 assert.deepEqual(sessionWindow('2026-11-20',5),['2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20']);
 assert.equal(afterSessions('2026-11-18',5),'2026-11-25');
 assert.equal(isSession('2027-03-26'),false);
});
test('synthetic example at 1.40 FX, 70% stress and $25 rounding reserves $300',()=>{
 const s=base(),x=calculateAccount(s,'demo-account','2026-11-14');
 assert.equal(x.asOf,'2026-11-13');
 assert.equal(x.budgetCad,600);
 assert.equal(x.reserveCad,300);
 assert.equal(x.availableCad,300);
 assert.ok(Math.abs(x.positions[0].metrics.remainingCostUsd-303.6)<.001);
});
test('closing one DEMO at profit releases half reserve and raises equity but never nets losses',()=>{
 const s=base();const x=simulateExit(s,'demo-account','2026-11-16','demo-position',1,1.60,.75);
 assert.equal(x.after.reserveCad,150);
 assert.equal(x.after.realizedLossCad,0);
 assert.ok(x.record.pnlCad>0);
 assert.equal(x.after.currentEquityCad,round2(20000+x.record.pnlCad));
 assert.equal(x.after.budgetCad,round2(x.after.currentEquityCad*0.03));
 assert.equal(x.after.availableCad,round2(x.after.budgetCad-150));
});
test('closing one DEMO at loss reduces available by loss',()=>{
 const s=base();const x=simulateExit(s,'demo-account','2026-11-16','demo-position',1,.5,.75);
 assert.equal(x.after.reserveCad,150);
 assert.ok(x.after.realizedLossCad>100);
 assert.ok(x.after.availableCad<350);
});
test('loss expires on fifth subsequent session; profits never net it',()=>{
 const s=base();s.adjustments.push({id:'l',accountId:'demo-account',date:'2026-11-18',pnlCad:-200});
 s.adjustments.push({id:'p',accountId:'demo-account',date:'2026-11-19',pnlCad:350});
 assert.equal(calculateAccount(s,'demo-account','2026-11-24').realizedLossCad,200);
 assert.equal(calculateAccount(s,'demo-account','2026-11-25').realizedLossCad,0);
 assert.equal(calculateAccount(s,'demo-account','2026-11-24').currentEquityCad,20150);
 assert.equal(calculateAccount(s,'demo-account','2026-11-24').budgetCad,604.50);
 assert.equal(calculateAccount(s,'demo-account','2026-11-24').availableCad,104.50);
 assert.equal(lossReleases(s,'demo-account','2026-11-24')[0].releaseDate,'2026-11-25');
});
test('strict mode reserves full cost, does not pretend 70% is max loss',()=>{
 const s=base();s.accounts[0].mode='strict';
 const x=calculateAccount(s,'demo-account','2026-11-13');
 assert.equal(x.reserveCad,450);
 assert.equal(x.availableCad,150);
});
test('open positions reserve risk even when their entry was months ago',()=>{
 const s=base();
 assert.equal(calculateAccount(s,'demo-account','2027-01-04').reserveCad,300);
});
test('partial and full exits use allocated cost and no ghost future closing',()=>{
 const s=base();s.positions[0].exits=[{id:'e1',date:'2026-11-16',time:'10:00',qty:1,price:1.5,fee:.75,fx:1.4},{id:'e2',date:'2026-11-17',time:'10:00',qty:1,price:1.7,fee:.75,fx:1.4}];
 assert.equal(calculateAccount(s,'demo-account','2026-11-13').reserveCad,300);
 assert.equal(calculateAccount(s,'demo-account','2026-11-16').reserveCad,150);
 assert.equal(calculateAccount(s,'demo-account','2026-11-17').reserveCad,0);
 assert.equal(calculatePosition(s.positions[0],s.accounts[0],'2026-11-17').closes.length,2);
});
test('forecast preserves existing open risk while previous loss rolls off',()=>{
 const s=base();s.adjustments.push({id:'l',accountId:'demo-account',date:'2026-11-13',pnlCad:-100});
 const series=budgetRunway(s,'demo-account','2026-11-13',6);
 assert.equal(series[0].available,197);
 assert.equal(series[5].available,297);
});


test('tracked equity automatically recalculates rolling percentage as account rises to 23k and falls to 18k',()=>{
 const s=base();s.positions=[];
 // The 20k account reaches 23k after a realized win.
 s.adjustments.push({id:'win',accountId:'demo-account',date:'2026-11-16',pnlCad:3000,note:'recorded win'});
 let m=calculateAccount(s,'demo-account','2026-11-16');
 assert.equal(m.currentEquityCad,23000);
 assert.equal(m.budgetCad,690);
 assert.equal(m.realizedLossCad,0);
 // A subsequent realized 5k loss reduces equity to 18k, but gross rolling losses
 // continue consuming capacity regardless of earlier profits.
 s.adjustments.push({id:'loss',accountId:'demo-account',date:'2026-11-17',pnlCad:-5000,note:'recorded loss'});
 m=calculateAccount(s,'demo-account','2026-11-17');
 assert.equal(m.currentEquityCad,18000);
 assert.equal(m.budgetCad,540);
 assert.equal(m.realizedLossCad,5000);
 assert.equal(m.availableCad,-4460);
});

test('recorded option entry debit is not a realized equity loss; closes change equity',()=>{
 const s=base();let m=calculateAccount(s,'demo-account','2026-11-13');
 assert.equal(m.currentEquityCad,20000);
 assert.equal(m.fullPremiumCad>0,true);
 const outcome=simulateExit(s,'demo-account','2026-11-16','demo-position',1,0.50,0.75);
 assert.equal(outcome.after.currentEquityCad,round2(20000+outcome.record.pnlCad));
 assert.equal(outcome.after.budgetCad,round2(outcome.after.currentEquityCad*0.03));
 assert.equal(outcome.after.realizedLossCad,round2(-outcome.record.pnlCad));
});

test('manual broker equity checkpoint rebases without applying prior closed P/L twice',()=>{
 const s=base();s.positions=[];
 s.adjustments.push({id:'old',accountId:'demo-account',date:'2026-11-13',pnlCad:500,note:'old gain'});
 const a=s.accounts[0];
 a.equityCheckpoints=[{id:'opening',date:'2026-11-01',createdAt:'2026-11-01T00:00:00Z',equityCad:20000,realizedPnlCad:0},
  {id:'broker-reset',date:'2026-11-17',createdAt:'2026-11-17T14:00:00Z',equityCad:18000,realizedPnlCad:500}];
 assert.equal(calculateAccount(s,'demo-account','2026-11-13').currentEquityCad,20500);
 assert.equal(calculateAccount(s,'demo-account','2026-11-17').currentEquityCad,18000);
 assert.equal(calculateAccount(s,'demo-account','2026-11-17').budgetCad,540);
 s.adjustments.push({id:'new',accountId:'demo-account',date:'2026-11-18',pnlCad:1000,note:'new gain'});
 assert.equal(calculateAccount(s,'demo-account','2026-11-18').currentEquityCad,19000);
 assert.equal(calculateAccount(s,'demo-account','2026-11-18').budgetCad,570);
});


test('weekend balance checkpoint applies to the previous session and latest same-day edit wins',()=>{
 const s=base();s.positions=[];
 s.accounts[0].equityCheckpoints=[
  {id:'old',date:'2026-11-13',createdAt:'2026-11-13T13:00:00Z',equityCad:18000,realizedPnlCad:0},
  {id:'new',date:'2026-11-13',createdAt:'2026-11-14T17:30:00Z',equityCad:23000,realizedPnlCad:0},
 ];
 assert.equal(calculateAccount(s,'demo-account','2026-11-14').asOf,'2026-11-13');
 assert.equal(calculateAccount(s,'demo-account','2026-11-14').currentEquityCad,23000);
 assert.equal(calculateAccount(s,'demo-account','2026-11-14').budgetCad,690);
});