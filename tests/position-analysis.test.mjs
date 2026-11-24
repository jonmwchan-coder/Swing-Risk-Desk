import test from 'node:test';
import assert from 'node:assert/strict';
import {captureDraftAnalysis,positionAnalysisEvents,currentAnalysisBasis,workingAnalysisPreview,appendAnalysisRevision,modelPositionAnalysis} from '../lib/position-analysis.mjs';
import {emptyPreview,projectOptionReturns} from '../lib/option-preview.mjs';
import {calculatePosition} from '../lib/risk.mjs';
import {normalizeLedger,mergeFullBackup,planOpenPositionMerge} from '../lib/ledger.mjs';

const day='2026-11-24',at='2026-11-24T15:00:00.000Z';
const account={id:'a',name:'A',equityCad:20000,riskPct:3,fx:1.4,stressPct:70,roundStep:25,window:5,mode:'stress',sellFeePerContractUsd:1,equityCheckpoints:[{id:'e',date:'2026-11-01',equityCad:20000,realizedPnlCad:0}]};
const contract={ticker:'SMH',expiry:'2026-12-18',strike:350,optionType:'Call'};
const fill=(id,qty=3,price=2,fee=3,date=day)=>({id,date,time:'10:00',qty,price,fee,fx:1.4});
const position=(id='p',f=fill('f'))=>({...contract,id,accountId:'a',fills:[f],exits:[],plannedLossPct:35});
const draft=()=>({...contract,draftId:'d',name:'Synthetic breakout',qty:'5',price:'2.05',fee:'5',stress:'70',plannedLossPct:35,analysisCapturedAt:at,preview:{...emptyPreview(day),spot:'350',ivPct:'40',ivManual:true,bid:'2',ask:'2.1',quoteAt:'2026-11-24T14:59:00Z',targets:[{id:'stop',name:'Stop',price:'345'},{id:'tp1',name:'TP1',price:'360'},{id:'tp2',name:'TP2',price:'370'}],dates:['2026-11-25','2026-11-27']}});
const ledger=ps=>normalizeLedger({accounts:[account],positions:ps,adjustments:[]});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);

