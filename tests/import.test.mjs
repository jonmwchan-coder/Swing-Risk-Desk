import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseIbkrTrades,isIbkrCsv,occContract} from '../lib/ibkr.mjs';
import {normalizeLedger,importIbkrTrades,mergeFullBackup,makeJournalEntry,recordPlanEdit,backupSnapshot} from '../lib/ledger.mjs';
const ibkr=fs.readFileSync(new URL('./fixtures/ibkr-example.csv', import.meta.url),'utf8');
const starter=JSON.parse(fs.readFileSync(new URL('./fixtures/starter-example.json', import.meta.url),'utf8'));
test('parse synthetic IBKR-style two exact option fills and commissions',()=>{
 assert.equal(isIbkrCsv(ibkr),true);const r=parseIbkrTrades(ibkr);assert.equal(r.totalRows,2);assert.equal(r.errors.length,0);
 assert.equal(r.trades[0].contract.strike,125);assert.equal(r.trades[0].contract.expiry,'2026-11-20');
 assert.equal(r.trades[0].fee,.31);assert.equal(r.trades[1].fee,.33);assert.equal(r.trades[0].time,'10:11:12');
 assert.equal(occContract('DEMO261120P00125000').optionType,'Put');
});
test('matches previously seeded DEMO fills without duplicating, and reimport stays idempotent',()=>{
 const initial=normalizeLedger(starter);
 const x=importIbkrTrades(initial,ibkr);
 assert.equal(x.report.added,0);assert.equal(x.report.sourceLinked,2);assert.equal(x.report.duplicates,2);
 assert.equal(x.next.positions[0].fills.length,2);assert.equal(x.next.positions[0].fills[0].broker.raw.Exchange,'DEMOEX');
 const y=importIbkrTrades(x.next,ibkr);assert.equal(y.report.added,0);assert.equal(y.report.duplicates,2);
 assert.equal(y.next.positions[0].fills.length,2);
});
test('empty account imports two genuine buys as one position and does not duplicate on second statement',()=>{
 const initial=normalizeLedger({...starter,positions:[]});
 const first=importIbkrTrades(initial,ibkr);
 assert.equal(first.report.newPositions,1);assert.equal(first.report.added,2);
 assert.equal(first.next.positions[0].fills.length,2);
 const second=importIbkrTrades(first.next,ibkr);
 assert.equal(second.report.added,0);assert.equal(second.report.duplicates,2);
});
test('unmatched broker SELL is preserved for later reconciliation instead of invented cost basis',()=>{
 const csv=ibkr.replaceAll(',BUY,',',SELL,');
 const res=importIbkrTrades(normalizeLedger({...starter,positions:[]}),csv);
 assert.equal(res.report.added,0);assert.equal(res.report.pending,2);
 assert.equal(res.next.brokerInbox.length,2);assert.equal(res.next.positions.length,0);
});
test('plan editing archives prior invalidation and notes append chronologically',()=>{
 const s=normalizeLedger(starter);const p=s.positions[0];
 recordPlanEdit(p,{underlyingInvalidation:'daily close above 415',targetLevels:'TP1 390; TP2 380',thesis:'bear continuation'}, {date:'2026-11-14'});
 makeJournalEntry(p,{date:'2026-11-14',kind:'Psychology',text:'Wanted to TP too early and stayed with the structure.'});
 recordPlanEdit(p,{underlyingInvalidation:'daily close above 420'},{date:'2026-11-17'});
 assert.equal(p.planHistory.length,2);assert.equal(p.planHistory[1].changes.underlyingInvalidation.before,'daily close above 415');
 assert.match(JSON.stringify(backupSnapshot(s)),/Wanted to TP too early/);
});
test('backup round trip merges without duplicate fills, notes or plan history',()=>{
 const s=normalizeLedger(starter),p=s.positions[0];
 recordPlanEdit(p,{targetLevels:'TP1 390'},{date:'2026-11-14'});
 makeJournalEntry(p,{text:'Test note',date:'2026-11-14'});
 const backup=backupSnapshot(s);const first=mergeFullBackup(s,backup);
 assert.equal(first.report.newTransactions,0);assert.equal(first.next.positions[0].fills.length,2);
 assert.equal(first.next.positions[0].journalEntries.length,1);
 const second=mergeFullBackup(first.next,backup);
 assert.equal(second.next.positions[0].journalEntries.length,1);
 assert.equal(second.next.positions[0].planHistory.length,1);
});

