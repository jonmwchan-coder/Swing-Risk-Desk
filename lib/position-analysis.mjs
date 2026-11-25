/* Independent, ledger-backed option scenario history. No pricing or risk edits. */
import {draftContract,draftContractKey} from './planner-contract.mjs';
import {emptyPreview,normalizePreview,projectOptionReturns} from './option-preview.mjs';
import {ratePerContract} from './fees.mjs';
const copy=x=>JSON.parse(JSON.stringify(x));
const present=x=>x!==null&&x!==undefined&&String(x).trim()!=='';
const validNumber=x=>present(x)&&Number.isFinite(Number(x));
const validBasis=b=>b&&Number.isInteger(Number(b.qty))&&Number(b.qty)>0&&validNumber(b.price)&&Number(b.price)>0&&validNumber(b.fee)&&Number(b.fee)>=0;
export function positionAnalysisEvents(position){
 return (Array.isArray(position?.analysisHistory)?position.analysisHistory:[]).filter(x=>x&&typeof x.id==='string'&&['entry','revision'].includes(x.kind)&&Number.isFinite(Date.parse(x.capturedAt))).sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt)||a.id.localeCompare(b.id));
}
export function captureDraftAnalysis(position,draft,fill,account,recordedAt=new Date().toISOString()){
 if(!draft?.draftId||!fill?.id||!draftContractKey(position)||draftContractKey(position)!==draftContractKey(draft))return null;
 const capturedAt=Number.isFinite(Date.parse(draft.analysisCapturedAt))?draft.analysisCapturedAt:recordedAt;
 const event={id:'entry:'+fill.id,kind:'entry',capturedAt,recordedAt,source:'Quick Size Check at Record click',contract:draftContract(position),multiplier:Number(position.multiplier||100),fillId:fill.id,
 basis:{qty:fill.qty,price:fill.price,fee:fill.fee,date:fill.date,time:fill.time||'',timeUnverified:!!fill.timeUnverified,fx:fill.fx,sellFee:ratePerContract(account,'SELL')},
 draft:copy(Object.fromEntries(['draftId','name','label','qty','price','fee','stress','plannedLossPct','marketMid','contractSymbol','quoteStatus','quoteMessage','priceManual','feeManual'].filter(k=>draft[k]!==undefined).map(k=>[k,draft[k]]))),
 confirmedPlan:copy({plannedLossPct:position.plannedLossPct??null,stressPct:position.stressPct??null,underlyingInvalidation:position.underlyingInvalidation||'',targetLevels:position.targetLevels||''}),
 preview:draft.preview?copy(draft.preview):null};
 position.analysisHistory??=[];
 if(!position.analysisHistory.some(x=>x.id===event.id))position.analysisHistory.push(event);
 return event;
}
export function currentAnalysisBasis(position,metrics,account,asOf){
 if(Number(position.multiplier||100)!==100||!metrics?.qty||metrics.issues?.length)return null;
 if((position.fills||[]).some(f=>f.date<=asOf&&(!validNumber(f.price)||Number(f.price)<=0||!validNumber(f.fee)||Number(f.fee)<0)))return null;
 const qty=metrics.qty,price=metrics.averageEntryUsd,fee=Math.max(0,metrics.remainingCostUsd-qty*price*100);
 const b={qty,price,fee,sellFee:ratePerContract(account,'SELL')};
 return validBasis(b)?b:null;
}
export function workingAnalysisPreview(position,day,closed=[]){
 const events=positionAnalysisEvents(position);
 const key=draftContractKey(position);
 const candidates=[...events].reverse().filter(x=>x.preview&&draftContractKey(x.contract)===key);
 const latest=candidates.find(x=>x.kind==='revision'||x.preview.tickerPlanEditedAt||x.preview.targets?.some(t=>present(t.price)))||candidates[0];
 const p=latest?normalizePreview(copy(latest.preview),day,closed):emptyPreview(day,closed);
 // Never pass the old underlying / bid / ask off as today's market values.
 // Keep the target/date plan and any explicit manually entered IV assumption.
 p.spot='';p.bid='';p.ask='';if(!p.ivManual)p.ivPct='';
 p.quoteAt='';p.quoteSource=p.ivManual?'Saved manual IV assumption; refresh current quote':'Awaiting current reference';
 p.tickerLinked=false;p.tickerLinkEstablished=false;
 return {preview:p,source:latest||null};
}
export function appendAnalysisRevision(position,preview,basis,eventId,at=new Date().toISOString()){
 if(!eventId||!validBasis(basis)||!draftContract(position))throw Error('Position analysis is not ready to save.');
 const event={id:eventId,kind:'revision',capturedAt:at,recordedAt:at,source:'Position Analyze % — user saved working scenario',contract:draftContract(position),multiplier:Number(position.multiplier||100),basis:copy(basis),preview:copy(preview)};
 position.analysisHistory??=[];
 if(position.analysisHistory.some(x=>x.id===eventId))throw Error('Analysis event ID already exists.');
 position.analysisHistory.push(event);return event;
}
export function modelPositionAnalysis({contract,preview,basis,asOf,multiplier=100,closed=[],includeExpiryDay=false}){
 if(Number(multiplier)!==100)return {valid:false,reason:'Adjusted/nonstandard option contracts are not supported by this 100-share model.'};
 if(!validBasis(basis))return {valid:false,reason:'A verified positive entry premium, quantity and acquisition cost are required.'};
 if(!preview)return {valid:false,reason:'No scenario inputs were captured with this entry.'};
 return projectOptionReturns({contract,preview,qty:Number(basis.qty),entryPremium:Number(basis.price),entryFeeUsd:Number(basis.fee),sellFeePerContractUsd:Number(basis.sellFee||0),asOf,allowEntryAnchor:false,closed,includeExpiryDay});
}