test('entry snapshot freezes original draft and actual fill independently',()=>{
 const p=position(),d=draft(),e=captureDraftAnalysis(p,d,p.fills[0],account,'2026-11-24T15:01:00Z');
 assert.equal(e.id,'entry:f');assert.equal(e.capturedAt,at);assert.equal(e.recordedAt,'2026-11-24T15:01:00Z');
 assert.equal(e.basis.qty,3);assert.equal(e.basis.price,2);assert.equal(e.basis.fee,3);assert.equal(e.draft.qty,'5');
 assert.equal(e.preview.targets[1].price,'360');assert.equal(e.preview.quoteAt,'2026-11-24T14:59:00Z');
 d.preview.targets[1].price='999';d.preview.dates.length=0;p.fills[0].price=8;
 assert.equal(e.preview.targets[1].price,'360');assert.equal(e.preview.dates.length,2);assert.equal(e.basis.price,2);
 assert.equal(positionAnalysisEvents(p).length,1);
});
test('each confirmed scale-in has its own snapshot; no snapshot without a matching draft',()=>{
 const p=position(),d=draft();captureDraftAnalysis(p,d,p.fills[0],account);
 const f2=fill('f2',2,1.8,2,'2026-11-25');p.fills.push(f2);
 const d2={...draft(),analysisCapturedAt:'2026-11-25T15:00:00Z'};d2.preview.targets[1].price='365';captureDraftAnalysis(p,d2,f2,account);
 assert.equal(positionAnalysisEvents(p).length,2);assert.equal(p.analysisHistory[0].preview.targets[1].price,'360');assert.equal(p.analysisHistory[1].preview.targets[1].price,'365');
 assert.equal(captureDraftAnalysis(p,{...d,strike:355},fill('bad'),account),null);
 assert.equal(captureDraftAnalysis(p,null,fill('manual'),account),null);
});
test('current scenario keeps targets and dates but never treats old quote as live',()=>{
 const p=position();captureDraftAnalysis(p,draft(),p.fills[0],account);
 const w=workingAnalysisPreview(p,day);
 assert.equal(w.preview.targets[1].price,'360');assert.deepEqual(w.preview.dates,['2026-11-25','2026-11-27']);
 assert.equal(w.preview.spot,'');assert.equal(w.preview.bid,'');assert.equal(w.preview.ask,'');assert.equal(w.preview.quoteAt,'');
 assert.equal(w.preview.ivPct,'40');assert.equal(w.preview.ivManual,true);
 w.preview.targets[1].price='999';assert.equal(p.analysisHistory[0].preview.targets[1].price,'360');
});
test('blank later scale-in does not discard the meaningful earlier targets',()=>{
 const p=position();captureDraftAnalysis(p,draft(),p.fills[0],account);
 const d={...draft(),analysisCapturedAt:'2026-11-25T15:00:00Z',preview:emptyPreview('2026-11-25')};
 captureDraftAnalysis(p,d,fill('f2',1,2,1,'2026-11-25'),account);
 assert.equal(workingAnalysisPreview(p,day).preview.targets[1].price,'360');
});
test('actual remaining basis includes allocated buy commissions after scale-in and partial exit',()=>{
 const p=position();p.fills.push(fill('f2',2,1,2,'2026-11-25'));
 p.exits.push({id:'x',date:'2026-11-27',time:'12:00',qty:2,price:2.5,fee:2,fx:1.4});
 const m=calculatePosition(p,account,'2026-11-27'),b=currentAnalysisBasis(p,m,account,'2026-11-27');
 assert.equal(b.qty,3);near(b.price,1.6);near(b.fee,3);near(b.qty*b.price*100+b.fee,m.remainingCostUsd);
 assert.equal(currentAnalysisBasis({...p,multiplier:50},m,account,'2026-11-27'),null);
 assert.equal(currentAnalysisBasis(p,{...m,qty:0},account,'2026-11-27'),null);
});
test('saved scenario is an append-only independent revision, older snapshots remain unchanged',()=>{
 const p=position();captureDraftAnalysis(p,draft(),p.fills[0],account);
 const w=workingAnalysisPreview(p,day).preview;w.targets[1].price='380';
 const b=currentAnalysisBasis(p,calculatePosition(p,account,day),account,day);
 const e=appendAnalysisRevision(p,w,b,'r','2026-11-25T15:00:00Z');w.targets[1].price='999';
 assert.equal(e.preview.targets[1].price,'380');assert.equal(p.analysisHistory[0].preview.targets[1].price,'360');
 assert.equal(workingAnalysisPreview(p,'2026-11-25').preview.targets[1].price,'380');
});
test('old positions can start fresh with no fabricated entry snapshot',()=>{
 const p=position();const w=workingAnalysisPreview(p,day);
 assert.equal(w.source,null);assert.equal(w.preview.targets[1].price,'');assert.equal(positionAnalysisEvents(p).length,0);
 const d={...draft(),preview:null};const e=captureDraftAnalysis(p,d,p.fills[0],account);
 assert.equal(e.preview,null);assert.equal(modelPositionAnalysis({contract,preview:e.preview,basis:e.basis,asOf:at}).valid,false);
});
test('position model uses current quote or theoretical value, not historical entry as current mark',()=>{
 const p=position();const e=captureDraftAnalysis(p,draft(),p.fills[0],account);
 const quoted=modelPositionAnalysis({contract,preview:e.preview,basis:e.basis,asOf:at});
 assert.equal(quoted.valid,true);near(quoted.anchorMid,2.05);near(quoted.baseCostUsd,603);
 const preview={...e.preview,bid:'',ask:''},result=modelPositionAnalysis({contract,preview,basis:e.basis,asOf:at});
 assert.equal(result.valid,true);near(result.anchorMid,result.modelNow);assert.match(result.anchorLabel,/theoretical/);
 const legacy=projectOptionReturns({contract,preview,qty:3,entryPremium:2,entryFeeUsd:3,sellFeePerContractUsd:1,asOf:at});
 near(legacy.anchorMid,2);assert.equal(modelPositionAnalysis({contract,preview,basis:e.basis,asOf:at,multiplier:50}).valid,false);
});
test('old backups cannot erase scenario history; conflict is recorded without changing original',()=>{
 const p=position(),old=ledger([p]);captureDraftAnalysis(p,draft(),p.fills[0],account);
 const newer=ledger([p]);
 for(const [a,b] of [[old,newer],[newer,old]]){
  const out=mergeFullBackup(a,b).next;assert.equal(out.positions[0].analysisHistory.length,1);assert.equal(out.positions[0].analysisHistory[0].preview.targets[1].price,'360');
 }
 const conflicting=JSON.parse(JSON.stringify(newer));conflicting.positions[0].analysisHistory[0].preview.targets[1].price='999';
 const merged=mergeFullBackup(newer,conflicting);assert.equal(merged.next.positions[0].analysisHistory[0].preview.targets[1].price,'360');
 assert.ok(merged.next.conflicts.some(c=>c.kind==='position-analysis'));
});
test('manual duplicate position consolidation preserves both entry analysis events',()=>{
 const p=position('p1',fill('f1',2,2,2)),q=position('p2',fill('f2',1,1.8,1,'2026-11-23'));
 captureDraftAnalysis(p,draft(),p.fills[0],account);captureDraftAnalysis(q,draft(),q.fills[0],account);
 const out=planOpenPositionMerge(ledger([p,q]),'a','p1',['p2'],day);
 assert.equal(out.next.positions.length,1);assert.equal(out.next.positions[0].analysisHistory.length,2);
});
