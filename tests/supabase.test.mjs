import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';

// These tests run the REAL supabase/schema.sql against an embedded Postgres
// (PGlite, WASM) — not a hand-written mirror — so a typo or logic error in
// the actual SQL that ships to users gets caught here, the same way the
// project's previous Cloudflare D1 backend was tested against real SQLite.

const schemaSql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

async function backend(secret) {
  const db = new PGlite({ extensions: { pgcrypto } });
  // Real Supabase projects come with `anon`/`authenticated` roles built in;
  // plain Postgres (what PGlite gives us) does not, so create stand-ins
  // before applying the real schema.sql unmodified.
  await db.exec('create role anon; create role authenticated;');
  await db.exec(schemaSql);
  await db.query('select set_sync_secret($1)', [secret ?? 'test-secret']);
  return db;
}

// Mirrors exactly how the frontend calls these functions (see cloudFetch in
// index.html) — PostgREST turns a POST body's keys into named SQL args; we
// know the fixed positional signatures here, so calling positionally is
// equivalent and avoids re-implementing PostgREST's dispatch.
async function rpc(db, fn, params) {
  const p = params || {};
  const table = {
    sync_get_checkpoints: ['select sync_get_checkpoints($1,$2) as result', [p.p_secret, p.p_since ?? 0]],
    sync_put_checkpoints: ['select sync_put_checkpoints($1,$2::jsonb) as result', [p.p_secret, JSON.stringify(p.p_rows)]],
    sync_delete_checkpoints: ['select sync_delete_checkpoints($1,$2,$3) as result', [p.p_secret, p.p_keys, p.p_updated_at]],
    sync_get_meta: ['select sync_get_meta($1) as result', [p.p_secret]],
    sync_put_meta: ['select sync_put_meta($1,$2::jsonb) as result', [p.p_secret, JSON.stringify(p.p_items)]],
    sync_post_logs: ['select sync_post_logs($1,$2::jsonb) as result', [p.p_secret, JSON.stringify(p.p_entries)]],
  }[fn];
  const res = await db.query(table[0], table[1]);
  return res.rows[0].result;
}

test('HTML script compiles and 13 tabs remain', () => {
  new vm.Script(source);
  assert.equal((html.match(/data-tab="/g) || []).length, 13);
});

test('every sync_* function rejects a wrong secret with {error:"unauthorized"}, not an exception', async () => {
  const db = await backend('right-secret');
  assert.equal((await rpc(db, 'sync_get_checkpoints', { p_secret: 'wrong' })).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_put_checkpoints', { p_secret: 'wrong', p_rows: [] })).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_delete_checkpoints', { p_secret: 'wrong', p_keys: ['x'], p_updated_at: '2026-01-01' })).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_get_meta', { p_secret: 'wrong' })).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_put_meta', { p_secret: 'wrong', p_items: {} })).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_post_logs', { p_secret: 'wrong', p_entries: [] })).error, 'unauthorized');
});

test('set_sync_secret and check_secret are not reachable by anon/authenticated', async () => {
  const db = await backend();
  const res = await db.query(`
    select has_function_privilege('anon', 'set_sync_secret(text)', 'execute') as a,
           has_function_privilege('authenticated', 'set_sync_secret(text)', 'execute') as b,
           has_function_privilege('anon', 'check_secret(text)', 'execute') as c
  `);
  assert.equal(res.rows[0].a, false);
  assert.equal(res.rows[0].b, false);
  assert.equal(res.rows[0].c, false);
});

test('every real table has row level security enabled (no policies -> direct REST access denied)', async () => {
  const db = await backend();
  const res = await db.query(`select relname, relrowsecurity from pg_class where relname in ('checkpoints','meta','logs','app_secret') and relkind='r'`);
  assert.equal(res.rows.length, 4);
  for (const row of res.rows) assert.equal(row.relrowsecurity, true, row.relname + ' must have RLS enabled');
});

