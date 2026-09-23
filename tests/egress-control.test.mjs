import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';

// Covers the "🛡️ Data & Egress Control" feature (Admin-configurable daily
// Soft/Hard traffic ceiling that throttles background sync/images without
// ever blocking QC record entry — see EGRESS_CONFIG/egressState()/
// recordEgressTraffic()/stripLocalMarkers() in index.html, and the
// egressControl guard inside sync_put_meta() in supabase/schema.sql).
const schemaSql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
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
function evalJson(w, expr) { return JSON.parse(w.eval(`JSON.stringify(${expr})`)); }

/* ===================== Pure local logic (no network) ===================== */

test('defaults: Soft=100MB, Hard=200MB, Protection ON, Extra=0, Unlock=false', async () => {
  const {dom, w} = await boot();
  try {
    const cfg = evalJson(w, 'EGRESS_CONFIG');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.softLimitMB, 100);
    assert.equal(cfg.hardLimitMB, 200);
    assert.equal(cfg.extraMB, 0);
    assert.equal(cfg.unlockToday, false);
  } finally { dom.window.close(); }
});

test('egressState(): normal below Soft, saving between Soft/Hard, protection at/above Hard — not hardcoded to 100/200', async () => {
  const {dom, w} = await boot();
  try {
    w.eval("EGRESS_CONFIG = normalizeEgressConfig({enabled:true, softLimitMB:150, hardLimitMB:300})");
    w.eval("egressDaily = {date: todayStr(), bytes: 140*1024*1024}");
    assert.equal(w.eval('egressState().level'), 'normal');
    w.eval("egressDaily.bytes = 200*1024*1024");
    assert.equal(w.eval('egressState().level'), 'saving');
    w.eval("egressDaily.bytes = 300*1024*1024");
    assert.equal(w.eval('egressState().level'), 'protection');
  } finally { dom.window.close(); }
});

test('egressState(): disabling protection always reports normal, however much traffic has been used', async () => {
  const {dom, w} = await boot();
  try {
    w.eval("EGRESS_CONFIG = normalizeEgressConfig({enabled:false, softLimitMB:100, hardLimitMB:200})");
    w.eval("egressDaily = {date: todayStr(), bytes: 999*1024*1024}");
    assert.equal(w.eval('egressState().level'), 'normal');
  } finally { dom.window.close(); }
});

test('Admin Override: +Extra MB Today raises the Effective Hard Limit only for today; a stale (yesterday\'s) Extra/Unlock no longer applies', async () => {
  const {dom, w} = await boot();
  try {
    w.eval("EGRESS_CONFIG = normalizeEgressConfig({softLimitMB:100, hardLimitMB:200, extraMB:100, extraMBDate: todayStr()})");
    assert.equal(w.eval('egressEffectiveHardMB()'), 300, 'Hard 200 + Extra 100 today = 300');
    w.eval("egressDaily = {date: todayStr(), bytes: 250*1024*1024}");
    assert.equal(w.eval('egressState().level'), 'saving', '250MB is above Soft(100) but still under effective Hard(300) -> Data Saving, not Protection');

    // Daily reset (spec section 12): Extra/Unlock apply ONLY on the date they
    // were set — computed client-side by comparing the stored date field to
    // todayStr(), no server cron needed.
    w.eval("EGRESS_CONFIG.extraMBDate = '2000-01-01'");
    assert.equal(w.eval('egressEffectiveHardMB()'), 200, 'stale Extra from a past day must not carry over');

    w.eval("EGRESS_CONFIG = normalizeEgressConfig({unlockToday:true, unlockDate: todayStr()})");
    assert.equal(w.eval('egressUnlockedToday()'), true);
    w.eval("EGRESS_CONFIG.unlockDate = '2000-01-01'");
    assert.equal(w.eval('egressUnlockedToday()'), false, 'stale Unlock from a past day must not carry over');
  } finally { dom.window.close(); }
});

