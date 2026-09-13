import test from 'node:test';
import assert from 'node:assert/strict';
import {timingSafeEqual} from 'node:crypto';
import gateway from '../worker.js';
import {readFileSync} from 'node:fs';
crypto.subtle.timingSafeEqual ??= (a,b)=>timingSafeEqual(Buffer.from(a),Buffer.from(b));
test('every static asset runs through login gate',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url)));
  assert.equal(config.assets.run_worker_first,true);
});
test('anonymous, wrong and malformed credentials cannot reach assets or API',async()=>{
  const env={APP_USERNAME:'test-user',APP_PASSWORD:'test-password',ASSETS:{fetch(){throw Error('bypassed');}},SYNC:{fetch(){throw Error('bypassed');}}};
  for(const path of ['/','/index.html','/api/checkpoints','/images/test.jpg']){
    for(const auth of ['', 'Basic !!!','Basic '+btoa('test-user:wrong')]){
      const response=await gateway.fetch(new Request('https://test'+path,{headers:{Authorization:auth}}),env);
      assert.equal(response.status,401);assert.match(response.headers.get('WWW-Authenticate'),/^Basic /);
    }
  }
});
test('valid login serves app and preserves independent sync authentication',async()=>{
  const env={APP_USERNAME:'test-user',APP_PASSWORD:'test-password',ASSETS:{fetch:async()=>new Response('app')},SYNC:{fetch:async(req)=>{assert.equal(req.headers.get('Authorization'),null);assert.equal(req.headers.get('X-Sync-Secret'),'sync-test');return new Response('api');}}};
  for(const [path,body] of [['/','app'],['/api/checkpoints','api']]){
    const response=await gateway.fetch(new Request('https://test'+path,{headers:{Authorization:'Basic '+btoa('test-user:test-password'),'X-Sync-Secret':'sync-test'}}),env);
    assert.equal(await response.text(),body);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  }
  assert.equal((await gateway.fetch(new Request('https://test'),{})).status,401);
});
