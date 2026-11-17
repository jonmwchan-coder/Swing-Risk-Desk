import fs from 'node:fs';
import assert from 'node:assert/strict';
const data=JSON.parse(fs.readFileSync(new URL('./fixtures/starter-example.json', import.meta.url),'utf8'));
// Fractional raw premium is kept in the data, but history displays two decimals.
data.positions[0].fills[0].price=2.7345;
// A partial TP leaves a runner open; both pages should show realized % from its SOLD basis.
data.positions[0].exits.push({id:'synthetic-sale',date:'2026-10-05',time:'12:00',qty:1,price:3.25,fee:0.8,fx:1.4});
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
assert.ok(h.includes("<th>TP</th>"));
assert.ok(h.includes('<th>CONTRACT</th>'));
assert.ok(h.includes('<th>P/L</th><th>RETURN %</th><th>ACTIONS</th>'),'Return percent belongs immediately after P/L');
assert.ok(h.includes('data-label="RETURN %"'));
assert.ok(h.includes('data-label="RETURN %" title='));
assert.match(h,/data-label="RETURN %"[^>]*>\+?\d+\.\d%</,'An exit with a basis shows the realized return');
assert.ok(h.includes('10/02/26'));
assert.ok(h.includes('$2.73'));
assert.ok(!h.includes('$2.7345'));
assert.ok(h.includes('>----</span>'), 'Non-exit transactions use short EXIT placeholder');
assert.ok(h.includes('data-label="REALIZED CAD"') && h.includes('>----</td>'), 'Non-realized P/L uses short placeholder');
assert.ok(!h.includes('Not realized'), 'Long P/L placeholder removed');
assert.ok(!h.includes('Not an exit'), 'Long EXIT placeholder removed');
assert.ok(h.includes('history-cell-scroll'));
assert.equal(data.positions[0].fills[0].price,2.7345);
const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
assert.ok(!css.includes('.app-shell.history-wide'));
assert.ok(css.includes('.history-table.expanded-ledger{min-width:0}'));
assert.ok(css.includes('@media(max-width:1100px)'), 'Responsive text-wrap breakpoint');
assert.ok(css.includes('white-space:pre-wrap;overflow:visible;overflow-wrap:anywhere'), 'Narrow screens wrap notes without clipping');
assert.ok(h.includes("<th>INVALIDATION</th>"));
assert.match(h,/DEMO/);
assert.match(getElementById('dashboardPositions').innerHTML,/DEMO/);
assert.match(getElementById('positionsFull').innerHTML,/REALIZED NET<\/div>/);
assert.match(getElementById('positionsFull').innerHTML,/REALIZED RETURN<\/div>/);
assert.match(getElementById('positionsFull').innerHTML,/Closed contracts · net of fees/);
assert.match(getElementById('positionsFull').innerHTML,/REALIZED RETURN<\/div><strong[^>]*>\+?\d+\.\d%</);
assert.match(getElementById('quickPlanner').innerHTML,/draft-idea/);
assert.match(getElementById('plannerResult').innerHTML,/INCOMPLETE/);
assert.match(getElementById('plannerResult').innerHTML,/Combined planned/);
assert.match(getElementById('importInbox').innerHTML,/Import exceptions/);

// Wide-screen thesis/catalyst text should wrap without relying on the <=1100px breakpoint.
assert.match(css,/\/\* v1\.8\.1: thesis \/ catalyst should wrap naturally on widescreen too\./);
assert.match(css,/\.history-table\.expanded-ledger \.history-thesis-cell \.history-cell-scroll\s*\{[^}]*white-space:pre-wrap;[^}]*overflow:visible;/);
console.log('App module boot/render smoke passed.');

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
assert.match(html,/name="buyFeePerContractUsd"/);
assert.match(html,/name="sellFeePerContractUsd"/);
assert.match(getElementById('quickPlanner').innerHTML,/data-action="reset-draft-fee"/);
assert.match(getElementById('quickPlanner').innerHTML,/name="fee"[^>]*value="0\.77"/);

// v2.0 loss rule must be visible, without suggesting that unrelated winners offset losses.
assert.match(html,/ROLLING NET LOSSES/);
assert.match(html,/Only partials from the same position\/attempt offset one another/);
assert.match(getElementById('lossHint').textContent,/Gross negative realized entries/);
assert.match(getElementById('releaseBox').innerHTML,/No scheduled change in rolling losses/);