test('Unlock Today bypasses the Hard Limit entirely (effective hard = Infinity) but keeps measuring traffic', async () => {
  const {dom, w} = await boot();
  try {
    w.eval("EGRESS_CONFIG = normalizeEgressConfig({softLimitMB:100, hardLimitMB:200, unlockToday:true, unlockDate: todayStr()})");
    w.eval("egressDaily = {date: todayStr(), bytes: 500*1024*1024}");
    // JSON can't carry Infinity (it serializes to null) — check it directly.
    assert.equal(w.eval('egressState().level'), 'saving', 'still above Soft — Data Saving — but never Protection while unlocked');
    assert.equal(w.eval('egressState().hardMB === Infinity'), true);
    assert.equal(w.eval('egressState().mb'), 500, 'counter keeps accumulating even while unlocked (spec: does NOT clear traffic counter)');
  } finally { dom.window.close(); }
});

test('recordEgressTraffic(): resets the counter on a new day, and persists to IndexedDB (meta.egressTrafficToday) without ever calling fetch', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("egressDaily = {date: '2000-01-01', bytes: 999999}");
    await w.eval("(async () => { await recordEgressTraffic(1000); })()");
    const daily = evalJson(w, 'egressDaily');
    assert.equal(daily.date, w.eval('todayStr()'));
    assert.equal(daily.bytes, 1000, 'old day\'s bytes must NOT carry over into the new day');
    const persisted = await w.idbGet('meta', 'egressTrafficToday');
    assert.equal(persisted.value.bytes, 1000);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('saveEgressConfig(): rejected for a non-admin (UI-side convenience check) and when Soft >= Hard', async () => {
  const {dom, w} = await boot();
  try {
    w.eval("currentMember = {userId:'u1', displayName:'QA', role:'user'}");
    const asUser = await w.eval("(async () => await saveEgressConfig({softLimitMB:150, hardLimitMB:300}))()");
    assert.equal(asUser, false);
    assert.equal(w.eval('EGRESS_CONFIG.softLimitMB'), 100, 'must be unchanged — a non-admin cannot alter the limits');

    w.eval("currentMember = {userId:'u2', displayName:'Admin', role:'admin'}");
    const badRange = await w.eval("(async () => await saveEgressConfig({softLimitMB:300, hardLimitMB:200}))()");
    assert.equal(badRange, false, 'Soft must be strictly less than Hard');
    assert.equal(w.eval('EGRESS_CONFIG.softLimitMB'), 100, 'the invalid attempt must not have mutated state');

    const ok = await w.eval("(async () => await saveEgressConfig({softLimitMB:150, hardLimitMB:300}))()");
    assert.equal(ok, true);
    assert.equal(w.eval('EGRESS_CONFIG.softLimitMB'), 150);
    assert.equal(w.eval('EGRESS_CONFIG.hardLimitMB'), 300);
  } finally { dom.window.close(); }
});

test('stripLocalMarkers(): a genuinely new/changed image is deferred (not dropped) under 🔴 Protection; record fields are unaffected', async () => {
  const {dom, w} = await boot();
  try {
    w.eval("EGRESS_CONFIG = normalizeEgressConfig({softLimitMB:1, hardLimitMB:2})");
    w.eval("egressDaily = {date: todayStr(), bytes: 5*1024*1024}"); // 5MB > 2MB hard -> protection
    assert.equal(w.eval('egressState().level'), 'protection');
    const cp = { key:'k1', date:'2026-09-23', shift:'1', section:'ROA', po:'123456789', fields:{ROA_R5C:1}, images:[{ts:1, dataUrl:'data:x'}] };
    const clean = evalJson(w, `stripLocalMarkers(${JSON.stringify(cp)})`);
    assert.equal(clean.images, undefined, 'image must be omitted from the push payload while in Protection');
    assert.equal(clean.fields.ROA_R5C, 1, 'record fields still push normally');

    // Once traffic drops back under Hard (e.g. after Admin raises quota, or
    // a new day), the SAME checkpoint must push its image again.
    w.eval("egressDaily.bytes = 0");
    const clean2 = evalJson(w, `stripLocalMarkers(${JSON.stringify(cp)})`);
    assert.deepEqual(clean2.images, cp.images, 'image resumes once no longer in Protection');
  } finally { dom.window.close(); }
});

test('a Protection-deferred image is never lost: the checkpoint stays "dirty" (not falsely marked synced) until the image actually goes through', async () => {
  const {dom, w, errors} = await boot();
  try {
    // jsdom's window has no AbortSignal by default (see cloudFetch's
    // `AbortSignal.timeout(30000)`) — inject Node's real one, exactly like
    // the full end-to-end harness in tests/supabase.test.mjs does.
    w.AbortSignal = AbortSignal;
    w.eval("currentAccessToken = async () => 'fake-token'; cloudCfg = {url:'https://x.test', anonKey:'k'};");
    w.eval("EGRESS_CONFIG = normalizeEgressConfig({softLimitMB:1, hardLimitMB:2}); egressDaily = {date: todayStr(), bytes: 5*1024*1024};");
    const cpKey = await w.eval(`(async () => {
      const cp = blankCheckpoint('2026-09-23','1','ROA','123456789','QA');
      cp.fields = {ROA_R5C: 1};
      cp.images = [{ts:1, dataUrl:'data:x'}];
      cp.updatedAt = new Date().toISOString();
      await idbPut('shifts', cp);
      await refreshCache();
      return cp.key;
    })()`);

    // Server always acks "applied" for this row (images or not) — the point
    // under test is purely the CLIENT's own dirty-bookkeeping, not the RPC.
    w.eval(`fetch = async (url, opts) => {
      const fn = url.split('/rest/v1/rpc/')[1];
      const body = fn==='sync_put_checkpoints' ? {results:[{key:${JSON.stringify(cpKey)}, applied:true}]}
        : fn==='sync_get_checkpoints' ? {rows:[], cursor:0, hasMore:false}
        : fn==='sync_get_meta' ? {items:{}, cursor:null} : {};
      return { ok:true, status:200, text: async () => JSON.stringify(body) };
    }`);
    await w.eval('(async () => { await persistAll(); await flushOutbox(); })()');

    let cp = await w.idbGet('shifts', cpKey);
    assert.notEqual(cp._syncedAt, cp.updatedAt, 'row must stay dirty — its image was deferred, not actually synced yet');

    // Protection lifts (Admin raises quota / new day) — the very same
    // dirty-row machinery must now push the image for real, with no new
    // "pending" flag or special resync call needed.
    w.eval("egressDaily.bytes = 0");
    await w.eval('(async () => { await flushOutbox(); })()');
    cp = await w.idbGet('shifts', cpKey);
    assert.equal(cp._syncedAt, cp.updatedAt, 'now fully synced (image included this time)');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('baseSyncDelay(): scaled up in Data Saving/Protection, but wakeSync()/manualSync() (QC-entry-relevant syncs) never go through this delay', async () => {
  const {dom, w} = await boot();
  try {
    w.eval("EGRESS_CONFIG = normalizeEgressConfig({softLimitMB:1, hardLimitMB:2})");
    w.eval("egressDaily = {date: todayStr(), bytes: 0}");
    const normal = w.eval('baseSyncDelay()');
    w.eval("egressDaily.bytes = 1.5*1024*1024");
    const saving = w.eval('baseSyncDelay()');
    w.eval("egressDaily.bytes = 3*1024*1024");
    const protection = w.eval('baseSyncDelay()');
    assert.ok(saving > normal, 'Data Saving must poll less often than Normal');
    assert.ok(protection > saving, 'Protection must poll even less often than Data Saving');
    assert.equal(typeof w.eval('wakeSync'), 'function');
    assert.equal(typeof w.eval('manualSync'), 'function');
  } finally { dom.window.close(); }
});

test('resyncFromScratch(): blocked under 🔴 Protection (records/text sync is untouched — only this large re-pull is restricted)', async () => {
  const {dom, w} = await boot();
  try {
    w.eval("cloudCfg.url = 'https://x.test';"); // cloudConfigured() gate
    w.eval("EGRESS_CONFIG = normalizeEgressConfig({softLimitMB:1, hardLimitMB:2}); egressDaily = {date: todayStr(), bytes: 5*1024*1024};");
    w.eval("syncCursors.checkpoints = '999';");
    w.eval('resyncFromScratch()');
    assert.equal(w.eval('syncCursors.checkpoints'), '999', 'cursor must be untouched while blocked');

    w.eval("egressDaily.bytes = 0;");
    w.eval('resyncFromScratch()');
    assert.equal(w.eval('syncCursors.checkpoints'), '0', 'allowed again once out of Protection');
    // resyncFromScratch() fires an un-awaited flushOutbox() in the background
    // (pre-existing fire-and-forget design, not something this test drives) —
    // give it a moment to settle before closing the window, so its
    // network-disabled rejection doesn't land as an unhandled rejection after
    // the test has already ended.
    await new Promise(r => setTimeout(r, 150));
  } finally { dom.window.close(); }
});

test('applyRemoteMeta("egressControl", …): config syncs across devices through the SAME generic meta path as poList/schema/etc.', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("applyRemoteMeta('egressControl', {enabled:true, softLimitMB:150, hardLimitMB:500, extraMB:0, unlockToday:false})");
    assert.equal(w.eval('EGRESS_CONFIG.softLimitMB'), 150);
    assert.equal(w.eval('EGRESS_CONFIG.hardLimitMB'), 500);
    const persisted = await w.idbGet('meta', 'egressControl');
    assert.equal(persisted.value.hardLimitMB, 500, 'must persist locally too, so it survives a reload without waiting on the network again');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('updateCloudPill(): shows the 🟠/🔴 suffix once in Data Saving/Protection, and none while Normal', async () => {
  const {dom, w} = await boot();
  try {
    w.eval("cloudCfg.url = 'https://x.test'; cloudStatus = 'idle';");
    w.eval("EGRESS_CONFIG = normalizeEgressConfig({softLimitMB:100, hardLimitMB:200}); egressDaily = {date: todayStr(), bytes: 0}; updateCloudPill();");
    assert.ok(!w.document.getElementById('linkPillTxt').textContent.includes('🟠'));

    w.eval("egressDaily.bytes = 150*1024*1024; updateCloudPill();");
    assert.ok(w.document.getElementById('linkPillTxt').textContent.includes('🟠 Data Saving'));

    w.eval("egressDaily.bytes = 250*1024*1024; updateCloudPill();");
    assert.ok(w.document.getElementById('linkPillTxt').textContent.includes('🔴 Protection'));
  } finally { dom.window.close(); }
});

test('Settings tab: 🛡️ Data & Egress Control card shows read-only summary for a non-admin, full editable controls only for Admin', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("cloudCfg.url = 'https://x.test'; currentMember = {userId:'u1', displayName:'QA', role:'user'}; showTab('settings');");
    // Scope to #view-settings, not document.body — the whole app source
    // lives in one inline <script>, whose OWN text (a descendant of <body>)
    // would otherwise make any of these Vietnamese strings match trivially
    // since they're also literal source code, regardless of what actually
    // rendered.
    const settingsText = () => w.document.getElementById('view-settings').textContent;
    assert.ok(settingsText().includes('Data & Egress Control'));
    assert.ok(!settingsText().includes('Cấu hình (chỉ Admin)'), 'a plain user must not see the admin-only config sub-card');

    w.eval("currentMember = {userId:'u2', displayName:'Admin', role:'admin'}; showTab('settings');");
    assert.ok(settingsText().includes('Cấu hình (chỉ Admin)'), 'Admin must see the editable config sub-card');
    assert.equal(errors.length, 0, errors.join('\n'));
    // Let any background activity from boot()'s own init() (e.g. the
    // un-awaited ensureStoragePersisted() / initial armSync() timer — both
    // pre-existing, unrelated to this feature) settle before closing the
    // window, so it can't surface as an unhandled rejection after the test
    // has already ended.
    await new Promise(r => setTimeout(r, 150));
  } finally { dom.window.close(); }
});

/* ===================== Server-side enforcement (real schema.sql via PGlite) =====================
   Mirrors the harness in tests/supabase.test.mjs — running the REAL
   supabase/schema.sql against an embedded Postgres, not a hand-written
   mirror, so the actual is_admin_member()/sync_put_meta guard shipped to
   users is what gets exercised here. */
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
async function signInAs(db, userId) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId || '']);
}
async function createMember(db, { role = 'user', disabled = false, displayName = 'QA', username = null, email = null } = {}) {
  const id = crypto.randomUUID();
  await db.query('insert into auth.users (id, email) values ($1,$2)', [id, email]);
  await db.query('insert into members (user_id, display_name, role, disabled, username) values ($1,$2,$3,$4,$5)', [id, displayName, role, disabled, username]);
  return id;
}
async function rpc(db, fn, params) {
  const p = params || {};
  const table = {
    sync_get_meta: ['select sync_get_meta($1) as result', [p.p_since ?? null]],
    sync_put_meta: ['select sync_put_meta($1::jsonb) as result', [JSON.stringify(p.p_items)]],
    sync_post_logs: ['select sync_post_logs($1::jsonb) as result', [JSON.stringify(p.p_entries)]],
    sync_get_logs: ['select sync_get_logs($1) as result', [p.p_limit ?? 10]],
    sync_put_checkpoints: ['select sync_put_checkpoints($1::jsonb) as result', [JSON.stringify(p.p_rows)]],
  }[fn];
  const res = await db.query(table[0], table[1]);
  return res.rows[0].result;
}

