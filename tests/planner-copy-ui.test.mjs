import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const sw=fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8');
test('copy button opens a destination-picker and will never write ledger positions',()=>{
 assert.match(html,/data-action="toggle-planner-copy"/);
 assert.match(html,/id="plannerCopyTarget"/);
 assert.match(html,/id="plannerCopyPanel"[^>]+hidden/);
 assert.match(app,/case 'confirm-planner-copy':confirmPlannerCopy\(\)/);
 assert.match(app,/copyPlannerIdeas\(plannerDrafts,account\(\)\.id,targetId,uid,state\.accounts\.map\(x=>x\.id\)\)/);
 assert.match(app,/if\(!plannerStorageHealthy\)\{plannerDrafts=previous/);
 assert.match(css,/\.planner-copy-panel\[hidden\]\{display:none!important\}/);
 assert.match(app,/state\.accounts\.length<2/);
 assert.match(sw,/\/lib\/planner-workflows\.mjs/);
});
test('ticker shared targets are linked by symbol and side with user-owned opt-out',()=>{
 assert.match(app,/tickerScenarioKey\(idea\)/);
 assert.match(app,/case 'toggle-ticker-link'/);
 assert.match(app,/data-action="toggle-ticker-link"/);
 assert.match(app,/publishTickerLevels\(idea\)/);
 assert.match(app,/adoptTickerLevels\(currentPreviewIdea\(\)\)/);
 assert.match(app,/No exit dates occur on or before this contract expiration/);
 assert.match(app,/visibleTickerDates\(idea\)\.visible\.map/);
 assert.match(html,/id="optionPreview"/);
});
