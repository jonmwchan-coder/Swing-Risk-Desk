/* Private, additive-first Supabase sync. A stale browser must not remove an executed sale. */
import {mergeFullBackup,backupSnapshot,normalizeLedger} from './ledger.mjs';

const MARKER='swing-risk-desk:cloud-marker:v1';
const AUTH_MODULE='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.10/+esm';
const ACCOUNT_FIELDS=['name','brokerAccountId','equityCad','equityCheckpoints','equityPnlAtCheckpointCad','riskPct','window','stressPct','roundStep','mode','fx','fxSource','fxDate','ideaCapCad','ideaCapMode','buyFeePerContractUsd','sellFeePerContractUsd'];
const copy=x=>structuredClone(x);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const accountSettings=s=>Object.fromEntries((s.accounts||[]).map(a=>[a.id,Object.fromEntries(ACCOUNT_FIELDS.map(k=>[k,copy(a[k]??null)]))]));
// Exclude device-only version/backup metadata when asking whether a cloud write is necessary.
const ledgerCore=s=>Object.fromEntries(['accounts','positions','adjustments','customClosed','brokerInbox','importLog','conflicts','archive'].map(k=>[k,s[k]||[]]));
const sameLedger=(a,b)=>equal(ledgerCore(a),ledgerCore(b));

/**
 * Cloud is the base. Merge locally added executions/notes by stable IDs
 * regardless of the browser's stale local revision or cloud marker.
 * Omitted transactions are NOT evidence of an intentional deletion; only
 * explicit archived corrections may remove them.
 */
export function reconcileForCloud(remoteState,localState,baseAccountSettings=null){
 const cloud=normalizeLedger(remoteState),local=normalizeLedger(localState);
 const incoming=copy(local),settingsConflicts=[];
 // Existing cloud account settings are protected from stale browser snapshots.
 // Legitimate local edits are reapplied below only if that field's cloud value
 // has not changed since the browser's last confirmed sync.
 for(const item of incoming.accounts){
  const current=cloud.accounts.find(a=>a.id===item.id||(item.brokerAccountId&&item.brokerAccountId===a.brokerAccountId));
  if(current)Object.assign(item,copy(current));
 }
 const merged=mergeFullBackup(cloud,incoming);
 const next=merged.next;
 if(baseAccountSettings){
  for(const localAccount of local.accounts){
   const base=baseAccountSettings[localAccount.id];
   const remoteAccount=cloud.accounts.find(a=>a.id===localAccount.id);
   const target=next.accounts.find(a=>a.id===localAccount.id);
   if(!base||!remoteAccount||!target)continue;
   for(const key of ACCOUNT_FIELDS){
    const before=base[key]??null,localValue=localAccount[key]??null,remoteValue=remoteAccount[key]??null;
    if(equal(before,localValue)||equal(localValue,remoteValue))continue;
    if(equal(before,remoteValue))target[key]=copy(localValue);
    else settingsConflicts.push(localAccount.id+'.'+key);
   }
  }
 }
 // Keep each browser's technical revision monotonic, never use it as cloud recency.
 next.revision=Math.max(Number(cloud.revision)||0,Number(local.revision)||0);
 return {...merged,next,changed:!sameLedger(next,cloud),settingsConflicts};
}

