import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {calculatePlanBasket,activeIdeaCapCad} from '../lib/planner.mjs';
import {normalizeLedger} from '../lib/ledger.mjs';

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const draft=(id,qty,price)=>({id,qty:String(qty),price:String(price),fee:'0',stress:'70'});
const account={fx:1.4,mode:'stress',stressPct:70,roundStep:25,ideaCapCad:200,ideaCapMode:'fixed'};

test('legacy optional $200 per-idea guide still flags the offending draft without changing the rolling pool',()=>{
 const result=calculatePlanBasket([draft('single',4,1.50)],account,600);
 assert.equal(activeIdeaCapCad(account),200);
 assert.equal(result.rows[0].reserveCad,600);
 assert.equal(result.rows[0].overIdeaCap,true);
 assert.equal(result.overIdeaCap,true);
 assert.equal(result.overBudget,false);
 assert.equal(result.remainingCad,0);
});

test('flexible mode permits one $600 idea or two $300 ideas only while aggregate risk fits',()=>{
 const pool={...account,ideaCapMode:'pool'};
 assert.equal(activeIdeaCapCad(pool),null);
 const one=calculatePlanBasket([draft('single',4,1.50)],pool,600);
 assert.equal(one.rows[0].reserveCad,600);
 assert.equal(one.rows[0].overIdeaCap,false);
 assert.equal(one.overIdeaCap,false);
 assert.equal(one.remainingCad,0);
 const two=calculatePlanBasket([draft('first',2,1.50),draft('second',2,1.50)],pool,600);
 assert.deepEqual(two.rows.map(r=>r.reserveCad),[300,300]);
 assert.equal(two.overIdeaCap,false);
 assert.equal(two.overBudget,false);
 assert.equal(two.remainingCad,0);
});

test('switching off optional idea-cap alerts never bypasses the rolling ceiling',()=>{
 const pool={...account,ideaCapMode:'pool'};
 const result=calculatePlanBasket([draft('single',4,1.50)],pool,500);
 assert.equal(result.overIdeaCap,false);
 assert.equal(result.overBudget,true);
 assert.equal(result.remainingCad,-100);
});

test('new and old portfolios preserve fixed cap guide; uncapped old portfolios use flexible pool',()=>{
 const base={id:'test',name:'Test',equityCad:20000,fx:1.4,roundStep:25,window:5,riskPct:3,stressPct:70,mode:'stress',
  equityCheckpoints:[{id:'first',date:'2026-11-19',createdAt:'2026-11-19T00:00:00Z',equityCad:20000,realizedPnlCad:0}]};
 const make=fields=>normalizeLedger({schema:'swing-risk-desk-v2',accounts:[{...base,...fields}],positions:[],adjustments:[]}).accounts[0];
 assert.equal(make({ideaCapCad:200}).ideaCapMode,'fixed');
 assert.equal(make({ideaCapCad:200,ideaCapMode:'pool'}).ideaCapMode,'pool');
 assert.equal(make({ideaCapCad:null}).ideaCapMode,'pool');
});

test('compact cards disclose exactly who exceeded the fixed idea cap and provide a direct review action',()=>{
 assert.ok(app.includes("is-over-idea-cap"));
 assert.ok(app.includes("data-cap-warning="));
 assert.ok(app.includes("ABOVE FIXED IDEA CAP"));
 assert.ok(app.includes("Review policy"));
 assert.ok(app.includes("plannerCapFlagSummary"));
 assert.ok(app.includes("data-action=\"jump-to-cap-idea\""));
 assert.ok(app.includes("case 'jump-to-cap-idea':"));
 assert.ok(app.includes("case 'focus-cap-policy':"));
 assert.ok(css.includes(".draft-idea.is-over-idea-cap"));
 assert.ok(css.includes(".planner-cap-flag-summary"));
});

test('allocation choice explicitly changes optional guide without changing rolling reserve calculations',()=>{
 assert.ok(html.includes('id="plannerCapMode"'));
 assert.ok(html.includes('value="fixed"'));
 assert.ok(html.includes('value="pool"'));
 assert.ok(html.includes('name="ideaCapMode"'));
 assert.ok(app.includes("a.ideaCapMode=mode"));
 assert.ok(app.includes("if(!save())"));
 assert.ok(app.includes("activeIdeaCapCad(m.account)"));
 assert.ok(app.includes("const ideaCap=activeIdeaCapCad(m.account)"));
 assert.ok(app.includes("Switch"));
 assert.ok(html.includes("Neither setting changes the portfolio"));
});
