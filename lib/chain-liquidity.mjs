/* Pure option-chain rows and liquidity heat map. Zero is data, null is missing. */
export const CHAIN_VISIBLE_STRIKES=31;
export function aroundStrike(strikes,preferred,count=CHAIN_VISIBLE_STRIKES){
 const values=[...new Set((strikes||[]).map(Number).filter(v=>Number.isFinite(v)&&v>0))].sort((a,b)=>a-b);
 if(values.length<=count)return values;
 const target=Number(preferred);
 const index=Number.isFinite(target)&&target>0?values.reduce((best,v,i)=>Math.abs(v-target)<Math.abs(values[best]-target)?i:best,0):Math.floor(values.length/2);
 const from=Math.max(0,Math.min(values.length-count,index-Math.floor(count/2)));
 return values.slice(from,from+count);
}
export function heatLevels(rows){
 const result=(rows||[]).map(row=>({...row,call:row.call?{...row.call}:null,put:row.put?{...row.put}:null}));
 for(const side of ['call','put']){
  for(const [field,key] of [['openInterest','oiHeat'],['volume','volumeHeat']]){
   const numeric=result.map(x=>x[side]?.[field]).filter(x=>typeof x==='number'&&Number.isFinite(x)&&x>0).sort((a,b)=>b-a);
   // Relative rankings are only meaningful when enough observations exist.
   if(numeric.length<4)continue;
   const h=numeric[Math.min(numeric.length-1,Math.ceil(numeric.length*.12)-1)];
   const m=numeric[Math.min(numeric.length-1,Math.ceil(numeric.length*.30)-1)];
   const l=numeric[Math.min(numeric.length-1,Math.ceil(numeric.length*.55)-1)];
   for(const row of result){
    const value=row[side]?.[field];
    if(typeof value!=='number'||value<=0||!Number.isFinite(value))continue;
    row[side][key]=value>=h?3:value>=m?2:value>=l?1:0;
   }
  }
 }
 return result;
}
export function numericOrNull(value){
 if(value===null||value===undefined||value==='')return null;
 const parsed=Number(value);
 return Number.isFinite(parsed)&&parsed>=0?parsed:null;
}
