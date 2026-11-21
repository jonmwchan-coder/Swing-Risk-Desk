import {calculatePosition,calculateAccount} from './risk.mjs';
import {torontoToday,onOrBeforeSession} from './calendar.mjs';
import {parseIbkrTrades,contractMatches,transactionMatches} from './ibkr.mjs';
import {ratePerContract,DEFAULT_BUY_FEE_USD,DEFAULT_SELL_FEE_USD} from './fees.mjs';
export const SCHEMA='swing-risk-desk-v2';
export const NO_VALUE=Symbol('none');
const id=()=>globalThis.crypto?.randomUUID?.()||`entry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const copy=x=>structuredClone(x);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const str=x=>String(x??'').trim();
const isEmpty=x=>x===null||x===undefined||x==='';
const planFields=['ideaId','sector','targetLevels','underlyingInvalidation','reviewBy','stopPremiumUsd','stressPct','fixedReserveCad','notes','catalyst','thesis','entryReason','managementPlan'];
// Stable technical IDs for older journal imports with no event ID. New notes use UUIDs.
function legacyEventId(positionId,kind,event,occurrence){
  const source=JSON.stringify([positionId,kind,event.date||'',event.createdAt||'',event.source||'',event.kind||'',event.body||'',event.changes||{},occurrence]);
  let h=0xcbf29ce484222325n;
  for(let i=0;i<source.length;i++)h=((h^BigInt(source.charCodeAt(i)))*0x100000001b3n)&0xffffffffffffffffn;
  return `legacy-${kind}-${h.toString(36)}`;
}
export function normalizeLedger(data){
  if(!data||!Array.isArray(data.accounts)||!Array.isArray(data.positions)||!Array.isArray(data.adjustments))throw new Error('File must contain accounts, positions and adjustments.');
  if(data.accounts.length>200||data.positions.length>5000||data.adjustments.length>20000)throw new Error('File has more records than this application supports.');
  const s=copy(data);
  s.schema=SCHEMA;s.customClosed=Array.isArray(s.customClosed)?s.customClosed:[];
  s.brokerInbox=Array.isArray(s.brokerInbox)?s.brokerInbox:[];
  s.importLog=Array.isArray(s.importLog)?s.importLog:[];
  s.conflicts=Array.isArray(s.conflicts)?s.conflicts:[];
  s.archive=Array.isArray(s.archive)?s.archive:[];
  s.revision=Math.max(0,Math.floor(Number(s.revision)||0));
  s.lastSavedAt=s.lastSavedAt||'';
  s.lastBackupRevision=Math.max(0,Math.floor(Number(s.lastBackupRevision)||0));
  s.lastBackupAt=s.lastBackupAt||'';
  for(const a of s.accounts){
    a.fx=Number(a.fx)||1.4;a.roundStep=Number(a.roundStep??25);a.window=Number(a.window)||5;
    a.riskPct=Number(a.riskPct??3);a.stressPct=Number(a.stressPct??70);
    a.equityCad=Number(a.equityCad??20000);a.mode=a.mode==='strict'?'strict':'stress';
    a.ideaCapMode=a.ideaCapMode==='pool'?'pool':Number(a.ideaCapCad)>0?'fixed':'pool';
    a.buyFeePerContractUsd=ratePerContract(a,'BUY');a.sellFeePerContractUsd=ratePerContract(a,'SELL');
    a.brokerAccountId=a.brokerAccountId||'';
  }
  for(const p of s.positions){
    p.fills=Array.isArray(p.fills)?p.fills:[];p.exits=Array.isArray(p.exits)?p.exits:[];
    p.journalEntries=Array.isArray(p.journalEntries)?p.journalEntries:[];
    p.planHistory=Array.isArray(p.planHistory)?p.planHistory:[];
    for(const [kind,events] of [['note',p.journalEntries],['plan',p.planHistory]]){
      const duplicates=new Map();
      for(const ev of events)if(!ev.id){
        const text=JSON.stringify([ev.date||'',ev.createdAt||'',ev.source||'',ev.kind||'',ev.body||'',ev.changes||{}]);
        const order=(duplicates.get(text)||0)+1;duplicates.set(text,order);
        ev.id=legacyEventId(p.id,kind,ev,order);
      }
    }
    p.stressPct=p.stressPct??null;p.fixedReserveCad=p.fixedReserveCad??null;
    p.targetLevels=p.targetLevels||'';p.underlyingInvalidation=p.underlyingInvalidation||'';
    p.catalyst=p.catalyst||'';p.thesis=p.thesis||'';p.entryReason=p.entryReason||'';
    p.managementPlan=p.managementPlan||'';p.notes=p.notes||'';
  }
  // V1.5 migration: treat previously typed CURRENT EQUITY as an existing broker
  // balance checkpoint. Prior imported trades may already be reflected in that
  // figure, so pin the cumulative *known* P/L to avoid silently counting it twice.
  // Future realized P/L changes tracked equity automatically from that checkpoint.
  for(const a of s.accounts){
    if(!Array.isArray(a.equityCheckpoints)||!a.equityCheckpoints.length){
      const date=onOrBeforeSession(torontoToday(),s.customClosed);
      const realized=a.equityPnlAtCheckpointCad!==undefined&&a.equityPnlAtCheckpointCad!==null&&a.equityPnlAtCheckpointCad!==''&&Number.isFinite(Number(a.equityPnlAtCheckpointCad))
        ?Number(a.equityPnlAtCheckpointCad)
        :calculateAccount(s,a.id,date).realizedAllTime;
      a.equityCheckpoints=[{id:`equity-initial-${a.id}`,date,createdAt:`${date}T00:00:00Z`,equityCad:a.equityCad,realizedPnlCad:realized,source:'Existing broker equity checkpoint at migration'}];
    }
    // Checkpoints are part of the backup/cloud record, not a UI-only calculation.
    a.equityPnlAtCheckpointCad=Number(a.equityCheckpoints.at(-1).realizedPnlCad)||0;
  }
  return s;
}
export function makeJournalEntry(position,{text,kind='Journal / process',date,source='App note',createdAt}={}){
  const entry={id:id(),date:date||new Date().toISOString().slice(0,10),createdAt:createdAt||new Date().toISOString(),kind,body:str(text),source};
  if(!entry.body)throw new Error('Journal note must contain text.');
  position.journalEntries??=[];
  position.journalEntries.push(entry);
  return entry;
}
export function recordPlanEdit(position,changes,{date,createdAt,source='App plan edit'}={}){
  const diff={};
  for(const [key,next] of Object.entries(changes)){
    if(!same(position[key]??'',next??''))diff[key]={before:position[key]??'',after:next??''};
  }
  if(Object.keys(diff).length){
    position.planHistory??=[];
    position.planHistory.push({id:id(),date:date||new Date().toISOString().slice(0,10),createdAt:createdAt||new Date().toISOString(),source,changes:diff});
    Object.assign(position,changes);
  }
  return Object.keys(diff);
}
const brokerMeta=t=>({source:'IBKR Flex CSV',sourceKey:t.sourceKey,account:t.account,contract:t.symbol,commissionRaw:t.commission,netCash:t.netCash,raw:t.raw,timezoneStatus:'Export time zone is not explicitly specified; confirm IBKR settings.'});
const inboxId=t=>t.sourceKey||`ibkr-unparsed:${t.rowNumber}:${str(t.symbol)}`;
function accountFor(s,accountNumber,accountMap={}){
  let a=s.accounts.find(x=>x.brokerAccountId===accountNumber);
  if(a)return a;
  // The user explicitly chooses the mapping in the broker-import preview.
  // Never hardcode private account numbers in public Vercel source files.
  const selectedId=accountMap[accountNumber];
  if(selectedId){
    a=s.accounts.find(x=>x.id===selectedId);
    if(!a)throw new Error(`Selected portfolio for IBKR ${accountNumber} no longer exists.`);
    if(a.brokerAccountId&&a.brokerAccountId!==accountNumber)throw new Error(`${a.name} is already mapped to a different IBKR account.`);
    a.brokerAccountId=accountNumber;
    return a;
  }
  // Unknown accounts must not get a fabricated balance or an inherited risk budget.
  a={id:`ibkr-${accountNumber}`,brokerAccountId:accountNumber,name:`IBKR ${accountNumber} (set equity)`,equityCad:0,equityCheckpoints:[{id:`equity-initial-ibkr-${accountNumber}`,date:onOrBeforeSession(torontoToday(),s.customClosed),createdAt:new Date().toISOString(),equityCad:0,realizedPnlCad:0,source:'IBKR account initial equity; set actual balance'}],riskPct:3,window:5,stressPct:70,roundStep:25,mode:'stress',fx:1.4,fxSource:'Illustrative assumption; enter account FX',fxDate:'',ideaCapCad:null,buyFeePerContractUsd:DEFAULT_BUY_FEE_USD,sellFeePerContractUsd:DEFAULT_SELL_FEE_USD};
  s.accounts.push(a);return a;
}
function inbox(s,t,reason,report){
  const key=inboxId(t);if(!s.brokerInbox.some(x=>x.id===key)){
    s.brokerInbox.push({id:key,source:'IBKR Flex CSV',reason,tradeDate:t.tradeDate||'',ticker:t.contract?.ticker||t.symbol,side:t.side,raw:t.raw,sourceKey:t.sourceKey});report.pending++;
  }else report.duplicates++;
}
export function importIbkrTrades(state,text,{filename='IBKR statement',includeSameDayExpiry=false,accountMap={}}={}){
  const s=normalizeLedger(state),parsed=parseIbkrTrades(text);
  const report={fileType:'ibkr',total:parsed.totalRows,added:0,duplicates:0,sourceLinked:0,newPositions:0,newAccounts:0,updatedPositions:0,pending:0,issueList:[],ambiguous:parsed.repeatedSignatures};
  const oldAccounts=new Set(s.accounts.map(x=>x.id));
  const originallyExistingPositions=new Set(s.positions.map(p=>p.id)),updatedExisting=new Set();
  for(const err of parsed.errors){inbox(s,err,err.reason,report);report.issueList.push(`${err.symbol||'Row '+err.rowNumber}: ${err.reason}`);}
  for(const t of parsed.trades){
    if(s.archive?.some(x=>(!x.restoredAt&&x.kind==='transaction'&&x.record?.tx?.broker?.sourceKey===t.sourceKey)||
       (!x.restoredAt&&x.kind==='position'&&[...(x.record?.fills||[]),...(x.record?.exits||[])].some(tx=>tx.broker?.sourceKey===t.sourceKey)))){
      report.duplicates++;continue;
    }
    const a=accountFor(s,t.account,accountMap);
    if(!oldAccounts.has(a.id)){report.newAccounts++;oldAccounts.add(a.id);}
    const matchPos=s.positions.filter(p=>p.accountId===a.id&&contractMatches(p,t));
    if(!includeSameDayExpiry&&t.side==='BUY'&&t.contract.expiry===t.tradeDate&&matchPos.length===0){
      inbox(s,t,'Same-day-expiry option was held out of the swing budget. Enable the 0DTE import option if this was an intentional swing/lotto trade.',report);
      continue;
    }
    const already=[];
    for(const p of matchPos){for(const k of ['fills','exits']){
      if((k==='fills'&&t.side==='BUY')||(k==='exits'&&t.side==='SELL')){
        for(const tx of p[k])if(tx.broker?.sourceKey===t.sourceKey)already.push({p,tx,exact:true});
      }
    }}
    if(already.length){report.duplicates++;s.brokerInbox=s.brokerInbox.filter(x=>x.id!==t.sourceKey);continue;}
    const candidates=[];
    for(const p of matchPos){
      for(const tx of t.side==='BUY'?p.fills:p.exits){
        if(transactionMatches(tx,t)&&!tx.broker?.sourceKey)candidates.push({p,tx});
      }
    }
    if(candidates.length===1){
      const {p:matchedPosition,tx:matchedTx}=candidates[0];
      const unverified=matchedTx.timeUnverified===true||!matchedTx.time||matchedTx.time==='23:59';
      if(unverified){
        // Upgrade a manually entered placeholder to the real broker time, but
        // only when the correction doesn't make an existing sell impossible.
        const trial=copy(matchedPosition);
        const target=(t.side==='BUY'?trial.fills:trial.exits).find(x=>x.id===matchedTx.id);
        target.time=t.time;
        if(calculatePosition(trial,a,'9999-12-31').issues.length){
          inbox(s,t,'Broker timestamp conflicts with a manual execution sequence; source retained for review',report);
          report.issueList.push(`${t.contract.ticker} ${t.tradeDate}: manual-time conflict; no economics duplicated`);continue;
        }
      }
      const oldFee=Number(matchedTx.fee||0),wasEstimated=matchedTx.feeEstimated===true;
      matchedTx.broker={...brokerMeta(t),manualTimeBeforeBrokerLink:unverified?matchedTx.time:undefined,
        estimatedFeeBeforeBrokerLink:wasEstimated?oldFee:undefined};
      // A planning estimate is not a verified execution cost; replace it with IBKR's actual fee.
      matchedTx.fee=t.fee;matchedTx.feeEstimated=false;
      if(unverified){matchedTx.time=t.time;matchedTx.timeUnverified=false;}
      report.sourceLinked++;report.duplicates++;
      s.brokerInbox=s.brokerInbox.filter(x=>x.id!==t.sourceKey);continue;
    }
    if(candidates.length>1){inbox(s,t,'Ambiguous: multiple existing executions match',report);report.issueList.push(`${t.contract.ticker} ${t.tradeDate}: multiple matching fills; no guess made`);continue;}
    // If the same intrinsic execution key is already recorded with conflicting source data,
    // quarantine it rather than adding a second economic transaction.
    const possibleCollision=matchPos.flatMap(p=>(t.side==='BUY'?p.fills:p.exits).filter(tx=>tx.date===t.tradeDate&&str(tx.time)===t.time&&Number(tx.qty)===t.qty&&Number(tx.price)===t.price&&tx.feeEstimated!==true&&Math.abs(Number(tx.fee||0)-t.fee)>.00001));
    if(possibleCollision.length){inbox(s,t,'Same timestamp/price/size but different commission; check source conflict',report);report.issueList.push(`${t.contract.ticker} ${t.tradeDate}: fee/source conflict`);continue;}
    let p;
    const dated=matchPos.filter(x=>{
      const earlier=structuredClone(x);
      for(const key of ['fills','exits'])earlier[key]=earlier[key].filter(f=>f.date<t.tradeDate||(f.date===t.tradeDate&&(f.time||'00:00:00')<=t.time));
      const open=calculatePosition(earlier,a,t.tradeDate).qty;
      return open>0;
    });
    if(dated.length===1)p=dated[0];
    else if(dated.length>1){
      inbox(s,t,'Multiple possible positions for this contract; assign manually',report);report.issueList.push(`${t.contract.ticker} ${t.tradeDate}: more than one idea uses this contract`);continue;
    }
    else if(t.side==='BUY'){
      // A manually entered first purchase with an unspecified time may show
      // 23:59 even when its real IBKR fill was earlier that same day. Match
      // only a single still-open same-day manual idea, never a completed roundtrip.
      const sameDayUnknown=matchPos.filter(x=>
        x.fills.some(f=>f.date===t.tradeDate&&!f.broker?.sourceKey&&(f.timeUnverified||f.time==='23:59'||!f.time))&&
        calculatePosition(x,a,t.tradeDate).qty>0&&
        !x.exits.some(e=>e.date===t.tradeDate&&(e.time||'23:59')<=t.time)
      );
      if(sameDayUnknown.length>1){
        inbox(s,t,'More than one same-day manually timed position matches; assign manually',report);
        report.issueList.push(`${t.contract.ticker} ${t.tradeDate}: ambiguous same-day idea; no guess made`);continue;
      }
      if(sameDayUnknown.length===1)p=sameDayUnknown[0];
    }
    if(!p){
      if(t.side==='BUY')p={id:`IBKR-${t.account}-${t.symbol}-${t.tradeDate}-${t.time.replace(/:/g,'')}`,accountId:a.id,externalId:'',source:'IBKR Flex CSV',ideaId:`SWING-${t.tradeDate}-${t.contract.ticker}-UNREVIEWED`,ticker:t.contract.ticker,optionType:t.contract.optionType,strike:t.contract.strike,expiry:t.contract.expiry,sector:'',stressPct:null,fixedReserveCad:null,underlyingInvalidation:'',targetLevels:'',stopPremiumUsd:null,reviewBy:'',thesis:'',entryReason:'',catalyst:'',managementPlan:'',notes:'',journalEntries:[],planHistory:[],fills:[],exits:[]};
      if(t.side==='BUY'){s.positions.push(p);report.newPositions++;}
      else{
        inbox(s,t,'Orphan SELL: no matching open purchase to establish cost basis',report);
        report.issueList.push(`${t.contract.ticker} ${t.tradeDate}: sale preserved for later reconciliation`);continue;
      }
    }
    const tx={id:t.sourceKey,date:t.tradeDate,time:t.time,qty:t.qty,price:t.price,fee:t.fee,fx:a.fx,broker:brokerMeta(t)};
    const k=t.side==='BUY'?'fills':'exits';
    if(k==='exits'){
      const trial=copy(p);trial.exits.push(tx);
      if(calculatePosition(trial,a,'9999-12-31').issues.length){
        inbox(s,t,'SELL exceeds available contracts or conflicts with execution order',report);report.issueList.push(`${t.contract.ticker}: sale could not be safely applied`);continue;
      }
    }
    p[k].push(tx);report.added++;
    if(originallyExistingPositions.has(p.id))updatedExisting.add(p.id);
    s.brokerInbox=s.brokerInbox.filter(x=>x.id!==t.sourceKey);
  }
  report.updatedPositions=updatedExisting.size;
  if(report.added||report.sourceLinked||report.pending){s.importLog.push({id:id(),date:new Date().toISOString(),type:'IBKR CSV',sourceName:filename,added:report.added,duplicates:report.duplicates,sourceLinked:report.sourceLinked,pending:report.pending});}
  return {next:normalizeLedger(s),report};
}
function sameEconomicTx(a,b){return a.date===b.date&&str(a.time)===str(b.time)&&Number(a.qty)===Number(b.qty)&&Number(a.price??0)===Number(b.price??0)&&Math.abs(Number(a.fee||0)-Number(b.fee||0))<0.00001;}
function uniqueRecord(arr,item){if(!arr.some(x=>x.id===item.id||same(x,item)))arr.push(copy(item));}
/** Reconcile archived timeline records after combining a backup or two devices. */
export function reconcileTimelineArchives(state){
 const latest=new Map();
 for(const entry of state.archive||[]){
   if(!['journal-entry','plan-revision'].includes(entry.kind)||!entry.positionId||!entry.record?.id)continue;
   const key=`${entry.positionId}|${entry.kind}|${entry.record.id}`;
   const timestamp=entry.restoredAt&&entry.restoredAt>entry.date?entry.restoredAt:entry.date;
   const stateRestored=!!entry.restoredAt&&entry.restoredAt>entry.date;
   if(!latest.has(key)||timestamp>latest.get(key).timestamp)latest.set(key,{timestamp,stateRestored,entry});
 }
 for(const p of state.positions||[]){
   for(const [kind,field] of [['journal-entry','journalEntries'],['plan-revision','planHistory']]){
     const active=new Map((p[field]||[]).map(x=>[x.id,x]));
     for(const [key,status] of latest){if(!key.startsWith(`${p.id}|${kind}|`))continue;
       if(status.stateRestored){if(!active.has(status.entry.record.id))active.set(status.entry.record.id,copy(status.entry.record));}
       else active.delete(status.entry.record.id);
     }
     p[field]=[...active.values()];
   }
 }
 return state;
}
/**
 * A removal is an explicit archived correction, not evidence that a stale
 * browser's shorter transaction list is newer. Keep tombstones (and restore
 * markers) when combining devices; otherwise merges can recreate deletions.
 */
export function reconcileArchivedLedger(state){
 const live=(state.archive||[]).filter(x=>!x.restoredAt);
 for(const item of live){
  if(item.kind==='position'&&item.record?.id){
   state.positions=state.positions.filter(p=>p.id!==item.record.id);
  }else if(item.kind==='transaction'&&item.positionId&&item.record?.tx?.id){
   const p=state.positions.find(x=>x.id===item.positionId);
   if(!p)continue;
   const k=item.record.side==='SELL'?'exits':'fills';
   p[k]=(p[k]||[]).filter(x=>x.id!==item.record.tx.id);
  }else if(item.kind==='adjustment'&&item.record?.id){
   state.adjustments=(state.adjustments||[]).filter(x=>x.id!==item.record.id);
  }
 }
 return state;
}

export function mergeFullBackup(current,incoming,{fallbackAccountId='bdi',journalOnly=false}={}){
  const s=normalizeLedger(current);let b;
  if(journalOnly){if(!Array.isArray(incoming.positions))throw new Error('Journal import has no positions.');b={accounts:s.accounts,positions:incoming.positions,adjustments:[],customClosed:[],brokerInbox:[],importLog:[],conflicts:[]};}
  else b=normalizeLedger(incoming);
  const report={fileType:journalOnly?'journal':'backup',newAccounts:0,newPositions:0,newTransactions:0,duplicates:0,newNotes:0,planChanges:0,conflicts:0,importInbox:0};
  const accountRemap=new Map();
  for(const a of b.accounts){
    let existing=s.accounts.find(x=>x.id===a.id||(a.brokerAccountId&&x.brokerAccountId===a.brokerAccountId));
    if(!existing){s.accounts.push(copy(a));existing=s.accounts.at(-1);report.newAccounts++;}
    else if(!journalOnly&&['equityCad','equityCheckpoints','riskPct','window','stressPct','roundStep','mode','fx','ideaCapCad','ideaCapMode','buyFeePerContractUsd','sellFeePerContractUsd'].some(k=>JSON.stringify(existing[k]??null)!==JSON.stringify(a[k]??null))){
      if(!s.conflicts.some(x=>x.kind==='account-settings'&&x.accountId===existing.id&&same(x.imported,a))){
        s.conflicts.push({id:id(),kind:'account-settings',date:new Date().toISOString(),accountId:existing.id,existing:copy(existing),imported:copy(a),reason:'Imported account limits/balance differ; current retained, alternative preserved. Select full restore to use imported rules.'});report.conflicts++;
      }
    }
    accountRemap.set(a.id,existing.id);
  }
  for(const incomingP of b.positions){
    const ai=accountRemap.get(incomingP.accountId)||incomingP.accountId||fallbackAccountId;
    if(!s.accounts.some(a=>a.id===ai))throw new Error(`Unknown account ${ai} in imported trade. Create the account first.`);
    let p=s.positions.find(x=>x.id===incomingP.id||(incomingP.externalId&&x.externalId===incomingP.externalId&&x.accountId===ai));
    if(!p){const other=s.positions.filter(x=>x.accountId===ai&&x.ticker===incomingP.ticker&&x.expiry===incomingP.expiry&&Number(x.strike)===Number(incomingP.strike)&&x.optionType===incomingP.optionType&&[...(incomingP.fills||[])].some(f=>x.fills.some(t=>sameEconomicTx(t,f))));
      if(other.length===1)p=other[0];
    }
    if(!p){const n=copy({...incomingP,accountId:ai});n.fills=Array.isArray(n.fills)?n.fills:[];n.exits=Array.isArray(n.exits)?n.exits:[];n.journalEntries=Array.isArray(n.journalEntries)?n.journalEntries:[];n.planHistory=Array.isArray(n.planHistory)?n.planHistory:[];s.positions.push(n);report.newPositions++;report.newTransactions+=n.fills.length+n.exits.length;report.newNotes+=n.journalEntries.length;continue;}
    if(p.accountId!==ai||p.ticker!==incomingP.ticker||p.expiry!==incomingP.expiry||p.optionType!==incomingP.optionType||Number(p.strike)!==Number(incomingP.strike)){
      s.conflicts.push({id:id(),kind:'position-contract',date:new Date().toISOString(),positionId:p.id,imported:copy(incomingP),reason:'Same position ID has conflicting contract/account; full incoming record preserved.'});report.conflicts++;continue;
    }
    for(const k of ['fills','exits'])for(const tx of incomingP[k]||[]){
      const exact=p[k].find(t=>t.id===tx.id||(t.broker?.sourceKey&&t.broker.sourceKey===tx.broker?.sourceKey)||(!(t.broker?.sourceKey&&tx.broker?.sourceKey)&&sameEconomicTx(t,tx)));
      if(!exact){p[k].push(copy(tx));report.newTransactions++;}
      else if(sameEconomicTx(exact,tx)){report.duplicates++;if(!exact.broker&&tx.broker)exact.broker=copy(tx.broker);}
      else{s.conflicts.push({id:id(),kind:'transaction',positionId:p.id,date:new Date().toISOString(),existing:copy(exact),imported:copy(tx),reason:'Same transaction ID has different economics; both preserved for review without double counting.'});report.conflicts++;}
    }
    for(const note of incomingP.journalEntries||[]){
      const equivalent=x=>(note.id&&x.id===note.id)||(x.date===note.date&&x.kind===note.kind&&str(x.body)===str(note.body)&&str(x.source)===str(note.source));
      if(!p.journalEntries.some(equivalent)){p.journalEntries.push({...copy(note),id:note.id||id()});report.newNotes++;}else report.duplicates++;
    }
    for(const ev of incomingP.planHistory||[])uniqueRecord(p.planHistory,ev);
    for(const field of planFields){const old=p[field],newV=incomingP[field];if(isEmpty(newV))continue;
      if(isEmpty(old)){recordPlanEdit(p,{[field]:copy(newV)},{source:'Import filled missing field'});report.planChanges++;}
      else if(!same(old,newV)){
        const present=p.planHistory.some(ev=>ev.changes?.[field]&&same(ev.changes[field].after,newV))||
          (s.archive||[]).some(item=>item.kind==='plan-revision'&&item.positionId===p.id&&item.record?.changes?.[field]&&same(item.record.changes[field].after,newV));
        if(!present){
          p.planHistory.push({id:id(),date:new Date().toISOString().slice(0,10),createdAt:new Date().toISOString(),source:'Imported alternative plan / do not backdate',changes:{[field]:{before:old,after:newV}},conflict:true});
          s.conflicts.push({id:id(),kind:'plan',positionId:p.id,field,date:new Date().toISOString(),existing:copy(old),imported:copy(newV),reason:'Different values supplied; current retained and alternative stored in timeline.'});
          report.conflicts++;
        }
      }
    }
    if(!p.externalId&&incomingP.externalId)p.externalId=incomingP.externalId;
    if(!p.source&&incomingP.source)p.source=incomingP.source;
  }
  for(const item of b.adjustments||[]){
    const sameId=s.adjustments.find(x=>x.id===item.id);
    if(sameId&&!same(sameId,item)){
      if(!s.conflicts.some(x=>x.kind==='adjustment'&&x.imported?.id===item.id&&same(x.imported,item))){
        s.conflicts.push({id:id(),kind:'adjustment',date:new Date().toISOString(),existing:copy(sameId),imported:copy(item),reason:'Same realized P/L adjustment ID with conflicting value; not counted twice.'});report.conflicts++;
      }
    }else if(!sameId&&!s.adjustments.some(x=>x.accountId===item.accountId&&x.date===item.date&&Number(x.pnlCad)===Number(item.pnlCad)&&x.note===item.note))s.adjustments.push(copy(item));
    else report.duplicates++;
  }
  for(const item of b.brokerInbox||[]){if(!s.brokerInbox.some(x=>x.id===item.id)){s.brokerInbox.push(copy(item));report.importInbox++;}}
  for(const item of b.conflicts||[]){if(!s.conflicts.some(x=>x.id===item.id))s.conflicts.push(copy(item));}
  for(const item of b.archive||[]){
    const previous=s.archive.find(x=>x.id===item.id);
    if(!previous)s.archive.push(copy(item));
    else if(item.restoredAt&&(!previous.restoredAt||item.restoredAt>previous.restoredAt))previous.restoredAt=item.restoredAt;
  }
  reconcileTimelineArchives(s);
  reconcileArchivedLedger(s);
  for(const item of b.importLog||[]){if(!s.importLog.some(x=>x.id===item.id))s.importLog.push(copy(item));}
  s.customClosed=[...new Set([...s.customClosed,...(b.customClosed||[])])].sort();
  for(const p of s.positions){const a=s.accounts.find(x=>x.id===p.accountId);if(!a||calculatePosition(p,a,'9999-12-31').issues.length){throw new Error(`Import would create an impossible execution sequence on ${p.ticker}. No changes applied.`);}}
  return {next:normalizeLedger(s),report};
}
export function backupSnapshot(state){
  const s=normalizeLedger(state);
  return {...s,schema:SCHEMA,backup:{kind:'complete-recovery-and-chatgpt-handoff',createdAt:new Date().toISOString(),contains:['accounts','equityCheckpoints','positions','fills','exits','journalEntries','planHistory','brokerInbox','conflicts','importLog','adjustments','customClosed','archive'],canonicalMasterPolicy:'This is external source evidence. Do not write to DK Trading Review Master without explicit user commit; reconcile IDs and source before appending, and update NQ/SPX master per the project protocol.'}};
}
