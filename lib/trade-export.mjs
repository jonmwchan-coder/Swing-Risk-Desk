import {calculatePosition,round2} from './risk.mjs';

export const TRADE_HANDOFF_SCHEMA='swing-risk-desk-single-trade-v1';
const clone=x=>structuredClone(x);
const finiteNumber=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const chronological=(a,b)=>String(a.date||'').localeCompare(String(b.date||''))||String(a.time||a.createdAt||'').localeCompare(String(b.time||b.createdAt||''));

function isScopedArchive(item,positionId){
  return item?.positionId===positionId ||
    (item?.kind==='position'&&item?.record?.id===positionId);
}

function feeProvenance(tx){
  if(tx?.broker?.sourceKey)return 'IBKR source execution';
  if(tx?.feeEstimated)return 'App estimate; confirm against broker';
  return 'Entered in app / not independently verified';
}

function timeline(position){
  return [
    ...(position.journalEntries||[]).map(n=>({type:'journal',id:n.id??null,date:n.date??null,createdAt:n.createdAt??null,source:n.source??null,kind:n.kind??null,body:n.body??null})),
    ...(position.planHistory||[]).map(n=>({type:'plan_revision',id:n.id??null,date:n.date??null,createdAt:n.createdAt??null,source:n.source??null,changes:clone(n.changes||{}),conflict:Boolean(n.conflict)}))
  ].sort((a,b)=>chronological(a,b));
}