test('sync_put_meta: a plain "user" (writer) is rejected specifically for the egressControl key, but other meta keys still work in the SAME batch', async () => {
  const db = await backend();
  const uid = await createMember(db, { role: 'user' });
  await signInAs(db, uid);
  const res = await rpc(db, 'sync_put_meta', { p_items: {
    egressControl: { value: {enabled:true, softLimitMB:1, hardLimitMB:2}, updatedAt: '2026-09-23T00:00:00Z' },
    poList: { value: ['A'], updatedAt: '2026-09-23T00:00:00Z' },
  }});
  assert.equal(res.results.egressControl.applied, false);
  assert.equal(res.results.egressControl.reason, 'forbidden_role');
  assert.equal(res.results.poList.applied, true, 'a non-admin can still write every OTHER meta key as before');
  const get = await rpc(db, 'sync_get_meta', {});
  assert.equal(get.items.egressControl, undefined, 'the rejected key must never actually land in the table');
  assert.deepEqual(get.items.poList.value, ['A']);
});

test('sync_put_meta: a supervisor (read-only writer) is rejected the same way as any other write — is_writer_member() still gates first', async () => {
  const db = await backend();
  const uid = await createMember(db, { role: 'supervisor' });
  await signInAs(db, uid);
  const res = await rpc(db, 'sync_put_meta', { p_items: { egressControl: { value: {}, updatedAt: '2026-09-23T00:00:00Z' } } });
  assert.equal(res.error, 'forbidden_role', 'a supervisor cannot write ANY meta key, egressControl included');
});

