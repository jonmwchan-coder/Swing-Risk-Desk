import {calculateAccount,calculatePosition,simulateExit,budgetRunway,lossReleases,round2,roundUp} from './lib/risk.mjs';
import {isSession,torontoToday,onOrBeforeSession,parseDay,dayOffset} from './lib/calendar.mjs';
import {SCHEMA,normalizeLedger,importIbkrTrades,mergeFullBackup,makeJournalEntry,recordPlanEdit,backupSnapshot,planOpenPositionMerge} from './lib/ledger.mjs';
import {isIbkrCsv,parseIbkrTrades} from './lib/ibkr.mjs';
import {createCloudController} from './lib/cloud.mjs';
import {calculatePlanBasket,defaultPlanIdea,parsePlannedContract,MAX_PLAN_IDEAS,activeIdeaCapCad,openContractMatches,remainingDraftQuantity} from './lib/planner.mjs';
import {PLANNER_LOCAL_KEY,loadPlannerDrafts,savePlannerDrafts,clearPlannerDraftStorage} from './lib/planner-storage.mjs';
import {DEFAULT_BUY_FEE_USD,DEFAULT_SELL_FEE_USD,estimateOrderFee,ratePerContract} from './lib/fees.mjs';
import {buildSingleTradeHandoff,singleTradeExportFilename,TRADE_HANDOFF_SCHEMA} from './lib/trade-export.mjs';
import {emptyPreview,normalizePreview,projectOptionReturns,buildOCCSymbol,MAX_PREVIEW_DATES,MAX_PREVIEW_TARGETS,easternCloseMs} from './lib/option-preview.mjs';
import {nextSession} from './lib/calendar.mjs';
import {captureDraftAnalysis,positionAnalysisEvents,currentAnalysisBasis,workingAnalysisPreview,appendAnalysisRevision,modelPositionAnalysis} from './lib/position-analysis.mjs';
import {draftContract,draftContractKey,normalizeTicker,sortPlanIdeas,PLAN_SORT_MODES} from './lib/planner-contract.mjs';
import {expirationLookupKey,normalizeListedDates,expirationListingStatus,nearestListedExpirations,regularExpirationKind} from './lib/expiry-listings.mjs';
import {renderChainPanel} from './lib/chain-view.mjs';
import {copyPlannerIdea,isEmptyPlannerPlaceholder,isUneditedTickerScenario,tickerScenarioKey,hydrateTickerScenario,broadcastTickerScenario,visibleTickerDates} from './lib/planner-workflows.mjs';