export function createCloudController({getState,replaceState,saveMergedLocal,downloadBackup,notify,updateStatus,clientOverride=null,refreshMs=45000}){
 let client=null,user=null,cloudRevision=0,localRevisionAtSync=0,task=null,queued=false,loading=false,ready=false,configured=false,checking=false;
 let pollTimer=null,baseAccountSettings=null;
 const status=(message,tone='neutral')=>updateStatus({message,tone,user:user?.email||'',configured,ready});
 const marker=()=>{try{return JSON.parse(globalThis.localStorage?.getItem(MARKER)||'null');}catch{return null;}};
 function mark(value){try{globalThis.localStorage?.setItem(MARKER,JSON.stringify({...value,updatedAt:new Date().toISOString()}));}catch{}}
 async function remote(){const {data,error}=await client.from('desk_snapshots').select('revision,state,updated_at').eq('user_id',user.id).maybeSingle();if(error)throw error;return data;}
 async function cas(payload,expected){const {data,error}=await client.rpc('save_desk_snapshot',{p_expected_revision:expected,p_state:{...backupSnapshot(payload),syncProtocolVersion:2}});if(error)throw error;return Number(data);}
 function synced(revision){
  cloudRevision=revision;
  localRevisionAtSync=Number(getState().revision)||0;
  baseAccountSettings=accountSettings(getState());
  mark({userId:user.id,cloudRevision:revision,localRevision:localRevisionAtSync,accountSettings:baseAccountSettings});
  status('Cloud up to date · revision '+revision,'good');
 }
 function safeExport(message){
  downloadBackup('swing-risk-desk-SAFETY-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(backupSnapshot(getState()),null,2));
  notify(message);
 }
 const dirty=()=>Number(getState().revision)!==localRevisionAtSync;
 function cleanupPolling(){
  if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
 }
 function startPolling(){
  cleanupPolling();
  // Only check while the app is actually in use. Offline copies remain local.
  if(typeof window==='undefined')return;
  pollTimer=setInterval(()=>{
   if(!ready||!user||loading||task||checking||globalThis.document?.hidden||globalThis.navigator?.onLine===false)return;
   void syncNow(true).catch(err=>{console.warn('Cloud background refresh',err);status('Cloud refresh unavailable; local records kept','warning');});
  },refreshMs);
 }
 async function initialize(){
  if(!user||loading)return;
  loading=true;ready=false;status('Checking private cloud history…');
  try{
   const entry=await remote(),local=getState(),old=marker();
   const hasLocal=(local.positions?.length||0)>0||(local.adjustments?.length||0)>0||(local.brokerInbox?.length||0)>0;
   if(!entry){
    if(hasLocal&&!confirm('This cloud account has no saved ledger yet. Upload this browser\'s accounts and trades to create the initial private cloud record?')){status('Cloud sign-in ready; initial upload declined','warning');return;}
    const revision=await cas(local,0);ready=true;synced(revision);startPolling();return;
   }
   cloudRevision=Number(entry.revision);
   // Marker from this login tells us which settings the user actually edited.
   baseAccountSettings=old?.userId===user.id?(old.accountSettings||null):null;
   localRevisionAtSync=old?.userId===user.id?Number(old.localRevision)||0:0;
   if((!old||old.userId!==user.id)&&hasLocal){
    if(!confirm('This browser has separate local trades. Safely MERGE them with the existing private cloud history? A complete local safety file will download first; no executed sales will be removed.')){status('Cloud sign-in ready; local merge declined','warning');return;}
    safeExport('Local backup saved before combining browser and cloud records.');
   }
   ready=true;
   // Always reconcile actual events, even if the stale browser marker claims
   // the cloud has not changed. The old code silently overwrote November exits.
   const safe=await push(entry);
   if(safe)startPolling();else ready=false;
  }catch(error){
   console.error('Cloud initialization',error);
   ready=false;status('Cloud unavailable — local data retained; export backup','bad');
   notify('Cloud sync error: '+error.message);
  }finally{loading=false;}
 }
 async function push(initialEntry=null){
  if(!user||!ready)return false;
  if(task){queued=true;return task;}
  task=(async()=>{
   for(let tries=0;tries<3;tries++){
    let entry;
    try{
     entry=initialEntry||await remote();
     initialEntry=null;
     if(!entry)throw new Error('Private cloud record disappeared; refusing to overwrite.');
     const localAtStart=getState();
     const startRevision=Number(localAtStart.revision)||0;
     const merge=reconcileForCloud(entry.state,localAtStart,baseAccountSettings);
     if(!merge.changed){
      // No unique local events to upload. Adopt current cloud version, not a
      // saved browser snapshot whose revision happens to look newer.
      if(!sameLedger(localAtStart,entry.state))replaceState(merge.next);
      synced(Number(entry.revision));
      if(merge.settingsConflicts.length)notify('Concurrent portfolio setting edits need review: '+merge.settingsConflicts.join(', '));
      return true;
     }
     const merged=merge.next;
     merged.revision=Math.max(startRevision,Number(entry.state?.revision)||0)+1;
     merged.lastSavedAt=new Date().toISOString();
     status('Safely merging and saving private cloud history…');
     const revision=await cas(merged,Number(entry.revision));
     // Never discard local edits that landed while the upload was in flight.
     if(Number(getState().revision)!==startRevision){
      const late=reconcileForCloud(merged,getState(),baseAccountSettings);
      replaceState(late.next);
      queued=true;
     }else replaceState(merged);
     synced(revision);
     if(merge.report.newTransactions||merge.report.newNotes)notify('Cloud history reconciled: '+merge.report.newTransactions+' executions and '+merge.report.newNotes+' notes preserved.');
     if(merge.settingsConflicts.length)notify('Concurrent portfolio settings kept at cloud version: '+merge.settingsConflicts.join(', '));
     return true;
    }catch(error){
     if(error.code==='40001'||error.code==='P0001'){
      // Cloud was changed by another device between read and CAS; retry with
      // its newly fetched history rather than ever retrying stale JSON.
      if(tries===0)safeExport('Other device changed cloud history; local safety file exported before reconciliation.');
      continue;
     }
     status('Cloud save blocked; local records and backups retained','bad');
     notify('Cloud sync blocked: '+error.message);
     return false;
    }
   }
   status('Repeated cloud conflicts; export backup before retrying','bad');
   return false;
  })();
  try{return await task;}finally{task=null;if(queued){queued=false;void push();}}
 }
 let timer=null;
 function changed(){
  if(!ready||!user)return;
  status('Unsynced changes on this device','warning');
  clearTimeout(timer);timer=setTimeout(()=>void push(),1100);
 }
 async function configure(){
  try{
   if(clientOverride)client=clientOverride;
   else{
    const response=await fetch('/api/cloud-config',{cache:'no-store'});
    if(!response.ok){status('Cloud not configured on Vercel','warning');return;}
    const config=await response.json();
    if(!config.url||!config.anonKey)throw new Error('Cloud configuration is incomplete');
    const {createClient}=await import(AUTH_MODULE);
    client=createClient(config.url,config.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
   }
   configured=true;status('Cloud available — sign in to enable sync');
   client.auth.onAuthStateChange((_event,session)=>{
    const current=session?.user;
    if(!current){user=null;ready=false;cleanupPolling();status('Cloud available — signed out');return;}
    if(user?.id===current.id)return;
    user=current;setTimeout(()=>void initialize(),0);
   });
   const {data}=await client.auth.getSession();
   if(data?.session?.user){user=data.session.user;await initialize();}
   if(typeof window!=='undefined'){
    window.addEventListener('focus',()=>{if(ready&&user)void syncNow(true);});
    window.addEventListener('online',()=>{if(ready&&user)void syncNow(true);});
    globalThis.document?.addEventListener?.('visibilitychange',()=>{if(ready&&user&&!document.hidden)void syncNow(true);});
   }
  }catch(error){console.warn('Cloud not active',error);status('Cloud not configured — local backups still work','warning');}
 }
 async function signIn(email){
  if(!client)throw new Error('Cloud not configured. Connect Supabase in Vercel first.');
  if(!/^\S+@\S+\.\S+$/.test(email))throw new Error('Enter a valid email address.');
  const {error}=await client.auth.signInWithOtp({email,emailRedirectTo:location.origin+location.pathname});
  if(error)throw error;
  status('Sign-in link sent. Open email to authorize cloud sync.');
 }
 async function signOut(){
  clearTimeout(timer);cleanupPolling();
  if(ready&&dirty()){
   const okay=await push();
   if(!okay)throw new Error('Local cloud changes are not saved. Export a complete backup before signing out.');
  }
  await client.auth.signOut();user=null;ready=false;
  status('Signed out. Browser data remains local.','neutral');
 }
 async function syncNow(background=false){
  if(!user){if(!background)throw new Error('Sign in first');return false;}
  if(!ready){if(!background)await initialize();return ready;}
  if(task)return task;
  if(checking)return true;
  checking=true;
  try{
   const entry=await remote();
   if(!entry)throw new Error('Cloud record missing; refusing to overwrite.');
   if(background&&Number(entry.revision)===cloudRevision&&!dirty())return true;
   return await push(entry);
  }finally{checking=false;}
 }
 return {configure,signIn,signOut,changed,syncNow,get ready(){return ready;},get configured(){return configured;}};
}