// An exported trade is a source-evidence handoff. It is neither a complete
// recovery backup nor an instruction to update canonical trading masters.
export function buildSingleTradeHandoff(state,positionId,{exportedAt=new Date().toISOString()}={}){
  if(!state||!Array.isArray(state.accounts)||!Array.isArray(state.positions))throw new Error('No valid ledger is loaded.');
  const p=state.positions.find(x=>x.id===positionId);
  if(!p)throw new Error('Trade not found. Select a position before exporting.');
  const a=state.accounts.find(x=>x.id===p.accountId);
  if(!a)throw new Error('Trade has no matching portfolio. Fix the account mapping before exporting.');
  const entryFills=Array.isArray(p.fills)?p.fills:[];
  const exits=Array.isArray(p.exits)?p.exits:[];
  const result=calculatePosition(p,a,'9999-12-31');
  const archivedCorrections=(state.archive||[]).filter(item=>isScopedArchive(item,p.id)).map(clone);
  const exitSummaries=result.closes.map(c=>{
    const source=exits.find(t=>t.id===c.id);
    return {...clone(c),sourceExecutionId:c.id,feeProvenance:feeProvenance(source),
      brokerSourceKey:source?.broker?.sourceKey??null,
      tpLabel:source?.tpLabel??null,notes:source?.notes??null,
      time:source?.time??null,timeUnverified:Boolean(source?.timeUnverified)};
  });
  const attempts=[...new Set(exitSummaries.map(c=>c.attemptIndex))].sort((x,y)=>x-y).map(index=>{
    const slices=exitSummaries.filter(c=>c.attemptIndex===index);
    return {attemptIndex:index,closedQuantity:slices.reduce((s,c)=>s+c.qty,0),
      realizedPnlCad:round2(slices.reduce((s,c)=>s+c.pnlCad,0)),
      allocatedBuyCostCad:round2(slices.reduce((s,c)=>s+c.basisCad,0)),
      exitIds:slices.map(c=>c.id)};
  });
  const executions=[
    ...entryFills.map(t=>({side:'BUY',...clone(t),feeProvenance:feeProvenance(t)})),
    ...exits.map(t=>({side:'SELL',...clone(t),feeProvenance:feeProvenance(t)}))
  ].sort((x,y)=>chronological(x,y)|| (x.side==='BUY'?-1:1));
  const warnings=[];
  const missingEconomicFields=executions.some(t=>finiteNumber(t.price)===null || finiteNumber(t.fee)===null || finiteNumber(t.fx)===null || !(finiteNumber(t.qty)>0));
  const reliableDerivedEconomics=!missingEconomicFields && !result.issues.length;
  if(missingEconomicFields)warnings.push('An execution is missing premium, commission, FX, or positive quantity. Monetary results are not independently calculable; review original broker records.');
  if(!entryFills.length)warnings.push('No entry fills are recorded in this position.');
  if(!exits.length)warnings.push('No exits recorded. Profit/loss and exit outcome are unverified/unknown.');
  if(result.qty>0)warnings.push(`${result.qty} contract(s) remain open in this ledger. Unrealized P/L is unknown; do not infer a completed outcome.`);
  if(entryFills.concat(exits).some(t=>t.timeUnverified||!t.time))warnings.push('One or more execution times were not verified; do not infer their exact intraday ordering.');
  if(entryFills.concat(exits).some(t=>t.feeEstimated))warnings.push('Some commissions are app estimates, not confirmed broker charges.');
  if(entryFills.concat(exits).some(t=>t.broker?.timezoneStatus))warnings.push('One or more broker export timestamps have unverified timezone metadata.');
  if(entryFills.concat(exits).some(t=>!t.broker))warnings.push('Some transactions have no linked original IBKR source execution.');
  if(entryFills.concat(exits).some(t=>finiteNumber(t.fx)===null))warnings.push('At least one fill has no verified USD/CAD rate.');
  if(result.issues.length)warnings.push(...result.issues.map(s=>`Reconciliation warning: ${s}`));
  const status=result.qty>0?'open':result.closes.length?'closed':'no_valid_recorded_exit';
  return {
    schema:TRADE_HANDOFF_SCHEMA,
    packageType:'single_position_trade_review_handoff',
    exportedAt,
    scope:{positionId:p.id,accountId:p.accountId,oneAccountOnly:true,onePositionOnly:true,
      includesOtherPositions:false,includesFullPortfolioHistory:false,isCompleteRecoveryBackup:false},
    portfolio:{id:a.id,name:a.name??null,brokerAccountId:a.brokerAccountId??null,reportingCurrency:'CAD',
      optionPremiumCurrency:'USD',currentUsdCadReference:finiteNumber(a.fx),referenceFxSource:a.fxSource??null,
      note:'Current reference FX is context only. Each recorded execution retains its own FX; confirm broker rates independently.'},
    contract:{ticker:p.ticker??null,optionType:p.optionType??null,strike:p.strike??null,
      expiration:p.expiry??null,multiplier:p.multiplier??100,sector:p.sector??null,
      ideaId:p.ideaId??null,externalMasterId:p.externalId??null,positionId:p.id,
      accountId:p.accountId},
    position:clone(p),
    orderedExecutions:executions,
    realizedExits:exitSummaries,
    realizedAttempts:attempts,
    chronologicalJournalAndPlan:timeline(p),
    archivedCorrections,
    summary:{status,remainingContracts:result.qty,totalContractsBought:entryFills.reduce((s,t)=>s+(finiteNumber(t.qty)||0),0),
      totalContractsSold:exits.reduce((s,t)=>s+(finiteNumber(t.qty)||0),0),
      realizedNetPnlCad:result.closes.length&&reliableDerivedEconomics?round2(result.realizedTotal):null,
      realizedReturnPct:reliableDerivedEconomics?result.realizedReturnPct:null,
      allocatedClosedCostCad:round2(result.closedCostCad),
      remainingCostUsd:result.qty>0?round2(result.remainingCostUsd):0,
      estimatedOpenReserveCad:result.qty>0?result.reserveCad:0,
      unrealizedPnlCad:null,
      outcomeGrade:null,setupGrade:null,entryGrade:null,managementGrade:null,
      calculationsAreDerivedFromRecordedFillsAndFx:true,
      realizedPnlCanIncludeManualBrokerOverrides:exitSummaries.some(c=>c.hasOverride)},
    sourceQuality:{warnings,economicsComplete:reliableDerivedEconomics,brokerActualFeeEntries:executions.filter(t=>t.broker?.sourceKey).length,
      estimatedFeeEntries:executions.filter(t=>t.feeEstimated).length,
      executionCount:executions.length,
      note:'Broker evidence and user-authored plans/notes are distinct. Later notes do not prove what was known at entry.'},
    gptMasterHandoff:{
      purpose:'Review or reconcile this one account-specific options swing with the DK trading master.',
      preserveSourceIds:true,
      retainAllDatedPsychologyAndPlanChanges:true,
      avoidHindsight:'Use only entry-time evidence to grade setup and entry; later information may inform management and outcome.',
      noAutomaticCommit:'Uploading this export does not authorize edits to any canonical trading or market master. Wait for an explicit commit instruction.',
      verifyExistingMasterRows:'Read AI_Update_Protocol first; reconcile by account, contract, position/idea IDs and execution timestamps to prevent duplicated records.',
      incompleteEvidence:'Unknown price bars, broker fees, entry-time plans, and unfilled exits remain unknown, not reconstructed.'
    }
  };
}

export function singleTradeExportFilename(bundle){
  const clean=(x,max=34)=>String(x??'unknown').replace(/[^A-Za-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,max)||'unknown';
  const p=bundle.contract,a=bundle.portfolio;
  const contract=`${clean(p.ticker,12)}-${clean(p.expiration,12)}-${clean(p.strike,14)}${String(p.optionType||'').toLowerCase()==='put'?'P':'C'}`;
  const account=clean(a.name,24);
  const id=clean(p.positionId,22);
  return `swing-risk-TRADE-${contract}-${account}-${id}.json`;
}
