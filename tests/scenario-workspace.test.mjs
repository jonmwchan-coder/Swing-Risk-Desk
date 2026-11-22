import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const styles=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');

test('selected idea highlight continues to follow active analysis or editor only',()=>{
 assert.match(app,/const editing=expandedPlanId===idea\.id,active=editing\|\|selectedPreviewId===idea\.id;/);
 assert.match(app,/case 'analyze-idea':\{const opening=selectedPreviewId!==el\.dataset\.planId\|\|optionPanelMode!=='analyze';/);
 assert.match(styles,/\.draft-idea\.is-active\{/);
 assert.doesNotMatch(app,/case 'select-plan-idea'/);
});

test('projection is unmistakably its own scenario workspace',()=>{
 assert.match(app,/SCENARIO STUDIO · WHAT-IF MODEL/);
 assert.doesNotMatch(app,/class="preview-lab-intro"/);
 assert.doesNotMatch(app,/<strong>WHAT-IF ANALYSIS<\/strong>/);
 assert.match(app,/MODEL, NOT FORECAST/);
 assert.match(app,/class="preview-output-title"/);
 assert.match(app,/Scenario return matrix/);
 assert.match(styles,/\.option-preview\{[\s\S]*--studio-lilac:/);
 assert.doesNotMatch(styles,/\.preview-lab-intro\{/);
 assert.match(styles,/\.option-preview \.preview-matrix td\.preview-profit-cell\{/);
 assert.match(styles,/\.option-preview \.preview-matrix td\.preview-loss-cell\{/);
 assert.match(sw,/swing-risk-desk-shell-v3\.10-regular-expiries/);
});

test('missing-IV response is explained and manual IV is retained on quote refresh',()=>{
 assert.match(app,/IV not supplied by Alpaca for this contract/);
 assert.match(app,/data-action="enter-manual-iv"/);
 assert.match(app,/case 'enter-manual-iv'/);
 assert.match(app,/manualIv=p\.ivManual&&Number\(p\.ivPct\)>0\?p\.ivPct:null/);
 assert.match(app,/if\(manualIv!==null\)p\.ivPct=manualIv/);
 assert.match(app,/if\(!preview\.ivManual\|\|!\(Number\(preview\.ivPct\)>0\)\)preview\.ivPct=data\.ivPct/);
 assert.match(app,/if\(name==='ivPct'\)\{p\.ivManual=Number\(p\.ivPct\)>0/);
 assert.match(app,/p\.spot='';p\.ivPct='';p\.ivManual=false;/);
 assert.match(styles,/\.preview-iv-help\[hidden\]\{display:none\}/);
});