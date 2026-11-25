import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPlanIdea,calculatePlanBasket,MAX_PLAN_IDEAS} from '../lib/planner.mjs';
import {emptyPreview} from '../lib/option-preview.mjs';
import {parkPlannerIdea,restorePlannerIdea,deleteSavedPlannerIdea,hydrateTickerScenario,broadcastTickerScenario} from '../lib/planner-workflows.mjs';
import {PLANNER_LOCAL_KEY,PREVIOUS_PLANNER_LOCAL_KEY,savePlannerDrafts,loadPlannerDrafts,clearPlannerDraftStorage} from '../lib/planner-storage.mjs';

const day='2026-11-25',at='2026-11-25T15:00:00Z';
const a={id:'a',fx:1.4,stressPct:70,mode:'stress',roundStep:25};
const idea=(id,extra={})=>({...defaultPlanIdea(id),ticker:'SMH',name:'Swing breakout',expiry:'2026-12-18',strike:'350',qty:'2',price:'1.50',priceManual:true,fee:'2',feeManual:true,plannedLossPct:'35',quoteStatus:'indicative',marketMid:'1.48',preview:{...emptyPreview(day),spot:'350',bid:'1.46',ask:'1.50',ivPct:'40',ivManual:true,quoteAt:at,targets:[{id:'stop',name:'Stop',price:'340'},{id:'tp1',name:'TP1',price:'365'},{id:'tp2',name:'TP2',price:'380'},{id:'tp3',name:'TP3',price:'395'}],dates:['2026-11-27','2026-12-01'],intradayMinutes:[3,15]},...extra});
function storage(initial={}){
 const m=new Map(Object.entries(initial));
 return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),m};
}
test('parking is an independent exact snapshot, removes just one active idea and releases hypothetical allocation',()=>{
 const drafts={a:[idea('one'),idea('two',{ticker:'QQQ'})],b:[idea('other')]},saved={a:[idea('older')]};
 const snapshot=JSON.stringify({drafts,saved});
 const before=calculatePlanBasket(drafts.a,a,1000);
 const moved=parkPlannerIdea(drafts,saved,'a','one',at);
 assert.equal(moved.ok,true);assert.deepEqual(moved.drafts.a.map(x=>x.id),['two']);
 assert.deepEqual(moved.savedIdeas.a.map(x=>x.id),['one','older']);
 assert.equal(moved.savedIdeas.a[0].savedForLaterAt,at);assert.equal(moved.savedIdeas.a[0].preview.targets[3].price,'395');
 assert.equal(moved.savedIdeas.a[0].price,'1.50');assert.equal(moved.savedIdeas.a[0].quoteStatus,'saved');
 assert.equal(moved.drafts.b,drafts.b);assert.equal(JSON.stringify({drafts,saved}),snapshot);
 const after=calculatePlanBasket(moved.drafts.a,a,1000);
 assert.ok(after.plannedReserveCad<before.plannedReserveCad);
 assert.ok(after.remainingCad>before.remainingCad);
 moved.savedIdeas.a[0].preview.targets[0].price='999';
 assert.equal(drafts.a[0].preview.targets[0].price,'340');
});
test('all ideas can be parked; the active basket consumes zero additional risk',()=>{
 const moved=parkPlannerIdea({a:[idea('one')]},{},'a','one',at);
 assert.equal(moved.drafts.a.length,0);
 const basket=calculatePlanBasket(moved.drafts.a,a,123);
 assert.equal(basket.total,0);assert.equal(basket.plannedReserveCad,0);assert.equal(basket.remainingCad,123);
});
test('restore preserves all targets, dates, quantity and planning assumptions, but clears stale pricing',()=>{
 const moved=parkPlannerIdea({a:[idea('one')]},{},'a','one',at);
 const restored=restorePlannerIdea(moved.drafts,moved.savedIdeas,'a','one');
 assert.equal(restored.ok,true);assert.equal(restored.savedIdeas.a.length,0);
 const v=restored.drafts.a[0];assert.equal(v.id,'one');assert.equal(v.qty,'2');assert.equal(v.plannedLossPct,'35');
 assert.deepEqual(v.preview.targets,moved.savedIdeas.a[0].preview.targets);assert.deepEqual(v.preview.dates,['2026-11-27','2026-12-01']);
 assert.deepEqual(v.preview.intradayMinutes,[3,15]);assert.equal(v.price,'');assert.equal(v.priceManual,false);
 for(const k of ['spot','ivPct','bid','ask','quoteAt'])assert.equal(v.preview[k],'');
 assert.equal(v.preview.tickerLinked,false);assert.equal(v.preview.ivManual,false);
 assert.match(v.quoteMessage,/Previous planned premium USD 1.50/);
 assert.equal(calculatePlanBasket([v],a,1000).plannedReserveCad,0);
 assert.equal(moved.savedIdeas.a[0].price,'1.50');
});
test('changing strike and expiry or opening Analyze cannot overwrite restored targets from a linked peer',()=>{
 const parked=parkPlannerIdea({a:[idea('one')]},{},'a','one',at);
 const peer=idea('peer');peer.preview.targets[1].price='999';peer.preview.tickerPlanEditedAt=at;peer.preview.tickerLinkEstablished=true;
 const restored=restorePlannerIdea({a:[peer]},parked.savedIdeas,'a','one');
 const v=restored.idea;v.strike='360';v.expiry='2027-01-15';
 assert.equal(hydrateTickerScenario(restored.drafts.a,v,day).reason,'independent');
 broadcastTickerScenario(restored.drafts.a,peer,day);
 assert.equal(v.preview.targets[1].price,'365');
 assert.equal(v.preview.targets[3].price,'395');
});
test('restore respects eight-active limit, consumes a blank slot, and never crosses portfolios',()=>{
 const shelf={a:[idea('one')],b:[idea('other')]};
 const full={a:Array.from({length:MAX_PLAN_IDEAS},(_,i)=>idea('f'+i))};
 assert.equal(restorePlannerIdea(full,shelf,'a','one').ok,false);
 assert.equal(restorePlannerIdea(full,shelf,'a','other').ok,false);
 const blank=defaultPlanIdea('blank');
 const almost={a:[...full.a.slice(0,7),blank]};
 const result=restorePlannerIdea(almost,shelf,'a','one');
 assert.equal(result.ok,true);assert.equal(result.drafts.a.length,8);assert.ok(!result.drafts.a.some(x=>x.id==='blank'));
 assert.equal(result.savedIdeas.b,shelf.b);assert.equal(shelf.a.length,1);
 assert.equal(parkPlannerIdea({a:[blank]},{},'a','blank').ok,false);
 assert.equal(deleteSavedPlannerIdea(result.drafts,shelf,'a','one').savedIdeas.a.length,0);
});
test('version 2 migration is lossless and retains rollback bytes',()=>{
 const raw=JSON.stringify({version:2,savedAt:at,accounts:{a:[idea('old')]}});
 const local=storage({[PREVIOUS_PLANNER_LOCAL_KEY]:raw});
 const loaded=loadPlannerDrafts(local);
 assert.equal(loaded.migrated,true);assert.equal(loaded.persisted,true);
 assert.equal(loaded.drafts.a[0].preview.targets[3].price,'395');assert.deepEqual(Object.keys(loaded.savedIdeas),[]);
 assert.equal(local.getItem(PREVIOUS_PLANNER_LOCAL_KEY),raw);
 assert.equal(JSON.parse(local.getItem(PLANNER_LOCAL_KEY)).version,3);
});
test('both collections survive reload; the saved list is not limited to eight',()=>{
 const local=storage(),saved={a:Array.from({length:15},(_,i)=>({...idea('s'+i),savedForLaterAt:at})),b:[idea('b')]},active={a:[idea('active')]};
 assert.equal(savePlannerDrafts(local,active,at,saved),true);
 let next=loadPlannerDrafts(local);
 assert.equal(next.savedIdeas.a.length,15);assert.equal(next.savedIdeas.a[14].preview.targets[3].price,'395');
 assert.equal(next.savedIdeas.a[0].savedForLaterAt,at);assert.equal(next.drafts.a.length,1);
 const res=restorePlannerIdea(next.drafts,next.savedIdeas,'a','s14');
 assert.equal(savePlannerDrafts(local,res.drafts,at,res.savedIdeas),true);
 next=loadPlannerDrafts(local);assert.equal(next.savedIdeas.a.length,14);assert.equal(next.drafts.a.length,2);
 assert.ok(next.drafts.a.some(x=>x.id==='s14'&&x.preview.targets[1].price==='365'));
 assert.equal(savePlannerDrafts(local,next.drafts,at),true,'old callers preserve shelf');
 assert.equal(loadPlannerDrafts(local).savedIdeas.a.length,14);
});
test('failed or conflicting storage writes leave last good board intact',()=>{
 const local=storage();const drafts={a:[idea('one')]},shelf={a:[idea('two')]};
 assert.equal(savePlannerDrafts(local,drafts,at,shelf),true);
 const before=local.getItem(PLANNER_LOCAL_KEY);
 const moved=parkPlannerIdea(drafts,shelf,'a','one',at);
 const blocked={getItem:local.getItem,setItem(){throw Error('quota')}};
 assert.equal(savePlannerDrafts(blocked,moved.drafts,at,moved.savedIdeas),false);
 assert.equal(local.getItem(PLANNER_LOCAL_KEY),before);
 assert.equal(savePlannerDrafts(local,drafts,at,{a:[idea('one')]}),false);
 assert.equal(local.getItem(PLANNER_LOCAL_KEY),before);
 local.setItem(PLANNER_LOCAL_KEY,'{broken');
 assert.equal(loadPlannerDrafts(local).persisted,false);
 assert.equal(savePlannerDrafts(local,{},at,{}),false);
 assert.equal(local.getItem(PLANNER_LOCAL_KEY),'{broken');
});
test('reset removes both planner versions, not actual trading ledger',()=>{
 const local=storage({[PLANNER_LOCAL_KEY]:'new',[PREVIOUS_PLANNER_LOCAL_KEY]:'old','swing-risk-desk:data:v1':'ledger'});
 assert.equal(clearPlannerDraftStorage(local),true);
 assert.equal(local.getItem(PLANNER_LOCAL_KEY),null);assert.equal(local.getItem(PREVIOUS_PLANNER_LOCAL_KEY),null);
 assert.equal(local.getItem('swing-risk-desk:data:v1'),'ledger');
});
