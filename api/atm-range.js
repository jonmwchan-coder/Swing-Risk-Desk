/* Read-only, strike-independent ATM 1-sigma underlying range.
   No estimate without a valid IEX underlying trade AND an actual IV snapshot
   for the nearest active, standard 100-share ATM option contract(s).
   Never use a median chain strike as a proxy for the underlying price. */
import {buildOCCSymbol,expectedUnderlyingRange} from '../lib/option-preview.mjs';

const HOME='https://swing-risk-desk-vercel-v11.vercel.app';
const SYMBOL=/^[A-Z][A-Z0-9.\-]{0,10}$/;
const respond=(res,status,code,error)=>res.status(status).json({code,error});
const dateValid=s=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
 const ms=Date.parse(s+'T00:00:00Z');
 return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===s;
};
const validPositive=x=>x===null||x===undefined||x===''?null:Number.isFinite(Number(x))&&Number(x)>0?Number(x):null;
const standard=(c,ticker,expiry)=>{
 const strike=validPositive(c?.strike_price),type=String(c?.type||'').toLowerCase();
 if(!strike||!['call','put'].includes(type)||c.status!=='active'||
 c.underlying_symbol!==ticker||c.expiration_date!==expiry||Number(c.size??100)!==100)return null;
 const symbol=buildOCCSymbol({ticker,expiry,strike,optionType:type==='call'?'Call':'Put'});
 if(!symbol||String(c.symbol||'').toUpperCase()!==symbol)return null;
 return {symbol,strike,type};
};
async function json(url,headers,deadline){
 const remaining=deadline-Date.now();
 if(remaining<350)throw Error('ATM range lookup timed out');
 const r=await fetch(url,{headers,signal:AbortSignal.timeout(remaining)});
 if(!r.ok){const e=Error('Provider HTTP '+r.status);e.status=r.status;throw e;}
 return r.json();
}
async function nearAtmContracts(ticker,expiry,spot,headers,deadline){
 // A bounded spot-centered window is faster than downloading every strike.
 // If any strike is in this window, no strike outside can be closer.
 const band=Math.max(5,Math.min(spot*.1,50));
 const query={underlying_symbols:ticker,expiration_date:expiry,status:'active',
  strike_price_gte:String(Math.max(0.001,spot-band)),strike_price_lte:String(spot+band),limit:'1000'};
 const all=[],seen=new Set();let token='';
 for(let page=0;page<8;page++){
  const q=new URLSearchParams(query);
  if(token)q.set('page_token',token);
  const data=await json('https://paper-api.alpaca.markets/v2/options/contracts?'+q,headers,deadline);
  if(!Array.isArray(data.option_contracts))throw Error('Invalid contract metadata');
  for(const c of data.option_contracts){const v=standard(c,ticker,expiry);if(v)all.push(v);}
  const next=String(data.next_page_token||'');
  if(!next)break;
  if(seen.has(next))throw Error('Repeated contract pagination token');
  seen.add(next);token=next;
  if(page===7)throw Error('Incomplete ATM contract listing');
 }
 if(!all.length)return null;
 const strikes=[...new Set(all.map(c=>c.strike))].sort((a,b)=>a-b);
 const strike=strikes.reduce((a,b)=>Math.abs(a-spot)<=Math.abs(b-spot)?a:b);
 // No distant OTM IV masquerading as an ATM volatility estimate.
 if(Math.abs(strike-spot)>Math.max(1,spot*.05))return null;
 const pair=[...new Map(all.filter(c=>c.strike===strike).map(c=>[c.symbol,c])).values()];
 return {strike,pair};
}
const unavailable=(res,ticker,expiry,reason)=>res.status(200).json({
 status:'unavailable',ticker,expiry,reason,source:'Alpaca IEX trade and indicative option IV',
 checkedAt:new Date().toISOString()
});
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store, max-age=0');
 if(req.method!=='GET')return respond(res,405,'METHOD_NOT_ALLOWED','Read-only GET requests only');
 const origin=req.headers?.origin;
 if(origin&&origin!==HOME&&!/^https:\/\/swing-risk-desk-vercel-v11-[a-z0-9-]+\.vercel\.app$/i.test(origin)&&!/^http:\/\/localhost:\d+$/.test(origin))
  return respond(res,403,'ORIGIN_DENIED','Origin not allowed');
 const ticker=String(req.query?.ticker||'').trim().toUpperCase(),expiry=String(req.query?.expiry||'').trim();
 if(!SYMBOL.test(ticker)||!dateValid(expiry))return respond(res,400,'BAD_CONTRACT','Enter valid ticker and expiration');
 if(expiry<new Date().toISOString().slice(0,10))return unavailable(res,ticker,expiry,'Expiration has passed.');
 const id=process.env.ALPACA_DATA_KEY_ID,secret=process.env.ALPACA_DATA_SECRET_KEY;
 if(!id||!secret)return respond(res,503,'NOT_CONFIGURED','Alpaca market data is not configured.');
 const headers={'APCA-API-KEY-ID':id,'APCA-API-SECRET-KEY':secret,Accept:'application/json'};
 const deadline=Date.now()+11000;
 try{
  const stock=await json('https://data.alpaca.markets/v2/stocks/'+encodeURIComponent(ticker)+'/trades/latest?feed=iex',headers,deadline);
  const spot=validPositive(stock?.trade?.p),spotAt=stock?.trade?.t||null;
  if(spot===null)return unavailable(res,ticker,expiry,'Underlying IEX trade price unavailable. No proxy price used.');
  if(spotAt){
   const ts=Date.parse(spotAt);
   if(!Number.isFinite(ts)||Date.now()-ts>10*86400000||ts-Date.now()>86400000)
    return unavailable(res,ticker,expiry,'Underlying IEX trade is stale or has an invalid timestamp.');
  }
  const atms=await nearAtmContracts(ticker,expiry,spot,headers,deadline);
  if(!atms)return unavailable(res,ticker,expiry,'No standard near-the-money contracts verified for this expiration.');
  const symbols=atms.pair.map(c=>c.symbol);
  const q=new URLSearchParams({symbols:symbols.join(','),feed:'indicative'});
  const snapshots=await json('https://data.alpaca.markets/v1beta1/options/snapshots?'+q,headers,deadline);
  if(snapshots.next_page_token||!snapshots.snapshots||typeof snapshots.snapshots!=='object')
   throw Error('Incomplete ATM option snapshots');
  const ivs=atms.pair.map(c=>{
   const snap=snapshots.snapshots[c.symbol],iv=validPositive(snap?.impliedVolatility);
   const quoteAt=snap?.latestQuote?.t||null;
   if(iv===null||iv>10)return null;
   if(quoteAt){
    const ts=Date.parse(quoteAt);
    if(!Number.isFinite(ts)||Date.now()-ts>10*86400000||ts-Date.now()>86400000)return null;
   }
   return {side:c.type,iv,quoteAt};
  }).filter(Boolean);
  if(!ivs.length)return unavailable(res,ticker,expiry,'ATM implied volatility unavailable; no wing-IV fallback.');
  // With both sides available, use call/put midpoint; otherwise label one-sided input.
  const ivPct=ivs.reduce((sum,c)=>sum+c.iv,0)/ivs.length*100;
  const now=new Date(),range=expectedUnderlyingRange({spot,ivPct,expiry,asOf:now});
  if(!range)return unavailable(res,ticker,expiry,'Expiration passed or ATM inputs invalid.');
  const ivMethod=ivs.length===2?'ATM call/put mean':ivs[0].side==='call'?'ATM call IV only':'ATM put IV only';
  res.setHeader('Cache-Control','public, s-maxage=45, stale-while-revalidate=45');
  return res.status(200).json({
   status:'ok',ticker,expiry,spotUsd:spot,spotAt,
   atmStrike:atms.strike,atmIvPct:ivPct,ivMethod,
   ivQuoteAt:ivs.map(x=>x.quoteAt).filter(Boolean).sort().at(-1)||null,
   range:{lower:range.lower,upper:range.upper,move:range.move,movePct:range.movePct,days:range.days},
   checkedAt:now.toISOString(),
   source:'Alpaca IEX latest underlying trade and indicative standard near-ATM options',
   note:'Approximate one-standard-deviation UNDERLYING range to 4 PM ET expiration; not a guaranteed move, option-premium range or forecast. No median strike or substitute IV is used.'
  });
 }catch(error){
  if(error?.status===429)return respond(res,503,'RATE_LIMITED','ATM data provider rate limited; retry later.');
  return respond(res,502,'ATM_DATA_UNAVAILABLE','ATM underlying or option volatility could not be verified.');
 }
}