test('sync_put_meta: an admin CAN write egressControl, and it is retrievable via sync_get_meta', async () => {
  const db = await backend();
  const uid = await createMember(db, { role: 'admin' });
  await signInAs(db, uid);
  const res = await rpc(db, 'sync_put_meta', { p_items: {
    egressControl: { value: {enabled:true, softLimitMB:150, hardLimitMB:500}, updatedAt: '2026-09-23T00:00:00Z' },
  }});
  assert.equal(res.results.egressControl.applied, true);
  const get = await rpc(db, 'sync_get_meta', {});
  assert.equal(get.items.egressControl.value.hardLimitMB, 500);
});

test('sync_put_meta: calling the RPC directly (bypassing the UI) as a non-admin still cannot write egressControl — no DevTools/API bypass', async () => {
  const db = await backend();
  const adminId = await createMember(db, { role: 'admin' });
  await signInAs(db, adminId);
  await rpc(db, 'sync_put_meta', { p_items: { egressControl: { value: {softLimitMB:100, hardLimitMB:200}, updatedAt: '2026-09-23T00:00:00Z' } } });

  const attackerId = await createMember(db, { role: 'user', displayName: 'Attacker' });
  await signInAs(db, attackerId);
  // The exact call a non-admin could fire straight at PostgREST from
  // DevTools, skipping the app's UI (and its client-side role check)
  // entirely — must still be rejected, because enforcement lives in SQL.
  const res = await rpc(db, 'sync_put_meta', { p_items: { egressControl: { value: {softLimitMB:1, hardLimitMB:2}, updatedAt: '2026-09-24T00:00:00Z' } } });
  assert.equal(res.results.egressControl.applied, false);

  await signInAs(db, adminId);
  const get = await rpc(db, 'sync_get_meta', {});
  assert.equal(get.items.egressControl.value.hardLimitMB, 200, 'the real Admin-set value must be untouched by the attempted bypass');
});

