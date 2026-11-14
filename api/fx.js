// Read-only, non-personal Bank of Canada FX proxy. No brokerage data is sent.
export default async function handler(req,res) {
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  res.setHeader('Cache-Control','s-maxage=21600, stale-while-revalidate=86400');
  try {
    const response=await fetch('https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1',{
      headers:{'Accept':'application/json'},signal:AbortSignal.timeout(8000)
    });
    if(!response.ok)throw new Error('Bank of Canada returned '+response.status);
    const body=await response.json();
    const item=body.observations?.at(-1);
    const rate=Number(item?.FXUSDCAD?.v);
    if(!Number.isFinite(rate)||rate<=0)throw new Error('Rate unavailable');
    res.status(200).json({rate,date:item.d,source:'Bank of Canada daily average',note:'Reference rate, not an IBKR executable FX rate.'});
  } catch (err) {
    res.status(502).json({error:'FX update unavailable. Enter your broker rate manually.'});
  }
}