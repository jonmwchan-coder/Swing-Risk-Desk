/* Read-only exact contract validation through Alpaca's paper trading metadata endpoint. */
const permittedOrigin='https://swing-risk-desk-vercel-v11.vercel.app';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store, max-age=0');
 if(req.method!=='GET')return res.status(405).json({error:'GET only'});
 const origin=req.headers?.origin;
 if(origin&&origin!==permittedOrigin&&!/^http:\/\/localhost:\d+$/.test(origin))return res.status(403).json({error:'Origin not allowed'});
 const symbol=String(req.query?.symbol||'').toUpperCase();
 if(!/^[A-Z][A-Z0-9.\-]{0,10}\d{6}[CP]\d{8}$/.test(symbol))return res.status(400).json({error:'Enter a complete standard option contract.'});
 const key=process.env.ALPACA_DATA_KEY_ID,secret=process.env.ALPACA_DATA_SECRET_KEY;
 if(!key||!secret)return res.status(503).json({code:'NOT_CONFIGURED',error:'Alpaca credentials not configured'});
 try{
  const response=await fetch('https://paper-api.alpaca.markets/v2/options/contracts/'+encodeURIComponent(symbol),{
   headers:{'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret,Accept:'application/json'},
   signal:AbortSignal.timeout(9000)
  });
  if(response.status===404)return res.status(404).json({code:'CONTRACT_NOT_FOUND',error:'This exact option contract was not found in Alpaca. Verify ticker, expiration, strike and type.'});
  if(!response.ok)return res.status(502).json({code:'VALIDATION_UNAVAILABLE',error:'Alpaca contract validation unavailable; quote may still be requested, but contract listing is unverified.'});
  const data=await response.json();
  if(data.symbol!==symbol||data.status!=='active')return res.status(422).json({code:'CONTRACT_NOT_ACTIVE',error:'Selected contract is not active in Alpaca.'});
  return res.status(200).json({symbol,validated:true,underlying:data.underlying_symbol,expiration:data.expiration_date,strike:Number(data.strike_price),type:data.type,multiplier:Number(data.size||data.multiplier||100),source:'Alpaca contract metadata'});
 }catch{return res.status(502).json({code:'VALIDATION_UNAVAILABLE',error:'Alpaca contract validation timed out; live listing unverified.'});}
}