test('checkpoints: push, pull, stale update rejected, cursor advances, delete tombstone', async () => {
  const db = await backend();
  const cp = { key: 'k1', date: '2026-09-18', shift: '1', section: 'ROA', po: 'PO1', recipe: '', client: '', technician: 'QA', fields: { a: 1 }, fieldNotes: {}, images: [], updatedAt: '2026-09-18T01:00:00Z' };

  const put1 = await rpc(db, 'sync_put_checkpoints', { p_secret: 'test-secret', p_rows: [cp] });
  assert.equal(put1.results[0].applied, true);

  const pull1 = await rpc(db, 'sync_get_checkpoints', { p_secret: 'test-secret', p_since: 0 });
  assert.equal(pull1.rows.length, 1);
  assert.equal(pull1.rows[0].fields.a, 1);
  const cursor1 = pull1.cursor;
  assert.ok(cursor1 > 0);

  const putStale = await rpc(db, 'sync_put_checkpoints', { p_secret: 'test-secret', p_rows: [{ ...cp, updatedAt: '2026-09-17T00:00:00Z', fields: { a: 999 } }] });
  assert.equal(putStale.results[0].applied, false);
  assert.equal((await rpc(db, 'sync_get_checkpoints', { p_secret: 'test-secret', p_since: 0 })).rows[0].fields.a, 1);

  assert.equal((await rpc(db, 'sync_get_checkpoints', { p_secret: 'test-secret', p_since: cursor1 })).rows.length, 0);

  const putNewer = await rpc(db, 'sync_put_checkpoints', { p_secret: 'test-secret', p_rows: [{ ...cp, updatedAt: '2026-09-18T02:00:00Z', fields: { a: 2 } }] });
  assert.equal(putNewer.results[0].applied, true);
  const pull3 = await rpc(db, 'sync_get_checkpoints', { p_secret: 'test-secret', p_since: cursor1 });
  assert.equal(pull3.rows.length, 1);
  assert.equal(pull3.rows[0].fields.a, 2);

  await rpc(db, 'sync_delete_checkpoints', { p_secret: 'test-secret', p_keys: ['k1'], p_updated_at: '2026-09-18T03:00:00Z' });
  assert.equal((await rpc(db, 'sync_get_checkpoints', { p_secret: 'test-secret', p_since: 0 })).rows[0].deleted, true);
});

