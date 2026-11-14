// IBKR Flex-style trade CSV reader. Preserve every original source column for provenance.
export function parseCsv(text) {
  const rows=[];let row=[],field='',inQuotes=false;
  const s=String(text||'').replace(/^\uFEFF/,'');
  for(let i=0;i<s.length;i++){
    const ch=s[i];
    if(inQuotes){if(ch==='"'&&s[i+1]==='"'){field+='"';i++;}else if(ch==='"')inQuotes=false;else field+=ch;}
    else if(ch==='"')inQuotes=true;
    else if(ch===','){row.push(field);field='';}
    else if(ch==='\n'){row.push(field.replace(/\r$/,''));if(row.some(v=>v.trim()))rows.push(row);row=[];field='';}
    else field+=ch;
  }
  if(inQuotes)throw new Error('CSV has a quoted value that was not closed.');
  row.push(field.replace(/\r$/,''));if(row.some(v=>v.trim()))rows.push(row);
  return rows;
}
export function isIbkrCsv(text){
  const r=parseCsv(text);const h=(r[0]||[]).map(x=>x.trim().toLowerCase());
  return ['clientaccountid','symbol','buy/sell','assetclass','date/time'].every(x=>h.includes(x));
}
export function occContract(symbol){
  const cleaned=String(symbol||'').toUpperCase().trim();
  const m=cleaned.match(/^([A-Z0-9.\-]+)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if(!m)return null;
  const year=2000+Number(m[2]);const month=Number(m[3]);const day=Number(m[4]);
  const expiry=`${year}-${m[3]}-${m[4]}`;
  const probe=new Date(`${expiry}T12:00:00Z`);
  if(!Number.isFinite(probe.getTime())||probe.getUTCFullYear()!==year||probe.getUTCMonth()+1!==month||probe.getUTCDate()!==day)return null;
  return {ticker:m[1],expiry,optionType:m[5]==='P'?'Put':'Call',strike:Number(m[6])/1000,raw:cleaned};
}
const number=v=>{const n=Number(String(v??'').replace(/[,$]/g,'').trim());return Number.isFinite(n)?n:null;};
const r4=n=>Number(Number(n||0).toFixed(5));
const compact=key=>String(key).trim().toUpperCase();
const dateIso=s=>/^[0-9]{8}$/.test(s)?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:/^\d{4}-\d{2}-\d{2}$/.test(s)?s:null;
function timeInfo(str){
  const src=String(str||'').trim();
  const m=src.match(/^(\d{8})\s*;\s*(\d{2}):?(\d{2}):?(\d{2})$/);
  if(!m)return null;
  if(Number(m[2])>23||Number(m[3])>59||Number(m[4])>59)return null;
  return {date:dateIso(m[1]),time:`${m[2]}:${m[3]}:${m[4]}`};
}
export function parseIbkrTrades(text){
  const rows=parseCsv(text);
  if(rows.length<2)throw new Error('The IBKR file has no trade rows.');
  const headers=rows[0].map(h=>h.trim());const lower=headers.map(h=>h.toLowerCase());
  for(const col of ['clientaccountid','symbol','buy/sell','quantity','price','commission','assetclass','tradedate','date/time'])if(!lower.includes(col))throw new Error(`IBKR CSV missing ${col}.`);
  const occurrences=new Map(),trades=[],errors=[];
  for(let index=1;index<rows.length;index++){
    const row=rows[index],raw=Object.fromEntries(headers.map((h,i)=>[h,row[i]??'']));
    const val=name=>String(row[lower.indexOf(name.toLowerCase())]??'').trim();
    const account=val('ClientAccountID').toUpperCase(),symbol=compact(val('Symbol')),
      side=val('Buy/Sell').toUpperCase(),assetClass=val('AssetClass').toUpperCase(),currency=val('CurrencyPrimary').toUpperCase()||'USD';
    const contract=occContract(symbol),qt=number(val('Quantity')),px=number(val('Price')),comm=number(val('Commission')),
      netCash=number(val('NetCash')),dt=timeInfo(val('Date/Time')),tradeDate=dateIso(val('TradeDate'));
    const trade={raw,account,symbol,side,assetClass,currency,contract,qty:Math.abs(qt||0),price:px,fee:comm===null?null:Math.abs(comm),commission:comm,netCash,tradeDate:tradeDate||dt?.date||'',time:dt?.time||'',rowNumber:index+1};
    const reason=!account?'Missing IBKR account':!['BUY','SELL'].includes(side)?'Unsupported trade side':assetClass!=='OPT'?'Non-option transaction':currency!=='USD'?'Non-USD contract':!contract?'Unsupported option symbol format':!tradeDate||!dt?'Missing/invalid execution date or time':dt?.date!==tradeDate?'TradeDate and Date/Time disagree':!Number.isInteger(trade.qty)||trade.qty<1?'Invalid contract quantity':px===null||px<0?'Missing/invalid premium price':trade.fee===null?'Missing/invalid commission':'';
    const signature=[account,symbol,side,trade.tradeDate,trade.time,trade.qty,r4(px),r4(comm),r4(netCash)].join('|');
    const ordinal=(occurrences.get(signature)||0)+1;occurrences.set(signature,ordinal);
    // Occurrence is necessary because IBKR examples do not contain execution IDs.
    trade.sourceKey=`ibkr-v1:${signature}|${ordinal}`;
    if(reason){errors.push({...trade,reason});continue;}
    trades.push(trade);
  }
  trades.sort((a,b)=>`${a.tradeDate}T${a.time}`.localeCompare(`${b.tradeDate}T${b.time}`)||a.rowNumber-b.rowNumber);
  return {trades,errors,totalRows:rows.length-1,repeatedSignatures:[...occurrences.values()].filter(x=>x>1).length};
}
export function contractMatches(p,t){
  return (p.ticker||'').toUpperCase()===t.contract.ticker&&p.optionType===t.contract.optionType&&
    Number(p.strike)===t.contract.strike&&p.expiry===t.contract.expiry;
}
export function transactionMatches(tx,trade){
  if(tx?.broker?.sourceKey===trade.sourceKey)return true;
  const exactTime=String(tx.time||'')===trade.time;
  // The manual editor may have had no time. Old exports stored the 23:59
  // sentinel, while new entries explicitly mark timeUnverified. Require all
  // economics to match; multiple candidates are quarantined upstream.
  const unverifiedManual=!tx.broker?.sourceKey&&(tx.timeUnverified===true||String(tx.time||'')==='23:59'||String(tx.time||'')==='');
  const sameDay=tx.date===trade.tradeDate&&(exactTime||unverifiedManual);
  return sameDay&&Number(tx.qty)===trade.qty&&Math.abs(Number(tx.price)-trade.price)<0.00001&&Math.abs(Number(tx.fee||0)-trade.fee)<0.00001;
}