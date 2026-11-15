import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DEFAULT_BUY_FEE_USD,DEFAULT_SELL_FEE_USD,estimateOrderFee,ratePerContract} from '../lib/fees.mjs';
import {normalizeLedger,importIbkrTrades,backupSnapshot,mergeFullBackup} from '../lib/ledger.mjs';
import {calculatePosition} from '../lib/risk.mjs';

const source=JSON.parse(fs.readFileSync(new URL('./fixtures/starter-example.json',import.meta.url),'utf8'));
const csv=fs.readFileSync(new URL('./fixtures/ibkr-example.csv',import.meta.url),'utf8');
const header=csv.trimEnd().split(/\r?\n/)[0];

test('per-portfolio option commissions are estimates in USD per contract, summed per order',()=>{
 const a=normalizeLedger(source).accounts[0];
 assert.equal(DEFAULT_BUY_FEE_USD,0.77);
 assert.equal(DEFAULT_SELL_FEE_USD,1.00);
 assert.equal(a.buyFeePerContractUsd,0.77);
 assert.equal(a.sellFeePerContractUsd,1);
 assert.equal(estimateOrderFee(a,'BUY',1),0.77);
 assert.equal(estimateOrderFee(a,'BUY',2),1.54);
 assert.equal(estimateOrderFee(a,'BUY',3),2.31);
 assert.equal(estimateOrderFee(a,'SELL',3),3);
 assert.equal(estimateOrderFee(a,'SELL',''),0);
 assert.equal(estimateOrderFee(a,'BUY',1.2),0);
 assert.equal(estimateOrderFee(a,'SELL',-1),0);
});

test('portfolio-specific fee settings persist in backup, allow zero, and do not modify historic fees',()=>{
 const s=normalizeLedger(source);
 const original=s.positions[0].fills[0].fee;
 s.accounts[0].buyFeePerContractUsd=0.93;
 s.accounts[0].sellFeePerContractUsd=0;
 const normalized=normalizeLedger(backupSnapshot(s));
 assert.equal(ratePerContract(normalized.accounts[0],'BUY'),0.93);
 assert.equal(ratePerContract(normalized.accounts[0],'SELL'),0);
 assert.equal(estimateOrderFee(normalized.accounts[0],'BUY',2),1.86);
 assert.equal(estimateOrderFee(normalized.accounts[0],'SELL',2),0);
 assert.equal(normalized.positions[0].fills[0].fee,original);
 const older=normalizeLedger(source);
 const reconciled=mergeFullBackup(older,normalized);
 assert.equal(reconciled.next.accounts[0].buyFeePerContractUsd,0.77,'current rules retained on merge');
 assert.ok(reconciled.report.conflicts>0,'conflicting settings preserved for review');
});

test('IBKR actual buy fee replaces ONLY flagged estimated matching commission',()=>{
 const s=normalizeLedger(source),tx=s.positions[0].fills[0];
 tx.fee=0.77;tx.feeEstimated=true;
 const first=importIbkrTrades(s,csv);
 assert.equal(first.report.added,0);
 assert.equal(first.report.sourceLinked,2);
 assert.equal(first.report.pending,0);
 const filled=first.next.positions[0].fills[0];
 assert.equal(filled.fee,0.31,'broker actual commission preserved');
 assert.equal(filled.feeEstimated,false);
 assert.equal(filled.broker.estimatedFeeBeforeBrokerLink,0.77);
 assert.equal(filled.broker.commissionRaw,-0.31);
 const second=importIbkrTrades(first.next,csv);
 assert.equal(second.report.added,0);
 assert.equal(second.report.pending,0);
 assert.equal(second.next.positions[0].fills.length,2,'reimport never duplicates the trade');
});

test('IBKR actual SELL commission supersedes estimated sale, with P/L recomputed once',()=>{
 const s=normalizeLedger(source),p=s.positions[0];
 p.exits.push({id:'manual-sale-estimated',date:'2026-10-02',time:'15:30:00',qty:1,price:2.5,fee:1,feeEstimated:true,fx:1.4});
 const estimated=calculatePosition(p,s.accounts[0],'2026-10-02').closes[0].pnlCad;
 const sellLine='U99999999,DEMO   261120P00125000,SELL,1,2.50,250,-0.82,249.18,20261002,20261005,DEMOEX,LMT,USD,OPT,20261002;153000';
 const first=importIbkrTrades(s,`${header}\n${sellLine}\n`);
 assert.equal(first.report.sourceLinked,1);
 assert.equal(first.report.added,0);
 assert.equal(first.report.pending,0);
 const sale=first.next.positions[0].exits[0];
 assert.equal(sale.fee,0.82);
 assert.equal(sale.broker.estimatedFeeBeforeBrokerLink,1);
 assert.equal(sale.feeEstimated,false);
 const actual=calculatePosition(first.next.positions[0],first.next.accounts[0],'2026-10-02').closes[0].pnlCad;
 assert.ok(actual>estimated,'lower broker fee yields higher true net P/L');
 assert.ok(Math.abs((actual-estimated)-0.18*1.4)<0.0001);
});

test('manually overridden fee disagreement is quarantined, not silently rewritten',()=>{
 const s=normalizeLedger(source);
 s.positions[0].fills[0].fee=0.77;
 s.positions[0].fills[0].feeEstimated=false;
 const r=importIbkrTrades(s,csv);
 assert.equal(r.report.pending,1);
 assert.equal(r.report.sourceLinked,1);
 assert.equal(r.next.positions[0].fills[0].fee,0.77);
 assert.equal(r.next.positions[0].fills.length,2);
 assert.ok(r.next.brokerInbox.some(x=>/commission/.test(x.reason)));
});

test('ambiguous estimated buy matches cannot be silently linked or create duplicate positions',()=>{
 const s=normalizeLedger(source);
 const first=s.positions[0].fills[0];first.fee=0.77;first.feeEstimated=true;
 s.positions[0].fills.push({...structuredClone(first),id:'unverified-duplicate'});
 const r=importIbkrTrades(s,`${header}\n${csv.split(/\r?\n/)[1]}\n`);
 assert.equal(r.report.sourceLinked,0);
 assert.equal(r.report.pending,1);
 assert.equal(r.report.added,0);
 assert.equal(r.next.positions[0].fills.length,3);
});
