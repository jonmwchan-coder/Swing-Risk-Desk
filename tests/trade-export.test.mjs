import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSingleTradeHandoff,singleTradeExportFilename,TRADE_HANDOFF_SCHEMA} from '../lib/trade-export.mjs';

const a={id:'bdi',name:'BDI Swing',brokerAccountId:'BROKER-TEST-1',fx:1.4,fxSource:'Manual rate',stressPct:70,mode:'stress',roundStep:25};
const b={id:'tfsa',name:'TFSA Swing',brokerAccountId:'BROKER-TEST-2',fx:1.41,stressPct:70,mode:'stress',roundStep:25};
function entry(id,qty,price,fee,options={}){return {id,date:'2026-11-13',time:'13:45:17',qty,price,fee,fx:1.4,...options};}
function exit(id,date,qty,price,fee,more={}){return {id,date,time:'10:33:15',qty,price,fee,fx:1.4,...more};}
function fixture(){
 const position={id:'pos-smh-bdi',accountId:'bdi',ideaId:'SWING-2026-11-13-SMH-400P',externalId:'2026-11-13-SWING-SMH-BDI',
   ticker:'SMH',optionType:'Put',strike:400,expiry:'2026-11-27',source:'IBKR Flex CSV',
   thesis:'Bear continuation',catalyst:'Failed support recovery',entryReason:'Observed failed buying',
   managementPlan:'Partial at underlying target, then structural runner',targetLevels:'TP1 370 / TP2 355',
   underlyingInvalidation:'Acceptance above 390',notes:'Original entry rationale',
   fills:[entry('buy-1',1,1.55,.7653,{broker:{source:'IBKR Flex CSV',sourceKey:'source-smh-buy',commissionRaw:-.7653,raw:{Symbol:'SMH   261127P00400000',Quantity:'1',ClientAccountID:'BROKER-TEST-1'},timezoneStatus:'Export timezone unverified'}}),
     entry('buy-2',1,1.41,.7673,{time:'15:59:56',feeEstimated:true})],
   exits:[exit('sell-tp1','2026-11-16',1,2.25,1.01,{tpLabel:'TP1',reason:'Hit underlying support',underlyingAtExit:370,notes:'Waited for target'}),
     exit('sell-runner','2026-11-17',1,1.90,1.03,{tpLabel:'Runner',reason:'Invalidation',notes:'Took structural exit'})],
   journalEntries:[{id:'note-1',date:'2026-11-13',createdAt:'2026-11-13T20:04:00Z',kind:'Psychology',body:'Felt patient, noted nervousness',source:'Contemporaneous app note'}],
   planHistory:[{id:'plan-1',date:'2026-11-14',createdAt:'2026-11-14T17:00:00Z',source:'App plan edit',changes:{targetLevels:{before:'TP1 370',after:'TP1 370 / TP2 355'}}}]
 };
 return {schema:'swing-risk-desk-v2',accounts:[a,b],positions:[position,{...structuredClone(position),id:'pos-smh-tfsa',accountId:'tfsa',externalId:'other-account-trade',notes:'OTHER ACCOUNT PRIVATE DETAILS'}],
 adjustments:[{id:'unrelated-adjustment',accountId:'bdi',pnlCad:-99999}],brokerInbox:[{id:'not-this-trade',raw:'other trade pending'}],
 archive:[{id:'note-deleted',kind:'journal-entry',positionId:'pos-smh-bdi',record:{id:'old-note',body:'Removed but preserved'}},
   {id:'other-note',kind:'journal-entry',positionId:'pos-smh-tfsa',record:{id:'not-this',body:'OTHER ACCOUNT PRIVATE DETAILS'}}],
 importLog:[{raw:'ALL OTHER TRANSACTIONS'}],customClosed:[],revision:11};
}

