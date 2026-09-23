import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
async function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'https://shiftly-report-app.example.workers.dev', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.indexedDB = new IDBFactory(); w.fetch = async () => { throw new Error('network disabled in test'); }; },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.eval('typeof DB !== "undefined" && DB !== null'); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 50));
  return {dom, w, errors};
}

test('Data Log: keeps at most 10 newest rows, records User/Máy tính/Hành động, and renders the 6-column table', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("currentMember = {userId:'u1', displayName:'E&A', role:'user'}");
    await w.eval(`(async () => {
      for(let i=0;i<25;i++) await logChange({action:'Cập nhật finding', date:'2026-09-23', shift:'1', po:'123456789', section:'E&A', changes:[{label:'f'+i, from:null, to:i}]});
    })()`);
    const logs = await w.idbGetAll('logs');
    assert.equal(logs.length, 10);
    assert.equal(logs[0].user, 'E&A');
    assert.match(logs[0].machine, /^PC-/);
    await w.eval("renderDataLog()");
    const v = w.document.getElementById('view-datalog');
    assert.ok(v.textContent.includes('Data Input Log'));
    assert.equal(v.querySelectorAll('tbody tr').length, 10);
    assert.equal(v.querySelectorAll('thead th').length, 6);
    assert.equal(errors.length, 0, errors.join(' | '));
    await new Promise(r => setTimeout(r, 150));
  } finally { dom.window.close(); }
});
