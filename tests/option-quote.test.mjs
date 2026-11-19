import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/option-quote.js';
const req=(symbol='INTC270115C00070000',method='GET')=>({method,query:{symbol},headers:{origin:'https://swing-risk-desk-vercel-v11.vercel.app'}});
function response(){return {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(o){this.body=o;return this;}};}
test('quote endpoint is read-only and safely refuses missing credentials',async()=>{
 const before=process.env.ALPACA_DATA_KEY_ID;
 delete process.env.ALPACA_DATA_KEY_ID;
 try{
  const res=response();await handler(req(),res);
  assert.equal(res.statusCode,503);assert.match(res.body.error,/not connected/);
  assert.equal(res.headers['Cache-Control'],'no-store, max-age=0');
  const r2=response();await handler(req('bad-symbol'),r2);assert.equal(r2.statusCode,400);
  const r3=response();await handler(req(undefined,'POST'),r3);assert.equal(r3.statusCode,405);
 }finally{if(before!==undefined)process.env.ALPACA_DATA_KEY_ID=before;}
});

test('mocked Alpaca Basic snapshot maps to indicative bid/ask, today IV and IEX spot without exposing keys',async()=>{
 const old={id:process.env.ALPACA_DATA_KEY_ID,secret:process.env.ALPACA_DATA_SECRET_KEY,fetch:globalThis.fetch};
 process.env.ALPACA_DATA_KEY_ID='TEST_ONLY_FREE_DATA';process.env.ALPACA_DATA_SECRET_KEY='TEST_ONLY_PRIVATE_KEY';
 const visited=[];
 globalThis.fetch=async(url,init)=>{
  visited.push({url:String(url),headers:init.headers});
  if(String(url).includes('/options/snapshots'))return {ok:true,json:async()=>({snapshots:{INTC270115C00070000:{latestQuote:{bp:1.25,ap:1.35,t:'2026-11-19T14:35:11Z'},impliedVolatility:0.42,greeks:{theta:-0.027}}}})};
  return {ok:true,json:async()=>({trade:{p:70.50,t:'2026-11-19T14:35:00Z'}})};
 };
 try{
  const res=response();await handler(req(),res);
  assert.equal(res.statusCode,200);assert.equal(res.body.optionBidUsd,1.25);assert.equal(res.body.optionAskUsd,1.35);
  assert.equal(res.body.ivPct,42);assert.equal(res.body.spotUsd,70.5);assert.equal(res.body.quoteType,'INDICATIVE_NOT_OPRA');
  assert.equal(res.body.thetaPerSharePerDay,-0.027);assert.equal(visited.length,2);
  assert.ok(visited[0].url.includes('feed=indicative'));assert.ok(visited[1].url.includes('feed=iex'));
  assert.ok(!JSON.stringify(res.body).includes('TEST_ONLY_PRIVATE_KEY'));
 }finally{globalThis.fetch=old.fetch;if(old.id===undefined)delete process.env.ALPACA_DATA_KEY_ID;else process.env.ALPACA_DATA_KEY_ID=old.id;if(old.secret===undefined)delete process.env.ALPACA_DATA_SECRET_KEY;else process.env.ALPACA_DATA_SECRET_KEY=old.secret;}
});
