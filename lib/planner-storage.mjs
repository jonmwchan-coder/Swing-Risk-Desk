/* Local, persistent draft-only scratchpad. Not part of the trading ledger or cloud sync. */
import {MAX_PLAN_IDEAS,parsePlannedContract} from './planner.mjs';
import {normalizeTicker} from './planner-contract.mjs';
import {normalizePreview} from './option-preview.mjs';
import {torontoToday} from './calendar.mjs';

export const PLANNER_LOCAL_KEY='swing-risk-desk:planning-board:v3';
export const PREVIOUS_PLANNER_LOCAL_KEY='swing-risk-desk:planning-board:v2';
export const LEGACY_PLANNER_SESSION_KEY='swing-risk-desk:planning-board:v1';
const string=(value,fallback='',max=120)=>String(value===null||value===undefined?fallback:value).slice(0,max);

export function normalizePlannerDrafts(value,limit=MAX_PLAN_IDEAS){
 const result=Object.create(null);
 if(!value||typeof value!=='object'||Array.isArray(value))return result;
 for(const [accountId,ideas] of Object.entries(value)){
  if(!accountId||accountId.length>160||!Array.isArray(ideas))continue;
  const seen=new Set();
  const safe=[];
  for(const idea of ideas){
   if(!idea||typeof idea!=='object'||typeof idea.id!=='string'||!idea.id||idea.id.length>160||seen.has(idea.id))continue;
   seen.add(idea.id);
   const legacy=parsePlannedContract(idea.label);
   const ticker=normalizeTicker(idea.ticker??legacy.ticker??'');
   const clean={id:idea.id,label:string(idea.label,'',80),name:string(idea.name,'',80),ticker:string(ticker,'',12),expiry:string(idea.expiry??legacy.expiry??'','',10),strike:string(idea.strike??legacy.strike??'','',30),optionType:idea.optionType==='Put'?'Put':idea.optionType==='Call'?'Call':legacy.optionType||'Call',qty:string(idea.qty,'1',30),price:string(idea.price,'',30),priceManual:idea.priceManual===true||(!('priceManual' in idea)&&String(idea.price??'').trim()!==''),marketMid:string(idea.marketMid,'',30),contractSymbol:string(idea.contractSymbol,'',40),quoteStatus:string(idea.quoteStatus,'',30),quoteMessage:string(idea.quoteMessage,'',200),fee:string(idea.fee,'',30),feeManual:idea.feeManual===true,stress:string(idea.stress,'70',30),stressCustom:idea.stressCustom===true,plannedLossPct:string(idea.plannedLossPct??(idea.stressCustom===true?idea.stress:''),'',30)};
   if(idea.preview)clean.preview=normalizePreview(idea.preview,torontoToday());
   if(typeof idea.savedForLaterAt==='string'&&Number.isFinite(Date.parse(idea.savedForLaterAt)))clean.savedForLaterAt=idea.savedForLaterAt.slice(0,40);
   safe.push(clean);
   if(safe.length>=limit)break;
  }
  if(safe.length)result[accountId]=safe;
 }
 return result;
}

// One atomic localStorage write for both lists. v2 remains intact as rollback evidence.
const emptyBoard=(persisted=true)=>({drafts:Object.create(null),savedIdeas:Object.create(null),savedAt:'',migrated:false,persisted});
function validBoard(data,version){
 return data&&typeof data==='object'&&!Array.isArray(data)&&data.version===version&&data.accounts&&typeof data.accounts==='object'&&!Array.isArray(data.accounts)&&(version===2||data.savedIdeas&&typeof data.savedIdeas==='object'&&!Array.isArray(data.savedIdeas));
}
function disjoint(drafts,savedIdeas){
 for(const [id,ideas] of Object.entries(savedIdeas)){
  const active=new Set((drafts[id]||[]).map(x=>x.id));
  if(ideas.some(x=>active.has(x.id)))return false;
 }
 return true;
}
export function savePlannerDrafts(storage,drafts,savedAt=new Date().toISOString(),savedIdeas){
 try{
  const raw=storage.getItem(PLANNER_LOCAL_KEY);
  let existing=null;
  if(raw!==null&&raw!==undefined){
   existing=JSON.parse(raw);
   if(!validBoard(existing,3))return false;
  }
  const active=normalizePlannerDrafts(drafts),saved=normalizePlannerDrafts(savedIdeas===undefined?(existing?.savedIdeas||{}):savedIdeas,Infinity);
  if(!disjoint(active,saved))return false;
  storage.setItem(PLANNER_LOCAL_KEY,JSON.stringify({version:3,savedAt,accounts:active,savedIdeas:saved}));
  return true;
 }catch{return false;}
}
export function loadPlannerDrafts(storage,legacySessionStorage=null){
 let raw=null;
 try{raw=storage?.getItem(PLANNER_LOCAL_KEY)??null;}catch{return emptyBoard(false);}
 if(raw!==null){
  try{
   const data=JSON.parse(raw);
   if(validBoard(data,3)){
    const drafts=normalizePlannerDrafts(data.accounts),savedIdeas=normalizePlannerDrafts(data.savedIdeas,Infinity);
    if(disjoint(drafts,savedIdeas))return {drafts,savedIdeas,savedAt:typeof data.savedAt==='string'?data.savedAt:'',migrated:false,persisted:true};
   }
  }catch{}
  return emptyBoard(false);
 }
 // Migrate the existing persistent board first. Never overwrite or remove v2.
 try{raw=storage?.getItem(PREVIOUS_PLANNER_LOCAL_KEY)??null;}catch{return emptyBoard(false);}
 if(raw!==null){
  try{
   const data=JSON.parse(raw);
   if(!validBoard(data,2))return emptyBoard(false);
   const drafts=normalizePlannerDrafts(data.accounts),savedIdeas=Object.create(null),savedAt=typeof data.savedAt==='string'?data.savedAt:new Date().toISOString();
   return {drafts,savedIdeas,savedAt,migrated:true,persisted:savePlannerDrafts(storage,drafts,savedAt,savedIdeas)};
  }catch{return emptyBoard(false);}
 }
 let legacy=null;
 try{legacy=legacySessionStorage?.getItem(LEGACY_PLANNER_SESSION_KEY)??null;}catch{}
 if(legacy!==null){
  try{
   const drafts=normalizePlannerDrafts(JSON.parse(legacy)),savedIdeas=Object.create(null);
   const savedAt=new Date().toISOString();
   const persisted=savePlannerDrafts(storage,drafts,savedAt,savedIdeas);
   if(persisted){try{legacySessionStorage?.removeItem(LEGACY_PLANNER_SESSION_KEY);}catch{}}
   return {drafts,savedIdeas,savedAt,migrated:true,persisted};
  }catch{}
 }
 return emptyBoard();
}
export function clearPlannerDraftStorage(storage,legacySessionStorage=null){
 let success=true;
 for(const key of [PLANNER_LOCAL_KEY,PREVIOUS_PLANNER_LOCAL_KEY])try{storage?.removeItem(key);}catch{success=false;}
 try{legacySessionStorage?.removeItem(LEGACY_PLANNER_SESSION_KEY);}catch{success=false;}
 return success;
}
