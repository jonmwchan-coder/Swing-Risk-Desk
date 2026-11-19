/* Optional read-only Alpaca Basic indicative option snapshot. Env-only keys.
   This endpoint never uses trading APIs or places orders. */
const allowedOrigin='https://swing-risk-desk-vercel-v11.vercel.app';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store, max-age=0');
 if(req.method!=='GET')return res.status(405).json({error:'GET only'});
 const origin=req.headers?.origin;
 if(origin && origin!==allowedOrigin && !/^http:\/\/localhost:\d+$/.test(origin))return res.status(403).json({error:'Origin not allowed'});
 const symbol=String(req.query?.symbol||'').toUpperCase();
 if(!/^[A-Z][A-Z0-9.\-]{0,10}\d{6}[CP]\d{8}$/.test(symbol))return res.status(400).json({error:'Enter a standard U.S. option contract first.'});
 const id=process.env.ALPACA_DATA_KEY_ID,secret=process.env.ALPACA_DATA_SECRET_KEY;
 if(!id||!secret)return res.status(503).json({code:'NOT_CONFIGURED',error:'One-time free Alpaca Paper Only market-data setup is required. Add server-side API credentials in Vercel Environment Variables; no funded brokerage account is needed.'});
 const headers={'APCA-API-KEY-ID':id,'APCA-API-SECRET-KEY':secret,Accept:'application/json'};
 try{
  const optionUrl=`https://data.alpaca.markets/v1beta1/options/snapshots?symbols=${encodeURIComponent(symbol)}&feed=indicative`;
  const stockSymbol=symbol.slice(0,Math.max(1,symbol.search(/\d{6}[CP]\d{8}$/)));
  const stockUrl=`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(stockSymbol)}/trades/latest?feed=iex`;
  const [optionResponse,stockResponse]=await Promise.allSettled([
    fetch(optionUrl,{headers,signal:AbortSignal.timeout(9000)}),
    fetch(stockUrl,{headers,signal:AbortSignal.timeout(9000)})
  ]);
  if(optionResponse.status!=='fulfilled')throw Error('Option quote service timed out');
  const r=optionResponse.value;
  if(!r.ok){if(r.status===401||r.status===403)return res.status(502).json({error:'Alpaca market-data authorization failed. Check free Basic API credentials and entitlements.'});throw Error('Indicative option snapshot unavailable (HTTP '+r.status+').');}
  const data=await r.json();const snap=data.snapshots?.[symbol];
  if(!snap)return res.status(404).json({error:'No indicative snapshot for that exact contract. Enter today’s spot and IV manually.'});
  const numeric=n=>Number.isFinite(Number(n))&&n!==null&&n!==undefined?Number(n):null;
  const b=numeric(snap.latestQuote?.bp),a=numeric(snap.latestQuote?.ap),iv=numeric(snap.impliedVolatility);
  let spot=null,spotAt=null;
  if(stockResponse.status==='fulfilled' && stockResponse.value.ok){const stock=await stockResponse.value.json();spot=numeric(stock.trade?.p);spotAt=stock.trade?.t||null;}
  const quoteAt=snap.latestQuote?.t||null;
  return res.status(200).json({
    provider:'Alpaca Basic indicative options / IEX underlying',quoteType:'INDICATIVE_NOT_OPRA',
    note:'Indicative option prices are modified and not executable OPRA bid/ask; underlying IEX trade is not consolidated NBBO.',
    symbol,optionBidUsd:b!==null&&b>=0?b:null,optionAskUsd:a!==null&&a>=0?a:null,
    ivPct:iv!==null&&iv>0?iv*100:null,thetaPerSharePerDay:numeric(snap.greeks?.theta),
    spotUsd:spot!==null&&spot>0?spot:null,quoteAt,underlyingAt:spotAt,requestedAt:new Date().toISOString(),
    missingIv:iv===null||iv<=0
  });
 }catch(err){return res.status(502).json({error:'Free indicative quote unavailable. Enter today’s values manually. ('+String(err.message||'provider error').slice(0,120)+')'});}
}
