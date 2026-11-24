/* Local, persistent draft-only scratchpad. Not part of the trading ledger or cloud sync. */
import {MAX_PLAN_IDEAS,parsePlannedContract} from './planner.mjs';
import {normalizeTicker} from './planner-contract.mjs';
import {normalizePreview} from './option-preview.mjs';
import {torontoToday} from './calendar.mjs';

export const PLANNER_LOCAL_KEY='swing-risk-desk:planning-board:v2';
export const LEGACY_PLANNER_SESSION_KEY='swing-risk-desk:planning-board:v1';
const string=(value,fallback='',max=120)=>String(value===null||value===undefined?fallback:value).slice(0,max);

export function normalizePlannerDrafts(value){
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
   safe.push(clean);
   if(safe.length>=MAX_PLAN_IDEAS)break;
  }
  if(safe.length)result[accountId]=safe;
 }
 return result;
}

export function savePlannerDrafts(storage,drafts,savedAt=new Date().toISOString()){
 try{
  storage.setItem(PLANNER_LOCAL_KEY,JSON.stringify({version:2,savedAt,accounts:normalizePlannerDrafts(drafts)}));
  return true;
 }catch{return false;}
}

export function loadPlannerDrafts(storage,legacySessionStorage=null){
 let raw=null;
 try{raw=storage?.getItem(PLANNER_LOCAL_KEY)??null;}catch{}
 if(raw!==null){
  try{
   const data=JSON.parse(raw);
   if(data&&typeof data==='object'&&!Array.isArray(data)&&data.version===2){
    return {drafts:normalizePlannerDrafts(data.accounts),savedAt:typeof data.savedAt==='string'?data.savedAt:'',migrated:false,persisted:true};
   }
  }catch{}
  // Do not silently replace an unreadable current record with older session data.
  return {drafts:Object.create(null),savedAt:'',migrated:false,persisted:false};
 }
 let legacy=null;
 try{legacy=legacySessionStorage?.getItem(LEGACY_PLANNER_SESSION_KEY)??null;}catch{}
 if(legacy!==null){
  try{
   const drafts=normalizePlannerDrafts(JSON.parse(legacy));
   const savedAt=new Date().toISOString();
   const persisted=savePlannerDrafts(storage,drafts,savedAt);
   if(persisted){try{legacySessionStorage?.removeItem(LEGACY_PLANNER_SESSION_KEY);}catch{}}
   return {drafts,savedAt,migrated:true,persisted};
  }catch{}
 }
 return {drafts:Object.create(null),savedAt:'',migrated:false,persisted:true};
}

export function clearPlannerDraftStorage(storage,legacySessionStorage=null){
 let success=true;
 try{storage?.removeItem(PLANNER_LOCAL_KEY);}catch{success=false;}
 try{legacySessionStorage?.removeItem(LEGACY_PLANNER_SESSION_KEY);}catch{success=false;}
 return success;
}
