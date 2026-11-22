/* Exact option listing availability; pure helpers for the browser UI. */
import {parseDay,dayOffset,onOrBeforeSession} from './calendar.mjs';
import {normalizeTicker} from './planner-contract.mjs';

export function expirationLookupKey(idea){
 const ticker=normalizeTicker(idea?.ticker),type=idea?.optionType;
 // Discover expirations first. The strike may not be chosen yet and must
 // never be part of this cache key or cause a new expiration request.
 if(!/^[A-Z][A-Z0-9.\-]{0,10}$/.test(ticker)||!['Call','Put'].includes(type))return '';
 return [ticker,type].join('|');
}

export function normalizeListedDates(dates){
 return [...new Set((Array.isArray(dates)?dates:[]).filter(parseDay))].sort();
}

/* Display category is calendar-based, never an assertion about an unverified OCC contract.
   Friday weeklies include 3rd-Friday monthlies, with the preceding session
   used when Friday is closed. Quarter-end means the last U.S. cash session
   in March, June, September, or December. */
export function regularExpirationKind(day){
 const date=parseDay(day);
 if(!date)return null;
 const year=date.getUTCFullYear(),month=date.getUTCMonth()+1,weekday=date.getUTCDay();
 if(weekday===0||weekday===6)return null;
 if(month%3===0){
  const last=new Date(Date.UTC(year,month,0));
  const quarterEnd=`${year}-${String(month).padStart(2,'0')}-${String(last.getUTCDate()).padStart(2,'0')}`;
  if(onOrBeforeSession(quarterEnd)===day)return 'quarterly';
 }
 const friday=dayOffset(day,5-weekday);
 return onOrBeforeSession(friday)===day?'weekly':null;
}
export function onlyRegularListedDates(dates){
 return normalizeListedDates(dates).filter(date=>regularExpirationKind(date)!==null);
}

export function expirationListingStatus(expiry,listing){
 if(!listing||listing.status!=='verified')return 'unverified';
 if(!parseDay(expiry))return 'unselected';
 if(expiry<listing.checkedFrom||expiry>listing.checkedThrough)return 'outside-range';
 if(listing.expirations.includes(expiry))return 'listed';
 // A date suppressed by the selected filter has NOT been verified absent.
 if(listing.scope==='regular'&&!regularExpirationKind(expiry))return 'filtered';
 return 'not-listed';
}

export function nearestListedExpirations(dates,wanted,limit=4){
 const sorted=normalizeListedDates(dates);
 if(!parseDay(wanted))return sorted.slice(0,limit);
 const pivot=Date.parse(wanted+'T00:00:00Z');
 return sorted.map(date=>({date,distance:Math.abs(Date.parse(date+'T00:00:00Z')-pivot)}))
  .sort((a,b)=>a.distance-b.distance||a.date.localeCompare(b.date)).slice(0,limit).map(x=>x.date);
}
