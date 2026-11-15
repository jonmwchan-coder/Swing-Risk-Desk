import {calculateAccount,calculatePosition,simulateExit,budgetRunway,lossReleases,round2,roundUp} from './lib/risk.mjs';
import {isSession,torontoToday,onOrBeforeSession,parseDay,dayOffset} from './lib/calendar.mjs';
import {SCHEMA,normalizeLedger,importIbkrTrades,mergeFullBackup,makeJournalEntry,recordPlanEdit,backupSnapshot} from './lib/ledger.mjs';
import {isIbkrCsv,parseIbkrTrades} from './lib/ibkr.mjs';
import {createCloudController} from './lib/cloud.mjs';
import {calculatePlanBasket,defaultPlanIdea,parsePlannedContract,MAX_PLAN_IDEAS} from './lib/planner.mjs';

const STORAGE_KEY='swing-risk-desk:data:v1';
const $=id=>document.getElementById(id);
const money=(v,digits=2)=>`${Number(v)<0?'-':''}$${Math.abs(Number(v)||0).toLocaleString('en-CA',{minimumFractionDigits:digits,maximumFractionDigits:digits})}`;
const cad=(v,digits=2)=>`CAD ${money(v,digits)}`;
const usd=(v,digits=2)=>`USD ${money(v,digits)}`;
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
  accounts:[{id:'bdi',name:'Sample Swing Account',equityCad:20000,equityCheckpoints:[{id:'equity-initial-bdi',date:onOrBeforeSession(today()),createdAt:new Date().toISOString(),equityCad:20000,realizedPnlCad:0,source:'Initial account equity'}],riskPct:3,window:5,stressPct:70,roundStep:25,mode:'stress',fx:1.4,fxSource:'Illustrative assumption, not a live quote',fxDate:'',ideaCapCad:200,brokerAccountId:''}],
  positions:[],adjustments:[],customClosed:[],brokerInbox:[],importLog:[],conflicts:[],archive:[],revision:0,lastBackupRevision:0,lastBackupAt:''
};}

function normalize(incoming){return normalizeLedger(incoming);}
function load(){try{const saved=localStorage.getItem(STORAGE_KEY);return saved?normalize(JSON.parse(saved)):seed();}catch(err){console.warn('Could not read locally stored risk data',err);return seed();}}
let state=load();
let maxRevisionObserved=state.revision||0;
const initiallyHadLocalRecord=Boolean(localStorage.getItem(STORAGE_KEY));
let activeAccountId=state.accounts[0]?.id||'bdi';
let activeTab='dashboard';
let positionFilter='open';
let asOfOverride=null;
let toastTimer=null;
let plannerPrefill=null;
const DRAFT_SESSION_KEY='swing-risk-desk:planning-board:v1';
function readDrafts(){try{const data=JSON.parse(sessionStorage.getItem(DRAFT_SESSION_KEY)||'{}');return data&&typeof data==='object'&&!Array.isArray(data)?data:{};}catch{return {};}}
let plannerDrafts=readDrafts();
function persistPlannerDrafts(){try{sessionStorage.setItem(DRAFT_SESSION_KEY,JSON.stringify(plannerDrafts));}catch{}}
function plannerIdeas(accountId=account().id){
 let ideas=plannerDrafts[accountId];
 if(!Array.isArray(ideas)||!ideas.length){ideas=[defaultPlanIdea(uid(),account().stressPct,true)];plannerDrafts[accountId]=ideas;persistPlannerDrafts();}
 const normalized=ideas.filter(x=>x&&typeof x==='object'&&typeof x.id==='string').slice(0,MAX_PLAN_IDEAS);
 if(!normalized.length){normalized.push(defaultPlanIdea(uid(),account().stressPct,true));}
 if(normalized.length!==ideas.length){plannerDrafts[accountId]=normalized;persistPlannerDrafts();}
 return plannerDrafts[accountId];
}
function dropPlannerIdea(draftId,renderAfter=true){
 const ideas=plannerIdeas();const index=ideas.findIndex(x=>x.id===draftId);
 if(index<0)return;
 ideas.splice(index,1);
 if(!ideas.length)ideas.push(defaultPlanIdea(uid(),account().stressPct,false));
 persistPlannerDrafts();if(renderAfter)renderPlanner(analytics());
}
function beginPlannedPosition(draftId){
 const draft=plannerIdeas().find(x=>x.id===draftId);
 if(!draft)return showToast('That draft is no longer present.');
 const candidate=calculatePlanBasket([draft],account(),analytics().availableCad).rows[0];
 if(!candidate?.valid)return showToast(candidate?.reason||'Enter a valid size before recording.');
 plannerPrefill={...draft,draftId,...parsePlannedContract(draft.label)};
 addPosition();
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
      state=normalize(backup);activeAccountId=state.accounts[0]?.id||'bdi';maxRevisionObserved=Math.max(maxRevisionObserved,state.revision||0);
      localStorage.setItem(STORAGE_KEY,JSON.stringify(state));render();showToast('Recovered your latest local data copy. Download an external backup.');
    }
  }
 }catch(err){console.warn('Recovery check unavailable',err);}}
