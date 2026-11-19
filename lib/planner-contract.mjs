/* Structured option contracts for independent local planning ideas. */
import {parseDay} from './calendar.mjs';

export const PLAN_SORT_MODES=['created','ticker','name','expiry'];
export function normalizeTicker(value){
 return String(value??'').trim().toUpperCase().replace(/\s+/g,'');
}
export function draftContract(idea){
 if(!idea)return null;
 const ticker=normalizeTicker(idea.ticker),expiry=String(idea.expiry??'').trim(),side=idea.optionType;
 const raw=String(idea.strike??'').trim(),strike=Number(raw);
 if(!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(ticker)||!parseDay(expiry)||!raw||!Number.isFinite(strike)||strike<=0||strike>99999.999||Math.abs(strike*1000-Math.round(strike*1000))>1e-6||!['Call','Put'].includes(side))return null;
 return {ticker,expiry,strike,optionType:side};
}
export function draftContractKey(idea){
 const c=draftContract(idea);
 return c?[c.ticker,c.expiry,c.strike.toFixed(3),c.optionType].join('|'):'';
}
export function sortPlanIdeas(ideas,mode='created'){
 const source=[...(ideas||[])];
 if(!PLAN_SORT_MODES.includes(mode)||mode==='created')return source;
 const text=v=>String(v||'').toUpperCase();
 const keys={ticker:i=>text(i.ticker),name:i=>text(i.name),expiry:i=>String(i.expiry||'9999-12-31')};
 const secondary=['ticker','name','expiry'].filter(k=>k!==mode);
 const fields=[mode,...secondary];
 return source.map((item,index)=>({item,index})).sort((a,b)=>{
  for(const k of fields){const av=keys[k](a.item),bv=keys[k](b.item);const result=av.localeCompare(bv,'en',{numeric:true});if(result)return result;}
  return a.index-b.index;
 }).map(x=>x.item);
}
