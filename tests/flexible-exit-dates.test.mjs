import test from 'node:test';
import assert from 'node:assert/strict';
import {availablePreviewDate,previewDateIssue,emptyPreview,projectOptionReturns,scenarioProjectionGroups} from '../lib/option-preview.mjs';
const at='2026-11-25T18:28:00Z',expiry='2026-11-27';
test('Black Friday expiry already selected: Add Date finds Wednesday before close',()=>{
 const dates=[expiry,'2026-11-30'];
 const before=JSON.stringify(dates);
 assert.deepEqual(availablePreviewDate(dates,expiry,at),{date:'2026-11-25',reason:''});
 assert.equal(JSON.stringify(dates),before);
 assert.equal(availablePreviewDate([...dates,'2026-11-25'],expiry,at).date,null);
 assert.match(previewDateIssue('2026-11-26',expiry,at),/Market closed/);
});
test('earliest missing future session, regardless of last selected date',()=>{
 const dates=['2026-12-04','2026-11-30','2026-11-25'];
 assert.equal(availablePreviewDate(dates,'2026-12-04',at).date,'2026-11-27');
 assert.equal(availablePreviewDate(['2026-12-04'],'2026-12-04',at,['2026-11-25','2026-11-27']).date,'2026-11-30');
 assert.equal(availablePreviewDate([],null,at).date,'2026-11-25');
});
test('past and early closes, duplicates, holiday, custom closure, invalid dates and expiration bounds',()=>{
 assert.equal(availablePreviewDate([expiry],expiry,'2026-11-25T21:00:00Z').date,null);
 assert.equal(availablePreviewDate([],expiry,'2026-11-25T21:00:00Z').date,expiry);
 assert.equal(availablePreviewDate([],expiry,'2026-11-27T17:59:00Z').date,expiry);
 assert.equal(availablePreviewDate([],expiry,'2026-11-27T18:00:00Z').date,null);
 assert.match(previewDateIssue('2026-11-25',expiry,'2026-11-25T21:00:00Z'),/already passed/);
 assert.match(previewDateIssue('2026-11-30',expiry,at),/after this option expires/);
 assert.match(previewDateIssue('2026-11-25',expiry,at,['2026-11-25']),/Market closed/);
 assert.match(previewDateIssue('2026-02-30',expiry,at),/valid date/);
 assert.equal(previewDateIssue('2026-11-25',expiry,at),'');
});
test('capacity is enforced without discarding hidden shared plan dates',()=>{
 const dates=['2026-11-27','2026-11-30','2026-12-01','2026-12-02','2026-12-03','2026-12-04'];
 const result=availablePreviewDate(dates,expiry,at);
 assert.equal(result.date,null);assert.match(result.reason,/6 saved date slots/);
 assert.equal(dates.length,6);
});
test('adding earlier day keeps expiration matrix separate and same-day minute mode unchanged',()=>{
 const contract={ticker:'RIOT',expiry,strike:15,optionType:'Call'};
 const preview={...emptyPreview('2026-11-25'),dates:[expiry],spot:'15',ivPct:'60',bid:'0.5',ask:'0.6'};
 const next=availablePreviewDate(preview.dates,expiry,at);
 const p={...preview,dates:[...preview.dates,next.date].sort()};
 const args={contract,preview:p,qty:1,entryPremium:.6,includeExpiryDay:true};
 const out=projectOptionReturns({...args,asOf:at}),groups=scenarioProjectionGroups(out,contract);
 assert.equal(out.valid,true);assert.equal(groups.daily.length,1);assert.equal(out.columns[groups.daily[0]].sessionDate,'2026-11-25');assert.equal(groups.expiry.length,4);
 const zero=projectOptionReturns({...args,asOf:'2026-11-27T15:00:00Z'});
 assert.equal(zero.valid,true);assert.deepEqual(scenarioProjectionGroups(zero,contract).daily,[]);assert.equal(zero.columns[0].label,'+5m');
 assert.deepEqual(preview.dates,[expiry]);
});