test('images travel inline as base64 dataUrl inside the checkpoint row — no separate table/round trip', async () => {
  const db = await backend();
  const cp = {
    key: 'k2', date: '2026-09-18', shift: '1', section: 'FP', po: 'PO2', recipe: '', client: '', technician: 'QA',
    fields: {}, fieldNotes: {}, images: [{ name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,AAAA', ts: 123 }], updatedAt: '2026-09-18T01:00:00Z',
  };
  await rpc(db, 'sync_put_checkpoints', { p_secret: 'test-secret', p_rows: [cp] });
  const got = (await rpc(db, 'sync_get_checkpoints', { p_secret: 'test-secret', p_since: 0 })).rows.find(r => r.key === 'k2');
  assert.equal(got.images[0].dataUrl, 'data:image/jpeg;base64,AAAA');
});

test('meta: last-write-wins round trip', async () => {
  const db = await backend();
  const put1 = await rpc(db, 'sync_put_meta', { p_secret: 'test-secret', p_items: { poList: { value: ['A', 'B'], updatedAt: '2026-09-18T01:00:00Z' } } });
  assert.equal(put1.results.poList.applied, true);
  assert.deepEqual((await rpc(db, 'sync_get_meta', { p_secret: 'test-secret' })).items.poList.value, ['A', 'B']);

  const putStale = await rpc(db, 'sync_put_meta', { p_secret: 'test-secret', p_items: { poList: { value: ['STALE'], updatedAt: '2026-09-17T00:00:00Z' } } });
  assert.equal(putStale.results.poList.applied, false);
  assert.deepEqual((await rpc(db, 'sync_get_meta', { p_secret: 'test-secret' })).items.poList.value, ['A', 'B']);
});

test('logs: entries are recorded', async () => {
  const db = await backend();
  await rpc(db, 'sync_post_logs', { p_secret: 'test-secret', p_entries: [{ ts: '2026-09-18T01:00:00Z', date: '2026-09-18', shift: '1', po: 'PO1', section: 'ROA', technician: 'QA', changes: [{ fieldId: 'x', from: 1, to: 2 }] }] });
  assert.equal((await db.query('select count(*)::int as n from logs')).rows[0].n, 1);
});

test('bulk push: every row gets a distinct seq (Postgres sequence, no shared per-batch counter, no ties to break)', async () => {
  const db = await backend();
  const rows = [];
  for (let i = 0; i < 250; i++) {
    rows.push({ key: 'k' + i, date: '2026-09-18', shift: '1', section: 'ROA', po: '', recipe: '', client: '', technician: '', fields: {}, fieldNotes: {}, images: [], updatedAt: '2026-09-18T00:00:00.' + String(i).padStart(4, '0') + 'Z' });
  }
  await rpc(db, 'sync_put_checkpoints', { p_secret: 'test-secret', p_rows: rows });
  const page = await rpc(db, 'sync_get_checkpoints', { p_secret: 'test-secret', p_since: 0 });
  assert.equal(page.rows.length, 250);
  assert.equal(page.hasMore, false);
  const distinctSeq = await db.query('select count(distinct seq)::int as n from checkpoints');
  assert.equal(distinctSeq.rows[0].n, 250);
});

test('full app boots, syncs a checkpoint through Supabase RPC end-to-end, and does not requeue acknowledged records', async () => {
  const db = await backend('test-secret');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'https://someuser.github.io/shiftly-report-app/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.indexedDB = new IDBFactory();
      w.Headers = Headers;
      w.AbortSignal = AbortSignal;
      w.fetch = async (url, opts) => {
        const u = new URL(url);
        const fn = u.pathname.split('/rest/v1/rpc/')[1];
        const params = opts && opts.body ? JSON.parse(opts.body) : {};
        const result = await rpc(db, fn, params);
        return new Response(JSON.stringify(result), { status: 200 });
      };
    },
  });
  try {
    const w = dom.window;
    for (let i = 0; i < 100 && !w.eval('typeof DB !== "undefined" && DB !== null'); i++) await new Promise(r => setTimeout(r, 10));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.document.querySelectorAll('.tab').length, 13);

    w.eval("cloudCfg = {url:'https://x.supabase.co', anonKey:'anon-key', secret:'test-secret'}");
    const cpKey = await w.eval(`(async () => {
      const cp = blankCheckpoint('2026-09-18','1','ROA','TEST','QA');
      cp.fields = {ROA_R5C: 100};
      cp.updatedAt = new Date().toISOString();
      await idbPut('shifts', cp);
      await refreshCache();
      await persistAll();
      await flushOutbox();
      return cp.key;
    })()`);

    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal((await w.idbGetAll('outbox')).length, 0);
    assert.equal((await w.collectDirtyCheckpointRows()).length, 0);
    // Top-level `let`/`const` in a classic <script> aren't exposed as
    // `window` properties (only `var`/`function` are) — eval() runs in the
    // same scope and can read them.
    assert.equal(w.eval('cloudStatus'), 'idle', w.eval('lastCloudError') || '');

    const serverRows = await rpc(db, 'sync_get_checkpoints', { p_secret: 'test-secret', p_since: 0 });
    assert.equal(serverRows.rows.length, 1);
    assert.equal(serverRows.rows[0].key, cpKey);
    assert.equal(serverRows.rows[0].fields.ROA_R5C, 100);

    // Realtime is a best-effort layer on top (see the REALTIME "WAKE UP"
    // SIGNAL comment in index.html) — this test's jsdom window never loads
    // the supabase-js CDN script, exactly like a page load with the CDN
    // blocked or offline. None of these calls may throw, and no channel
    // should end up "connected" without the SDK actually being present.
    await w.eval(`(async () => { startRealtime(); pingRealtimeChanged(); stopRealtime(); })()`);
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(w.eval('realtimeChannel'), null);
  } finally {
    dom.window.close();
  }
});
