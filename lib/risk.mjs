import {sessionWindow,sessionRange,afterSessions,onOrBeforeSession} from './calendar.mjs';
export const MULTIPLIER=100;
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
export const round2=n=>Math.round((num(n)+Number.EPSILON)*100)/100;
export const roundUp=(value,step=25)=>{const a=num(value),b=num(step); return b>0?Math.ceil((a-1e-8)/b)*b:a;};
const validDate = s=>typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function txList(position,asOf) {
  const entries=(position.fills||[]).map((tx,index)=>({...tx,kind:'buy',order:index}));
  const exits=(position.exits||[]).map((tx,index)=>({...tx,kind:'sell',order:index}));
  return [...entries,...exits].filter(t=>validDate(t.date)&&t.date<=asOf).sort((a,b)=>{
    const ta=`${a.date}T${a.time||(a.kind==='buy'?'00:00':'23:59')}`;
    const tb=`${b.date}T${b.time||(b.kind==='buy'?'00:00':'23:59')}`;
    if(ta!==tb)return ta.localeCompare(tb);
    if(a.kind!==b.kind)return a.kind==='buy'?-1:1;
    return a.order-b.order;
  });
}
export function calculatePosition(position,account,asOf) {
  let qty=0,costCad=0,costUsd=0,realizedTotal=0;
  const closes=[];const issues=[];
  for(const t of txList(position,asOf)){
    const quantity=Math.max(0,Math.floor(num(t.qty)));
    const fx=Math.max(0.01,num(t.fx)||num(account.fx)||1.4);
    const mult=Math.max(1,num(position.multiplier)||MULTIPLIER);
    const fee=Math.max(0,num(t.fee));
    const price=Math.max(0,num(t.price));
    if(t.kind==='buy'){
      const debit=quantity*price*mult+fee;
      qty+=quantity;costUsd+=debit;costCad+=debit*fx;
    }else{
      if(quantity>qty){issues.push('Exit quantity exceeds available contracts');continue;}
      const basisUsd=qty>0?costUsd/qty*quantity:0;
      const basisCad=qty>0?costCad/qty*quantity:0;
      const proceedsUsd=quantity*price*mult-fee;
      const calculatedPnlCad=proceedsUsd*fx-basisCad;
      const hasOverride=t.brokerPnlCad!==''&&t.brokerPnlCad!==null&&t.brokerPnlCad!==undefined&&Number.isFinite(Number(t.brokerPnlCad));
      const pnlCad=hasOverride?Number(t.brokerPnlCad):calculatedPnlCad;
      closes.push({id:t.id,date:t.date,qty:quantity,price:t.price===null?null:price,fx,pnlCad,calculatedPnlCad,hasOverride,fee,basisCad,proceedsCad:t.price===null?null:proceedsUsd*fx,reason:t.reason||'',underlyingAtExit:t.underlyingAtExit??null});
      realizedTotal+=pnlCad;
      qty-=quantity;costUsd-=basisUsd;costCad-=basisCad;
      if(qty===0){costUsd=0;costCad=0;}
    }
  }
  const stressPct=position.stressPct===null||position.stressPct===''||position.stressPct===undefined?num(account.stressPct):Math.max(0,Math.min(100,num(position.stressPct)));
  const reservePct=account.mode==='strict'?100:stressPct;
  const premiumCad=Math.max(0,costUsd)*num(account.fx);
  const stressRaw=premiumCad*reservePct/100;
  const hasFixed=position.fixedReserveCad!==''&&position.fixedReserveCad!==null&&position.fixedReserveCad!==undefined&&Number.isFinite(Number(position.fixedReserveCad));
  const reserveCad=qty===0?0:Math.max(roundUp(stressRaw,account.roundStep),hasFixed?Math.max(0,num(position.fixedReserveCad)):0);
  const stopPremium=(position.stopPremiumUsd===null||position.stopPremiumUsd===''||position.stopPremiumUsd===undefined)?null:num(position.stopPremiumUsd);
  const planLoss=stopPremium===null?null:Math.max(0,(Math.max(0,costUsd)-qty*stopPremium*(num(position.multiplier)||MULTIPLIER))*num(account.fx));
  return {id:position.id,qty,remainingCostUsd:Math.max(0,costUsd),remainingCostCad:Math.max(0,costCad),premiumCad,stressPct,reservePct,stressRaw,reserveCad,planLoss,closes,realizedTotal,issues,hasFixed,status:qty>0?'open':'closed'};
}
export function calculateAccount(state,accountId,day) {
  const account=state.accounts.find(a=>a.id===accountId);
  if(!account)throw new Error('Account not found');
  const extra=state.customClosed||[];
  const asOf=onOrBeforeSession(day,extra);
  const dates=sessionWindow(asOf,Math.max(1,Math.floor(num(account.window)||5)),extra);
  const dateSet=new Set(dates);
  const positions=(state.positions||[]).filter(p=>p.accountId===accountId).map(p=>({position:p,metrics:calculatePosition(p,account,asOf)}));
  const sales=positions.flatMap(x=>x.metrics.closes.map(c=>({...c,ticker:x.position.ticker,positionId:x.position.id,ideaId:x.position.ideaId||x.position.id})));
  const adjustments=(state.adjustments||[]).filter(e=>e.accountId===accountId&&e.date<=asOf).map(e=>({id:e.id,date:e.date,pnlCad:num(e.pnlCad),ticker:e.note||'Manual P/L',manual:true}));
  const events=[...sales,...adjustments];
  const recent=events.filter(x=>dateSet.has(x.date));
  const realizedLossCad=round2(recent.reduce((sum,t)=>sum+Math.max(0,-t.pnlCad),0));
  const realizedProfitCad=round2(recent.reduce((sum,t)=>sum+Math.max(0,t.pnlCad),0));
  const reserveCad=positions.reduce((sum,x)=>sum+x.metrics.reserveCad,0);
  const fullPremiumCad=positions.reduce((sum,x)=>sum+x.metrics.premiumCad,0);
  const realizedAllTime=round2(events.reduce((sum,t)=>sum+t.pnlCad,0));
  // Equity is a broker-balance checkpoint plus *subsequently recorded* net realized P/L.
  // Historic checkpoints preserve risk calculations before later manual cash adjustments.
  // Never confuse an option purchase/open reserve with a realized principal loss.
  const history=(Array.isArray(account.equityCheckpoints)?account.equityCheckpoints:[])
    .filter(x=>typeof x.date==='string'&&validDate(x.date)&&Number.isFinite(Number(x.equityCad))&&Number.isFinite(Number(x.realizedPnlCad)))
    .sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
  const checkpoint=history.filter(x=>x.date<=asOf).at(-1)||history[0]||{
    equityCad:num(account.equityCad),realizedPnlCad:num(account.equityPnlAtCheckpointCad),date:''
  };
  const equityChangeCad=round2(realizedAllTime-num(checkpoint.realizedPnlCad));
  const currentEquityCad=round2(num(checkpoint.equityCad)+equityChangeCad);
  const budgetCad=round2(Math.max(0,currentEquityCad)*Math.max(0,num(account.riskPct))/100);
  const availableCad=round2(budgetCad-realizedLossCad-reserveCad);
  const lossesByDate=Object.fromEntries(dates.map(d=>[d,recent.filter(t=>t.date===d).reduce((s,t)=>s+Math.max(0,-t.pnlCad),0)]));
  return {account,asOf,dates,positions,sales,events,recent,lossesByDate,budgetCad,realizedLossCad,realizedProfitCad,reserveCad,fullPremiumCad,availableCad,usedCad:realizedLossCad+reserveCad,realizedAllTime,currentEquityCad,equityChangeCad,equityCheckpointCad:num(checkpoint.equityCad),equityCheckpointDate:checkpoint.date};
}
export function budgetRunway(state,accountId,day,n=10){
  const a=calculateAccount(state,accountId,day);
  const future=sessionRange(a.asOf,Math.min(30,Math.max(1,n)),state.customClosed||[]);
  const older=a.events.filter(e=>e.date<=a.asOf&&e.pnlCad<0);
  return future.map(date=>{
    const win=new Set(sessionWindow(date,a.account.window,state.customClosed||[]));
    const losses=older.filter(e=>win.has(e.date)).reduce((s,e)=>s-e.pnlCad,0);
    return {date,losses,openReserve:a.reserveCad,available:a.budgetCad-losses-a.reserveCad};
  });
}
export function lossReleases(state,accountId,day) {
  const a=calculateAccount(state,accountId,day);
  return a.recent.filter(t=>t.pnlCad<-0.005).map(t=>({...t,releaseDate:afterSessions(t.date,a.account.window,state.customClosed||[])})).sort((x,y)=>x.releaseDate.localeCompare(y.releaseDate));
}
export function simulateExit(state,accountId,day,positionId,qty,price,fee=0,fx=null) {
  const clone=structuredClone(state);
  const account=clone.accounts.find(a=>a.id===accountId);
  const p=clone.positions.find(p=>p.id===positionId);
  if(!p||!account)throw new Error('Position not found');
  const before=calculateAccount(clone,accountId,day);
  const current=calculatePosition(p,account,before.asOf);
  if(!Number.isInteger(qty)||qty<1||qty>current.qty)throw new Error('Invalid close size');
  p.exits.push({id:'simulation',date:before.asOf,time:'23:59',qty,price:num(price),fee:num(fee),fx:fx?num(fx):num(account.fx)});
  const after=calculateAccount(clone,accountId,day);
  const record=after.positions.find(x=>x.position.id===positionId)?.metrics.closes.find(c=>c.id==='simulation');
  return {before,after,record};
}