import {sessionWindow,sessionRange,nextSession,onOrBeforeSession} from './calendar.mjs';
export const MULTIPLIER=100;
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
export const round2=n=>Math.round((num(n)+Number.EPSILON)*100)/100;
export const roundUp=(value,step=25)=>{const a=num(value),b=num(step); return b>0?Math.ceil((a-1e-8)/b)*b:a;};
// Realized, net option return on the acquisition cost of the contracts sold.
// Buy and sell commissions are already included in the CAD P/L and buy basis.
// No exit, missing basis or manual account P/L without a contract basis = unknown.
export function realizedReturnPct(pnlCad,closedCostCad){
  if(pnlCad===null||pnlCad===undefined||closedCostCad===null||closedCostCad===undefined)return null;
  const pnl=Number(pnlCad),basis=Number(closedCostCad);
  return Number.isFinite(pnl)&&Number.isFinite(basis)&&basis>0?100*pnl/basis:null;
}
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
  let qty=0,costCad=0,costUsd=0,entryPremiumUsd=0,totalEntryDebitUsd=0,attemptEntryQty=0,attemptEntryPremiumUsd=0,realizedTotal=0,attemptIndex=0;
  const closes=[];const issues=[];
  for(const t of txList(position,asOf)){
    const quantity=Math.max(0,Math.floor(num(t.qty)));
    const fx=Math.max(0.01,num(t.fx)||num(account.fx)||1.4);
    const mult=Math.max(1,num(position.multiplier)||MULTIPLIER);
    const fee=Math.max(0,num(t.fee));
    const price=Math.max(0,num(t.price));
    if(t.kind==='buy'){
      // A purchase after a fully flat close starts a new attempt, even if an
      // old imported/manual position object was accidentally reused.
      if(qty===0 && quantity>0){attemptIndex++;totalEntryDebitUsd=0;attemptEntryQty=0;attemptEntryPremiumUsd=0;}
      const debit=quantity*price*mult+fee;
      qty+=quantity;costUsd+=debit;costCad+=debit*fx;entryPremiumUsd+=quantity*price*mult;totalEntryDebitUsd+=debit;attemptEntryQty+=quantity;attemptEntryPremiumUsd+=quantity*price*mult;
    }else{
      if(quantity>qty){issues.push('Exit quantity exceeds available contracts');continue;}
      const basisUsd=qty>0?costUsd/qty*quantity:0;
      const basisCad=qty>0?costCad/qty*quantity:0;
      const proceedsUsd=quantity*price*mult-fee;
      const calculatedPnlCad=proceedsUsd*fx-basisCad;
      const hasOverride=t.brokerPnlCad!==''&&t.brokerPnlCad!==null&&t.brokerPnlCad!==undefined&&Number.isFinite(Number(t.brokerPnlCad));
      const pnlCad=hasOverride?Number(t.brokerPnlCad):calculatedPnlCad;
      closes.push({id:t.id,date:t.date,attemptIndex,qty:quantity,price:t.price===null?null:price,fx,pnlCad,calculatedPnlCad,hasOverride,fee,basisCad,returnPct:realizedReturnPct(pnlCad,basisCad),proceedsCad:t.price===null?null:proceedsUsd*fx,reason:t.reason||'',underlyingAtExit:t.underlyingAtExit??null});
      realizedTotal+=pnlCad;
      entryPremiumUsd-=qty>0?entryPremiumUsd/qty*quantity:0;
      qty-=quantity;costUsd-=basisUsd;costCad-=basisCad;
      if(qty===0){costUsd=0;costCad=0;entryPremiumUsd=0;}
    }
  }
  const stressPct=position.stressPct===null||position.stressPct===''||position.stressPct===undefined?num(account.stressPct):Math.max(0,Math.min(100,num(position.stressPct)));
  const reservePct=account.mode==='strict'?100:stressPct;
  const premiumCad=Math.max(0,costUsd)*num(account.fx);
  const stressRaw=premiumCad*reservePct/100;
  const hasFixed=position.fixedReserveCad!==''&&position.fixedReserveCad!==null&&position.fixedReserveCad!==undefined&&Number.isFinite(Number(position.fixedReserveCad));
  const reserveCad=qty===0?0:Math.max(roundUp(stressRaw,account.roundStep),hasFixed?Math.max(0,num(position.fixedReserveCad)):0);
  const stopPremium=(position.stopPremiumUsd===null||position.stopPremiumUsd===''||position.stopPremiumUsd===undefined)?null:num(position.stopPremiumUsd);
  // User's scenario estimate uses the full attempt's acquisition cost, incl. buy fees.
  // It is not a broker stop, a risk reserve, or a cap on the remaining loss.
  const rawPct=position.plannedLossPct;
  const plannedLossPct=rawPct===null||rawPct===undefined||String(rawPct).trim()===''||!Number.isFinite(Number(rawPct))||Number(rawPct)<0||Number(rawPct)>100?null:Number(rawPct);
  const planLossUsd=plannedLossPct!==null?totalEntryDebitUsd*plannedLossPct/100:stopPremium===null?null:Math.max(0,Math.max(0,costUsd)-qty*stopPremium*(num(position.multiplier)||MULTIPLIER));
  const planLoss=planLossUsd===null?null:planLossUsd*num(account.fx);
  const closedCostCad=closes.reduce((sum,c)=>sum+c.basisCad,0);
  const mult=Math.max(1,num(position.multiplier)||MULTIPLIER);
  const averageEntryUsd=qty>0?Math.max(0,entryPremiumUsd)/(qty*mult):attemptEntryQty>0?attemptEntryPremiumUsd/(attemptEntryQty*mult):null;
  const averageCostUsd=qty>0?Math.max(0,costUsd)/(qty*mult):attemptEntryQty>0?totalEntryDebitUsd/(attemptEntryQty*mult):null;
  return {id:position.id,qty,averageEntryUsd,averageCostUsd,totalEntryDebitUsd,attemptEntryQty,remainingCostUsd:Math.max(0,costUsd),remainingCostCad:Math.max(0,costCad),premiumCad,stressPct,reservePct,stressRaw,reserveCad,planLoss,planLossUsd,plannedLossPct,closes,realizedTotal,closedCostCad,realizedReturnPct:realizedReturnPct(closes.length?realizedTotal:null,closedCostCad),issues,hasFixed,status:qty>0?'open':'closed'};
}
/**
 * Charge only NET losing position/attempts, using exits inside the selected
 * trading-session window. A profitable partial may offset a losing runner from
 * that SAME attempt, but cannot mask an unrelated trade, account, or later
 * re-entry after the first position returned to zero contracts.
 *
 * Signed manual P/L adjustments remain independent events; they never net
 * against one another or against an options position. The gross negative-exit
 * statistic is retained solely as a diagnostic.
 *
 * Since the rolling window changes, an old profitable partial may expire
 * before a later losing partial. In that case the current net loss charge can
 * INCREASE without a new trade. Forecasts must recompute every future window.
 */
