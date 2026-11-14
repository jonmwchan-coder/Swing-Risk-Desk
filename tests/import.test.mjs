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