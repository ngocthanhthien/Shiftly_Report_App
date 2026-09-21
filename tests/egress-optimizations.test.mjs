import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers the client-side half of the 2026-09-21 Supabase egress audit (see
// HANDOFF.md): a true reset-on-each-call debounce for meta saves (Specs/PO/
// Recipe/Client/Items Code tables now save on every blur/change — without
// this, each edit re-uploads AND every other device re-downloads the WHOLE
// list), and adaptive polling once Realtime Broadcast is confirmed connected
// (see supabase.test.mjs for the server-side "images fetched separately"
// half of the same audit).
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

async function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'https://shiftly-report-app.example.workers.dev',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.indexedDB = new IDBFactory();
      w.fetch = async () => { throw new Error('network disabled in test'); };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.eval('typeof DB !== "undefined" && DB !== null'); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 50));
  return {dom, w, errors};
}

test('queueMetaSync(): rapid edits (as the inline-editable tables now do on every blur/change) debounce into a single flushOutbox() call', async () => {
  const {dom, w, errors} = await boot();
  try {
    // Replace flushOutbox() with a counter so this test only exercises the
    // scheduling/debounce logic, not an actual network round-trip.
    w.eval('window.__flushCount = 0; flushOutbox = async function(){ window.__flushCount++; };');

    await w.eval("(async () => { await queueMetaSync('recipes', ['A']); })()");
    await new Promise(r => setTimeout(r, 600));
    await w.eval("(async () => { await queueMetaSync('recipes', ['A','B']); })()"); // must RESET the debounce timer
    await new Promise(r => setTimeout(r, 600));
    await w.eval("(async () => { await queueMetaSync('recipes', ['A','B','C']); })()"); // resets again

    assert.equal(w.eval('window.__flushCount'), 0, 'must not have flushed yet — still within the debounce window from the last edit');
    await new Promise(r => setTimeout(r, 2700)); // past the debounce delay, measured from the LAST call above
    assert.equal(w.eval('window.__flushCount'), 1, 'three edits spread over ~1.2s must still coalesce into exactly one flush, not three');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('queueMetaSync(): edits spaced further apart than the debounce window each get their own flush (sanity check the debounce isn\'t simply disabled)', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval('window.__flushCount = 0; flushOutbox = async function(){ window.__flushCount++; };');
    await w.eval("(async () => { await queueMetaSync('recipes', ['A']); })()");
    await new Promise(r => setTimeout(r, 2700));
    assert.equal(w.eval('window.__flushCount'), 1, 'first edit must have flushed on its own after the debounce window elapsed');

    await w.eval("(async () => { await queueMetaSync('recipes', ['A','B']); })()");
    await new Promise(r => setTimeout(r, 2700));
    assert.equal(w.eval('window.__flushCount'), 2, 'a second edit made well after the first must trigger its own separate flush');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('baseSyncDelay(): widens once Realtime Broadcast is confirmed connected, per active tab (Tablet/Nhập liệu vs PC/quản lý)', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("showTab('table');"); // a PC/quản lý tab, not 'input'
    assert.equal(w.eval('realtimeConnected'), false, 'must start out not-connected (no real Realtime in this offline test)');
    assert.equal(w.eval('baseSyncDelay()'), 8000, 'PC/quản lý tabs poll every 8s while Realtime is not confirmed connected (unchanged default)');
    w.eval('realtimeConnected = true;');
    assert.equal(w.eval('baseSyncDelay()'), 30000, 'must widen once Realtime is confirmed connected — it now carries the "instant" load');

    w.eval("showTab('input'); realtimeConnected = false;");
    assert.equal(w.eval('baseSyncDelay()'), 20000, 'Tablet/Nhập liệu keeps its 20s default while Realtime is not confirmed connected');
    w.eval('realtimeConnected = true;');
    assert.equal(w.eval('baseSyncDelay()'), 60000, 'Tablet/Nhập liệu widens the most once Realtime is confirmed connected (mostly writes anyway)');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('stopRealtime() resets realtimeConnected back to false (so polling falls back to the tighter default)', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval('realtimeConnected = true;');
    w.eval('stopRealtime();');
    assert.equal(w.eval('realtimeConnected'), false);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});