test('two identical printed IBKR fills are not silently collapsed and are flagged as ambiguous',()=>{
 const parts=ibkr.trimEnd().split(/\r?\n/);const csv=[parts[0],parts[1],parts[1]].join('\n');
 const r=importIbkrTrades(normalizeLedger({...starter,positions:[]}),csv);
 assert.equal(r.report.ambiguous,1);assert.equal(r.report.added,2);assert.equal(r.next.positions[0].fills.length,2);
 const again=importIbkrTrades(r.next,csv);assert.equal(again.report.added,0);
});
test('IBKR partial exit reduces contract count and creates realized event without manufacturing a reason',()=>{
 const opening=importIbkrTrades(normalizeLedger({...starter,positions:[]}),ibkr);
 const hdr=ibkr.trimEnd().split(/\r?\n/)[0];
 const sale='U99999999,DEMO   261120P00125000,SELL,1,1.80,180,-0.80,179.20,20261005,20261006,DEMOEX,LMT,USD,OPT,20261005;101500';
 const sell=importIbkrTrades(opening.next,`${hdr}\n${sale}\n`);
 assert.equal(sell.report.added,1);assert.equal(sell.next.positions[0].exits.length,1);
 assert.equal(sell.next.positions[0].exits[0].reason,undefined);
 assert.equal(sell.next.positions[0].exits[0].qty,1);
});

test('new 0DTE buys are held for review by default, but may be explicitly included',()=>{
 const csv=ibkr.replaceAll('261120P','261002P');
 const initial=normalizeLedger({...starter,positions:[]});
 const held=importIbkrTrades(initial,csv);
 assert.equal(held.report.added,0);assert.equal(held.report.pending,2);
 const approved=importIbkrTrades(initial,csv,{includeSameDayExpiry:true});
 assert.equal(approved.report.added,2);
});

test('IBKR account can be explicitly mapped by the user without embedding any real account IDs in the app',()=>{
 const original=normalizeLedger({...starter,accounts:[{...starter.accounts[0],brokerAccountId:''}],positions:[]});
 const mapped=importIbkrTrades(original,ibkr,{accountMap:{U99999999:'bdi'}});
 assert.equal(mapped.report.newAccounts,0);
 assert.equal(mapped.next.accounts.length,1);
 assert.equal(mapped.next.accounts[0].brokerAccountId,'U99999999');
 assert.equal(mapped.next.positions[0].accountId,'bdi');
 assert.equal(mapped.next.positions[0].fills.length,2);
 const again=importIbkrTrades(mapped.next,ibkr);
 assert.equal(again.report.added,0);
 assert.equal(again.report.duplicates,2);
});

test('unknown IBKR account starts with zero equity rather than inventing a portfolio budget',()=>{
 const original=normalizeLedger({...starter,accounts:[{...starter.accounts[0],brokerAccountId:''}],positions:[]});
 const result=importIbkrTrades(original,ibkr);
 const a=result.next.accounts.find(a=>a.brokerAccountId==='U99999999');
 assert.equal(a.equityCad,0);
 assert.equal(result.next.positions[0].accountId,a.id);
 assert.equal(result.report.newAccounts,1);
});

test('broker transaction archived on purpose is not resurrected by reimport',()=>{
 let s=importIbkrTrades(normalizeLedger(starter),ibkr).next;
 const t=s.positions[0].fills[0];
 s.archive.push({id:'archive-demo',kind:'transaction',record:{side:'BUY',tx:structuredClone(t)},positionId:s.positions[0].id});
 s.positions[0].fills.splice(0,1);
 const res=importIbkrTrades(s,ibkr);
 assert.equal(res.report.added,0);
 assert.equal(res.next.positions[0].fills.length,1);
});

