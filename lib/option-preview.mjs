/* Date-aware, fee-aware European approximation for long US equity options.
   Model inputs are assumed, never a trade signal or a broker quote. */
import {dayOffset, nextSession, parseDay, isSession, torontoToday} from './calendar.mjs';
export const MAX_PREVIEW_DATES=6;
export const MAX_PREVIEW_TARGETS=8;
export const DEFAULT_INTRADAY_MINUTES=Object.freeze([5,15,30,60]);
// NYSE published 2026–28 early closes. Use the underlying cash close as
// a conservative model cutoff even for eligible ETFs trading 15 min later.
// https://www.nyse.com/trade/hours-calendars
const EARLY_CLOSE_DAYS=new Set(['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24']);
// Known index roots have different settlement/underlying quote semantics.
const INDEX_ROOTS=new Set(['SPX','SPXW','XSP','NANOS','NDX','NDXP','XND','RUT','RUTW','MRUT','VIX','VIXW','DJX','OEX','XEO','NQX','MXEA','MXEF','RUI','RUA','SML','MID']);
export function parseIntradayMinutes(raw){
 const values=Array.isArray(raw)?raw:typeof raw==='string'?raw.split(','):[];
 if(!values.length||values.length>MAX_PREVIEW_DATES)return null;
 const out=values.map(v=>typeof v==='number'||typeof v==='string'&&/^\s*\d+\s*$/.test(v)?Number(v):NaN);
 if(out.some(v=>!Number.isInteger(v)||v<1||v>1440)||new Set(out).size!==out.length)return null;
 return out.sort((a,b)=>a-b);
}
export function intradayMinutes(raw){return parseIntradayMinutes(raw)||[...DEFAULT_INTRADAY_MINUTES];}
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
 dates:standardPreviewDates(day,closed),intradayMinutes:[...DEFAULT_INTRADAY_MINUTES],
 targets:[{id:'stop',name:'Stop',price:''},{id:'tp1',name:'TP1',price:''},{id:'tp2',name:'TP2',price:''}]
};}
export function normalizePreview(raw,day,closed=[]){
 const v=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
 const base=emptyPreview(day,closed);
 const sn=(x,max=40)=>String(x===null||x===undefined?'':x).slice(0,max);
 const dates=Array.isArray(v.dates)?[...new Set(v.dates.filter(parseDay))].slice(0,MAX_PREVIEW_DATES):[];
 const targets=Array.isArray(v.targets)?v.targets.filter(x=>x&&typeof x==='object'&&typeof x.id==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(x.id)).slice(0,MAX_PREVIEW_TARGETS).map(x=>({id:x.id,name:sn(x.name,18),price:sn(x.price,24)})):[];
 return {...base,spot:sn(v.spot),ivPct:sn(v.ivPct),ivManual:v.ivManual===true,tickerLinked:v.tickerLinked!==false,tickerLinkEstablished:v.tickerLinkEstablished===true,tickerPlanEditedAt:typeof v.tickerPlanEditedAt==='string'?v.tickerPlanEditedAt.slice(0,32):'',bid:sn(v.bid),ask:sn(v.ask),ratePct:sn(v.ratePct??'4'),dividendPct:sn(v.dividendPct??'0'),quoteAt:sn(v.quoteAt,60),quoteSource:sn(v.quoteSource??'Manual inputs',120),dates:dates.length?dates:base.dates,intradayMinutes:intradayMinutes(v.intradayMinutes),targets:targets.length?targets:base.targets};
}
export function buildOCCSymbol(contract){
 const ticker=String(contract?.ticker||'').trim().toUpperCase();
 const strike=Number(contract?.strike),expiry=contract?.expiry;
 if(!/^[A-Z][A-Z0-9.\-]{0,10}$/.test(ticker)||!parseDay(expiry)||!['Call','Put'].includes(contract?.optionType)||!Number.isFinite(strike)||strike<=0||strike>99999.999)return null;
 const scaled=Math.round(strike*1000);
 if(Math.abs(scaled-strike*1000)>0.0001)return null;
 return `${ticker}${expiry.slice(2,4)}${expiry.slice(5,7)}${expiry.slice(8,10)}${contract.optionType==='Call'?'C':'P'}${String(scaled).padStart(8,'0')}`;
}
// US Eastern wall-clock conversion, including DST transitions.
export function easternClockMs(date,hour=16,minute=0){
 if(!parseDay(date)||!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59)return NaN;
 const stamp=`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`;
 const anchor=new Date(stamp);
 const part=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'}).formatToParts(anchor).find(p=>p.type==='timeZoneName')?.value||'GMT-5';
 const match=part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
 const minutes=match?(match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3]||0)):-300;
 return Date.parse(stamp)-minutes*60000;
}
export function easternCloseMs(date){return easternClockMs(date,EARLY_CLOSE_DAYS.has(date)?13:16);}
export function sessionCloseLabel(date){return EARLY_CLOSE_DAYS.has(date)?'1 PM ET':'4 PM ET';}
// Standard equity/ETF model uses the underlying cash-session close. Expand
// an explicitly selected future expiration date into useful intraday horizons
// without modifying the user's saved date or target plan.
export function expiryDayColumns(date){
 if(!parseDay(date))return [];
 const hours=EARLY_CLOSE_DAYS.has(date)?[10,11,12]:[10,12,14];
 const close=easternCloseMs(date);
 return [...hours.map(h=>({t:easternClockMs(date,h),kind:'expiry-time'})),{t:close,kind:'expiry-close'}].map(c=>({...c,date:new Date(c.t).toISOString(),sessionDate:date}));
}
export function intradayTiming(contract,asOf=new Date(),closed=[]){
 const ms=asOf instanceof Date?asOf.getTime():typeof asOf==='number'?asOf:Date.parse(asOf);
 if(!Number.isFinite(ms)||!parseDay(contract?.expiry)||contract.expiry!==torontoToday(new Date(ms)))return null;
 const day=contract.expiry,earlyClose=EARLY_CLOSE_DAYS.has(day);
 const openMs=easternClockMs(day,9,30),cutoffMs=easternCloseMs(day);
 const unsupported=INDEX_ROOTS.has(String(contract.ticker||'').toUpperCase());
 const session=isSession(day,closed);
 return {asOfMs:ms,openMs,cutoffMs,earlyClose,session,unsupported,
  cutoffLabel:sessionCloseLabel(day),
  remainingMinutes:Math.max(0,(cutoffMs-ms)/60000),
  beforeOpen:ms<openMs,expired:ms>=cutoffMs};
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
   to the underlying cash-session close on expiration, not the option strike as the range center.
   It is not a probability guarantee, target, straddle price, or live forecast. */
export function expectedUnderlyingRange({spot,ivPct,expiry,asOf=new Date()}={}){
 const price=finite(spot),percent=finite(ivPct);
 const start=asOf instanceof Date?asOf.getTime():Date.parse(asOf);
 if(!isSession(expiry))return null;
 const finish=easternCloseMs(expiry);
 if(price===null||price<=0||percent===null||percent<=0||percent>1000||
  !Number.isFinite(start)||!Number.isFinite(finish)||finish<=start)return null;
 const years=(finish-start)/YEAR_MS;
 const move=price*(percent/100)*Math.sqrt(years);
 if(!Number.isFinite(move))return null;
 return {spot:price,ivPct:percent,years,days:(finish-start)/MS_DAY,
  move,movePct:move/price*100,lower:Math.max(0,price-move),upper:price+move,cutoffLabel:sessionCloseLabel(expiry)};
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
export function projectOptionReturns({contract,preview,qty,entryPremium,entryFeeUsd=0,sellFeePerContractUsd=0,asOf=new Date(),allowEntryAnchor=true,closed=[]}){
 const asOfMs=asOf instanceof Date?asOf.getTime():typeof asOf==='number'?asOf:Date.parse(asOf);
 const p=preview||{};
 const spot=finite(p.spot),ivPct=finite(p.ivPct),ratePct=finite(p.ratePct??4),dividendPct=finite(p.dividendPct??0);
 const intraday=intradayTiming(contract,asOf,closed);
 const expiryMs=intraday?.cutoffMs??easternCloseMs(contract?.expiry);
 const quantity=Number(qty),price=Number(entryPremium),buyFee=Number(entryFeeUsd),sellFee=Number(sellFeePerContractUsd);
 if(!buildOCCSymbol(contract))return {valid:false,reason:'Enter a complete contract such as INTC 1/15/27 70C.'};
 if(intraday?.unsupported)return {valid:false,reason:'Same-day index option settlement and quote support are not verified. Use a supported standard equity/ETF contract; no SPX/SPXW or other known index-root estimate is generated.'};
 if(intraday&&!intraday.session)return {valid:false,reason:'No regular trading session on this expiration date. Check the exact contract and exchange calendar.'};
 if(!Number.isFinite(expiryMs)||!Number.isFinite(asOfMs)||expiryMs<=asOfMs)return {valid:false,reason:intraday?'The same-day model cutoff ('+intraday.cutoffLabel+') has passed.':'This option expires before the quote/model date.'};
 if(spot===null||spot<=0||ivPct===null||ivPct<=0||ivPct>1000)return {valid:false,reason:'Enter the current underlying price (USD) and the option’s quoted IV (%).'};
 if(ratePct===null||ratePct<0||ratePct>50||dividendPct===null||dividendPct<0||dividendPct>50)return {valid:false,reason:'Interest/dividend yield must be between 0% and 50%.'};
 if(!Number.isInteger(quantity)||quantity<=0||!(price>0)||!(buyFee>=0)||!(sellFee>=0))return {valid:false,reason:'Enter quantity, USD buy premium and fees in Quick Size Check.'};
 const dates=Array.isArray(p.dates)?p.dates:[],targets=Array.isArray(p.targets)?p.targets:[];
 const offsets=intraday?intradayMinutes(p.intradayMinutes):[];
 const knownIndex=INDEX_ROOTS.has(String(contract.ticker||'').toUpperCase());
 const columns=intraday?[...offsets.map(minutes=>({minutes,t:asOfMs+minutes*60000,kind:'minutes'})),{minutes:null,t:expiryMs,kind:'cutoff'}].map(c=>({...c,date:new Date(c.t).toISOString(),sessionDate:contract.expiry,label:c.kind==='cutoff'?'Close':'+'+c.minutes+'m',afterExpiry:c.t>expiryMs,beforeOpen:c.t<intraday.openMs})):dates.flatMap(date=>{
  if(date===contract.expiry&&!knownIndex&&isSession(date,closed))return expiryDayColumns(date);
  return [{date,sessionDate:date,t:easternCloseMs(date),kind:'date'}];
 });
 const hasExpiryDayTimes=columns.some(c=>c.kind==='expiry-time');
 const baseCost=quantity*price*100+buyFee;
 const baseYears=(expiryMs-asOfMs)/YEAR_MS;
 const modelNow=blackScholes({spot,strike:contract.strike,years:baseYears,iv:ivPct/100,rate:ratePct/100,dividend:dividendPct/100,type:contract.optionType});
 const tomorrowYears=Math.max(0,(expiryMs-asOfMs-MS_DAY)/YEAR_MS);
 const tomorrowModel=blackScholes({spot,strike:contract.strike,years:tomorrowYears,iv:ivPct/100,rate:ratePct/100,dividend:dividendPct/100,type:contract.optionType});
 const bid=finite(p.bid),ask=finite(p.ask);
 const quoted=(bid!==null&&ask!==null&&bid>=0&&ask>=bid&&ask>0);
 const spread=quoted?ask-bid:0;
 // Calibrate the theoretical value to the *current* mid when supplied.
 // The anchor mismatch decays to zero by expiration, preserving intrinsic payoff.
 // Without a real quote, the planned premium is only an unverified proxy.
 const anchorMid=quoted?(bid+ask)/2:allowEntryAnchor?price:modelNow;
 const anchorLabel=quoted?'indicative bid/ask midpoint':allowEntryAnchor?'planned premium as UNVERIFIED current-value proxy':'unanchored theoretical value (no valid option quote; not the entry premium)';
 const residual=anchorMid-modelNow;
 const anchor=(unadjusted,years,S)=>{
   // Standard American-style long equity/ETF contracts have immediate exercise value.
   // Quote calibration must never wipe out that intrinsic value.
   const floor=years<=0||!knownIndex?Math.max(0,contract.optionType==='Call'?S-contract.strike:contract.strike-S):0;
   return Math.max(floor,unadjusted+residual*clamp(years/baseYears,0,1));
 };
 const tomorrowAnchored=anchor(tomorrowModel,tomorrowYears,spot);
 const thetaNextCalendarDayUsdPerContract=money((tomorrowAnchored-anchorMid)*100);
 const thetaIntraday=intraday?[5,15,30].map(minutes=>{
  const t=asOfMs+minutes*60000;
  if(t>expiryMs)return {minutes,usdPerContract:null};
  const years=(expiryMs-t)/YEAR_MS,raw=blackScholes({spot,strike:contract.strike,years,iv:ivPct/100,rate:ratePct/100,dividend:dividendPct/100,type:contract.optionType});
  return {minutes,usdPerContract:money((anchor(raw,years,spot)-anchorMid)*100)};
 }):[];
 const quoteAgeMinutes=intraday&&Number.isFinite(Date.parse(p.quoteAt))?(asOfMs-Date.parse(p.quoteAt))/60000:null;
 const scenarioTargets=[{id:"no-move",name:"No stock move",price:String(spot)},...targets];
 const cells=scenarioTargets.map(target=>({id:target.id,name:target.name,spotPrice:finite(target.price),values:columns.map(column=>{
   const {date,t}=column,S=finite(target.price);
   if(!Number.isFinite(t)||t<asOfMs)return {date,valid:false,reason:'Past date'};
   if(t>expiryMs+(intraday?0:1000))return {date,valid:false,reason:intraday?'After same-day model cutoff':'After expiry'};
   if(!isSession(column.sessionDate,closed))return {date,valid:false,reason:'Market closed on selected date'};
   if(S===null||S<=0)return {date,valid:false,reason:'Add a target USD price'};
   const years=Math.max(0,(expiryMs-t)/YEAR_MS);
   const unadjustedModel=blackScholes({spot:S,strike:contract.strike,years,iv:ivPct/100,rate:ratePct/100,dividend:dividendPct/100,type:contract.optionType});
   const modelPremium=anchor(unadjustedModel,years,S);
   // Assumed half-spread discount, not an executable forecast.
   const projectedSell=Math.max(0,modelPremium-spread/2),saleProceeds=quantity*projectedSell*100-quantity*sellFee;
   const netUsd=saleProceeds-baseCost;
   return {date,valid:true,modelPremium:money(modelPremium),intrinsicPremium:money(Math.max(0,contract.optionType==='Call'?S-contract.strike:contract.strike-S)),projectedSellPremium:money(projectedSell),returnPct:netUsd/baseCost*100,netUsd:money(netUsd),totalCostUsd:money(baseCost),usedHalfSpreadUsd:money(spread/2),dateAtExpiry:years===0};
 })}));
 return {valid:true,modelNow,anchorMid,anchorLabel,quoted,thetaNextCalendarDayUsdPerContract,baseCostUsd:money(baseCost),optionMultiplier:100,spread,ivPct,spot,quoteSource:p.quoteSource||'Manual inputs',dateHeaders:columns.map(c=>c.date),columns,intraday,hasExpiryDayTimes,expiryCutoffLabel:sessionCloseLabel(contract.expiry),thetaIntraday,quoteAgeMinutes,rows:cells};
}