let userEditedSinceStartup=false;
let cloudController=null;
function replaceFromCloud(snapshot){
 state=normalize(snapshot);maxRevisionObserved=Math.max(maxRevisionObserved,Number(state.revision)||0);
 activeAccountId=state.accounts.some(a=>a.id===activeAccountId)?activeAccountId:state.accounts[0]?.id||'bdi';
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
}
function renderOverview(m){
  const isOver=m.availableCad<-.005;
  const p=Math.max(0,m.budgetCad)>0?(m.usedCad/m.budgetCad)*100:100;
  const used=Number.isFinite(p)?p:100;
  $('availableBig').innerHTML=`${isOver?'-':''}CAD $${Math.floor(Math.abs(m.availableCad)).toLocaleString('en-CA')}<span>.${String(Math.round((Math.abs(m.availableCad)%1)*100)).padStart(2,'0')}</span>`;
  $('availableBig').classList.toggle('negative',isOver);
  $('heroBadge').className=`pill ${isOver?'pill-alert':m.availableCad<25?'pill-warning':'pill-good'}`;
  $('heroBadge').textContent=isOver?'OVER BUDGET':m.availableCad<25?'CAPACITY FULL':'WITHIN PLAN';
  $('heroSubtitle').textContent=isOver?`${cad(-m.availableCad)} over the risk limit. No room to add.`:`After open stress reserves and losses realized during the last ${m.account.window} sessions.`;
  const openPercent=m.budgetCad>0?Math.max(0,Math.min(100,100*m.reserveCad/m.budgetCad)):100;
  const lossPercent=m.budgetCad>0?Math.max(0,Math.min(100-openPercent,100*m.realizedLossCad/m.budgetCad)):0;
  $('trackOpen').style.width=`${openPercent}%`;
  $('trackLoss').style.width=`${lossPercent}%`;
  $('budgetTrack').setAttribute('aria-label',`${cad(m.reserveCad)} reserved, ${cad(m.realizedLossCad)} realized losses, ${cad(m.availableCad)} available`);
  $('usedPct').textContent=`${Math.round(used)}%`;
  $('riskRing').style.background=`conic-gradient(#75dec0 0 ${openPercent}%,#fd9b93 ${openPercent}% ${openPercent+lossPercent}%,#35515b ${openPercent+lossPercent}% 100%)`;
  $('windowLabel').textContent=`Rolling ${m.account.window}-session window`;
  $('rangeLabel').textContent=`${fmtDate(m.dates[0])} - ${fmtDate(m.asOf)}`;
  $('reservedMetric').textContent=money(m.reserveCad);
  const oc=m.positions.filter(x=>x.metrics.qty>0).length;
  $('reservedHint').textContent=`${oc} open position${oc!==1?'s':''} across all ideas`;
  $('lossMetric').textContent=money(m.realizedLossCad);
  $('lossHint').textContent=`${money(m.realizedProfitCad)} wins logged, not netted`;
  $('capMetric').textContent=money(m.budgetCad);
  $('capHint').textContent=`${m.account.riskPct}% of ${money(m.currentEquityCad)} tracked equity`;
  $('equityTracker').innerHTML=`<strong>TRACKED ACCOUNT EQUITY</strong> <span class="equity-tracker-value">${cad(m.currentEquityCad)}</span> <span class="equity-tracker-detail">${cad(m.equityCheckpointCad)} checkpoint ${m.equityChangeCad>=0?'+':''}${money(m.equityChangeCad)} net realized since checkpoint · excludes unrealized P/L</span>`;
  $('costMetric').textContent=money(m.fullPremiumCad);
  $('costHint').textContent='Remaining debit at current FX';
  updateBackupBadge();
  const alerts=[];
  if(isOver)alerts.push({kind:'danger',title:`Budget exceeded by ${money(-m.availableCad)}.`,desc:'Stop opening positions. Reduce existing exposure or wait for eligible realized losses to roll out.'});
  const missing=m.positions.filter(x=>x.metrics.qty>0&&!x.position.underlyingInvalidation?.trim());
  if(missing.length)alerts.push({kind:'warning',title:`${missing.length} open position${missing.length===1?' is':'s are'} missing an underlying invalidation.`,desc:`${missing.map(x=>x.position.ticker).join(', ')}: the stress reserve is a planning estimate, not a protective stop. Set the structure/time invalidation.`});
  const pastExp=m.positions.filter(x=>x.metrics.qty>0&&x.position.expiry&&x.position.expiry<m.asOf);
  if(pastExp.length)alerts.push({kind:'danger',title:`${pastExp.map(x=>x.position.ticker).join(', ')} shows an expired contract with no recorded close.`,desc:'Reconcile the broker fills. The app will not invent an expiry loss or quietly zero out your reserve.'});
  const openWithStop=m.positions.filter(x=>x.metrics.qty>0&&x.metrics.planLoss!==null&&m.account.ideaCapCad>0&&x.metrics.planLoss>m.account.ideaCapCad+.01);
  if(openWithStop.length)alerts.push({kind:'warning',title:'Estimated stop loss exceeds your planned idea cap.',desc:`${openWithStop.map(x=>x.position.ticker).join(', ')}: review planned risk vs the ${cad(m.account.ideaCapCad)} idea cap.`});
  const themeGroups={};for(const item of m.positions.filter(x=>x.metrics.qty>0)){const theme=item.position.sector?.trim().toLowerCase();if(theme)(themeGroups[theme]??=[]).push(item);}
  for(const [theme,items] of Object.entries(themeGroups)){if(new Set(items.map(x=>x.position.ticker)).size>1){const total=items.reduce((sum,x)=>sum+x.metrics.reserveCad,0);alerts.push({kind:'warning',title:`Correlated exposure: ${items.map(x=>x.position.ticker).join(' + ')}.`,desc:`These share the ${theme} theme and together reserve ${cad(total)}. Different tickers do not make independent bets.`});}}
  const ideaGroups={};for(const item of m.positions.filter(x=>x.metrics.qty>0)){const idea=item.position.ideaId?.trim();if(idea)(ideaGroups[idea]??=[]).push(item);}
  for(const [idea,items] of Object.entries(ideaGroups)){if(items.length>1&&m.account.ideaCapCad>0){const sum=items.reduce((n,x)=>n+(x.metrics.planLoss||0),0);if(sum>m.account.ideaCapCad){alerts.push({kind:'warning',title:`Combined idea stop exposure exceeds ${cad(m.account.ideaCapCad)}.`,desc:`${idea}: ${cad(sum)} across ${items.length} positions, before any exit slippage.`});}}}
  if(m.account.fxSource?.toLowerCase().includes('illustrative'))alerts.push({kind:'warning',title:`USD/CAD ${Number(m.account.fx).toFixed(4)} is an illustrative starting rate.`,desc:'Refresh from Bank of Canada or enter IBKR FX in Rules & data for more precise CAD figures.'});
  $('alerts').innerHTML=alerts.map(a=>`<div class="alert ${a.kind==='danger'?'danger':''}"><div class="alert-icon">${a.kind==='danger'?'!':'i'}</div><div><strong>${esc(a.title)}</strong><p>${esc(a.desc)}</p></div></div>`).join('');
  const open=m.positions.filter(x=>x.metrics.qty>0).sort((x,y)=>y.metrics.reserveCad-x.metrics.reserveCad);
  $('dashboardPositions').innerHTML=open.length?open.map(x=>positionCard(x,false)).join(''):'<div class="empty-state">No open positions yet. Import your private starter JSON in Rules & data, or add your first trade. A free budget is not a trade signal.</div>';
  $('rollingDaysLabel').textContent=`${m.account.window} sessions`;
  $('sessionStrip').style.gridTemplateColumns=m.dates.length>7?`repeat(${m.dates.length},minmax(56px,1fr))`:`repeat(${m.dates.length},minmax(0,1fr))`;
  $('sessionStrip').innerHTML=m.dates.map(d=>{const loss=m.lossesByDate[d]||0;return `<div class="session-day ${d===m.asOf?'today':''}"><span class="dow">${esc(dow(d))}</span><div class="daynum">${d.slice(8)}</div><div class="loss ${loss<.005?'zero':''}">${loss<.005?'No loss':money(loss,0)}</div></div>`;}).join('');
  const release=lossReleases(state,m.account.id,asOf());
  $('releaseBox').innerHTML=release.length?`<b>Next release:</b> ${fmtDate(release[0].releaseDate,true)} removes ${money(release.filter(x=>x.releaseDate===release[0].releaseDate).reduce((s,x)=>s-x.pnlCad,0))} in realized losses, assuming no other activity.`:'<b>No realized losses in this window.</b> An open swing keeps reserving risk even if its entry is older than five sessions.';
  renderPlanner(m);
  const runway=budgetRunway(state,m.account.id,asOf(),10);
  $('runwayChart').innerHTML=runway.map((r,i)=>{const h=m.budgetCad>0?Math.max(4,Math.min(100,100*Math.max(0,r.available)/m.budgetCad)):4;return `<div class="runway-item"><div class="runway-number ${r.available<0?'neg':''}">${money(r.available,0)}</div><div class="runway-bar-box"><div class="runway-bar ${r.available<0?'negative':''}" style="height:${h}%"></div></div><div class="runway-date">${i===0?'NOW':fmtDate(r.date)}</div></div>`;}).join('');
}
function positionCard(x,full){const p=x.position,z=x.metrics;const isOpen=z.qty>0;const days=p.expiry?Math.round((new Date(`${p.expiry}T12:00:00Z`)-new Date(`${analytics().asOf}T12:00:00Z`))/86400000):null;
 const fmt=days===null?'No expiry':days<0?`Expired ${-days}d ago`:days===0?'Expires today':`${days} calendar days to expiry`;
 const label=p.optionType==='Put'?'P':'C';const flag=!p.underlyingInvalidation?.trim();
 return `<article class="position-card" data-position="${esc(p.id)}">
  <div class="pos-top"><div><div class="pos-ticker">${esc(p.ticker)}</div><div class="pos-contract">${esc(p.expiry?fmtDate(p.expiry,true):'')} ${esc(p.strike||'?')}${label} <span style="color:#688e9a">/</span> ${esc(p.ideaId||'Single idea')}</div><div class="pos-meta">${esc(p.sector||'Sector not recorded')} &bull; ${esc(fmt)}</div></div><div class="pos-badge ${isOpen?'':'closed'}">${isOpen?`${z.qty} OPEN`:'CLOSED'}</div></div>
  <div class="pos-data"><div><div class="pos-data-label">RISK RESERVE</div><strong>${money(z.reserveCad,0)}</strong><small>${z.hasFixed?'Reserve floor applied':`${z.reservePct}% stress / cap`}</small></div><div><div class="pos-data-label">REMAINING DEBIT</div><strong>${money(z.premiumCad,0)}</strong><small>CAD at current FX</small></div><div><div class="pos-data-label">PLANNED LOSS</div><strong>${z.planLoss===null?'Not set':money(z.planLoss,0)}</strong><small>${z.planLoss===null?'Add option exit est.':'Estimated at stop mark'}</small></div>${full?`<div><div class="pos-data-label">REALIZED NET</div><strong class="${z.realizedTotal<0?'neg':'pos'}">${money(z.realizedTotal,0)}</strong><small>Recorded exits to date</small></div><div><div class="pos-data-label">STRESS RATE</div><strong>${z.reservePct}%</strong><small>${z.stressPct===account().stressPct?'Default or same':'Custom'}</small></div>`:''}</div>
  <div class="pos-note"><span class="${flag?'warning':''}">${flag?'Needs an underlying invalidation / time stop':`Wrong if: ${esc(p.underlyingInvalidation).slice(0,125)}`}${p.targetLevels?`<br>Targets: ${esc(p.targetLevels).slice(0,200)}`:''}${p.thesis?`<br>Idea: ${esc(p.thesis).slice(0,160)}`:''}</span><span>${esc(p.reviewBy?`Review by ${fmtDate(p.reviewBy)}`:'')}</span></div>
  <div class="pos-actions">${isOpen?`<button type="button" class="btn-mini emph" data-action="close-position" data-id="${esc(p.id)}">Record exit</button><button type="button" class="btn-mini" data-action="add-fill" data-id="${esc(p.id)}">Add contracts</button>`:''}<button type="button" class="btn-mini" data-action="edit-position" data-id="${esc(p.id)}">Edit plan</button><button type="button" class="btn-mini" data-action="add-note" data-id="${esc(p.id)}">+ Journal note</button>${full?`<button type="button" class="btn-mini" data-action="see-transactions" data-id="${esc(p.id)}">Fills / corrections</button><button type="button" class="btn-mini" data-action="delete-position" data-id="${esc(p.id)}">Delete</button>`:''}</div>
  ${full?`<details class="pos-details" id="detail-${esc(p.id)}"><summary>Original record and transactions</summary><p class="help-line">Source: ${esc(p.source||'Manual entry')} &bull; Master ID: ${esc(p.externalId||'Not linked')}</p><div class="plan-details"><div><strong>Thesis</strong><p>${esc(p.thesis||'Not recorded')}</p></div><div><strong>Catalyst / why now</strong><p>${esc(p.catalyst||'Not recorded')} ${esc(p.entryReason||'')}</p></div><div><strong>Management</strong><p>${esc(p.managementPlan||'Not recorded')}</p></div><div><strong>Other notes</strong><p>${esc(p.notes||'Not recorded')}</p></div></div><div class="journal-timeline">${renderTimeline(p)}</div><div class="modal-transaction-list">${transactionList(p)}</div></details>`:''}</article>`;
}
function renderTimeline(p){
 const events=[
  ...(p.journalEntries||[]).map(n=>({id:n.id,recordType:'journal-entry',type:n.kind||'Journal',date:n.date,time:n.createdAt||'',source:n.source||'App',body:n.body})),
  ...(p.planHistory||[]).map(n=>({id:n.id,recordType:'plan-revision',type:n.conflict?'Imported alternative plan':'Plan revision',date:n.date,time:n.createdAt||'',source:n.source||'',body:Object.entries(n.changes||{}).map(([k,v])=>`${k}: ${String(v.before??'')||'(blank)'} → ${String(v.after??'')||'(blank)'}`).join('\n')}))
 ].sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
 return events.length?`<h4>Journal / plan change timeline (${events.length})</h4>${events.map(n=>`<div class="journal-event"><div class="journal-event-head"><div><strong>${esc(n.type)}</strong><small>${esc(n.date||'Unspecified')} · ${esc(n.source)}</small></div><button class="timeline-remove" type="button" data-action="archive-timeline" data-id="${esc(p.id)}" data-event-type="${esc(n.recordType)}" data-event-id="${esc(n.id)}" aria-label="Remove ${esc(n.type)} dated ${esc(n.date||'unknown')} from timeline" title="Remove from timeline (recoverable)">×</button></div><p>${esc(n.body)}</p></div>`).join('')}`:'<p class="help-line">No visible journal or plan revisions. Removed records are recoverable in Rules & data → Archived corrections.</p>';
}
function transactionList(p){const tx=[...p.fills.map(x=>({...x,side:'BUY'})),...p.exits.map(x=>({...x,side:'SELL'}))].sort((a,b)=>`${a.date}${a.time||''}`.localeCompare(`${b.date}${b.time||''}`));return tx.map(t=>`<div class="transaction-row"><span>${esc(t.side)} ${t.qty} x ${money(t.price??0)} USD &bull; ${esc(fmtDate(t.date))} ${esc(t.time||'')} ${t.side==='SELL'?esc(t.reason||''):''}<br>Commission: ${usd(t.fee||0)}; USD/CAD ${Number(t.fx||account().fx).toFixed(4)}</span><button type="button" class="tiny-btn" data-action="delete-tx" data-id="${esc(p.id)}" data-tx="${esc(t.id)}" data-side="${t.side}">Remove</button></div>`).join('');}
function renderPositions(m){const arr=m.positions.filter(x=>positionFilter==='all'||(positionFilter==='open'?x.metrics.qty>0:x.metrics.qty===0));$('openCount').textContent=m.positions.filter(x=>x.metrics.qty>0).length;
  for(const f of document.querySelectorAll('.filter'))f.classList.toggle('active',f.dataset.filter===positionFilter);
  $('positionsFull').innerHTML=arr.length?arr.map(x=>positionCard(x,true)).join(''):'<div class="empty-state">No matching positions for this date.</div>';
}
function renderHistory(m){
 const rows=[];
 for(const x of m.positions){
  const p=x.position;
  for(const f of p.fills||[])if(f.date<=m.asOf){rows.push({id:f.id,date:f.date,time:f.time||'',ticker:p.ticker,position:p,action:'BUY',qty:f.qty,priceUsd:f.price,underlyingAtExit:null,amountCad:(f.qty*f.price*100+num(f.fee))*num(f.fx),pnlCad:null,kind:'entry',positionId:p.id,source:f.broker?.source||p.source||''});}
  for(const c of x.metrics.closes){const raw=p.exits.find(e=>e.id===c.id)||{};rows.push({id:c.id,date:c.date,time:raw.time||'',ticker:p.ticker,position:p,action:'SELL',qty:c.qty,priceUsd:c.price,underlyingAtExit:c.underlyingAtExit,reason:c.reason||'',tpLabel:raw.tpLabel||'',exitNotes:raw.notes||'',amountCad:c.proceedsCad,pnlCad:c.pnlCad,kind:'sale',positionId:p.id,hasOverride:c.hasOverride,source:raw.broker?.source||p.source||''});}
 }
 for(const e of state.adjustments.filter(a=>a.accountId===m.account.id&&a.date<=m.asOf))rows.push({id:e.id,date:e.date,ticker:e.note||'Prior trade',action:'ADJUST',qty:'--',priceUsd:null,underlyingAtExit:null,amountCad:0,pnlCad:num(e.pnlCad),kind:'manual'});
 rows.sort((a,b)=>`${b.date}${b.time||''}`.localeCompare(`${a.date}${a.time||''}`));
 const closed=rows.filter(x=>x.pnlCad!==null),net=closed.reduce((s,x)=>s+x.pnlCad,0);
 $('historyStats').innerHTML=`<div><small>Realized P/L in last window</small><strong class="${m.recent.reduce((s,x)=>s+x.pnlCad,0)<0?'neg':'pos'}">${money(m.recent.reduce((s,x)=>s+x.pnlCad,0))}</strong></div><div><small>All logged realized P/L</small><strong class="${net<0?'neg':'pos'}">${money(net)}</strong></div><div><small>Entries / exits in account</small><strong>${rows.filter(x=>x.action==='BUY').length} / ${rows.filter(x=>x.action==='SELL').length}</strong></div>`;
 const mark=(v,empty='Not recorded')=>v?`<span>${esc(v)}</span>`:`<span class="missing-field">${esc(empty)}</span>`;
 $('historyTable').innerHTML=rows.length?`<table class="history-table expanded-ledger"><colgroup><col style="width:7.5%"><col style="width:13%"><col style="width:4.5%"><col style="width:7%"><col style="width:7%"><col style="width:9%"><col style="width:16.5%"><col style="width:13%"><col style="width:8.5%"><col style="width:14%"></colgroup><thead><tr><th>DATE</th><th>CONTRACT</th><th>QTY</th><th>PREMIUM</th><th>TP</th><th>INVALIDATION</th><th>THESIS / CAT.</th><th>EXIT</th><th>P/L</th><th>ACTIONS</th></tr></thead><tbody>${rows.map(r=>{
  const p=r.position;const isManual=!p;
  const name=isManual?esc(r.ticker):`${esc(p.ticker)} ${esc(p.expiry)} ${esc(p.strike)}${p.optionType==='Put'?'P':'C'}`;
  const memo=p?[p.thesis?`Thesis: ${p.thesis}`:'',p.catalyst?`Catalyst: ${p.catalyst}`:'',p.entryReason?`Trigger: ${p.entryReason}`:''].filter(Boolean).join(' · '):'';
  const exitInfo=r.action==='SELL'?`${r.underlyingAtExit!==null?'Underlying $'+Number(r.underlyingAtExit).toFixed(2)+' · ':''}${r.tpLabel?esc(r.tpLabel)+' · ':''}${mark(r.reason,'Reason not supplied by IBKR')}${r.exitNotes?`<div class="history-subnote">${esc(r.exitNotes)}</div>`:''}`:'<span class="missing-field">Not an exit</span>';
  return `<tr><td data-label="DATE"><time datetime="${esc(r.date)}" title="${esc(fmtDate(r.date,true))}">${esc(historyDate(r.date))}</time><div class="history-subnote">${esc(r.time||'')}</div></td><td data-label="OPTION / SIDE"><strong>${name}</strong><div class="history-side">${esc(r.action)} ${r.hasOverride?'· broker P/L':''}</div></td><td data-label="QTY">${esc(r.qty)}</td><td data-label="PREMIUM USD">${r.priceUsd===null?'--':money(r.priceUsd,2)}</td><td data-label="TP" class="history-level-cell"><div class="history-cell-scroll" tabindex="0" title="${esc(p?.targetLevels||'')}">${p?mark(p.targetLevels):'--'}</div></td><td data-label="INVALIDATION" class="history-level-cell"><div class="history-cell-scroll" tabindex="0" title="${esc(p?.underlyingInvalidation||'')}">${p?mark(p.underlyingInvalidation):'--'}</div></td><td data-label="THESIS / CATALYST" class="history-thesis-cell"><div class="history-cell-scroll" tabindex="0" title="${esc(memo)}">${p?mark(memo,'Add thesis using Edit plan'):'--'}</div></td><td data-label="EXIT / REASON"><div class="history-cell-scroll" tabindex="0">${exitInfo}</div></td><td data-label="REALIZED CAD" class="${r.pnlCad===null?'':r.pnlCad>0?'pnl-pos':r.pnlCad<0?'pnl-neg':'pnl-zero'}">${r.pnlCad===null?'Not realized':money(r.pnlCad)}</td><td data-label="REVIEW">${p?`<div class="history-actions"><button class="tiny-btn" type="button" data-action="edit-position" data-id="${esc(p.id)}">Edit plan</button><button class="tiny-btn" type="button" data-action="view-position" data-id="${esc(p.id)}">Details</button><button class="tiny-btn" type="button" data-action="add-note" data-id="${esc(p.id)}">+ Note</button>${r.action==='SELL'?`<button class="tiny-btn" type="button" data-action="edit-exit" data-id="${esc(p.id)}" data-tx="${esc(r.id)}">Exit details</button>`:''}</div>`:`<button class="tiny-btn" type="button" data-action="delete-adjustment" data-id="${esc(r.id)}">Archive</button>`}</td></tr>`;
 }).join('')}</tbody></table>`:'<div class="empty-inline">No executions yet. Import IBKR trades, add a position, or enter a historical result.</div>';
}
function renderSettings(a){const f=$('settingsForm');const tracked=calculateAccount(state,a.id,today());const fields={name:a.name,brokerAccountId:a.brokerAccountId||'',equityCad:tracked.currentEquityCad,riskPct:a.riskPct,window:a.window,stressPct:a.stressPct,roundStep:a.roundStep,mode:a.mode,fx:a.fx,ideaCapCad:a.ideaCapCad??''};
 for(const [k,v] of Object.entries(fields)){const field=f.elements.namedItem(k);if(field)field.value=v;}
 $('equitySettingsInfo').textContent=`Calculated: ${cad(tracked.equityCheckpointCad)} checkpoint ${tracked.equityChangeCad>=0?'+':''}${money(tracked.equityChangeCad)} net realized P/L = ${cad(tracked.currentEquityCad)} now. Editing this figure creates a new dated checkpoint without resetting rolling losses. Exclude unrealized P/L from open positions when reconciling, or you may count it again when they close.`;
 $('fxDescriptor').textContent=`1 USD = ${Number(a.fx).toFixed(4)} CAD`;
 $('fxSource').textContent=a.fxSource?`${a.fxSource}${a.fxDate?` (as of ${a.fxDate})`:''}`:'Manually set';
 renderInbox();updateBackupBadge();
  $('customClosedDays').innerHTML=(state.customClosed||[]).map(d=>`<span class="date-tag">${esc(fmtDate(d,true))}<button type="button" data-action="remove-closed-day" data-date="${esc(d)}" aria-label="Remove closure ${esc(d)}">x</button></span>`).join('')||'<span class="help-line">No extra closure dates.</span>';
}
function renderPlanner(m){
 const ideas=plannerIdeas(m.account.id);
 let changed=false;
 for(const idea of ideas){if(!idea.stressCustom&&String(idea.stress)!==String(m.account.stressPct)){idea.stress=String(m.account.stressPct);changed=true;}}
 if(changed)persistPlannerDrafts();
 $('quickPlanner').innerHTML=ideas.map((idea,index)=>`<article class="draft-idea" data-draft-id="${esc(idea.id)}">
  <div class="draft-head"><strong>IDEA ${index+1}</strong><input type="text" name="label" maxlength="80" value="${esc(idea.label||'')}" placeholder="INTC 1/15/27 70C" aria-label="Idea ${index+1} ticker and option contract (optional)">
   <button type="button" class="draft-record" data-action="plan-to-position" data-plan-id="${esc(idea.id)}" title="Open a prefilled New position form; no trade recorded until submitted">Record</button>
   <button type="button" class="draft-remove" data-action="remove-plan-idea" data-plan-id="${esc(idea.id)}" aria-label="Remove draft idea ${index+1}" title="Remove this draft">×</button></div>
  <div class="draft-fields">
   <label><span>QTY</span><input type="number" inputmode="numeric" name="qty" min="1" step="1" value="${esc(idea.qty)}" aria-label="Idea ${index+1} contract quantity"></label>
   <label><span>PREMIUM USD</span><input type="number" inputmode="decimal" name="price" min="0.01" step="0.01" value="${esc(idea.price)}" aria-label="Idea ${index+1} price per share in USD"></label>
   <label><span>FEES USD</span><input type="number" inputmode="decimal" name="fee" min="0" step="0.01" value="${esc(idea.fee)}" aria-label="Idea ${index+1} total entry commissions in USD"></label>
   <label><span>STRESS %</span><input type="number" inputmode="numeric" name="stress" min="0" max="100" step="1" value="${esc(idea.stress)}" aria-label="Idea ${index+1} stress loss percent" ${m.account.mode==='strict'?'title="Strict mode reserves 100% of debit"':''}></label>
  </div>
  <div class="draft-metrics" data-plan-status="${esc(idea.id)}"></div>
 </article>`).join('');
 const addBtn=document.querySelector('[data-action="add-plan-idea"]');
 if(addBtn)addBtn.disabled=ideas.length>=MAX_PLAN_IDEAS;
 updatePlannerMetrics(m);
}
function updatePlannerMetrics(m){
 const ideas=plannerIdeas(m.account.id);const result=calculatePlanBasket(ideas,m.account,m.availableCad);
 for(const r of result.rows){const el=[...document.querySelectorAll('[data-plan-status]')].find(x=>x.dataset.planStatus===r.id);if(!el)continue;
  if(!r.valid){el.className='draft-metrics draft-incomplete';el.textContent=r.reason;continue;}
  const warning=r.overIdeaCap?` · Above ${money(m.account.ideaCapCad)} idea cap`:'';
  el.className=`draft-metrics ${r.overBudget?'draft-breach':''}`;
  el.innerHTML=`<span>Reserve <strong>${money(r.reserveCad)}</strong> CAD${esc(warning)}</span><span>Left after this <strong>${money(r.remainingCad)}</strong></span>`;
 }
 $('planIdeaCount').textContent=`${result.total} of ${MAX_PLAN_IDEAS} drafts · ${result.priced} priced`;
 $('plannerResult').innerHTML=`<div class="result-line"><span>Available before drafts</span><strong>${money(result.availableCad)}</strong></div>
  <div class="result-line"><span>Combined planned ${m.account.mode==='strict'?'full-debit':'stress'} reserve</span><strong>${money(result.plannedReserveCad)}</strong></div>
  <div class="result-line"><span>Combined entry debit (USD)</span><strong>${usd(result.plannedDebitUsd)}</strong></div>
  <div class="result-line result-main ${result.overBudget?'negative':''}"><span>Risk left after all drafts</span><strong>${money(result.remainingCad)}</strong></div>
  <div class="result-line"><span>${!result.complete?'Enter prices for remaining drafts':result.overBudget?'Combined draft entries breach your rolling risk limit':result.overIdeaCap?'Combined budget fits; review individual idea caps':'All priced drafts fit the rolling budget'}</span><strong class="${result.overBudget?'neg':result.complete&&!result.overIdeaCap?'pos':'risk-warning'}">${result.overBudget?'OVER BUDGET':!result.complete?'INCOMPLETE':result.overIdeaCap?'CAP REVIEW':'FITS'}</strong></div>`;
}
function switchTab(tab){if(!['dashboard','positions','history','settings'].includes(tab))return;activeTab=tab;render();}
function field(label,name,type='text',value='',opts={}){const attr=Object.entries(opts).map(([k,v])=>` ${k}="${esc(v)}"`).join('');return `<label class="${opts.full?'span-2':''}"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(value??'')}"${attr}></label>`;}
function selectField(label,name,options,value){return `<label><span>${esc(label)}</span><select name="${esc(name)}">${options.map(([val,text])=>`<option value="${esc(val)}" ${String(val)===String(value)?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;}
function dialog(title,eyebrow,body,submit){$('dialogTitle').textContent=title;$('dialogEyebrow').textContent=eyebrow;$('dialogBody').innerHTML=body;const d=$('editorDialog');d.showModal();const f=$('dialogBody').querySelector('form');if(f&&submit){f.addEventListener('submit',e=>{e.preventDefault();try{const ok=submit(new FormData(f),f);if(ok!==false){d.close();save();render();}}catch(err){showToast(err.message);const msg=f.querySelector('.modal-error');if(msg)msg.textContent=err.message;}});}return f;}
function formEnd(text='Save'){return `<div class="modal-error neg" role="alert" style="font-size:12px"></div><div class="modal-actions"><button type="button" class="btn btn-outline" data-action="close-dialog">Cancel</button><button type="submit" class="btn btn-primary">${esc(text)}</button></div>`;}
function requireRange(v,min,max,label){const n=Number(v);if(v===''||!Number.isFinite(n)||n<min||n>max)throw new Error(`${label} must be between ${min} and ${max}.`);return n;}
function requireDate(v,label){if(!parseDay(v))throw new Error(`Enter a valid ${label}.`);return v;}
function validateSession(date){if(!isSession(date,state.customClosed))throw new Error(`${date} is not a NYSE trading session. Select the actual execution date.`);}
function validateAsOf(date){if(date>analytics().asOf)throw new Error('This execution falls after the AS OF session. Select its actual trading date above before recording it.');}
function getText(d,k){return String(d.get(k)||'').trim();}
function validateDeal(a,qty,price,fee,fx,date){requireRange(qty,1,99999,'Contracts');requireRange(price,0,100000,'Option price');requireRange(fee,0,100000,'Commission');requireRange(fx,.01,100,'USD/CAD rate');requireDate(date,'execution date');validateSession(date);}
function maybeBreach(before,newReserve){if(newReserve>before.availableCad+0.01){return confirm(`This adds ${money(newReserve)} risk but only ${money(Math.max(0,before.availableCad))} is available. Record as an over-budget historical execution anyway?`);}return true;}
function addPosition(){const a=account(),pref=plannerPrefill;plannerPrefill=null;const now=onOrBeforeSession(asOf(),state.customClosed||[]);
 const body=`<p class="modal-intro">Entry date, exact premium and fees determine the cost. Your 70% assumption affects the reserve, not a broker stop order.</p><form><div class="modal-grid">
 ${field('TICKER','ticker','text',pref?.ticker||'',{required:'required',maxlength:12})}
 ${selectField('OPTION TYPE','optionType',[['Put','Put'],['Call','Call']],pref?.optionType||'Put')}
 ${field('STRIKE (USD)','strike','number',pref?.strike??'',{min:0,step:.01,required:'required'})}
 ${field('EXPIRY','expiry','date',pref?.expiry||'',{required:'required'})}
 ${field('CONTRACTS','qty','number',pref?.qty||2,{min:1,step:1,required:'required'})}
 ${field('ENTRY PRICE PER SHARE (USD)','price','number',pref?.price||'',{min:0,step:.0001,required:'required'})}
 ${field('TOTAL ENTRY COMMISSIONS (USD)','fee','number',pref?.fee??0,{min:0,step:.0001})}
 ${field('USD / CAD AT ENTRY','fx','number',a.fx,{min:.01,step:.0001})}
 ${field('TRADE DATE','date','date',now,{required:'required'})}
 ${field('TIME ET (OPTIONAL)','time','time','',{step:1})}
 ${field('STRESS % OVERRIDE (BLANK = ACCOUNT DEFAULT)','stressPct','number',pref?.stress??'',{min:0,max:100,step:1})}
 ${field('SECTOR / THEME','sector','text','',{maxlength:65})}
 ${field('IDEA / CORRELATED TRADE GROUP','ideaId','text','',{maxlength:90})}
 ${field('UNDERLYING INVALIDATION','underlyingInvalidation','text','',{maxlength:200})}
 ${field('ESTIMATED STOP OPTION PRICE / SHARE USD','stopPremiumUsd','number','',{min:0,step:.01})}
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
 const qty=Math.floor(requireRange(getText(d,'qty'),1,99999,'Contracts'));const price=requireRange(getText(d,'price'),.0001,100000,'Price');const fee=requireRange(getText(d,'fee')||'0',0,100000,'Fees');const fx=requireRange(getText(d,'fx'),.01,100,'USD/CAD');const date=requireDate(getText(d,'date'),'entry date');validateSession(date);validateAsOf(date);
 const expiry=requireDate(getText(d,'expiry'),'expiry');if(expiry<date)throw new Error('Expiry cannot precede purchase date.');
 const strike=requireRange(getText(d,'strike'),0,1000000,'Strike');const stress=optional(getText(d,'stressPct'));if(stress!==null)requireRange(String(stress),0,100,'Stress percentage');
 const newReserve=roundUp((qty*price*100+fee)*a.fx*(a.mode==='strict'?100:(stress??a.stressPct))/100,a.roundStep);
 if(!maybeBreach(analytics(),newReserve))return false;
 const position={id:uid(),externalId:'',source:'Manual entry',accountId:a.id,ticker,optionType:getText(d,'optionType'),strike,expiry,sector:getText(d,'sector'),ideaId:getText(d,'ideaId')||`${ticker}-${date}`,underlyingInvalidation:getText(d,'underlyingInvalidation'),targetLevels:getText(d,'targetLevels'),stopPremiumUsd:optional(getText(d,'stopPremiumUsd')),stressPct:stress,fixedReserveCad:null,reviewBy:getText(d,'reviewBy'),thesis:getText(d,'thesis'),catalyst:getText(d,'catalyst'),entryReason:getText(d,'entryReason'),managementPlan:getText(d,'managementPlan'),notes:getText(d,'notes'),journalEntries:[],planHistory:[],fills:[{id:uid(),date,time:getText(d,'time'),timeUnverified:!getText(d,'time'),qty,price,fee,fx}],exits:[]};
 position.planHistory.push({id:uid(),date,createdAt:new Date().toISOString(),source:'Initial plan recorded in app (entry-time status not independently verified)',changes:Object.fromEntries(['underlyingInvalidation','targetLevels','thesis','catalyst','entryReason','managementPlan','notes'].filter(k=>position[k]).map(k=>[k,{before:'',after:position[k]}]))});state.positions.push(position);if(pref?.draftId)dropPlannerIdea(pref.draftId,false);showToast(`Added ${qty} ${ticker} contract${qty!==1?'s':''}.`);return true;
 });
 const preview=()=>{const d=new FormData(f);const q=num(d.get('qty')),price=num(d.get('price')),fee=num(d.get('fee')),fx=num(d.get('fx'),a.fx),stress=optional(d.get('stressPct'))??a.stressPct;
 const cost=q*price*100+fee,raw=cost*a.fx*(a.mode==='strict'?1:stress/100),reserve=roundUp(raw,a.roundStep);
 const box=$('newPreview');if(q>0&&price>0&&fx>0)box.innerHTML=`<strong>${money(reserve)} reserved</strong><span>Cost ${usd(cost)} / ${money(cost*fx)} CAD at entry FX; reserve uses current ${a.fx.toFixed(4)} rate. Budget after entry: ${money(analytics().availableCad-reserve)}.</span>`;else box.innerHTML='<span>Enter a size and price to preview the reserve.</span>';
 };f.addEventListener('input',preview);preview();
}
function findPosition(id){const p=state.positions.find(x=>x.id===id&&x.accountId===account().id);if(!p)throw new Error('Position not found in this account.');return p;}
function closePosition(id){const a=account(),p=findPosition(id),existing=calculatePosition(p,a,analytics().asOf);if(existing.qty<=0)return showToast('Position is already closed.');
 const now=analytics().asOf;
 const body=`<p class="modal-intro">Close a slice or the full position. The remaining contracts keep their reserve. Each losing exit counts on its own closing date.</p><form><div class="modal-grid">
 ${field('CONTRACTS TO SELL','qty','number',existing.qty,{required:'required',min:1,max:existing.qty,step:1})}
 ${field('SALE PRICE PER SHARE USD / OPTIONAL WITH BROKER P&L','price','number','',{min:0,step:.0001})}
 ${field('EXIT COMMISSIONS USD','fee','number',0,{min:0,step:.0001})}
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
 const newExit={id:uid(),date,time:getText(d,'time')||'23:59',qty,price,fee,fx,brokerPnlCad:pnlOverride,underlyingAtExit:optional(getText(d,'underlyingAtExit')),reason:getText(d,'reason'),tpLabel:getText(d,'tpLabel'),notes:getText(d,'notes')};
 const check=structuredClone(p);check.exits.push(newExit);if(calculatePosition(check,a,'9999-12-31').issues.length)throw new Error('Sale time or quantity conflicts with other fills or prior exits.');
 p.exits.push(newExit);
 const after=calculateAccount(state,a.id,asOf());showToast(`Recorded ${qty} ${p.ticker} sale. Available: ${money(after.availableCad)}.`);return true;
 });
 const preview=()=>{const d=new FormData(f),q=num(d.get('qty')),price=optional(d.get('price')),broker=optional(d.get('brokerPnlCad'));
 if(q<1||q>existing.qty||(price===null&&broker===null)){$('closePreview').innerHTML='<span>Enter sale quantity and price (or verified broker P/L) for an exact budget preview.</span>';return;}
 try{const copy=structuredClone(state);const z=copy.positions.find(z=>z.id===p.id);z.exits.push({id:'__preview__',date:String(d.get('date')),time:String(d.get('time')||'23:59'),qty:q,price,fee:num(d.get('fee')),fx:num(d.get('fx')),brokerPnlCad:broker});const calc=calculateAccount(copy,a.id,asOf());const sale=calc.sales.find(x=>x.id==='__preview__');const result=sale?.pnlCad??0;const remains=calc.positions.find(x=>x.position.id===p.id)?.metrics;
 const box=$('closePreview');box.classList.toggle('alert',calc.availableCad<-.01);box.innerHTML=`<strong>After exit: ${money(calc.availableCad)} available</strong><span>Estimated realized ${money(result)} CAD (${result<0?'loss consumes budget':'profit does not net prior losses'}). Remaining reserve ${money(remains?.reserveCad||0)}.</span>`;
 }catch(err){$('closePreview').textContent='Set an eligible sale date to preview.';}
 };f.addEventListener('input',preview);preview();
}
function addFill(id){const a=account(),p=findPosition(id),now=analytics().asOf;
 const body=`<p class="modal-intro">Adding to the same idea increases its open cost and reserved risk. This is not a new risk allowance.</p><form><div class="modal-grid">${field('ADDITIONAL CONTRACTS','qty','number',1,{required:'required',min:1,step:1})}${field('PRICE / SHARE USD','price','number','',{required:'required',min:.0001,step:.0001})}${field('TOTAL BUY FEES USD','fee','number',0,{min:0,step:.0001})}${field('USD / CAD AT BUY','fx','number',a.fx,{min:.01,step:.0001})}${field('DATE','date','date',now,{required:'required'})}${field('TIME ET','time','time','',{step:1})}</div><div id="fillPreview" class="modal-summary"></div>${formEnd('Record added contracts')}</form>`;
 const f=dialog(`Add to ${p.ticker}`,'SAME IDEA / EXTRA EXPOSURE',body,(d)=>{
 const qty=Math.floor(requireRange(getText(d,'qty'),1,99999,'Contracts')),price=requireRange(getText(d,'price'),.0001,100000,'Premium'),fee=requireRange(getText(d,'fee')||'0',0,100000,'Fees'),fx=requireRange(getText(d,'fx'),.01,100,'FX'),date=requireDate(getText(d,'date'),'entry date');validateSession(date);validateAsOf(date);
 const before=analytics(),copy=structuredClone(state);copy.positions.find(z=>z.id===p.id).fills.push({id:'__add__',date,time:getText(d,'time')||'23:59',qty,price,fee,fx});
 const newCalc=calculateAccount(copy,a.id,asOf()),addedRisk=newCalc.reserveCad-before.reserveCad;
 if(!maybeBreach(before,addedRisk))return false;
 p.fills.push({id:uid(),date,time:getText(d,'time')||'23:59',timeUnverified:!getText(d,'time'),qty,price,fee,fx});showToast(`Added ${qty} contract${qty===1?'':'s'} to ${p.ticker}.`);return true;
 });
 const preview=()=>{const d=new FormData(f),qty=num(d.get('qty')),price=num(d.get('price')),fee=num(d.get('fee'));if(qty<1||price<=0){$('fillPreview').innerHTML='<span>Enter contracts and premium to preview added risk.</span>';return;}
 const before=analytics(),clone=structuredClone(state);clone.positions.find(z=>z.id===p.id).fills.push({id:'__preview__',date:String(d.get('date')),time:String(d.get('time')||'23:59'),qty,price,fee,fx:num(d.get('fx'),a.fx)});
 const after=calculateAccount(clone,a.id,asOf());$('fillPreview').innerHTML=`<strong>Additional reserve: ${money(after.reserveCad-before.reserveCad)}</strong><span>Available after add: ${money(after.availableCad)}. Your per-idea allowance does not reset.</span>`;
 };f.addEventListener('input',preview);preview();
}
function editPosition(id){const p=findPosition(id);const body=`<p class="modal-intro">Update your forward-looking risk plan. Do not rewrite what you knew before entry. No existing fills or realized results are changed.</p><form><div class="modal-grid">
 ${field('TICKER','ticker','text',p.ticker,{required:'required',maxlength:12})}${selectField('OPTION TYPE','optionType',[['Put','Put'],['Call','Call']],p.optionType)}
 ${field('STRIKE','strike','number',p.strike,{min:0,step:.01})}${field('EXPIRY','expiry','date',p.expiry,{required:'required'})}
 ${field('CORRELATED IDEA / GROUP','ideaId','text',p.ideaId||'',{maxlength:90})}${field('SECTOR / THEME','sector','text',p.sector||'',{maxlength:65})}
 ${field('STRESS % (BLANK = DEFAULT)','stressPct','number',p.stressPct??'',{min:0,max:100,step:1})}${field('MINIMUM CAD RESERVE / OPTIONAL','fixedReserveCad','number',p.fixedReserveCad??'',{min:0,step:1})}
 ${field('EST. STOP OPTION PREMIUM USD','stopPremiumUsd','number',p.stopPremiumUsd??'',{min:0,step:.01})}${field('REVIEW / TIME-STOP DATE','reviewBy','date',p.reviewBy||'')}
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
 const stress=optional(getText(d,'stressPct')),fixed=optional(getText(d,'fixedReserveCad')),stop=optional(getText(d,'stopPremiumUsd'));
 if(stress!==null)requireRange(String(stress),0,100,'Stress');if(fixed!==null)requireRange(String(fixed),0,1e8,'Fixed reserve');if(stop!==null)requireRange(String(stop),0,1e6,'Stop premium');
 const identity={ticker,strike,expiry,optionType:getText(d,'optionType')};
  if(p.fills.some(t=>t.broker)&&Object.entries(identity).some(([k,v])=>String(p[k])!==String(v)))throw new Error('Broker-verified contract identity cannot be changed here. Add a correction note, or reconcile the source.');
  const changes={...identity,ideaId:getText(d,'ideaId'),sector:getText(d,'sector'),stressPct:stress,fixedReserveCad:fixed,stopPremiumUsd:stop,reviewBy:getText(d,'reviewBy'),targetLevels:getText(d,'targetLevels'),underlyingInvalidation:getText(d,'underlyingInvalidation'),thesis:getText(d,'thesis'),catalyst:getText(d,'catalyst'),entryReason:getText(d,'entryReason'),managementPlan:getText(d,'managementPlan'),notes:getText(d,'notes')};
  const n=recordPlanEdit(p,changes,{date:today(),source:'Manual plan revision'});
  showToast(`${ticker} plan updated: ${n.length} change(s) preserved in timeline.`);return true;
 });
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
  if(changed.length){makeJournalEntry(p,{date:today(),kind:'Exit annotation change',source:`App annotation for ${tx.date} ${tx.time||''} / ${tx.id}`,text:`Updated exit ${tx.date} (${tx.qty} contracts): ${changed.map(k=>`${k}: [${String(tx[k]??'')||'blank'}] -> [${String(next[k]??'')||'blank'}]`).join('\n')}`});Object.assign(tx,next);}
  showToast(`Exit details saved; ${changed.length} change(s) in journal history.`);return true;});
}
function openPositionDetail(id){positionFilter='all';activeTab='positions';render();const item=$('positionsFull').querySelectorAll('[data-position]');for(const el of item)if(el.dataset.position===id){const details=el.querySelector('details');if(details)details.open=true;el.scrollIntoView({block:'center',behavior:'smooth'});break;}}
function renderInbox(){const pending=state.brokerInbox||[],conflicts=state.conflicts||[],archive=(state.archive||[]).filter(x=>!x.restoredAt);
 $('importInbox').innerHTML=`<div class="inbox-head"><strong>Import exceptions: ${pending.length} pending · ${conflicts.length} conflicting · ${archive.length} archived</strong><span>All retained in full JSON backup</span></div>`+
 (pending.length?`<details class="issue-details"><summary>Review ${pending.length} unreconciled IBKR row(s)</summary>${pending.slice(-50).map(x=>`<div class="issue-row"><strong>${esc(x.ticker)} ${esc(x.tradeDate)}</strong> ${esc(x.side)}: ${esc(x.reason)}<div class="history-subnote">${esc(x.raw?.Symbol||'')} / ${esc(x.raw?.['Date/Time']||'')}</div></div>`).join('')}</details>`:'')+
 (conflicts.length?`<details class="issue-details"><summary>Review ${conflicts.length} saved conflict(s)</summary>${conflicts.slice(-50).map(x=>`<div class="issue-row">${esc(x.reason||x.kind||'Import conflict')}<div class="history-subnote">${esc(x.positionId||'')}</div></div>`).join('')}</details>`:'')+
 (archive.length?`<details class="issue-details"><summary>Archived corrections (${archive.length})</summary>${archive.slice(-50).reverse().map(x=>`<div class="issue-row">${esc(x.kind||'record')} · ${esc(x.date)} · ${esc(x.label||'')} <button class="tiny-btn" type="button" data-action="restore-archive" data-id="${esc(x.id)}">Restore</button></div>`).join('')}</details>`:'');
}
function manualPnl(){const now=analytics().asOf;const body=`<p class="modal-intro">For a previously closed trade whose executions are not imported. Enter a signed <strong>NET CAD result</strong>: negative for loss, positive for profit. This is not a new position.</p><form><div class="modal-grid">${field('TRADE DATE','date','date',now,{required:'required'})}${field('REALIZED NET CAD (+/-)','pnlCad','number','',{required:'required',step:.01})}<label class="span-2"><span>LABEL / SOURCE</span><input name="note" type="text" placeholder="e.g. historical AXP runner loss" maxlength="120" required></label></div>${formEnd('Record realized result')}</form>`;
 dialog('Record prior realized P/L','HISTORICAL ADJUSTMENT',body,(d)=>{const date=requireDate(getText(d,'date'),'trade date');validateSession(date);validateAsOf(date);const pnlCad=requireRange(getText(d,'pnlCad'),-1e9,1e9,'P/L'),note=getText(d,'note');if(!note)throw new Error('Label required.');state.adjustments.push({id:uid(),accountId:account().id,date,pnlCad,note});showToast(`Saved ${money(pnlCad)} in realized CAD P/L.`);return true;});
}
function addAccount(){const body=`<p class="modal-intro">Each portfolio gets its own rolling loss and open-risk allocation. Do not treat correlated accounts as diversification.</p><form><div class="modal-grid">${field('PORTFOLIO NAME','name','text','New swing account',{required:'required',maxlength:56})}${field('CURRENT EQUITY CAD','equity','number',20000,{required:'required',min:0,step:.01})}${field('RISK % / WINDOW','risk','number',3,{required:'required',min:0,max:100,step:.1})}${field('STRESS %','stress','number',70,{required:'required',min:0,max:100,step:1})}</div>${formEnd('Add account')}</form>`;
 dialog('New portfolio','INDEPENDENT ACCOUNT',body,(d)=>{const a=account(),name=getText(d,'name'),equity=requireRange(getText(d,'equity'),0,1e9,'Equity'),riskPct=requireRange(getText(d,'risk'),0,100,'Risk'),stressPct=requireRange(getText(d,'stress'),0,100,'Stress');if(!name)throw new Error('Name is required.');const id=uid();state.accounts.push({id,name,equityCad:equity,equityCheckpoints:[{id:uid(),date:onOrBeforeSession(today(),state.customClosed),createdAt:new Date().toISOString(),equityCad:equity,realizedPnlCad:0,source:'New portfolio opening equity'}],riskPct,stressPct,window:5,roundStep:25,mode:'stress',fx:a.fx,fxSource:a.fxSource,fxDate:a.fxDate,ideaCapCad:200,brokerAccountId:''});activeAccountId=id;showToast(`${name} created.`);return true;});
}
function saveSettings(e){e.preventDefault();const f=e.currentTarget,d=new FormData(f),a=account();try{
 const equityCad=requireRange(getText(d,'equityCad'),0,1e9,'Equity'),riskPct=requireRange(getText(d,'riskPct'),0,100,'Risk percentage'),window=Math.floor(requireRange(getText(d,'window'),1,30,'Window')),stressPct=requireRange(getText(d,'stressPct'),0,100,'Stress percentage'),fx=requireRange(getText(d,'fx'),.01,100,'FX');const step=requireRange(getText(d,'roundStep'),0,100,'Rounding');
 const name=getText(d,'name');if(!name)throw new Error('Account name is required.');const brokerAccountId=getText(d,'brokerAccountId').toUpperCase();if(brokerAccountId&&state.accounts.some(x=>x.id!==a.id&&x.brokerAccountId===brokerAccountId))throw new Error('That IBKR account number is already mapped to another portfolio.');const oldFx=a.fx;
 // A plain settings save must NOT bake today's realized P/L into equity a second time.
 const before=calculateAccount(state,a.id,today());
 const equityRebased=Math.abs(equityCad-before.currentEquityCad)>0.005;
 if(equityRebased){
   a.equityCheckpoints??=[];
   a.equityCheckpoints.push({id:uid(),date:before.asOf,createdAt:new Date().toISOString(),equityCad,realizedPnlCad:before.realizedAllTime,source:'Manual realized-equity reconciliation / deposit / withdrawal'});
   a.equityCad=equityCad;
   a.equityPnlAtCheckpointCad=before.realizedAllTime;
 }
 Object.assign(a,{name,brokerAccountId,riskPct,window,stressPct,fx,roundStep:step,mode:getText(d,'mode')==='strict'?'strict':'stress',ideaCapCad:optional(getText(d,'ideaCapCad'))});
 if(fx!==oldFx){a.fxSource='Manually entered (broker rate if supplied)';a.fxDate='';}
 save();render();showToast(equityRebased?'Equity checkpoint saved. New realized P/L will now update account equity automatically.':'Portfolio rules recalculated; tracked equity preserved.');
 }catch(err){showToast(err.message);}
}
async function refreshFx(){const btn=document.querySelector('[data-action="refresh-fx"]');btn.disabled=true;btn.textContent='Checking reference rate...';
 try{let response=await fetch('/api/fx',{cache:'no-store'});if(!response.ok)throw new Error('Vercel rate endpoint not available');const data=await response.json();const value=Number(data.rate);if(!Number.isFinite(value)||value<=0)throw new Error('Invalid rate');const a=account();a.fx=value;a.fxSource=data.source+' (reference, not broker execution)';a.fxDate=data.date;save();render();showToast(`Bank of Canada daily average: ${value.toFixed(4)} CAD / USD.`);
 }catch(err){showToast('Rate unavailable. Enter your broker FX manually in Rules & data.');}finally{btn.disabled=false;btn.textContent='Get Bank of Canada rate';}
}
function download(name,data,mime='application/json'){const blob=new Blob([data],{type:mime});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function exportBackup(){
 state.lastBackupAt=new Date().toISOString();state.lastBackupRevision=state.revision;
 const backup=backupSnapshot(state);
 download(`swing-risk-desk-COMPLETE-${today()}.json`,JSON.stringify(backup,null,2));
 writeLocalWithoutRevision();
 showToast('Complete backup / ChatGPT handoff download started. Save the file to Google Drive.');
}
function csvEsc(value){const s=String(value??'');return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s;}
const CSV_COLUMNS=['account_id','position_id','external_id','idea_id','ticker','option_type','strike','expiry','sector','action','date','time','contracts','price_usd','fee_usd','fx_usdcad','stress_pct','underlying_invalidation','stop_premium_usd','notes','transaction_id','broker_pnl_cad'];
function exportCsv(template=false){const rows=[CSV_COLUMNS];if(!template){for(const p of state.positions){const tx=[...p.fills.map(x=>({...x,action:'BUY'})),...p.exits.map(x=>({...x,action:'SELL'}))];for(const t of tx)rows.push([p.accountId,p.id,p.externalId||'',p.ideaId,p.ticker,p.optionType,p.strike,p.expiry,p.sector||'',t.action,t.date,t.time||'',t.qty,t.price??'',t.fee||0,t.fx||'',p.stressPct??'',p.underlyingInvalidation||'',p.stopPremiumUsd??'',p.notes||'',t.id,t.brokerPnlCad??'']);}}
 download(template?'swing-risk-import-template.csv':`swing-risk-transactions-${today()}.csv`,rows.map(r=>r.map(csvEsc).join(',')).join('\r\n'),'text/csv;charset=utf-8');showToast(template?'CSV import template downloaded.':'Transactions CSV downloaded.');}
function parseCSV(content){const rows=[],row=[];let cell='',quote=false;const str=content.replace(/^\uFEFF/,'');for(let i=0;i<str.length;i++){const c=str[i];if(quote){if(c==='"'&&str[i+1]==='"'){cell+='"';i++;}else if(c==='"'){quote=false;}else cell+=c;}else{if(c==='"'){quote=true;}else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));if(row.some(v=>v.trim()))rows.push([...row]);row.length=0;cell='';}else cell+=c;}}if(quote)throw new Error('Unclosed quote in CSV file.');row.push(cell.replace(/\r$/,''));if(row.some(v=>v.trim()))rows.push(row);return rows;}
function mergeCSV(textData){const csv=parseCSV(textData);if(csv.length<2)throw new Error('CSV has no transactions.');const cols=csv[0].map(x=>x.trim().toLowerCase());for(const col of ['ticker','action','date','contracts','price_usd'])if(!cols.includes(col))throw new Error(`CSV missing ${col} column.`);
 const clone=structuredClone(state);let added=0,skipped=0;for(const raw of csv.slice(1)){const r=Object.fromEntries(cols.map((x,i)=>[x,raw[i]??'']));const accountId=r.account_id||activeAccountId;const a=clone.accounts.find(x=>x.id===accountId||x.name===accountId);if(!a)throw new Error(`Unknown account '${accountId}'. Create it first.`);
 const ticker=(r.ticker||'').toUpperCase().trim();const action=(r.action||'').toUpperCase().trim();if(!['BUY','SELL'].includes(action)||!ticker)throw new Error('Every row needs a ticker and BUY or SELL.');
 requireDate(r.date,'CSV execution date');if(!isSession(r.date,clone.customClosed||[]))throw new Error(`${r.date} is not a session.`);
 const qty=Math.floor(requireRange(r.contracts,1,99999,'CSV contracts'));const price=r.price_usd===''&&r.broker_pnl_cad!==''?null:requireRange(r.price_usd,0,100000,'CSV price');const fee=requireRange(r.fee_usd||'0',0,1e5,'CSV fees'),fx=requireRange(r.fx_usdcad||String(a.fx),.01,100,'CSV FX');
 let p=clone.positions.find(x=>(r.position_id&&x.id===r.position_id)||(r.external_id&&x.externalId===r.external_id));
 if(!p){if(action==='SELL')throw new Error(`No existing purchase found for ${ticker} SELL. Import the BUY rows first.`);if(!r.expiry||!r.strike)throw new Error(`New ${ticker} positions need expiry and strike.`);p={id:r.position_id||uid(),accountId:a.id,externalId:r.external_id||'',source:'Imported CSV journal',ideaId:r.idea_id||`${ticker}-${r.date}`,ticker,optionType:r.option_type||'Call',strike:num(r.strike),expiry:r.expiry,sector:r.sector||'',stressPct:optional(r.stress_pct),underlyingInvalidation:r.underlying_invalidation||'',stopPremiumUsd:optional(r.stop_premium_usd),fixedReserveCad:null,notes:r.notes||'',fills:[],exits:[]};clone.positions.push(p);}
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
    state=normalize(data);activeAccountId=state.accounts[0]?.id||'bdi';
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
function archiveRecord(kind,label,record,positionId=''){
 state.archive??=[];
 state.archive.push({id:uid(),kind,label,positionId,date:new Date().toISOString(),record:structuredClone(record)});
}
function restoreArchive(id){const item=(state.archive||[]).find(x=>x.id===id);if(!item)return showToast('Archived item was not found.');if(item.restoredAt)return showToast('This record was already restored.');const snapshot=structuredClone(state);
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
  state.archive=state.archive.filter(x=>x.id!==id);save();render();showToast('Archived record restored.');
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
 case 'add-note':addNote(id);break;
 case 'archive-timeline':archiveTimeline(id,el.dataset.eventType,el.dataset.eventId);break;
 case 'edit-exit':editExit(id,el.dataset.tx);break;
 case 'view-position':openPositionDetail(id);break;
 case 'add-fill':addFill(id);break;
 case 'manual-pnl':manualPnl();break;
 case 'add-account':addAccount();break;
 case 'close-dialog':$('editorDialog').close();break;
 case 'today':asOfOverride=null;render();break;
 case 'plan-to-position':beginPlannedPosition(el.dataset.planId);break;
 case 'add-plan-idea':{const ideas=plannerIdeas();if(ideas.length>=MAX_PLAN_IDEAS){showToast(`Maximum ${MAX_PLAN_IDEAS} draft ideas.`);break;}const idea=defaultPlanIdea(uid(),account().stressPct,false);ideas.push(idea);persistPlannerDrafts();renderPlanner(analytics());document.querySelectorAll('.draft-idea [name="label"]')[ideas.length-1]?.focus();break;}
 case 'remove-plan-idea':dropPlannerIdea(el.dataset.planId);break;
 case 'export-backup':exportBackup();break;
 case 'export-csv':exportCsv();break;
 case 'template-csv':exportCsv(true);break;
 case 'import-open':$('importFile').click();break;
 case 'import-ibkr':$('ibkrFile').click();break;
 case 'refresh-fx':refreshFx();break;
 case 'reset-data':if(confirm('Reset every locally stored account, position, note and transaction? A full safety backup will download first. Proceed ONLY after saving that file securely.')){download(`swing-risk-desk-BEFORE-RESET-${today()}.json`,JSON.stringify(backupSnapshot(state),null,2));state=seed();activeAccountId='bdi';asOfOverride=null;plannerDrafts={};try{sessionStorage.removeItem(DRAFT_SESSION_KEY);}catch{}save();render();showToast('Local data reset. Safety backup download was initiated.');}break;
 case 'delete-account':{const a=account();if(state.accounts.length<=1){showToast('At least one account must remain.');break;}if(state.positions.some(p=>p.accountId===a.id)||state.adjustments.some(x=>x.accountId===a.id)){showToast('This account contains records. Export and remove its records first.');break;}if(confirm(`Delete empty account ${a.name}?`)){state.accounts=state.accounts.filter(x=>x.id!==a.id);activeAccountId=state.accounts[0].id;save();render();}break;}
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
$('accountSelect').addEventListener('change',e=>{activeAccountId=e.target.value;render();});
$('asOfDate').addEventListener('change',e=>{const d=e.target.value;if(parseDay(d)){asOfOverride=d;render();}else showToast('Enter a valid date.');});
$('quickPlanner').addEventListener('input',e=>{
 const draftEl=e.target.closest('[data-draft-id]');if(!draftEl)return;
 const idea=plannerIdeas().find(x=>x.id===draftEl.dataset.draftId);
 if(!idea||!['label','qty','price','fee','stress'].includes(e.target.name))return;
 idea[e.target.name]=e.target.value;
 if(e.target.name==='stress')idea.stressCustom=true;
 persistPlannerDrafts();updatePlannerMetrics(analytics());
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