import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
test('ledger, sizing, and projection occur in this order as three full-width dashboard rows',()=>{
 assert.match(html,/<div class="dashboard-panel-stack">/);
 const ledger=html.indexOf('class="panel window-panel"');
 const sizing=html.indexOf('class="panel scenario-panel"');
 const preview=html.indexOf('id="optionPreview"');
 const runway=html.indexOf('class="panel runway-panel"');
 assert.ok(ledger>=0 && ledger<sizing && sizing<preview && preview<runway);
 assert.equal((html.match(/id="optionPreview"/g)||[]).length,1);
 assert.ok(html.slice(sizing,preview).includes('id="quickPlanner"'));
 assert.ok(html.slice(sizing,preview).includes('id="plannerResult"'));
 assert.match(css,/\.dashboard-panel-stack\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
 assert.match(css,/\.dashboard-panel-stack>\.option-preview\{margin-top:0\}/);
});
test('Analyze % brings the selected standalone preview into view, retaining quote request',()=>{
 assert.match(app,/\$\('optionPreview'\)\?\.scrollIntoView\(\{block:'start',behavior:'smooth'\}\)/);
 assert.match(app,/if\(opening\)\$\('optionPreview'\)\?\.scrollIntoView/);
 assert.match(app,/void refreshOptionQuote\(\)/);
 assert.match(sw,/swing-risk-desk-shell-v3\.10-regular-expiries/);
 assert.match(html,/SWING RISK DESK \/ v3\.10 regular expiration filter/);
});
