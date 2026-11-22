import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
test('preview is selected per idea rather than rendered for each quick-size-check row',()=>{
 assert.match(app,/let selectedPreviewId=null/);
 assert.match(app,/data-action="analyze-idea"/);
 assert.match(app,/selectedPreviewId!==el\.dataset\.planId/);
 assert.match(app,/el\.hidden=true;el\.innerHTML='';return;/);
 assert.match(html,/id="optionPreview"[^>]+hidden/);
 assert.match(app,/function renderOptionPreview\(\)/);
});
test('next sessions, custom exit dates and extra TP targets have explicit controls',()=>{
 assert.match(app,/preview-add-date/);assert.match(app,/preview-add-target/);
 assert.match(app,/name="exit-date"/);assert.match(app,/name="target-price"/);
 assert.match(app,/MAX_PREVIEW_TARGETS/);
 assert.match(app,/Exit dates · 4 PM ET/);
});
test('quote refresh starts when Analyze % is selected or Refresh is explicitly clicked, without changing entry premium',()=>{
 assert.match(app,/case 'refresh-option-quote':void refreshOptionQuote\(\);break;/);
 assert.match(app,/if\(opening\)void refreshOptionQuote\(\);/);
 assert.match(app,/fetch\(`\/api\/option-quote\?symbol=/);
 assert.match(app,/unless you manually override it/);
 assert.match(app,/if\(valid&&!idea\.priceManual\)idea\.price=idea\.marketMid/);
 assert.match(sw,/swing-risk-desk-shell-v3\.12-contract-identity/);
 assert.match(sw,/\/lib\/option-preview\.mjs/);
});
test('cost and model output always describe currencies and limitations',()=>{
 assert.match(app,/Underlying \(USD\)/);
 assert.match(app,/Indicative bid \(USD\/share\)/);
 assert.match(app,/Modeled 1-day theta/);
 assert.match(app,/USD.*net/);
 assert.match(app,/European-style/);
 assert.match(app,/select <strong>Analyze %<\/strong>/i);
 assert.match(app,/One-time free data connection needed/);
 assert.doesNotMatch(app,/Interest rate \(\%\) <input/);
 assert.doesNotMatch(app,/Annual dividend yield \(\%\) <input/);
});
test('scrolling is confined to matrix; phone sizing remains responsive',()=>{
 assert.match(css,/\.preview-matrix-scroll\{[^}]*max-width:100%;overflow-x:auto/);
 assert.match(css,/@media\(max-width:690px\)\{\.option-preview/);
 assert.match(css,/\.option-preview\[hidden\]\{display:none!important\}/);
});

test('Scenario Studio header prioritizes readable contract and account identity',()=>{
 assert.match(app,/const previewIdentity=/);
 assert.match(app,/class="studio-contract-identity"/);
 assert.match(app,/class="studio-account-identity"/);
 assert.match(app,/esc\(account\(\)\.name\)/,'account comes from active portfolio');
 assert.match(app,/const displayContract=contractDisplayParts\(idea\)/);
 assert.match(app,/Projected option return by date<\/h3>\$\{previewIdentity\}/);
 assert.match(css,/\.studio-contract-expiry\{/);
 assert.match(css,/\.studio-contract-strike\{/);
 assert.match(css,/\.studio-account-identity strong\{/);
 assert.doesNotMatch(app,/esc\(\[idea\.ticker,idea\.name,idea\.expiry,idea\.strike,idea\.optionType\]/,'old microscopic summary removed');
});
