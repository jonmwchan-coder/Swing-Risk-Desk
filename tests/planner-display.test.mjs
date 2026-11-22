import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
// Synthetic record and hypothetical drafts only; never use user account data in source.
const data=JSON.parse(fs.readFileSync(new URL('./fixtures/starter-example.json', import.meta.url),'utf8'));
data.positions=[];
const original=JSON.stringify(data);
const drafts={version:2,savedAt:'2026-11-19T14:00:00.000Z',accounts:{bdi:[
 {id:'priced-one',label:'INTC 1/15/27 70C',qty:'2',price:'1.50',fee:'1.54',feeManual:true,stress:'70',stressCustom:false},
 {id:'priced-two',label:'SMH 11/27/26 400P',qty:'1',price:'0.50',fee:'0.77',feeManual:true,stress:'70',stressCustom:false}
]}};
const storage=new Map([
 ['swing-risk-desk:data:v1',original],
 ['swing-risk-desk:planning-board:v2',JSON.stringify(drafts)]
]);
globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))};
globalThis.location={protocol:'file:'};
Object.defineProperty(globalThis,'navigator',{value:{},configurable:true});
const els=new Map(),statuses=new Map();
function elem(id){
 const obj={id,value:'',checked:false,innerHTML:'',textContent:'',hidden:false,style:{},dataset:{},className:'',
  classList:{toggle:()=>{},add:()=>{},remove:()=>{}},setAttribute:()=>{},addEventListener:()=>{},scrollIntoView:()=>{},querySelectorAll:()=>[],querySelector:()=>null,showModal:()=>{},close:()=>{}};
 if(id==='quickPlanner'){
  let html='';Object.defineProperty(obj,'innerHTML',{get:()=>html,set:value=>{
   html=String(value);statuses.clear();
   for(const m of html.matchAll(/data-plan-status="([^"]+)"/g))statuses.set(m[1],{dataset:{planStatus:m[1]},innerHTML:'',className:''});
  }});
 }
 if(id==='settingsForm')obj.elements={namedItem:()=>({value:''})};
 return obj;
}
function getElementById(id){if(!els.has(id))els.set(id,elem(id));return els.get(id);}
globalThis.document={getElementById,querySelectorAll:selector=>selector==='[data-plan-status]'?[...statuses.values()]:[],querySelector:()=>null,addEventListener:()=>{},body:{appendChild:()=>{}},createElement:()=>({click:()=>{},remove:()=>{}})};
await import(new URL('../app.js', import.meta.url).href);

test('a priced idea shows USD premiums, estimated buy fees, and CAD risk-budget capacity',()=>{
 const first=statuses.get('priced-one');
 assert.ok(first, 'first idea rendered');
 assert.match(first.innerHTML,/Option premiums \(USD\)<\/span><strong>USD \$300\.00<\/strong>/);
 assert.match(first.innerHTML,/2 contracts × USD \$1\.50 per share × 100/);
 assert.match(first.innerHTML,/Estimated buy fees \(USD\)<\/span><strong>USD \$1\.54<\/strong>/);
 assert.match(first.innerHTML,/5-day risk budget used \(CAD\)<\/span><strong>CAD \$300\.00<\/strong>/);
 assert.match(first.innerHTML,/not cash paid to IBKR/);
 assert.match(first.innerHTML,/Remaining Risk Budget \(CAD\)<\/span><strong>CAD \$300\.00<\/strong>/);
});

test('multi-entry summary separates USD premiums, USD fees, total USD cash, and CAD risk',()=>{
 const second=statuses.get('priced-two');
 assert.match(second.innerHTML,/Option premiums \(USD\)<\/span><strong>USD \$50\.00<\/strong>/);
 const html=getElementById('plannerResult').innerHTML;
 assert.match(html,/Combined option premiums[^<]*<\/span><strong>USD \$350\.00<\/strong>/);
 assert.match(html,/Combined estimated buy fees \(USD\)<\/span><strong>USD \$2\.31<\/strong>/);
 assert.match(html,/Total cash to buy all ideas[^<]*<\/span><strong>USD \$352\.31<\/strong>/);
 assert.match(html,/5-day risk budget used by these ideas \(CAD\)<\/span><strong>CAD \$350\.00<\/strong>/);
 assert.match(html,/5-day risk budget left after all ideas \(CAD\)<\/span><strong>CAD \$250\.00<\/strong>/);
 assert.match(html,/1 USD = 1\.4000 CAD/);
 assert.equal(storage.get('swing-risk-desk:data:v1'),original,'planning views never write trade records');
});