const STORAGE_KEY='swing-risk-desk:data:v1';
const $=id=>document.getElementById(id);
const money=(v,digits=2)=>`${Number(v)<0?'-':''}$${Math.abs(Number(v)||0).toLocaleString('en-CA',{minimumFractionDigits:digits,maximumFractionDigits:digits})}`;
const cad=(v,digits=2)=>`CAD ${money(v,digits)}`;
const usd=(v,digits=2)=>`USD ${money(v,digits)}`;
// Position cards use USD first; CAD accounting stays authoritative.
const dualPositionMoney=(u,c,digits=2)=>`<span class="pos-usd">${usd(u,digits)}</span> <span class="pos-cad">(${cad(c,digits)})</span>`;
const usdWithCad=(value,fx,digits=2)=>dualPositionMoney(value,value*fx,digits);
const cadWithUsd=(value,fx,digits=2)=>dualPositionMoney(value/fx,value,digits);
const formattedReturn=(value)=>{
 if(value===null||value===undefined||!Number.isFinite(Number(value)))return '----';
 const rounded=Math.round(Number(value)*10)/10;
 const clean=Math.abs(rounded)<.05?0:rounded;
 return `${clean>0?'+':''}${clean.toFixed(1)}%`;
};
const fmtDate=(iso,detail=false)=>parseDay(iso)?new Intl.DateTimeFormat('en-CA',{month:'short',day:'numeric',year:detail?'numeric':undefined,timeZone:'UTC'}).format(new Date(`${iso}T12:00:00Z`)):(iso||'--');
const historyDate=iso=>parseDay(iso)?`${iso.slice(5,7)}/${iso.slice(8,10)}/${iso.slice(2,4)}`:fmtDate(iso,true);
const dow=iso=>new Intl.DateTimeFormat('en-US',{weekday:'short',timeZone:'UTC'}).format(new Date(`${iso}T12:00:00Z`));
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>globalThis.crypto?.randomUUID?.()||`id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const num=(v,fallback=0)=>v===''||v===null||v===undefined?fallback:Number(v);
const optional=(v)=>v===''||v===null||v===undefined?null:Number(v);
const today=()=>torontoToday();
function seed(){return {
  schema:SCHEMA,
  accounts:[{id:'bdi',name:'Sample Swing Account',equityCad:20000,equityCheckpoints:[{id:'equity-initial-bdi',date:onOrBeforeSession(today()),createdAt:new Date().toISOString(),equityCad:20000,realizedPnlCad:0,source:'Initial account equity'}],riskPct:3,window:5,stressPct:70,roundStep:25,mode:'stress',fx:1.4,fxSource:'Illustrative assumption, not a live quote',fxDate:'',ideaCapCad:200,ideaCapMode:'fixed',brokerAccountId:'',buyFeePerContractUsd:DEFAULT_BUY_FEE_USD,sellFeePerContractUsd:DEFAULT_SELL_FEE_USD}],
  positions:[],adjustments:[],customClosed:[],brokerInbox:[],importLog:[],conflicts:[],archive:[],revision:0,lastBackupRevision:0,lastBackupAt:''
};}

function normalize(incoming){return normalizeLedger(incoming);}
function load(){try{const saved=localStorage.getItem(STORAGE_KEY);return saved?normalize(JSON.parse(saved)):seed();}catch(err){console.warn('Could not read locally stored risk data',err);return seed();}}
let state=load();
let maxRevisionObserved=state.revision||0;
const initiallyHadLocalRecord=Boolean(localStorage.getItem(STORAGE_KEY));
const LAST_ACCOUNT_KEY='swing-risk-desk:last-portfolio:v1';
function preferredAccountId(){
 try{const prior=globalThis.localStorage.getItem(LAST_ACCOUNT_KEY);if(state.accounts.some(a=>a.id===prior))return prior;}catch{}
 return state.accounts[0]?.id||'bdi';
}
let activeAccountId=preferredAccountId();
function rememberAccount(){try{globalThis.localStorage.setItem(LAST_ACCOUNT_KEY,activeAccountId);}catch{}}

let activeTab='dashboard';
let positionFilter='open';
let asOfOverride=null;
let toastTimer=null;
let plannerPrefill=null;
const positionQuotes=new Map();
const positionQuoteQueue=[];
let positionQuoteActive=0;
let selectedPreviewId=null;
let optionPanelMode='analyze';
let chainSide='Put';
let optionChainRange='nearby';
let chainFetchToken=0;
const chainCache=new Map();
let expandedPlanId=null;
const tickerInputOrigins=new Map(); // Only reset underlying levels after a ticker/type change is finalized.
let quoteRefreshBusy=false;
let quoteRefreshMessage='';
let quoteConnectionState='unknown'; // Never imply unconfigured or failed data are live quotes.
let quoteRefreshToken=0;
const PLAN_SORT_KEY='swing-risk-desk:idea-sort:v1';
let planSortMode=(()=>{try{const v=localStorage.getItem(PLAN_SORT_KEY);return PLAN_SORT_MODES.includes(v)?v:'created';}catch{return 'created';}})();
const restoredPlanner=loadPlannerDrafts(globalThis.localStorage,globalThis.sessionStorage);
let plannerDrafts=restoredPlanner.drafts;
let plannerDraftSavedAt=restoredPlanner.savedAt;
let plannerStorageHealthy=restoredPlanner.persisted;
function plannerSavedStatus(){
 const el=$('plannerSavedStatus');if(!el)return;
 if(!plannerStorageHealthy){el.textContent='Could not save drafts in this browser';el.dataset.tone='warning';return;}
 const time=plannerDraftSavedAt?new Date(plannerDraftSavedAt):null;
 const stamp=time&&Number.isFinite(time.valueOf())?new Intl.DateTimeFormat('en-CA',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(time):'';
 el.textContent=stamp?`Saved on this device · ${stamp}`:'Auto-saved on this device';el.dataset.tone='good';
}
function persistPlannerDrafts(){
 const at=new Date().toISOString();
 plannerStorageHealthy=savePlannerDrafts(globalThis.localStorage,plannerDrafts,at);
 if(plannerStorageHealthy)plannerDraftSavedAt=at;
 plannerSavedStatus();
}
function plannerIdeas(accountId=account().id){
 let ideas=plannerDrafts[accountId];
 if(!Array.isArray(ideas)||!ideas.length){ideas=[defaultPlanIdea(uid(),account().stressPct,true)];plannerDrafts[accountId]=ideas;persistPlannerDrafts();}
 const normalized=ideas.filter(x=>x&&typeof x==='object'&&typeof x.id==='string').slice(0,MAX_PLAN_IDEAS);
 for(const idea of normalized)if(idea.feeManual===undefined)idea.feeManual=false;
 if(!normalized.length){normalized.push(defaultPlanIdea(uid(),account().stressPct,true));}
 if(normalized.length!==ideas.length){plannerDrafts[accountId]=normalized;persistPlannerDrafts();}
 return plannerDrafts[accountId];
}
function dropPlannerIdea(draftId,renderAfter=true){
 const ideas=plannerIdeas();const index=ideas.findIndex(x=>x.id===draftId);
 if(index<0)return;
 ideas.splice(index,1);
 tickerInputOrigins.delete(draftId);
 if(selectedPreviewId===draftId)selectedPreviewId=null;
  if(expandedPlanId===draftId)expandedPlanId=null;
 if(!ideas.length)ideas.push(defaultPlanIdea(uid(),account().stressPct,false));
 persistPlannerDrafts();if(renderAfter)renderPlanner(analytics());
}
function beginPlannedPosition(draftId){
 const draft=plannerIdeas().find(x=>x.id===draftId);
 if(!draft)return showToast('That draft is no longer present.');
 if(!draftContract(draft))return showToast('Enter a valid ticker, expiry, strike and call/put before recording.');
 const m=analytics(),candidate=calculatePlanBasket([draft],m.account,m.availableCad,m.positions).rows[0];
 if(!candidate?.valid||!candidate.qty)return showToast(candidate?.reason||'Set the number of additional contracts before recording.');
 const pref=structuredClone({...draft,draftId,...draftContract(draft),plannedLossPct:candidate.plannedLossPct??'',analysisCapturedAt:new Date().toISOString()});
 if(candidate.positionId)return addFill(candidate.positionId,pref);
 plannerPrefill=pref;
 addPosition();
}
// Called only after the ledger is successfully saved; keeping the idea is the safe default.
function finishDraftRecord(pref,qty){
 if(!pref?.draftId)return;
 const draft=plannerIdeas().find(x=>x.id===pref.draftId);
 if(!draft||draftContractKey(draft)!==draftContractKey(pref))return;
 const m=analytics(),matches=openContractMatches(pref,m.positions,m.account.id);
 if(matches.length===1)draft.plannedLossPct=String(matches[0].position.plannedLossPct??'');
 draft.qty=String(remainingDraftQuantity(draft.qty,qty));
 draft.feeManual=false;draft.fee=estimateOrderFee(account(),'BUY',draft.qty).toFixed(2);
 persistPlannerDrafts();renderPlanner(analytics());
 dialog('Entry recorded','TRADE IDEA',`<p class="modal-intro"><strong>${qty} contract${qty===1?'':'s'} recorded.</strong> ${draft.qty} planned additional contracts remain. Keep this idea for later entries or close just the idea (your position stays open).</p><div class="modal-actions"><button type="button" class="btn btn-outline" data-action="close-recorded-idea" data-plan-id="${esc(draft.id)}">Close idea</button><button type="button" class="btn btn-primary" data-action="close-dialog" autofocus>Keep idea open</button></div>`);
}
// Synchronize the user-confirmed estimate back to matching local drafts only.
function syncPositionLossToDrafts(id){
 const m=analytics(),x=m.positions.find(x=>x.position.id===id);
 if(!x||!x.metrics.qty||openContractMatches(x.position,m.positions,m.account.id).length!==1)return;
 const value=String(x.position.plannedLossPct??'');let changed=false;
 for(const idea of plannerIdeas(m.account.id))if(draftContractKey(idea)===draftContractKey(x.position)&&String(idea.plannedLossPct??'')!==value){idea.plannedLossPct=value;changed=true;}
 if(changed){persistPlannerDrafts();renderPlanner(m);}
}
function applyPlannedLoss(p,pct,source){
 const n=recordPlanEdit(p,{plannedLossPct:pct},{date:today(),source});
 if(n.includes('plannedLossPct'))p.plannedLossEditedAt=new Date().toISOString();
 return n.length>0;
}
function account(){return state.accounts.find(a=>a.id===activeAccountId)||state.accounts[0];}
function asOf(){return asOfOverride||today();}
function analytics(){return calculateAccount(state,account().id,asOf());}
const IDB_NAME='swing-risk-desk-recovery-v1';
function openRecovery(){return new Promise((resolve,reject)=>{if(!('indexedDB' in globalThis)){reject(new Error('IndexedDB unavailable'));return;}
 const req=indexedDB.open(IDB_NAME,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('snapshots'))req.result.createObjectStore('snapshots');};
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
let recoveryWriteQueue=Promise.resolve();
async function writeRecovery(snapshot){try{const db=await openRecovery();await new Promise((resolve,reject)=>{const t=db.transaction('snapshots','readwrite');t.objectStore('snapshots').put(snapshot,'latest');t.oncomplete=resolve;t.onerror=()=>reject(t.error);});db.close();}catch(err){console.warn('Secondary local recovery unavailable',err);}}
async function recoverFromIndexedDb(){try{const db=await openRecovery();const backup=await new Promise((resolve,reject)=>{const r=db.transaction('snapshots','readonly').objectStore('snapshots').get('latest');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();
  if(backup&&(!initiallyHadLocalRecord||Number(backup.revision)>maxRevisionObserved)&&!userEditedSinceStartup){
    if(!initiallyHadLocalRecord||confirm('A newer recovery copy was found on this device. Restore it instead of the older browser copy?')){
      state=normalize(backup);activeAccountId=preferredAccountId();rememberAccount();maxRevisionObserved=Math.max(maxRevisionObserved,state.revision||0);
      localStorage.setItem(STORAGE_KEY,JSON.stringify(state));render();showToast('Recovered your latest local data copy. Download an external backup.');
    }
  }
 }catch(err){console.warn('Recovery check unavailable',err);}}
let userEditedSinceStartup=false;
let cloudController=null;
function replaceFromCloud(snapshot){
 state=normalize(snapshot);maxRevisionObserved=Math.max(maxRevisionObserved,Number(state.revision)||0);
 activeAccountId=state.accounts.some(a=>a.id===activeAccountId)?activeAccountId:preferredAccountId();rememberAccount();
 writeLocalWithoutRevision();render();
}
function updateCloudStatus({message,tone,user,configured,ready}){
 const el=$('cloudStatus');if(!el)return;
 el.textContent=message;el.dataset.tone=tone;
 $('cloudAccount').textContent=user?`Signed in: ${user}`:(configured?'Not signed in':'Needs cloud setup');
 $('cloudSignInForm').hidden=Boolean(user);
 $('cloudSignOut').hidden=!user;
 $('cloudSyncNow').disabled=!user;
 $('cloudEmail').disabled=!configured;
 $('cloudSignIn').disabled=!configured;
 // The top bar is truthful: local saves are not necessarily saved to the cloud yet.
 if(ready&&tone==='good')$('saveStatus').innerHTML='<span class="saved-dot"></span>Cloud saved';
 else if(tone==='bad'||(ready&&tone==='warning'))$('saveStatus').innerHTML='<span class="saved-dot"></span>Cloud not synced';
}

function writeLocalWithoutRevision(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));const snapshot=structuredClone(state);recoveryWriteQueue=recoveryWriteQueue.catch(()=>{}).then(()=>writeRecovery(snapshot));updateBackupBadge();return true;}
 catch(err){$('saveStatus').textContent='Storage blocked: download backup';showToast('Browser storage failed. Download a JSON backup immediately.');return false;}}
function updateBackupBadge(){const badge=$('backupStatus');const dirty=(state.revision||0)>(state.lastBackupRevision||0);
 if(badge)badge.innerHTML=dirty?`<strong class="neg">Backup needed:</strong> ${Math.max(1,(state.revision||0)-(state.lastBackupRevision||0))} change(s) since your last download. Data is only on this device until you save the full JSON elsewhere.`:`<strong>Backup ${state.lastBackupAt?'exported':'not yet exported'}:</strong> ${state.lastBackupAt?esc(fmtDate(state.lastBackupAt.slice(0,10),true)):'Download a copy before relying on this ledger.'} — remember to store it in Google Drive.`;
 $('saveStatus').innerHTML=`<span class="saved-dot"></span>${dirty?'Backup needed':'Saved locally'}`;}
function save(){userEditedSinceStartup=true;state.revision=Math.max(Number(state.revision)||0,maxRevisionObserved)+1;maxRevisionObserved=state.revision;state.lastSavedAt=new Date().toISOString();const ok=writeLocalWithoutRevision();if(ok)cloudController?.changed();return ok;}
function showToast(message){const t=$('toast');t.textContent=message;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3200);}
function render(){const a=account();if(!a)return;
  $('accountSelect').innerHTML=state.accounts.map(x=>`<option value="${esc(x.id)}" ${x.id===a.id?'selected':''}>${esc(x.name)}</option>`).join('');
  $('asOfDate').value=asOf();
  const m=analytics();
  $('asOfCaption').textContent=`${m.asOf!==asOf()?`Showing last session ${fmtDate(m.asOf)} / `:''}NYSE equity-option sessions`;
  renderOverview(m);
  renderPositions(m);
  renderHistory(m);
  renderSettings(a);
  for(const t of document.querySelectorAll('.tab')){t.classList.toggle('active',t.dataset.tab===activeTab);t.setAttribute('aria-current',t.dataset.tab===activeTab?'page':'false');}
  for(const v of document.querySelectorAll('.view'))v.hidden=v.id!==`view-${activeTab}`;
  schedulePositionQuotes(m);
}
function renderOverview(m){
  const fx=m.account.fx;
  const isOver=m.availableCad<-.005;
  const p=Math.max(0,m.budgetCad)>0?(m.usedCad/m.budgetCad)*100:100;
  const used=Number.isFinite(p)?p:100;
  $('availableBig').innerHTML=cadWithUsd(m.availableCad,fx);
  $('availableBig').classList.toggle('negative',isOver);
  $('heroBadge').className=`pill ${isOver?'pill-alert':m.availableCad<25?'pill-warning':'pill-good'}`;
  $('heroBadge').textContent=isOver?'OVER BUDGET':m.availableCad<25?'CAPACITY FULL':'WITHIN PLAN';
  $('heroSubtitle').textContent=isOver?`${cad(-m.availableCad)} over the risk limit. No room to add.`:`After open stress reserves and net losing positions/attempts during the last ${m.account.window} sessions.`;
  const openPercent=m.budgetCad>0?Math.max(0,Math.min(100,100*m.reserveCad/m.budgetCad)):100;
  const lossPercent=m.budgetCad>0?Math.max(0,Math.min(100-openPercent,100*m.realizedLossCad/m.budgetCad)):0;
  $('trackOpen').style.width=`${openPercent}%`;
  $('trackLoss').style.width=`${lossPercent}%`;
  $('budgetTrack').setAttribute('aria-label',`${cad(m.reserveCad)} reserved, ${cad(m.realizedLossCad)} net losing attempts, ${cad(m.availableCad)} available`);
  $('usedPct').textContent=`${Math.round(used)}%`;
  $('riskRing').style.background=`conic-gradient(#75dec0 0 ${openPercent}%,#fd9b93 ${openPercent}% ${openPercent+lossPercent}%,#35515b ${openPercent+lossPercent}% 100%)`;
  $('windowLabel').textContent=`Rolling ${m.account.window}-session window`;
  $('rangeLabel').textContent=`${fmtDate(m.dates[0])} - ${fmtDate(m.asOf)}`;
  $('reservedMetric').innerHTML=cadWithUsd(m.reserveCad,fx);
  const oc=m.positions.filter(x=>x.metrics.qty>0).length;
  $('reservedHint').textContent=`${oc} open position${oc!==1?'s':''} across all ideas`;
  $('lossMetric').innerHTML=cadWithUsd(m.realizedLossCad,fx);
  $('lossHint').textContent=`Gross negative realized entries: ${usd(m.grossRealizedLossCad/fx)} (${cad(m.grossRealizedLossCad)}) (diagnostic). Net profitable attempts do not offset other trades.`;
  $('capMetric').innerHTML=cadWithUsd(m.budgetCad,fx);
  $('capHint').textContent=`${m.account.riskPct}% of ${cad(m.currentEquityCad)} tracked equity`;
  $('equityTracker').innerHTML=`<strong>TRACKED ACCOUNT EQUITY</strong> <span class="equity-tracker-value">${cadWithUsd(m.currentEquityCad,fx)}</span> <span class="equity-tracker-detail">${cadWithUsd(m.equityCheckpointCad,fx)} checkpoint · ${cadWithUsd(m.equityChangeCad,fx)} net realized since checkpoint · excludes unrealized P/L</span>`;
  $('costMetric').innerHTML=dualPositionMoney(m.positions.reduce((sum,x)=>sum+x.metrics.remainingCostUsd,0),m.fullPremiumCad);
  $('costHint').textContent='Total acquisition cost of contracts still held, including buy fees';
  updateBackupBadge();
  const alerts=[];
  if(isOver)alerts.push({kind:'danger',title:`Budget exceeded by ${money(-m.availableCad)}.`,desc:'Stop opening positions. Reduce existing exposure or wait for eligible realized losses to roll out.'});
  const missing=m.positions.filter(x=>x.metrics.qty>0&&!x.position.underlyingInvalidation?.trim());
  if(missing.length)alerts.push({kind:'warning',title:`${missing.length} open position${missing.length===1?' is':'s are'} missing an underlying invalidation.`,desc:`${missing.map(x=>x.position.ticker).join(', ')}: the stress reserve is a planning estimate, not a protective stop. Set the structure/time invalidation.`});
  const pastExp=m.positions.filter(x=>x.metrics.qty>0&&x.position.expiry&&x.position.expiry<m.asOf);
  if(pastExp.length)alerts.push({kind:'danger',title:`${pastExp.map(x=>x.position.ticker).join(', ')} shows an expired contract with no recorded close.`,desc:'Reconcile the broker fills. The app will not invent an expiry loss or quietly zero out your reserve.'});
  const ideaCap=activeIdeaCapCad(m.account);
  const openWithStop=m.positions.filter(x=>x.metrics.qty>0&&x.metrics.planLoss!==null&&ideaCap!==null&&x.metrics.planLoss>ideaCap+.01);
  if(openWithStop.length)alerts.push({kind:'warning',title:'Estimated stop loss exceeds your planned idea cap.',desc:`${openWithStop.map(x=>x.position.ticker).join(', ')}: review planned risk vs the ${cad(ideaCap)} optional per-idea guide.`});
  const themeGroups={};for(const item of m.positions.filter(x=>x.metrics.qty>0)){const theme=item.position.sector?.trim().toLowerCase();if(theme)(themeGroups[theme]??=[]).push(item);}
  for(const [theme,items] of Object.entries(themeGroups)){if(new Set(items.map(x=>x.position.ticker)).size>1){const total=items.reduce((sum,x)=>sum+x.metrics.reserveCad,0);alerts.push({kind:'warning',title:`Correlated exposure: ${items.map(x=>x.position.ticker).join(' + ')}.`,desc:`These share the ${theme} theme and together reserve ${cad(total)}. Different tickers do not make independent bets.`});}}
  const ideaGroups={};for(const item of m.positions.filter(x=>x.metrics.qty>0)){const idea=item.position.ideaId?.trim();if(idea)(ideaGroups[idea]??=[]).push(item);}
  for(const [idea,items] of Object.entries(ideaGroups)){if(items.length>1&&ideaCap!==null){const sum=items.reduce((n,x)=>n+(x.metrics.planLoss||0),0);if(sum>ideaCap){alerts.push({kind:'warning',title:`Combined idea stop exposure exceeds ${cad(ideaCap)}.`,desc:`${idea}: ${cad(sum)} across ${items.length} positions, before any exit slippage.`});}}}
  if(m.account.fxSource?.toLowerCase().includes('illustrative'))alerts.push({kind:'warning',title:`USD/CAD ${Number(m.account.fx).toFixed(4)} is an illustrative starting rate.`,desc:'Refresh from Bank of Canada or enter IBKR FX in Rules & data for more precise CAD figures.'});
  $('alerts').innerHTML=alerts.map(a=>`<div class="alert ${a.kind==='danger'?'danger':''}"><div class="alert-icon">${a.kind==='danger'?'!':'i'}</div><div><strong>${esc(a.title)}</strong><p>${esc(a.desc)}</p></div></div>`).join('');
  const open=m.positions.filter(x=>x.metrics.qty>0).sort((x,y)=>y.metrics.reserveCad-x.metrics.reserveCad);
  $('dashboardPositions').innerHTML=open.length?open.map(x=>positionCard(x,false)).join(''):'<div class="empty-state">No open positions yet. Import your private starter JSON in Rules & data, or add your first trade. A free budget is not a trade signal.</div>';
  $('rollingDaysLabel').textContent=`${m.account.window} sessions`;
  $('sessionStrip').style.gridTemplateColumns=m.dates.length>7?`repeat(${m.dates.length},minmax(56px,1fr))`:`repeat(${m.dates.length},minmax(0,1fr))`;
  $('sessionStrip').innerHTML=m.dates.map(d=>{const loss=m.lossesByDate[d]||0;return `<div class="session-day ${d===m.asOf?'today':''}"><span class="dow">${esc(dow(d))}</span><div class="daynum">${d.slice(8)}</div><div class="loss ${loss<.005?'zero':''}">${loss<.005?'No loss':cadWithUsd(loss,fx)}</div></div>`;}).join('');
  const release=lossReleases(state,m.account.id,asOf());
  $('releaseBox').innerHTML=release.length?(release[0].changeCad>0?
    `<b>Next rolling release:</b> ${fmtDate(release[0].releaseDate,true)} frees ${cadWithUsd(release[0].changeCad,fx)} in net-loss capacity, assuming no new trades.`:
    `<b>Rolling window warning:</b> ${fmtDate(release[0].releaseDate,true)} adds ${cadWithUsd(-release[0].changeCad,fx)} to the loss charge when an older winning partial expires before its losing runner. No new trade is required for this change.`):
    '<b>No scheduled change in rolling losses.</b> An open swing keeps reserving risk even if its entry is older than five sessions.';
  renderPlanner(m);
  const runway=budgetRunway(state,m.account.id,asOf(),10);
  $('runwayChart').innerHTML=runway.map((r,i)=>{const h=m.budgetCad>0?Math.max(4,Math.min(100,100*Math.max(0,r.available)/m.budgetCad)):4;return `<div class="runway-item"><div class="runway-number ${r.available<0?'neg':''}">${cadWithUsd(r.available,fx)}</div><div class="runway-bar-box"><div class="runway-bar ${r.available<0?'negative':''}" style="height:${h}%"></div></div><div class="runway-date">${i===0?'NOW':fmtDate(r.date)}</div></div>`;}).join('');
}
function currentPositionQuoteSymbol(p,z,m){
 if(!z.qty||m.asOf!==onOrBeforeSession(today(),state.customClosed||[])||Number(p.multiplier||100)!==100||p.expiry<today())return null;
 return buildOCCSymbol(draftContract(p));
}
function quoteForPosition(p,z,m){
 if(z.qty===0)return {value:0,detail:'No open contracts',refresh:false};
 if(m.asOf!==onOrBeforeSession(today(),state.customClosed||[]))return {value:null,detail:'Historical view · no quote',refresh:false};
 const symbol=currentPositionQuoteSymbol(p,z,m),q=positionQuotes.get(symbol);
 if(!symbol)return {value:null,detail:'Quote unavailable',refresh:false};
 return {value:q?.mid!=null?z.qty*Number(p.multiplier||100)*q.mid:null,detail:q?.loading?'Refreshing…':q?.error?'Quote unavailable · retry':q?.mid!=null?`Mid ${usd(q.mid)} (${cad(q.mid*m.account.fx)}) · ${q.at?new Date(q.at).toLocaleString('en-CA',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/Toronto'})+' ET':'time unknown'} · indicative`:'Loading indicative quote…',refresh:true,loading:!!q?.loading};
}
function positionMarketMarkup(p,z,m){
 const quote=quoteForPosition(p,z,m);
 return `<div class="pos-data-label">MARKET VALUE</div><strong>${quote.value===null?'—':dualPositionMoney(quote.value,quote.value*m.account.fx)}</strong><small>${esc(quote.detail)} ${quote.refresh?`<button class="fee-reset-mini" type="button" data-action="refresh-position-quote" data-id="${esc(p.id)}" title="Refresh indicative option midpoint" ${quote.loading?'disabled':''}>Refresh</button>`:''}</small>`;
}
// Update quote cells only, never re-render the planner or discard an in-progress edit.
function updatePositionQuoteCells(){
 const m=analytics(),byId=new Map(m.positions.map(x=>[x.position.id,x]));
 for(const card of document.querySelectorAll('.position-card[data-position]')){
  const x=byId.get(card.dataset.position),cell=card.querySelector('.pos-market-value');
  if(x&&cell)cell.innerHTML=positionMarketMarkup(x.position,x.metrics,m);
 }
}
function enqueuePositionQuote(symbol,manual=false){
 if(!symbol||positionQuotes.get(symbol)?.loading||(!manual&&positionQuotes.has(symbol)))return;
 positionQuotes.set(symbol,{loading:true});positionQuoteQueue.push({symbol,manual});
}
function schedulePositionQuotes(m){
 if(!['dashboard','positions'].includes(activeTab))return;
 for(const {position:p,metrics:z} of m.positions)enqueuePositionQuote(currentPositionQuoteSymbol(p,z,m));
 pumpPositionQuotes();
}
function pumpPositionQuotes(){
 // Bound concurrent requests and deduplicate by exact option symbol.
 while(positionQuoteActive<3&&positionQuoteQueue.length){
  const job=positionQuoteQueue.shift();positionQuoteActive++;
  void fetchPositionQuote(job).finally(()=>{positionQuoteActive--;pumpPositionQuotes();});
 }
}
async function fetchPositionQuote({symbol,manual}){
 updatePositionQuoteCells();
 try{
  const response=await fetch(`/api/option-quote?symbol=${encodeURIComponent(symbol)}`,{cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  const bid=Number(data.optionBidUsd),ask=Number(data.optionAskUsd);
  if(!response.ok||data.symbol!==symbol||data.optionBidUsd==null||data.optionAskUsd==null||!Number.isFinite(bid)||!Number.isFinite(ask)||bid<0||ask<=0||ask<bid)throw Error(data.error||'No valid indicative bid/ask');
  positionQuotes.set(symbol,{mid:(bid+ask)/2,at:data.quoteAt&&Number.isFinite(Date.parse(data.quoteAt))?data.quoteAt:null});
 }catch(err){positionQuotes.set(symbol,{error:true});if(manual)showToast(String(err.message||'Quote unavailable').slice(0,180));}
 finally{updatePositionQuoteCells();}
}
function refreshPositionQuote(id){
 const p=findPosition(id),m=analytics(),x=m.positions.find(x=>x.position.id===p.id);
 const symbol=x&&currentPositionQuoteSymbol(p,x.metrics,m);
 if(!symbol)return showToast('No current quote available for this position.');
 enqueuePositionQuote(symbol,true);updatePositionQuoteCells();pumpPositionQuotes();
}
function positionCard(x,full){const p=x.position,z=x.metrics;const isOpen=z.qty>0;const days=p.expiry?Math.round((new Date(`${p.expiry}T12:00:00Z`)-new Date(`${analytics().asOf}T12:00:00Z`))/86400000):null;
 const fmt=days===null?'No expiry':days<0?`Expired ${-days}d ago`:days===0?'Expires today':`${days} calendar days to expiry`;
 const label=p.optionType==='Put'?'P':'C';const flag=!p.underlyingInvalidation?.trim();const m=analytics(),fx=m.account.fx;const duplicates=isOpen&&m.asOf===onOrBeforeSession(today(),state.customClosed||[])?openContractMatches(p,m.positions,p.accountId).length:0;
 return `<article class="position-card" data-position="${esc(p.id)}">
  <div class="pos-top"><div><div class="pos-ticker">${esc(p.ticker)}</div><div class="pos-contract">${esc(p.expiry?fmtDate(p.expiry,true):'')} ${esc(p.strike||'?')}${label} <span style="color:#688e9a">/</span> ${esc(p.ideaId||'Single idea')}</div><div class="pos-meta">${esc(p.sector||'Sector not recorded')} &bull; ${esc(fmt)}</div></div><div class="pos-badge ${isOpen?'':'closed'}">${isOpen?`${z.qty} OPEN`:'CLOSED'}</div></div>
  ${full?`<div class="pos-data pos-performance"><div><div class="pos-data-label">TOTAL ENTRY COST</div><strong>${dualPositionMoney(z.totalEntryDebitUsd,z.totalEntryDebitUsd*fx)}</strong><small>Recorded entry cost · incl. buy fees</small></div><div class="pos-market-value">${positionMarketMarkup(p,z,m)}</div><div><div class="pos-data-label">REALIZED NET</div><strong class="${z.realizedTotal<0?'neg':'pos'}">${dualPositionMoney(z.realizedTotal/fx,z.realizedTotal)}</strong><small>USD equivalent at portfolio FX</small></div><div><div class="pos-data-label">REALIZED RETURN</div><strong class="${z.realizedReturnPct===null?'':z.realizedReturnPct<0?'neg':'pos'}">${formattedReturn(z.realizedReturnPct)}</strong><small>Closed contracts · net of fees</small></div></div>`:``}
  <div class="pos-data pos-risk-row"><div><div class="pos-data-label">OPEN COST BASIS</div><strong>${dualPositionMoney(z.remainingCostUsd,z.premiumCad)}</strong><small>Remaining contracts · incl. buy fees</small></div><div><div class="pos-data-label">AVG ENTRY PREMIUM</div><strong>${z.averageEntryUsd===null||!Number.isFinite(z.averageEntryUsd)?'—':usdWithCad(z.averageEntryUsd,fx)}</strong><small>${isOpen?'Weighted avg':'Last attempt avg'} · per share · excl. fees</small></div><div><div class="pos-data-label">STRESS RISK (${z.reservePct}%)</div><strong>${dualPositionMoney(z.reserveCad/fx,z.reserveCad)}</strong><small>${z.hasFixed?'Reserve floor applied':m.account.mode==='strict'?'Full open cost · rounded':'Open cost × stress · rounded'}</small></div><div><div class="pos-data-label">PLANNED LOSS</div><strong>${z.planLossUsd===null?'Not set':dualPositionMoney(z.planLossUsd,z.planLoss)}</strong><small>${z.plannedLossPct!==null?`${z.plannedLossPct}% of total entry cost`:z.planLossUsd===null?'Set loss % at invalidation':'Stop-price estimate'} ${full&&isOpen?`<button class="fee-reset-mini" type="button" data-action="edit-planned-loss" data-id="${esc(p.id)}">${z.plannedLossPct===null?'Set %':'Edit %'}</button>`:''}</small></div></div>
  <div class="pos-note"><span class="${flag?'warning':''}">${flag?'Needs an underlying invalidation / time stop':`Wrong if: ${esc(p.underlyingInvalidation).slice(0,125)}`}${p.targetLevels?`<br>Targets: ${esc(p.targetLevels).slice(0,200)}`:''}${p.thesis?`<br>Idea: ${esc(p.thesis).slice(0,160)}`:''}</span><span>${esc(p.reviewBy?`Review by ${fmtDate(p.reviewBy)}`:'')}</span></div>
  <div class="pos-actions"><button type="button" class="btn-mini" data-action="analyze-position" data-id="${esc(p.id)}" title="Analyze option returns using recorded entry and saved scenario">Analyze %</button>${isOpen?`<button type="button" class="btn-mini emph" data-action="close-position" data-id="${esc(p.id)}">Record exit</button><button type="button" class="btn-mini" data-action="add-fill" data-id="${esc(p.id)}">Add contracts</button>${duplicates>1?`<button type="button" class="btn-mini" data-action="merge-positions" data-id="${esc(p.id)}" title="Review matching open positions before merging">Merge duplicates (${duplicates})</button>`:''}`:''}<button type="button" class="btn-mini" data-action="edit-position" data-id="${esc(p.id)}">Edit plan</button><button type="button" class="btn-mini" data-action="add-note" data-id="${esc(p.id)}">+ Journal note</button>${full?`<button type="button" class="btn-mini" data-action="export-trade" data-id="${esc(p.id)}" title="Download only this position for GPT master review">Export trade</button>`:''}${full?`<button type="button" class="btn-mini" data-action="see-transactions" data-id="${esc(p.id)}">Fills / corrections</button><button type="button" class="btn-mini" data-action="delete-position" data-id="${esc(p.id)}">Delete</button>`:''}</div>
  ${full?`<details class="pos-details" id="detail-${esc(p.id)}"><summary>Original record and transactions</summary><p class="help-line">Source: ${esc(p.source||'Manual entry')} &bull; Master ID: ${esc(p.externalId||'Not linked')}</p><div class="plan-details"><div><strong>Thesis</strong><p>${esc(p.thesis||'Not recorded')}</p></div><div><strong>Catalyst / why now</strong><p>${esc(p.catalyst||'Not recorded')} ${esc(p.entryReason||'')}</p></div><div><strong>Management</strong><p>${esc(p.managementPlan||'Not recorded')}</p></div><div><strong>Other notes</strong><p>${esc(p.notes||'Not recorded')}</p></div></div><div class="journal-timeline">${renderTimeline(p)}</div><div class="modal-transaction-list">${transactionList(p)}</div></details>`:''}</article>`;
}
function renderTimeline(p){
 const events=[
  ...(p.journalEntries||[]).map(n=>({id:n.id,recordType:'journal-entry',type:n.kind||'Journal',date:n.date,time:n.createdAt||'',source:n.source||'App',body:n.body})),
  ...(p.planHistory||[]).map(n=>({id:n.id,recordType:'plan-revision',type:n.conflict?'Imported alternative plan':'Plan revision',date:n.date,time:n.createdAt||'',source:n.source||'',body:Object.entries(n.changes||{}).map(([k,v])=>`${k}: ${String(v.before??'')||'(blank)'} → ${String(v.after??'')||'(blank)'}`).join('\n')}))
 ].sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
 return events.length?`<h4>Journal / plan change timeline (${events.length})</h4>${events.map(n=>`<div class="journal-event"><div class="journal-event-head"><div><strong>${esc(n.type)}</strong><small>${esc(n.date||'Unspecified')} · ${esc(n.source)}</small></div><button class="timeline-remove" type="button" data-action="archive-timeline" data-id="${esc(p.id)}" data-event-type="${esc(n.recordType)}" data-event-id="${esc(n.id)}" aria-label="Remove ${esc(n.type)} dated ${esc(n.date||'unknown')} from timeline" title="Remove from timeline (recoverable)">×</button></div><p>${esc(n.body)}</p></div>`).join('')}`:'<p class="help-line">No visible journal or plan revisions. Removed records are recoverable in Rules & data → Archived corrections.</p>';
}
function transactionList(p){const tx=[...p.fills.map(x=>({...x,side:'BUY'})),...p.exits.map(x=>({...x,side:'SELL'}))].sort((a,b)=>`${a.date}${a.time||''}`.localeCompare(`${b.date}${b.time||''}`));return tx.map(t=>`<div class="transaction-row"><span>${esc(t.side)} ${t.qty} x ${money(t.price??0)} USD &bull; ${esc(fmtDate(t.date))} ${esc(t.time||'')} ${t.side==='SELL'?esc(t.reason||''):''}<br>Commission: ${usd(t.fee||0,t.broker?4:2)} <em>(${t.broker?'IBKR actual':t.feeEstimated?'estimate':'manual'})</em>; USD/CAD ${Number(t.fx||account().fx).toFixed(4)}</span><button type="button" class="tiny-btn" data-action="delete-tx" data-id="${esc(p.id)}" data-tx="${esc(t.id)}" data-side="${t.side}">Remove</button></div>`).join('');}
function positionsBudgetMarkup(m){
 const a=m.account;
 return `<div><div class="pos-data-label">$ BUDGET REMAINING</div><strong class="${m.availableCad<0?'neg':''}">${dualPositionMoney(m.availableCad/a.fx,m.availableCad)}</strong></div><small>${esc(a.name)} · ${a.window}-session rolling risk · ${esc(fmtDate(m.asOf))}</small>`;
}
function renderPositions(m){const arr=m.positions.filter(x=>positionFilter==='all'||(positionFilter==='open'?x.metrics.qty>0:x.metrics.qty===0));$('openCount').textContent=m.positions.filter(x=>x.metrics.qty>0).length;
  for(const f of document.querySelectorAll('.filter'))f.classList.toggle('active',f.dataset.filter===positionFilter);
  $('positionsBudget').innerHTML=positionsBudgetMarkup(m);
  $('positionsFull').innerHTML=arr.length?arr.map(x=>positionCard(x,true)).join(''):'<div class="empty-state">No matching positions for this date.</div>';
}
function renderHistory(m){
 const rows=[];
 for(const x of m.positions){
  const p=x.position;
  for(const f of p.fills||[])if(f.date<=m.asOf){rows.push({id:f.id,date:f.date,time:f.time||'',ticker:p.ticker,position:p,action:'BUY',qty:f.qty,priceUsd:f.price,underlyingAtExit:null,amountCad:(f.qty*f.price*100+num(f.fee))*num(f.fx),pnlCad:null,kind:'entry',positionId:p.id,source:f.broker?.source||p.source||''});}
  for(const c of x.metrics.closes){const raw=p.exits.find(e=>e.id===c.id)||{};rows.push({id:c.id,date:c.date,time:raw.time||'',ticker:p.ticker,position:p,action:'SELL',qty:c.qty,priceUsd:c.price,underlyingAtExit:c.underlyingAtExit,reason:c.reason||'',tpLabel:raw.tpLabel||'',exitNotes:raw.notes||'',amountCad:c.proceedsCad,pnlCad:c.pnlCad,returnPct:c.returnPct,kind:'sale',positionId:p.id,hasOverride:c.hasOverride,source:raw.broker?.source||p.source||''});}
 }
 for(const e of state.adjustments.filter(a=>a.accountId===m.account.id&&a.date<=m.asOf))rows.push({id:e.id,date:e.date,ticker:e.note||'Prior trade',action:'ADJUST',qty:'--',priceUsd:null,underlyingAtExit:null,amountCad:0,pnlCad:num(e.pnlCad),kind:'manual'});
 rows.sort((a,b)=>`${b.date}${b.time||''}`.localeCompare(`${a.date}${a.time||''}`));
 const closed=rows.filter(x=>x.pnlCad!==null),net=closed.reduce((s,x)=>s+x.pnlCad,0);
 $('historyStats').innerHTML=`<div><small>Realized P/L in last window</small><strong class="${m.recent.reduce((s,x)=>s+x.pnlCad,0)<0?'neg':'pos'}">${money(m.recent.reduce((s,x)=>s+x.pnlCad,0))}</strong></div><div><small>All logged realized P/L</small><strong class="${net<0?'neg':'pos'}">${money(net)}</strong></div><div><small>Entries / exits in account</small><strong>${rows.filter(x=>x.action==='BUY').length} / ${rows.filter(x=>x.action==='SELL').length}</strong></div>`;
 const mark=(v,empty='Not recorded')=>v?`<span>${esc(v)}</span>`:`<span class="missing-field">${esc(empty)}</span>`;
 $('historyTable').innerHTML=rows.length?`<table class="history-table expanded-ledger"><colgroup><col style="width:6%"><col style="width:12.5%"><col style="width:4%"><col style="width:7%"><col style="width:7%"><col style="width:9%"><col style="width:16%"><col style="width:13%"><col style="width:8%"><col style="width:6.5%"><col style="width:11%"></colgroup><thead><tr><th>DATE</th><th>CONTRACT</th><th>QTY</th><th>PREMIUM</th><th>TP</th><th>INVALIDATION</th><th>THESIS / CAT.</th><th>EXIT</th><th>P/L</th><th>RETURN %</th><th>ACTIONS</th></tr></thead><tbody>${rows.map(r=>{
  const p=r.position;const isManual=!p;
  const name=isManual?esc(r.ticker):`${esc(p.ticker)} ${esc(p.expiry)} ${esc(p.strike)}${p.optionType==='Put'?'P':'C'}`;
  const memo=p?[p.thesis?`Thesis: ${p.thesis}`:'',p.catalyst?`Catalyst: ${p.catalyst}`:'',p.entryReason?`Trigger: ${p.entryReason}`:''].filter(Boolean).join(' · '):'';
  const exitInfo=r.action==='SELL'?`${r.underlyingAtExit!==null?'Underlying $'+Number(r.underlyingAtExit).toFixed(2)+' · ':''}${r.tpLabel?esc(r.tpLabel)+' · ':''}${mark(r.reason,'Reason not supplied by IBKR')}${r.exitNotes?`<div class="history-subnote">${esc(r.exitNotes)}</div>`:''}`:'<span class="missing-field">----</span>';
  return `<tr><td data-label="DATE"><time datetime="${esc(r.date)}" title="${esc(fmtDate(r.date,true))}">${esc(historyDate(r.date))}</time><div class="history-subnote">${esc(r.time||'')}</div></td><td data-label="OPTION / SIDE"><strong>${name}</strong><div class="history-side">${esc(r.action)} ${r.hasOverride?'· broker P/L':''}</div></td><td data-label="QTY">${esc(r.qty)}</td><td data-label="PREMIUM USD">${r.priceUsd===null?'--':money(r.priceUsd,2)}</td><td data-label="TP" class="history-level-cell"><div class="history-cell-scroll" tabindex="0" title="${esc(p?.targetLevels||'')}">${p?mark(p.targetLevels):'--'}</div></td><td data-label="INVALIDATION" class="history-level-cell"><div class="history-cell-scroll" tabindex="0" title="${esc(p?.underlyingInvalidation||'')}">${p?mark(p.underlyingInvalidation):'--'}</div></td><td data-label="THESIS / CATALYST" class="history-thesis-cell"><div class="history-cell-scroll" tabindex="0" title="${esc(memo)}">${p?mark(memo,'Add thesis using Edit plan'):'--'}</div></td><td data-label="EXIT / REASON"><div class="history-cell-scroll" tabindex="0">${exitInfo}</div></td><td data-label="REALIZED CAD" class="${r.pnlCad===null?'':r.pnlCad>0?'pnl-pos':r.pnlCad<0?'pnl-neg':'pnl-zero'}">${r.pnlCad===null?'----':money(r.pnlCad)}</td><td data-label="RETURN %" title="Net realized P/L divided by allocated purchase cost of the contracts sold (fees included)" class="${r.returnPct===null||r.returnPct===undefined?'':r.returnPct>0?'pnl-pos':r.returnPct<0?'pnl-neg':'pnl-zero'}">${formattedReturn(r.returnPct)}</td><td data-label="REVIEW">${p?`<div class="history-actions"><button class="tiny-btn" type="button" data-action="edit-position" data-id="${esc(p.id)}">Edit plan</button><button class="tiny-btn" type="button" data-action="view-position" data-id="${esc(p.id)}">Details</button><button class="tiny-btn" type="button" data-action="export-trade" data-id="${esc(p.id)}" title="Download this one trade as JSON for GPT review">Export</button><button class="tiny-btn" type="button" data-action="add-note" data-id="${esc(p.id)}">+ Note</button>${r.action==='SELL'?`<button class="tiny-btn" type="button" data-action="edit-exit" data-id="${esc(p.id)}" data-tx="${esc(r.id)}">Exit details</button>`:''}</div>`:`<button class="tiny-btn" type="button" data-action="delete-adjustment" data-id="${esc(r.id)}">Archive</button>`}</td></tr>`;
 }).join('')}</tbody></table>`:'<div class="empty-inline">No executions yet. Import IBKR trades, add a position, or enter a historical result.</div>';
}
function renderSettings(a){const f=$('settingsForm');const tracked=calculateAccount(state,a.id,today());const fields={name:a.name,brokerAccountId:a.brokerAccountId||'',equityCad:tracked.currentEquityCad,riskPct:a.riskPct,window:a.window,stressPct:a.stressPct,roundStep:a.roundStep,mode:a.mode,fx:a.fx,ideaCapCad:a.ideaCapCad??'',ideaCapMode:a.ideaCapMode==='pool'?'pool':'fixed',buyFeePerContractUsd:ratePerContract(a,'BUY'),sellFeePerContractUsd:ratePerContract(a,'SELL')};
 for(const [k,v] of Object.entries(fields)){const field=f.elements.namedItem(k);if(field)field.value=v;}
 $('equitySettingsInfo').textContent=`Calculated: ${cad(tracked.equityCheckpointCad)} checkpoint ${tracked.equityChangeCad>=0?'+':''}${money(tracked.equityChangeCad)} net realized P/L = ${cad(tracked.currentEquityCad)} now. Editing this figure creates a new dated checkpoint without resetting rolling losses. Exclude unrealized P/L from open positions when reconciling, or you may count it again when they close.`;
 $('fxDescriptor').textContent=`1 USD = ${Number(a.fx).toFixed(4)} CAD`;
 $('fxSource').textContent=a.fxSource?`${a.fxSource}${a.fxDate?` (as of ${a.fxDate})`:''}`:'Manually set';
 renderInbox();updateBackupBadge();
  $('customClosedDays').innerHTML=(state.customClosed||[]).map(d=>`<span class="date-tag">${esc(fmtDate(d,true))}<button type="button" data-action="remove-closed-day" data-date="${esc(d)}" aria-label="Remove closure ${esc(d)}">x</button></span>`).join('')||'<span class="help-line">No extra closure dates.</span>';
}


// Listing metadata is transient, not stored with hypothetical draft pricing.
const expirationListings=new Map();
const pendingListingRequests=new Map();
// A small regular-only lookup is the default; All is opt-in and cached separately.
let regularExpiriesOnly=true;
const scopedExpirationKey=idea=>{const key=expirationLookupKey(idea);return key?key+'|'+(regularExpiriesOnly?'regular':'all'):'';};
const LISTING_TTL_MS=300000;
let listingDebounce=null;

function listingBadge(idea){
 const key=scopedExpirationKey(idea);
 if(!key)return '';
 const state=expirationListings.get(key);
 if(!state)return '<span class="listing-badge listing-neutral">Dates unverified</span>';
 if(state.status==='loading')return '<span class="listing-badge listing-loading"><span class="mini-spin" aria-hidden="true"></span> Checking dates</span>';
 if(state.status!=='verified')return '<span class="listing-badge listing-neutral">Lookup unavailable</span>';
 const status=expirationListingStatus(idea.expiry,state);
 if(!state.expirations.length)return '<span class="listing-badge listing-warning">No listed contracts</span>';
 if(status==='listed')return ''; // Selected expiration is already verified; keep warnings.
 if(status==='filtered')return '<span class="listing-badge listing-neutral">Hidden by regular filter</span>';
 if(status==='not-listed')return '<span class="listing-badge listing-warning">Not listed</span>';
 if(status==='outside-range')return '<span class="listing-badge listing-neutral">Outside checked range</span>';
 return '<span class="listing-badge listing-neutral">Choose a listed date</span>';
}
// One visible expiration control at a time: verified dropdown OR manual date.
// Expirations are discovered from ticker and Call/Put BEFORE selecting a strike.
// Manual overrides stay available, but they are never presented as verified.
const manualExpiryIds=new Set();
function expiryIndicator(idea){
 const key=scopedExpirationKey(idea),data=expirationListings.get(key);
 if(!key)return '';
 if(!data)return '<span class="expiry-inline-status neutral">Unverified</span>';
 if(data.status==='loading')return '<span class="expiry-inline-status neutral"><span class="mini-spin" aria-hidden="true"></span> Checking</span>';
 if(data.status!=='verified')return '<span class="expiry-inline-status neutral">Unavailable</span>';
 if(!data.expirations.length)return '<span class="expiry-inline-status warning">None found</span>';
 const status=expirationListingStatus(idea.expiry,data);
 if(status==='listed')return ''; // Keep warnings, not duplicate success text.
 if(status==='filtered')return '<span class="expiry-inline-status neutral">Hidden by filter</span>';
 if(status==='not-listed')return '<span class="expiry-inline-status warning">Not listed</span>';
 if(status==='outside-range')return '<span class="expiry-inline-status neutral">Unverified date</span>';
 return '<span class="expiry-inline-status neutral">'+data.expirations.length+' dates</span>';
}
function expirationField(idea){
 const key=scopedExpirationKey(idea),listing=key?expirationListings.get(key):null;
 const verified=listing?.status==='verified';
 const dates=verified?listing.expirations||[]:[];
 const manual=manualExpiryIds.has(idea.id);
 const selected=dates.includes(idea.expiry);
 const status=expirationListingStatus(idea.expiry,listing);
 // Native mobile calendars cannot selectively gray out arbitrary listed dates.
 // Always show the SAME verified-date dropdown on phone and desktop. A calendar
 // is only exposed when a user explicitly requests an unverified manual override.
 const retry=key&&listing?.status==='error'?'<span class="expiry-inline-status warning">Retry ↻</span>':'';
 const manualLink=!manual&&(!verified||!dates.length)
  ?'<button class="expiry-secondary-action" type="button" data-action="enter-manual-expiry" data-plan-id="'+esc(idea.id)+'" title="Choose an unverified date manually">Manual</button>':'';
 const returnLink=manual
  ?'<button class="expiry-secondary-action" type="button" data-action="use-listed-expirations" data-plan-id="'+esc(idea.id)+'">Listed dates</button>':'';
 const regularToggle='<label class="expiry-regular-toggle" title="Only verified standard Friday weekly/monthly and quarter-end expirations; uncheck to fetch every expiry"><input type="checkbox" name="regularExpiriesOnly" aria-label="Regular expirations only"'+(regularExpiriesOnly?' checked':'')+'> Regular only</label>';
 const label='<span class="expiry-field-heading"><span class="expiry-field-title">EXPIRATION</span>'+regularToggle+'<span data-expiry-status>'+expiryIndicator(idea)+'</span>'+retry+manualLink+returnLink+'</span>';
 const title=regularExpiriesOnly?'Verified regular expirations for this ticker and option type. Choose a strike afterward in View chain.':'All verified standard expirations for this ticker and option type. Verify the exact strike separately.';
 const refreshIcon='<button type="button" class="expiry-refresh-icon" data-action="refresh-listed-expirations" data-plan-id="'+esc(idea.id)+'" aria-label="Refresh expirations" title="Refresh expiration dates for this ticker and type"'+(key?'':' disabled')+'>↻</button>';
 let control='';
 if(manual){
  control='<input type="date" name="expiry" aria-label="Manual expiration (unverified)" value="'+esc(idea.expiry||'')+'" title="Manual override: not a verified listed expiration">';
 }else{
  let placeholder='';
  if(!key)placeholder='Enter ticker first';
  else if(!listing||listing.status==='loading')placeholder='Checking listed dates…';
  else if(!verified)placeholder='Unable to verify · Retry';
  else if(!dates.length)placeholder='No listed dates for this contract';
  else if(parseDay(idea.expiry)&&!selected)placeholder=fmtDate(idea.expiry,true)+(status==='filtered'?' · Hidden by filter':status==='outside-range'?' · Unverified':' · Not listed');
  else if(!selected)placeholder='Choose listed expiration…';
  const disabled=!verified||!dates.length;
  const needsPlaceholder=disabled||!selected;
  const options=dates.map(d=>'<option value="'+esc(d)+'"'+(selected&&d===idea.expiry?' selected':'')+'>'+esc(fmtDate(d,true))+(regularExpirationKind(d)?' (Regular)':'')+'</option>').join('');
  control='<select name="listedExpiry" aria-label="Available listed expiration dates" title="'+title+'"'+
   (disabled?' disabled':'')+(verified&&!selected&&parseDay(idea.expiry)?' class="expiry-unlisted"':'')+'>'+
   (needsPlaceholder?'<option value="" disabled selected>'+placeholder+'</option>':'')+
   options+(verified&&dates.length?'<option value="__manual__">Enter date manually (unverified)…</option>':'')+
   '</select><input type="hidden" name="expiry" value="'+esc(idea.expiry||'')+'">';
 }
 return '<div class="draft-expiration-field" data-expiration-field>'+label+'<div class="expiry-select-row">'+control+refreshIcon+'</div></div>';
}
function updateListingCard(idea){
 const card=[...document.querySelectorAll('[data-draft-id]')].find(x=>x.dataset.draftId===idea.id);
 if(!card)return;
 const badge=card.querySelector('[data-listing-badge]'),field=card.querySelector('[data-expiration-field]');
 if(badge)badge.innerHTML=listingBadge(idea);
 if(field){
  const live=field.querySelector('[data-expiry-status]');
  if(live)live.innerHTML=expiryIndicator(idea);
  // Never destroy the actual date input or dropdown while the user is
  // interacting with it; delegated change handling updates it afterward.
  if(field.dataset.dispatchingExpiry!=='true'&&!field.contains(document.activeElement))field.outerHTML=expirationField(idea);
 }
}
function updateListingCardsForKey(key){
 for(const idea of plannerIdeas())if(scopedExpirationKey(idea)===key)updateListingCard(idea);
}
function showInlineQuoteLoading(idea){
 const card=[...document.querySelectorAll('[data-draft-id]')].find(x=>x.dataset.draftId===idea?.id);
 if(!card)return;
 const quote=card.querySelector('[data-idea-quote]');
 if(quote&&idea.quoteStatus==='loading'){
  quote.dataset.tone='loading';
  quote.innerHTML='<span class="mini-spin" aria-hidden="true"></span> Fetching quote…';
 }
}
async function ensureListedExpirations(idea,force=false){
 const key=scopedExpirationKey(idea);
 if(!key)return;
 const current=expirationListings.get(key);
 if(current?.status==='loading'&&!force)return;
 if(!force&&current?.status==='verified'&&Date.now()-current.fetchedAt<LISTING_TTL_MS){
  updateListingCardsForKey(key);return;
 }
 // Explicit refresh can restart a stalled call. A superseded response cannot
 // overwrite fresh data or leave an infinite spinner behind.
 pendingListingRequests.get(key)?.controller.abort();
 const controller=new AbortController(),request={controller};
 pendingListingRequests.set(key,request);
 expirationListings.set(key,{status:'loading'});
 updateListingCardsForKey(key);
 const [ticker,type,scope]=key.split('|');
 const timeout=setTimeout(()=>controller.abort(),12500);
 try{
  const query=new URLSearchParams({ticker,type:type.toLowerCase(),scope});
  const response=await fetch('/api/option-expirations?'+query,{cache:'no-store',signal:controller.signal});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'Listing service unavailable.');
  if(data.status!=='verified'||data.ticker!==ticker||data.type!==type.toLowerCase()||
   data.scope!==scope||!Array.isArray(data.expirations))throw Error('Option listing response could not be verified.');
  if(pendingListingRequests.get(key)!==request)return;
  expirationListings.set(key,{status:'verified',scope,expirations:normalizeListedDates(data.expirations),
   checkedFrom:data.checkedFrom,checkedThrough:data.checkedThrough,fetchedAt:Date.now()});
 }catch(e){
  if(pendingListingRequests.get(key)!==request)return;
  expirationListings.set(key,{status:'error',message:controller.signal.aborted?'Lookup timed out. Tap ↻ to retry.':String(e.message||'Lookup unavailable').slice(0,170),fetchedAt:Date.now()});
 }finally{
  clearTimeout(timeout);
  if(pendingListingRequests.get(key)===request){
   pendingListingRequests.delete(key);
   updateListingCardsForKey(key);
  }
 }
}
function queueListedExpirations(idea,immediate=false){
 if(listingDebounce)clearTimeout(listingDebounce);
 if(!scopedExpirationKey(idea)){updateListingCard(idea);return;}
 if(immediate){void ensureListedExpirations(idea);return;}
 const id=idea.id,key=scopedExpirationKey(idea);
 listingDebounce=setTimeout(()=>{
  const current=plannerIdeas().find(i=>i.id===id);
  if(current&&scopedExpirationKey(current)===key)void ensureListedExpirations(current);
 },600);
}
function applyListedExpiry(ideaId,date){
 const idea=plannerIdeas().find(x=>x.id===ideaId);
 const listing=idea&&expirationListings.get(scopedExpirationKey(idea));
 if(!idea||!parseDay(date)||listing?.status!=='verified'||!listing.expirations.includes(date))return;
 const card=[...document.querySelectorAll('[data-draft-id]')].find(x=>x.dataset.draftId===idea.id);
 const field=card?.querySelector('input[name="expiry"]');
 if(!field)return;
 if(field.value===date){updateListingCard(idea);return;}
 // Dispatch both events against the ORIGINAL connected input. Otherwise
 // the input handler can rerender and detach the hidden field before 'change'
 // reaches the delegated quote-refresh listener (especially on mobile).
 const wrapper=field.closest('[data-expiration-field]');
 if(wrapper)wrapper.dataset.dispatchingExpiry='true';
 try{
  field.value=date;
  field.dispatchEvent(new Event('input',{bubbles:true}));
  field.dispatchEvent(new Event('change',{bubbles:true}));
 }finally{if(wrapper)delete wrapper.dataset.dispatchingExpiry;}
 card.querySelector('select[name="listedExpiry"]')?.blur();
 updateListingCard(idea);
}
function contractDisplayParts(idea){
 const expiryValid=Boolean(parseDay(idea?.expiry));
 const rawStrike=String(idea?.strike??'').trim(),strike=Number(rawStrike);
 const strikeValid=Boolean(rawStrike)&&Number.isFinite(strike)&&strike>0&&strike<=99999.999;
 const side=idea?.optionType==='Put'?'PUT':'CALL';
 return {
  hasExpiry:expiryValid,
  expiry:expiryValid?fmtDate(idea.expiry,true):'Select expiry',
  hasStrike:strikeValid,
  strike:strikeValid?'$'+strike.toLocaleString('en-US',{maximumFractionDigits:3})+' '+side:'Select strike'
 };
}
function compactContractMarkup(idea){
 const c=contractDisplayParts(idea);
 return '<span class="draft-contract-piece draft-contract-expiry'+(c.hasExpiry?'':' is-missing')+'">'+esc(c.expiry)+'</span>'+
  '<span class="draft-contract-separator" aria-hidden="true">·</span>'+
  '<strong class="draft-contract-piece draft-contract-strike'+(c.hasStrike?'':' is-missing')+'">'+esc(c.strike)+'</strong>';
}
function renderPlanner(m){
 const ideas=plannerIdeas(m.account.id);
 if($('planSortSelect'))$('planSortSelect').value=planSortMode;
 let changed=false;
 for(const idea of ideas){
  if(!idea.stressCustom&&String(idea.stress)!==String(m.account.stressPct)){idea.stress=String(m.account.stressPct);changed=true;}
  if(!idea.feeManual){const fee=estimateOrderFee(m.account,'BUY',idea.qty).toFixed(2);if(String(idea.fee)!==fee){idea.fee=fee;changed=true;}}
 }
 if(changed)persistPlannerDrafts();
 const sortedIdeas=sortPlanIdeas(ideas,planSortMode);
 const basket=calculatePlanBasket(sortedIdeas,m.account,m.availableCad,m.positions);
 const byId=new Map(basket.rows.map(x=>[x.id,x]));
 const fixedIdeaCap=activeIdeaCapCad(m.account);
 $('quickPlanner').innerHTML=sortedIdeas.map((idea,index)=>{
  const editing=expandedPlanId===idea.id,active=editing||selectedPreviewId===idea.id;
  const riskRow=byId.get(idea.id),overCap=Boolean(riskRow?.overIdeaCap);
  const capOverCad=overCap?riskRow.totalReserveCad-fixedIdeaCap:0;
  const symbol=normalizeTicker(idea.ticker)||'NEW TICKER',name=idea.name||'Untitled idea';

  const moneyOrDash=v=>String(v??'').trim()&&Number.isFinite(Number(v))&&Number(v)>0?usd(Number(v))+' ('+cad(Number(v)*m.account.fx)+')':'—';
  const mid=moneyOrDash(idea.marketMid),p=idea.preview||{};
  const quote=idea.quoteStatus==='loading'?'Fetching quote…':idea.priceManual?`Manual premium${mid!=='—'?' · Mid '+mid:''}`:idea.quoteStatus==='indicative'?`Indicative mid ${mid}`:idea.quoteStatus==='unavailable'?'Quote unavailable':idea.quoteStatus==='saved'?'Saved indicative quote · refresh':'Quote not loaded';
  const quoteTone=idea.quoteStatus==='unavailable'?'warning':idea.priceManual?'manual':idea.quoteStatus==='indicative'?'indicative':idea.quoteStatus==='saved'?'warning':'empty';
  return `<article class="draft-idea ${active?'is-active':''} ${editing?'is-expanded':'is-collapsed'} ${overCap?'is-over-idea-cap':''}" data-draft-id="${esc(idea.id)}">
    <div class="draft-head"><div class="draft-identity"><strong class="draft-ticker" data-idea-ticker>${esc(symbol)}</strong><span class="draft-idea-name" data-idea-name>${esc(name)}</span><span class="draft-contract-hero" data-idea-contract aria-label="Selected expiration and strike">${compactContractMarkup(idea)}</span><span data-listing-badge class="draft-listing-indicator">${listingBadge(idea)}</span></div>
      <div class="draft-actions"><button type="button" class="draft-edit-btn" data-action="toggle-plan-details" data-plan-id="${esc(idea.id)}" aria-expanded="${editing}">${editing?'Done':'Edit'}</button><button type="button" class="draft-preview-btn" data-action="analyze-idea" data-plan-id="${esc(idea.id)}" aria-pressed="${selectedPreviewId===idea.id&&optionPanelMode==='analyze'}">${selectedPreviewId===idea.id&&optionPanelMode==='analyze'?'Hide %':'Analyze %'}</button><button type="button" class="draft-chain-btn" data-action="view-option-chain" data-plan-id="${esc(idea.id)}" aria-pressed="${selectedPreviewId===idea.id&&optionPanelMode==='chain'}" title="Compare call and put volume, open interest and indicative quotes for this expiration">${selectedPreviewId===idea.id&&optionPanelMode==='chain'?'Hide chain':'View chain'}</button><button type="button" class="draft-edit-btn" data-action="copy-planner-idea" data-plan-id="${esc(idea.id)}" title="Copy only this idea to another portfolio" ${state.accounts.length<2||isEmptyPlannerPlaceholder(idea)?'disabled':''}>Copy to portfolio…</button><button type="button" class="draft-record" data-action="plan-to-position" data-plan-id="${esc(idea.id)}" ${riskRow?.valid&&riskRow.qty>0&&draftContract(idea)?'':'disabled'}>${riskRow?.existingQty?'Record add':'Record'}</button><button type="button" class="draft-remove" data-action="remove-plan-idea" data-plan-id="${esc(idea.id)}" aria-label="Remove ${esc(symbol)} ${esc(name)}">×</button></div></div>
    <div class="draft-compact-line"><span class="draft-mini-field"><strong data-idea-held></strong> Add <strong data-idea-qty>${esc(idea.qty||'—')}</strong></span><span class="draft-mini-field">Premium <strong data-idea-premium>${Number(idea.price)>0&&Number.isFinite(Number(idea.price))?usdWithCad(Number(idea.price),m.account.fx):"—"}</strong><small>/share</small></span><span class="draft-mini-field" data-idea-loss></span><span class="draft-mini-quote" data-tone="${quoteTone}" data-idea-quote>${idea.quoteStatus==='loading'?'<span class="mini-spin" aria-hidden="true"></span> ':''}${esc(quote)}</span></div>
    <div class="draft-cap-alert" data-cap-warning="${esc(idea.id)}" role="status" ${overCap?'':'hidden'}>${overCap?`<strong>ABOVE FIXED IDEA CAP · +${cad(capOverCad)}</strong><span>Combined position uses ${cad(riskRow.totalReserveCad)} vs your ${cad(fixedIdeaCap)} guide. Rolling pool is separate.</span><button type="button" data-action="focus-cap-policy" title="Review your fixed versus flexible risk allocation">Review policy</button>`:''}</div>
    ${editing?`<div class="draft-editor"><div class="draft-editor-heading"><strong>Contract setup</strong><span>Independent contract and assumptions per idea</span></div>
      <label class="draft-name-field"><span>IDEA NAME</span><input type="text" name="name" maxlength="80" value="${esc(idea.name||'')}" placeholder="Breakout continuation"></label>
      <div class="draft-contract-fields"><label><span>TICKER</span><input type="text" name="ticker" maxlength="12" value="${esc(idea.ticker||'')}" placeholder="IREN" autocomplete="off" spellcheck="false"></label><label><span>TYPE</span><select name="optionType"><option value="Call" ${idea.optionType!=='Put'?'selected':''}>Call</option><option value="Put" ${idea.optionType==='Put'?'selected':''}>Put</option></select></label>${expirationField(idea)}<label><span>STRIKE (USD)</span><input type="number" name="strike" min="0.001" step="0.001" value="${esc(idea.strike||'')}" placeholder="Choose in chain"></label></div>
      <div class="draft-editor-heading draft-editor-pricing"><strong>Entry &amp; risk</strong><span>Typing premium = manual override</span></div>
      <div class="draft-fields"><label><span>ADDITIONAL QTY</span><input type="number" inputmode="numeric" name="qty" min="0" step="1" value="${esc(idea.qty)}" aria-label="Idea ${index+1} contract quantity"></label><label><span>BUY PREMIUM (USD/SHARE)</span><input type="number" inputmode="decimal" name="price" min="0.01" step="0.0001" value="${esc(idea.price)}" aria-label="Idea ${index+1} price per share in USD"></label><label><span>BUY FEES (USD) <button class="fee-reset-mini" type="button" data-action="reset-draft-fee" data-plan-id="${esc(idea.id)}">Auto</button></span><input type="number" inputmode="decimal" name="fee" min="0" step="0.01" value="${esc(idea.fee)}" aria-label="Idea ${index+1} total entry commissions in USD"></label><label><span>EST. LOSS %</span><input type="number" inputmode="decimal" name="plannedLossPct" min="0" max="100" step=".1" value="${esc(idea.plannedLossPct??'')}" placeholder="${riskRow?.positionId&&riskRow.plannedLossPct!=null?esc(riskRow.plannedLossPct):'Not set'}" aria-label="Idea ${index+1} estimated loss at invalidation percent"></label><label><span>STRESS RISK %</span><input type="number" inputmode="numeric" name="stress" min="0" max="100" step="1" value="${esc(riskRow?.positionId?riskRow.stress??idea.stress:idea.stress)}" ${riskRow?.positionId?'disabled title="Uses existing position stress; edit the position plan to change it"':''} aria-label="Idea ${index+1} stress risk percent"></label></div></div>`:''}
    <div class="draft-metrics" data-plan-status="${esc(idea.id)}"></div>
    <details class="draft-quote-detail"><summary>Quote details</summary><div class="draft-quote-body"><div><span>Source</span><strong>${esc(p.quoteSource||'Not requested')}</strong></div><div><span>Bid / ask</span><strong>${esc(moneyOrDash(p.bid))} / ${esc(moneyOrDash(p.ask))}</strong></div><div><span>Midpoint</span><strong>${esc(mid)}</strong></div><div><span>Quote time (UTC)</span><strong>${esc(p.quoteAt||'Not available')}</strong></div><p>${esc(idea.quoteMessage||'Select a contract to request a quote.')}</p><small>Indicative Alpaca Basic, not executable OPRA quotes. Verify your broker quote.</small></div></details>
   </article>`;
 }).join('');
 const addBtn=document.querySelector('[data-action="add-plan-idea"]');
 if(addBtn)addBtn.disabled=ideas.length>=MAX_PLAN_IDEAS;

 updatePlannerMetrics(m);renderOptionPreview();
}
function updatePlannerMetrics(m){
 const ideas=sortPlanIdeas(plannerIdeas(m.account.id),planSortMode);const result=calculatePlanBasket(ideas,m.account,m.availableCad,m.positions);
 const activeCap=activeIdeaCapCad(m.account);
 for(const r of result.rows){const el=[...document.querySelectorAll('[data-plan-status]')].find(x=>x.dataset.planStatus===r.id);if(!el)continue;
   const card=el.closest?.('.draft-idea'),idea=ideas.find(i=>i.id===r.id);
   const held=card?.querySelector('[data-idea-held]'),record=card?.querySelector('[data-action="plan-to-position"]'),stressInput=card?.querySelector('[name="stress"]'),lossInput=card?.querySelector('[name="plannedLossPct"]'),copyBtn=card?.querySelector('[data-action="copy-planner-idea"]');
   if(copyBtn)copyBtn.disabled=state.accounts.length<2||isEmptyPlannerPlaceholder(idea);
   if(lossInput)lossInput.placeholder=r.positionId&&r.plannedLossPct!=null?String(r.plannedLossPct):'Not set';
   const lossLabel=card?.querySelector('[data-idea-loss]');if(lossLabel){lossLabel.hidden=!r.valid||r.plannedLossPct==null;lossLabel.innerHTML=r.valid&&r.plannedLossPct!=null?`Planned loss ${r.plannedLossPct}% · ${usdWithCad(r.plannedLossUsd,m.account.fx)}`:'';}
   if(held)held.textContent=r.existingQty?`${r.existingQty} held${r.valid?` / ${r.existingQty+r.qty} planned ·`:' ·'}`:'';
   if(record){record.disabled=!r.valid||!r.qty||!draftContract(idea);record.textContent=r.existingQty?'Record add':'Record';}
   if(stressInput){stressInput.disabled=!!r.positionId;if(r.positionId&&r.stress!=null)stressInput.value=String(r.stress);else if(document.activeElement!==stressInput)stressInput.value=idea.stress;}
  const warnEl=[...document.querySelectorAll('[data-cap-warning]')].find(x=>x.dataset.capWarning===r.id);
  if(warnEl){
   warnEl.hidden=!r.valid||!r.overIdeaCap;
   const overCad=r.valid&&r.overIdeaCap?r.totalReserveCad-activeCap:0;
   if(!warnEl.hidden)warnEl.innerHTML=`<strong>ABOVE FIXED IDEA CAP · +${cad(overCad)}</strong><span>Combined position uses ${cad(r.totalReserveCad)} vs your ${cad(activeCap)} guide. Rolling pool is separate.</span><button type="button" data-action="focus-cap-policy">Review policy</button>`;
   warnEl.closest?.('.draft-idea')?.classList?.toggle('is-over-idea-cap',!warnEl.hidden);
  }
  if(!r.valid){el.className='draft-metrics draft-incomplete';el.textContent=r.reason;continue;}
  const warning=r.overIdeaCap?`<small class="draft-cap-warning">Fixed guide exceeded by ${cad(r.totalReserveCad-activeCap)} (limit ${cad(activeCap)})</small>`:'';
  el.className=`draft-metrics ${r.overBudget?'draft-breach':''}`;
  el.innerHTML=`<div class="draft-metric draft-premium-total"><span>Option premiums (USD)</span><strong>${usdWithCad(r.premiumTotalUsd,m.account.fx)}</strong><small>${r.qty} contracts × ${usd(r.price)} per share × 100</small></div>
    <div class="draft-metric"><span>Estimated buy fees (USD)</span><strong>${usdWithCad(r.fee,m.account.fx)}</strong><small>Additional to option premiums · estimated entry fees</small></div>
    <div class="draft-metric"><span>Additional stress risk (CAD)</span><strong>${cadWithUsd(r.reserveCad,m.account.fx)}</strong><small>${r.existingQty?`Held ${cad(r.existingReserveCad)} → combined ${cad(r.totalReserveCad)}`:m.account.mode==='strict'?'100% of estimated buy cost':`${r.stress}% assumed loss`}</small>${warning}</div>
    <div class="draft-metric"><span>Remaining Risk Budget (CAD)</span><strong>${cadWithUsd(r.remainingCad,m.account.fx)}</strong><small>After open positions, rolling losses and preceding drafts</small></div>`;
 }

 const capMode=$('plannerCapMode'),capHelp=$('plannerCapPolicyHelp');
 if(capMode)capMode.value=activeCap===null?'pool':'fixed';
 if(capHelp)capHelp.textContent=activeCap===null
  ?`Flexible: share ${cad(Math.max(0,result.availableCad))} currently available across one or several ideas. No individual cap warning; the combined rolling budget still applies. ${m.account.mode==='strict'?'Strict mode reserves the full option debit.':'Stress-loss reserves are estimates, not worst-case losses; an option can lose its full debit.'}`
  :`Fixed: each combined position or new idea is compared with ${cad(activeCap)}. A warning is advisory; the combined rolling risk ceiling still applies.`;
 const flags=$('plannerCapFlagSummary'),offenders=result.rows.filter(r=>r.valid&&r.overIdeaCap);
 if(flags){
  flags.hidden=!offenders.length;
  flags.innerHTML=offenders.length?`<strong>${offenders.length} idea${offenders.length===1?'':'s'} above your ${cad(activeCap)} fixed guide:</strong>
    <div class="planner-cap-offenders">${offenders.map(r=>{const idea=ideas.find(i=>i.id===r.id);const name=[normalizeTicker(idea?.ticker)||'UNTITLED',idea?.name].filter(Boolean).join(' · ');return `<button type="button" data-action="jump-to-cap-idea" data-plan-id="${esc(r.id)}">${esc(name)} · +${cad(r.totalReserveCad-activeCap)} over <span>Review idea</span></button>`;}).join('')}</div>
    <small>Use the risk policy selector to switch to Flexible rolling pool if you're intentionally concentrating risk. This does not increase the rolling ceiling.</small>`:''; 
 }
 const strip=$('plannerSummaryStrip');
 if(strip){
  const status=result.overBudget?'OVER BUDGET':!result.complete?'INCOMPLETE':result.overIdeaCap?'CAP REVIEW':'FITS';
  strip.dataset.status=result.overBudget?'danger':!result.complete||result.overIdeaCap?'warning':'good';
  const stats=[['IDEAS',String(result.total)],['TOTAL CASH',usdWithCad(result.plannedDebitUsd,m.account.fx)],['RISK USED',cadWithUsd(result.plannedReserveCad,m.account.fx)],['RISK LEFT',cadWithUsd(result.remainingCad,m.account.fx)],['STATUS',status],['PREMIUMS',usdWithCad(result.plannedPremiumUsd,m.account.fx)],['FEES',usdWithCad(result.plannedBuyFeesUsd,m.account.fx)]];
  strip.innerHTML=stats.map(([label,value],index)=>`<div class="planner-summary-chip ${index===3?'planner-summary-left':index===4?'planner-summary-status':index>4?'planner-summary-secondary':''}"><span>${label}</span><strong>${value}</strong></div>`).join('');
 }
 $('planIdeaCount').textContent=`${result.total} of ${MAX_PLAN_IDEAS} drafts · ${result.priced} priced`;
 plannerSavedStatus();
 $('plannerResult').innerHTML=`<div class="result-line"><span>5-day risk available before these ideas (CAD)</span><strong>${cadWithUsd(result.availableCad,m.account.fx)}</strong></div>
  <div class="result-line"><span>Combined option premiums · qty × price × 100 (USD)</span><strong>${usdWithCad(result.plannedPremiumUsd,m.account.fx)}</strong></div>
  <div class="result-line"><span>Combined estimated buy fees (USD)</span><strong>${usdWithCad(result.plannedBuyFeesUsd,m.account.fx)}</strong></div>
  <div class="result-line planner-purchase-total"><span>Total cash to buy all ideas · premiums + fees (USD)</span><strong>${usdWithCad(result.plannedDebitUsd,m.account.fx)}</strong></div>
  <div class="result-line"><span>Additional risk from unrecorded ideas (CAD)</span><strong>${cadWithUsd(result.plannedReserveCad,m.account.fx)}</strong></div>
  <div class="result-line result-main ${result.overBudget?'negative':''}"><span>5-day risk budget left after all ideas (CAD)</span><strong>${cadWithUsd(result.remainingCad,m.account.fx)}</strong></div>
  <div class="result-line"><span>${!result.complete?'Enter USD premiums for remaining drafts':result.overBudget?'Combined draft entries breach your CAD rolling risk limit':result.overIdeaCap?'Combined CAD budget fits; check per-idea CAD risk caps':'All priced drafts fit the CAD rolling risk budget'}</span><strong class="${result.overBudget?'neg':result.complete&&!result.overIdeaCap?'pos':'risk-warning'}">${result.overBudget?'OVER BUDGET':!result.complete?'INCOMPLETE':result.overIdeaCap?'CAP REVIEW':'FITS'}</strong></div>
  <div class="planner-fx-note">FX used for estimated CAD risk: 1 USD = ${Number(m.account.fx).toFixed(4)} CAD (portfolio setting).</div>`;
 updateOptionPreviewResults();
}

// One on-demand preview for the selected hypothetical idea, never one chart per row.
function currentPreviewIdea(){return plannerIdeas().find(i=>i.id===selectedPreviewId);}
function ensurePreview(idea){if(!idea)return null;if(!idea.preview)idea.preview=emptyPreview(today(),state.customClosed||[]);return idea.preview;}
function adoptTickerLevels(idea,force=false){
 if(!idea)return {changed:false};
 const info=hydrateTickerScenario(plannerIdeas(),idea,today(),state.customClosed||[],force);
 if(info.changed)persistPlannerDrafts();
 return info;
}
function publishTickerLevels(idea){
 if(!idea)return;
 broadcastTickerScenario(plannerIdeas(),idea,today(),state.customClosed||[]);
}
function tickerLinkInfo(idea){
 const key=tickerScenarioKey(idea);
 if(!key)return '';
 const matches=plannerIdeas().filter(x=>x.id!==idea.id&&tickerScenarioKey(x)===key);
 if(!matches.length)return '';
 const linked=ensurePreview(idea).tickerLinked!==false;
 const count=matches.filter(x=>x.preview?.tickerLinked!==false).length;
 const symbol=normalizeTicker(idea.ticker),side=idea.optionType==='Put'?'puts':'calls';
 return `<div class="preview-ticker-sharing"><div><strong>${esc(symbol)} ${side} · ${linked?'Shared underlying plan':'Independent underlying plan'}</strong><small>${linked?`Stop, TPs and exit dates are linked to ${count} other ${esc(symbol)} ${side} idea${count===1?'':'s'} in this portfolio. Option premiums and IV remain contract-specific.`:'This idea keeps its own levels and dates. Other ideas are not changed.'}</small></div><button type="button" data-action="toggle-ticker-link" class="preview-ticker-toggle">${linked?'Use own plan':'Use shared plan'}</button></div>`;
}
function copySinglePlannerIdea(ideaId){
 const sourceId=account().id,idea=plannerIdeas(sourceId).find(x=>x.id===ideaId);
 if(!idea||isEmptyPlannerPlaceholder(idea))return showToast('Enter an idea before copying it.');
 const destinations=state.accounts.filter(x=>x.id!==sourceId);
 if(!destinations.length)return showToast('Create a second portfolio before copying an idea.');
 const title=[normalizeTicker(idea.ticker),idea.name].filter(Boolean).join(' · ')||'Selected idea';
 const body=`<p class="modal-intro">Copy only <strong>${esc(title)}</strong> ${esc(idea.expiry||'')} ${esc(idea.strike||'')}${idea.optionType==='Put'?'P':'C'} to the chosen portfolio. The original idea remains; no trades or account records are copied.</p><form><div class="modal-grid">${selectField('DESTINATION PORTFOLIO','targetId',destinations.map(x=>[x.id,x.name]),destinations[0].id)}</div><div id="singleCopyHint" class="modal-summary"></div>${formEnd('Copy this idea')}</form>`;
 const f=dialog('Copy to portfolio','ONE SELECTED IDEA',body);
 const preview=()=>{
  const targetId=new FormData(f).get('targetId'),dest=plannerDrafts[targetId]||[];
  const count=dest.length===1&&isEmptyPlannerPlaceholder(dest[0])?0:dest.length;
  $('singleCopyHint').textContent=count>=MAX_PLAN_IDEAS?`Destination already has ${count} ideas. Nothing can be added without removing one first.`:`Add 1 idea to ${count} existing. Destination risk and automatic fees use its own settings.`;
  f.querySelector('[type="submit"]').disabled=count>=MAX_PLAN_IDEAS;
 };
 f.addEventListener('change',preview);preview();
 f.addEventListener('submit',e=>{e.preventDefault();try{
  if(account().id!==sourceId)throw Error('Source portfolio changed. Reopen the copy dialog.');
  const targetId=new FormData(f).get('targetId'),previous=plannerDrafts;
  const result=copyPlannerIdea(plannerDrafts,sourceId,targetId,ideaId,uid,state.accounts.map(x=>x.id));
  if(!result.ok)throw Error(result.reason);
  plannerDrafts=result.drafts;persistPlannerDrafts();
  if(!plannerStorageHealthy){plannerDrafts=previous;throw Error('Could not save copied idea in this browser.');}
  $('editorDialog').close();renderPlanner(analytics());
  const target=state.accounts.find(x=>x.id===targetId);
  showToast(`Copied one idea to ${target?.name||'portfolio'}. Source unchanged. Review risk and refresh premium.`);
 }catch(err){f.querySelector('.modal-error').textContent=err.message;showToast(err.message);}});
}

function chainKey(idea){
 const ticker=normalizeTicker(idea?.ticker);
 const expiry=String(idea?.expiry||'');
 const rawStrike=String(idea?.strike??'').trim(),strike=Number(rawStrike);
 if(!ticker||!parseDay(expiry)||(rawStrike&&(!Number.isFinite(strike)||strike<=0||strike>99999.999)))return '';
 return ticker+'|'+expiry+'|'+(rawStrike?strike:'')+'|'+optionChainRange;
}
function renderChainPreview(idea=currentPreviewIdea()){
 const el=$('optionPreview');
 if(!el||!idea)return;
 const entry=chainCache.get(chainKey(idea));
 el.hidden=false;
 el.innerHTML=renderChainPanel({idea,data:entry?.status==='ready'?entry.data:null,
  loading:entry?.status==='loading',error:entry?.status==='error'?entry.message:'',
  side:chainSide,scope:optionChainRange,atmRange:expectedRangeDisplay(idea)});
}
async function refreshOptionChain(force=false){
 const idea=currentPreviewIdea();
 if(!idea||optionPanelMode!=='chain')return;
 const key=chainKey(idea),id=idea.id;
 if(!key){renderChainPreview(idea);return;}
 const cached=chainCache.get(key);
 if(cached?.status==='loading')return;
 if(!force&&cached?.status==='ready'&&Date.now()-cached.fetchedAt<60000){
  renderChainPreview(idea);return;
 }
 const token=++chainFetchToken;
 chainCache.set(key,{status:'loading'});
 renderChainPreview(idea);
 try{
  const parts=key.split('|');
  const qs=new URLSearchParams({ticker:parts[0],expiry:parts[1],scope:parts[3]});
  if(parts[2])qs.set('strike',parts[2]);
  const response=await fetch('/api/option-chain?'+qs,{cache:'no-store'});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(payload.error||'Could not load the full option chain.');
  if(!['ok','empty'].includes(payload.status)||payload.ticker!==parts[0]||payload.expiry!==parts[1]||payload.scope!==parts[3]||
   (payload.status==='ok'&&!Array.isArray(payload.rows)))throw Error('Option chain response was incomplete.');
  chainCache.set(key,{status:'ready',data:payload,fetchedAt:Date.now()});
 }catch(error){
  chainCache.set(key,{status:'error',message:String(error.message||'Chain unavailable').slice(0,200)});
 }finally{
  if(token===chainFetchToken&&selectedPreviewId===id&&optionPanelMode==='chain'&&
   chainKey(currentPreviewIdea())===key)renderChainPreview();
 }
}
function pickChainContract(el){
 const id=el.dataset.planId,side=el.dataset.side,strike=Number(el.dataset.strike);
 const idea=plannerIdeas().find(x=>x.id===id),entry=idea&&chainCache.get(chainKey(idea));
 if(!idea||entry?.status!=='ready'||!['Call','Put'].includes(side)||!Number.isFinite(strike))return;
 const row=entry.data.rows?.find(x=>x.strike===strike);
 if(!row||!row[side.toLowerCase()])return;
 const changed=Number(idea.strike)!==strike||idea.optionType!==side;
 const typeChanged=idea.optionType!==side;
 if(!changed){
  selectedPreviewId=null;optionPanelMode='analyze';expandedPlanId=idea.id;
  renderPlanner(analytics());return;
 }
 if(side!==idea.optionType){
  const p=ensurePreview(idea),fresh=emptyPreview(today(),state.customClosed||[]);
  p.targets=fresh.targets;p.dates=fresh.dates;p.tickerLinked=true;
  p.tickerLinkEstablished=false;p.tickerPlanEditedAt='';
 }
 idea.strike=String(strike);idea.optionType=side;
 const p=ensurePreview(idea);
 p.spot='';p.ivPct='';p.ivManual=false;p.bid='';p.ask='';
 p.quoteAt='';p.quoteSource='New contract requires new quote';
 idea.contractSymbol='';idea.marketMid='';idea.quoteStatus='';
 idea.quoteMessage='Contract changed. Old premium cleared; refreshing the new exact contract.';
 // Never carry a stale manually entered premium across a strike/side change.
 idea.price='';idea.priceManual=false;
 adoptTickerLevels(idea);
 persistPlannerDrafts();
 chainFetchToken++;
 selectedPreviewId=null;optionPanelMode='analyze';expandedPlanId=idea.id;
 renderPlanner(analytics());
 if(typeChanged)queueListedExpirations(idea,true);
 if(draftContract(idea))void refreshDraftPremium(idea);
}

function previewViewModel(idea){
 const contract=draftContract(idea);
 const result=projectOptionReturns({contract,preview:{...idea.preview,dates:visibleTickerDates(idea).visible.map(x=>x.date),ratePct:'4',dividendPct:'0'},qty:Number(idea.qty),entryPremium:Number(idea.price),entryFeeUsd:Number(idea.fee||0),sellFeePerContractUsd:ratePerContract(account(),'SELL'),asOf:new Date()});
 return {contract,result};
}
function percentCell(cell){
 if(!cell?.valid)return `<span class="preview-missing" title="${esc(cell?.reason||'Unavailable')}">----</span>`;
 const value=cell.returnPct;
 return `<div class="preview-return ${value>=0?'preview-positive':'preview-negative'}">${value>0?'+':''}${value.toFixed(1)}%</div><small>USD ${money(cell.netUsd)} net</small><small>USD ${money(cell.projectedSellPremium)} model exit/sh</small>`;
}
// The ATM expected move is shared across BOTH chain and return preview.
// It is ticker + expiration specific; never keyed to selected strike, side or account.
const atmRangeCache=new Map(),pendingAtmRanges=new Map();
const ATM_RANGE_TTL_MS=90000;
function atmRangeKey(idea){
 const ticker=normalizeTicker(idea?.ticker),expiry=String(idea?.expiry||'');
 return /^[A-Z][A-Z0-9.-]{0,10}$/.test(ticker)&&parseDay(expiry)?ticker+'|'+expiry:'';
}
function expectedRangeDisplay(idea){
 const key=atmRangeKey(idea),entry=key?atmRangeCache.get(key):null;
 if(!key)return {label:'Range unavailable',title:'Choose a valid ticker and expiration to request ATM data.',state:'unavailable'};
 if(!entry)return {label:'ATM range loading…',title:'Checking the IEX underlying trade and near-ATM option IV.',state:'loading'};
 if(entry.status==='loading')return {label:'ATM range loading…',title:'Checking the IEX underlying trade and near-ATM option IV.',state:'loading'};
 if(entry.status!=='ok')return {label:'Range unavailable',
  title:entry.reason||'An actual underlying price and valid ATM IV could not be verified. No guessed inputs.',state:'unavailable'};
 const d=entry.data,r=d.range;
 return {
  label:'ATM 1σ underlying: '+money(r.lower)+'–'+money(r.upper)+' (±'+money(r.move)+', '+r.movePct.toFixed(1)+'%)',
  title:'Estimated underlying-price range through 4 PM ET expiration using '+money(d.spotUsd)+
   ' IEX spot and '+d.atmIvPct.toFixed(1)+'% IV at nearest standard ATM strike '+money(d.atmStrike)+
   ' ('+d.ivMethod+'). '+r.days.toFixed(1)+' calendar days remaining. '+
   'Indicative data, not executable, a price target, a guaranteed probability or an option-premium range.',
  state:'ok'
 };
}
function updateExpectedRangeHeader(idea){
 if(!idea||atmRangeKey(idea)!==atmRangeKey(currentPreviewIdea()))return;
 const node=$('optionPreview')?.querySelector('[data-expected-range]');
 if(!node)return;
 const range=expectedRangeDisplay(idea);
 node.textContent=range.label;
 node.title=range.title;
 node.dataset.rangeStatus=range.state;
}
async function ensureAtmRange(idea,force=false){
 const key=atmRangeKey(idea);
 if(!key)return;
 const cached=atmRangeCache.get(key);
 if(cached?.status==='loading'&&!force)return;
 if(!force&&cached&&['ok','unavailable'].includes(cached.status)&&Date.now()-cached.fetchedAt<ATM_RANGE_TTL_MS){
  updateExpectedRangeHeader(idea);return;
 }
 pendingAtmRanges.get(key)?.abort();
 const controller=new AbortController();
 pendingAtmRanges.set(key,controller);
 atmRangeCache.set(key,{status:'loading'});
 updateExpectedRangeHeader(idea);
 const [ticker,expiry]=key.split('|');
 const timeout=setTimeout(()=>controller.abort(),13000);
 try{
  const query=new URLSearchParams({ticker,expiry});
  const response=await fetch('/api/atm-range?'+query,{cache:'no-store',signal:controller.signal});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'ATM data service unavailable.');
  if(data.ticker!==ticker||data.expiry!==expiry||!['ok','unavailable'].includes(data.status))
   throw Error('ATM data response invalid.');
  if(pendingAtmRanges.get(key)!==controller)return;
  if(data.status==='unavailable'){
   atmRangeCache.set(key,{status:'unavailable',reason:String(data.reason||'No valid ATM IV or underlying price.').slice(0,250),fetchedAt:Date.now()});
  }else{
   const fields=[data.spotUsd,data.atmStrike,data.atmIvPct,
    data.range?.lower,data.range?.upper,data.range?.move,data.range?.movePct,data.range?.days];
   if(fields.some(x=>typeof x!=='number'||!Number.isFinite(x)||x<0)||
    data.spotUsd<=0||data.atmStrike<=0||data.atmIvPct<=0||data.atmIvPct>1000||
    data.range.upper<data.range.lower||data.range.move<=0)
    throw Error('ATM source values incomplete.');
   atmRangeCache.set(key,{status:'ok',data,fetchedAt:Date.now()});
  }
 }catch(error){
  if(pendingAtmRanges.get(key)!==controller)return;
  atmRangeCache.set(key,{status:'unavailable',reason:controller.signal.aborted?'ATM range lookup timed out. Refresh the chain to retry.':
   String(error.message||'ATM data unavailable.').slice(0,250),fetchedAt:Date.now()});
 }finally{
  clearTimeout(timeout);
  if(pendingAtmRanges.get(key)===controller){
   pendingAtmRanges.delete(key);
   updateExpectedRangeHeader(idea);
  }
 }
}
function renderOptionPreview(){
 const el=$('optionPreview');if(!el)return;
 const idea=currentPreviewIdea();if(!idea){el.hidden=true;el.innerHTML='';return;}
 if(optionPanelMode==='chain'){renderChainPreview(idea);return;}
 el.hidden=false;
 const p=ensurePreview(idea),parsed=draftContract(idea)||{},symbol=buildOCCSymbol(parsed);
 const {visible:shownExitDates,excluded:unavailableExitDates}=visibleTickerDates(idea);
 const lastExitDate=shownExitDates.at(-1)?.date||today();
 const nextExitDate=nextSession(lastExitDate,state.customClosed||[]);
 const canAddExitDate=p.dates.length<MAX_PREVIEW_DATES && (!parseDay(parsed.expiry)||nextExitDate<=parsed.expiry);
 const quote=p.quoteAt?`As of ${esc(p.quoteAt.replace('T',' ').slice(0,19))} UTC`:'Not yet refreshed';
 const marketNumber=(n,unit,places=2)=>{const v=Number(n);return String(n??'').trim()!==''&&Number.isFinite(v)&&v>0?`${unit} ${v.toFixed(places)}`:'----';};
 const ivUnavailable=quoteConnectionState==='connected'&&!(Number(p.ivPct)>0);
 const ivHelp=ivUnavailable?`<div class="preview-iv-help" role="status"><div><strong>IV not supplied by Alpaca for this contract</strong><p>The free snapshot can include a bid/ask without a usable implied volatility. Enter the IV displayed in your broker's option chain for this exact strike and expiration to calculate returns. The model won't guess an IV.</p></div><button type="button" class="preview-enter-iv" data-action="enter-manual-iv">Enter broker IV</button></div>`:'';
 const connectionHelp=quoteConnectionState==='not-configured'?`<div class="preview-connect" role="status"><strong>One-time free data connection needed</strong><p>Automatic spot, IV and indicative bid/ask require free Alpaca Paper Only API keys. The feed is <strong>not connected</strong> yet. You can set it up without funding an Alpaca brokerage account.</p><ol><li><a href="https://app.alpaca.markets/signup" target="_blank" rel="noopener noreferrer">Create a free Alpaca paper-only account</a> and generate paper API credentials.</li><li>In your existing Vercel project's <strong>Settings → Environment Variables</strong>, add <code>ALPACA_DATA_KEY_ID</code> and <code>ALPACA_DATA_SECRET_KEY</code> for Production, then redeploy.</li><li>Return and press <strong>Refresh quote</strong>. Quotes will then fill automatically when you click Analyze %.</li></ol><small>Never enter API secrets into this form or chat. They belong in the server's environment settings.</small></div>`:'';
 const displayContract=contractDisplayParts(idea);
 const expectedRange=expectedRangeDisplay(idea);
 const previewIdentity='<div class="studio-contract-identity" aria-label="Selected option contract">'+
  '<span class="studio-contract-ticker">'+esc(normalizeTicker(idea.ticker)||'Ticker')+'</span>'+
  '<span class="studio-contract-expiry'+(displayContract.hasExpiry?'':' is-missing')+'">'+esc(displayContract.expiry)+'</span>'+
  '<strong class="studio-contract-strike'+(displayContract.hasStrike?'':' is-missing')+'">'+esc(displayContract.strike)+'</strong>'+
  '<span class="studio-expected-range" data-expected-range data-range-status="'+esc(expectedRange.state)+'" title="'+esc(expectedRange.title)+'">'+esc(expectedRange.label)+'</span></div>'+
  '<div class="studio-account-identity"><span>ACCOUNT</span><strong>'+esc(account().name)+'</strong></div>'+
  (idea.name&&idea.name!=='Untitled idea'?'<small class="studio-idea-name">Idea: '+esc(idea.name)+'</small>':'');
 el.innerHTML=`<div class="option-preview-heading"><div class="preview-title-stack"><div class="overline">SCENARIO STUDIO · WHAT-IF MODEL</div><h3>Projected option return by date</h3>${previewIdentity}</div><div class="preview-heading-actions"><span class="preview-mode-tag">HYPOTHETICAL RETURNS</span><button type="button" class="preview-close" data-action="close-option-preview" aria-label="Close option return preview">×</button></div></div>
  <p class="preview-explainer">Today’s underlying price and quoted IV are requested automatically when you select <strong>Analyze %</strong> (or press Refresh). Future dates are repriced at that <strong>unchanged IV</strong>, showing estimated time decay. Nothing is fetched in the background.</p>
  <div class="preview-quote-card">
   <div class="preview-workspace-step"><span>01</span><strong>Market reference</strong><small>Indicative snapshot or your manual inputs</small></div>
   <div class="preview-market-grid"><div data-market-key="spot"><span>Underlying (USD)</span><strong>${marketNumber(p.spot,'USD')}</strong></div><div data-market-key="ivPct"><span>Option IV</span><strong>${String(p.ivPct??'').trim()&&Number(p.ivPct)>0?`${Number(p.ivPct).toFixed(1)}%`:'----'}</strong><small class="preview-iv-source">${p.ivManual?'Broker-entered IV':'Alpaca IV when available'}</small></div><div data-market-key="bid"><span>Indicative bid (USD/share)</span><strong>${marketNumber(p.bid,'USD')}</strong></div><div data-market-key="ask"><span>Indicative ask (USD/share)</span><strong>${marketNumber(p.ask,'USD')}</strong></div></div>
   <div class="preview-quote-row"><button type="button" data-action="refresh-option-quote" ${!symbol||quoteRefreshBusy?'disabled':''} class="btn btn-outline preview-refresh">${quoteRefreshBusy?'<span class="mini-spin" aria-hidden="true"></span> ':''}${quoteRefreshBusy?'Fetching quote…':'Refresh quote'}</button><div class="preview-quote-label"><span data-preview-quote-source>${esc(p.quoteSource||'Quote not connected')}</span> · <span data-preview-quote-at>${quote}</span>${quoteRefreshBusy?' · Looking up this exact contract…':''}${quoteRefreshMessage?`<div class="preview-warning" role="status">${esc(quoteRefreshMessage)}</div>`:''}</div></div>
   ${connectionHelp}
   ${ivHelp}
   <details class="preview-manual"><summary>Optional: enter quote values manually if the free feed is unavailable</summary><div class="preview-inputs"><label><span>Underlying price (USD)</span><input type="number" name="spot" inputmode="decimal" min="0.01" step="any" value="${esc(p.spot)}" placeholder="e.g. 16.50"></label><label><span>Option IV (%)</span><input type="number" name="ivPct" inputmode="decimal" min="0.01" max="1000" step="any" value="${esc(p.ivPct)}" placeholder="e.g. 65.0"></label><label><span>Option bid (USD/share)</span><input type="number" name="bid" inputmode="decimal" min="0" step="any" value="${esc(p.bid)}" placeholder="Optional"></label><label><span>Option ask (USD/share)</span><input type="number" name="ask" inputmode="decimal" min="0" step="any" value="${esc(p.ask)}" placeholder="Optional"></label></div></details>
  </div>
  ${tickerLinkInfo(idea)}
  <div class="preview-grid-head"><strong><span class="preview-step-number">02</span> Underlying price targets (USD)</strong><button type="button" class="btn btn-outline preview-add-btn" data-action="preview-add-target" ${p.targets.length>=MAX_PREVIEW_TARGETS?'disabled':''}>+ TP</button></div>
  <div class="preview-targets">${p.targets.map(t=>`<label class="preview-target-row" data-target-id="${esc(t.id)}"><strong>${esc(t.name)}</strong><input type="number" name="target-price" inputmode="decimal" min="0.01" step="0.01" value="${esc(t.price)}" placeholder="Underlying USD price">${!['stop','tp1','tp2'].includes(t.id)?`<button type="button" class="preview-remove-mini" data-action="preview-remove-target" data-target-id="${esc(t.id)}" aria-label="Remove ${esc(t.name)}">×</button>`:''}</label>`).join('')}</div>
  <div class="preview-grid-head"><strong><span class="preview-step-number">03</span> Exit dates · 4 PM ET</strong><button type="button" class="btn btn-outline preview-add-btn" data-action="preview-add-date" ${!canAddExitDate?'disabled':''}>+ Date</button></div>
  <div class="preview-dates">${shownExitDates.map(({date,index},i)=>`<label class="preview-date-row"><span>${i===0?'Next session':i===1?'Second session':`Date ${i+1}`}</span><input type="date" name="exit-date" data-date-index="${index}" value="${esc(date)}" min="${esc(today())}" max="${esc(parsed.expiry||'2100-01-01')}">${p.dates.length>1?`<button type="button" class="preview-remove-mini" data-action="preview-remove-date" data-date-index="${index}" aria-label="Remove exit date">×</button>`:''}</label>`).join('')}</div>
  ${unavailableExitDates.length?`<p class="preview-expiry-note" role="note">${unavailableExitDates.length} ticker-plan exit date${unavailableExitDates.length===1?'':'s'} after ${esc(fmtDate(parsed.expiry,true))} excluded for this contract. The dates remain saved for longer-expiring ${esc(normalizeTicker(idea.ticker))} options.</p>`:''}
  <div class="preview-output-title"><span class="preview-step-number">04</span><div><strong>Scenario return matrix</strong><small>Price × date · net projected percentage after fees</small></div><span class="preview-output-tag">MODEL, NOT FORECAST</span></div>
  <div id="optionPreviewResults" aria-live="polite"></div>
  <details class="preview-data-help"><summary>Quote source and pricing-model limitations</summary><p>The optional free Alpaca Basic feed provides indicative options prices (not executable OPRA quotes) and IEX underlying trades. A free paper-only account is needed; it does not trade or connect to IBKR. The model uses fixed internal 4% annual interest and 0% dividend yield assumptions, not live rates. Actual dividend-paying stocks, early assignment, IV changes, earnings, slippage and stale quotes can materially change the results. Quick Size Check premium defaults to a valid indicative midpoint, unless you manually override it.</p></details>
  <p class="preview-caution">The projections are theoretical, with the same IV assumed for future dates—not a prediction of future IV, a guaranteed fill or statistical expectancy. The model is European-style; most U.S. stock options are American-style.</p>`;
 updateOptionPreviewResults();
}
function updateOptionPreviewResults(){
 const container=$('optionPreviewResults'),idea=currentPreviewIdea();if(!container||!idea)return;
 const {result,contract}=previewViewModel(idea);
 if(!result.valid){container.innerHTML=`<div class="preview-prompt">${esc(result.reason)}</div>`;return;}
 if(!result.dateHeaders.length){container.innerHTML='<div class="preview-prompt">No exit dates occur on or before this contract expiration. Adjust the shared plan, or use an independent plan for this option.</div>';return;}
 const dates=result.dateHeaders;
 const expMs=easternCloseMs(contract.expiry);
 const heading=dates.map(d=>`<th>${esc(fmtDate(d,true))}<small>${d===contract.expiry?'Expiration':d+' 4 PM ET'}</small></th>`).join('');
 const rows=result.rows.map(r=>`<tr><th>${esc(r.name)}<small>${r.spotPrice>0?usd(r.spotPrice):'Set target price'}</small></th>${r.values.map(x=>`<td class="${!x.valid?'preview-empty-cell':x.returnPct>=0?'preview-profit-cell':'preview-loss-cell'}">${percentCell(x)}</td>`).join('')}</tr>`).join('');
 const theta=result.thetaNextCalendarDayUsdPerContract;
 container.innerHTML=`<div class="preview-result-summary"><div><span>Modeled 1-day theta · unchanged stock / IV</span><strong class="${theta<0?'preview-negative':'preview-positive'}">${usd(theta)} / contract / calendar day</strong></div><div><span>Entry cost incl. fees</span><strong>${usd(result.baseCostUsd)}</strong></div><div><span>IV assumed at every date</span><strong>${result.ivPct.toFixed(1)}%</strong></div></div>
  <div class="preview-matrix-legend"><span class="preview-legend-gain">Positive modeled net return</span><span class="preview-legend-loss">Negative modeled net return</span></div>
  <div class="preview-matrix-scroll" role="region" aria-label="Modeled option returns by exit date" tabindex="0"><table class="preview-matrix"><thead><tr><th>Underlying target</th>${heading}</tr></thead><tbody>${rows}</tbody></table></div>
  <small class="preview-footnote">Valuation anchored to ${esc(result.anchorLabel)} at current spot; that anchor mismatch is reduced toward expiration. Percent = net modeled USD P/L ÷ actual proposed USD purchase cost (quantity × buy premium × 100 + buy fees). Estimated sell fees are deducted. ${result.spread>0?`Assumes half the current indicative ${usd(result.spread)} bid/ask spread is lost on exit.`:'No spread discount: enter a bid and ask to model half-spread exit slippage.'} These are scenario estimates, not statistical expectancy or guaranteed proceeds.</small>`;
}
// One-time quote on contract selection for any draft, without opening the analysis panel.
async function refreshDraftPremium(idea){
 const key=draftContractKey(idea),symbol=buildOCCSymbol(draftContract(idea)),id=idea?.id;
 if(!key||!symbol)return;
 idea.quoteStatus='loading';idea.quoteMessage='Fetching exact option quote…';showInlineQuoteLoading(idea);
 try{
  const verify=await fetch(`/api/option-contract?symbol=${encodeURIComponent(symbol)}`,{cache:'no-store'}).then(async r=>({status:r.status,ok:r.ok,data:await r.json().catch(()=>({}))})).catch(()=>({status:502,ok:false,data:{}}));
  if(verify.status===404||verify.status===422)throw Error(verify.data.error||'Contract unavailable in Alpaca listing.');
  const response=await fetch(`/api/option-quote?symbol=${encodeURIComponent(symbol)}`,{cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'Indicative quote unavailable.');
  const draft=plannerIdeas().find(i=>i.id===id);
  if(!draft||draftContractKey(draft)!==key)return;
  const bid=Number(data.optionBidUsd),ask=Number(data.optionAskUsd);
  if(data.optionBidUsd===null||data.optionAskUsd===null||!(bid>0&&ask>=bid))throw Error('No valid bid/ask for selected contract.');
  draft.marketMid=String(Math.round((bid+ask)*5000)/10000);
   const preview=ensurePreview(draft);preview.spot=data.spotUsd??'';if(!preview.ivManual||!(Number(preview.ivPct)>0))preview.ivPct=data.ivPct??'';preview.bid=data.optionBidUsd??'';preview.ask=data.optionAskUsd??'';preview.quoteAt=data.quoteAt||'';preview.quoteSource=data.provider||'Alpaca indicative';
  draft.contractSymbol=symbol;draft.quoteStatus='indicative';
  draft.quoteMessage=`Indicative bid ${bid.toFixed(2)} / ask ${ask.toFixed(2)} · midpoint ${Number(draft.marketMid).toFixed(2)} · ${data.quoteAt||'time unavailable'} UTC · ${verify.ok?'verified contract':'unverified listing'} · non-OPRA`;
  if(!draft.priceManual)draft.price=draft.marketMid;
  persistPlannerDrafts();renderPlanner(analytics());
 }catch(err){
  const draft=plannerIdeas().find(i=>i.id===id);
  if(!draft||draftContractKey(draft)!==key)return;
  draft.quoteStatus='unavailable';draft.quoteMessage=String(err.message||'Quote unavailable').slice(0,200);
  persistPlannerDrafts();renderPlanner(analytics());
 }
}
async function refreshOptionQuote(){
 const idea=currentPreviewIdea(),symbol=buildOCCSymbol(draftContract(idea)),contractKey=draftContractKey(idea);
 if(!idea||!symbol){quoteRefreshMessage='Enter a valid ticker, expiration, strike and call/put.';renderOptionPreview();return;}
 const token=++quoteRefreshToken;quoteRefreshBusy=true;quoteRefreshMessage='';quoteConnectionState='loading';idea.quoteStatus='loading';showInlineQuoteLoading(idea);void ensureListedExpirations(idea);renderOptionPreview();
 try{
  let verification='Contract listing unverified';
  const check=await fetch(`/api/option-contract?symbol=${encodeURIComponent(symbol)}`,{cache:'no-store'}).then(async response=>({ok:response.ok,status:response.status,data:await response.json().catch(()=>({}))})).catch(()=>({ok:false,status:502,data:{code:'VALIDATION_UNAVAILABLE'}}));
  if(token!==quoteRefreshToken||currentPreviewIdea()?.id!==idea.id||draftContractKey(idea)!==contractKey)return;
  if(check.status===404||check.status===422)throw Error(check.data.error||'Selected contract is not active in Alpaca.');
  if(check.ok)verification='Contract verified active by Alpaca';
  const response=await fetch(`/api/option-quote?symbol=${encodeURIComponent(symbol)}`,{cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){quoteConnectionState=data.code==='NOT_CONFIGURED'?'not-configured':'failed';throw Error(data.error||'Indicative quote unavailable');}
  if(token!==quoteRefreshToken||currentPreviewIdea()?.id!==idea.id||draftContractKey(idea)!==contractKey)return;
  const p=ensurePreview(idea),set=(k,v)=>{if(v!==null&&v!==undefined&&Number.isFinite(Number(v)))p[k]=String(v);};
  const manualIv=p.ivManual&&Number(p.ivPct)>0?p.ivPct:null;
  p.spot='';p.ivPct='';p.bid='';p.ask='';
  set('spot',data.spotUsd);if(manualIv!==null)p.ivPct=manualIv;else set('ivPct',data.ivPct);set('bid',data.optionBidUsd);set('ask',data.optionAskUsd);
  p.quoteAt=data.quoteAt||'';p.quoteSource=data.provider||'Alpaca indicative';
  const bid=Number(data.optionBidUsd),ask=Number(data.optionAskUsd);
  const valid=data.optionBidUsd!==null&&data.optionAskUsd!==null&&Number.isFinite(bid)&&Number.isFinite(ask)&&bid>0&&ask>0&&ask>=bid;
  idea.contractSymbol=symbol;idea.marketMid=valid?String(Math.round((bid+ask)*5000)/10000):'';
  idea.quoteStatus=valid?'indicative':'unavailable';
  idea.quoteMessage=valid?`Indicative bid ${bid.toFixed(2)} / ask ${ask.toFixed(2)} · midpoint ${Number(idea.marketMid).toFixed(2)} · ${p.quoteAt||'timestamp unavailable'} UTC · non-OPRA / non-executable · ${verification}`:'No valid indicative bid/ask. Enter a manual premium.';
  if(valid&&!idea.priceManual)idea.price=idea.marketMid;
  quoteConnectionState='connected';
  quoteRefreshMessage=data.missingIv&&!(Number(p.ivPct)>0)?'Alpaca returned no usable implied volatility. Enter your broker IV to run the simulation.':data.spotUsd===null?'Underlying price unavailable; enter manually.':idea.quoteMessage;
  persistPlannerDrafts();
 }catch(err){
  if(token===quoteRefreshToken&&currentPreviewIdea()?.id===idea?.id&&draftContractKey(idea)===contractKey){
   idea.quoteStatus='unavailable';idea.quoteMessage=String(err.message||'Refresh failed').slice(0,200);
   quoteRefreshMessage=idea.quoteMessage;persistPlannerDrafts();
  }
 }finally{if(token===quoteRefreshToken){quoteRefreshBusy=false;renderPlanner(analytics());}}
}

function switchTab(tab){if(!['dashboard','positions','history','settings'].includes(tab))return;activeTab=tab;render();}
function field(label,name,type='text',value='',opts={}){const attr=Object.entries(opts).map(([k,v])=>` ${k}="${esc(v)}"`).join('');return `<label class="${opts.full?'span-2':''}"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(value??'')}"${attr}></label>`;}
function selectField(label,name,options,value){return `<label><span>${esc(label)}</span><select name="${esc(name)}">${options.map(([val,text])=>`<option value="${esc(val)}" ${String(val)===String(value)?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;}
function dialog(title,eyebrow,body,submit,afterSave){$('dialogTitle').textContent=title;$('dialogEyebrow').textContent=eyebrow;$('dialogBody').innerHTML=body;const d=$('editorDialog');d.showModal();const f=$('dialogBody').querySelector('form');if(f&&submit){f.addEventListener('submit',e=>{e.preventDefault();try{const ok=submit(new FormData(f),f);if(ok!==false){d.close();const saved=save();render();if(saved)afterSave?.(ok);}}catch(err){showToast(err.message);const msg=f.querySelector('.modal-error');if(msg)msg.textContent=err.message;}});}return f;}
function attachFeeEstimate(form,portfolio,side,{automatic=true}={}){
  if(!form)return;
  const qty=form.elements.namedItem('qty'),fee=form.elements.namedItem('fee');
  if(!qty||!fee)return;
  let auto=automatic;
  const label=fee.closest('label');
  if(label){
    const note=document.createElement('small');note.className='fee-estimate-hint';
    note.setAttribute('data-fee-note','');label.appendChild(note);
    const reset=document.createElement('button');reset.type='button';reset.className='fee-reset-mini';reset.textContent='Use estimate';
    reset.title='Reset to the estimated per-contract fee in Portfolio settings';label.appendChild(reset);
    reset.addEventListener('click',()=>{auto=true;refresh();form.dispatchEvent(new Event('input',{bubbles:true}));});
  }
  const refresh=()=>{
    if(auto)fee.value=estimateOrderFee(portfolio,side,Number(qty.value)).toFixed(2);
    form.dataset.feeEstimated=String(auto);
    const hint=form.querySelector('[data-fee-note]');
    if(hint)hint.textContent=`${auto?'Estimate':'Manual override'} - USD ${ratePerContract(portfolio,side).toFixed(2)}/contract ${auto?'(replace with IBKR actual when imported)':''}`;
  };
  qty.addEventListener('input',refresh);
  fee.addEventListener('input',()=>{auto=false;refresh();});
  refresh();
}
function formEnd(text='Save'){return `<div class="modal-error neg" role="alert" style="font-size:12px"></div><div class="modal-actions"><button type="button" class="btn btn-outline" data-action="close-dialog">Cancel</button><button type="submit" class="btn btn-primary">${esc(text)}</button></div>`;}
function requireRange(v,min,max,label){const n=Number(v);if(v===''||!Number.isFinite(n)||n<min||n>max)throw new Error(`${label} must be between ${min} and ${max}.`);return n;}
function requireDate(v,label){if(!parseDay(v))throw new Error(`Enter a valid ${label}.`);return v;}
function validateSession(date){if(!isSession(date,state.customClosed))throw new Error(`${date} is not a NYSE trading session. Select the actual execution date.`);}
function validateAsOf(date){if(date>analytics().asOf)throw new Error('This execution falls after the AS OF session. Select its actual trading date above before recording it.');}
function getText(d,k){return String(d.get(k)||'').trim();}
function validateDeal(a,qty,price,fee,fx,date){requireRange(qty,1,99999,'Contracts');requireRange(price,0,100000,'Option price');requireRange(fee,0,100000,'Commission');requireRange(fx,.01,100,'USD/CAD rate');requireDate(date,'execution date');validateSession(date);}
function maybeBreach(before,newReserve){if(newReserve>before.availableCad+0.01){return confirm(`This adds ${money(newReserve)} risk but only ${money(Math.max(0,before.availableCad))} is available. Record as an over-budget historical execution anyway?`);}return true;}
// Only append to a unique currently-open continuous attempt.
function fillTarget(contract,a){
 const m=analytics(),matches=openContractMatches(contract,m.positions,a.id);
 if(matches.length>1)throw Error('Multiple matching open positions. Review them in Positions before recording.');
 return matches[0]?.position||null;
}
function addToExisting(p,a,fill){
 const live=state.positions.find(x=>x.id===p.id&&x.accountId===a.id);if(!live||draftContractKey(live)!==draftContractKey(p))throw Error('Position changed; reopen the recording dialog.');p=live;
 const before=analytics(),current=calculatePosition(p,a,before.asOf),latest=calculatePosition(p,a,'9999-12-31');
 if(!current.qty||!latest.qty||current.issues.length||latest.issues.length)throw Error('Position is closed or has execution conflicts. Reconcile in Positions.');
 if(fill.date>p.expiry)throw Error('Entry cannot be after expiry.');
 const stamp=`${fill.date}T${fill.time||'23:59'}`;
 if([...p.fills,...p.exits].some(t=>`${t.date}T${t.time||(p.fills.includes(t)?'00:00':'23:59')}`>stamp)||p.exits.some(t=>t.date===fill.date&&(!fill.time||fill.timeUnverified||t.timeUnverified||!t.time||t.time===fill.time)))throw Error('Earlier or ambiguous fill time could change historical exits. Use IBKR reconciliation or enter verified execution times.');
 const trial=structuredClone(state),target=trial.positions.find(z=>z.id===p.id);target.fills.push(fill);
 if(calculatePosition(target,a,'9999-12-31').issues.length)throw Error('Fill conflicts with existing transactions.');
 const after=calculateAccount(trial,a.id,asOf());
 if(!maybeBreach(before,after.reserveCad-before.reserveCad))return false;
 p.fills.push(fill);return true;
}
function addPosition(){const a=account(),pref=plannerPrefill;plannerPrefill=null;let recordedPositionId=null,changedLoss=false;const now=onOrBeforeSession(asOf(),state.customClosed||[]);
 const body=`<p class="modal-intro">Entry date, exact premium and fees determine the cost. Your 70% assumption affects the reserve, not a broker stop order.</p><form><div class="modal-grid">
 ${field('TICKER','ticker','text',pref?.ticker||'',{required:'required',maxlength:12})}
 ${selectField('OPTION TYPE','optionType',[['Put','Put'],['Call','Call']],pref?.optionType||'Put')}
 ${field('STRIKE (USD)','strike','number',pref?.strike??'',{min:0,step:.01,required:'required'})}
 ${field('EXPIRY','expiry','date',pref?.expiry||'',{required:'required'})}
 ${field('CONTRACTS','qty','number',pref?.qty||2,{min:1,step:1,required:'required'})}
 ${field('ENTRY PRICE PER SHARE (USD)','price','number',pref?.price||'',{min:0,step:.0001,required:'required'})}
 ${field('TOTAL ENTRY COMMISSIONS (USD)','fee','number',pref?.feeManual?pref.fee:estimateOrderFee(a,'BUY',pref?.qty||2),{min:0,step:.0001})}
 ${field('USD / CAD AT ENTRY','fx','number',a.fx,{min:.01,step:.0001})}
 ${field('TRADE DATE','date','date',now,{required:'required'})}
 ${field('TIME ET (OPTIONAL)','time','time','',{step:1})}
 ${field('STRESS % OVERRIDE (BLANK = ACCOUNT DEFAULT)','stressPct','number',pref?.stress??'',{min:0,max:100,step:1})}
 ${field('SECTOR / THEME','sector','text','',{maxlength:65})}
 ${field('IDEA / CORRELATED TRADE GROUP','ideaId','text','',{maxlength:90})}
 ${field('UNDERLYING INVALIDATION','underlyingInvalidation','text','',{maxlength:200})}
 ${field('EST. LOSS % OF TOTAL ENTRY COST','plannedLossPct','number',pref?.plannedLossPct??'',{min:0,max:100,step:.1})}
 ${field('UNDERLYING TARGETS / TP LEVELS','targetLevels','text','',{maxlength:220})}
 ${field('REVIEW DATE / TIME STOP','reviewBy','date','')}
 <label class="span-2"><span>THESIS / TRADE IDEA</span><textarea name="thesis" rows="3" maxlength="4000" placeholder="Why this direction? What's the structure or fundamental idea?"></textarea></label>
 <label class="span-2"><span>CATALYST / WHY NOW</span><textarea name="catalyst" rows="2" maxlength="3000" placeholder="Earnings, breakout, retest, technical shift, etc."></textarea></label>
 <label class="span-2"><span>ENTRY TRIGGER / EVIDENCE</span><textarea name="entryReason" rows="2" maxlength="3000" placeholder="What confirmed the entry at the time?"></textarea></label>
 <label class="span-2"><span>MANAGEMENT / EXIT PLAN</span><textarea name="managementPlan" rows="2" maxlength="5000" placeholder="TP order, structural response, review date and adjustments"></textarea></label>
 <label class="span-2"><span>ADDITIONAL NOTES</span><textarea name="notes" rows="3" placeholder="Other details not captured above" maxlength="12000"></textarea></label>
 </div><div id="newPreview" class="modal-summary"></div>${formEnd('Record position')}</form>`;
 const f=dialog('New swing position','ENTRY / QUOTE',body,(d)=>{
 const ticker=getText(d,'ticker').toUpperCase().replace(/[^A-Z0-9.\-]/g,'');if(!ticker)throw new Error('Enter a ticker.');
 const qty=requireRange(getText(d,'qty'),1,99999,'Contracts');if(!Number.isInteger(qty))throw Error('Contracts must be a whole number.');const price=requireRange(getText(d,'price'),.0001,100000,'Price');const fee=requireRange(getText(d,'fee')||'0',0,100000,'Fees');const fx=requireRange(getText(d,'fx'),.01,100,'USD/CAD');const date=requireDate(getText(d,'date'),'entry date');validateSession(date);validateAsOf(date);
 const expiry=requireDate(getText(d,'expiry'),'expiry');if(expiry<date)throw new Error('Expiry cannot precede purchase date.');
 const strike=requireRange(getText(d,'strike'),0,1000000,'Strike');const stress=optional(getText(d,'stressPct'));if(stress!==null)requireRange(String(stress),0,100,'Stress percentage');
 const plannedLoss=optional(getText(d,'plannedLossPct'));if(plannedLoss!==null)requireRange(String(plannedLoss),0,100,'Planned loss percentage');
 const contract={ticker,optionType:getText(d,'optionType'),strike,expiry};
  if(pref?.draftId&&draftContractKey(pref)!==draftContractKey(contract))throw Error('Contract changed. Edit the saved idea before recording.');
  const existing=fillTarget(contract,a);
  if(existing){
   if(!confirm('An open position matches this exact contract. Add this fill to it and keep its existing plan (with the estimated loss % updated if entered)?'))return false;
   if(!addToExisting(existing,a,{id:uid(),date,time:getText(d,'time')||'23:59',timeUnverified:!getText(d,'time'),qty,price,fee,fx,feeEstimated:f.dataset.feeEstimated==='true'}))return false;
   recordedPositionId=existing.id;if(plannedLoss!==null)changedLoss=applyPlannedLoss(findPosition(existing.id),plannedLoss,'Estimate confirmed during scale-in');
   if(pref){const live=findPosition(existing.id);captureDraftAnalysis(live,pref,live.fills.at(-1),a);}
   showToast(`Added ${qty} ${ticker} to existing position.`);return qty;
  }
  const historical=openContractMatches(contract,calculateAccount(state,a.id,date).positions,a.id);
  if(historical.length)throw Error('This contract was open on that historical date. Use IBKR reconciliation rather than creating an overlapping attempt.');
  const newReserve=roundUp((qty*price*100+fee)*a.fx*(a.mode==='strict'?100:(stress??a.stressPct))/100,a.roundStep);
 if(!maybeBreach(analytics(),newReserve))return false;
 const position={id:uid(),externalId:'',source:'Manual entry',accountId:a.id,ticker,optionType:getText(d,'optionType'),strike,expiry,sector:getText(d,'sector'),ideaId:getText(d,'ideaId')||`${ticker}-${date}`,underlyingInvalidation:getText(d,'underlyingInvalidation'),targetLevels:getText(d,'targetLevels'),stopPremiumUsd:null,plannedLossPct:plannedLoss,...(plannedLoss!==null?{plannedLossEditedAt:new Date().toISOString()}:{}),stressPct:stress,fixedReserveCad:null,reviewBy:getText(d,'reviewBy'),thesis:getText(d,'thesis'),catalyst:getText(d,'catalyst'),entryReason:getText(d,'entryReason'),managementPlan:getText(d,'managementPlan'),notes:getText(d,'notes'),journalEntries:[],planHistory:[],fills:[{id:uid(),date,time:getText(d,'time'),timeUnverified:!getText(d,'time'),qty,price,fee,fx,feeEstimated:f.dataset.feeEstimated==='true'}],exits:[]};
 position.planHistory.push({id:uid(),date,createdAt:new Date().toISOString(),source:'Initial plan recorded in app (entry-time status not independently verified)',changes:Object.fromEntries(['underlyingInvalidation','targetLevels','plannedLossPct','thesis','catalyst','entryReason','managementPlan','notes'].filter(k=>position[k]!==null&&position[k]!==undefined&&position[k]!=='').map(k=>[k,{before:'',after:position[k]}]))});if(pref)captureDraftAnalysis(position,pref,position.fills[0],a);state.positions.push(position);recordedPositionId=position.id;changedLoss=plannedLoss!==null;showToast(`Added ${qty} ${ticker} contract${qty!==1?'s':''}.`);return qty;
 },qty=>{if(pref)finishDraftRecord(pref,qty);else if(changedLoss&&recordedPositionId)syncPositionLossToDrafts(recordedPositionId);});
 const preview=()=>{const d=new FormData(f);const q=num(d.get('qty')),price=num(d.get('price')),fee=num(d.get('fee')),fx=num(d.get('fx'),a.fx),stress=optional(d.get('stressPct'))??a.stressPct;
 const cost=q*price*100+fee,raw=cost*a.fx*(a.mode==='strict'?1:stress/100),reserve=roundUp(raw,a.roundStep),pct=optional(d.get('plannedLossPct'));
 const box=$('newPreview');if(q>0&&price>0&&fx>0)box.innerHTML=`<strong>${money(reserve)} reserved</strong><span>Cost ${usd(cost)} / ${money(cost*fx)} CAD at entry FX; reserve uses current ${a.fx.toFixed(4)} rate. Budget after entry: ${money(analytics().availableCad-reserve)} CAD.${pct!==null&&Number.isFinite(pct)&&pct>=0&&pct<=100?` Planned loss: ${dualPositionMoney(cost*pct/100,cost*pct/100*a.fx)} (${pct}% of entry cost).`:''}</span>`;else box.innerHTML='<span>Enter a size and price to preview the reserve.</span>';
 };attachFeeEstimate(f,a,'BUY',{automatic:!pref?.feeManual});f.addEventListener('input',preview);preview();
}
function findPosition(id){const p=state.positions.find(x=>x.id===id&&x.accountId===account().id);if(!p)throw new Error('Position not found in this account.');return p;}
function closePosition(id){const a=account(),p=findPosition(id),existing=calculatePosition(p,a,analytics().asOf);if(existing.qty<=0)return showToast('Position is already closed.');
 const now=analytics().asOf;
 const body=`<p class="modal-intro">Close a slice or the full position. The remaining contracts keep their reserve. Net partial exits from this same position/attempt count together within the rolling window. Unrelated trades never offset its losses.</p><p class="help-line">Planned loss: ${existing.planLossUsd===null?'Not set':dualPositionMoney(existing.planLossUsd,existing.planLoss)}${existing.plannedLossPct!==null?` (${existing.plannedLossPct}% of total entry cost)`:''}. Stress risk (${existing.reservePct}%): ${dualPositionMoney(existing.reserveCad/a.fx,existing.reserveCad)}.</p><form><div class="modal-grid">
 ${field('CONTRACTS TO SELL','qty','number',existing.qty,{required:'required',min:1,max:existing.qty,step:1})}
 ${field('SALE PRICE PER SHARE USD / OPTIONAL WITH BROKER P&L','price','number','',{min:0,step:.0001})}
 ${field('EXIT COMMISSIONS USD','fee','number',estimateOrderFee(a,'SELL',existing.qty),{min:0,step:.0001})}
 ${field('USD / CAD ON SALE','fx','number',a.fx,{min:.01,step:.0001})}
 ${field('SALE DATE','date','date',now,{required:'required'})}
 ${field('TIME ET / OPTIONAL','time','time','',{step:1})}
 ${field('BROKER VERIFIED NET P&L CAD / OPTIONAL','brokerPnlCad','number','',{step:.01})}
 ${field('UNDERLYING PRICE AT EXIT / OPTIONAL','underlyingAtExit','number','',{min:0,step:.01})}
 ${field('TARGET HIT / LABEL (OPTIONAL)','tpLabel','text','',{maxlength:100})}<label><span>EXIT REASON</span><select name="reason"><option value="Target">Target / TP</option><option value="Invalidation">Invalidation</option><option value="Breakeven">Breakeven</option><option value="Risk reduction">Risk reduction</option><option value="Time stop">Time stop</option><option value="Other">Other</option></select></label>
 <label class="span-2"><span>EXIT JOURNAL / WHY YOU SOLD (OPTIONAL)</span><textarea name="notes" rows="3" maxlength="6000" placeholder="What was happening on the underlying? What changed in your thesis?"></textarea></label>
 </div><div id="closePreview" class="modal-summary"></div>${formEnd('Record exit')}</form>`;
 const f=dialog(`Sell ${p.ticker} contracts`,'PARTIAL OR FULL EXIT',body,(d)=>{
 const qty=Math.floor(requireRange(getText(d,'qty'),1,existing.qty,'Exit quantity'));
 const px=getText(d,'price'),override=getText(d,'brokerPnlCad');if(!px&&override==='')throw new Error('Enter sale price or broker net CAD P/L.');
 const price=px?requireRange(px,0,100000,'Exit price'):null;const fee=requireRange(getText(d,'fee')||'0',0,100000,'Fees');const fx=requireRange(getText(d,'fx'),.01,100,'FX');const date=requireDate(getText(d,'date'),'sale date');validateSession(date);validateAsOf(date);
 const at=calculatePosition(p,a,date).qty;if(qty>at)throw new Error(`Only ${at} contracts were open on ${date}.`);
 const pnlOverride=override===''?null:requireRange(override,-1e9,1e9,'Broker P/L');
 const newExit={id:uid(),date,time:getText(d,'time')||'23:59',qty,price,fee,fx,feeEstimated:f.dataset.feeEstimated==='true',brokerPnlCad:pnlOverride,underlyingAtExit:optional(getText(d,'underlyingAtExit')),reason:getText(d,'reason'),tpLabel:getText(d,'tpLabel'),notes:getText(d,'notes')};
 const check=structuredClone(p);check.exits.push(newExit);if(calculatePosition(check,a,'9999-12-31').issues.length)throw new Error('Sale time or quantity conflicts with other fills or prior exits.');
 p.exits.push(newExit);
 const after=calculateAccount(state,a.id,asOf());showToast(`Recorded ${qty} ${p.ticker} sale. Available: ${money(after.availableCad)}.`);return true;
 });
 const preview=()=>{const d=new FormData(f),q=num(d.get('qty')),price=optional(d.get('price')),broker=optional(d.get('brokerPnlCad'));
 if(q<1||q>existing.qty||(price===null&&broker===null)){$('closePreview').innerHTML='<span>Enter sale quantity and price (or verified broker P/L) for an exact budget preview.</span>';return;}
 try{const copy=structuredClone(state);const z=copy.positions.find(z=>z.id===p.id);z.exits.push({id:'__preview__',date:String(d.get('date')),time:String(d.get('time')||'23:59'),qty:q,price,fee:num(d.get('fee')),fx:num(d.get('fx')),brokerPnlCad:broker});const calc=calculateAccount(copy,a.id,asOf());const sale=calc.sales.find(x=>x.id==='__preview__');const result=sale?.pnlCad??0;const remains=calc.positions.find(x=>x.position.id===p.id)?.metrics;
 const box=$('closePreview');box.classList.toggle('alert',calc.availableCad<-.01);box.innerHTML=`<strong>After exit: ${money(calc.availableCad)} available</strong><span>Estimated realized ${money(result)} CAD (${result<0?'loss may consume net position budget':'profit offsets losses only within this position/attempt'}). Remaining reserve ${money(remains?.reserveCad||0)}.</span>`;
 }catch(err){$('closePreview').textContent='Set an eligible sale date to preview.';}
 };attachFeeEstimate(f,a,'SELL');f.addEventListener('input',preview);preview();
}
function addFill(id,pref=null){const a=account(),p=findPosition(id),now=analytics().asOf;let changedLoss=false;
 const body=`<p class="modal-intro">Adding to the same idea increases its open cost and reserved risk. This is not a new risk allowance.</p><form><div class="modal-grid">${field('ADDITIONAL CONTRACTS','qty','number',pref?.qty||1,{required:'required',min:1,step:1})}${field('PRICE / SHARE USD','price','number',pref?.price||'',{required:'required',min:.0001,step:.0001})}${field('TOTAL BUY FEES USD','fee','number',pref?.feeManual?pref.fee:estimateOrderFee(a,'BUY',pref?.qty||1),{min:0,step:.0001})}${field('USD / CAD AT BUY','fx','number',a.fx,{min:.01,step:.0001})}${field('DATE','date','date',now,{required:'required'})}${field('TIME ET','time','time','',{step:1})}${field('EST. LOSS % OF TOTAL ENTRY COST','plannedLossPct','number',pref?.plannedLossPct??p.plannedLossPct??'',{min:0,max:100,step:.1})}</div><div id="fillPreview" class="modal-summary"></div>${formEnd('Record added contracts')}</form>`;
 const f=dialog(`Add to ${p.ticker}`,'SAME IDEA / EXTRA EXPOSURE',body,(d)=>{
 const qty=requireRange(getText(d,'qty'),1,99999,'Contracts'),price=requireRange(getText(d,'price'),.0001,100000,'Premium'),fee=requireRange(getText(d,'fee')||'0',0,100000,'Fees'),fx=requireRange(getText(d,'fx'),.01,100,'FX'),date=requireDate(getText(d,'date'),'entry date');validateSession(date);validateAsOf(date);
 if(!Number.isInteger(qty))throw Error('Contracts must be a whole number.');
 const pct=optional(getText(d,'plannedLossPct'));if(pct!==null)requireRange(String(pct),0,100,'Estimated loss percentage');
 if(pref&&fillTarget(pref,a)?.id!==p.id)throw Error('Matching position changed. Reopen the idea.');
 if(!addToExisting(p,a,{id:uid(),date,time:getText(d,'time')||'23:59',timeUnverified:!getText(d,'time'),qty,price,fee,fx,feeEstimated:f.dataset.feeEstimated==='true'}))return false;
 changedLoss=applyPlannedLoss(findPosition(id),pct,'Estimate confirmed during scale-in');
 if(pref){const live=findPosition(id);captureDraftAnalysis(live,pref,live.fills.at(-1),a);}
 showToast(`Added ${qty} contract${qty===1?'':'s'} to ${p.ticker}.`);return qty;
 },qty=>{if(pref)finishDraftRecord(pref,qty);else if(changedLoss)syncPositionLossToDrafts(id);});
 const preview=()=>{const d=new FormData(f),qty=num(d.get('qty')),price=num(d.get('price')),fee=num(d.get('fee'));if(!Number.isInteger(qty)||qty<1||price<=0){$('fillPreview').innerHTML='<span>Enter contracts and premium to preview added risk.</span>';return;}
 const before=analytics(),clone=structuredClone(state);clone.positions.find(z=>z.id===p.id).fills.push({id:'__preview__',date:String(d.get('date')),time:String(d.get('time')||'23:59'),qty,price,fee,fx:num(d.get('fx'),a.fx)});
 const pct=optional(d.get('plannedLossPct'));clone.positions.find(z=>z.id===p.id).plannedLossPct=pct;
 const after=calculateAccount(clone,a.id,asOf()),z=after.positions.find(x=>x.position.id===p.id)?.metrics,old=before.positions.find(x=>x.position.id===p.id)?.metrics,cap=activeIdeaCapCad(a);
 $('fillPreview').innerHTML=`<strong>${old.qty} held → ${z.qty} combined · avg ${z.averageEntryUsd===null?'—':usdWithCad(z.averageEntryUsd,a.fx)}</strong><span>Additional reserve ${cad(after.reserveCad-before.reserveCad)} · combined ${cad(z.reserveCad)} · available after add ${cad(after.availableCad)}.${z.planLossUsd!==null?` Planned loss: ${dualPositionMoney(z.planLossUsd,z.planLoss)}.`:''}${cap!==null&&z.reserveCad>cap?' Above fixed idea guide.':''}</span>`;
 };attachFeeEstimate(f,a,'BUY',{automatic:!pref?.feeManual});f.addEventListener('input',preview);preview();
}
function editPlannedLoss(id){
 const p=findPosition(id),a=account(),z=calculatePosition(p,a,analytics().asOf);
 const body=`<p class="modal-intro">Enter the expected loss at your underlying invalidation, using Analyze % as a guide. Calculated from the entire recorded entry cost (including buy fees), not the remaining open cost. It does not change stress risk or the rolling budget. If you previously saved a stop-price estimate, it is retained as a fallback until a percentage is entered.</p><form><div class="modal-grid">${field('EST. LOSS % OF TOTAL ENTRY COST','plannedLossPct','number',p.plannedLossPct??'',{min:0,max:100,step:.1})}</div><div id="plannedLossPreview" class="modal-summary"></div>${formEnd('Save planned loss')}</form>`;
 const f=dialog(`Planned loss · ${p.ticker}`,'UNDERLYING INVALIDATION ESTIMATE',body,d=>{
  const live=findPosition(id),pct=optional(getText(d,'plannedLossPct'));
  if(pct!==null)requireRange(String(pct),0,100,'Planned loss percentage');
  applyPlannedLoss(live,pct,'Manual planned-loss percentage revision');
  showToast('Planned loss updated. Stress risk and budget unchanged.');return true;
 },()=>syncPositionLossToDrafts(id));
 const preview=()=>{const pct=optional(new FormData(f).get('plannedLossPct'));$('plannedLossPreview').innerHTML=`<strong>Total entry: ${dualPositionMoney(z.totalEntryDebitUsd,z.totalEntryDebitUsd*a.fx)}</strong><span>${pct===null?'No percentage estimate set.':Number.isFinite(pct)&&pct>=0&&pct<=100?`Planned loss: ${dualPositionMoney(z.totalEntryDebitUsd*pct/100,z.totalEntryDebitUsd*pct/100*a.fx)}`:'Enter a percentage from 0 to 100.'}</span>`;};
 f.addEventListener('input',preview);preview();
}
function editPosition(id){const p=findPosition(id);let lossChanged=false;const body=`<p class="modal-intro">Update your forward-looking risk plan. Do not rewrite what you knew before entry. No existing fills or realized results are changed. Estimated loss is your underlying-invalidation scenario, separate from the stress reserve.</p>${p.plannedLossPct==null&&p.stopPremiumUsd!=null&&p.stopPremiumUsd!==''?'<p class="help-line">A previously saved stop-price estimate is retained until you enter a loss percentage.</p>':''}<form><div class="modal-grid">
 ${field('TICKER','ticker','text',p.ticker,{required:'required',maxlength:12})}${selectField('OPTION TYPE','optionType',[['Put','Put'],['Call','Call']],p.optionType)}
 ${field('STRIKE','strike','number',p.strike,{min:0,step:.01})}${field('EXPIRY','expiry','date',p.expiry,{required:'required'})}
 ${field('CORRELATED IDEA / GROUP','ideaId','text',p.ideaId||'',{maxlength:90})}${field('SECTOR / THEME','sector','text',p.sector||'',{maxlength:65})}
 ${field('STRESS % (BLANK = DEFAULT)','stressPct','number',p.stressPct??'',{min:0,max:100,step:1})}${field('MINIMUM CAD RESERVE / OPTIONAL','fixedReserveCad','number',p.fixedReserveCad??'',{min:0,step:1})}
 ${field('PLANNED LOSS % OF TOTAL ENTRY COST','plannedLossPct','number',p.plannedLossPct??'',{min:0,max:100,step:.1})}${field('REVIEW / TIME-STOP DATE','reviewBy','date',p.reviewBy||'')}
 ${field('TARGETS / TP LEVELS ON UNDERLYING','targetLevels','text',p.targetLevels||'',{maxlength:220})}
 <label class="span-2"><span>UNDERLYING STRUCTURAL INVALIDATION</span><textarea name="underlyingInvalidation" rows="3" maxlength="1200">${esc(p.underlyingInvalidation||'')}</textarea></label>
 <label class="span-2"><span>THESIS / TRADE IDEA</span><textarea name="thesis" rows="4" maxlength="4000">${esc(p.thesis||'')}</textarea></label>
 <label class="span-2"><span>CATALYST / WHY NOW</span><textarea name="catalyst" rows="3" maxlength="3000">${esc(p.catalyst||'')}</textarea></label>
 <label class="span-2"><span>ENTRY TRIGGER / EVIDENCE</span><textarea name="entryReason" rows="3" maxlength="3000">${esc(p.entryReason||'')}</textarea></label>
 <label class="span-2"><span>MANAGEMENT / EXIT PLAN</span><textarea name="managementPlan" rows="3" maxlength="5000">${esc(p.managementPlan||'')}</textarea></label>
 <label class="span-2"><span>ADDITIONAL NOTES</span><textarea name="notes" rows="3" maxlength="12000">${esc(p.notes||'')}</textarea></label>
 </div>${formEnd('Save position rules')}</form>`;
 dialog(`Edit ${p.ticker}`,'PROSPECTIVE PLAN',body,(d)=>{
 const ticker=getText(d,'ticker').toUpperCase().replace(/[^A-Z0-9.\-]/g,'');if(!ticker)throw new Error('Ticker required.');
 const expiry=requireDate(getText(d,'expiry'),'expiry'),strike=requireRange(getText(d,'strike'),0,1e6,'Strike');
 const stress=optional(getText(d,'stressPct')),fixed=optional(getText(d,'fixedReserveCad')),plannedLoss=optional(getText(d,'plannedLossPct'));
 if(plannedLoss!==null)requireRange(String(plannedLoss),0,100,'Planned loss percentage');
 if(stress!==null)requireRange(String(stress),0,100,'Stress');if(fixed!==null)requireRange(String(fixed),0,1e8,'Fixed reserve');
 const identity={ticker,strike,expiry,optionType:getText(d,'optionType')};
  if(p.fills.some(t=>t.broker)&&Object.entries(identity).some(([k,v])=>String(p[k])!==String(v)))throw new Error('Broker-verified contract identity cannot be changed here. Add a correction note, or reconcile the source.');
  const changes={...identity,ideaId:getText(d,'ideaId'),sector:getText(d,'sector'),stressPct:stress,fixedReserveCad:fixed,plannedLossPct:plannedLoss,reviewBy:getText(d,'reviewBy'),targetLevels:getText(d,'targetLevels'),underlyingInvalidation:getText(d,'underlyingInvalidation'),thesis:getText(d,'thesis'),catalyst:getText(d,'catalyst'),entryReason:getText(d,'entryReason'),managementPlan:getText(d,'managementPlan'),notes:getText(d,'notes')};
  const n=recordPlanEdit(p,changes,{date:today(),source:'Manual plan revision'});
  if(n.includes('plannedLossPct')){p.plannedLossEditedAt=new Date().toISOString();lossChanged=true;}
  showToast(`${ticker} plan updated: ${n.length} change(s) preserved in timeline.`);return true;
 },()=>{if(lossChanged)syncPositionLossToDrafts(id);});
}
function addNote(positionId){const p=findPosition(positionId);const date=today();
 const types=['Journal / process','Premarket / original idea','Thesis update','Catalyst / event','Management decision','Psychology / emotion','Target / invalidation observation','Post-trade review','Other'];
 const body=`<p class="modal-intro">Append a dated note. Existing notes are never overwritten. The recorded-at timestamp distinguishes a contemporary observation from a retrospective one.</p><form><div class="modal-grid">${field('OBSERVATION DATE (ET)','date','date',date,{required:'required'})}${selectField('NOTE CATEGORY','kind',types.map(v=>[v,v]),'Journal / process')}<label class="span-2"><span>YOUR NOTE / THOUGHTS</span><textarea name="body" rows="7" maxlength="12000" required placeholder="What did you observe, feel, decide, or realize? Include the underlying level if material."></textarea></label></div>${formEnd('Append journal note')}</form>`;
 dialog(`Note for ${p.ticker}`,'APPEND-ONLY TRADE JOURNAL',body,d=>{const obs=requireDate(getText(d,'date'),'observation date');const text=getText(d,'body');if(!text)throw new Error('Note cannot be empty.');makeJournalEntry(p,{text,date:obs,kind:getText(d,'kind'),source:'Manual app note'});showToast(`Journal note saved to ${p.ticker} and backup.`);return true;});
}
function editExit(positionId,txId){const p=findPosition(positionId),tx=p.exits.find(x=>x.id===txId);if(!tx)throw new Error('Sale not found.');
 const reasons=[['','Not recorded'],['Target','Target / TP'],['Invalidation','Invalidation'],['Breakeven','Breakeven'],['Risk reduction','Risk reduction'],['Time stop','Time stop'],['Other','Other']];
 const body=`<p class="modal-intro">These are <strong>annotations</strong>, not changes to the broker fill economics. IBKR does not tell us your thesis, actual underlying price, TP intention or why you exited.</p><form><div class="modal-grid">${selectField('ACTUAL EXIT REASON','reason',reasons,tx.reason||'')}${field('TP LABEL / OBJECTIVE HIT','tpLabel','text',tx.tpLabel||'',{maxlength:120})}${field('UNDERLYING PRICE AT EXIT','underlyingAtExit','number',tx.underlyingAtExit??'',{min:0,step:.01})}<label class="span-2"><span>EXIT JOURNAL / CONTEMPORANEOUS THOUGHTS</span><textarea name="notes" rows="5" maxlength="6000">${esc(tx.notes||'')}</textarea></label></div>${formEnd('Save exit annotations')}</form>`;
 dialog(`Exit context: ${p.ticker}`,'THE WHY, NOT THE FILL',body,d=>{
  const next={reason:getText(d,'reason'),tpLabel:getText(d,'tpLabel'),underlyingAtExit:optional(getText(d,'underlyingAtExit')),notes:getText(d,'notes')};
  const changed=Object.keys(next).filter(k=>JSON.stringify(next[k]??'')!==JSON.stringify(tx[k]??''));
  if(changed.length){makeJournalEntry(p,{date:today(),kind:'Exit annotation change',source:`App annotation for ${tx.date} ${tx.time||''} / ${tx.id}`,text:`Updated exit ${tx.date} (${tx.qty} contracts): ${changed.map(k=>`${k}: [${String(tx[k]??'')||'blank'}] -> [${String(next[k]??'')||'blank'}]`).join('\n')}`});Object.assign(tx,next,{annotationEditedAt:new Date().toISOString()});}
  showToast(`Exit details saved; ${changed.length} change(s) in journal history.`);return true;});
}

/* Position-owned scenario studio. Independent of local Quick Size Check drafts. */
let positionAnalysisSession=null;
function positionAnalysisContext(session){
 if(account().id!==session.accountId)return null;
 const m=analytics(),x=m.positions.find(v=>v.position.id===session.positionId);
 if(!x||draftContractKey(x.position)!==session.contractKey)return null;
 const live=m.asOf===onOrBeforeSession(today(),state.customClosed||[])&&x.metrics.qty>0&&easternCloseMs(x.position.expiry)>Date.now();
 return {m,x,live,basis:live?currentAnalysisBasis(x.position,x.metrics,m.account,m.asOf):null};
}
function openPositionAnalysis(id){
 const p=findPosition(id),m=analytics(),key=draftContractKey(p),dialog=$('positionAnalysisDialog');
 if(!dialog)return;
 if(positionAnalysisSession?.controller)positionAnalysisSession.controller.abort();
 const initial=workingAnalysisPreview(p,today(),state.customClosed||[]);
 const session={positionId:id,accountId:m.account.id,contractKey:key,working:initial.preview,source:initial.source,mode:'current',status:'',busy:false,dirty:false,controller:null,token:0};
 const ctx=positionAnalysisContext(session),events=positionAnalysisEvents(p);
 if(!ctx?.live||!ctx.basis)session.mode=events.at(-1)?.id||'none';
 positionAnalysisSession=session;
 renderPositionAnalysis();
 dialog.showModal();
 if(session.mode==='current')void refreshPositionAnalysisQuote();
}
function positionAnalysisSelection(session,ctx){
 if(session.mode==='current')return {preview:session.working,basis:ctx.basis,contract:draftContract(ctx.x.position),asOf:new Date(),multiplier:Number(ctx.x.position.multiplier||100),editable:true,event:null};
 const event=positionAnalysisEvents(ctx.x.position).find(e=>e.id===session.mode);
 return event?{preview:event.preview,basis:event.basis,contract:event.contract,asOf:event.capturedAt,multiplier:event.multiplier,editable:false,event}:null;
}
function analysisTime(value){
 const d=new Date(value);
 return Number.isFinite(d.getTime())?d.toLocaleString('en-CA',{timeZone:'America/Toronto',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})+' ET':'Time unavailable';
}
function renderPositionAnalysis(){
 const session=positionAnalysisSession,root=$('positionAnalysisBody');if(!session||!root)return;
 const ctx=positionAnalysisContext(session);
 if(!ctx){root.innerHTML='<p class="preview-warning">The position or portfolio changed. Close and reopen Analyze %.</p>';return;}
 const p=ctx.x.position,events=positionAnalysisEvents(p),selection=positionAnalysisSelection(session,ctx);
 $('positionAnalysisTitle').textContent=p.ticker+' '+p.strike+(p.optionType==='Put'?'P':'C')+' · Analyze %';
 const options=[...(ctx.live&&ctx.basis?[['current','Current position · editable']]:[]),...events.map((e,i)=>[e.id,(e.kind==='entry'?'Recorded entry #'+(events.slice(0,i+1).filter(v=>v.kind==='entry').length):'Saved scenario')+' · '+analysisTime(e.capturedAt)])];
 if(!options.some(x=>x[0]===session.mode))options.push([session.mode,'No recorded scenario available']);
 const selector=`<label class="position-analysis-select"><span>ANALYSIS VIEW</span><select name="position-analysis-mode">${options.map(([id,label])=>`<option value="${esc(id)}" ${id===session.mode?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;
 if(!selection){root.innerHTML=selector+'<div class="preview-prompt">No original analysis snapshot was recorded for this position. Earlier quotes, IV and targets cannot be reconstructed. An eligible open position can be analyzed using a new scenario.</div>';return;}
 const {preview:v,basis:b,contract,editable,event}=selection;
 const identity=`<div class="studio-contract-identity"><span class="studio-contract-ticker">${esc(contract?.ticker||p.ticker)}</span><span class="studio-contract-expiry">${esc(contract?.expiry||p.expiry)}</span><strong class="studio-contract-strike">${esc(contract?.strike??p.strike)}${(contract?.optionType||p.optionType)==='Put'?'P':'C'}</strong></div><div class="studio-account-identity"><span>ACCOUNT</span><strong>${esc(ctx.m.account.name)}</strong></div>`;
 const basisText=b?`${esc(b.qty)} contract(s) · avg entry ${usd(b.price)} (${cad(b.price*ctx.m.account.fx)})/share · entry cost incl. buy fees ${usd(Number(b.qty)*Number(b.price)*Number(selection.multiplier||100)+Number(b.fee))}`:'Entry basis unavailable';
 const statusText=editable?'Remaining contracts only; percentages use actual weighted entry cost and allocated buy commissions. Closed contracts and realized P/L are excluded from this matrix.':'Frozen scenario from '+analysisTime(event.capturedAt)+'. The original input values are read-only. This models the recorded fill / saved basis, not the later trade outcome.';
 const provenance=editable?(session.source?`Targets loaded from ${session.source.kind==='entry'?'recorded entry':'saved scenario'} · ${analysisTime(session.source.capturedAt)}.`:'No original Analyze % data was saved; start a new scenario. No historical values inferred.'):`Recorded in ledger ${analysisTime(event.recordedAt)}. ${event.kind==='entry'?'Draft assumptions captured when Record was clicked; confirmed execution is stored separately.':''}`;
 const header=selector+identity+`<p class="preview-explainer"><strong>${esc(basisText)}</strong><br>${esc(statusText)}<br>${esc(provenance)}</p>`;
 if(!v){root.innerHTML=header+'<div class="preview-prompt">No scenario inputs were captured for this entry.</div>';return;}
 const dates=Array.isArray(v.dates)?v.dates:[],targets=Array.isArray(v.targets)?v.targets:[];
 const disable=editable?'':'disabled';
 const quoteLabel=editable?(v.quoteAt?'Reference quote '+analysisTime(v.quoteAt):v.quoteSource||'No current quote'):(v.quoteAt?'Captured quote timestamp '+analysisTime(v.quoteAt):v.quoteSource||'No quote timestamp saved');
 const marketFields=[['spot','Underlying price (USD)','0.01'],['ivPct','Option IV (%)','0.01'],['bid','Option bid (USD/share)','0'],['ask','Option ask (USD/share)','0']];
 const textPlan=[p.underlyingInvalidation?'Recorded invalidation: '+p.underlyingInvalidation:'',p.targetLevels?'Recorded target notes: '+p.targetLevels:''].filter(Boolean);
 const canAddDate=editable&&dates.length<MAX_PREVIEW_DATES&&parseDay(contract?.expiry);
 const draftNote=event?.kind==='entry'&&event.draft?`<details class="preview-data-help"><summary>Original sizing assumptions</summary><p>${esc(event.draft.name||'Saved sizing idea')} · planned qty ${esc(event.draft.qty??'—')} · quoted/planned premium ${esc(event.draft.price??'—')} USD/share · estimated buy fees ${esc(event.draft.fee??'—')} USD · estimated loss ${esc(event.draft.plannedLossPct??'—')}% · stress ${esc(event.draft.stress??'—')}%</p><p>${esc(event.draft.quoteMessage||'')}</p></details>`:'';
 root.innerHTML=header+`
  <div class="preview-quote-card"><div class="preview-workspace-step"><span>01</span><strong>Market reference</strong><small>${esc(quoteLabel)}</small></div>
  <div class="preview-inputs">${marketFields.map(([name,label,min])=>`<label><span>${label}</span><input type="number" name="pa-${name}" min="${min}" step="any" value="${esc(v[name]??'')}" ${disable}></label>`).join('')}</div>
  <div class="preview-quote-row">${editable?`<button type="button" class="btn btn-outline preview-refresh" data-pa-action="refresh" ${session.busy||!buildOCCSymbol(contract)?'disabled':''}>${session.busy?'Fetching quote…':'Refresh quote'}</button>`:''}<small data-pa-status role="status">${esc(session.mode==='current'?session.status:quoteLabel)}</small></div></div>
  ${draftNote}
  ${textPlan.length&&editable?`<p class="help-line">${textPlan.map(esc).join('<br>')}</p>`:''}
  <div class="preview-grid-head"><strong><span class="preview-step-number">02</span> Underlying price targets (USD)</strong>${editable?`<button type="button" class="btn btn-outline preview-add-btn" data-pa-action="add-target" ${targets.length>=MAX_PREVIEW_TARGETS?'disabled':''}>+ TP</button>`:''}</div>
  <div class="preview-targets">${targets.map((t,i)=>`<label class="preview-target-row"><strong>${esc(t.name)}</strong><input type="number" name="pa-target" data-index="${i}" min="0.01" step=".01" value="${esc(t.price)}" placeholder="Underlying USD price" ${disable}>${editable&&!['stop','tp1','tp2'].includes(t.id)?`<button type="button" class="preview-remove-mini" data-pa-action="remove-target" data-index="${i}" aria-label="Remove ${esc(t.name)}">×</button>`:''}</label>`).join('')}</div>
  <div class="preview-grid-head"><strong><span class="preview-step-number">03</span> Exit dates · 4 PM ET</strong>${editable?`<div class="position-analysis-date-actions"><button type="button" class="btn btn-outline preview-add-btn" data-pa-action="reset-dates">Next sessions</button><button type="button" class="btn btn-outline preview-add-btn" data-pa-action="add-date" ${canAddDate?'':'disabled'}>+ Date</button></div>`:''}</div>
  <div class="preview-dates">${dates.map((date,i)=>`<label class="preview-date-row"><span>Date ${i+1}${editable&&easternCloseMs(date)<Date.now()?' · past':''}</span><input type="date" name="pa-date" data-index="${i}" value="${esc(date)}" max="${esc(contract?.expiry||'2100-01-01')}" ${disable}>${editable&&dates.length>1?`<button type="button" class="preview-remove-mini" data-pa-action="remove-date" data-index="${i}">×</button>`:''}</label>`).join('')}</div>
  <div class="preview-output-title"><span class="preview-step-number">04</span><div><strong>Scenario return matrix</strong><small>Price × date · net projected percentage after fees</small></div><span class="preview-output-tag">MODEL, NOT FORECAST</span></div>
  <div id="positionAnalysisResults" aria-live="polite"></div>
  <p class="preview-caution">Same European-style model as Quick Size Check; fixed assumed IV, rates and dividends. Quotes are indicative, not guaranteed fills. The current view never treats old entry premium as today's market value.</p>
  ${editable?`<div class="modal-actions position-analysis-footer"><small id="positionAnalysisSaveHint">${session.dirty?'Unsaved scenario edits.':'Save to retain the current targets and assumptions.'}</small><button type="button" class="btn btn-primary" data-pa-action="save">Save scenario</button></div>`:''}`;
 updatePositionAnalysisResults();
}
function updatePositionAnalysisResults(){
 const session=positionAnalysisSession,container=$('positionAnalysisResults');if(!session||!container)return;
 const ctx=positionAnalysisContext(session),selection=ctx&&positionAnalysisSelection(session,ctx);if(!selection)return;
 const result=modelPositionAnalysis(selection);
 if(!result.valid){container.innerHTML=`<div class="preview-prompt">${esc(result.reason)}</div>`;return;}
 const heading=result.dateHeaders.map(d=>`<th>${esc(fmtDate(d,true))}<small>${d===selection.contract.expiry?'Expiration':esc(d)+' 4 PM ET'}</small></th>`).join('');
 const rows=result.rows.map(r=>`<tr><th>${esc(r.name)}<small>${r.spotPrice>0?usd(r.spotPrice):'Set target price'}</small></th>${r.values.map(x=>`<td class="${!x.valid?'preview-empty-cell':x.returnPct>=0?'preview-profit-cell':'preview-loss-cell'}">${percentCell(x)}</td>`).join('')}</tr>`).join('');
 const theta=result.thetaNextCalendarDayUsdPerContract;
 container.innerHTML=`<div class="preview-result-summary"><div><span>Modeled 1-day theta · unchanged stock / IV</span><strong class="${theta<0?'preview-negative':'preview-positive'}">${usd(theta)} / contract / day</strong></div><div><span>Actual analyzed acquisition cost</span><strong>${usd(result.baseCostUsd)}</strong></div><div><span>IV assumed at every date</span><strong>${result.ivPct.toFixed(1)}%</strong></div></div><div class="preview-matrix-scroll" role="region" aria-label="Modeled position returns by date" tabindex="0"><table class="preview-matrix"><thead><tr><th>Underlying target</th>${heading}</tr></thead><tbody>${rows}</tbody></table></div><small class="preview-footnote">Valuation anchored to ${esc(result.anchorLabel)}. Return = modeled net USD P/L divided by this view's actual acquisition cost, including buy fees. Estimated sell fees and half the indicative spread (when available) are deducted. Past/after-expiry dates are unavailable; use Next sessions in the current view.</small>`;
}
function markPositionAnalysisDirty(session){
 session.dirty=true;const hint=$('positionAnalysisSaveHint');if(hint)hint.textContent='Unsaved scenario edits.';
}
async function refreshPositionAnalysisQuote(){
 const session=positionAnalysisSession,ctx=session&&positionAnalysisContext(session);
 if(!session||!ctx?.live||!ctx.basis||session.mode!=='current')return;
 const symbol=buildOCCSymbol(draftContract(ctx.x.position));if(!symbol)return;
 session.controller?.abort();const controller=new AbortController(),token=++session.token;
 session.controller=controller;session.busy=true;session.status='Requesting exact contract and underlying…';renderPositionAnalysis();
 const timeout=setTimeout(()=>controller.abort(),15000);
 try{
  const response=await fetch('/api/option-quote?symbol='+encodeURIComponent(symbol),{cache:'no-store',signal:controller.signal});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.symbol!==symbol)throw Error(data.error||'Quote unavailable for this contract.');
  if(positionAnalysisSession!==session||session.token!==token||!positionAnalysisContext(session)?.live)return;
  const v=session.working;
  const positive=x=>x!==null&&x!==undefined&&Number.isFinite(Number(x))&&Number(x)>0;
  v.spot=positive(data.spotUsd)?String(data.spotUsd):'';
  if(!v.ivManual||!(Number(v.ivPct)>0))v.ivPct=positive(data.ivPct)&&Number(data.ivPct)<=1000?String(data.ivPct):'';
  const bid=Number(data.optionBidUsd),ask=Number(data.optionAskUsd),valid=data.optionBidUsd!=null&&data.optionAskUsd!=null&&Number.isFinite(bid)&&Number.isFinite(ask)&&bid>=0&&ask>0&&ask>=bid;
  v.bid=valid?String(bid):'';v.ask=valid?String(ask):'';
  v.quoteAt=typeof data.quoteAt==='string'&&Number.isFinite(Date.parse(data.quoteAt))?data.quoteAt:'';
  v.quoteSource=data.provider||'Alpaca indicative';session.status=[!v.spot?'Underlying unavailable; enter manually.':'',!v.ivPct?'IV unavailable; enter broker IV.':'',!valid?'No valid option midpoint; theoretical model only.':'Indicative bid/ask loaded.',v.ivManual?'Using saved/manual IV.':''].filter(Boolean).join(' ');
  if(valid)positionQuotes.set(symbol,{mid:(bid+ask)/2,at:v.quoteAt||null});
  updatePositionQuoteCells();
 }catch(err){
  if(positionAnalysisSession===session&&session.token===token)session.status='Quote unavailable. '+(controller.signal.aborted?'Request timed out.':String(err.message||'Refresh failed').slice(0,180))+' Enter current assumptions manually.';
 }finally{clearTimeout(timeout);if(positionAnalysisSession===session&&session.token===token){session.busy=false;session.controller=null;renderPositionAnalysis();}}
}
function positionAnalysisInput(e){
 const session=positionAnalysisSession;if(!session||session.mode!=='current')return;
 const name=e.target.name,v=session.working,index=Number(e.target.dataset.index);
 if(['pa-spot','pa-ivPct','pa-bid','pa-ask'].includes(name)){
  const key=name.slice(3);v[key]=e.target.value;if(key==='ivPct')v.ivManual=Number(v.ivPct)>0;
  v.quoteSource='Manual assumptions';v.quoteAt='';session.status='Manual market assumptions.';
  // A user edit supersedes an in-flight automatic refresh.
  if(session.busy){session.token++;session.controller?.abort();session.controller=null;session.busy=false;}
  const status=$('positionAnalysisBody').querySelector('[data-pa-status]');if(status)status.textContent=session.status;
  const refresh=$('positionAnalysisBody').querySelector('[data-pa-action="refresh"]');if(refresh){refresh.disabled=false;refresh.textContent='Refresh quote';}
 }else if(name==='pa-target'&&v.targets[index])v.targets[index].price=e.target.value;
 else if(name==='pa-date'&&v.dates[index]){
  if(!parseDay(e.target.value)||e.target.value>positionAnalysisContext(session)?.x.position.expiry||v.dates.some((d,i)=>i!==index&&d===e.target.value))return;
  v.dates[index]=e.target.value;
 }else return;
 markPositionAnalysisDirty(session);updatePositionAnalysisResults();
}
function positionAnalysisAction(action,element){
 const session=positionAnalysisSession,ctx=session&&positionAnalysisContext(session);
 if(!session||session.mode!=='current'||!ctx?.live||!ctx.basis)return;
 const v=session.working,p=ctx.x.position,index=Number(element.dataset.index);
 if(action==='refresh'){void refreshPositionAnalysisQuote();return;}
 if(action==='add-target'&&v.targets.length<MAX_PREVIEW_TARGETS){
  let n=3;while(v.targets.some(t=>t.name==='TP'+n))n++;
  v.targets.push({id:uid().replace(/[^A-Za-z0-9_-]/g,'').slice(0,40),name:'TP'+n,price:''});
 }else if(action==='remove-target'&&v.targets[index]&&!['stop','tp1','tp2'].includes(v.targets[index].id))v.targets.splice(index,1);
 else if(action==='reset-dates'){
  const dates=emptyPreview(today(),state.customClosed||[]).dates.filter(d=>d<=p.expiry);v.dates=dates.length?dates:[p.expiry];
 }else if(action==='add-date'&&v.dates.length<MAX_PREVIEW_DATES){
  const start=[today(),...v.dates.filter(parseDay)].sort().at(-1),date=nextSession(start,state.customClosed||[]);
  if(date>p.expiry)return showToast('No additional session before expiry. Edit or reset the saved dates.');
  if(!v.dates.includes(date))v.dates.push(date);
 }else if(action==='remove-date'&&v.dates.length>1&&v.dates[index])v.dates.splice(index,1);
 else if(action==='save'){
  const live=findPosition(session.positionId),event=appendAnalysisRevision(live,v,ctx.basis,uid());
  if(!save()){live.analysisHistory=live.analysisHistory.filter(x=>x.id!==event.id);session.status='Could not save. Original scenario history remains unchanged.';renderPositionAnalysis();return;}
  session.dirty=false;session.source=event;session.status='Scenario saved to position history.';renderPositionAnalysis();return;
 }else return;
 markPositionAnalysisDirty(session);renderPositionAnalysis();
}
function initPositionAnalysis(){
 const dialog=$('positionAnalysisDialog'),root=$('positionAnalysisBody');if(!dialog||!root)return;
 root.addEventListener('input',positionAnalysisInput);
 root.addEventListener('change',e=>{
  const session=positionAnalysisSession;if(!session)return;
  if(e.target.name==='position-analysis-mode'){
   session.mode=e.target.value;renderPositionAnalysis();
   if(session.mode==='current'&&!session.working.spot&&!session.busy)void refreshPositionAnalysisQuote();
  }else if(e.target.name==='pa-date')renderPositionAnalysis();
 });
 dialog.addEventListener('click',e=>{
  const el=e.target.closest('[data-pa-action]');if(!el)return;
  if(el.dataset.paAction==='close'){dialog.close();return;}
  try{positionAnalysisAction(el.dataset.paAction,el);}catch(err){showToast(err.message);const status=root.querySelector('[data-pa-status]');if(status)status.textContent=err.message;}
 });
 dialog.addEventListener('close',()=>{const session=positionAnalysisSession;positionAnalysisSession=null;session?.controller?.abort();root.innerHTML='';});
}

function openPositionDetail(id){positionFilter='all';activeTab='positions';render();const item=$('positionsFull').querySelectorAll('[data-position]');for(const el of item)if(el.dataset.position===id){const details=el.querySelector('details');if(details)details.open=true;el.scrollIntoView({block:'center',behavior:'smooth'});break;}}
function renderInbox(){const pending=state.brokerInbox||[],conflicts=state.conflicts||[],archive=(state.archive||[]).filter(x=>!x.restoredAt);
 $('importInbox').innerHTML=`<div class="inbox-head"><strong>Import exceptions: ${pending.length} pending · ${conflicts.length} conflicting · ${archive.length} archived</strong><span>All retained in full JSON backup</span></div>`+
 (pending.length?`<details class="issue-details"><summary>Review ${pending.length} unreconciled IBKR row(s)</summary>${pending.slice(-50).map(x=>`<div class="issue-row"><strong>${esc(x.ticker)} ${esc(x.tradeDate)}</strong> ${esc(x.side)}: ${esc(x.reason)}<div class="history-subnote">${esc(x.raw?.Symbol||'')} / ${esc(x.raw?.['Date/Time']||'')}</div></div>`).join('')}</details>`:'')+
 (conflicts.length?`<details class="issue-details"><summary>Review ${conflicts.length} saved conflict(s)</summary>${conflicts.slice(-50).map(x=>`<div class="issue-row">${esc(x.reason||x.kind||'Import conflict')}<div class="history-subnote">${esc(x.positionId||'')}</div></div>`).join('')}</details>`:'')+
 (archive.length?`<details class="issue-details"><summary>Archived corrections (${archive.length})</summary>${archive.slice(-50).reverse().map(x=>`<div class="issue-row">${esc(x.kind||'record')} · ${esc(x.date)} · ${esc(x.label||'')} ${x.kind==='position-merge'||x.mergedIntoPositionId?'<small>Merge audit · backup only</small>':`<button class="tiny-btn" type="button" data-action="restore-archive" data-id="${esc(x.id)}">Restore</button>`}</div>`).join('')}</details>`:'');
}
function manualPnl(){const now=analytics().asOf;const body=`<p class="modal-intro">For a previously closed trade whose executions are not imported. Enter a signed <strong>NET CAD result</strong>: negative for loss, positive for profit. This is not a new position.</p><form><div class="modal-grid">${field('TRADE DATE','date','date',now,{required:'required'})}${field('REALIZED NET CAD (+/-)','pnlCad','number','',{required:'required',step:.01})}<label class="span-2"><span>LABEL / SOURCE</span><input name="note" type="text" placeholder="e.g. historical AXP runner loss" maxlength="120" required></label></div>${formEnd('Record realized result')}</form>`;
 dialog('Record prior realized P/L','HISTORICAL ADJUSTMENT',body,(d)=>{const date=requireDate(getText(d,'date'),'trade date');validateSession(date);validateAsOf(date);const pnlCad=requireRange(getText(d,'pnlCad'),-1e9,1e9,'P/L'),note=getText(d,'note');if(!note)throw new Error('Label required.');state.adjustments.push({id:uid(),accountId:account().id,date,pnlCad,note});showToast(`Saved ${money(pnlCad)} in realized CAD P/L.`);return true;});
}
function addAccount(){const body=`<p class="modal-intro">Each portfolio gets its own rolling loss and open-risk allocation. Do not treat correlated accounts as diversification.</p><form><div class="modal-grid">${field('PORTFOLIO NAME','name','text','New swing account',{required:'required',maxlength:56})}${field('CURRENT EQUITY CAD','equity','number',20000,{required:'required',min:0,step:.01})}${field('RISK % / WINDOW','risk','number',3,{required:'required',min:0,max:100,step:.1})}${field('STRESS %','stress','number',70,{required:'required',min:0,max:100,step:1})}</div>${formEnd('Add account')}</form>`;
 dialog('New portfolio','INDEPENDENT ACCOUNT',body,(d)=>{const a=account(),name=getText(d,'name'),equity=requireRange(getText(d,'equity'),0,1e9,'Equity'),riskPct=requireRange(getText(d,'risk'),0,100,'Risk'),stressPct=requireRange(getText(d,'stress'),0,100,'Stress');if(!name)throw new Error('Name is required.');const id=uid();state.accounts.push({id,name,equityCad:equity,equityCheckpoints:[{id:uid(),date:onOrBeforeSession(today(),state.customClosed),createdAt:new Date().toISOString(),equityCad:equity,realizedPnlCad:0,source:'New portfolio opening equity'}],riskPct,stressPct,window:5,roundStep:25,mode:'stress',fx:a.fx,fxSource:a.fxSource,fxDate:a.fxDate,ideaCapCad:200,ideaCapMode:'fixed',brokerAccountId:'',buyFeePerContractUsd:ratePerContract(a,'BUY'),sellFeePerContractUsd:ratePerContract(a,'SELL')});activeAccountId=id;rememberAccount();showToast(`${name} created.`);return true;});
}
function saveSettings(e){e.preventDefault();const f=e.currentTarget,d=new FormData(f),a=account();try{
 const equityCad=requireRange(getText(d,'equityCad'),0,1e9,'Equity'),riskPct=requireRange(getText(d,'riskPct'),0,100,'Risk percentage'),window=Math.floor(requireRange(getText(d,'window'),1,30,'Window')),stressPct=requireRange(getText(d,'stressPct'),0,100,'Stress percentage'),fx=requireRange(getText(d,'fx'),.01,100,'FX');const step=requireRange(getText(d,'roundStep'),0,100,'Rounding');
 const name=getText(d,'name');if(!name)throw new Error('Account name is required.');const brokerAccountId=getText(d,'brokerAccountId').toUpperCase();if(brokerAccountId&&state.accounts.some(x=>x.id!==a.id&&x.brokerAccountId===brokerAccountId))throw new Error('That IBKR account number is already mapped to another portfolio.');const buyFeePerContractUsd=requireRange(getText(d,'buyFeePerContractUsd'),0,1000,'Estimated buy fee per contract'),sellFeePerContractUsd=requireRange(getText(d,'sellFeePerContractUsd'),0,1000,'Estimated sell fee per contract');const oldFx=a.fx;
 // A plain settings save must NOT bake today's realized P/L into equity a second time.
 const before=calculateAccount(state,a.id,today());
 const equityRebased=Math.abs(equityCad-before.currentEquityCad)>0.005;
 if(equityRebased){
   a.equityCheckpoints??=[];
   a.equityCheckpoints.push({id:uid(),date:before.asOf,createdAt:new Date().toISOString(),equityCad,realizedPnlCad:before.realizedAllTime,source:'Manual realized-equity reconciliation / deposit / withdrawal'});
   a.equityCad=equityCad;
   a.equityPnlAtCheckpointCad=before.realizedAllTime;
 }
 const capValue=optional(getText(d,'ideaCapCad')),ideaCapMode=getText(d,'ideaCapMode')==='pool'?'pool':'fixed';
 if(capValue!==null&&(!Number.isFinite(capValue)||capValue<0||capValue>1e9))throw new Error('Set a valid optional per-idea cap in CAD.');
 if(ideaCapMode==='fixed'&&!(capValue>0))throw new Error('Enter a positive per-idea cap, or choose Flexible rolling pool.');
 Object.assign(a,{name,brokerAccountId,riskPct,window,stressPct,fx,roundStep:step,mode:getText(d,'mode')==='strict'?'strict':'stress',ideaCapCad:capValue,ideaCapMode,buyFeePerContractUsd,sellFeePerContractUsd});
 if(fx!==oldFx){a.fxSource='Manually entered (broker rate if supplied)';a.fxDate='';}
 save();render();showToast(equityRebased?'Equity checkpoint saved. New realized P/L will now update account equity automatically.':'Portfolio rules recalculated; tracked equity preserved.');
 }catch(err){showToast(err.message);}
}
async function refreshFx(){const btn=document.querySelector('[data-action="refresh-fx"]');btn.disabled=true;btn.textContent='Checking reference rate...';
 try{let response=await fetch('/api/fx',{cache:'no-store'});if(!response.ok)throw new Error('Vercel rate endpoint not available');const data=await response.json();const value=Number(data.rate);if(!Number.isFinite(value)||value<=0)throw new Error('Invalid rate');const a=account();a.fx=value;a.fxSource=data.source+' (reference, not broker execution)';a.fxDate=data.date;save();render();showToast(`Bank of Canada daily average: ${value.toFixed(4)} CAD / USD.`);
 }catch(err){showToast('Rate unavailable. Enter your broker FX manually in Rules & data.');}finally{btn.disabled=false;btn.textContent='Get Bank of Canada rate';}
}
function download(name,data,mime='application/json'){const blob=new Blob([data],{type:mime});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function exportTrade(positionId){
 const p=findPosition(positionId);
 const handoff=buildSingleTradeHandoff(state,p.id);
 download(singleTradeExportFilename(handoff),JSON.stringify(handoff,null,2));
 showToast(`Exported ${p.ticker} only for GPT review. This is NOT a complete backup.`);
}
function exportBackup(){
 state.lastBackupAt=new Date().toISOString();state.lastBackupRevision=state.revision;
 const backup=backupSnapshot(state);
 download(`swing-risk-desk-COMPLETE-${today()}.json`,JSON.stringify(backup,null,2));
 writeLocalWithoutRevision();
 showToast('Complete backup / ChatGPT handoff download started. Save the file to Google Drive.');
}
function csvEsc(value){const s=String(value??'');return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s;}
const CSV_COLUMNS=['account_id','position_id','external_id','idea_id','ticker','option_type','strike','expiry','sector','action','date','time','contracts','price_usd','fee_usd','fx_usdcad','stress_pct','underlying_invalidation','stop_premium_usd','notes','transaction_id','broker_pnl_cad','planned_loss_pct'];
function exportCsv(template=false){const rows=[CSV_COLUMNS];if(!template){for(const p of state.positions){const tx=[...p.fills.map(x=>({...x,action:'BUY'})),...p.exits.map(x=>({...x,action:'SELL'}))];for(const t of tx)rows.push([p.accountId,p.id,p.externalId||'',p.ideaId,p.ticker,p.optionType,p.strike,p.expiry,p.sector||'',t.action,t.date,t.time||'',t.qty,t.price??'',t.fee||0,t.fx||'',p.stressPct??'',p.underlyingInvalidation||'',p.stopPremiumUsd??'',p.notes||'',t.id,t.brokerPnlCad??'',p.plannedLossPct??'']);}}
 download(template?'swing-risk-import-template.csv':`swing-risk-transactions-${today()}.csv`,rows.map(r=>r.map(csvEsc).join(',')).join('\r\n'),'text/csv;charset=utf-8');showToast(template?'CSV import template downloaded.':'Transactions CSV downloaded.');}
function parseCSV(content){const rows=[],row=[];let cell='',quote=false;const str=content.replace(/^\uFEFF/,'');for(let i=0;i<str.length;i++){const c=str[i];if(quote){if(c==='"'&&str[i+1]==='"'){cell+='"';i++;}else if(c==='"'){quote=false;}else cell+=c;}else{if(c==='"'){quote=true;}else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));if(row.some(v=>v.trim()))rows.push([...row]);row.length=0;cell='';}else cell+=c;}}if(quote)throw new Error('Unclosed quote in CSV file.');row.push(cell.replace(/\r$/,''));if(row.some(v=>v.trim()))rows.push(row);return rows;}
function mergeCSV(textData){const csv=parseCSV(textData);if(csv.length<2)throw new Error('CSV has no transactions.');const cols=csv[0].map(x=>x.trim().toLowerCase());for(const col of ['ticker','action','date','contracts','price_usd'])if(!cols.includes(col))throw new Error(`CSV missing ${col} column.`);
 const clone=structuredClone(state);let added=0,skipped=0;for(const raw of csv.slice(1)){const r=Object.fromEntries(cols.map((x,i)=>[x,raw[i]??'']));const accountId=r.account_id||activeAccountId;const a=clone.accounts.find(x=>x.id===accountId||x.name===accountId);if(!a)throw new Error(`Unknown account '${accountId}'. Create it first.`);
 const ticker=(r.ticker||'').toUpperCase().trim();const action=(r.action||'').toUpperCase().trim();if(!['BUY','SELL'].includes(action)||!ticker)throw new Error('Every row needs a ticker and BUY or SELL.');
 requireDate(r.date,'CSV execution date');if(!isSession(r.date,clone.customClosed||[]))throw new Error(`${r.date} is not a session.`);
 const qty=Math.floor(requireRange(r.contracts,1,99999,'CSV contracts'));const price=r.price_usd===''&&r.broker_pnl_cad!==''?null:requireRange(r.price_usd,0,100000,'CSV price');const fee=requireRange(r.fee_usd||'0',0,1e5,'CSV fees'),fx=requireRange(r.fx_usdcad||String(a.fx),.01,100,'CSV FX');
 let p=clone.positions.find(x=>(r.position_id&&x.id===r.position_id)||(r.external_id&&x.externalId===r.external_id));
 if(!p){if(action==='SELL')throw new Error(`No existing purchase found for ${ticker} SELL. Import the BUY rows first.`);if(!r.expiry||!r.strike)throw new Error(`New ${ticker} positions need expiry and strike.`);p={id:r.position_id||uid(),accountId:a.id,externalId:r.external_id||'',source:'Imported CSV journal',ideaId:r.idea_id||`${ticker}-${r.date}`,ticker,optionType:r.option_type||'Call',strike:num(r.strike),expiry:r.expiry,sector:r.sector||'',stressPct:optional(r.stress_pct),underlyingInvalidation:r.underlying_invalidation||'',stopPremiumUsd:optional(r.stop_premium_usd),plannedLossPct:r.planned_loss_pct===undefined||r.planned_loss_pct===''?null:requireRange(r.planned_loss_pct,0,100,'CSV planned loss %'),fixedReserveCad:null,notes:r.notes||'',fills:[],exits:[]};clone.positions.push(p);}
 if(p.accountId!==a.id||p.ticker!==ticker)throw new Error(`Conflicting account/ticker for ${ticker}.`);
 const list=action==='BUY'?p.fills:p.exits;
 const id=r.transaction_id||`journal-${[p.id,action,r.date,r.time||'',qty,price??'',fee,fx].join('-')}`;
 if([...p.fills,...p.exits].some(t=>t.id===id)){skipped++;continue;}
 const tx={id,date:r.date,time:r.time|| (action==='BUY'?'00:00':'23:59'),qty,price,fee,fx};if(action==='SELL'){tx.brokerPnlCad=optional(r.broker_pnl_cad);const avail=calculatePosition(p,a,r.date).qty;if(qty>avail)throw new Error(`CSV oversells ${ticker}: ${qty} vs ${avail}.`);}
 list.push(tx);added++;
 }
 for(const pos of clone.positions){const a=clone.accounts.find(x=>x.id===pos.accountId);if(calculatePosition(pos,a,'9999-12-31').issues.length)throw new Error(`Imported ${pos.ticker} has an exit before the contracts were owned.`);}
 state=normalize(clone);save();render();showToast(`Imported ${added} transactions; skipped ${skipped} duplicate IDs.`);
}
function importPreviewReport(report){
 if(report.fileType==='ibkr')return `<div class="import-kpis"><div><strong>${report.added}</strong><span>New executions</span></div><div><strong>${report.duplicates}</strong><span>Already logged</span></div><div><strong>${report.sourceLinked}</strong><span>Existing fills linked</span></div><div><strong>${report.pending}</strong><span>Needs review</span></div></div><p class="help-line">${report.updatedPositions??0} existing position(s) updated with new executions; ${report.newPositions} truly new position(s); ${report.newAccounts} new broker portfolio(s). Exact re-imports are not duplicated. IBKR doesn't supply your trading rationale, TP targets, underlying invalidation or exact CAD FX. Fill those in separately.</p>`+
 (report.issueList.length?`<details class="issue-details"><summary>Review ${report.issueList.length} import issue(s)</summary>${report.issueList.slice(0,24).map(x=>`<p>${esc(x)}</p>`).join('')}</details>`:'')+
 (report.ambiguous?'<p class="neg">Warning: identical broker rows have no execution ID; indistinguishable fills require manual verification.</p>':'');
 return `<div class="import-kpis"><div><strong>${report.newPositions}</strong><span>New positions</span></div><div><strong>${report.newTransactions}</strong><span>New fills/exits</span></div><div><strong>${report.newNotes}</strong><span>New journal notes</span></div><div><strong>${report.conflicts}</strong><span>Conflicts preserved</span></div></div><p class="help-line">${report.duplicates} already logged item(s), ${report.planChanges} new plan field(s), ${report.importInbox} pending broker row(s). Existing nonempty plans and account settings are not silently overwritten during a merge; alternatives go to the conflict timeline.</p>`;
}
function previewIBKR(raw,filename){
 const parsed=parseIbkrTrades(raw);
 const brokerAccounts=[...new Set(parsed.trades.map(t=>t.account))];
 const unmapped=brokerAccounts.filter(id=>!state.accounts.some(a=>a.brokerAccountId===id));
 const available=state.accounts.filter(a=>!a.brokerAccountId);
 const mappingFields=brokerAccounts.map((brokerId)=>{
  const linked=state.accounts.find(a=>a.brokerAccountId===brokerId);
  if(linked)return `<div class="import-account-linked"><strong>IBKR ${esc(brokerId)}</strong><span>→ ${esc(linked.name)} (already linked)</span></div>`;
  const i=unmapped.indexOf(brokerId);
  const opts=[['',`Choose a portfolio…`],['__new__',`Create a separate IBKR portfolio (equity starts at $0)`],...available.map(a=>[a.id,`${a.name} (existing portfolio)`])];
  return `<label class="import-choice"><span>IBKR ACCOUNT ${esc(brokerId)}: IMPORT INTO</span><select required name="broker-map-${i}">${opts.map(([v,n])=>`<option value="${esc(v)}">${esc(n)}</option>`).join('')}</select></label>`;
 }).join('');
 function selectMap(form){const mapping={};unmapped.forEach((brokerId,i)=>{const value=form?.elements.namedItem(`broker-map-${i}`)?.value||'';if(!value)throw new Error(`Choose a portfolio for IBKR account ${brokerId}.`);if(value!=='__new__'){if(Object.values(mapping).includes(value))throw new Error('One app portfolio cannot be mapped to two IBKR accounts.');mapping[brokerId]=value;}});return mapping;}
 let result=importIbkrTrades(state,raw,{filename,includeSameDayExpiry:false,accountMap:{}});
 const body=`<p class="modal-intro">Recognized <strong>${esc(filename)}</strong> as an IBKR trade export. Check the destination portfolio for every broker account. Purchases for a uniquely matching open contract are added to its existing position, not a second position. Broker times are ET only if configured as such in the export.</p><form>
 ${mappingFields?`<div class="import-mappings"><strong>Choose or verify the destination portfolio</strong><p class="help-line">Existing mappings are shown below. For a new broker account you must choose an existing portfolio or deliberately create a separate one. Multiple active ideas in the same contract go to review rather than being guessed.</p>${mappingFields}</div>`:''}
 <label class="import-choice import-toggle"><input type="checkbox" name="includeSameDayExpiry"><span>Include NEW same-day-expiry / 0DTE buys in this <strong>swing</strong> risk budget (off by default)</span></label><div id="ibkrPreviewBody">${importPreviewReport(result.report)}</div>${formEnd('Apply safe reconciliation')}</form>`;
 const f=dialog('Reconcile IBKR executions','BROKER IMPORT / NO HINDSIGHT',body,()=>{
  // Never apply the baseline preview until the user explicitly chooses each new account destination.
  const mapping=selectMap(f);
  result=importIbkrTrades(state,raw,{filename,includeSameDayExpiry:!!f.elements.namedItem('includeSameDayExpiry')?.checked,accountMap:mapping});
  state=result.next;showToast(`IBKR: ${result.report.added} new, ${result.report.duplicates} duplicates, ${result.report.pending} pending.`);return true;
 });
 const refresh=()=>{try{
   if(unmapped.some((brokerId,i)=>!f.elements.namedItem(`broker-map-${i}`)?.value)){
     $('ibkrPreviewBody').innerHTML='<div class="modal-summary">Choose the destination portfolio above to preview which existing positions and new fills will be updated.</div>';return;
   }
   result=importIbkrTrades(state,raw,{filename,includeSameDayExpiry:!!f.elements.namedItem('includeSameDayExpiry')?.checked,accountMap:selectMap(f)});
   $('ibkrPreviewBody').innerHTML=importPreviewReport(result.report);
   const error=f.querySelector('.modal-error');if(error)error.textContent='';
  }catch(e){const error=f.querySelector('.modal-error');if(error)error.textContent=e.message;}};
 f.querySelectorAll('select[name^="broker-map-"], input[name="includeSameDayExpiry"]').forEach(el=>el.addEventListener('change',refresh));
 refresh();
}
function previewJSON(data,filename){
 if(data?.schema===TRADE_HANDOFF_SCHEMA)throw new Error('This is a one-position GPT review export, not a complete app backup. Use the COMPLETE JSON backup to restore or merge your account records.');
 let result,mode='merge';
 const journal=data.schema==='swing-risk-desk-journal-v1';
 if(journal)result=mergeFullBackup(state,data,{fallbackAccountId:activeAccountId,journalOnly:true});
 else if(['swing-risk-desk-v1','swing-risk-desk-v2'].includes(data.schema))result=mergeFullBackup(state,data,{fallbackAccountId:activeAccountId});
 else throw new Error('Unsupported JSON format. Import a complete Swing Risk Desk backup or swing-risk-desk-journal-v1.');
 const empty=state.positions.length===0&&state.adjustments.length===0&&state.brokerInbox.length===0;
 const option=journal?'':`<label class="import-choice"><span>IMPORT MODE</span><select name="mode"><option value="merge" ${empty?'':'selected'}>Safely merge (keep current account rules)</option><option value="replace" ${empty?'selected':''}>Full restore (replace this browser's records and settings)</option></select></label>`;
 const body=`<p class="modal-intro">${journal?'Journal handoff':'Complete backup'}: <strong>${esc(filename)}</strong>. Safe merge deduplicates matching transactions and dated notes. <strong>Full restore replaces this browser's data</strong>; it is for recovering a known complete snapshot.</p>${importPreviewReport(result.report)}<form>${option}<div class="modal-summary">Nothing is sent to the server. This import does not modify the canonical DK master. Saving another backup afterward lets you hand new journal notes back to ChatGPT.</div>${formEnd(journal?'Merge journal update':'Import selected mode')}</form>`;
 dialog('Preview your data import','SAFE RECONCILIATION',body,d=>{
  mode=journal?'merge':getText(d,'mode');
  if(mode==='replace'){
    if(!confirm('FULL RESTORE replaces every account, position, note, and settings value currently in this browser. A safety backup of your current state will download first. Continue?'))return false;
    download(`swing-risk-desk-PRE-RESTORE-${today()}.json`,JSON.stringify(backupSnapshot(state),null,2));
    state=normalize(data);activeAccountId=preferredAccountId();rememberAccount();
  }else state=result.next;
  showToast(mode==='replace'?'Full backup restored. Save the recovery file securely.':`Merged ${result.report.newTransactions} trades and ${result.report.newNotes} notes.`);return true;
 });
}
async function importFile(file){
 if(!file)return;const raw=await file.text();if(raw.length>20e6)throw new Error('Maximum import size is 20MB.');
 if(file.name.toLowerCase().endsWith('.csv')){
  if(isIbkrCsv(raw))return previewIBKR(raw,file.name);
  return mergeCSV(raw);
 }
 const data=JSON.parse(raw);return previewJSON(data,file.name);
}
function mergePositions(id){
 const target=findPosition(id),m=analytics();
 if(m.asOf!==onOrBeforeSession(today(),state.customClosed||[]))return showToast('Return to Today before merging positions.');
 const candidates=openContractMatches(target,m.positions,m.account.id).filter(x=>x.position.id!==id);
 if(!candidates.length)return showToast('No matching open positions to merge.');
 const body=`<p class="modal-intro">Keep <strong>${esc(target.ticker)} · ${esc(target.ideaId||target.id)}</strong> as the primary position. Only merge records of the same continuous trade. Its plan stays active; source plans, notes and all executions stay in the audit trail.</p><form><div class="modal-grid">${candidates.map(x=>`<label class="span-2"><span><input type="checkbox" name="sourceId" value="${esc(x.position.id)}" checked style="width:auto;min-height:0"> ${esc(x.position.ideaId||x.position.id)} · ${x.metrics.qty} open · avg ${x.metrics.averageEntryUsd===null?'—':usdWithCad(x.metrics.averageEntryUsd,m.account.fx)} · reserve ${cad(x.metrics.reserveCad)}</span></label>`).join('')}</div><div id="mergePreview" class="modal-summary"></div><label style="display:block;margin:12px 0"><input type="checkbox" name="confirmed" required style="width:auto;min-height:0"> These are the same continuous trade. I accept the previewed recalculation of risk and cost basis.</label>${formEnd('Merge selected positions')}</form>`;
 const f=dialog('Merge matching open positions','LEDGER CORRECTION',body);
 const preview=()=>{
  try{
   const d=new FormData(f),plan=planOpenPositionMerge(state,m.account.id,id,d.getAll('sourceId'),asOf()),z=plan.metrics;
   $('mergePreview').innerHTML=`<strong>${plan.sourceCount} positions → 1 · ${z.qty} open · avg ${z.averageEntryUsd===null?'—':usdWithCad(z.averageEntryUsd,m.account.fx)}</strong><span>Entry cost ${usd(z.totalEntryDebitUsd)} · open reserve ${cad(plan.oldReserveCad)} → ${cad(z.reserveCad)} · stress ${z.stressPct}% · rolling losses ${cad(plan.before.realizedLossCad)} → ${cad(plan.after.realizedLossCad)} · available ${cad(plan.before.availableCad)} → ${cad(plan.after.availableCad)} · account realized P/L ${cad(plan.before.realizedAllTime)} → ${cad(plan.after.realizedAllTime)}. ${plan.recalculatedExits?plan.recalculatedExits+' existing exit basis/P&L calculation(s) change; verified broker P&L overrides remain intact.':'Existing exit basis/P&L unchanged.'}</span>`;
   f.querySelector('[type="submit"]').disabled=false;return plan;
  }catch(err){$('mergePreview').textContent=err.message;f.querySelector('[type="submit"]').disabled=true;return null;}
 };
 f.addEventListener('change',preview);
 f.addEventListener('submit',e=>{e.preventDefault();try{
  if(account().id!==m.account.id||analytics().asOf!==onOrBeforeSession(today(),state.customClosed||[]))throw Error('Portfolio or date changed; reopen merge.');
  const plan=preview();if(!plan||!new FormData(f).has('confirmed'))return;
  if(!confirm(`Merge ${plan.sourceCount} open records into one? Available risk changes from ${cad(plan.before.availableCad)} to ${cad(plan.after.availableCad)}. ${plan.recalculatedExits?plan.recalculatedExits+' exit calculation(s) change. ':''}A pre-merge backup will download first. Source records cannot be restored individually without double counting.`))return;
  download(`swing-risk-desk-BEFORE-POSITION-MERGE-${today()}.json`,JSON.stringify(backupSnapshot(state),null,2));
  const previous=state;state=plan.next;
  if(!save()){state=previous;render();throw Error('Could not save merged ledger; original records retained.');}
  $('editorDialog').close();render();showToast(`Merged ${plan.sourceCount} records into one position. Pre-merge backup initiated.`);
 }catch(err){showToast(err.message);const error=f.querySelector('.modal-error');if(error)error.textContent=err.message;}});
 preview();
}
function archiveRecord(kind,label,record,positionId=''){
 state.archive??=[];
 state.archive.push({id:uid(),kind,label,positionId,date:new Date().toISOString(),record:structuredClone(record)});
}
function restoreArchive(id){const item=(state.archive||[]).find(x=>x.id===id);if(!item)return showToast('Archived item was not found.');if(item.restoredAt)return showToast('This record was already restored.');if(item.kind==='position-merge'||item.mergedIntoPositionId)return showToast('Merged originals are retained for audit. Restoring one would duplicate fills; use the pre-merge backup or reconcile manually.');const snapshot=structuredClone(state);
 try{
  if(item.kind==='journal-entry'||item.kind==='plan-revision'){
    const p=state.positions.find(x=>x.id===item.positionId);if(!p)throw new Error('Restore the parent position first.');
    const collection=item.kind==='journal-entry'?'journalEntries':'planHistory';
    if(!p[collection].some(x=>x.id===item.record.id))p[collection].push(structuredClone(item.record));
    // The historical archive event is retained with a restoration marker, so a later
    // backup/cloud merge cannot revive the stale deletion and hide the restored note.
    item.restoredAt=new Date().toISOString();
    save();render();showToast('Timeline entry restored. Earlier archive action remains in backup.');return;
  }
  if(item.kind==='position'){
    if(state.positions.some(x=>x.id===item.record.id))throw new Error('Position ID already active; review duplicate before restoring.');
    state.positions.push(structuredClone(item.record));
  }else if(item.kind==='transaction'){
    const p=state.positions.find(x=>x.id===item.positionId);if(!p)throw new Error('Restore the original position first.');
    const key=item.record.side==='SELL'?'exits':'fills';
    if([...p.fills,...p.exits].some(x=>x.id===item.record.tx.id))throw new Error('Transaction already active.');
    p[key].push(structuredClone(item.record.tx));
  }else if(item.kind==='adjustment')state.adjustments.push(structuredClone(item.record));
  for(const p of state.positions){const a=state.accounts.find(x=>x.id===p.accountId);if(calculatePosition(p,a,'9999-12-31').issues.length)throw new Error(`Restoring ${p.ticker} would cause an impossible execution sequence.`);}
  item.restoredAt=new Date().toISOString();save();render();showToast('Archived record restored. Restoration kept in cloud history.');
 }catch(err){state=snapshot;showToast(err.message);}
}
function deleteTransaction(posId,txId,side){const p=findPosition(posId);const key=side==='BUY'?'fills':'exits';const tx=p[key].find(t=>t.id===txId);if(!tx)return showToast('Transaction not found.');
 if(!confirm(`Remove ${side} ${tx.qty} ${p.ticker} on ${tx.date}? This recalculates risk and P/L. The execution will be archived and can be restored from Rules & data or backup.`))return;
 const clone=structuredClone(p);clone[key]=clone[key].filter(x=>x.id!==txId);const probe=calculatePosition(clone,account(),'9999-12-31');if(probe.issues.length){showToast('Removal would leave a sale without enough acquired contracts. Remove the dependent exits first.');return;}
 archiveRecord('transaction',`${p.ticker} ${side} ${tx.date}`,{side,tx},p.id);p[key]=p[key].filter(x=>x.id!==txId);save();render();showToast('Transaction archived. It remains in backup/recovery.');
}
function archiveTimeline(positionId,kind,eventId){
 const p=findPosition(positionId),field=kind==='journal-entry'?'journalEntries':kind==='plan-revision'?'planHistory':null;
 if(!field)throw new Error('Unknown timeline record type.');
 const event=(p[field]||[]).find(x=>x.id===eventId);
 if(!event)throw new Error('Timeline record was not found.');
 if(!confirm(`Remove this ${kind==='journal-entry'?'journal note':'plan revision'} from the visible timeline? It will stay in Archived corrections and the full JSON backup, and can be restored. Current plan values and trade P/L will NOT change.`))return;
 archiveRecord(kind,`${p.ticker}: ${kind==='journal-entry'?(event.kind||'Journal note'):'Plan revision'} · ${event.date||''}`,event,p.id);
 p[field]=p[field].filter(x=>x.id!==eventId);
 save();render();showToast('Timeline entry archived. Restore via Rules & data → Archived corrections.');
}
function runAction(action,el){try{const id=el.dataset.id;switch(action){
 case 'add-position':addPosition();break;
 case 'close-position':closePosition(id);break;
 case 'edit-position':editPosition(id);break;
 case 'analyze-position':openPositionAnalysis(id);break;
 case 'edit-planned-loss':editPlannedLoss(id);break;
 case 'add-note':addNote(id);break;
 case 'archive-timeline':archiveTimeline(id,el.dataset.eventType,el.dataset.eventId);break;
 case 'edit-exit':editExit(id,el.dataset.tx);break;
 case 'view-position':openPositionDetail(id);break;
 case 'add-fill':addFill(id);break;
 case 'merge-positions':mergePositions(id);break;
 case 'refresh-position-quote':void refreshPositionQuote(id);break;
 case 'close-recorded-idea':$('editorDialog').close();dropPlannerIdea(el.dataset.planId);break;
 case 'manual-pnl':manualPnl();break;
 case 'add-account':addAccount();break;
 case 'close-dialog':$('editorDialog').close();break;
 case 'today':asOfOverride=null;render();break;
 case 'plan-to-position':beginPlannedPosition(el.dataset.planId);break;
 case 'add-plan-idea':{const ideas=plannerIdeas();if(ideas.length>=MAX_PLAN_IDEAS){showToast(`Maximum ${MAX_PLAN_IDEAS} draft ideas.`);break;}const idea=defaultPlanIdea(uid(),account().stressPct,false);ideas.push(idea);expandedPlanId=idea.id;selectedPreviewId=null;quoteRefreshToken++;persistPlannerDrafts();renderPlanner(analytics());[...document.querySelectorAll('.draft-idea')].find(x=>x.dataset.draftId===idea.id)?.querySelector('[name="ticker"]')?.focus();break;}
 case 'remove-plan-idea':dropPlannerIdea(el.dataset.planId);break;
 case 'focus-cap-policy':{const select=$('plannerCapMode');select?.scrollIntoView?.({block:'center',behavior:'smooth'});select?.focus?.();break;}
 case 'open-cap-settings':{switchTab('settings');$('settingsForm')?.elements?.namedItem?.('ideaCapCad')?.focus?.();break;}
 case 'jump-to-cap-idea':{
  expandedPlanId=el.dataset.planId;
  if(selectedPreviewId&&selectedPreviewId!==expandedPlanId){selectedPreviewId=null;quoteRefreshToken++;}
  renderPlanner(analytics());
  [...document.querySelectorAll('.draft-idea')].find(x=>x.dataset.draftId===expandedPlanId)?.scrollIntoView?.({block:'center',behavior:'smooth'});
  break;
 }
 case 'copy-planner-idea':copySinglePlannerIdea(el.dataset.planId);break;
  case 'toggle-plan-details':{expandedPlanId=expandedPlanId===el.dataset.planId?null:el.dataset.planId;if(expandedPlanId&&selectedPreviewId&&expandedPlanId!==selectedPreviewId){selectedPreviewId=null;quoteRefreshToken++;}renderPlanner(analytics());if(expandedPlanId){const idea=plannerIdeas().find(i=>i.id===expandedPlanId);if(idea)queueListedExpirations(idea,true);}break;}
  case 'collapse-plan-ideas':expandedPlanId=null;renderPlanner(analytics());break;
 case 'refresh-listed-expirations':{const idea=plannerIdeas().find(x=>x.id===el.dataset.planId);el.blur();if(idea)void ensureListedExpirations(idea,true);break;}
 case 'enter-manual-expiry':{manualExpiryIds.add(el.dataset.planId);el.blur();const idea=plannerIdeas().find(x=>x.id===el.dataset.planId);if(idea){updateListingCard(idea);const card=[...document.querySelectorAll('[data-draft-id]')].find(x=>x.dataset.draftId===el.dataset.planId);card?.querySelector('input[type="date"][name="expiry"]')?.focus();}break;}
 case 'use-listed-expirations':{manualExpiryIds.delete(el.dataset.planId);el.blur();const idea=plannerIdeas().find(x=>x.id===el.dataset.planId);if(idea){updateListingCard(idea);const card=[...document.querySelectorAll('[data-draft-id]')].find(x=>x.dataset.draftId===el.dataset.planId);card?.querySelector('[name="listedExpiry"]')?.focus();}break;}
 case 'clear-plan-ideas':{if(!confirm('Clear all saved Quick size check ideas for this portfolio? Recorded positions will not be affected.'))break;expandedPlanId=null;selectedPreviewId=null;quoteRefreshToken++;plannerDrafts[account().id]=[defaultPlanIdea(uid(),account().stressPct,false)];persistPlannerDrafts();renderPlanner(analytics());showToast('Saved size-check ideas cleared for this portfolio.');break;}
 case 'analyze-idea':{const opening=selectedPreviewId!==el.dataset.planId||optionPanelMode!=='analyze';optionPanelMode='analyze';chainFetchToken++;selectedPreviewId=opening?el.dataset.planId:null;if(opening)adoptTickerLevels(currentPreviewIdea());expandedPlanId=null;quoteRefreshToken++;quoteRefreshMessage='';quoteConnectionState='unknown';renderPlanner(analytics());if(opening)$('optionPreview')?.scrollIntoView({block:'start',behavior:'smooth'});if(opening){void ensureAtmRange(currentPreviewIdea());void refreshOptionQuote();}break;}
 case 'view-option-chain':{
  const opening=selectedPreviewId!==el.dataset.planId||optionPanelMode!=='chain';
  selectedPreviewId=opening?el.dataset.planId:null;
  optionPanelMode='chain';if(opening)optionChainRange='nearby';expandedPlanId=null;quoteRefreshToken++;
  const idea=currentPreviewIdea();if(idea)chainSide=idea.optionType==='Call'?'Call':'Put';
  renderPlanner(analytics());
  if(opening){$('optionPreview')?.scrollIntoView({block:'start',behavior:'smooth'});void ensureAtmRange(idea);void refreshOptionChain();}
  break;
 }
 case 'open-chain-analyze':{
  if(!currentPreviewIdea())break;
  chainFetchToken++;optionPanelMode='analyze';quoteRefreshMessage='';quoteConnectionState='unknown';
  renderPlanner(analytics());void ensureAtmRange(currentPreviewIdea());void refreshOptionQuote();break;
 }
 case 'refresh-option-chain':void ensureAtmRange(currentPreviewIdea(),true);void refreshOptionChain(true);break;
 case 'toggle-chain-range':{
  optionChainRange=optionChainRange==='all'?'nearby':'all';
  renderChainPreview();void refreshOptionChain();break;
 }
 case 'chain-show-side':chainSide=el.dataset.side==='Call'?'Call':'Put';renderChainPreview();break;
 case 'pick-chain-contract':pickChainContract(el);break;
 case 'close-option-preview':selectedPreviewId=null;chainFetchToken++;quoteRefreshToken++;renderPlanner(analytics());break;
 case 'preview-add-target':{const idea=currentPreviewIdea();if(!idea)break;const p=ensurePreview(idea);if(p.targets.length>=MAX_PREVIEW_TARGETS)break;const n=p.targets.filter(t=>t.name.startsWith('TP')).length+1;p.targets.push({id:uid(),name:`TP${n}`,price:''});publishTickerLevels(idea);persistPlannerDrafts();renderOptionPreview();break;}
 case 'preview-remove-target':{const idea=currentPreviewIdea(),p=ensurePreview(idea);if(!p)break;p.targets=p.targets.filter(t=>t.id!==el.dataset.targetId);publishTickerLevels(idea);persistPlannerDrafts();renderOptionPreview();break;}
 case 'preview-add-date':{const idea=currentPreviewIdea(),p=ensurePreview(idea);if(!p||p.dates.length>=MAX_PREVIEW_DATES)break;const shown=visibleTickerDates(idea).visible;let d=nextSession(shown.at(-1)?.date||today(),state.customClosed||[]);if(parseDay(idea.expiry)&&d>idea.expiry){showToast('This exit date would be after the selected option expires.');break;}if(p.dates.includes(d)){showToast('This exit date is already in the shared ticker plan.');break;}p.dates.push(d);p.dates.sort();publishTickerLevels(idea);persistPlannerDrafts();renderOptionPreview();break;}
 case 'preview-remove-date':{const idea=currentPreviewIdea(),p=ensurePreview(idea);if(!p||p.dates.length<=1)break;p.dates.splice(Number(el.dataset.dateIndex),1);publishTickerLevels(idea);persistPlannerDrafts();renderOptionPreview();break;}
 case 'toggle-ticker-link':{
  const idea=currentPreviewIdea(),p=ensurePreview(idea);if(!p)break;
  if(p.tickerLinked!==false){p.tickerLinked=false;p.tickerLinkEstablished=false;persistPlannerDrafts();renderOptionPreview();break;}
  if(!isUneditedTickerScenario(p,today(),state.customClosed||[])&&!confirm('Use the shared '+normalizeTicker(idea.ticker)+' '+idea.optionType.toLowerCase()+' plan? This replaces this idea’s own underlying Stop/TP levels and exit dates. Premium and IV stay separate.'))break;
  const linked=adoptTickerLevels(idea,true);if(linked.reason==='solo')publishTickerLevels(idea);
  persistPlannerDrafts();renderOptionPreview();break;
 }
 case 'refresh-option-quote':void refreshOptionQuote();break;
 case 'enter-manual-iv':{const panel=$('optionPreview');const details=panel?.querySelector('.preview-manual');if(details)details.open=true;panel?.querySelector('input[name="ivPct"]')?.focus();break;}
 case 'reset-draft-fee':{const idea=plannerIdeas().find(x=>x.id===el.dataset.planId);if(idea){idea.feeManual=false;idea.fee=estimateOrderFee(account(),'BUY',idea.qty).toFixed(2);persistPlannerDrafts();renderPlanner(analytics());}break;}
 case 'export-trade':exportTrade(id);break;
 case 'export-backup':exportBackup();break;
 case 'export-csv':exportCsv();break;
 case 'template-csv':exportCsv(true);break;
 case 'import-open':$('importFile').click();break;
 case 'import-ibkr':$('ibkrFile').click();break;
 case 'refresh-fx':refreshFx();break;
 case 'reset-data':if(confirm('Reset every locally stored account, position, note and transaction? A full safety backup will download first. Proceed ONLY after saving that file securely.')){download(`swing-risk-desk-BEFORE-RESET-${today()}.json`,JSON.stringify(backupSnapshot(state),null,2));state=seed();activeAccountId='bdi';asOfOverride=null;plannerDrafts=Object.create(null);clearPlannerDraftStorage(globalThis.localStorage,globalThis.sessionStorage);plannerDraftSavedAt='';plannerStorageHealthy=true;try{globalThis.localStorage.removeItem(LAST_ACCOUNT_KEY);}catch{}save();render();showToast('Local data reset. Safety backup download was initiated.');}break;
 case 'delete-account':{const a=account();if(state.accounts.length<=1){showToast('At least one account must remain.');break;}if(state.positions.some(p=>p.accountId===a.id)||state.adjustments.some(x=>x.accountId===a.id)){showToast('This account contains records. Export and remove its records first.');break;}if(confirm(`Delete empty account ${a.name}?`)){state.accounts=state.accounts.filter(x=>x.id!==a.id);delete plannerDrafts[a.id];persistPlannerDrafts();activeAccountId=state.accounts[0].id;rememberAccount();save();render();}break;}
 case 'delete-position':{const p=findPosition(id);if(confirm(`Archive ${p.ticker} and all its executions? They will leave active calculations but remain in your full backup and can be restored.`)){archiveRecord('position',p.ticker,p);state.positions=state.positions.filter(x=>x.id!==id);save();render();showToast('Position archived; restorable in Rules & data.');}break;}
 case 'delete-tx':deleteTransaction(id,el.dataset.tx,el.dataset.side);break;
 case 'restore-archive':restoreArchive(id);break;
 case 'delete-adjustment':{const item=state.adjustments.find(a=>a.id===id);if(item&&confirm(`Remove logged ${money(item.pnlCad)} ${item.note}?`)){archiveRecord('adjustment',item.note,item);state.adjustments=state.adjustments.filter(x=>x.id!==id);save();render();}break;}
 case 'see-transactions':{const details=document.getElementById(`detail-${id}`);if(details){details.open=!details.open;details.scrollIntoView({block:'nearest',behavior:'smooth'});}break;}
 case 'remove-closed-day':{const date=el.dataset.date;state.customClosed=state.customClosed.filter(x=>x!==date);save();render();showToast('Custom holiday removed.');break;}
 default:break;
 }}catch(err){console.error(err);showToast(err.message||'Unexpected error.');}}

document.addEventListener('click',e=>{const tab=e.target.closest('[data-tab]');if(tab){switchTab(tab.dataset.tab);return;}const filter=e.target.closest('[data-filter]');if(filter){positionFilter=filter.dataset.filter;renderPositions(analytics());return;}const action=e.target.closest('[data-action]');if(action){runAction(action.dataset.action,action);}});
$('editorDialog').addEventListener('click',e=>{if(e.target===$('editorDialog'))$('editorDialog').close();});
initPositionAnalysis();
$('accountSelect').addEventListener('change',e=>{activeAccountId=e.target.value;selectedPreviewId=null;expandedPlanId=null;quoteRefreshToken++;quoteRefreshBusy=false;tickerInputOrigins.clear();rememberAccount();render();});
$('asOfDate').addEventListener('change',e=>{const d=e.target.value;if(parseDay(d)){asOfOverride=d;render();}else showToast('Enter a valid date.');});
// Browser tabs share the latest sizing ideas. A change in another tab is not a trade.
if(typeof globalThis.addEventListener==='function')globalThis.addEventListener('storage',event=>{
 if(event.key!==PLANNER_LOCAL_KEY)return;
 const current=loadPlannerDrafts(globalThis.localStorage);
 plannerDrafts=current.drafts;plannerDraftSavedAt=current.savedAt;plannerStorageHealthy=current.persisted;
 if(activeTab==='dashboard')renderPlanner(analytics());
});
$('optionPreview').addEventListener('input',e=>{
 const idea=currentPreviewIdea();if(!idea)return;
 const p=ensurePreview(idea),name=e.target.name;
 if(['spot','ivPct','bid','ask'].includes(name)){
  p[name]=e.target.value;
  if(name==='ivPct'){p.ivManual=Number(p.ivPct)>0;const notice=$('optionPreview')?.querySelector('.preview-iv-help');if(notice)notice.hidden=Boolean(p.ivManual);}
  if(['spot','ivPct','bid','ask'].includes(name)){
   p.quoteSource='Manual override';p.quoteAt='';quoteRefreshMessage='';
   const cell=document.querySelector(`[data-market-key="${name}"] strong`),amount=Number(p[name]);
   if(cell)cell.textContent=String(p[name]||'').trim()&&Number.isFinite(amount)&&amount>0?(name==='ivPct'?`${amount.toFixed(1)}%`:`USD ${amount.toFixed(2)}`):'----';
   const src=document.querySelector('[data-preview-quote-source]'),at=document.querySelector('[data-preview-quote-at]');
   if(src)src.textContent='Manual override';if(at)at.textContent='Not yet refreshed';
  }
 }else if(name==='target-price'){
  const t=p.targets.find(t=>t.id===e.target.closest('[data-target-id]')?.dataset.targetId);if(!t)return;t.price=e.target.value;publishTickerLevels(idea);
 }else if(name==='exit-date'){
  const index=Number(e.target.dataset.dateIndex);if(!Number.isInteger(index)||index<0||index>=p.dates.length)return;
  if(!parseDay(e.target.value))return;
  if(parseDay(idea.expiry)&&e.target.value>idea.expiry){e.target.value=p.dates[index];showToast('Exit date cannot be after this option expires.');return;}
  if(p.dates.some((d,i)=>i!==index&&d===e.target.value)){e.target.value=p.dates[index];showToast('That exit date is already in this ticker plan.');return;}
  p.dates[index]=e.target.value;publishTickerLevels(idea);
 }else return;
 persistPlannerDrafts();updateOptionPreviewResults();
});
$('quickPlanner').addEventListener('input',e=>{
 const el=e.target.closest('[data-draft-id]');if(!el)return;
 const idea=plannerIdeas().find(x=>x.id===el.dataset.draftId),name=e.target.name;
 if(!idea||!['name','ticker','expiry','strike','optionType','qty','price','fee','stress','plannedLossPct'].includes(name))return;
 const before=draftContractKey(idea);
 if(['ticker','optionType'].includes(name)&&!tickerInputOrigins.has(idea.id))tickerInputOrigins.set(idea.id,tickerScenarioKey(idea));
 idea[name]=name==='ticker'?normalizeTicker(e.target.value):e.target.value;
 // Manual date choice applies only to this contract; changing ticker, strike
 // or direction returns the new contract to the verified-only dropdown.
 if(['ticker','optionType'].includes(name))manualExpiryIds.delete(idea.id);
 const changed=['ticker','expiry','strike','optionType'].includes(name)&&before!==draftContractKey(idea);
 if(changed){
  quoteRefreshToken++;quoteRefreshBusy=false;
  const p=ensurePreview(idea);p.spot='';p.ivPct='';p.ivManual=false;p.bid='';p.ask='';p.quoteAt='';p.quoteSource='New contract requires new quote';
  idea.marketMid='';idea.contractSymbol='';idea.quoteStatus='';idea.quoteMessage='Contract changed — Analyze % to refresh quote.';
  if(!idea.priceManual){idea.price='';const price=el.querySelector('[name="price"]');if(price)price.value='';}
  quoteConnectionState='unknown';quoteRefreshMessage='';
 }
 if(name==='price')idea.priceManual=String(idea.price).trim()!=='';
 if(name==='stress')idea.stressCustom=true;
 if(name==='fee')idea.feeManual=true;
 if(name==='qty'&&!idea.feeManual){idea.fee=estimateOrderFee(account(),'BUY',idea.qty).toFixed(2);const fee=el.querySelector('[name="fee"]');if(fee)fee.value=idea.fee;}
 persistPlannerDrafts();updatePlannerMetrics(analytics());
 const header=el.querySelector('[data-idea-ticker]');if(header){const sym=normalizeTicker(idea.ticker)||'NEW TICKER';header.textContent=sym;el.querySelector('[data-idea-name]').textContent=idea.name||'Untitled idea';el.querySelector('[data-idea-contract]').innerHTML=compactContractMarkup(idea);el.querySelector('[data-idea-qty]').textContent=idea.qty||'—';el.querySelector('[data-idea-premium]').innerHTML=Number(idea.price)>0&&Number.isFinite(Number(idea.price))?usdWithCad(Number(idea.price),account().fx):'—';}
 if(['ticker','strike','optionType','expiry'].includes(name)){
  // Only update the label when the selected date input is actively being edited.
  updateListingCard(idea);
 }
 if(['ticker','optionType'].includes(name))queueListedExpirations(idea);
 if(changed&&currentPreviewIdea()?.id===idea.id)renderOptionPreview();
});
// A listing lookup can finish while a user is still focused inside the
// fallback calendar. Switch to the verified dropdown on blur, not mid-typing.
$('quickPlanner').addEventListener('focusout',e=>{
 const field=e.target.closest('[data-expiration-field]');
 if(!field)return;
 const id=field.closest('[data-draft-id]')?.dataset.draftId;
 if(!id)return;
 setTimeout(()=>{
  const card=[...document.querySelectorAll('[data-draft-id]')].find(x=>x.dataset.draftId===id);
  const currentField=card?.querySelector('[data-expiration-field]');
  if(!currentField||currentField.contains(document.activeElement))return;
  const idea=plannerIdeas().find(x=>x.id===id);
  if(idea)updateListingCard(idea);
 },0);
});
$('quickPlanner').addEventListener('change',e=>{
 const node=e.target.closest('[data-draft-id]');
 if(!node)return;
 if(e.target.name==='regularExpiriesOnly'){
  const next=!!e.target.checked;
  if(next===regularExpiriesOnly)return;
  regularExpiriesOnly=next;
  if(listingDebounce)clearTimeout(listingDebounce);
  // Mode changes never alter the saved contract or its selected expiration.
  e.target.blur();
  renderPlanner(analytics());
  const idea=plannerIdeas().find(x=>x.id===node.dataset.draftId);
  if(idea)void ensureListedExpirations(idea);
  return;
 }
 if(e.target.name==='listedExpiry'){
  if(e.target.value==='__manual__'){
   manualExpiryIds.add(node.dataset.draftId);
   e.target.blur();
   const selected=plannerIdeas().find(x=>x.id===node.dataset.draftId);
   if(selected)updateListingCard(selected);
  }else if(e.target.value)applyListedExpiry(node.dataset.draftId,e.target.value);
  return;
 }
 if(!['ticker','expiry','strike','optionType'].includes(e.target.name))return;
 const idea=plannerIdeas().find(x=>x.id===node.dataset.draftId);
 if(!idea)return;
 const oldGroup=tickerInputOrigins.get(idea.id);
 tickerInputOrigins.delete(idea.id);
 if(['ticker','optionType'].includes(e.target.name)&&oldGroup!==undefined&&oldGroup&&oldGroup!==tickerScenarioKey(idea)){
  // New company/direction: clear old underlying targets, but keep contract's quote invalidation separate.
  const p=ensurePreview(idea),fresh=emptyPreview(today(),state.customClosed||[]);
  p.targets=fresh.targets;p.dates=fresh.dates;p.tickerLinked=true;p.tickerLinkEstablished=false;p.tickerPlanEditedAt='';
 }
 adoptTickerLevels(idea);
 if(['ticker','optionType'].includes(e.target.name))queueListedExpirations(idea,true);
 if(selectedPreviewId===idea.id)void ensureAtmRange(idea);
 if(selectedPreviewId===idea.id&&optionPanelMode==='chain'){
  renderOptionPreview();void ensureAtmRange(idea);void refreshOptionChain();
 }else if(draftContract(idea)){if(selectedPreviewId===idea.id)void refreshOptionQuote();else void refreshDraftPremium(idea);}
 else {persistPlannerDrafts();if(currentPreviewIdea()?.id===idea.id)renderOptionPreview();}
 if(e.target.name==='expiry')updateListingCard(idea);
});

$('plannerCapMode')?.addEventListener('change',e=>{
 const a=account();
 const previous=activeIdeaCapCad(a)===null?'pool':'fixed';
 const mode=e.target.value==='pool'?'pool':'fixed';
 if(mode===previous)return;
 if(mode==='fixed'&&!(Number(a.ideaCapCad)>0)){
  e.target.value=previous;showToast('Set a positive per-idea cap in Rules & data before using Fixed mode.');return;
 }
 a.ideaCapMode=mode;
 if(!save()){a.ideaCapMode=previous;e.target.value=previous;showToast('Could not save this policy change.');return;}
 render();
 showToast(mode==='pool'?'Flexible rolling pool enabled. Fixed cap saved for later.':'Fixed per-idea guide restored. Rolling ceiling unchanged.');
});
$('planSortSelect')?.addEventListener('change',e=>{
 planSortMode=PLAN_SORT_MODES.includes(e.target.value)?e.target.value:'created';
 try{localStorage.setItem(PLAN_SORT_KEY,planSortMode);}catch{}
 renderPlanner(analytics());
});
$('settingsForm').addEventListener('submit',saveSettings);
$('cloudSignInForm').addEventListener('submit',async e=>{e.preventDefault();const btn=$('cloudSignIn');btn.disabled=true;
 try{await cloudController.signIn($('cloudEmail').value.trim());showToast('Check your email for the cloud sign-in link.');}
 catch(err){showToast(err.message||'Sign-in failed');}finally{btn.disabled=false;}});
$('cloudSignOut').addEventListener('click',()=>void cloudController.signOut());
$('cloudSyncNow').addEventListener('click',async()=>{try{await cloudController.syncNow();showToast('Cloud sync checked.');}catch(err){showToast(err.message||'Cloud unavailable');}});

$('closedDayForm').addEventListener('submit',e=>{e.preventDefault();const date=e.currentTarget.elements.date.value;if(!parseDay(date)){showToast('Enter a valid closure date.');return;}if(state.positions.some(p=>[...p.fills,...p.exits].some(t=>t.date===date))||state.adjustments.some(x=>x.date===date)){showToast('An execution is already recorded on this date; cannot mark it closed.');return;}if(!state.customClosed.includes(date)){state.customClosed.push(date);state.customClosed.sort();save();render();showToast('Closure added to session calendar.');}});
$('ibkrFile').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{const raw=await file.text();if(raw.length>20e6)throw new Error('File exceeds 20 MB.');if(!isIbkrCsv(raw))throw new Error('Not an IBKR Flex-style trade export. Select a CSV with ClientAccountID, Symbol, Buy/Sell, etc.');previewIBKR(raw,file.name);}catch(err){console.error(err);showToast(`IBKR import failed: ${err.message}`);}finally{e.target.value='';}});
$('importFile').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{await importFile(file);}catch(err){console.error(err);showToast(`Import failed: ${err.message}`);}finally{e.target.value='';}});
render();
cloudController=createCloudController({
 getState:()=>state,
 replaceState:replaceFromCloud,
 saveMergedLocal:writeLocalWithoutRevision,
 downloadBackup:download,
 notify:showToast,
 updateStatus:updateCloudStatus
});
void recoverFromIndexedDb().then(()=>cloudController.configure());


// Optional private cloud sync is configured separately; local data remains available offline.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
