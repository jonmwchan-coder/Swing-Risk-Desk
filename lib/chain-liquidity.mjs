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
/* Visually sparse: only the top 3 positive CONTRACTS for each metric/side
   are highlighted, never percentile ranges. Tied values use competition
   ranking (1,2,2,4) so equal figures never appear to have different ranks,
   and the display can never highlight more than three cells per column. */
export function heatLevels(rows){
 const result=(rows||[]).map(row=>({...row,call:row.call?{...row.call}:null,put:row.put?{...row.put}:null}));
 for(const side of ['call','put']){
  for(const [field,key] of [['openInterest','oiHeat'],['volume','volumeHeat']]){
   const values=result.map((row,index)=>({index,value:row[side]?.[field]}))
    .filter(x=>typeof x.value==='number'&&Number.isFinite(x.value)&&x.value>0)
    .sort((a,b)=>b.value-a.value||a.index-b.index);
   // Rank in sorted order, assigning equal values equal priority.
   // Limit to the first three rows so the rest stay visually quiet.
   let rank=0;
   for(let i=0;i<Math.min(3,values.length);i++){
    if(i===0||values[i].value!==values[i-1].value)rank=i+1;
    result[values[i].index][side][key]=rank===1?3:rank===2?2:rank===3?1:0;
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
