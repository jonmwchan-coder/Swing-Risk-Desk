/* Exact option listing availability; pure helpers for the browser UI. */
import {parseDay} from './calendar.mjs';
import {normalizeTicker} from './planner-contract.mjs';

export function expirationLookupKey(idea){
 const ticker=normalizeTicker(idea?.ticker),raw=String(idea?.strike??'').trim(),strike=Number(raw),type=idea?.optionType;
 if(!/^[A-Z][A-Z0-9.\-]{0,10}$/.test(ticker)||!raw||!Number.isFinite(strike)||
    strike<=0||strike>99999.999||Math.abs(strike*1000-Math.round(strike*1000))>1e-5||
    !['Call','Put'].includes(type))return '';
 return [ticker,strike.toFixed(3),type].join('|');
}

export function normalizeListedDates(dates){
 return [...new Set((Array.isArray(dates)?dates:[]).filter(parseDay))].sort();
}

export function expirationListingStatus(expiry,listing){
 if(!listing||listing.status!=='verified')return 'unverified';
 if(!parseDay(expiry))return 'unselected';
 if(expiry<listing.checkedFrom||expiry>listing.checkedThrough)return 'outside-range';
 return listing.expirations.includes(expiry)?'listed':'not-listed';
}

export function nearestListedExpirations(dates,wanted,limit=4){
 const sorted=normalizeListedDates(dates);
 if(!parseDay(wanted))return sorted.slice(0,limit);
 const pivot=Date.parse(wanted+'T00:00:00Z');
 return sorted.map(date=>({date,distance:Math.abs(Date.parse(date+'T00:00:00Z')-pivot)}))
  .sort((a,b)=>a.distance-b.distance||a.date.localeCompare(b.date)).slice(0,limit).map(x=>x.date);
}
