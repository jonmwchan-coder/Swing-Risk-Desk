/* Pure, non-interactive HTML view for the on-demand option-chain panel.
   No trading actions occur here: buttons only raise app-level draft selection. */
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const number=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('en-US'):'—';
const price=value=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(2):'—';
const percent=value=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(1)+'%':'—';
const delta=value=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(3):'—';
const dateText=iso=>/^\d{4}-\d{2}-\d{2}$/.test(String(iso||''))?
 new Date(iso+'T12:00:00Z').toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}):'not reported';
function td(value,heat=0,kind=''){
 return '<td class="chain-num '+(heat?'chain-heat-'+heat:'')+'" title="'+esc(heat?'High relative '+kind+' among displayed strikes':'')+'">'+esc(value)+'</td>';
}
function record(row,side){return row?.[side]||{};}
function pick(id,strike,side,selected){
 return '<button type="button" class="chain-use-contract'+(selected?' selected':'')+'" data-action="pick-chain-contract" data-plan-id="'+esc(id)+'" data-strike="'+esc(strike)+'" data-side="'+esc(side)+'" title="Use '+esc(strike)+' '+esc(side)+' in this Quick Size Check idea">'+(selected?'✓ Use':'Use')+'</button>';
}
// Nonselectable underlying marker, independent of the selected option.
export function chainSpotLocation(rows,spot){
 if(typeof spot!=='number'||!Number.isFinite(spot)||spot<=0||!rows?.length)return null;
 const first=rows.findIndex(row=>row.strike>=spot);
 if(first<0)return {index:rows.length,relation:'above'};
 if(rows[first].strike===spot)return {index:first,relation:'at'};
 if(first===0)return {index:0,relation:'below'};
 return {index:first,relation:'between'};
}
function spotMarker(data,location,colspan){
 const spot='$'+price(data.underlyingSpotUsd);
 const relation=location.relation==='above'?'Above displayed strikes':location.relation==='below'?'Below displayed strikes':location.relation==='at'?'At next strike':'Between strikes';
 return `<tr class="chain-spot-marker" aria-label="Underlying price ${esc(spot)}; ${esc(relation)}"><td colspan="${colspan}"><div class="chain-spot-marker-content"><span class="chain-spot-line"></span><strong>◆ ${esc(data.ticker)} underlying ${esc(spot)}</strong><small>${esc(relation)}${location.relation==='above'||location.relation==='below'?' · use All strikes for wider range':''}</small><span class="chain-spot-line"></span></div></td></tr>`;
}
function ladderRows(rows,idea,data,side=null){
 const loc=chainSpotLocation(rows,data.underlyingSpotUsd);
 const out=rows.map(row=>side?mobileRow(row,idea,side):desktopRow(row,idea));
 if(loc)out.splice(loc.index,0,spotMarker(data,loc,side?7:15));
 return out.join('');
}
function spotSummary(idea,data){
 const spot=data.underlyingSpotUsd,valid=typeof spot==='number'&&Number.isFinite(spot)&&spot>0;
 const timestamp=typeof data.underlyingAt==='string'&&Number.isFinite(Date.parse(data.underlyingAt))?new Date(data.underlyingAt).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'})+' ET':'Time unavailable';
 const selected=String(idea.strike??'').trim()&&Number(idea.strike)>0?'$'+number(Number(idea.strike))+' '+idea.optionType:'None';
 return `<div class="chain-price-key"><div class="chain-spot-key"><strong>◆ ${esc(idea.ticker)} underlying ${valid?'$'+price(spot):'unavailable'}</strong><small>${esc(valid?(data.underlyingSource||'IEX')+' · '+timestamp+' · not consolidated':'No underlying snapshot returned; no price marker shown')}</small></div><div class="chain-selected-key"><strong>✓ Selected contract: ${esc(selected)}</strong><small>Green highlight · separate from underlying price</small></div></div>`;
}
function desktopRow(row,idea){
 const call=record(row,'call'),put=record(row,'put'),strike=number(row.strike);
 const isCall=Number(idea.strike)===row.strike&&idea.optionType==='Call';
 const isPut=Number(idea.strike)===row.strike&&idea.optionType==='Put';
 const c=Boolean(row.call),p=Boolean(row.put);
 return '<tr class="'+(isCall||isPut?'chain-selected-row':'')+'">'+
  td(c?number(call.volume):'—',call.volumeHeat||0,'call volume')+
  td(c?number(call.openInterest):'—',call.oiHeat||0,'call open interest')+
  td(c?price(call.bid):'—')+td(c?price(call.ask):'—')+
  td(c?percent(call.ivPct):'—')+td(c?delta(call.delta):'—')+
  '<td class="chain-use-cell">'+(c?pick(idea.id,row.strike,'Call',isCall):'')+'</td>'+
  '<th scope="row" class="chain-strike">'+esc(strike)+'</th>'+
  '<td class="chain-use-cell">'+(p?pick(idea.id,row.strike,'Put',isPut):'')+'</td>'+
  td(p?delta(put.delta):'—')+td(p?percent(put.ivPct):'—')+
  td(p?price(put.bid):'—')+td(p?price(put.ask):'—')+
  td(p?number(put.openInterest):'—',put.oiHeat||0,'put open interest')+
  td(p?number(put.volume):'—',put.volumeHeat||0,'put volume')+'</tr>';
}
function mobileRow(row,idea,side){
 const rec=record(row,side.toLowerCase()),active=Boolean(row[side.toLowerCase()]);
 const selected=Number(idea.strike)===row.strike&&idea.optionType===side;
 return '<tr class="'+(selected?'chain-selected-row':'')+'">'+
  '<th scope="row" class="chain-strike">'+esc(number(row.strike))+'</th>'+
  td(active?number(rec.volume):'—',rec.volumeHeat||0,'volume')+
  td(active?number(rec.openInterest):'—',rec.oiHeat||0,'open interest')+
  td(active?price(rec.bid):'—')+td(active?price(rec.ask):'—')+
  td(active?percent(rec.ivPct):'—')+
  '<td class="chain-use-cell">'+(active?pick(idea.id,row.strike,side,selected):'')+'</td></tr>';
}
const header=(idea,subtitle,scope='nearby',atmRange=null)=>'<div class="option-preview-heading chain-panel-heading"><div class="preview-title-stack">'+
 '<div class="overline">OPTIONS · LIQUIDITY LADDER</div><div class="chain-date-range-row">'+
 '<h3>'+esc(idea.ticker||'Ticker')+' · '+esc(idea.expiry||'Select expiration')+'</h3>'+
 '<span class="chain-atm-range" data-expected-range data-range-status="'+esc(atmRange?.state||'unavailable')+
  '" title="'+esc(atmRange?.title||'Requires valid underlying price and near-ATM IV.')+'">'+
  esc(atmRange?.label||'Range unavailable')+'</span></div>'+
 '<small>'+esc(subtitle)+'</small></div><div class="preview-heading-actions">'+
 '<button type="button" class="chain-range-btn" data-action="toggle-chain-range" aria-pressed="'+(scope==='all'?'true':'false')+'" title="'+(scope==='all'?'Show the 31 closest strikes':'Show every listed standard strike for this expiration')+'">'+(scope==='all'?'Nearby strikes':'All strikes')+'</button>'+ '<button type="button" class="btn btn-outline chain-analyze" data-action="open-chain-analyze">Analyze %</button>'+
 '<button type="button" class="preview-close" data-action="close-option-preview" aria-label="Close option chain">×</button>'+
 '</div></div>';
