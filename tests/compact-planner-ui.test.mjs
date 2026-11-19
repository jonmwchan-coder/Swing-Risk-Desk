import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
test('all ideas start collapsed with exactly one editable card at a time',()=>{
 assert.match(app,/let expandedPlanId=null/);
 assert.match(app,/expandedPlanId===idea.id/);
 assert.match(app,/case 'toggle-plan-details'/);
 assert.match(app,/case 'collapse-plan-ideas'/);
 assert.match(app,/class="draft-idea/);
 assert.match(app,/data-action="toggle-plan-details"/);
 assert.match(app,/\$\{editing\?\x60<div class="draft-editor"/);
});
test('sticky summary shows correctly labeled currencies, capacity, fees and explicit status',()=>{
 assert.match(html,/id="plannerSummaryStrip"/);
 assert.match(css,/\.planner-summary-strip\{position:sticky/);
 for(const text of ['IDEAS','TOTAL CASH · USD','RISK USED · CAD','RISK LEFT · CAD','STATUS','PREMIUMS · USD','FEES · USD'])assert.ok(app.includes(text));
 assert.match(app,/result\.overBudget\?'OVER BUDGET'/);
 assert.match(app,/result\.overIdeaCap\?'CAP REVIEW'/);
});
test('quote details and portfolio breakdown are expandable, no calculations deleted',()=>{
 assert.match(app,/<details class="draft-quote-detail">/);
 assert.match(html,/<details id="plannerImpactDetails"/);
 assert.match(app,/calculatePlanBasket\(ideas,m\.account,m\.availableCad\)/);
 assert.match(app,/updateOptionPreviewResults\(\)/);
 assert.match(app,/data-plan-status/);
 assert.match(app,/Alpaca Basic/);
});
