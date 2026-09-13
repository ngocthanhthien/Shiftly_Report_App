import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {indexedDB} from 'fake-indexeddb';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.js';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function fn(name){const p=source.indexOf('function '+name+'(');const start=source.slice(Math.max(0,p-6),p)==='async '?p-6:p;let braces=0;const open=source.indexOf('{',p);for(let i=open;i<source.length;i++){if(source[i]==='{')braces++;if(source[i]==='}'&&!--braces)return source.slice(start,i+1);}throw Error(name);}
function backend(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/schema.sql',import.meta.url),'utf8'));
  const prepare=(sql,args=[])=>({sql,args,bind(...v){return prepare(sql,v);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return sqlite.prepare(sql).run(...args);}});
  const env={SYNC_SECRET:'test',DB:{prepare,async batch(stmts){sqlite.exec('BEGIN');try{const results=stmts.map(s=>sqlite.prepare(s.sql).run(...s.args));sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}}};
  const call=async(method,body,path='/api/checkpoints')=>{const res=await worker.fetch(new Request('https://test'+path,{method,headers:{'X-Sync-Secret':'test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);return res.json();};
  return {sqlite,call,env};
}
test('HTML script compiles and 13 tabs remain',()=>{new vm.Script(source);assert.equal((html.match(/data-tab="/g)||[]).length,13);});
test('pagination includes legacy tied sequence rows without skipping',async()=>{
 const {sqlite,call}=backend();const insert=sqlite.prepare("INSERT INTO checkpoints(key,date,shift,section,updated_at,seq) VALUES (?,'2026-09-13','1','ROA','2026-09-13',?)");
 sqlite.exec('BEGIN');for(let i=1;i<=5102;i++)insert.run(String(i),i<=5002?Math.min(i,5000):i);sqlite.exec('COMMIT');
 sqlite.exec('UPDATE sync_seq SET value=9999');
 const first=await call('GET');assert.equal(first.cursor,5000);assert.equal(first.rows.length,5002);assert.equal(first.hasMore,true);
 const second=await call('GET',null,'/api/checkpoints?since='+first.cursor);assert.equal(second.rows.length,100);assert.equal(second.cursor,5102);
});
test('atomic writes, stale updates, tombstone and recreation',async()=>{
 const {call,sqlite}=backend();const cp={key:'a',date:'2026-09-13',shift:'1',section:'ROA',updatedAt:'2026-09-13T01:00:00Z',fields:{a:1}};
 await call('PUT',{rows:[cp]});assert.equal(sqlite.prepare('SELECT seq FROM checkpoints').get().seq,1);
 await call('PUT',{rows:[{...cp,updatedAt:'2026-09-12',fields:{a:2}}]});assert.equal(JSON.parse(sqlite.prepare('SELECT fields_json FROM checkpoints').get().fields_json).a,1);
 await call('DELETE',{keys:['a'],updatedAt:'2026-09-13T02:00:00Z'});assert.equal((await call('GET')).rows[0].deleted,true);
 await call('PUT',{rows:[{...cp,updatedAt:'2026-09-13T03:00:00Z'}]});assert.equal((await call('GET')).rows[0].deleted,false);
});
test('outbox coalesces checkpoint updates, preserves logs and handles in-flight ack IDs',async()=>{
 const DB=await new Promise((resolve,reject)=>{const req=indexedDB.open('test-'+Date.now(),1);req.onupgradeneeded=()=>req.result.createObjectStore('outbox',{keyPath:'id',autoIncrement:true});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
 const ctx=vm.createContext({DB,Date,Map});vm.runInContext([fn('outboxKey'),fn('queueOutbox'),fn('compactOutbox')].join('\n'),ctx);
 const all=()=>new Promise(resolve=>{const r=DB.transaction('outbox').objectStore('outbox').getAll();r.onsuccess=()=>resolve(r.result);});
 await ctx.queueOutbox('checkpoint',{key:'a',updatedAt:'1'});const old=(await all())[0].id;
 await ctx.queueOutbox('checkpoint',{key:'a',updatedAt:'2'});await ctx.queueOutbox('log',{changes:[1]});await ctx.queueOutbox('log',{changes:[2]});
 assert.equal((await all()).length,3);assert.notEqual((await all())[0].id,old);
 await ctx.queueOutbox('checkpointDelete',{key:'a',updatedAt:'3'});const rows=await all();assert.equal(rows.filter(r=>r.kind==='checkpoint').length,0);assert.equal(rows.filter(r=>r.kind==='checkpointDelete').length,1);
});
test('a later successful fetch cannot clear an earlier sync error',async()=>{
 const ctx=vm.createContext({cloudCfg:{baseUrl:'https://test',secret:'test'},lastCloudError:null,URL,Headers,AbortSignal,console:{error(){}},fetch:async()=>new Response('{}',{status:500})});
 vm.runInContext(fn('cloudFetch'),ctx);await ctx.cloudFetch('/api/checkpoints');assert.match(ctx.lastCloudError,/500/);
 ctx.fetch=async()=>new Response('{"items":{}}');await ctx.cloudFetch('/api/meta');assert.match(ctx.lastCloudError,/500/);
});
test('full app boots, syncs a checkpoint and does not requeue acknowledged records',async()=>{
 const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const {call}=backend();
 const dom=new JSDOM(html,{url:'https://shiftly-report-app.dangthanhbinh53.workers.dev',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
   w.indexedDB=new IDBFactory();w.Headers=Headers;w.AbortSignal=AbortSignal;w.structuredClone=structuredClone;
   w.fetch=async(url,opts)=>{const parsed=new URL(url);return new Response(JSON.stringify(await call(opts.method,opts.body?JSON.parse(opts.body):undefined,parsed.pathname+parsed.search)));};
 }});
 try{
 const w=dom.window;
 for(let i=0;i<100 && !w.eval('DB !== null && allCheckpoints !== undefined');i++)await new Promise(r=>setTimeout(r,10));
 await new Promise(r=>setTimeout(r,50));
 assert.equal(w.document.querySelectorAll('.tab').length,13);assert.equal(errors.length,0,errors.join('\n'));
 w.eval("cloudCfg={baseUrl:location.origin,secret:'test'}");
 const cp=w.blankCheckpoint('2026-09-13','1','ROA','TEST','QA');cp.fields={ROA_R5C:100};
 await w.idbPut('shifts',cp);await w.refreshCache();await w.persistAll();await w.flushOutbox();
 assert.equal((await w.idbGetAll('outbox')).length,0);assert.equal((await w.collectDirtyCheckpointRows()).length,0);
 const field=w.document.querySelector('#view-input textarea');field.value='unsaved draft';w.setCloudStatus('syncing');assert.equal(field.value,'unsaved draft');
 }finally{dom.window.close();}
});
