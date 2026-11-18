import test from 'node:test';
import assert from 'node:assert/strict';
import {PLANNER_LOCAL_KEY,LEGACY_PLANNER_SESSION_KEY,normalizePlannerDrafts,savePlannerDrafts,loadPlannerDrafts,clearPlannerDraftStorage} from '../lib/planner-storage.mjs';

function storage(initial={}){
 const data=new Map(Object.entries(initial));
 return {getItem:key=>data.has(key)?data.get(key):null,setItem:(key,val)=>{data.set(key,String(val));},removeItem:key=>{data.delete(key);},has:key=>data.has(key),data};
}
const draft=(id,label='INTC 1/15/27 70C',price='1.29')=>({id,label,qty:'2',price,fee:'1.54',feeManual:true,stress:'55',stressCustom:true});

test('autosaved drafts survive a simulated browser restart and retain all inputs',()=>{
 const local=storage(),first={bdi:[draft('one'),draft('two','SMH 11/27/26 400P','2.05')],tfsa:[draft('three','NVDA','0.75')]};
 assert.equal(savePlannerDrafts(local,first,'2026-11-18T14:59:00.000Z'),true);
 const next=loadPlannerDrafts(local,storage());
 assert.equal(next.persisted,true);
 assert.equal(next.savedAt,'2026-11-18T14:59:00.000Z');
 assert.equal(next.drafts.bdi.length,2);
 assert.deepEqual(next.drafts.bdi[0],draft('one'));
 assert.deepEqual(next.drafts.bdi[1],draft('two','SMH 11/27/26 400P','2.05'));
 assert.deepEqual(next.drafts.tfsa[0],draft('three','NVDA','0.75'));
});

test('legacy tab-session drafts migrate to persistent storage without losing fields',()=>{
 const local=storage();const old=storage({[LEGACY_PLANNER_SESSION_KEY]:JSON.stringify({bdi:[draft('old','INTC 1/15/27 70C','1.15')]})});
 const result=loadPlannerDrafts(local,old);
 assert.equal(result.migrated,true);assert.equal(result.persisted,true);
 assert.equal(old.has(LEGACY_PLANNER_SESSION_KEY),false);
 assert.equal(local.has(PLANNER_LOCAL_KEY),true);
 const reopened=loadPlannerDrafts(local,storage());
 assert.deepEqual(reopened.drafts.bdi[0],draft('old','INTC 1/15/27 70C','1.15'));
});

test('local drafts win over stale legacy sessions, and portfolios stay distinct',()=>{
 const local=storage(),session=storage({[LEGACY_PLANNER_SESSION_KEY]:JSON.stringify({bdi:[draft('stale')]})});
 const existing={bdi:[draft('latest','AMD','3.25')],tfsa:[draft('other','QQQ','1.00')]};
 savePlannerDrafts(local,existing);
 const result=loadPlannerDrafts(local,session);
 assert.equal(result.migrated,false);
 assert.equal(result.drafts.bdi[0].label,'AMD');assert.equal(result.drafts.tfsa[0].label,'QQQ');
});

test('empty, partial or invalid drafts do not turn into hypothetical priced reserves',()=>{
 const normalized=normalizePlannerDrafts({bdi:[{id:'a',label:'TICKER',qty:'',price:'1.',fee:'',stress:'',feeManual:false},{id:'b',label:'',qty:'1',price:''},{id:'b',label:'duplicate'}],invalid:42});
 assert.equal(normalized.bdi.length,2);
 assert.equal(normalized.bdi[0].qty,'');
 assert.equal(normalized.bdi[0].price,'1.');
 assert.equal(normalized.bdi[0].stress,'');
 assert.equal(normalized.bdi[1].price,'');
 assert.equal('invalid' in normalized,false);
});

test('malformed stored data never crashes the app or overwrites the existing bytes',()=>{
 const local=storage({[PLANNER_LOCAL_KEY]:'{bad json'});
 const result=loadPlannerDrafts(local,storage({[LEGACY_PLANNER_SESSION_KEY]:JSON.stringify({bdi:[draft('old')]})}));
 assert.equal(result.persisted,false);
 assert.deepEqual(Object.keys(result.drafts),[]);
 assert.equal(local.getItem(PLANNER_LOCAL_KEY),'{bad json');
});

test('limits restored rows to eight and strips duplicate IDs',()=>{
 const many=Array.from({length:20},(_,i)=>draft(`id${i}`));many.splice(1,0,draft('id0'));
 const clean=normalizePlannerDrafts({bdi:many});
 assert.equal(clean.bdi.length,8);
 assert.equal(new Set(clean.bdi.map(x=>x.id)).size,8);
});

test('clearing drafts removes both current and legacy storage but leaves trading ledger untouched',()=>{
 const local=storage({[PLANNER_LOCAL_KEY]:'saved','swing-risk-desk:data:v1':'real ledger'}),session=storage({[LEGACY_PLANNER_SESSION_KEY]:'old'});
 assert.equal(clearPlannerDraftStorage(local,session),true);
 assert.equal(local.has(PLANNER_LOCAL_KEY),false);assert.equal(session.has(LEGACY_PLANNER_SESSION_KEY),false);
 assert.equal(local.getItem('swing-risk-desk:data:v1'),'real ledger');
});

test('storage failures are reported rather than falsely claiming autosave',()=>{
 const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}};
 const legacy=storage({[LEGACY_PLANNER_SESSION_KEY]:JSON.stringify({bdi:[draft('a')]})});
 const result=loadPlannerDrafts(blocked,legacy);
 assert.equal(result.persisted,false);assert.equal(legacy.has(LEGACY_PLANNER_SESSION_KEY),true);
 assert.equal(savePlannerDrafts(blocked,{bdi:[draft('b')]}),false);
 assert.equal(clearPlannerDraftStorage(blocked,legacy),false);
});
