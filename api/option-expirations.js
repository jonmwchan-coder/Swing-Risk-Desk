/* Read-only option expiration discovery for a specific ticker, strike and side.
   NEVER infer existence from a missing indicative quote. Alpaca contract metadata
   is the listing authority for this UI; it is not a broker-wide OPRA guarantee. */
import {buildOCCSymbol} from '../lib/option-preview.mjs';

const home='https://swing-risk-desk-vercel-v11.vercel.app';
const DAY_MS=86400000;
const err=(res,status,code,message)=>res.status(status).json({code,error:message});

export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store, max-age=0');
 if(req.method!=='GET')return err(res,405,'METHOD_NOT_ALLOWED','GET only');
 const origin=req.headers?.origin;
 if(origin&&origin!==home&&!/^https:\/\/swing-risk-desk-vercel-v11-[a-z0-9-]+\.vercel\.app$/i.test(origin)&&!/^http:\/\/localhost:\d+$/.test(origin))return err(res,403,'ORIGIN_DENIED','Origin not allowed');
 const ticker=String(req.query?.ticker??'').toUpperCase().trim();
 const rawStrike=String(req.query?.strike??'').trim(),strike=Number(rawStrike);
 const optionType=String(req.query?.type??'').toLowerCase();
 if(!/^[A-Z][A-Z0-9.\-]{0,10}$/.test(ticker)||!rawStrike||!Number.isFinite(strike)||strike<=0||strike>99999.999||Math.abs(strike*1000-Math.round(strike*1000))>1e-5||!['call','put'].includes(optionType))return err(res,400,'BAD_CONTRACT','Enter a valid ticker, positive strike (up to 3 decimals), and Call or Put.');
 const id=process.env.ALPACA_DATA_KEY_ID,secret=process.env.ALPACA_DATA_SECRET_KEY;
 if(!id||!secret)return err(res,503,'NOT_CONFIGURED','Alpaca option listing lookup is not connected. Configure the existing server-side Alpaca data keys.');
 const checkedFrom=new Date().toISOString().slice(0,10);
 const checkedThrough=new Date(Date.parse(checkedFrom+'T00:00:00Z')+1096*DAY_MS).toISOString().slice(0,10);
 const headers={'APCA-API-KEY-ID':id,'APCA-API-SECRET-KEY':secret,Accept:'application/json'};
 const expirations=new Set();
 let pageToken='',pageCount=0;
 const visited=new Set(),deadline=Date.now()+8500;
 try{
  do{
   if(++pageCount>6)return err(res,503,'RESULT_INCOMPLETE','Too many option contracts to verify all expirations. No dates have been excluded; try your broker chain.');
   const query=new URLSearchParams({
    underlying_symbols:ticker,status:'active',type:optionType,strike_price_gte:String(strike),
    strike_price_lte:String(strike),expiration_date_gte:checkedFrom,expiration_date_lte:checkedThrough,limit:'1000'
   });
   if(pageToken)query.set('page_token',pageToken);
   const remaining=deadline-Date.now();
   if(remaining<500)return err(res,504,'LOOKUP_TIMEOUT','Option listing lookup timed out; contract availability is unverified.');
   const response=await fetch('https://paper-api.alpaca.markets/v2/options/contracts?'+query,{
    headers,signal:AbortSignal.timeout(remaining)
   });
   if(response.status===401||response.status===403)return err(res,503,'AUTH_UNAVAILABLE','Alpaca option metadata authorization failed. Listing status is unverified.');
   if(response.status===429)return err(res,503,'RATE_LIMITED','Option listing provider is temporarily rate limited. Try again soon.');
   if(!response.ok)return err(res,502,'PROVIDER_UNAVAILABLE','Alpaca options contract lookup is temporarily unavailable. No assumption about listing status was made.');
   const body=await response.json();
   if(!Array.isArray(body.option_contracts))return err(res,502,'INVALID_RESPONSE','Option listing response was incomplete; could not verify dates.');
   for(const c of body.option_contracts){
    const expiry=String(c.expiration_date||''),symbol=buildOCCSymbol({ticker,expiry,strike,optionType:optionType==='call'?'Call':'Put'});
    // Ignore adjusted roots and deliverables not compatible with our 100-share model/OCC symbol.
    if(!symbol||String(c.symbol||'').toUpperCase()!==symbol||c.status!=='active'||c.underlying_symbol!==ticker
     ||String(c.type||'').toLowerCase()!==optionType||Math.abs(Number(c.strike_price)-strike)>0.00001
     ||Number(c.size??100)!==100)continue;
    expirations.add(expiry);
   }
   const next=String(body.next_page_token||'');
   if(next&&visited.has(next))return err(res,502,'INVALID_RESPONSE','Option listing pagination did not finish; dates are unverified.');
   if(next)visited.add(next);
   pageToken=next;
  }while(pageToken);
  return res.status(200).json({
   ticker,strike,type:optionType,expirations:[...expirations].sort(),checkedFrom,checkedThrough,
   checkedAt:new Date().toISOString(),status:'verified',provider:'Alpaca active standard option contracts',
   note:'Listed contracts only; a valid contract may have no indicative quote. Verify availability with your broker before trading.'
  });
 }catch(error){
  const timeout=error?.name==='TimeoutError'||error?.name==='AbortError'||Date.now()>=deadline;
  return err(res,timeout?504:502,timeout?'LOOKUP_TIMEOUT':'PROVIDER_UNAVAILABLE',
   timeout?'Option listing lookup timed out; dates unverified.':'Could not reach option listing provider; dates unverified.');
 }
}
