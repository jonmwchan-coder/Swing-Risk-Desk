import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../api/option-quote.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
test('Analyze % automatically requests only the selected idea quote once, not all ideas',()=>{
 assert.match(app,/case 'analyze-idea':\{const opening=.*?if\(opening\)\{void ensureAtmRange\(currentPreviewIdea\(\)\);void refreshOptionQuote\(\);\}break;\}/);
 assert.match(app,/currentPreviewIdea\(\)\?\.id!==idea\.id/);
 assert.match(app,/symbol=buildOCCSymbol\(draftContract\(idea\)\)/);
});
test('unconfigured feed displays a one-time setup card and never suggests unauthenticated market data exists',()=>{
 assert.match(server,/code:'NOT_CONFIGURED'/);
 assert.match(app,/quoteConnectionState=data\.code==='NOT_CONFIGURED'\?'not-configured':'failed'/);
 assert.match(app,/quoteConnectionState==='not-configured'/);
 assert.match(app,/One-time free data connection needed/);
 assert.match(app,/https:\/\/app\.alpaca\.markets\/signup/);
});
test('spot, IV, bid and ask display automatically as read-only quote fields with optional collapsed fallback',()=>{
 assert.match(app,/class="preview-market-grid"/);
 assert.match(app,/data-market-key="spot"/);
 assert.match(app,/data-market-key="ivPct"/);
 assert.match(app,/data-market-key="bid"/);
 assert.match(app,/data-market-key="ask"/);
 assert.match(app,/<details class="preview-manual">/);
 assert.match(css,/\.preview-market-grid\{display:grid/);
});
test('rate and dividend are no longer user inputs but fixed assumptions are disclosed',()=>{
 assert.match(app,/preview:\{\.\.\.idea\.preview,dates:visibleTickerDates\(idea\)\.visible\.map\(x=>x\.date\),ratePct:'4',dividendPct:'0'\}/);
 assert.match(app,/fixed internal 4% annual interest and 0% dividend yield assumptions/);
 assert.doesNotMatch(app,/name="ratePct"/);
 assert.doesNotMatch(app,/name="dividendPct"/);
});
test('changing option contract invalidates previously refreshed quote and never changes planned entry premium',()=>{
 assert.match(app,/const changed=\['ticker','expiry','strike','optionType'\]/);
 assert.match(app,/p\.spot='';p\.ivPct='';p\.ivManual=false;p\.bid='';p\.ask='';p\.quoteAt='';/);
 assert.match(app,/if\(valid&&!idea\.priceManual\)idea\.price=idea\.marketMid/);
});
