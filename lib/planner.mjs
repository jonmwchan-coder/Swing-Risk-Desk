/* Temporary scenario planning. No draft belongs to the trading ledger or cloud backup. */
import {round2, roundUp} from './risk.mjs';

export const MAX_PLAN_IDEAS=8;
const val=v=>v===null||v===undefined?'':String(v).trim();

export function defaultPlanIdea(id,stressPct=70,first=false){
  return {id,label:'',qty:'1',price:'',fee:'',feeManual:false,stress:String(stressPct),stressCustom:false};
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

export function calculatePlanBasket(ideas,account,availableCad){
  let remainingCad=round2(Number(availableCad)||0);
  let plannedReserveCad=0, plannedDebitUsd=0, plannedPremiumUsd=0, plannedBuyFeesUsd=0, priced=0;
  const fx=Number(account.fx);
  const strict=account.mode==='strict';
  const rows=(ideas||[]).map(idea=>{
    const qty=Number(val(idea.qty)),price=Number(val(idea.price)),fee=val(idea.fee)===''?0:Number(idea.fee);
    const stress=val(idea.stress)===''?Number(account.stressPct):Number(idea.stress);
    let reason='';
    if(!val(idea.price))reason='Enter a premium to allocate risk.';
    else if(!Number.isInteger(qty)||qty<1||qty>99999)reason='Enter 1–99,999 whole contracts.';
    else if(!Number.isFinite(price)||price<=0||price>100000)reason='Enter a valid option premium.';
    else if(!Number.isFinite(fee)||fee<0||fee>100000)reason='Enter valid total entry fees.';
    else if(!Number.isFinite(stress)||stress<0||stress>100)reason='Stress must be between 0–100%.';
    else if(!Number.isFinite(fx)||fx<=0)reason='Set a valid account USD/CAD rate.';
    if(reason)return {id:idea.id,valid:false,reason,remainingCad};
    const premiumTotalUsd=round2(qty*price*100);
    const debitUsd=qty*price*100+fee;
    const debitCad=debitUsd*fx;
    const reserveCad=round2(roundUp(debitCad*(strict?1:stress/100),account.roundStep));
    remainingCad=round2(remainingCad-reserveCad);
    plannedReserveCad=round2(plannedReserveCad+reserveCad);
    plannedDebitUsd=round2(plannedDebitUsd+debitUsd);
    plannedPremiumUsd=round2(plannedPremiumUsd+premiumTotalUsd);
    plannedBuyFeesUsd=round2(plannedBuyFeesUsd+fee);
    priced++;
    const ideaCap=Number(account.ideaCapCad);
    const overIdeaCap=account.ideaCapCad!==null&&account.ideaCapCad!==undefined&&account.ideaCapCad!==''&&Number.isFinite(ideaCap)&&ideaCap>0&&reserveCad>ideaCap+0.005;
    return {id:idea.id,valid:true,qty,price,fee,stress,premiumTotalUsd,reserveCad,debitUsd,debitCad,remainingCad,overBudget:remainingCad<-.005,overIdeaCap};
  });
  return {rows,availableCad:round2(Number(availableCad)||0),priced,total:rows.length,complete:priced===rows.length,plannedReserveCad,plannedPremiumUsd,plannedBuyFeesUsd,plannedDebitUsd,remainingCad,overBudget:remainingCad<-.005,overIdeaCap:rows.some(r=>r.overIdeaCap)};
}
