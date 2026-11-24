/* Temporary scenario planning. No draft belongs to the trading ledger or cloud backup. */
import {round2, roundUp} from './risk.mjs';
import {draftContractKey} from './planner-contract.mjs';

export const MAX_PLAN_IDEAS=8;
/** The optional per-idea guide is distinct from the mandatory rolling risk ceiling. */
export function activeIdeaCapCad(account){
 if(account?.ideaCapMode==='pool')return null;
 const raw=account?.ideaCapCad;
 if(raw===null||raw===undefined||raw==='')return null;
 const n=Number(raw);
 return Number.isFinite(n)&&n>0?n:null;
}
const val=v=>v===null||v===undefined?'':String(v).trim();

export function defaultPlanIdea(id,stressPct=70,first=false){
  return {id,label:'',name:'',ticker:'',expiry:'',strike:'',optionType:'Call',qty:'1',price:'',priceManual:false,marketMid:'',contractSymbol:'',quoteStatus:'',quoteMessage:'',fee:'',feeManual:false,stress:String(stressPct),stressCustom:false};
}

export function parsePlannedContract(label){
  const text=val(label).toUpperCase();
  const match=text.match(/^([A-Z][A-Z0-9.\-]{0,11})\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d+(?:\.\d+)?)\s*([CP])$/);
  if(!match)return /^[A-Z][A-Z0-9.\-]{0,11}$/.test(text)?{ticker:text}:{};
  const [,ticker,datePart,strikePart,side]=match;
  let year,month,day;
  if(datePart.includes('-'))[year,month,day]=datePart.split('-').map(Number);
  else {
    const parts=datePart.split('/').map(Number);
    [month,day,year]=parts;
    if(year<100)year+=2000;
  }
  if(year<2000||year>2100||!Number.isFinite(year)||month<1||month>12||day<1||day>31)return {ticker};
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)return {ticker};
  const strike=Number(strikePart);
  if(!Number.isFinite(strike)||strike<0)return {ticker};
  return {ticker,expiry:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,strike,optionType:side==='C'?'Call':'Put'};
}

// Match the exact option in the current portfolio; never merge closed attempts
// or guess which existing position to use if historical records are ambiguous.
export function openContractMatches(idea,positions=[],accountId){
 const key=draftContractKey(idea);
 return key?positions.filter(x=>x.metrics.qty>0&&(!accountId||x.position.accountId===accountId)&&draftContractKey(x.position)===key):[];
}
export function remainingDraftQuantity(planned,recorded){
 return Math.max(0,(Number.isInteger(Number(planned))?Number(planned):0)-Math.max(0,Math.floor(Number(recorded)||0)));
}
export function calculatePlanBasket(ideas,account,availableCad,positions=[]){
  let remainingCad=round2(Number(availableCad)||0);
  let plannedReserveCad=0, plannedDebitUsd=0, plannedPremiumUsd=0, plannedBuyFeesUsd=0, priced=0;
  const fx=Number(account.fx);
  const strict=account.mode==='strict';
  const ideaCap=activeIdeaCapCad(account);
  const allocatedContracts=new Set();
  const rows=(ideas||[]).map(idea=>{
    const key=draftContractKey(idea),matches=openContractMatches(idea,positions,account.id);
    const existingQty=matches.reduce((sum,x)=>sum+x.metrics.qty,0);
    const existingReserveCad=matches.reduce((sum,x)=>sum+x.metrics.reserveCad,0);
    const existingCostUsd=matches.reduce((sum,x)=>sum+x.metrics.remainingCostUsd,0);
    const match=matches.length===1?matches[0]:null;
    const existing={existingQty,existingReserveCad,existingCostUsd,positionId:match?.position.id||null,ambiguous:matches.length>1};
    const qty=Number(val(idea.qty)),price=Number(val(idea.price)),fee=val(idea.fee)===''?0:Number(idea.fee);
    const stress=match?match.metrics.stressPct:val(idea.stress)===''?Number(account.stressPct):Number(idea.stress);
    let reason='';
    if(!val(idea.qty)||!Number.isInteger(qty)||qty<0||qty>99999)reason='Enter 0–99,999 whole additional contracts.';
    else if(matches.length>1)reason='Multiple open positions match this contract. Review them in Positions before adding.';
    else if(match&&Number(match.position.multiplier||100)!==100)reason='Non-standard option multiplier. Use Add contracts in Positions.';
    else if(qty===0){
      priced++;
      return {id:idea.id,valid:true,idle:true,...existing,qty:0,price:0,fee:0,stress,premiumTotalUsd:0,reserveCad:0,totalReserveCad:existingReserveCad,debitUsd:0,debitCad:0,remainingCad,overBudget:remainingCad<-.005,overIdeaCap:ideaCap!==null&&existingReserveCad>ideaCap+.005};
    }
    else if(key&&allocatedContracts.has(key))reason='Another draft already sizes this exact contract. Use one draft for additions.';
    else if(!val(idea.price))reason='Enter a premium to allocate risk.';
    else if(!Number.isFinite(price)||price<=0||price>100000)reason='Enter a valid option premium.';
    else if(!Number.isFinite(fee)||fee<0||fee>100000)reason='Enter valid total entry fees.';
    else if(!Number.isFinite(stress)||stress<0||stress>100)reason='Stress must be between 0–100%.';
    else if(!Number.isFinite(fx)||fx<=0)reason='Set a valid account USD/CAD rate.';
    if(reason)return {id:idea.id,valid:false,reason,remainingCad,...existing};
    if(key)allocatedContracts.add(key);
    const premiumTotalUsd=round2(qty*price*100);
    const debitUsd=qty*price*100+fee;
    const debitCad=debitUsd*fx;
    // Recalculate the ENTIRE position at its existing risk policy, then subtract
    // the reserve already charged to availableCad. Round only once per position.
    const fixed=match&&match.metrics.hasFixed?Math.max(0,Number(match.position.fixedReserveCad)||0):0;
    const totalReserveCad=round2(Math.max(fixed,roundUp((existingCostUsd+debitUsd)*fx*(strict?1:stress/100),account.roundStep)));
    const reserveCad=round2(Math.max(0,totalReserveCad-existingReserveCad));
    remainingCad=round2(remainingCad-reserveCad);
    plannedReserveCad=round2(plannedReserveCad+reserveCad);
    plannedDebitUsd=round2(plannedDebitUsd+debitUsd);
    plannedPremiumUsd=round2(plannedPremiumUsd+premiumTotalUsd);
    plannedBuyFeesUsd=round2(plannedBuyFeesUsd+fee);
    priced++;
    const overIdeaCap=ideaCap!==null&&totalReserveCad>ideaCap+0.005;
    return {id:idea.id,valid:true,...existing,qty,price,fee,stress,premiumTotalUsd,reserveCad,totalReserveCad,debitUsd,debitCad,remainingCad,overBudget:remainingCad<-.005,overIdeaCap};
  });
  return {rows,availableCad:round2(Number(availableCad)||0),priced,total:rows.length,complete:priced===rows.length,plannedReserveCad,plannedPremiumUsd,plannedBuyFeesUsd,plannedDebitUsd,remainingCad,overBudget:remainingCad<-.005,overIdeaCap:rows.some(r=>r.overIdeaCap)};
}