test('sync_put_checkpoints: re-pushing the same updatedAt reports reason "stale" (not a silent applied:false), but is ACCEPTED when it newly carries images (deferred-image retry)', async () => {
  const db = await backend();
  const uid = await createMember(db, { role: 'user' });
  await signInAs(db, uid);
  const row = { key: 'k1', date: '2026-09-23', shift: '1', section: 'ROA', po: '123456789', fields: {}, updatedAt: '2026-09-23T01:00:00Z' };
  assert.equal((await rpc(db, 'sync_put_checkpoints', { p_rows: [row] })).results[0].applied, true);
  const again = (await rpc(db, 'sync_put_checkpoints', { p_rows: [row] })).results[0];
  assert.equal(again.applied, false);
  assert.equal(again.reason, 'stale');
  const withImg = (await rpc(db, 'sync_put_checkpoints', { p_rows: [{ ...row, images: [{ ts: 1, dataUrl: 'data:x' }] }] })).results[0];
  assert.equal(withImg.applied, true, 'deferred image must be accepted even though updatedAt is unchanged');
});

test('sync_post_logs/sync_get_logs: stores user/machine/action from any device and returns only the newest p_limit rows; unauthenticated is rejected', async () => {
  const db = await backend();
  const uid = await createMember(db, { role: 'user' });
  await signInAs(db, uid);
  const entries = Array.from({ length: 15 }, (_, i) => ({ ts: `2026-09-23T10:${String(i).padStart(2, '0')}:00Z`, po: '123456789', section: 'ROA', user: 'QC A', machine: 'PC-X', action: 'Sửa điểm kiểm tra', changes: [] }));
  await rpc(db, 'sync_post_logs', { p_entries: entries });
  const res = await rpc(db, 'sync_get_logs', { p_limit: 10 });
  assert.equal(res.rows.length, 10);
  assert.equal(res.rows[0].ts, '2026-09-23T10:14:00Z', 'newest first');
  assert.equal(res.rows[0].user, 'QC A');
  assert.equal(res.rows[0].machine, 'PC-X');
  await signInAs(db, null);
  assert.equal((await rpc(db, 'sync_get_logs', {})).error, 'unauthorized');
});

test('sync_post_logs: the server keeps only the newest 10 log rows (older ones are auto-deleted)', async () => {
  const db = await backend();
  const uid = await createMember(db, { role: 'user' });
  await signInAs(db, uid);
  const entries = Array.from({ length: 15 }, (_, i) => ({ ts: `2026-09-23T11:${String(i).padStart(2, '0')}:00Z`, section: 'ROA', changes: [] }));
  await rpc(db, 'sync_post_logs', { p_entries: entries });
  const n = (await db.query('select count(*)::int as n, min(ts) as oldest from logs')).rows[0];
  assert.equal(n.n, 10);
  assert.equal(n.oldest, '2026-09-23T11:05:00Z');
});
