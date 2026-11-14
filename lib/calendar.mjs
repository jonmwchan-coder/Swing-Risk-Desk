// NYSE cash equities / listed equity options sessions, US Eastern.
// Official holiday tables cover 2026-2028; outside those years a standard-rule
// approximation is used. Unscheduled closures must be added by the user.
const OFFICIAL = {
  2026: ['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'],
  2027: ['2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24'],
  2028: ['2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25']
};
const pad = n => String(n).padStart(2,'0');
export const isoUTC = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
export const parseDay = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const [y,m,d] = s.split('-').map(Number);
  const out = new Date(Date.UTC(y,m-1,d));
  return isoUTC(out) === s ? out : null;
};
export function dayOffset(day, delta) {
  const d = parseDay(day);
  if (!d) throw new Error('Invalid calendar date');
  d.setUTCDate(d.getUTCDate() + delta);
  return isoUTC(d);
}
function nthWeekday(year,month,weekday,n) {
  const d = new Date(Date.UTC(year,month-1,1));
  return isoUTC(new Date(Date.UTC(year,month-1,1 + (weekday - d.getUTCDay() + 7)%7 + 7*(n-1))));
}
function lastWeekday(year,month,weekday) {
  const d = new Date(Date.UTC(year,month,0));
  return isoUTC(new Date(Date.UTC(year,month-1,d.getUTCDate()-(d.getUTCDay()-weekday+7)%7)));
}
function easter(year) {
  // Anonymous Gregorian algorithm.
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4;
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30;
  const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k+70)%7,m=Math.floor((a+11*h+22*l)/451);
  const month=Math.floor((h+l-7*m+114)/31),day=(h+l-7*m+114)%31+1;
  return `${year}-${pad(month)}-${pad(day)}`;
}
function observed(year,month,day,skipSat=false) {
  const d = new Date(Date.UTC(year,month-1,day));
  if (d.getUTCDay() === 0) return dayOffset(isoUTC(d),1);
  if (d.getUTCDay() === 6) return skipSat ? null : dayOffset(isoUTC(d),-1);
  return isoUTC(d);
}
export function holidays(year) {
  if (OFFICIAL[year]) return new Set(OFFICIAL[year]);
  return new Set([
    observed(year,1,1,true),nthWeekday(year,1,1,3),nthWeekday(year,2,1,3),dayOffset(easter(year),-2),
    lastWeekday(year,5,1),observed(year,6,19),observed(year,7,4),nthWeekday(year,9,1,1),
    nthWeekday(year,11,4,4),observed(year,12,25)
  ].filter(Boolean));
}
export function isSession(day,extraClosed=[]) {
  const d=parseDay(day); if (!d) return false;
  const dow=d.getUTCDay();
  return dow!==0 && dow!==6 && !holidays(d.getUTCFullYear()).has(day) && !extraClosed.includes(day);
}
export function onOrBeforeSession(day,extraClosed=[]) {
  let d=day;
  for(let i=0;i<25;i++){ if(isSession(d,extraClosed)) return d; d=dayOffset(d,-1); }
  throw new Error('Could not find prior trading session');
}
export function nextSession(day,extraClosed=[]) {
  let d=day;
  for(let i=0;i<25;i++){ d=dayOffset(d,1); if(isSession(d,extraClosed)) return d; }
  throw new Error('Could not find next trading session');
}
export function prevSession(day,extraClosed=[]) {
  return onOrBeforeSession(dayOffset(day,-1),extraClosed);
}
export function sessionWindow(day,count=5,extraClosed=[]) {
  const n=Math.max(1,Math.min(30,Math.floor(Number(count)||5)));
  const out=[]; let cursor=onOrBeforeSession(day,extraClosed);
  for(let i=0;i<n;i++){out.push(cursor);cursor=prevSession(cursor,extraClosed);}
  return out.reverse();
}
export function afterSessions(day,count=5,extraClosed=[]) {
  let cursor=day;
  for(let i=0;i<count;i++) cursor=nextSession(cursor,extraClosed);
  return cursor;
}
export function sessionRange(day,n=10,extraClosed=[]) {
  const out=[]; let cursor=onOrBeforeSession(day,extraClosed);
  for(let i=0;i<n;i++){out.push(cursor);cursor=nextSession(cursor,extraClosed);}
  return out;
}
export function torontoToday(date=new Date()) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const get=t=>parts.find(p=>p.type===t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}