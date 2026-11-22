/* Date-aware, fee-aware European approximation for long US equity options.
   Model inputs are assumed, never a trade signal or a broker quote. */
import {dayOffset, nextSession, parseDay} from './calendar.mjs';
export const MAX_PREVIEW_DATES=6;
export const MAX_PREVIEW_TARGETS=8;
export const MS_DAY=86400000;
const YEAR_MS=365.2425*MS_DAY;
const finite=n=>n===null||n===undefined||String(n).trim()===''?null:(Number.isFinite(Number(n))?Number(n):null);
const money=n=>Math.round((n+Number.EPSILON)*100)/100;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function standardPreviewDates(day,closed=[]){
 const first=nextSession(day,closed);return [first,nextSession(first,closed)];
}
export function emptyPreview(day,closed=[]){return {
 spot:'',ivPct:'',ivManual:false,bid:'',ask:'',tickerLinked:true,tickerLinkEstablished:false,tickerPlanEditedAt:'',ratePct:'4',dividendPct:'0',quoteAt:'',quoteSource:'Manual inputs',
 dates:standardPreviewDates(day,closed),
 targets:[{id:'stop',name:'Stop',price:''},{id:'tp1',name:'TP1',price:''},{id:'tp2',name:'TP2',price:''}]
};}
export function normalizePreview(raw,day,closed=[]){
 const v=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
 const base=emptyPreview(day,closed);
 const sn=(x,max=40)=>String(x===null||x===undefined?'':x).slice(0,max);
 const dates=Array.isArray(v.dates)?[...new Set(v.dates.filter(parseDay))].slice(0,MAX_PREVIEW_DATES):[];
 const targets=Array.isArray(v.targets)?v.targets.filter(x=>x&&typeof x==='object'&&typeof x.id==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(x.id)).slice(0,MAX_PREVIEW_TARGETS).map(x=>({id:x.id,name:sn(x.name,18),price:sn(x.price,24)})):[];
 return {...base,spot:sn(v.spot),ivPct:sn(v.ivPct),ivManual:v.ivManual===true,tickerLinked:v.tickerLinked!==false,tickerLinkEstablished:v.tickerLinkEstablished===true,tickerPlanEditedAt:typeof v.tickerPlanEditedAt==='string'?v.tickerPlanEditedAt.slice(0,32):'',bid:sn(v.bid),ask:sn(v.ask),ratePct:sn(v.ratePct??'4'),dividendPct:sn(v.dividendPct??'0'),quoteAt:sn(v.quoteAt,60),quoteSource:sn(v.quoteSource??'Manual inputs',120),dates:dates.length?dates:base.dates,targets:targets.length?targets:base.targets};
}
export function buildOCCSymbol(contract){
 const ticker=String(contract?.ticker||'').trim().toUpperCase();
 const strike=Number(contract?.strike),expiry=contract?.expiry;
 if(!/^[A-Z][A-Z0-9.\-]{0,10}$/.test(ticker)||!parseDay(expiry)||!['Call','Put'].includes(contract?.optionType)||!Number.isFinite(strike)||strike<=0||strike>99999.999)return null;
 const scaled=Math.round(strike*1000);
 if(Math.abs(scaled-strike*1000)>0.0001)return null;
 return `${ticker}${expiry.slice(2,4)}${expiry.slice(5,7)}${expiry.slice(8,10)}${contract.optionType==='Call'?'C':'P'}${String(scaled).padStart(8,'0')}`;
}
// Time point: 4pm America/New_York, including DST transitions.
export function easternCloseMs(date){
 if(!parseDay(date))return NaN;
 const anchor=new Date(`${date}T16:00:00Z`);
 const part=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'}).formatToParts(anchor).find(p=>p.type==='timeZoneName')?.value||'GMT-5';
 const match=part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
 const minutes=match?(match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3]||0)):-300;
 return Date.parse(`${date}T16:00:00Z`)-minutes*60000;
}
function erf(z){
 const sign=z<0?-1:1,x=Math.abs(z),t=1/(1+0.3275911*x);
 const poly=((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t;
 const y=1-poly*Math.exp(-x*x);
 return sign*y;
}
const cdf=x=>0.5*(1+erf(x/Math.SQRT2));
/* Approximate one-standard-deviation underlying range through the option expiry.
   This uses the IV of the SELECTED strike (skew-sensitive) and calendar time
   to 4 PM ET on expiration, not the option strike as the range center.
   It is not a probability guarantee, target, straddle price, or live forecast. */
export function expectedUnderlyingRange({spot,ivPct,expiry,asOf=new Date()}={}){
 const price=finite(spot),percent=finite(ivPct);
 const start=asOf instanceof Date?asOf.getTime():Date.parse(asOf);
 const finish=easternCloseMs(expiry);
 if(price===null||price<=0||percent===null||percent<=0||percent>1000||
  !Number.isFinite(start)||!Number.isFinite(finish)||finish<=start)return null;
 const years=(finish-start)/YEAR_MS;
 const move=price*(percent/100)*Math.sqrt(years);
 if(!Number.isFinite(move))return null;
 return {spot:price,ivPct:percent,years,days:(finish-start)/MS_DAY,
  move,movePct:move/price*100,lower:Math.max(0,price-move),upper:price+move};
}
export function blackScholes({spot,strike,years,iv,rate=0.04,dividend=0,type='Call'}){
 if(![spot,strike,years,iv,rate,dividend].every(Number.isFinite)||spot<=0||strike<=0||years<0||iv<0||!['Call','Put'].includes(type))return null;
 const call=type==='Call';
 if(years<=0)return Math.max(0,call?spot-strike:strike-spot);
 if(iv===0){const forward=spot*Math.exp((rate-dividend)*years),value=call?forward-strike:strike-forward;return Math.max(0,value)*Math.exp(-rate*years);}
 const vol=iv*Math.sqrt(years),d1=(Math.log(spot/strike)+(rate-dividend+iv*iv/2)*years)/vol,d2=d1-vol;
 const discSpot=spot*Math.exp(-dividend*years),discStrike=strike*Math.exp(-rate*years);
 const result=call?discSpot*cdf(d1)-discStrike*cdf(d2):discStrike*cdf(-d2)-discSpot*cdf(-d1);
 return Math.max(0,result);
}
export function projectOptionReturns({contract,preview,qty,entryPremium,entryFeeUsd=0,sellFeePerContractUsd=0,asOf=new Date()}){
 const asOfMs=asOf instanceof Date?asOf.getTime():Date.parse(asOf);
 const p=preview||{};
 const spot=finite(p.spot),ivPct=finite(p.ivPct),ratePct=finite(p.ratePct??4),dividendPct=finite(p.dividendPct??0);
 const expiryMs=easternCloseMs(contract?.expiry);
 const quantity=Number(qty),price=Number(entryPremium),buyFee=Number(entryFeeUsd),sellFee=Number(sellFeePerContractUsd);
 if(!buildOCCSymbol(contract))return {valid:false,reason:'Enter a complete contract such as INTC 1/15/27 70C.'};
 if(!Number.isFinite(expiryMs)||!Number.isFinite(asOfMs)||expiryMs<=asOfMs)return {valid:false,reason:'This option expires before the quote/model date.'};
 if(spot===null||spot<=0||ivPct===null||ivPct<=0||ivPct>1000)return {valid:false,reason:'Enter the current underlying price (USD) and the option’s quoted IV (%).'};
 if(ratePct===null||ratePct<0||ratePct>50||dividendPct===null||dividendPct<0||dividendPct>50)return {valid:false,reason:'Interest/dividend yield must be between 0% and 50%.'};
 if(!Number.isInteger(quantity)||quantity<=0||!(price>0)||!(buyFee>=0)||!(sellFee>=0))return {valid:false,reason:'Enter quantity, USD buy premium and fees in Quick Size Check.'};
 const dates=Array.isArray(p.dates)?p.dates:[],targets=Array.isArray(p.targets)?p.targets:[];
 const baseCost=quantity*price*100+buyFee;
 const baseYears=(expiryMs-asOfMs)/YEAR_MS;
 const modelNow=blackScholes({spot,strike:contract.strike,years:baseYears,iv:ivPct/100,rate:ratePct/100,dividend:dividendPct/100,type:contract.optionType});
 const tomorrowYears=Math.max(0,(expiryMs-asOfMs-MS_DAY)/YEAR_MS);
 const tomorrowModel=blackScholes({spot,strike:contract.strike,years:tomorrowYears,iv:ivPct/100,rate:ratePct/100,dividend:dividendPct/100,type:contract.optionType});
 const bid=finite(p.bid),ask=finite(p.ask);
 const quoted=(bid!==null&&ask!==null&&bid>=0&&ask>=bid);
 const spread=quoted?ask-bid:0;
 // Calibrate the theoretical value to the *current* mid when supplied.
 // The anchor mismatch decays to zero by expiration, preserving intrinsic payoff.
 // Without a real quote, the planned premium is only an unverified proxy.
 const anchorMid=quoted?(bid+ask)/2:price;
 const anchorLabel=quoted?'today’s indicative bid/ask midpoint':'planned premium as UNVERIFIED current-value proxy';
 const residual=anchorMid-modelNow;
 const anchor=(unadjusted,years,S)=>{
   const floor=years<=0?Math.max(0,contract.optionType==='Call'?S-contract.strike:contract.strike-S):0;
   return Math.max(floor,unadjusted+residual*clamp(years/baseYears,0,1));
 };
 const tomorrowAnchored=anchor(tomorrowModel,tomorrowYears,spot);
 const thetaNextCalendarDayUsdPerContract=money((tomorrowAnchored-anchorMid)*100);
 const scenarioTargets=[{id:"no-move",name:"No stock move",price:String(spot)},...targets];
 const cells=scenarioTargets.map(target=>({id:target.id,name:target.name,spotPrice:finite(target.price),values:dates.map(date=>{
   const t=easternCloseMs(date),S=finite(target.price);
   if(!Number.isFinite(t)||t<asOfMs)return {date,valid:false,reason:'Past date'};
   if(t>expiryMs+1000)return {date,valid:false,reason:'After expiry'};
   if(S===null||S<=0)return {date,valid:false,reason:'Add a target USD price'};
   const years=Math.max(0,(expiryMs-t)/YEAR_MS);
   const unadjustedModel=blackScholes({spot:S,strike:contract.strike,years,iv:ivPct/100,rate:ratePct/100,dividend:dividendPct/100,type:contract.optionType});
   const modelPremium=anchor(unadjustedModel,years,S);
   // Assumed half-spread discount, not an executable forecast.
   const projectedSell=Math.max(0,modelPremium-spread/2),saleProceeds=quantity*projectedSell*100-quantity*sellFee;
   const netUsd=saleProceeds-baseCost;
   return {date,valid:true,modelPremium:money(modelPremium),projectedSellPremium:money(projectedSell),returnPct:netUsd/baseCost*100,netUsd:money(netUsd),totalCostUsd:money(baseCost),usedHalfSpreadUsd:money(spread/2),dateAtExpiry:years===0};
 })}));
 return {valid:true,modelNow,anchorMid,anchorLabel,quoted,thetaNextCalendarDayUsdPerContract,baseCostUsd:money(baseCost),optionMultiplier:100,spread,ivPct,spot,quoteSource:p.quoteSource||'Manual inputs',dateHeaders:dates,rows:cells};
}