test('later IBKR scale-in adds a new fill to the same open idea, within the explicitly mapped portfolio',()=>{
 const head=ibkr.trimEnd().split(/\r?\n/)[0];
 const addedRow='U99999999,DEMO   261120P00125000,BUY,1,1.91,-191,-0.41,-191.41,20261005,20261005,DEMOEX,LMT,USD,OPT,20261005;132515';
 const csv=`${head}\n${addedRow}\n`;
 const s=normalizeLedger(starter);
 const first=importIbkrTrades(s,csv);
 assert.equal(first.report.newPositions,0);
 assert.equal(first.report.updatedPositions,1);
 assert.equal(first.report.added,1);
 assert.equal(first.next.positions.length,1);
 assert.equal(first.next.positions[0].fills.length,3);
 assert.equal(first.next.positions[0].ideaId,s.positions[0].ideaId);
 const again=importIbkrTrades(first.next,csv);
 assert.equal(again.report.added,0);
 assert.equal(again.report.duplicates,1);
 assert.equal(again.next.positions.length,1);
});

test('IBKR can link a manually entered same-day add with unknown time instead of double-counting it',()=>{
 const head=ibkr.trimEnd().split(/\r?\n/)[0];
 const row='U99999999,DEMO   261120P00125000,BUY,1,1.91,-191,-0.41,-191.41,20261005,20261005,DEMOEX,LMT,USD,OPT,20261005;132515';
 const s=normalizeLedger(starter);
 s.positions[0].fills.push({id:'manual-extra',date:'2026-10-05',time:'23:59',timeUnverified:true,qty:1,price:1.91,fee:0.41,fx:1.4});
 const r=importIbkrTrades(s,`${head}\n${row}\n`);
 assert.equal(r.report.sourceLinked,1);
 assert.equal(r.report.added,0);
 assert.equal(r.report.newPositions,0);
 assert.equal(r.next.positions[0].fills.length,3);
 assert.match(r.next.positions[0].fills[2].broker.sourceKey,/ibkr-v1/);
});

test('IBKR recognizes the first entry recorded manually on same day with unknown execution time',()=>{
 const head=ibkr.trimEnd().split(/\r?\n/)[0];
 const row='U99999999,DEMO   261120P00125000,BUY,1,1.91,-191,-0.41,-191.41,20261005,20261005,DEMOEX,LMT,USD,OPT,20261005;132515';
 const s=normalizeLedger(starter);
 s.positions[0].fills=[{id:'manual-first',date:'2026-10-05',time:'23:59',timeUnverified:true,qty:1,price:1.91,fee:0.41,fx:1.4}];
 const r=importIbkrTrades(s,`${head}\n${row}\n`);
 assert.equal(r.report.sourceLinked,1);
 assert.equal(r.report.newPositions,0);
 assert.equal(r.next.positions.length,1);
 assert.equal(r.next.positions[0].fills.length,1);
});

test('two open independent ideas of same contract are quarantined instead of guessed',()=>{
 const head=ibkr.trimEnd().split(/\r?\n/)[0];
 const row='U99999999,DEMO   261120P00125000,BUY,1,1.91,-191,-0.41,-191.41,20261005,20261005,DEMOEX,LMT,USD,OPT,20261005;132515';
 const s=normalizeLedger(starter);
 s.positions.push({...structuredClone(s.positions[0]),id:'different-idea',ideaId:'INDEPENDENT-THESIS'});
 const r=importIbkrTrades(s,`${head}\n${row}\n`);
 assert.equal(r.report.added,0);
 assert.equal(r.report.pending,1);
 assert.equal(r.next.positions.length,2);
});

