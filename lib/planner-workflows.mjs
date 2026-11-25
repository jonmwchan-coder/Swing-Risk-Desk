/* Pure, local-only planner conveniences. Never modify ledger or Supabase records. */
import {MAX_PLAN_IDEAS} from './planner.mjs';
import {normalizeTicker} from './planner-contract.mjs';
import {emptyPreview,standardPreviewDates,MAX_PREVIEW_DATES,MAX_PREVIEW_TARGETS} from './option-preview.mjs';
import {parseDay,nextSession} from './calendar.mjs';

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
 const currentDefault=dates.length===expected.length&&dates.every((d,i)=>d===expected[i]);
 const olderDefault=dates.length===2&&parseDay(dates[0])&&dates[0]<=day&&dates[1]===nextSession(dates[0],closed);
 return currentDefault||olderDefault;
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
 visible.sort((a,b)=>a.date.localeCompare(b.date));excluded.sort((a,b)=>a.date.localeCompare(b.date));
 return {visible,excluded};
}
export function isEmptyPlannerPlaceholder(idea){
 if(!idea)return false;
 const hasIntent=['label','name','ticker','expiry','strike','price'].some(k=>filled(idea[k]));
 return !hasIntent&&String(idea.qty??'1')==='1'&&!idea.feeManual&&!idea.stressCustom&&!filled(idea.plannedLossPct)&&!idea.priceManual&&!idea.preview;
}
export function copyPlannerIdeas(drafts,sourceId,targetId,makeId,allowedAccounts=[],selectedIdeaId=null){
 const allowed=new Set(allowedAccounts);
 if(!allowed.has(sourceId)||!allowed.has(targetId)||sourceId===targetId)return {ok:false,reason:'Choose a different existing portfolio.'};
 const source=(drafts[sourceId]||[]).filter(i=>!isEmptyPlannerPlaceholder(i)&&(selectedIdeaId===null||i.id===selectedIdeaId));
 if(!source.length)return {ok:false,reason:'There are no entered ideas to copy.'};
 const destination=drafts[targetId]||[];
 const preserved=destination.length===1&&isEmptyPlannerPlaceholder(destination[0])?[]:destination;
 if(preserved.length+source.length>MAX_PLAN_IDEAS)return {ok:false,reason:'Destination has '+preserved.length+' ideas. Adding '+source.length+' would exceed the '+MAX_PLAN_IDEAS+'-idea limit; nothing was copied.',current:preserved.length};
 const existingIds=new Set(Object.values(drafts).flatMap(x=>Array.isArray(x)?x.map(i=>i.id):[]));
 const copies=[];
 let conflicts=0;
 const hasExplicitTickerPlan=p=>Boolean(p?.tickerPlanEditedAt)||Boolean(p?.targets?.some(t=>filled(t.price)))||(Array.isArray(p?.targets)&&p.targets.length!==3);
 for(const sourceIdea of source){
  const freshId=makeId();
  if(!freshId||existingIds.has(freshId))return {ok:false,reason:'Could not generate a unique draft ID. Nothing was copied.'};
  existingIds.add(freshId);
  const copied=clone(sourceIdea);
  copied.id=freshId;
  copied.quoteStatus=copied.quoteStatus==='indicative'?'saved':copied.quoteStatus==='loading'?'unavailable':copied.quoteStatus;
  const mismatchedExisting=preserved.some(targetIdea=>tickerScenarioKey(targetIdea)&&tickerScenarioKey(targetIdea)===tickerScenarioKey(copied)&&
   (hasExplicitTickerPlan(targetIdea.preview)||hasExplicitTickerPlan(copied.preview))&&!sameTickerScenario(targetIdea.preview,copied.preview));
  if(mismatchedExisting&&copied.preview){
   // Preserve existing target portfolio's intentionally different plan. Copied ideas stay independently editable.
   copied.preview.tickerLinked=false;copied.preview.tickerLinkEstablished=false;
   conflicts++;
  }
  if(copied.quoteStatus==='saved')copied.quoteMessage='Copied indicative quote. May be stale; refresh the exact contract before trading.';
  copies.push(copied);
 }
 const next={...drafts,[targetId]:[...preserved,...copies]};
 return {ok:true,drafts:next,count:copies.length,previousCount:preserved.length,conflicts};
}

// The user-facing action requires an exact source idea; never fall back to a bulk copy.
export function copyPlannerIdea(drafts,sourceId,targetId,ideaId,makeId,allowedAccounts=[]){
 if(typeof ideaId!=='string'||!ideaId)return {ok:false,reason:'Select one idea to copy.'};
 return copyPlannerIdeas(drafts,sourceId,targetId,makeId,allowedAccounts,ideaId);
}