test('closed SMH exports only selected account-specific trade with every fill and exit, journal, plan revisions and IBKR provenance',()=>{
 const s=fixture();const before=JSON.stringify(s);
 const exportFile=buildSingleTradeHandoff(s,'pos-smh-bdi',{exportedAt:'2026-11-17T21:01:00Z'});
 assert.equal(exportFile.schema,TRADE_HANDOFF_SCHEMA);
 assert.equal(exportFile.portfolio.id,'bdi');
 assert.equal(exportFile.portfolio.brokerAccountId,'BROKER-TEST-1');
 assert.equal(exportFile.scope.isCompleteRecoveryBackup,false);
 assert.equal(exportFile.contract.externalMasterId,'2026-11-13-SWING-SMH-BDI');
 assert.equal(exportFile.position.fills.length,2);assert.equal(exportFile.position.exits.length,2);
 assert.equal(exportFile.realizedExits.length,2);assert.equal(exportFile.summary.remainingContracts,0);
 assert.equal(exportFile.summary.status,'closed');
 assert.equal(exportFile.chronologicalJournalAndPlan.length,2);
 assert.equal(exportFile.archivedCorrections.length,1);
 assert.equal(exportFile.archivedCorrections[0].record.body,'Removed but preserved');
 assert.equal(exportFile.position.fills[0].broker.raw.Symbol,'SMH   261127P00400000');
 assert.equal(exportFile.position.fills[0].fee,.7653);
 assert.ok(exportFile.sourceQuality.warnings.some(x=>x.includes('estimate')));
 assert.ok(exportFile.sourceQuality.warnings.some(x=>x.includes('timezone')));
 assert.ok(exportFile.realizedExits.every(x=>x.returnPct!==null));
 assert.ok(exportFile.summary.realizedNetPnlCad!==null);
 assert.deepEqual(exportFile.realizedExits.map(x=>x.tpLabel),['TP1','Runner']);
 assert.equal(JSON.stringify(s),before,'export must never mutate the saved ledger or backup revision');
 const text=JSON.stringify(exportFile);
 for(const forbidden of ['OTHER ACCOUNT PRIVATE DETAILS','not-this-trade','unrelated-adjustment','ALL OTHER TRANSACTIONS'])assert.equal(text.includes(forbidden),false,`Other-account data leaked: ${forbidden}`);
 assert.match(singleTradeExportFilename(exportFile),/^swing-risk-TRADE-SMH-2026-11-27-400P-BDI-Swing-pos-smh-bdi\.json$/);
});

test('open position exports all partials without inventing a full exit, unrealized P/L, or grade',()=>{
 const s=fixture();s.positions[0].exits=s.positions[0].exits.slice(0,1);
 const e=buildSingleTradeHandoff(s,'pos-smh-bdi');
 assert.equal(e.summary.status,'open');assert.equal(e.summary.remainingContracts,1);
 assert.equal(e.realizedExits.length,1);
 assert.equal(e.summary.outcomeGrade,null);assert.equal(e.summary.unrealizedPnlCad,null);
 assert.ok(e.summary.estimatedOpenReserveCad>0);
 assert.ok(e.sourceQuality.warnings.some(x=>x.includes('remain open')));
 assert.equal(e.position.managementPlan,'Partial at underlying target, then structural runner');
});

test('two separate round trips within one position object carry distinct attempt numbers',()=>{
 const s=fixture();const p=s.positions[0];p.fills=[entry('buy-1',1,1.55,1),entry('buy-2',1,1.55,1,{date:'2026-11-17',time:'14:00'})];
 p.exits=[exit('exit-1','2026-11-16',1,2.25,1),exit('exit-2','2026-11-17',1,1.05,1,{time:'15:00'})];
 const e=buildSingleTradeHandoff(s,'pos-smh-bdi');
 assert.equal(e.realizedAttempts.length,2);
 assert.deepEqual(e.realizedAttempts.map(x=>x.attemptIndex),[1,2]);
 assert.deepEqual(e.realizedExits.map(x=>x.attemptIndex),[1,2]);
});

test('unknown or inconsistent transactions are flagged, not assigned fabricated net profits',()=>{
 const s=fixture();s.positions[0].fills=[];
 const e=buildSingleTradeHandoff(s,'pos-smh-bdi');
 assert.equal(e.summary.realizedNetPnlCad,null);
 assert.ok(e.sourceQuality.warnings.some(x=>x.includes('Reconciliation warning')));
});

test('incomplete economic fields are reported as unknown rather than silently using zero',()=>{
 const s=fixture();s.positions[0].exits[1].fee=null;
 const x=buildSingleTradeHandoff(s,'pos-smh-bdi');
 assert.equal(x.sourceQuality.economicsComplete,false);
 assert.equal(x.summary.realizedNetPnlCad,null);
 assert.equal(x.summary.realizedReturnPct,null);
 assert.ok(x.sourceQuality.warnings.some(w=>w.includes('missing premium, commission')));
 assert.equal(x.position.exits[1].fee,null);
});

test('export requires a matching portfolio and position',()=>{
 const s=fixture();assert.throws(()=>buildSingleTradeHandoff(s,'nonexistent'),/Trade not found/);
 s.accounts=s.accounts.filter(x=>x.id!=='bdi');assert.throws(()=>buildSingleTradeHandoff(s,'pos-smh-bdi'),/matching portfolio/);
});
