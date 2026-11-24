import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=source.indexOf('const money='),end=source.indexOf('\n',source.indexOf('const cadWithUsd='));
const a=source.indexOf('function availableRiskMarkup('),b=source.indexOf('function renderOverview(',a);
const availableRiskMarkup=new Function(source.slice(start,end)+'\n'+source.slice(a,b)+'\nreturn availableRiskMarkup;')();
test('CAD headline displays available risk of full rolling ceiling, including zero and negative capacity',()=>{
 assert.match(availableRiskMarkup({availableCad:1625,budgetCad:1800}),/CAD \$1,625\.00<\/span>.*of CAD \$1,800\.00/);
 assert.match(availableRiskMarkup({availableCad:-25,budgetCad:600}),/CAD -\$25\.00<\/span>.*of CAD \$600\.00/);
 assert.match(availableRiskMarkup({availableCad:0,budgetCad:0}),/CAD \$0\.00<\/span>.*of CAD \$0\.00/);
});
test('summary cards appear once and in requested order, with no obsolete DOM updates',()=>{
 const grid=html.slice(html.indexOf('<div class="metric-grid">'),html.indexOf('<div class="equity-tracker"'));
 assert.deepEqual([...grid.matchAll(/<strong id="([^"]+)"/g)].map(x=>x[1]),['costMetric','reservedMetric','lossMetric']);
 assert.doesNotMatch(source,/\$\('capMetric'\)|\$\('capHint'\)/);
 assert.match(source,/\$\('costMetric'\)\.innerHTML=dualPositionMoney\(m\.positions\.reduce\(\(sum,x\)=>sum\+x\.metrics\.remainingCostUsd,0\),m\.fullPremiumCad\)/);
});
