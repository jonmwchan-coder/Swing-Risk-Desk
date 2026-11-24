import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const helperStart=source.indexOf('const money='),helperEnd=source.indexOf('\n',source.indexOf('const cadWithUsd='));
const {usdWithCad,cadWithUsd}=new Function(source.slice(helperStart,helperEnd)+'\nreturn {usdWithCad,cadWithUsd};')();
test('currency display rounds to two decimals without altering source price',()=>{
 const premium=1.104567;
 assert.equal(usdWithCad(premium,1.4),'<span class="pos-usd">USD $1.10</span> <span class="pos-cad">(CAD $1.55)</span>');
 assert.equal(premium,1.104567);
 assert.match(cadWithUsd(-140,1.4),/USD -\$100\.00.*CAD -\$140\.00/);
});
test('dashboard and positions share dual-currency average entry and cost basis',()=>{
 const start=source.indexOf('function positionCard('),end=source.indexOf('function renderTimeline(',start),card=source.slice(start,end);
 assert.match(card,/usdWithCad\(z\.averageEntryUsd,fx\)/);
 assert.match(card,/dualPositionMoney\(z\.remainingCostUsd,z\.premiumCad\)/);
 assert.doesNotMatch(card,/usd\(z\.averageEntryUsd,4\)/);
 assert.doesNotMatch(html,/OPEN PREMIUM AT COST/);
 assert.match(html,/OPEN COST BASIS/);
});
