/* Optional private Supabase sync. The trading desk remains usable without cloud configuration. */
import {mergeFullBackup,backupSnapshot,normalizeLedger} from './ledger.mjs';

const MARKER='swing-risk-desk:cloud-marker:v1';
const AUTH_MODULE='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.10/+esm';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function createCloudController({getState,replaceState,saveMergedLocal,downloadBackup,notify,updateStatus}){
  let client=null,user=null,cloudRevision=0,localRevisionAtSync=0,task=null,queued=false,loading=false,ready=false,configured=false;
  const status=(message,tone='neutral')=>updateStatus({message,tone,user:user?.email||'',configured,ready});
  const marker=()=>{try{return JSON.parse(localStorage.getItem(MARKER)||'null');}catch{return null;}};
  function mark(value){try{localStorage.setItem(MARKER,JSON.stringify({...value,updatedAt:new Date().toISOString()}));}catch{}}
  async function remote(){const {data,error}=await client.from('desk_snapshots').select('revision,state,updated_at').eq('user_id',user.id).maybeSingle();if(error)throw error;return data;}
  async function cas(payload,expected){const {data,error}=await client.rpc('save_desk_snapshot',{p_expected_revision:expected,p_state:backupSnapshot(payload)});if(error)throw error;return Number(data);}
  function synced(revision){cloudRevision=revision;localRevisionAtSync=Number(getState().revision)||0;mark({userId:user.id,cloudRevision:revision,localRevision:localRevisionAtSync});status(`Cloud saved · revision ${revision}`,'good');}
  function safeExport(message){downloadBackup(`swing-risk-desk-SAFETY-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(backupSnapshot(getState()),null,2));notify(message);}
  async function initialize(){
    if(!user||loading)return;
    loading=true;ready=false;status('Checking private cloud history…');
    try{
      const entry=await remote(),local=getState(),existing=marker(),hasLocal=(local.positions?.length||0)>0||(local.adjustments?.length||0)>0||(local.brokerInbox?.length||0)>0;
      if(!entry){
        if(hasLocal&&!confirm('This cloud account has no saved ledger yet. Upload all local accounts, positions and journal history to your private cloud? This creates your initial cloud record.')){status('Cloud sign-in ready; initial upload was declined','warning');return;}
        const next=await cas(local,0);ready=true;synced(next);return;
      }
      cloudRevision=Number(entry.revision);
      const cloud=normalizeLedger(entry.state);
      if(!existing||existing.userId!==user.id){
        if(hasLocal){
          if(!confirm('Private cloud data already exists, and this browser has separate local records. Merge both histories using transaction IDs and note deduplication? A safety backup of this browser will download first. Cancel keeps local data untouched.')){status('Cloud sign-in ready; merging declined','warning');return;}
          safeExport('A safety backup was downloaded before the first cloud merge.');
          const result=mergeFullBackup(cloud,local);
          replaceState(result.next);
          ready=true;
          status('Merging historical records into cloud…');
          await push();
          notify(`Cloud connected: ${result.report.newTransactions} new fills, ${result.report.newNotes} new notes, ${result.report.conflicts} conflicts retained for review.`);
          return;
        }
        replaceState(cloud);ready=true;synced(cloudRevision);return;
      }
      const divergedLocal=Number(local.revision)!==Number(existing.localRevision);
      const remoteChanged=Number(entry.revision)!==Number(existing.cloudRevision);
      if(divergedLocal&&remoteChanged){
        safeExport('Both devices changed since the last sync; local copy backed up before merging.');
        const result=mergeFullBackup(cloud,local);
        replaceState(result.next);ready=true;await push();
        notify(`Merged concurrent work. ${result.report.conflicts} conflicts preserved for review.`);
      }else if(divergedLocal){ready=true;await push();}
      else{replaceState(cloud);ready=true;synced(cloudRevision);}
    }catch(error){console.error('Cloud initialization',error);status('Cloud unavailable — local data kept; export a backup','bad');notify(`Cloud sync error: ${error.message}`);}
    finally{loading=false;}
  }
  async function push(){
    if(!user||!ready)return;
    if(task){queued=true;return task;}
    task=(async()=>{
      for(let tries=0;tries<3;tries++){
        const local=getState();
        try{
          status('Saving to private cloud…');
          const revision=await cas(local,cloudRevision);
          synced(revision);
          if(Number(getState().revision)!==localRevisionAtSync)queued=true;
          return;
        }catch(error){
          if(error.code!=='40001'&&error.code!=='P0001'){status('Cloud save failed — local copy retained','bad');notify(`Cloud save error: ${error.message}`);return;}
          // Server-side compare-and-swap prevented a competing device's version being overwritten.
          try{
            const entry=await remote();
            safeExport('Concurrent cloud change detected. Local safety copy downloaded before merge.');
            const result=mergeFullBackup(normalizeLedger(entry.state),getState());
            replaceState(result.next);cloudRevision=Number(entry.revision);
            notify(`${result.report.conflicts} conflicting records kept for review; retrying safe merge.`);
          }catch(mergeError){status('Conflict unresolved; local copy safe','bad');notify(mergeError.message);return;}
        }
      }
      status('Could not resolve repeated cloud conflicts; export backup','bad');
    })();
    try{await task;}finally{task=null;if(queued){queued=false;void push();}}
  }
  let timer=null;
  function changed(){if(!ready||!user)return;status('Unsynced changes on this device','warning');clearTimeout(timer);timer=setTimeout(()=>void push(),1100);}
  async function configure(){
    try{
      const response=await fetch('/api/cloud-config',{cache:'no-store'});
      if(!response.ok){status('Cloud not configured on Vercel','warning');return;}
      const config=await response.json();
      if(!config.url||!config.anonKey)throw new Error('Cloud configuration is incomplete');
      const {createClient}=await import(AUTH_MODULE);
      client=createClient(config.url,config.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
      configured=true;status('Cloud available — sign in to enable sync');
      client.auth.onAuthStateChange((_event,session)=>{
        const current=session?.user;
        if(!current){user=null;ready=false;status('Cloud available — signed out');return;}
        if(user?.id===current.id)return;
        user=current;
        setTimeout(()=>void initialize(),0);
      });
      const {data}=await client.auth.getSession();if(data?.session?.user){user=data.session.user;await initialize();}
    }catch(error){console.warn('Cloud not active',error);status('Cloud not configured — local backups still work','warning');}
  }
  async function signIn(email){if(!client)throw new Error('Cloud not configured. Connect a Supabase project in Vercel first.');
    if(!/^\S+@\S+\.\S+$/.test(email))throw new Error('Enter a valid email address.');
    const {error}=await client.auth.signInWithOtp({email,emailRedirectTo:location.origin+location.pathname});if(error)throw error;
    status('Sign-in link sent. Open email to authorize cloud sync.');
  }
  async function signOut(){if(!client)return;clearTimeout(timer);if(ready&&Number(getState().revision)!==localRevisionAtSync)await push();await client.auth.signOut();user=null;ready=false;status('Signed out; private cloud is disconnected. Browser data remains on this device.');}
  async function syncNow(){if(!user)throw new Error('Sign in first');if(!ready){await initialize();return;}const data=await remote();if(data&&Number(data.revision)!==cloudRevision){
    safeExport('A newer cloud revision exists. Exported local data before merge.');
    const result=mergeFullBackup(normalizeLedger(data.state),getState());replaceState(result.next);cloudRevision=Number(data.revision);notify(`${result.report.conflicts} merge conflicts kept for review.`);
  }
    if(Number(getState().revision)!==localRevisionAtSync)await push();else synced(cloudRevision);
  }
  return {configure,signIn,signOut,changed,syncNow,get ready(){return ready;},get configured(){return configured;}};
}