test('a new BUY after the same contract was completely closed becomes a new trade idea',()=>{
 const head=ibkr.trimEnd().split(/\r?\n/)[0];
 const row='U99999999,DEMO   261120P00125000,BUY,1,1.91,-191,-0.41,-191.41,20261006,20261006,DEMOEX,LMT,USD,OPT,20261006;132515';
 const s=normalizeLedger(starter);
 s.positions[0].exits=[{id:'complete-exit',date:'2026-10-05',time:'13:15:00',qty:2,price:3,fee:0.6,fx:1.4}];
 const r=importIbkrTrades(s,`${head}\n${row}\n`);
 assert.equal(r.report.added,1);
 assert.equal(r.report.newPositions,1);
 assert.equal(r.next.positions.length,2);
 assert.notEqual(r.next.positions[0].id,r.next.positions[1].id);
});

test('journal and plan removals survive merges, yet remain recoverable and reversible',()=>{
 const s=normalizeLedger(starter);const p=s.positions[0];
 const note=makeJournalEntry(p,{kind:'Psychology / emotion',text:'Paper-hands warning',date:'2026-11-14'});
 recordPlanEdit(p,{thesis:'A strong contemporaneous setup',targetLevels:'TP1 125'},{date:'2026-11-14'});
 const plan=p.planHistory[0];
 const before=structuredClone(s);
 s.archive.push({id:'arc-note',kind:'journal-entry',date:'2026-11-14T10:00:00.000Z',positionId:p.id,record:structuredClone(note)});
 s.archive.push({id:'arc-plan',kind:'plan-revision',date:'2026-11-14T10:00:01.000Z',positionId:p.id,record:structuredClone(plan)});
 p.journalEntries=[];p.planHistory=[];
 const r=mergeFullBackup(s,before);
 assert.equal(r.next.positions[0].journalEntries.length,0);
 assert.equal(r.next.positions[0].planHistory.length,0);
 assert.equal(r.next.archive.filter(a=>a.kind==='journal-entry'||a.kind==='plan-revision').length,2);
 assert.equal(r.next.positions[0].thesis,'A strong contemporaneous setup');
 const restored=structuredClone(r.next);
 restored.archive[0].restoredAt='2026-11-14T11:00:00.000Z';
 restored.archive[1].restoredAt='2026-11-14T11:00:01.000Z';
 restored.positions[0].journalEntries.push(note);
 restored.positions[0].planHistory.push(plan);
 const merged=mergeFullBackup(r.next,restored);
 assert.equal(merged.next.positions[0].journalEntries.length,1);
 assert.equal(merged.next.positions[0].planHistory.length,1);
 const again=mergeFullBackup(merged.next,before);
 assert.equal(again.next.positions[0].journalEntries.length,1);
 assert.equal(again.next.positions[0].planHistory.length,1);
});

test('older journal entries without IDs get consistent IDs across independent backup loads',()=>{
 const initial=structuredClone(starter);initial.positions[0].journalEntries=[{date:'2026-10-02',body:'A legacy note',kind:'Journal / process'}];
 initial.positions[0].planHistory=[{date:'2026-10-02',changes:{thesis:{before:'',after:'Legacy thesis'}}}];
 const one=normalizeLedger(initial),two=normalizeLedger(initial);
 assert.equal(one.positions[0].journalEntries[0].id,two.positions[0].journalEntries[0].id);
 assert.equal(one.positions[0].planHistory[0].id,two.positions[0].planHistory[0].id);
});

test('a removed alternative plan from a stale backup is not reconstructed as a fresh conflict',()=>{
 const current=normalizeLedger(starter);const p=current.positions[0];
 p.thesis='Active new assessment';
 p.planHistory=[];
 const old=normalizeLedger(starter);
 old.positions[0].thesis='Prior alternative interpretation';
 const archived={id:'archive-old-plan',kind:'plan-revision',date:'2026-11-14T13:00:00.000Z',positionId:p.id,record:{id:'archived-alternative',date:'2026-11-14',changes:{thesis:{before:'Active new assessment',after:'Prior alternative interpretation'}}}};
 current.archive.push(archived);
 const merged=mergeFullBackup(current,old);
 assert.equal(merged.next.positions[0].planHistory.length,0);
 assert.equal(merged.report.conflicts,0);
});