import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePosition,calculateAccount,realizedReturnPct} from '../lib/risk.mjs';

const approx=(actual,expected,tol=1e-8)=>assert.ok(Math.abs(actual-expected)<tol,`${actual} != ${expected}`);
const a={id:'demo',fx:1.4,stressPct:70,mode:'stress',roundStep:25,riskPct:3,window:5,equityCad:20000};
function fixture(){return {
  id:'trade',accountId:'demo',ticker:'TEST',multiplier:100,
  fills:[{id:'b1',date:'2026-11-12',time:'10:00',qty:2,price:2.00,fee:1.54,fx:1.4}],
  exits:[]
};}
const sell=(id,date,qty,price,fee=1)=>({id,date,time:'11:00',qty,price,fee,fx:1.4});

test('unknown return stays blank before any exit and for missing acquisition basis',()=>{
 const p=fixture(); const m=calculatePosition(p,a,'2026-11-17');
 assert.equal(m.realizedReturnPct,null);
 assert.equal(m.closedCostCad,0);
 assert.equal(realizedReturnPct(null,250),null);
 assert.equal(realizedReturnPct(0,0),null);
 assert.equal(realizedReturnPct(45,null),null);
 assert.equal(realizedReturnPct(45,undefined),null);
 assert.equal(realizedReturnPct('bad',250),null);
 assert.equal(realizedReturnPct(45,-2),null);
});

test('a partial exit has net realized return on the ONE sold contract, not two-contract debit',()=>{
 const p=fixture();p.exits=[sell('tp1','2026-11-13',1,2.6)];
 const m=calculatePosition(p,a,'2026-11-13');
 const acquisitionCostCad=(2*2*100+1.54)*1.4;
 const singleBasis=acquisitionCostCad/2;
 const expectedPnl=(2.6*100-1)*1.4-singleBasis;
 const expectedPct=100*expectedPnl/singleBasis;
 assert.equal(m.qty,1);
 assert.equal(m.closes.length,1);
 approx(m.closes[0].basisCad,singleBasis);
 approx(m.closes[0].returnPct,expectedPct);
 approx(m.realizedReturnPct,expectedPct);
 approx(m.closedCostCad,singleBasis);
 assert.ok(m.reserveCad>0,'remaining runner still reserves risk');
});

test('two fully closed slices have their own % and position % uses weighted acquired basis',()=>{
 const p=fixture();p.exits=[sell('tp1','2026-11-13',1,2.6),sell('runner','2026-11-16',1,1.4)];
 const m=calculatePosition(p,a,'2026-11-16');
 const [tp1,runner]=m.closes;
 assert.equal(m.qty,0);
 assert.ok(tp1.returnPct>0 && runner.returnPct<0);
 approx(m.closedCostCad,(2*2*100+1.54)*1.4);
 approx(m.realizedReturnPct,100*(tp1.pnlCad+runner.pnlCad)/(tp1.basisCad+runner.basisCad));
 assert.notEqual(m.realizedReturnPct,(tp1.returnPct+runner.returnPct)/2 + 10,'aggregate is not a flat average');
 const acc=calculateAccount({accounts:[a],positions:[p],adjustments:[],customClosed:[]},'demo','2026-11-16');
 assert.equal(acc.positions[0].metrics.realizedReturnPct,m.realizedReturnPct);
 // Both underlying accounting and the rolling budget retain their original, independent definitions.
 approx(acc.realizedAllTime,tp1.pnlCad+runner.pnlCad,0.01);
});

test('weighted basis matters when quantities and purchase prices differ',()=>{
 const p=fixture();p.fills=[{id:'b1',date:'2026-11-12',time:'09:45',qty:1,price:1,fee:1,fx:1.3},
   {id:'b2',date:'2026-11-12',time:'10:00',qty:2,price:3,fee:2,fx:1.5}];
 p.exits=[sell('tp1','2026-11-13',1,4),sell('runner','2026-11-16',2,2)];
 const m=calculatePosition(p,a,'2026-11-16');
 assert.equal(m.qty,0);
 // 1x $101 at FX 1.3 plus 2x $602 at FX 1.5, divided proportionally between closes.
 const cost=101*1.3+602*1.5;
 approx(m.closedCostCad,cost);
 approx(m.realizedReturnPct,100*m.realizedTotal/cost);
});

test('broker verified CAD P/L overrides computed exit return numerator, original basis stays unchanged',()=>{
 const p=fixture();p.exits=[{...sell('sale','2026-11-16',1,2.6),brokerPnlCad:55.33}];
 const m=calculatePosition(p,a,'2026-11-16');
 assert.equal(m.closes[0].pnlCad,55.33);
 assert.ok(m.closes[0].hasOverride);
 approx(m.closes[0].returnPct,100*55.33/m.closes[0].basisCad);
 approx(m.realizedReturnPct,m.closes[0].returnPct);
});

test('future exits are never borrowed into the realized percentage',()=>{
 const p=fixture();p.exits=[sell('future','2026-11-20',2,3)];
 assert.equal(calculatePosition(p,a,'2026-11-17').realizedReturnPct,null);
 assert.equal(calculatePosition(p,a,'2026-11-20').closes.length,1);
});
