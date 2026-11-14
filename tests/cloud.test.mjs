import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import cloudConfig from '../api/cloud-config.js';

test('cloud config refuses calls until Vercel is configured',()=>{
 const oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_PUBLISHABLE_KEY;
 delete process.env.SUPABASE_URL;delete process.env.SUPABASE_PUBLISHABLE_KEY;
 const res={setHeader(){},status(n){this.code=n;return this;},json(x){this.body=x;}};
 cloudConfig({method:'GET'},res);
 assert.equal(res.code,503);
 assert.equal(JSON.stringify(res.body).includes('key'),false);
 if(oldUrl!==undefined)process.env.SUPABASE_URL=oldUrl;
 if(oldKey!==undefined)process.env.SUPABASE_PUBLISHABLE_KEY=oldKey;
});

test('cloud config exposes only public key and refuses service-role secrets',()=>{
 const oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_PUBLISHABLE_KEY,oldRole=process.env.SUPABASE_SERVICE_ROLE_KEY;
 process.env.SUPABASE_URL='https://example-ref.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='sb_publishable_test';process.env.SUPABASE_SERVICE_ROLE_KEY='SECRET_SERVER_KEY';
 const res={setHeader(){},status(n){this.code=n;return this;},json(x){this.body=x;}};
 cloudConfig({method:'GET'},res);
 assert.equal(res.code,200);assert.equal(res.body.anonKey,'sb_publishable_test');assert.equal(JSON.stringify(res.body).includes('SECRET_SERVER_KEY'),false);
 for(const [k,v] of [['SUPABASE_URL',oldUrl],['SUPABASE_PUBLISHABLE_KEY',oldKey],['SUPABASE_SERVICE_ROLE_KEY',oldRole]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('database policy isolates authenticated users and blocks stale updates',()=>{
 const sql=readFileSync(new URL('../supabase/schema.sql',import.meta.url),'utf8');
 assert.match(sql,/enable row level security/);
 assert.match(sql,/auth\.uid\(\)/);
 assert.match(sql,/current_revision <> p_expected_revision/);
 assert.match(sql,/errcode='40001'/);
 assert.match(sql,/revoke all on function.*from public, anon/);
});