/* Read-only on-demand option-chain liquidity view.
   OI: Alpaca paper contract metadata. Volume: delayed daily option bars.
   Bid/ask and Greeks: free indicative option snapshots, not executable OPRA.
   No brokerage action, no keys exposed, no claims about missing values. */
import {buildOCCSymbol} from '../lib/option-preview.mjs';
import {aroundStrike,heatLevels,numericOrNull} from '../lib/chain-liquidity.mjs';

const HOME='https://swing-risk-desk-vercel-v11.vercel.app';
const respond=(res,status,code,error)=>res.status(status).json({code,error});
const SYMBOL=/^[A-Z][A-Z0-9.\-]{0,10}$/;
const isoDate=s=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;
 const ms=Date.parse(s+'T00:00:00Z');
 return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===s;
};
const headersFor=(id,secret)=>({'APCA-API-KEY-ID':id,'APCA-API-SECRET-KEY':secret,Accept:'application/json'});
const quoteNumber=value=>{
 if(value===null||value===undefined||value==='')return null;
 const n=Number(value);return Number.isFinite(n)&&n>=0?n:null;
};
async function readJson(url,headers,timeout=8500){
 const r=await fetch(url,{headers,signal:AbortSignal.timeout(timeout)});
 if(!r.ok){const e=Error('Provider responded HTTP '+r.status);e.status=r.status;throw e;}
 return await r.json();
}
async function getContracts(ticker,expiry,headers){
 const all=[],seen=new Set(),deadline=Date.now()+10500;
 let token='';
 for(let page=0;page<8;page++){
  const q=new URLSearchParams({underlying_symbols:ticker,expiration_date:expiry,status:'active',limit:'2000'});
  if(token)q.set('page_token',token);
  const remaining=deadline-Date.now();
  if(remaining<400)throw Error('Expired metadata lookup deadline');
  const data=await readJson('https://paper-api.alpaca.markets/v2/options/contracts?'+q,headers,remaining);
  if(!Array.isArray(data.option_contracts))throw Error('Invalid option contracts response');
  for(const c of data.option_contracts){
   const type=String(c.type||'').toLowerCase(),strike=Number(c.strike_price);
   if(c.status!=='active'||c.underlying_symbol!==ticker||c.expiration_date!==expiry||
    !['call','put'].includes(type)||!Number.isFinite(strike)||strike<=0||Number(c.size??100)!==100)continue;
   const expected=buildOCCSymbol({ticker,expiry,strike,optionType:type==='call'?'Call':'Put'});
   // Exclude adjusted/multi-deliverable or incompatible OCC roots from the standard 100-share calculator.
   if(!expected||String(c.symbol||'').toUpperCase()!==expected)continue;
   all.push({symbol:expected,strike,type,openInterest:numericOrNull(c.open_interest),
    oiDate:isoDate(String(c.open_interest_date||''))?c.open_interest_date:null});
  }
  const next=String(data.next_page_token||'');
  if(!next)return all;
  if(seen.has(next))throw Error('Option contracts pagination repeated a token');
  seen.add(next);token=next;
 }
 throw Error('Option chain too large to verify completely');
}
async function getSnapshots(symbols,headers){
 if(!symbols.length)return {ok:true,bySymbol:{}};
 try{
  const q=new URLSearchParams({symbols:symbols.join(','),feed:'indicative'});
  const response=await readJson('https://data.alpaca.markets/v1beta1/options/snapshots?'+q,headers,9000);
  if(response.next_page_token)throw Error('Snapshot data was only partial');
  if(!response.snapshots||typeof response.snapshots!=='object')throw Error('No valid snapshots payload');
  const bySymbol={};
  for(const symbol of symbols){
   const snap=response.snapshots[symbol];
   if(!snap)continue;
   bySymbol[symbol]={
    bid:quoteNumber(snap.latestQuote?.bp),ask:quoteNumber(snap.latestQuote?.ap),
    ivPct:quoteNumber(snap.impliedVolatility)===null?null:Math.round(Number(snap.impliedVolatility)*1000)/10,
    delta:typeof snap.greeks?.delta==='number'?snap.greeks.delta:null,
    quoteAt:snap.latestQuote?.t||null
   };
  }
  return {ok:true,bySymbol};
 }catch(error){return {ok:false,bySymbol:{},message:'Indicative quotes unavailable; check your broker chain.'};}
}
async function getVolume(symbols,headers){
 if(!symbols.length)return {ok:true,bySymbol:{},volumeDate:null};
 try{
  // Free historical option data excludes roughly the most recent 15 minutes.
  // Request current or most recent trading session volume, never guess missing trades.
  const end=new Date(Date.now()-16*60*1000),start=new Date(Date.now()-10*86400000);
  const bySymbol={};let date=null,token='',page=0;const seen=new Set();
  do{
   if(++page>3)throw Error('Volume history pagination exceeded the safe limit');
   const q=new URLSearchParams({symbols:symbols.join(','),timeframe:'1Day',start:start.toISOString(),
    end:end.toISOString(),sort:'desc',limit:'10000'});
   if(token)q.set('page_token',token);
   const body=await readJson('https://data.alpaca.markets/v1beta1/options/bars?'+q,headers,9500);
   if(!body.bars||typeof body.bars!=='object')throw Error('No option bars payload');
   for(const symbol of symbols){
    const bars=body.bars[symbol];
    if(!Array.isArray(bars))continue;
    for(const bar of bars){
     const day=String(bar.t||'').slice(0,10),value=numericOrNull(bar.v);
     if(!isoDate(day)||value===null)continue;
     if(!bySymbol[symbol]||day>bySymbol[symbol].date)bySymbol[symbol]={date:day,value};
     if(!date||day>date)date=day;
    }
   }
   const next=String(body.next_page_token||'');
   if(next&&seen.has(next))throw Error('Volume pagination repeated a token');
   if(next)seen.add(next);
   token=next;
  }while(token);
  // Compare one session across strikes, not an old bar for one strike against today's for another.
  return {ok:true,bySymbol:Object.fromEntries(symbols.map(symbol=>[
   symbol,bySymbol[symbol]?.date===date?bySymbol[symbol].value:null
  ])),volumeDate:date};
 }catch(error){return {ok:false,bySymbol:{},volumeDate:null,
  message:'Volume unavailable on current data entitlement; open interest may still be shown.'};}
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store, max-age=0');
 if(req.method!=='GET')return respond(res,405,'METHOD_NOT_ALLOWED','Read-only GET requests only.');
 const origin=req.headers?.origin;
 if(origin&&origin!==HOME&&!/^https:\/\/swing-risk-desk-vercel-v11-[a-z0-9-]+\.vercel\.app$/i.test(origin)&&!/^http:\/\/localhost:\d+$/.test(origin))
  return respond(res,403,'ORIGIN_DENIED','Origin not allowed.');
 const ticker=String(req.query?.ticker||'').trim().toUpperCase();
 const expiry=String(req.query?.expiry||'').trim();
 const strikeText=String(req.query?.strike||'').trim(),centerStrike=Number(strikeText);
 if(!SYMBOL.test(ticker)||!isoDate(expiry)||!strikeText||!Number.isFinite(centerStrike)||centerStrike<=0||
  centerStrike>99999.999)return respond(res,400,'BAD_CONTRACT','Enter a ticker, future expiration, and preferred strike.');
 if(expiry<new Date().toISOString().slice(0,10))return respond(res,400,'EXPIRED','Select a current or future option expiration.');
 const id=process.env.ALPACA_DATA_KEY_ID,secret=process.env.ALPACA_DATA_SECRET_KEY;
 if(!id||!secret)return respond(res,503,'NOT_CONFIGURED','Alpaca option data is not configured in this environment.');
 const headers=headersFor(id,secret);
 let contracts;
 try{contracts=await getContracts(ticker,expiry,headers);}
 catch(error){return respond(res,error.status===429?429:502,'CONTRACTS_UNAVAILABLE',
  'Could not verify the entire option chain. No incomplete list was ranked.');}
 if(!contracts.length)return res.status(200).json({status:'empty',ticker,expiry,centerStrike,rows:[],
   message:'No active standard 100-share options found for this expiry in Alpaca.'});
 const strikes=aroundStrike(contracts.map(c=>c.strike),centerStrike);
 const selected=contracts.filter(c=>strikes.includes(c.strike));
 const symbols=selected.map(x=>x.symbol);
 const [quotes,volumes]=await Promise.all([getSnapshots(symbols,headers),getVolume(symbols,headers)]);
 const byStrike=new Map(strikes.map(strike=>[strike,{strike,call:null,put:null}]));
 for(const c of selected){
  const quote=quotes.bySymbol[c.symbol],row=byStrike.get(c.strike);
  row[c.type]={symbol:c.symbol,openInterest:c.openInterest,oiDate:c.oiDate,
   volume:volumes.bySymbol[c.symbol]??null,
   bid:quote?.bid??null,ask:quote?.ask??null,ivPct:quote?.ivPct??null,
   delta:quote?.delta??null,quoteAt:quote?.quoteAt??null};
 }
 return res.status(200).json({
  status:'ok',ticker,expiry,centerStrike,checkedAt:new Date().toISOString(),
  rows:heatLevels([...byStrike.values()]),strikeCount:contracts.length,
  displayedStrikeCount:strikes.length,highlightScope:'Displayed strikes only, ranked separately for calls/puts',
  oiDates:[...new Set(selected.map(x=>x.oiDate).filter(Boolean))].sort(),
  volumeDate:volumes.volumeDate,volumeStatus:volumes.ok?'available':'unavailable',
  quoteStatus:quotes.ok?'indicative':'unavailable',
  quoteAsOf:Object.values(quotes.bySymbol).map(q=>q.quoteAt).filter(Boolean).sort().at(-1)||null,
  note:'OI from dated contract metadata; VOL from latest shared historical session (free data delayed at least 15 minutes); bid/ask indicative and not executable. Heatmap is relative, not a guarantee of liquidity.'
 });
}
