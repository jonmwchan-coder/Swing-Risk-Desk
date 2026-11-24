import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPlanIdea,calculatePlanBasket,draftPlannedLossPct} from '../lib/planner.mjs';
import {normalizePlannerDrafts} from '../lib/planner-storage.mjs';
import {copyPlannerIdea} from '../lib/planner-workflows.mjs';
import {calculateAccount,calculatePosition} from '../lib/risk.mjs';

const day='2026-11-24';
const account={id:'a',name:'A',equityCad:20000,riskPct:3,fx:1.4,stressPct:70,roundStep:25,window:5,mode:'stress'};
const contract={ticker:'SMH',expiry:'2026-12-18',strike:350,optionType:'Call',accountId:'a',multiplier:100};
const idea=(id,ticker='SMH')=>({...defaultPlanIdea(id),...contract,ticker,qty:'2',price:'1.00',fee:'2',plannedLossPct:'35'});
const near=(x,y)=>assert.ok(Math.abs(x-y)<1e-6,`${x} != ${y}`);

test('copy only the selected idea, preserve all existing destination and source drafts',()=>{
 const source={a:[idea('a1'),idea('a2','AMD')],b:[idea('b1','QQQ')]};
 const snapshot=JSON.stringify(source);
 const result=copyPlannerIdea(source,'a','b','a2',()=> 'copy',['a','b']);
 assert.equal(result.ok,true);assert.equal(result.count,1);assert.equal(result.drafts.b.length,2);
 assert.equal(result.drafts.b[0].id,'b1');assert.equal(result.drafts.b[1].ticker,'AMD');
 assert.equal(result.drafts.b[1].plannedLossPct,'35');assert.equal(result.drafts.b[1].id,'copy');
 assert.equal(JSON.stringify(source),snapshot);
});
test('no selected or unknown idea never defaults to copying all',()=>{
 const source={a:[idea('a1'),idea('a2')],b:[]};
 for(const id of [undefined,null,'','missing'])assert.equal(copyPlannerIdea(source,'a','b',id,()=> 'copy',['a','b']).ok,false);
 assert.equal(source.b.length,0);
});
test('selected copy can use the last available draft slot without copying other source ideas',()=>{
 const source={a:[idea('a1'),idea('a2')],b:Array.from({length:7},(_,i)=>idea('b'+i,'QQQ'))};
 const result=copyPlannerIdea(source,'a','b','a1',()=> 'copy',['a','b']);
 assert.equal(result.ok,true);assert.equal(result.drafts.b.length,8);
 assert.equal(copyPlannerIdea(result.drafts,'a','b','a2',()=> 'copy2',['a','b']).ok,false);
});
test('restore draft estimates separately from stress overrides, including explicitly cleared values',()=>{
 const custom={...idea('custom'),stress:'45',stressCustom:true};delete custom.plannedLossPct;
 const ordinary={...defaultPlanIdea('ordinary')};delete ordinary.plannedLossPct;
 const clean=normalizePlannerDrafts({a:[custom,ordinary,{...idea('zero'),plannedLossPct:'0'},{...idea('cleared'),stress:'55',stressCustom:true,plannedLossPct:''}]}).a;
 assert.equal(clean[0].plannedLossPct,'45');assert.equal(clean[0].stress,'45');assert.equal(clean[0].stressCustom,true);
 assert.equal(clean[1].plannedLossPct,'');assert.equal(clean[1].stress,'70');assert.equal(clean[2].plannedLossPct,'0');assert.equal(clean[3].plannedLossPct,'');
});
test('estimated loss changes projected plan amount but never stress allocation or remaining budget',()=>{
 const x=idea('a1'),a=calculatePlanBasket([x],account,600).rows[0],b=calculatePlanBasket([{...x,plannedLossPct:'10'}],account,600).rows[0];
 near(a.plannedLossUsd,202*.35);near(b.plannedLossUsd,202*.10);
 assert.equal(a.reserveCad,b.reserveCad);assert.equal(a.remainingCad,b.remainingCad);
 assert.equal(a.stress,70);
});
test('scale-in estimate inherits saved position plan and uses projected total actual entry debit',()=>{
 const p={...contract,id:'p',plannedLossPct:30,fills:[{id:'f',date:'2026-11-20',qty:3,price:1.10,fee:3,fx:1.4}],exits:[]};
 const m=calculateAccount({accounts:[account],positions:[p],adjustments:[]},'a',day),draft={...idea('a1'),plannedLossPct:''};
 assert.equal(draftPlannedLossPct(draft,p),30);
 const r=calculatePlanBasket([draft],account,m.availableCad,m.positions).rows[0];
 assert.equal(r.existingQty,3);assert.equal(r.plannedLossPct,30);near(r.plannedLossUsd,(333+202)*.30);
 const after=calculatePosition({...p,plannedLossPct:r.plannedLossPct,fills:[...p.fills,{id:'f2',date:day,qty:2,price:1.00,fee:2,fx:1.4}]},account,day);
 near(after.planLossUsd,r.plannedLossUsd);near(after.reserveCad,r.totalReserveCad);
 const changed=calculatePlanBasket([{...draft,plannedLossPct:'20'}],account,m.availableCad,m.positions).rows[0];
 assert.equal(changed.reserveCad,r.reserveCad);near(changed.plannedLossUsd,535*.20);
 const idle=calculatePlanBasket([{...draft,qty:'0'}],account,m.availableCad,m.positions).rows[0];
 near(idle.plannedLossUsd,333*.30);assert.equal(idle.reserveCad,0);
});
test('zero is a valid estimated loss; out-of-range values cannot be recorded',()=>{
 const x=idea('a1');assert.equal(calculatePlanBasket([{...x,plannedLossPct:'0'}],account,600).rows[0].plannedLossUsd,0);
 assert.equal(calculatePlanBasket([{...x,plannedLossPct:'101'}],account,600).rows[0].valid,false);
 assert.equal(calculatePlanBasket([{...x,plannedLossPct:'-1'}],account,600).rows[0].valid,false);
});