export function summarizeRollingLosses(events,dates){
  const selected=new Set(dates);
  const byDate=Object.fromEntries(dates.map(d=>[d,0]));
  const groups=new Map();
  let grossRealizedLossCad=0,grossRealizedProfitCad=0;
  for(const [index,e] of events.entries()){
    if(!selected.has(e.date))continue;
    const value=num(e.pnlCad);
    if(value<0)grossRealizedLossCad-=value;
    if(value>0)grossRealizedProfitCad+=value;
    // Do NOT use ideaId as the group key: separate positions can share an
    // underlying thesis but still represent independent risk-taking attempts.
    const groupKey=e.manual ? `manual:${e.id??index}` :
      `position:${e.positionId??e.id??index}:attempt:${e.attemptIndex??1}`;
    if(!groups.has(groupKey))groups.set(groupKey,[]);
    groups.get(groupKey).push({...e,pnlCad:value,_sourceIndex:index});
  }
  let realizedLossCad=0,realizedProfitCad=0;
  const positionAttempts=[];
  for(const [key,items] of groups){
    const netPnlCad=items.reduce((sum,x)=>sum+x.pnlCad,0);
    const chargedLossCad=Math.max(0,-netPnlCad);
    realizedLossCad+=chargedLossCad;
    realizedProfitCad+=Math.max(0,netPnlCad);
    positionAttempts.push({key,netPnlCad:round2(netPnlCad),chargedLossCad:round2(chargedLossCad)});
    // Allocate the *remaining* net loss to original losing-exit dates, with
    // profits from this attempt cancelling the oldest negative exits first.
    // This makes the daily tiles reconcile to the current rolling risk charge.
    let matchingProfits=items.reduce((sum,x)=>sum+Math.max(0,x.pnlCad),0);
    const losses=items.filter(x=>x.pnlCad<0).sort((a,b)=>
      String(a.date).localeCompare(String(b.date)) || a._sourceIndex-b._sourceIndex);
    for(const e of losses){
      const loss=-e.pnlCad;
      const offset=Math.min(loss,matchingProfits);
      matchingProfits-=offset;
      byDate[e.date]+=loss-offset;
    }
  }
  const netLoss=round2(realizedLossCad);
  const lossesByDate=Object.fromEntries(dates.map(d=>[d,round2(byDate[d])]));
  // Rounding each display tile can differ from rounding the total by a cent.
  const difference=round2(netLoss-Object.values(lossesByDate).reduce((a,b)=>a+b,0));
  if(difference){
    const last=[...dates].reverse().find(d=>byDate[d]>.000001);
    if(last)lossesByDate[last]=round2(lossesByDate[last]+difference);
  }
  return {realizedLossCad:netLoss,realizedProfitCad:round2(realizedProfitCad),
    grossRealizedLossCad:round2(grossRealizedLossCad),grossRealizedProfitCad:round2(grossRealizedProfitCad),
    lossesByDate,positionAttempts};
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
  const {realizedLossCad,realizedProfitCad,grossRealizedLossCad,grossRealizedProfitCad,lossesByDate,positionAttempts}=summarizeRollingLosses(events,dates);
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
  return {account,asOf,dates,positions,sales,events,recent,lossesByDate,positionAttempts,
    budgetCad,realizedLossCad,realizedProfitCad,grossRealizedLossCad,grossRealizedProfitCad,
    reserveCad,fullPremiumCad,availableCad,usedCad:realizedLossCad+reserveCad,
    realizedAllTime,currentEquityCad,equityChangeCad,equityCheckpointCad:num(checkpoint.equityCad),equityCheckpointDate:checkpoint.date};
}
export function budgetRunway(state,accountId,day,n=10){
  const a=calculateAccount(state,accountId,day);
  const future=sessionRange(a.asOf,Math.min(30,Math.max(1,n)),state.customClosed||[]);
  return future.map(date=>{
    const window=sessionWindow(date,a.account.window,state.customClosed||[]);
    // Recompute the entire window. An aging-out *winning* partial can cause a
    // later loss on the same position to become chargeable, not just release.
    const losses=summarizeRollingLosses(a.events,window).realizedLossCad;
    return {date,losses,openReserve:a.reserveCad,
      available:round2(a.budgetCad-losses-a.reserveCad)};
  });
}
export function lossReleases(state,accountId,day){
  const a=calculateAccount(state,accountId,day);
  const extra=state.customClosed||[];
  const result=[];
  let date=a.asOf,lastLoss=a.realizedLossCad;
  const count=Math.max(1,Math.min(30,Math.floor(num(a.account.window)||5)));
  for(let i=0;i<count;i++){
    date=nextSession(date,extra);
    const losses=summarizeRollingLosses(a.events,sessionWindow(date,count,extra)).realizedLossCad;
    const amount=round2(lastLoss-losses);
    if(Math.abs(amount)>.005){
      // Positive changeCad = capacity freed. Negative = charge increases as
      // an older winner ceases to offset a losing partial in the window.
      result.push({releaseDate:date,changeCad:amount,pnlCad:round2(-amount),
        kind:amount>0?'release':'increase',lossesAfterCad:losses});
    }
    lastLoss=losses;
  }
  return result;
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
