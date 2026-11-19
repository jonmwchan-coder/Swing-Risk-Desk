/* Pure, local-only planner conveniences. Never modify ledger or Supabase records. */
import {MAX_PLAN_IDEAS} from './planner.mjs';
import {normalizeTicker} from './planner-contract.mjs';
import {emptyPreview,standardPreviewDates,MAX_PREVIEW_DATES,MAX_PREVIEW_TARGETS} from './option-preview.mjs';
import {parseDay} from './calendar.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const filled = value => String(value ?? '').trim() !== '';
const targetTuple = target => [String(target?.id || ''),String(target?.name || ''),String(target?.price ?? '')];
const planTuple = preview => [Array.isArray(preview?.targets) ? preview.targets.map(targetTuple) : [],Array.isArray(preview?.dates) ? preview.dates : []];
export const tickerScenarioKey = idea => {
 const ticker = normalizeTicker(idea?.ticker);
 if(!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(ticker) || !['Call','Put'].includes(idea?.optionType))return '';
 return ticker+'|'+idea.optionType;
};
export function isUneditedTickerScenario(preview,day,closed=[]){
 if(!preview)return true;
 if(preview.tickerPlanEditedAt || preview.tickerLinkEstablished)return false;
 const targets=preview.targets||[];
 if(targets.length!==3 || targets.some((t,i)=>t.id!==['stop','tp1','tp2'][i] || t.name!==['Stop','TP1','TP2'][i] || filled(t.price)))return false;
 const expected=standardPreviewDates(day,closed),dates=preview.dates||[];
 return dates.length===expected.length && dates.every((d,i)=>d===expected[i]);
}
export function sameTickerScenario(a,b){return JSON.stringify(planTuple(a))===JSON.stringify(planTuple(b));}
function setScenario(preview,source){
 preview.targets=clone((source.targets||[]).slice(0,MAX_PREVIEW_TARGETS));
 preview.dates=clone((source.dates||[]).slice(0,MAX_PREVIEW_DATES));
 preview.tickerLinked=true;
 preview.tickerLinkEstablished=true;
 preview.tickerPlanEditedAt=source.tickerPlanEditedAt||'';
}
export function hydrateTickerScenario(ideas,idea,day,closed=[],force=false){
 const key=tickerScenarioKey(idea);
 if(!key)return {changed:false,reason:'no-ticker'};
 const current=idea.preview||(idea.preview=emptyPreview(day,closed));
 if(current.tickerLinked===false&&!force)return {changed:false,reason:'independent'};
 const sources=ideas.filter(x=>x.id!==idea.id && tickerScenarioKey(x)===key && x.preview?.tickerLinked!==false && !isUneditedTickerScenario(x.preview,day,closed))
 .sort((a,b)=>String(b.preview.tickerPlanEditedAt||'').localeCompare(String(a.preview.tickerPlanEditedAt||'')));
 if(!sources.length){
  if(force){current.tickerLinked=true;current.tickerLinkEstablished=true;return {changed:true,reason:'solo'};}
  return {changed:false,reason:'no-source'};
 }
 const source=sources[0].preview;
 if(!force&&!current.tickerLinkEstablished&&!isUneditedTickerScenario(current,day,closed)&&!sameTickerScenario(current,source)){
  current.tickerLinked=false;
  return {changed:true,reason:'preserved-existing'};
 }
 if(!force&&sameTickerScenario(current,source)&&current.tickerLinkEstablished)return {changed:false,reason:'already-synced'};
 setScenario(current,source);
 return {changed:true,reason:'adopted',fromId:sources[0].id};
}
export function broadcastTickerScenario(ideas,idea,day,closed=[],editedAt=new Date().toISOString()){
 const key=tickerScenarioKey(idea),preview=idea?.preview;
 if(!key||!preview||preview.tickerLinked===false)return {copied:0,preserved:0};
 preview.tickerLinkEstablished=true;
 preview.tickerPlanEditedAt=editedAt;
 let copied=0,preserved=0;
 for(const peer of ideas){
  if(peer.id===idea.id||tickerScenarioKey(peer)!==key||peer.preview?.tickerLinked===false)continue;
  const target=peer.preview||(peer.preview=emptyPreview(day,closed));
  if(target.tickerLinkEstablished||isUneditedTickerScenario(target,day,closed)||sameTickerScenario(target,preview)){
   setScenario(target,preview);copied++;
  }else{
   // Existing independently entered targets must never be overwritten silently.
   target.tickerLinked=false;preserved++;
  }
 }
 return {copied,preserved};
}
export function visibleTickerDates(idea){
 const expiry=parseDay(idea?.expiry)?idea.expiry:'9999-12-31';
 const dates=idea?.preview?.dates||[];
 const visible=[],excluded=[];
 dates.forEach((date,index)=>{
  if(!parseDay(date))return;
  (date<=expiry?visible:excluded).push({date,index});
 });
 return {visible,excluded};
}
export function isEmptyPlannerPlaceholder(idea){
 if(!idea)return false;
 const hasIntent=['label','name','ticker','expiry','strike','price'].some(k=>filled(idea[k]));
 return !hasIntent&&!idea.feeManual&&!idea.stressCustom&&!idea.priceManual&&!idea.preview;
}
export function copyPlannerIdeas(drafts,sourceId,targetId,makeId,allowedAccounts=[]){
 const allowed=new Set(allowedAccounts);
 if(!allowed.has(sourceId)||!allowed.has(targetId)||sourceId===targetId)return {ok:false,reason:'Choose a different existing portfolio.'};
 const source=(drafts[sourceId]||[]).filter(i=>!isEmptyPlannerPlaceholder(i));
 if(!source.length)return {ok:false,reason:'There are no entered ideas to copy.'};
 const destination=drafts[targetId]||[];
 const preserved=destination.length===1&&isEmptyPlannerPlaceholder(destination[0])?[]:destination;
 if(preserved.length+source.length>MAX_PLAN_IDEAS)return {ok:false,reason:'Destination has '+preserved.length+' ideas. Adding '+source.length+' would exceed the '+MAX_PLAN_IDEAS+'-idea limit; nothing was copied.',current:preserved.length};
 const existingIds=new Set(Object.values(drafts).flatMap(x=>Array.isArray(x)?x.map(i=>i.id):[]));
 const copies=[];
 for(const sourceIdea of source){
  const freshId=makeId();
  if(!freshId||existingIds.has(freshId))return {ok:false,reason:'Could not generate a unique draft ID. Nothing was copied.'};
  existingIds.add(freshId);
  const copied=clone(sourceIdea);
  copied.id=freshId;
  copied.quoteStatus=copied.quoteStatus==='indicative'?'saved':copied.quoteStatus;
  if(copied.quoteStatus==='saved')copied.quoteMessage='Copied indicative quote. May be stale; refresh the exact contract before trading.';
  copies.push(copied);
 }
 const next={...drafts,[targetId]:[...preserved,...copies]};
 return {ok:true,drafts:next,count:copies.length,previousCount:preserved.length};
}