export function renderChainPanel({idea,data,loading=false,error='',side='Put',scope='nearby',atmRange=null}={}){
 if(!idea)return '';
 const sub='Select a listed strike to populate this idea.';
 const head=header(idea,sub,scope,atmRange);
 if(!idea.ticker||!idea.expiry)return head+'<div class="chain-prompt">Choose a ticker and expiration before opening the chain.</div>';
 if(loading)return head+'<div class="chain-loading" role="status"><span class="mini-spin" aria-hidden="true"></span> Loading strike ladder, open interest, volume and indicative quotes…</div>';
 if(error)return head+'<div class="chain-error" role="status">'+esc(error)+
  ' <button type="button" data-action="refresh-option-chain">Retry</button></div>';
 if(!data)return head+'<div class="chain-prompt">Open the chain to load listed contracts.</div>';
 if(!data.rows?.length)return head+'<div class="chain-prompt">'+esc(data.message||'No listed standard contracts found for this expiry.')+
  ' <button type="button" data-action="refresh-option-chain">Refresh</button></div>';
 const rows=data.rows;
 const desktop='<div class="chain-desktop chain-scroll" role="region" aria-label="Calls and puts option chain" tabindex="0">'+
 '<table class="chain-table"><thead><tr class="chain-side-labels"><th colspan="7">CALLS</th><th class="chain-center-head">STRIKE</th><th colspan="7">PUTS</th></tr>'+
 '<tr><th>VOL</th><th>OI</th><th>BID</th><th>ASK</th><th>IV</th><th>Δ</th><th>CHOOSE</th>'+
 '<th class="chain-center-head">USD</th><th>CHOOSE</th><th>Δ</th><th>IV</th><th>BID</th><th>ASK</th><th>OI</th><th>VOL</th></tr></thead>'+
 '<tbody>'+ladderRows(rows,idea,data)+'</tbody></table></div>';
 const displaySide=side==='Call'?'Call':'Put';
 const mobile='<div class="chain-mobile"><div class="chain-side-pills" role="group" aria-label="Show call or put strikes">'+
 ['Call','Put'].map(x=>'<button type="button" class="'+(x===displaySide?'on':'')+'" data-action="chain-show-side" data-side="'+x+'" aria-pressed="'+(x===displaySide?'true':'false')+'">'+x+'s</button>').join('')+
 '</div><div class="chain-scroll" role="region" aria-label="'+displaySide+' options strikes" tabindex="0">'+
 '<table class="chain-table"><thead><tr><th>STRIKE</th><th>VOL</th><th>OI</th><th>BID</th><th>ASK</th><th>IV</th><th>CHOOSE</th></tr></thead>'+
 '<tbody>'+ladderRows(rows,idea,data,displaySide)+'</tbody></table></div></div>';
 const oi=(data.oiDates||[]).length===1?data.oiDates[0]:(data.oiDates||[]).length?'mixed dates':'not available';
 const volumeStatus=data.volumeDate?'Latest volume session: '+data.volumeDate+' (at least 15-minute delay)':'Volume unavailable';

 const centerNote=!String(idea.strike??'').trim()&&scope!=='all'&&data.centerSource?
  ' · Centered on '+esc(data.centerSource)+' ('+esc(data.centerStrike)+')':'';
 const footer='<div class="chain-meta"><span>OI as of: '+esc(oi)+'</span><span>'+esc(volumeStatus)+'</span>'+
  '<span>Quotes: '+esc(data.quoteStatus==='indicative'?'Alpaca indicative, not OPRA'+(data.quoteAsOf?' · '+data.quoteAsOf.slice(0,16).replace('T',' ')+' UTC':' · time unavailable'):'Unavailable')+'</span>'+
  '<button type="button" class="btn btn-outline chain-refresh" data-action="refresh-option-chain">Refresh chain</button></div>'+
  '<p class="chain-caution">OI and volume alone do not prove liquidity. Compare the <strong>bid–ask spread</strong> and executable IBKR quote before choosing a contract. Dashes indicate missing data, not zero. Chain displays '+
  (scope==='all'?'Showing all '+esc(data.displayedStrikeCount||rows.length)+' listed standard strikes.':
   'Showing '+esc(data.displayedStrikeCount||rows.length)+' nearby strikes.')+centerNote+'</p>';
 return head+spotSummary(idea,data)+desktop+mobile+footer;
}