// Park exact idea (including all its underlying scenario inputs), not its position.
// Only the active map is supplied to calculatePlanBasket.
export function parkPlannerIdea(drafts,savedIdeas,accountId,ideaId,at=new Date().toISOString()){
 const active=drafts[accountId]||[],saved=savedIdeas[accountId]||[];
 const idea=active.find(x=>x.id===ideaId);
 if(!idea||isEmptyPlannerPlaceholder(idea))return {ok:false,reason:'Enter an idea before saving it for later.'};
 if(saved.some(x=>x.id===ideaId))return {ok:false,reason:'That idea is already saved. Nothing moved.'};
 const parked={...clone(idea),savedForLaterAt:at};
 if(parked.quoteStatus==='loading'||parked.quoteStatus==='indicative')parked.quoteStatus='saved';
 return {ok:true,drafts:{...drafts,[accountId]:active.filter(x=>x.id!==ideaId)},savedIdeas:{...savedIdeas,[accountId]:[parked,...saved]},idea:parked};
}
export function restorePlannerIdea(drafts,savedIdeas,accountId,ideaId){
 const active=drafts[accountId]||[],saved=savedIdeas[accountId]||[];
 const parked=saved.find(x=>x.id===ideaId);
 if(!parked)return {ok:false,reason:'That saved idea is no longer present.'};
 if(active.some(x=>x.id===ideaId))return {ok:false,reason:'That idea is already active. Nothing moved.'};
 const preserved=active.filter(x=>!isEmptyPlannerPlaceholder(x));
 if(preserved.length>=MAX_PLAN_IDEAS)return {ok:false,reason:'All '+MAX_PLAN_IDEAS+' active idea slots are full. Save an active idea for later first.'};
 const idea=clone(parked);
 delete idea.savedForLaterAt;
 const oldPremium=String(idea.price??'').trim();
 // Premium, spot and IV are time/contract specific. Preserve thesis and targets,
 // but never allocate risk using a stale saved purchase estimate.
 Object.assign(idea,{price:'',priceManual:false,marketMid:'',contractSymbol:'',quoteStatus:'',quoteMessage:oldPremium?'Previous planned premium USD '+oldPremium+' / share. Refresh or enter a new premium.':'Refresh or enter a new premium before recording.'});
 if(idea.preview){
  const p=idea.preview;
  Object.assign(p,{spot:'',ivPct:'',ivManual:false,bid:'',ask:'',quoteAt:'',quoteSource:'Restored idea — refresh quote'});
  // A saved plan is a frozen, independent plan on return. A new active peer
  // must not silently replace the saved targets. User can explicitly relink.
  p.tickerLinked=false;p.tickerLinkEstablished=false;
 }
 return {ok:true,drafts:{...drafts,[accountId]:[...preserved,idea]},savedIdeas:{...savedIdeas,[accountId]:saved.filter(x=>x.id!==ideaId)},idea};
}
export function deleteSavedPlannerIdea(drafts,savedIdeas,accountId,ideaId){
 const saved=savedIdeas[accountId]||[];
 if(!saved.some(x=>x.id===ideaId))return {ok:false,reason:'That saved idea is no longer present.'};
 return {ok:true,drafts,savedIdeas:{...savedIdeas,[accountId]:saved.filter(x=>x.id!==ideaId)}};
}

// Update contract-specific market inputs without touching the underlying plan,
// listing cache or executions. Explicit Refresh premium can replace a manual
// buy price, but only if it hasn't been edited since the request began.
export function applyDraftMarketQuote(idea,data,symbol,{useMidpoint=false,initialPrice=idea.price,initialManual=idea.priceManual,verified=false}={}){
 if(!data||data.symbol!==symbol)throw Error('Quote response did not match the selected contract.');
 if(!idea.preview)throw Error('Missing scenario preview.');
 const p=idea.preview;
 const number=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
 const spot=number(data.spotUsd),iv=number(data.ivPct),bid=number(data.optionBidUsd),ask=number(data.optionAskUsd);
 p.spot=spot!==null&&spot>0?String(spot):'';
 if(!(p.ivManual&&Number(p.ivPct)>0)){p.ivManual=false;p.ivPct=iv!==null&&iv>0?String(iv):'';}
 p.bid=bid!==null&&bid>=0?String(bid):'';
 p.ask=ask!==null&&ask>=0?String(ask):'';
 p.quoteAt=typeof data.quoteAt==='string'&&Number.isFinite(Date.parse(data.quoteAt))?data.quoteAt:'';
 p.quoteSource=String(data.provider||'Alpaca indicative').slice(0,120);
 const valid=bid!==null&&ask!==null&&bid>0&&ask>=bid;
 idea.contractSymbol=symbol;idea.marketMid=valid?String(Math.round((bid+ask)*5000)/10000):'';
 idea.quoteStatus=valid?'indicative':'unavailable';
 const unchanged=String(idea.price??'')===String(initialPrice??'')&&Boolean(idea.priceManual)===Boolean(initialManual);
 if(valid&&(!idea.priceManual||useMidpoint&&unchanged)){idea.price=idea.marketMid;idea.priceManual=false;}
 idea.quoteMessage=valid?
  'Indicative bid '+bid.toFixed(2)+' / ask '+ask.toFixed(2)+' · midpoint '+Number(idea.marketMid).toFixed(2)+' · '+(p.quoteAt||'timestamp unavailable')+' UTC · non-OPRA'+(verified?' · verified contract':'')+(idea.priceManual?' · manual buy premium retained':''):
  'No valid indicative midpoint. Existing planned premium, if any, is unchanged; verify or enter a broker premium.';
 return {valid,missingIv:!(Number(p.ivPct)>0),missingSpot:!p.spot};
}
export function markDraftQuoteFailed(idea,error){
 idea.quoteStatus='unavailable';
 idea.quoteMessage=('Refresh failed: '+String(error?.message||error||'Quote unavailable')+'. Prior planned premium, if any, is unchanged. Verify your broker price.').slice(0,200);
 if(idea.preview){idea.preview.quoteSource='Refresh failed · previous reference (if any)';}
}
