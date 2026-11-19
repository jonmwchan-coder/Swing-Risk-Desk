import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPlanIdea} from '../lib/planner.mjs';
import {normalizePlannerDrafts} from '../lib/planner-storage.mjs';
import {draftContract,draftContractKey,sortPlanIdeas} from '../lib/planner-contract.mjs';
import handler from '../api/option-contract.js';

function fakeResponse(){return {statusCode:200,body:null,setHeader(){return this;},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};}
test('independent dynamic ticker contracts retain distinct identities',()=>{
 const iren={...defaultPlanIdea('a'),ticker:'iren',expiry:'2027-01-15',strike:'35',optionType:'Call'};
 const ttwo={...defaultPlanIdea('b'),ticker:'TTWO',expiry:'2027-01-15',strike:'100',optionType:'Put'};
 assert.deepEqual(draftContract(iren),{ticker:'IREN',expiry:'2027-01-15',strike:35,optionType:'Call'});
 assert.notEqual(draftContractKey(iren),draftContractKey(ttwo));
 assert.equal(draftContract({...iren,strike:''}),null);
 assert.equal(draftContract({...iren,expiry:'2027-02-30'}),null);
});
test('several saved ideas for same ticker preserve independent names, prices and assumptions',()=>{
 const x=normalizePlannerDrafts({bdi:[
  {id:'one',ticker:'IREN',name:'Breakout',expiry:'2027-01-15',strike:'35',optionType:'Call',price:'2.15',priceManual:true,preview:{spot:'45'}},
  {id:'two',ticker:'IREN',name:'Bounce',expiry:'2027-02-19',strike:'40',optionType:'Put',price:'1.5'}
 ]}).bdi;
 assert.equal(x.length,2);assert.equal(x[0].name,'Breakout');assert.equal(x[1].name,'Bounce');
 assert.notEqual(draftContractKey(x[0]),draftContractKey(x[1]));
 assert.equal(x[0].priceManual,true);assert.equal(x[1].priceManual,true);
});
test('ticker name and expiration sorting do not alter original allocation order',()=>{
 const a=[{id:'1',ticker:'TTWO',name:'Z',expiry:'2027-02-19'},{id:'2',ticker:'IREN',name:'A',expiry:'2027-01-15'}];
 assert.deepEqual(sortPlanIdeas(a,'ticker').map(x=>x.id),['2','1']);
 assert.deepEqual(sortPlanIdeas(a,'name').map(x=>x.id),['2','1']);
 assert.deepEqual(sortPlanIdeas(a,'expiry').map(x=>x.id),['2','1']);
 assert.deepEqual(a.map(x=>x.id),['1','2']);
});
test('read-only exact contract endpoint distinguishes unavailable keys from invalid symbols',async()=>{
 const old=process.env.ALPACA_DATA_KEY_ID;delete process.env.ALPACA_DATA_KEY_ID;
 try{
  let out=fakeResponse();await handler({method:'GET',query:{symbol:'IREN270115C00035000'},headers:{}},out);
  assert.equal(out.statusCode,503);assert.equal(out.body.code,'NOT_CONFIGURED');
  out=fakeResponse();await handler({method:'GET',query:{symbol:'invalid'},headers:{}},out);
  assert.equal(out.statusCode,400);
 }finally{if(old!==undefined)process.env.ALPACA_DATA_KEY_ID=old;}
});
