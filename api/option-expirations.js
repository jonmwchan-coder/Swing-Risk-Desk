/* Read-only ticker/type expiration discovery. Strike is deliberately NOT required:
   the option chain is used to choose the strike after expiration selection.
   Dates come only from verified active standard Alpaca OCC contracts. */
import {buildOCCSymbol} from '../lib/option-preview.mjs';
import {regularExpirationKind,onlyRegularListedDates} from '../lib/expiry-listings.mjs';
import {dayOffset} from '../lib/calendar.mjs';

const HOME='https://swing-risk-desk-vercel-v11.vercel.app';
const DAY_MS=86400000;
const respond=(res,status,code,error)=>res.status(status).json({code,error});
const isDate=x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x||''))&&!Number.isNaN(Date.parse(x+'T00:00:00Z'));
const standardContract=(c,ticker,side)=>{
 const strike=Number(c?.strike_price),expiry=String(c?.expiration_date||'');
 if(c?.status!=='active'||c?.underlying_symbol!==ticker||String(c?.type||'').toLowerCase()!==side||
  !isDate(expiry)||!Number.isFinite(strike)||strike<=0||Number(c.size??100)!==100)return false;
 const symbol=buildOCCSymbol({ticker,expiry,strike,optionType:side==='call'?'Call':'Put'});
 return Boolean(symbol)&&String(c.symbol||'').toUpperCase()===symbol;
};
const providerError=status=>{
 const e=Error('Alpaca response '+status);e.status=status;return e;
};
async function requestContracts(query,headers,deadline){
 const remaining=deadline-Date.now();
 if(remaining<400){const e=Error('Deadline reached');e.timeout=true;throw e;}
 const url='https://paper-api.alpaca.markets/v2/options/contracts?'+new URLSearchParams(query);
 const response=await fetch(url,{headers,signal:AbortSignal.timeout(remaining)});
 if(!response.ok)throw providerError(response.status);
 const body=await response.json();
 if(!Array.isArray(body.option_contracts))throw Error('Invalid option contract response');
 return body;
}
// Fast mode: query a bounded amount of metadata for each regular calendar date,
// rather than downloading tens of thousands of strikes to discover just their dates.
// Every candidate is independently verified; unusual/adjusted roots never count.
async function discoverRegularDates(ticker,side,from,through,headers,deadline){
 const dates=[];
 for(let d=from;d<=through;d=dayOffset(d,1))if(regularExpirationKind(d))dates.push(d);
 const result=new Array(dates.length);let nextIndex=0;
 async function probeDate(date){
  let pageToken='',seen=new Set();
  for(let page=0;page<8;page++){
   const query={underlying_symbols:ticker,status:'active',type:side,expiration_date:date,limit:'50'};
   if(pageToken)query.page_token=pageToken;
   const data=await requestContracts(query,headers,deadline);
   if(data.option_contracts.some(c=>c.expiration_date===date&&standardContract(c,ticker,side)))return true;
   const next=String(data.next_page_token||'');
   if(!next)return false;
   if(seen.has(next))throw Error('Repeated expiration probe page token');
   seen.add(next);pageToken=next;
  }
  throw Error('Could not verify all contracts for an expiration');
 }
 await Promise.all(Array.from({length:Math.min(8,dates.length)},async()=>{
  while(nextIndex<dates.length){
   const i=nextIndex++;
   result[i]=await probeDate(dates[i]);
  }
 }));
 return dates.filter((_,i)=>result[i]);
}
// All mode includes special weekday expirations. Never return a truncated list
// when the provider pages/time out; missing dates are UNKNOWN, not absent.
async function discoverAllDates(ticker,side,from,through,headers,deadline){
 const dates=new Set(),seen=new Set();let pageToken='';
 for(let page=0;page<30;page++){
  const query={underlying_symbols:ticker,status:'active',type:side,
   expiration_date_gte:from,expiration_date_lte:through,limit:'10000'};
  if(pageToken)query.page_token=pageToken;
  const data=await requestContracts(query,headers,deadline);
  for(const c of data.option_contracts)if(standardContract(c,ticker,side))dates.add(c.expiration_date);
  const next=String(data.next_page_token||'');
  if(!next)return [...dates].sort();
  if(seen.has(next))throw Error('Repeated option listing page token');
  seen.add(next);pageToken=next;
 }
 throw Error('Too many contracts to verify all expirations');
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store, max-age=0');
 if(req.method!=='GET')return respond(res,405,'METHOD_NOT_ALLOWED','GET only');
 const origin=req.headers?.origin;
 if(origin&&origin!==HOME&&!/^https:\/\/swing-risk-desk-vercel-v11-[a-z0-9-]+\.vercel\.app$/i.test(origin)&&!/^http:\/\/localhost:\d+$/.test(origin))
  return respond(res,403,'ORIGIN_DENIED','Origin not allowed.');
 const ticker=String(req.query?.ticker??'').toUpperCase().trim();
 const type=String(req.query?.type??'').toLowerCase();
 const scope=String(req.query?.scope??'regular').toLowerCase();
 if(!/^[A-Z][A-Z0-9.\-]{0,10}$/.test(ticker)||!['call','put'].includes(type))
  return respond(res,400,'BAD_CONTRACT','Enter a valid ticker and Call or Put. No strike is required.');
 if(!['regular','all'].includes(scope))
  return respond(res,400,'BAD_SCOPE','Choose regular or all listed expirations.');
 const id=process.env.ALPACA_DATA_KEY_ID,secret=process.env.ALPACA_DATA_SECRET_KEY;
 if(!id||!secret)return respond(res,503,'NOT_CONFIGURED','Alpaca option listing metadata is not connected.');
 const checkedFrom=new Date().toISOString().slice(0,10);
 const checkedThrough=new Date(Date.parse(checkedFrom+'T00:00:00Z')+(scope==='regular'?366:1096)*DAY_MS).toISOString().slice(0,10);
 const headers={'APCA-API-KEY-ID':id,'APCA-API-SECRET-KEY':secret,Accept:'application/json'};
 const deadline=Date.now()+11500;
 try{
  const dates=scope==='regular'
   ?await discoverRegularDates(ticker,type,checkedFrom,checkedThrough,headers,deadline)
   :await discoverAllDates(ticker,type,checkedFrom,checkedThrough,headers,deadline);
  res.setHeader('Cache-Control','public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({
   status:'verified',ticker,type,scope,expirations:scope==='regular'?onlyRegularListedDates(dates):dates,
   checkedFrom,checkedThrough,checkedAt:new Date().toISOString(),
   provider:'Alpaca active standard option contracts',
   note:'Expirations verified for ticker and option type, not for a particular strike. Choose a strike in View chain or verify the exact contract with your broker.'
  });
 }catch(error){
  const timed=error?.timeout||error?.name==='TimeoutError'||error?.name==='AbortError'||Date.now()>=deadline;
  if(error?.status===429)return respond(res,503,'RATE_LIMITED','Alpaca is rate limiting expiration lookups. Use refresh shortly.');
  if(error?.status===401||error?.status===403)return respond(res,503,'AUTH_UNAVAILABLE','Alpaca option listing authorization is unavailable.');
  return respond(res,timed?504:502,timed?'LOOKUP_TIMEOUT':'RESULT_INCOMPLETE',
   timed?'Expiration lookup timed out; use the refresh icon to retry.':'Could not verify every expiration. Try refresh, or switch the date filter.');
 }
}
