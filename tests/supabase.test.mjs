import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
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

// Real Supabase provides `auth.users` + `auth.uid()` (reading the caller's
// JWT `sub` claim, which PostgREST injects as the `request.jwt.claim.sub`
// session setting) out of the box; plain Postgres (what PGlite gives us)
// does not, so this stand-in exists ONLY in the test harness — schema.sql
// itself is the real, unmodified file that ships to users.
async function backend() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec('create role anon; create role authenticated;');
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
  `);
  await db.exec(schemaSql);
  return db;
}

// Mimics PostgREST setting the caller's JWT claim for the session — every
// sync_* call after this runs `as` that member (or as nobody, if userId is
// falsy, i.e. an unauthenticated anon call).
async function signInAs(db, userId) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId || '']);
}
async function createMember(db, { role = 'user', disabled = false, displayName = 'QA', username = null, email = null } = {}) {
  const id = crypto.randomUUID();
  await db.query('insert into auth.users (id, email) values ($1,$2)', [id, email]);
  await db.query('insert into members (user_id, display_name, role, disabled, username) values ($1,$2,$3,$4,$5)', [id, displayName, role, disabled, username]);
  return id;
}

// Mirrors exactly how the frontend calls these functions (see cloudFetch in
// index.html) — PostgREST turns a POST body's keys into named SQL args; we
// know the fixed positional signatures here, so calling positionally is
// equivalent and avoids re-implementing PostgREST's dispatch.
async function rpc(db, fn, params) {
  const p = params || {};
  const table = {
    sync_whoami: ['select sync_whoami() as result', []],
    sync_get_checkpoints: ['select sync_get_checkpoints($1) as result', [p.p_since ?? 0]],
    sync_put_checkpoints: ['select sync_put_checkpoints($1::jsonb) as result', [JSON.stringify(p.p_rows)]],
    sync_delete_checkpoints: ['select sync_delete_checkpoints($1,$2) as result', [p.p_keys, p.p_updated_at]],
    sync_get_meta: ['select sync_get_meta() as result', []],
    sync_put_meta: ['select sync_put_meta($1::jsonb) as result', [JSON.stringify(p.p_items)]],
    sync_post_logs: ['select sync_post_logs($1::jsonb) as result', [JSON.stringify(p.p_entries)]],
  }[fn];
  const res = await db.query(table[0], table[1]);
  return res.rows[0].result;
}

test('HTML script compiles and 13 tabs remain', () => {
  new vm.Script(source);
  assert.equal((html.match(/data-tab="/g) || []).length, 13);
});

test('every sync_* function rejects an unauthenticated caller with {error:"unauthorized"}, not an exception', async () => {
  const db = await backend();
  await signInAs(db, null);
  assert.equal((await rpc(db, 'sync_whoami', {})).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_get_checkpoints', {})).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_put_checkpoints', { p_rows: [] })).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_delete_checkpoints', { p_keys: ['x'], p_updated_at: '2026-01-01' })).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_get_meta', {})).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_put_meta', { p_items: {} })).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_post_logs', { p_entries: [] })).error, 'unauthorized');
});

test('a signed-in Supabase Auth user with no members row, or a disabled member, is still unauthorized', async () => {
  const db = await backend();
  const strangerId = crypto.randomUUID();
  await db.query('insert into auth.users (id, email) values ($1,$2)', [strangerId, 'stranger@test.local']);
  await signInAs(db, strangerId);
  assert.equal((await rpc(db, 'sync_get_checkpoints', {})).error, 'unauthorized');

  const disabledId = await createMember(db, { disabled: true, displayName: 'Disabled QC' });
  await signInAs(db, disabledId);
  assert.equal((await rpc(db, 'sync_whoami', {})).error, 'unauthorized');
  assert.equal((await rpc(db, 'sync_get_checkpoints', {})).error, 'unauthorized');
});

test('sync_whoami returns the caller\'s own membership row for an active member', async () => {
  const db = await backend();
  const uid = await createMember(db, { role: 'admin', displayName: 'Nguyễn Văn A', username: 'nva' });
  await signInAs(db, uid);
  const who = await rpc(db, 'sync_whoami', {});
  assert.equal(who.userId, uid);
  assert.equal(who.displayName, 'Nguyễn Văn A');
  assert.equal(who.username, 'nva');
  assert.equal(who.role, 'admin');
});

test('a supervisor can read everything but every write RPC rejects with {error:"forbidden_role"}', async () => {
  const db = await backend();
  const uid = await createMember(db, { role: 'supervisor', displayName: 'Giám sát A' });
  await signInAs(db, uid);

  // Reads: unaffected — a supervisor's whole purpose is viewing reports/data.
  assert.equal((await rpc(db, 'sync_whoami', {})).role, 'supervisor');
  assert.deepEqual((await rpc(db, 'sync_get_checkpoints', {})).rows, []);
  assert.deepEqual((await rpc(db, 'sync_get_meta', {})).items, {});

  // Writes: every one of them, rejected — never silently a no-op, always this exact error shape.
  const cp = { key: 'sup1', date: '2026-09-19', shift: '1', section: 'ROA', po: '', recipe: '', client: '', technician: '', fields: {}, fieldNotes: {}, images: [], updatedAt: '2026-09-19T00:00:00Z' };
  assert.equal((await rpc(db, 'sync_put_checkpoints', { p_rows: [cp] })).error, 'forbidden_role');
  assert.equal((await rpc(db, 'sync_delete_checkpoints', { p_keys: ['sup1'], p_updated_at: '2026-09-19T00:00:01Z' })).error, 'forbidden_role');
  assert.equal((await rpc(db, 'sync_put_meta', { p_items: { poList: { value: ['X'], updatedAt: '2026-09-19T00:00:00Z' } } })).error, 'forbidden_role');
  assert.equal((await rpc(db, 'sync_post_logs', { p_entries: [{ ts: '2026-09-19T00:00:00Z' }] })).error, 'forbidden_role');

  // Confirm the rejected checkpoint write never actually landed.
  assert.equal((await db.query('select count(*)::int as n from checkpoints')).rows[0].n, 0);
});

test('is_active_member() and is_writer_member() are not reachable by anon, only authenticated', async () => {
  const db = await backend();
  const res = await db.query(`
    select has_function_privilege('anon', 'is_active_member()', 'execute') as a,
           has_function_privilege('authenticated', 'is_active_member()', 'execute') as b,
           has_function_privilege('anon', 'is_writer_member()', 'execute') as c,
           has_function_privilege('authenticated', 'is_writer_member()', 'execute') as d
  `);
  assert.equal(res.rows[0].a, false);
  assert.equal(res.rows[0].b, true);
  assert.equal(res.rows[0].c, false);
  assert.equal(res.rows[0].d, true);
});

test('every real table has row level security enabled (no policies -> direct REST access denied)', async () => {
  const db = await backend();
  const res = await db.query(`select relname, relrowsecurity from pg_class where relname in ('checkpoints','meta','logs','members','member_audit') and relkind='r'`);
  assert.equal(res.rows.length, 5);
  for (const row of res.rows) assert.equal(row.relrowsecurity, true, row.relname + ' must have RLS enabled');
});

test('the old shared-secret model is fully removed', async () => {
  const db = await backend();
  const res = await db.query(`
    select
      (select count(*)::int from pg_proc where proname in ('set_sync_secret','check_secret')) as fn_count,
      (select count(*)::int from pg_class where relname='app_secret') as tbl_count
  `);
  assert.equal(res.rows[0].fn_count, 0);
  assert.equal(res.rows[0].tbl_count, 0);
});

test('checkpoints: itemCode round-trips through push/pull and defaults to \'\' when absent', async () => {
  const db = await backend();
  const uid = await createMember(db, { displayName: 'QA' });
  await signInAs(db, uid);
  const withCode = { key: 'ic1', date: '2026-09-19', shift: '1', section: 'ROA', po: 'PO1', itemCode: '1100011', recipe: '', client: '', technician: 'QA', fields: {}, fieldNotes: {}, images: [], updatedAt: '2026-09-19T01:00:00Z' };
  const withoutCode = { key: 'ic2', date: '2026-09-19', shift: '1', section: 'ROA', po: 'PO2', recipe: '', client: '', technician: 'QA', fields: {}, fieldNotes: {}, images: [], updatedAt: '2026-09-19T01:00:00Z' };
  await rpc(db, 'sync_put_checkpoints', { p_rows: [withCode, withoutCode] });
  const pulled = (await rpc(db, 'sync_get_checkpoints', { p_since: 0 })).rows;
  assert.equal(pulled.find(r => r.key === 'ic1').itemCode, '1100011');
  assert.equal(pulled.find(r => r.key === 'ic2').itemCode, '');
});

test('checkpoints: push, pull, stale update rejected, cursor advances, delete tombstone', async () => {
  const db = await backend();
  const uid = await createMember(db, { displayName: 'QA' });
  await signInAs(db, uid);
  const cp = { key: 'k1', date: '2026-09-18', shift: '1', section: 'ROA', po: 'PO1', recipe: '', client: '', technician: 'QA', fields: { a: 1 }, fieldNotes: {}, images: [], updatedAt: '2026-09-18T01:00:00Z' };

  const put1 = await rpc(db, 'sync_put_checkpoints', { p_rows: [cp] });
  assert.equal(put1.results[0].applied, true);

  const pull1 = await rpc(db, 'sync_get_checkpoints', { p_since: 0 });
  assert.equal(pull1.rows.length, 1);
  assert.equal(pull1.rows[0].fields.a, 1);
  const cursor1 = pull1.cursor;
  assert.ok(cursor1 > 0);

  const putStale = await rpc(db, 'sync_put_checkpoints', { p_rows: [{ ...cp, updatedAt: '2026-09-17T00:00:00Z', fields: { a: 999 } }] });
  assert.equal(putStale.results[0].applied, false);
  assert.equal((await rpc(db, 'sync_get_checkpoints', { p_since: 0 })).rows[0].fields.a, 1);

  assert.equal((await rpc(db, 'sync_get_checkpoints', { p_since: cursor1 })).rows.length, 0);

  const putNewer = await rpc(db, 'sync_put_checkpoints', { p_rows: [{ ...cp, updatedAt: '2026-09-18T02:00:00Z', fields: { a: 2 } }] });
  assert.equal(putNewer.results[0].applied, true);
  const pull3 = await rpc(db, 'sync_get_checkpoints', { p_since: cursor1 });
  assert.equal(pull3.rows.length, 1);
  assert.equal(pull3.rows[0].fields.a, 2);

  await rpc(db, 'sync_delete_checkpoints', { p_keys: ['k1'], p_updated_at: '2026-09-18T03:00:00Z' });
  assert.equal((await rpc(db, 'sync_get_checkpoints', { p_since: 0 })).rows[0].deleted, true);
});

test('images travel inline as base64 dataUrl inside the checkpoint row — no separate table/round trip', async () => {
  const db = await backend();
  const uid = await createMember(db);
  await signInAs(db, uid);
  const cp = {
    key: 'k2', date: '2026-09-18', shift: '1', section: 'FP', po: 'PO2', recipe: '', client: '', technician: 'QA',
    fields: {}, fieldNotes: {}, images: [{ name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,AAAA', ts: 123 }], updatedAt: '2026-09-18T01:00:00Z',
  };
  await rpc(db, 'sync_put_checkpoints', { p_rows: [cp] });
  const got = (await rpc(db, 'sync_get_checkpoints', { p_since: 0 })).rows.find(r => r.key === 'k2');
  assert.equal(got.images[0].dataUrl, 'data:image/jpeg;base64,AAAA');
});

test('meta: last-write-wins round trip', async () => {
  const db = await backend();
  const uid = await createMember(db);
  await signInAs(db, uid);
  const put1 = await rpc(db, 'sync_put_meta', { p_items: { poList: { value: ['A', 'B'], updatedAt: '2026-09-18T01:00:00Z' } } });
  assert.equal(put1.results.poList.applied, true);
  assert.deepEqual((await rpc(db, 'sync_get_meta', {})).items.poList.value, ['A', 'B']);

  const putStale = await rpc(db, 'sync_put_meta', { p_items: { poList: { value: ['STALE'], updatedAt: '2026-09-17T00:00:00Z' } } });
  assert.equal(putStale.results.poList.applied, false);
  assert.deepEqual((await rpc(db, 'sync_get_meta', {})).items.poList.value, ['A', 'B']);
});

test('logs: entries are recorded', async () => {
  const db = await backend();
  const uid = await createMember(db);
  await signInAs(db, uid);
  await rpc(db, 'sync_post_logs', { p_entries: [{ ts: '2026-09-18T01:00:00Z', date: '2026-09-18', shift: '1', po: 'PO1', section: 'ROA', technician: 'QA', changes: [{ fieldId: 'x', from: 1, to: 2 }] }] });
  assert.equal((await db.query('select count(*)::int as n from logs')).rows[0].n, 1);
});

test('bulk push: every row gets a distinct seq (Postgres sequence, no shared per-batch counter, no ties to break)', async () => {
  const db = await backend();
  const uid = await createMember(db);
  await signInAs(db, uid);
  const rows = [];
  for (let i = 0; i < 250; i++) {
    rows.push({ key: 'k' + i, date: '2026-09-18', shift: '1', section: 'ROA', po: '', recipe: '', client: '', technician: '', fields: {}, fieldNotes: {}, images: [], updatedAt: '2026-09-18T00:00:00.' + String(i).padStart(4, '0') + 'Z' });
  }
  await rpc(db, 'sync_put_checkpoints', { p_rows: rows });
  const page = await rpc(db, 'sync_get_checkpoints', { p_since: 0 });
  assert.equal(page.rows.length, 250);
  assert.equal(page.hasMore, false);
  const distinctSeq = await db.query('select count(distinct seq)::int as n from checkpoints');
  assert.equal(distinctSeq.rows[0].n, 250);
});

// Builds a stand-in for the `window.supabase` global (the supabase-js SDK,
// which jsdom never actually loads — see the CDN <script> comment in
// index.html) covering only what index.html's ACCESS CONTROL section calls:
// auth.signInWithPassword/getSession/signOut, and just enough of the
// Realtime channel API for startRealtime/stopRealtime/pingRealtimeChanged to
// run without throwing. Real GoTrue (Supabase's Auth server) never runs
// here — signInWithPassword instead checks an in-memory fixture and mints a
// fake session whose "access_token" is simply the member's real user_id, so
// the mocked fetch below can hand that straight to signInAs().
function fakeSupabaseSdk(fixtureUsersByEmail) {
  return {
    createClient() {
      let session = null;
      return {
        auth: {
          async getSession() { return { data: { session } }; },
          async signInWithPassword({ email, password }) {
            const fx = fixtureUsersByEmail.get(String(email).toLowerCase());
            if (!fx || fx.password !== password) return { error: { message: 'Invalid login credentials' } };
            session = { access_token: fx.userId };
            return { error: null };
          },
          async signOut() { session = null; return { error: null }; },
        },
        channel() {
          const ch = { on() { return ch; }, subscribe() { return ch; }, send() {} };
          return ch;
        },
        removeChannel() {},
      };
    },
  };
}

test('full app boots, requires login once cloud sync is configured, then syncs a checkpoint through Supabase RPC end-to-end', async () => {
  const db = await backend();
  const uid = await createMember(db, { role: 'user', displayName: 'QA Một', username: 'qa1' });
  const fixtures = new Map([[`qa1@x.users.internal`, { userId: uid, password: 'secret123' }]]);

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
      w.supabase = fakeSupabaseSdk(fixtures);
      w.fetch = async (url, opts) => {
        const u = new URL(url);
        const fn = u.pathname.split('/rest/v1/rpc/')[1];
        const authHeader = (opts && opts.headers && opts.headers['Authorization']) || '';
        const token = authHeader.replace(/^Bearer\s+/, '');
        await signInAs(db, token || null);
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

    // https://<project-ref>.supabase.co — shadowAuthDomain() derives
    // "x.users.internal" from the hostname's first label, matching the
    // fixture email registered above.
    await w.eval("(async () => { await saveCloudConfig('https://x.supabase.co', 'anon-key'); })()");
    assert.equal(w.document.getElementById('loginGate').style.display, '', 'login gate must show once cloud sync is configured but no session exists yet');

    const loginErr = await w.eval("(async () => await signInUser('qa1', 'wrong-password'))()");
    assert.ok(loginErr, 'wrong password must be rejected');

    const ok = await w.eval("(async () => await signInUser('qa1', 'secret123'))()");
    assert.equal(ok, null);
    assert.equal(w.document.getElementById('loginGate').style.display, 'none');
    assert.equal(w.eval('currentMember.role'), 'user');
    assert.equal(w.eval('currentMember.displayName'), 'QA Một');

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

    await signInAs(db, uid);
    const serverRows = await rpc(db, 'sync_get_checkpoints', { p_since: 0 });
    assert.equal(serverRows.rows.length, 1);
    assert.equal(serverRows.rows[0].key, cpKey);
    assert.equal(serverRows.rows[0].fields.ROA_R5C, 100);

    // A disabled account must be kicked back to the login gate on its very
    // next sync call, even mid-session (see onAccessRevoked in index.html).
    await db.query('update members set disabled = true where user_id = $1', [uid]);
    await w.eval('(async () => { await flushOutbox(); })()');
    await new Promise(r => setTimeout(r, 50)); // onAccessRevoked() is fire-and-forget from cloudFetch — give it a tick to finish signOut()+showLoginGate()
    assert.equal(w.document.getElementById('loginGate').style.display, '', 'a disabled account must be signed out back to the login gate');
    assert.equal(w.eval('currentMember'), null);
  } finally {
    dom.window.close();
  }
});
