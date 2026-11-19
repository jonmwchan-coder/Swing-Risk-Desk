import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPlanIdea} from '../lib/planner.mjs';
import {emptyPreview,normalizePreview} from '../lib/option-preview.mjs';
import {copyPlannerIdeas,broadcastTickerScenario,hydrateTickerScenario,visibleTickerDates,isEmptyPlannerPlaceholder,tickerScenarioKey} from '../lib/planner-workflows.mjs';
const day='2026-11-19';
const idea=(id,ticker='NVDA',optionType='Call',expiry='2027-01-15')=>({...defaultPlanIdea(id,70),ticker,optionType,expiry,strike:'180',price:'2.5',preview:emptyPreview(day)});
const plan=(x,stop,tp1,tp2,dates=['2026-11-20','2026-11-23'])=>{x.preview.targets[0].price=String(stop);x.preview.targets[1].price=String(tp1);x.preview.targets[2].price=String(tp2);x.preview.dates=dates;return x;};

test('copy is append-only, skips target blank placeholder, deep-copies, uses unique IDs and marks indicative quotes saved',()=>{
 const source=plan(idea('a'),175,185,195);source.quoteStatus='indicative';source.marketMid='2.4';
 const original={a:[source],b:[defaultPlanIdea('blank')]};
 const snapshot=JSON.stringify(original);
 const res=copyPlannerIdeas(original,'a','b',()=> 'copy-1',['a','b']);
 assert.equal(res.ok,true);assert.equal(res.count,1);assert.equal(res.previousCount,0);
 assert.equal(res.drafts.b[0].id,'copy-1');assert.equal(res.drafts.b[0].quoteStatus,'saved');
 assert.equal(res.drafts.b[0].preview.targets[0].price,'175');
 assert.equal(JSON.stringify(original),snapshot,'source and destination must be untouched');
 res.drafts.b[0].preview.targets[0].price='999';
 assert.equal(source.preview.targets[0].price,'175','nested data is a deep clone');
});
test('copy leaves destination ideas intact, refuses overflow atomically and never copies ledger',()=>{
 const draft={a:[idea('a'),idea('b')],b:[idea('target')]};
 const res=copyPlannerIdeas(draft,'a','b',(()=>{let i=0;return()=> 'id-'+(++i);})(),['a','b']);
 assert.equal(res.ok,true);assert.equal(res.drafts.b.length,3);assert.equal(res.drafts.b[0].id,'target');
 const full={...draft,b:Array.from({length:7},(_,i)=>idea('t'+i))};
 const fail=copyPlannerIdeas(full,'a','b',()=> 'new',['a','b']);
 assert.equal(fail.ok,false);assert.match(fail.reason,/eight|8-idea/i);assert.equal(full.b.length,7);
 assert.equal(copyPlannerIdeas(draft,'a','a',()=> 'x',['a','b']).ok,false);
 assert.equal(copyPlannerIdeas(draft,'a','deleted',()=> 'x',['a','b']).ok,false);
 assert.equal(copyPlannerIdeas({a:[defaultPlanIdea('blank')],b:[]},'a','b',()=> 'x',['a','b']).ok,false);
});
test('shared ticker and same option direction synchronizes underlying plan without leaking IV or premium',()=>{
 const first=plan(idea('one'),175,185,190),second=idea('two');
 second.preview.spot='183';second.preview.ivPct='61';second.preview.ivManual=true;
 const put=plan(idea('put','NVDA','Put'),200,170,160);
 const amd=idea('amd','AMD');
 const items=[first,second,put,amd];
 const out=broadcastTickerScenario(items,first,day,[], '2026-11-19T18:00:00Z');
 assert.equal(out.copied,1);assert.equal(second.preview.targets[0].price,'175');
 assert.equal(second.preview.ivPct,'61');assert.equal(second.preview.spot,'183');assert.equal(second.price,'2.5');
 assert.equal(put.preview.targets[0].price,'200');assert.equal(amd.preview.targets[0].price,'');
 first.preview.targets[0].price='177';
 broadcastTickerScenario(items,first,day,[], '2026-11-19T18:01:00Z');
 assert.equal(second.preview.targets[0].price,'177','later edits propagate to established links');
 assert.equal(tickerScenarioKey(put),'NVDA|Put');
});
test('new idea automatically adopts matching ticker plan, but manual independent plan is preserved',()=>{
 const owner=plan(idea('one'),170,195,205),other=idea('two');
 broadcastTickerScenario([owner],owner,day);
 const adopted=hydrateTickerScenario([owner,other],other,day);
 assert.equal(adopted.reason,'adopted');assert.equal(other.preview.targets[2].price,'205');
 const different=plan(idea('different'),160,200,210);
 const guarded=hydrateTickerScenario([owner,different],different,day);
 assert.equal(guarded.reason,'preserved-existing');assert.equal(different.preview.targets[0].price,'160');
 assert.equal(different.preview.tickerLinked,false);
 const relinked=hydrateTickerScenario([owner,different],different,day,[],true);
 assert.equal(relinked.reason,'adopted');assert.equal(different.preview.targets[0].price,'170');
});
test('unlink prevents broadcast, and shorter expiration omits incompatible shared dates without deleting them',()=>{
 const one=plan(idea('one'),175,185,190,['2026-11-20','2026-11-27','2027-01-15']);
 const short=idea('short','NVDA','Call','2026-11-27');
 broadcastTickerScenario([one,short],one,day);
 const before=[...short.preview.dates];
 const dates=visibleTickerDates(short);
 assert.deepEqual(dates.visible.map(x=>x.date),['2026-11-20','2026-11-27']);
 assert.deepEqual(dates.excluded.map(x=>x.date),['2027-01-15']);
 assert.deepEqual(short.preview.dates,before,'retain underlying shared plan across option expiries');
 short.preview.tickerLinked=false;
 one.preview.targets[0].price='168';broadcastTickerScenario([one,short],one,day);
 assert.equal(short.preview.targets[0].price,'175');
});
test('copying into a portfolio with different NVDA underlying targets never overwrites its existing plan',()=>{
 const source=plan(idea('src'),175,185,190);
 const dest=plan(idea('existing'),165,175,180);
 const drafts={a:[source],b:[dest]};
 const result=copyPlannerIdeas(drafts,'a','b',()=> 'copied',['a','b']);
 assert.equal(result.ok,true);assert.equal(result.conflicts,1);
 assert.equal(result.drafts.b[0].preview.targets[0].price,'165');
 assert.equal(result.drafts.b[1].preview.targets[0].price,'175');
 assert.equal(result.drafts.b[1].preview.tickerLinked,false);
 result.drafts.b[1].preview.targets[0].price='172';
 broadcastTickerScenario(result.drafts.b,result.drafts.b[1],day);
 assert.equal(result.drafts.b[0].preview.targets[0].price,'165');
});
test('old empty previews with two default sessions can adopt the current ticker plan',()=>{
 const original=plan(idea('src'),175,185,190);
 const peer=idea('old');
 peer.preview=emptyPreview('2026-11-10');
 broadcastTickerScenario([original],original,day);
 const result=hydrateTickerScenario([original,peer],peer,day);
 assert.equal(result.reason,'adopted');
 assert.equal(peer.preview.targets[0].price,'175');
});
test('a draft with an edited quantity is not mistaken for a blank placeholder when copying',()=>{
 const qty=defaultPlanIdea('only');qty.qty='3';
 assert.equal(isEmptyPlannerPlaceholder(qty),false);
});
test('link metadata is persisted by preview normalization without inheriting per-contract IV',()=>{
 const iv=normalizePreview({...emptyPreview(day),ivManual:true,ivPct:'70',tickerLinked:false,tickerLinkEstablished:true,tickerPlanEditedAt:'2026-11-19T19:00:00Z'},day);
 assert.equal(iv.ivManual,true);assert.equal(iv.tickerLinked,false);assert.equal(iv.tickerLinkEstablished,true);
 assert.equal(iv.tickerPlanEditedAt,'2026-11-19T19:00:00Z');
});
