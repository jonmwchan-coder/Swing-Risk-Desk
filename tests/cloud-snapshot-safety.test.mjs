import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLedger,mergeFullBackup} from '../lib/ledger.mjs';
import {reconcileForCloud,createCloudController} from '../lib/cloud.mjs';
const clone=x=>structuredClone(x);
const fixture=()=>normalizeLedger({
 schema:'swing-risk-desk-v2',revision:13,accounts:[{id:'bdi',name:'Trading',equityCad:20000,fx:1.4,roundStep:25,window:5,riskPct:3,stressPct:70,mode:'stress',ideaCapCad:200,
 equityCheckpoints:[{id:'initial',date:'2026-11-13',createdAt:'2026-11-13T00:00:00Z',equityCad:20000,realizedPnlCad:0}]}],
 positions:[{id:'smh',accountId:'bdi',ticker:'SMH',optionType:'Put',strike:400,expiry:'2026-11-27',ideaId:'smh-2026',fills:[
 {id:'buy1',date:'2026-11-13',time:'13:45',qty:1,price:1.55,fee:.77,fx:1.4},
 {id:'buy2',date:'2026-11-13',time:'15:59',qty:1,price:1.41,fee:.77,fx:1.4}],
 exits:[{id:'tp1',date:'2026-11-16',time:'10:10',qty:1,price:2.88,fee:1,fx:1.4},
 {id:'tp2',date:'2026-11-17',time:'10:43',qty:1,price:4.45,fee:1,fx:1.4}],
 journalEntries:[{id:'note1',date:'2026-11-16',kind:'Process',body:'held first TP'},{id:'note2',date:'2026-11-17',kind:'Process',body:'held final TP'}]}],adjustments:[],customClosed:[],archive:[],conflicts:[],importLog:[],brokerInbox:[]
});
const stale=()=>{const x=fixture();x.revision=9;x.positions[0].exits=[];x.positions[0].journalEntries=[x.positions[0].journalEntries[0]];return x;};

test('older browser snapshot cannot erase two recorded SMH exits or final journal notes',()=>{
 const newest=fixture(),old=stale();
 const result=reconcileForCloud(newest,old);
 assert.equal(result.changed,false,'remote already holds the complete trade; do not re-save older snapshot');
 assert.deepEqual(result.next.positions[0].exits.map(x=>x.id),['tp1','tp2']);
 assert.equal(result.next.positions[0].journalEntries.length,2);
});

test('a desktop with the complete SMH history can repair cloud snapshot missing exits',()=>{
 const cloud=stale(),desktop=fixture();
 const result=reconcileForCloud(cloud,desktop);
 assert.equal(result.changed,true);
 assert.equal(result.report.newTransactions,2);
 assert.deepEqual(result.next.positions[0].exits.map(x=>x.id),['tp1','tp2']);
 assert.equal(result.next.positions[0].journalEntries.length,2);
});

test('new execution on phone merges with desktop execution without deleting either',()=>{
 const desktop=fixture(),phone=fixture();
 phone.positions[0].fills.push({id:'buy-new',date:'2026-11-18',time:'10:00',qty:1,price:1,fee:1,fx:1.4});
 phone.positions[0].journalEntries.push({id:'note-new',date:'2026-11-18',kind:'Process',body:'added on mobile'});
 const result=reconcileForCloud(desktop,phone);
 assert.equal(result.next.positions[0].fills.length,3);
 assert.equal(result.next.positions[0].exits.length,2);
 assert.equal(result.next.positions[0].journalEntries.length,3);
});

test('explicit archived corrections remain removed across device merges',()=>{
 const remote=fixture(),local=fixture(),removed=local.positions[0].exits.pop();
 local.archive.push({id:'arch-tp2',kind:'transaction',positionId:'smh',date:'2026-11-18T12:00:00Z',record:{side:'SELL',tx:removed}});
 const result=reconcileForCloud(remote,local);
 assert.equal(result.changed,true);
 assert.deepEqual(result.next.positions[0].exits.map(e=>e.id),['tp1']);
 assert.equal(result.next.archive.length,1);
 const restore=clone(result.next);restore.archive[0].restoredAt='2026-11-19T12:00:00Z';restore.positions[0].exits.push(removed);
 const reconciled=reconcileForCloud(result.next,restore);
 assert.deepEqual(reconciled.next.positions[0].exits.map(e=>e.id).sort(),['tp1','tp2']);
});

test('account settings from stale browsers cannot reset newer cloud settings',()=>{
 const cloud=fixture(),local=fixture();
 cloud.accounts[0].riskPct=4;local.accounts[0].riskPct=3;
 const withoutBase=reconcileForCloud(cloud,local);
 assert.equal(withoutBase.next.accounts[0].riskPct,4);
 const base={bdi:{riskPct:3}};
 const withLocalChange=fixture();withLocalChange.accounts[0].riskPct=5;
 const safeChange=reconcileForCloud(fixture(),withLocalChange,base);
 assert.equal(safeChange.next.accounts[0].riskPct,5,'actual local setting edit can sync if cloud field did not change');
 const collision=reconcileForCloud(cloud,withLocalChange,base);
 assert.equal(collision.next.accounts[0].riskPct,4,'concurrent cloud change wins until manually resolved');
 assert.deepEqual(collision.settingsConflicts,['bdi.riskPct']);
});

test('same-login device with obsolete marker adopts complete cloud without creating a new revision',async()=>{
 const oldLocalStorage=globalThis.localStorage;
 const memory=new Map([['swing-risk-desk:cloud-marker:v1',JSON.stringify({userId:'user-a',cloudRevision:14,localRevision:9})]]);
 globalThis.localStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)};
 let cloud={revision:14,state:fixture()},local=stale(),writes=0;
 const client={
  from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:clone(cloud),error:null})})})}),
  rpc:async(_,args)=>{writes++;if(args.p_expected_revision!==cloud.revision)return {error:{code:'40001',message:'version conflict'}};cloud={revision:cloud.revision+1,state:clone(args.p_state)};return {data:cloud.revision,error:null};},
  auth:{onAuthStateChange:()=>{},getSession:async()=>({data:{session:{user:{id:'user-a',email:'test@example.com'}}}}),signOut:async()=>{}}
 };
 try{
  const c=createCloudController({getState:()=>local,replaceState:s=>{local=s;},downloadBackup:()=>{},notify:()=>{},updateStatus:()=>{},clientOverride:client});
  await c.configure();
  assert.equal(c.ready,true);
  assert.equal(local.positions[0].exits.length,2);
  assert.equal(local.positions[0].journalEntries.length,2);
  assert.equal(writes,0);
  assert.equal(cloud.revision,14);
  // Mobile may append a note afterward; syncing it must not lose the sells.
  local.positions[0].journalEntries.push({id:'mobile',date:'2026-11-20',kind:'Process',body:'from mobile'});
  local.revision++;
  await c.syncNow();
  assert.equal(cloud.revision,15);
  assert.deepEqual(cloud.state.positions[0].exits.map(e=>e.id),['tp1','tp2']);
  assert.equal(cloud.state.positions[0].journalEntries.length,3);
 }finally{if(oldLocalStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldLocalStorage;}
});
