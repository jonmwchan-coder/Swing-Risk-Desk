import fs from 'node:fs';
import assert from 'node:assert/strict';
const data=JSON.parse(fs.readFileSync(new URL('./fixtures/starter-example.json', import.meta.url),'utf8'));
const storage=new Map([['swing-risk-desk:data:v1',JSON.stringify(data)]]);
globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v))};
globalThis.location={protocol:'file:'};
Object.defineProperty(globalThis,'navigator',{value:{},configurable:true});
const controls={qty:'2',price:'1.5',fee:'1.5',stress:'70'};
const el=new Map();
function fakeElement(id){
 const obj={id,value:'',checked:false,innerHTML:'',textContent:'',hidden:false,style:{},dataset:{},classList:{toggle:()=>{},add:()=>{},remove:()=>{}},setAttribute:()=>{},addEventListener:()=>{},scrollIntoView:()=>{},querySelectorAll:()=>[],querySelector:()=>null,showModal:()=>{},close:()=>{}};
 if(id==='quickPlanner')obj.elements={namedItem:(name)=>({value:controls[name]??''}),...Object.fromEntries(Object.entries(controls).map(([k,v])=>[k,{value:v}]))};
 if(id==='settingsForm')obj.elements={namedItem:(name)=>({value:''})};
 return obj;
}
const getElementById=id=>{if(!el.has(id))el.set(id,fakeElement(id));return el.get(id);};
globalThis.document={getElementById,querySelectorAll:()=>[],querySelector:()=>null,addEventListener:()=>{},body:{appendChild:()=>{}},createElement:()=>({click:()=>{},remove:()=>{}})};
await import(new URL('../app.js', import.meta.url).href);
const h=getElementById('historyTable').innerHTML;
console.log('HTML characters',h.length);
assert.match(h,/TP TARGETS ON UNDERLYING/);
assert.match(h,/UNDERLYING INVALIDATION/);
assert.match(h,/DEMO/);
assert.match(getElementById('dashboardPositions').innerHTML,/DEMO/);
assert.match(getElementById('importInbox').innerHTML,/Import exceptions/);
console.log('App module boot/render smoke passed.');