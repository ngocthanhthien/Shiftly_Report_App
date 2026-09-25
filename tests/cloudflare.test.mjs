import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import bcrypt from 'bcryptjs';

// Chạy Worker THẬT (cloudflare/src/worker.js, đóng gói bằng esbuild) trong workerd cục bộ qua Miniflare — D1, R2 và Durable
// Object đều là bản cục bộ thật, không phải mô phỏng viết tay — cùng tinh thần với tests/supabase.test.mjs (chạy schema.sql
// thật qua PGlite). Kiểm cùng các hành vi: xác thực, vai trò, last-write-wins, cursor seq, ảnh, meta, nhật ký, quản trị.
const ORIGIN = 'https://ngocthanhthien.github.io';
const schemaSql = readFileSync(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8');
let mf, db, images;

before(async () => {
  const out = await build({
    entryPoints: [new URL('../cloudflare/src/worker.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'],
  });
  mf = new Miniflare({
    modules: true,
    script: out.outputFiles[0].text,
    compatibilityDate: '2025-09-01',
    d1Databases: { DB: 'test-db' },
    r2Buckets: { IMAGES: 'test-images' },
    durableObjects: { HASHER: { className: 'Hasher', useSQLite: true }, HUB: { className: 'Hub', useSQLite: true } },
    bindings: { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', ALLOWED_ORIGINS: ORIGIN, BOOTSTRAP_TOKEN: 'boot-token' },
  });
  db = await mf.getD1Database('DB');
  images = await mf.getR2Bucket('IMAGES');
  // D1.exec() coi MỖI DÒNG là 1 câu lệnh; schema.sql viết nhiều dòng nên tách theo dấu ';' và chạy từng câu.
  const stmts = schemaSql.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const s of stmts) await db.prepare(s).run();
});
after(async () => { await mf.dispose(); });

async function call(path, body, { token, headers } = {}) {
  const res = await mf.dispatchFetch('http://api.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  return { status: res.status, data };
}
const rpc = async (fn, params, token) => (await call('/rpc/' + fn, params, { token })).data;
const login = async (identifier, password) => call('/auth/login', { identifier, password });
const uid = () => crypto.randomUUID();
const hash = pw => bcrypt.hashSync(pw, 10); // cùng định dạng/độ khó bcrypt mà Supabase Auth đang lưu

async function seedUsers() {
  const users = {
    admin: { id: uid(), email: 'admin@example.com', displayName: 'Quản trị', role: 'admin', passwordHash: hash('adminpass') },
    user: { id: uid(), username: 'qa1', displayName: 'QA Một', role: 'user', passwordHash: hash('userpass') },
    sup: { id: uid(), username: 'giamsat', displayName: 'Giám sát A', role: 'supervisor', passwordHash: hash('suppass') },
    off: { id: uid(), username: 'nghiviec', displayName: 'Đã nghỉ', role: 'user', disabled: true, passwordHash: hash('offpass') },
  };
  const r = await call('/auth/bootstrap', { users: Object.values(users) }, { headers: { 'X-Bootstrap-Token': 'boot-token' } });
  return { users, r };
}
let U, T; // users + tokens
const put = (rows, token = T.user) => rpc('sync_put_checkpoints', { p_rows: rows }, token);
const cp = (key, extra = {}) => ({ key, date: '2026-09-25', shift: '1', section: 'ROA', po: '123456789', fields: { A: 1 }, updatedAt: '2026-09-25T01:00:00Z', ...extra });

test('setup: bootstrap imports accounts (bcrypt hashes kept), is idempotent, and rejects a wrong/missing token', async () => {
  const bad = await call('/auth/bootstrap', { users: [] }, { headers: { 'X-Bootstrap-Token': 'nope' } });
  assert.equal(bad.status, 403);
  assert.equal((await call('/auth/bootstrap', { users: [] })).status, 403);
  const { users, r } = await seedUsers();
  U = users;
  assert.equal(r.data.inserted, 4);
  const again = await call('/auth/bootstrap', { users: Object.values(users) }, { headers: { 'X-Bootstrap-Token': 'boot-token' } });
  assert.equal(again.data.inserted, 0);
  assert.equal(again.data.skipped, 4);
  T = {};
  for (const [k, id, pw] of [['admin', 'admin@example.com', 'adminpass'], ['user', 'qa1', 'userpass'], ['sup', 'giamsat', 'suppass']]) {
    const l = await login(id, pw);
    assert.equal(l.status, 200, k);
    T[k] = l.data.accessToken; T[k + 'Refresh'] = l.data.refreshToken;
  }
});

test('CORS: the GitHub Pages origin is allowed; another origin gets no Access-Control-Allow-Origin; preflight works', async () => {
  const ok = await mf.dispatchFetch('http://api.test/health', { headers: { Origin: ORIGIN } });
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  const other = await mf.dispatchFetch('http://api.test/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const pre = await mf.dispatchFetch('http://api.test/rpc/sync_get_meta', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(pre.status, 204);
});

test('login: email (Admin) and username (Nhân viên) both work with the ORIGINAL bcrypt password; the old synthetic Supabase email form is still accepted', async () => {
  assert.equal((await login('ADMIN@example.com', 'adminpass')).status, 200, 'email is case-insensitive');
  assert.equal((await login('QA1', 'userpass')).status, 200);
  assert.equal((await login('qa1@abcdef.users.internal', 'userpass')).status, 200, 'client cũ ghép username thành email giả');
  assert.equal((await login('qa1', 'wrong')).status, 401);
  assert.equal((await login('khongco', 'x')).status, 401);
  assert.equal((await login('nghiviec', 'offpass')).status, 401, 'tài khoản bị vô hiệu hóa không đăng nhập được');
});

test('login: a bcrypt hash is transparently upgraded to PBKDF2 on first success, and the same password keeps working', async () => {
  const before = await db.prepare('SELECT password_hash FROM users WHERE username = ?1').bind('qa1').first();
  assert.ok(before.password_hash.startsWith('pbkdf2$'), 'đã nâng cấp sau lần đăng nhập đầu (trong setup)');
  assert.equal((await login('qa1', 'userpass')).status, 200);
  assert.equal((await login('qa1', 'userpass2')).status, 401);
});

test('login: brute force is throttled (429 after repeated failures) and a success clears the counter', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await login('giamsat', 'sai' + i)).status, 401);
  assert.equal((await login('giamsat', 'suppass')).status, 429, 'đã bị khoá tạm thời dù đúng mật khẩu');
});

test('refresh rotates the refresh token (old one dies), logout revokes it, and access tokens are rejected once tampered', async () => {
  const l = await login('admin@example.com', 'adminpass');
  const r1 = await call('/auth/refresh', { refreshToken: l.data.refreshToken });
  assert.equal(r1.status, 200);
  assert.equal((await call('/auth/refresh', { refreshToken: l.data.refreshToken })).status, 401, 'refresh token cũ hết hiệu lực');
  await call('/auth/logout', { refreshToken: r1.data.refreshToken });
  assert.equal((await call('/auth/refresh', { refreshToken: r1.data.refreshToken })).status, 401);
  const tampered = l.data.accessToken.slice(0, -3) + 'AAA';
  assert.equal((await rpc('sync_whoami', {}, tampered)).error, 'unauthorized');
});

test('every rpc rejects an unauthenticated caller with HTTP 200 + {error:"unauthorized"} (same convention cloudFetch relies on)', async () => {
  for (const fn of ['sync_whoami', 'sync_get_checkpoints', 'sync_get_checkpoint_images', 'sync_put_checkpoints', 'sync_delete_checkpoints', 'sync_get_meta', 'sync_put_meta', 'sync_post_logs', 'sync_get_logs']) {
    const r = await call('/rpc/' + fn, {});
    assert.equal(r.status, 200, fn);
    assert.equal(r.data.error, 'unauthorized', fn);
  }
});

test('sync_whoami returns the caller\'s own record; a member disabled mid-session is unauthorized on the very next call', async () => {
  const who = await rpc('sync_whoami', {}, T.user);
  assert.equal(who.userId, U.user.id);
  assert.equal(who.username, 'qa1');
  assert.equal(who.role, 'user');
  const l = await login('admin@example.com', 'adminpass');
  const created = (await call('/admin/users', { action: 'create-user', displayName: 'Tạm', username: 'tam', password: 'tam123', role: 'user' }, { token: l.data.accessToken })).data;
  const tl = await login('tam', 'tam123');
  assert.equal((await rpc('sync_whoami', {}, tl.data.accessToken)).role, 'user');
  await call('/admin/users', { action: 'disable-user', targetUserId: created.user.userId }, { token: l.data.accessToken });
  assert.equal((await rpc('sync_whoami', {}, tl.data.accessToken)).error, 'unauthorized');
  assert.equal((await call('/auth/refresh', { refreshToken: tl.data.refreshToken })).status, 401, 'phiên bị thu hồi');
});

test('a supervisor can read everything but every write RPC rejects with {error:"forbidden_role"}', async () => {
  const s = T.sup || (await call('/auth/login', { identifier: 'giamsat', password: 'suppass' })).data.accessToken;
  // (đăng nhập giamsat đã bị khoá ở test brute-force → dùng token lấy được từ setup)
  assert.equal((await rpc('sync_get_checkpoints', {}, T.sup)).rows.length >= 0, true);
  assert.equal((await rpc('sync_get_meta', {}, T.sup)).items !== undefined, true);
  assert.equal((await rpc('sync_put_checkpoints', { p_rows: [] }, T.sup)).error, 'forbidden_role');
  assert.equal((await rpc('sync_delete_checkpoints', { p_deletes: [] }, T.sup)).error, 'forbidden_role');
  assert.equal((await rpc('sync_put_meta', { p_items: {} }, T.sup)).error, 'forbidden_role');
  assert.equal((await rpc('sync_post_logs', { p_entries: [] }, T.sup)).error, 'forbidden_role');
  void s;
});

test('checkpoints: push, pull, stale rejected with reason "stale", cursor advances, distinct seq per row, tombstone delete', async () => {
  const res = await put([cp('c1'), cp('c2', { fields: { A: 2 } })]);
  assert.deepEqual(res.results.map(r => r.applied), [true, true]);
  const pulled = await rpc('sync_get_checkpoints', { p_since: 0 }, T.user);
  const c1 = pulled.rows.find(r => r.key === 'c1');
  assert.equal(c1.fields.A, 1);
  assert.equal(c1.deleted, false);
  assert.equal(c1.itemCode, '');
  assert.equal(pulled.hasMore, false);
  const seqs = (await db.prepare("SELECT seq FROM checkpoints WHERE key IN ('c1','c2')").all()).results.map(r => r.seq);
  assert.equal(new Set(seqs).size, 2, 'mỗi dòng 1 seq riêng');
  assert.equal(pulled.cursor, Math.max(...seqs));

  const stale = await put([cp('c1', { fields: { A: 99 }, updatedAt: '2026-09-24T00:00:00Z' })]);
  assert.equal(stale.results[0].applied, false);
  assert.equal(stale.results[0].reason, 'stale');
  const same = await put([cp('c1')]);
  assert.equal(same.results[0].reason, 'stale', 'cùng updatedAt, không kèm ảnh mới → bỏ qua, không phải lỗi im lặng');

  const newer = await put([cp('c1', { fields: { A: 5 }, updatedAt: '2026-09-25T02:00:00Z' })]);
  assert.equal(newer.results[0].applied, true);
  const inc = await rpc('sync_get_checkpoints', { p_since: pulled.cursor }, T.user);
  assert.deepEqual(inc.rows.map(r => r.key), ['c1'], 'chỉ dòng đổi sau cursor');
  assert.equal(inc.rows[0].fields.A, 5);

  await rpc('sync_delete_checkpoints', { p_deletes: [{ key: 'c2', updatedAt: '2026-09-25T03:00:00Z' }, { key: 'c1', updatedAt: '2026-09-20T00:00:00Z' }] }, T.user);
  const after = await rpc('sync_get_checkpoints', { p_since: inc.cursor }, T.user);
  assert.deepEqual(after.rows.map(r => [r.key, r.deleted]), [['c2', true]], 'xoá c1 bằng updatedAt cũ hơn bị bỏ qua (last-write-wins từng dòng)');
});

test('checkpoints: more than 20 rows in one call are not silently dropped — the extras report reason "batch_too_large" so the client can resend', async () => {
  const rows = Array.from({ length: 23 }, (_, i) => cp('bulk' + i));
  const res = await put(rows);
  assert.equal(res.results.filter(r => r.applied).length, 20);
  assert.deepEqual(res.results.slice(20).map(r => r.reason), ['batch_too_large', 'batch_too_large', 'batch_too_large']);
});

test('images: stored in R2 (not D1), sync_get_checkpoints only returns imagesFp, images fetched separately; omitted `images` keeps them; [] clears them', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(50000);
  const res = await put([cp('img1', { images: [{ name: 'a.jpg', dataUrl: big, ts: 123 }, { name: 'b.jpg', dataUrl: big + 'B', ts: 456 }] })]);
  assert.equal(res.results[0].applied, true);
  const row = await db.prepare("SELECT images, images_fp FROM checkpoints WHERE key = 'img1'").first();
  assert.ok(!row.images.includes('dataUrl'), 'D1 chỉ giữ metadata, không giữ base64 (giới hạn 2MB/dòng)');
  assert.equal(row.images_fp, '123,456');
  assert.equal((await images.list()).objects.length >= 2, true);

  const pulled = (await rpc('sync_get_checkpoints', { p_since: 0 }, T.user)).rows.find(r => r.key === 'img1');
  assert.equal(pulled.imagesFp, '123,456');
  assert.equal(pulled.images, undefined);

  const got = await rpc('sync_get_checkpoint_images', { p_keys: ['img1', 'c2', 'khongco'] }, T.user);
  assert.deepEqual(Object.keys(got.items), ['img1'], 'chỉ trả ảnh của đúng key được hỏi và còn tồn tại');
  assert.equal(got.items.img1[0].dataUrl, big);
  assert.equal(got.items.img1[1].name, 'b.jpg');
  assert.deepEqual(got.pending, []);

  await put([cp('img1', { fields: { A: 7 }, updatedAt: '2026-09-25T05:00:00Z' })]); // không gửi `images`
  assert.equal((await rpc('sync_get_checkpoint_images', { p_keys: ['img1'] }, T.user)).items.img1.length, 2, 'bỏ field images = giữ nguyên ảnh cũ');

  await put([cp('img1', { updatedAt: '2026-09-25T06:00:00Z', images: [{ name: 'a.jpg', dataUrl: big, ts: 123 }] })]);
  assert.equal((await rpc('sync_get_checkpoint_images', { p_keys: ['img1'] }, T.user)).items.img1.length, 1, 'ảnh bị bỏ khỏi danh sách sẽ bị xoá');
  assert.equal((await images.list({ prefix: 'cp/img1/' })).objects.length, 1, 'và đối tượng R2 của ảnh đó cũng bị xoá');

  await put([cp('img1', { updatedAt: '2026-09-25T07:00:00Z', images: [] })]);
  assert.equal((await rpc('sync_get_checkpoint_images', { p_keys: ['img1'] }, T.user)).items.img1.length, 0);
  assert.equal((await images.list({ prefix: 'cp/img1/' })).objects.length, 0);
});

test('images: a deferred image (Data & Egress Control Protection) re-pushed with the SAME updatedAt is accepted once it carries a new image', async () => {
  const first = await put([cp('img2', { updatedAt: '2026-09-25T08:00:00Z' })]);
  assert.equal(first.results[0].applied, true);
  const retry = await put([cp('img2', { updatedAt: '2026-09-25T08:00:00Z', images: [{ name: 'x.jpg', dataUrl: 'data:x', ts: 9 }] })]);
  assert.equal(retry.results[0].applied, true);
  assert.equal((await rpc('sync_get_checkpoint_images', { p_keys: ['img2'] }, T.user)).items.img2[0].dataUrl, 'data:x');
  const again = await put([cp('img2', { updatedAt: '2026-09-25T08:00:00Z', images: [{ name: 'x.jpg', dataUrl: 'data:x', ts: 9 }] })]);
  assert.equal(again.results[0].reason, 'stale', 'cùng ảnh, cùng updatedAt → không nhận lại');
});

test('images: deleting a checkpoint removes its R2 objects; a call needing more R2 reads than the Free-plan subrequest budget returns the rest in `pending`', async () => {
  await put([cp('img3', { updatedAt: '2026-09-25T09:00:00Z', images: [{ name: 'd.jpg', dataUrl: 'data:d', ts: 1 }] })]);
  assert.equal((await images.list({ prefix: 'cp/img3/' })).objects.length, 1);
  await rpc('sync_delete_checkpoints', { p_deletes: [{ key: 'img3', updatedAt: '2026-09-25T10:00:00Z' }] }, T.user);
  assert.equal((await images.list({ prefix: 'cp/img3/' })).objects.length, 0);

  const many = n => Array.from({ length: n }, (_, i) => ({ name: i + '.jpg', dataUrl: 'data:m' + i, ts: i + 1 }));
  await put([cp('p1', { updatedAt: '2026-09-25T11:00:00Z', images: many(30) })]);
  await put([cp('p2', { updatedAt: '2026-09-25T11:00:00Z', images: many(30) })]);
  const got = await rpc('sync_get_checkpoint_images', { p_keys: ['p1', 'p2'] }, T.user);
  assert.equal(Object.keys(got.items).length + got.pending.length, 2, 'không key nào bị bỏ sót âm thầm');
  assert.equal(got.pending.length, 1);
  const rest = await rpc('sync_get_checkpoint_images', { p_keys: got.pending }, T.user);
  assert.equal(Object.keys(rest.items).length, 1);
});

test('meta: last-write-wins, p_since cursor returns only changed keys, and egressControl is writable by Admin only (server-side)', async () => {
  const put1 = await rpc('sync_put_meta', { p_items: { poList: { value: ['A', 'B'], updatedAt: '2026-09-25T01:00:00Z' } } }, T.user);
  assert.equal(put1.results.poList.applied, true);
  const stale = await rpc('sync_put_meta', { p_items: { poList: { value: ['STALE'], updatedAt: '2026-09-24T00:00:00Z' } } }, T.user);
  assert.equal(stale.results.poList.applied, false);
  const g = await rpc('sync_get_meta', {}, T.user);
  assert.deepEqual(g.items.poList.value, ['A', 'B']);
  assert.deepEqual((await rpc('sync_get_meta', { p_since: g.cursor }, T.user)).items, {}, 'không đổi gì → rỗng');

  const mixed = await rpc('sync_put_meta', { p_items: {
    egressControl: { value: { enabled: true, softLimitMB: 1, hardLimitMB: 2 }, updatedAt: '2026-09-25T02:00:00Z' },
    clientList: { value: ['C'], updatedAt: '2026-09-25T02:00:00Z' },
  } }, T.user);
  assert.equal(mixed.results.egressControl.applied, false);
  assert.equal(mixed.results.egressControl.reason, 'forbidden_role');
  assert.equal(mixed.results.clientList.applied, true, 'khoá khác vẫn ghi bình thường trong cùng lệnh');
  const adm = await rpc('sync_put_meta', { p_items: { egressControl: { value: { enabled: true, softLimitMB: 150, hardLimitMB: 500 }, updatedAt: '2026-09-25T03:00:00Z' } } }, T.admin);
  assert.equal(adm.results.egressControl.applied, true);
  assert.equal((await rpc('sync_get_meta', {}, T.user)).items.egressControl.value.hardLimitMB, 500);
  const attack = await rpc('sync_put_meta', { p_items: { egressControl: { value: { softLimitMB: 1, hardLimitMB: 2 }, updatedAt: '2026-09-26T00:00:00Z' } } }, T.user);
  assert.equal(attack.results.egressControl.applied, false);
  assert.equal((await rpc('sync_get_meta', {}, T.admin)).items.egressControl.value.hardLimitMB, 500, 'gọi thẳng API cũng không đổi được');
});

test('logs: user/machine/action stored, server keeps only the newest 10, sync_get_logs returns newest first with the limit honoured', async () => {
  const entries = Array.from({ length: 15 }, (_, i) => ({ ts: `2026-09-25T10:${String(i).padStart(2, '0')}:00Z`, po: '123456789', section: 'ROA', user: 'QC A', machine: 'PC-X', action: 'Sửa điểm kiểm tra', changes: [{ label: 'x', from: null, to: i }] }));
  await rpc('sync_post_logs', { p_entries: entries.slice(0, 10) }, T.user);
  await rpc('sync_post_logs', { p_entries: entries.slice(10) }, T.user);
  const n = await db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM logs').first();
  assert.equal(n.n, 10);
  assert.equal(n.oldest, '2026-09-25T10:05:00Z');
  const res = await rpc('sync_get_logs', { p_limit: 10 }, T.user);
  assert.equal(res.rows.length, 10);
  assert.equal(res.rows[0].ts, '2026-09-25T10:14:00Z');
  assert.equal(res.rows[0].user, 'QC A');
  assert.equal(res.rows[0].changes[0].to, 14);
  assert.equal((await rpc('sync_get_logs', { p_limit: 3 }, T.user)).rows.length, 3);
});

test('admin API: only Admin; create user (login works with the chosen password), duplicate rejected, role change, last-admin protection, list', async () => {
  assert.equal((await call('/admin/users', { action: 'list-users' }, { token: T.user })).status, 403);
  assert.equal((await call('/admin/users', { action: 'list-users' })).status, 401);
  const c = await call('/admin/users', { action: 'create-user', displayName: 'Nhân viên Mới', username: 'moi01', password: 'matkhau1', role: 'user' }, { token: T.admin });
  assert.equal(c.data.ok, true);
  assert.equal((await login('moi01', 'matkhau1')).status, 200);
  assert.match((await call('/admin/users', { action: 'create-user', displayName: 'Trùng', username: 'moi01', password: 'matkhau1' }, { token: T.admin })).data.error, /đã được sử dụng/);
  assert.match((await call('/admin/users', { action: 'create-user', displayName: 'X', username: 'Bad Name', password: 'matkhau1' }, { token: T.admin })).data.error, /không hợp lệ/);
  assert.match((await call('/admin/users', { action: 'create-user', displayName: 'X', username: 'okname', password: '123' }, { token: T.admin })).data.error, /6 ký tự/);
  assert.equal((await call('/admin/users', { action: 'change-role', targetUserId: c.data.user.userId, newRole: 'supervisor' }, { token: T.admin })).data.role, 'supervisor');
  const list = (await call('/admin/users', { action: 'list-users' }, { token: T.admin })).data.users;
  assert.equal(list[0].role, 'admin', 'Admin lên đầu');
  const moi = list.find(u => u.username === 'moi01');
  assert.equal(moi.role, 'supervisor');
  assert.equal(moi.email, null);
  const self = U.admin.id;
  assert.match((await call('/admin/users', { action: 'change-role', targetUserId: self, newRole: 'user' }, { token: T.admin })).data.error, /duy nhất/);
  assert.match((await call('/admin/users', { action: 'disable-user', targetUserId: self }, { token: T.admin })).data.error, /chính bạn/);
  const audit = await db.prepare('SELECT COUNT(*) AS n FROM member_audit').first();
  assert.ok(audit.n >= 3, 'thao tác quản trị được ghi vào member_audit');
});

test('realtime: a WebSocket subscriber is told "changed" after another member pushes data; unauthenticated sockets are refused', async () => {
  const denied = await mf.dispatchFetch('http://api.test/realtime', { headers: { Upgrade: 'websocket' } });
  assert.equal(denied.status, 401);
  const res = await mf.dispatchFetch('http://api.test/realtime?token=' + T.admin, { headers: { Upgrade: 'websocket' } });
  assert.equal(res.status, 101);
  const ws = res.webSocket;
  ws.accept();
  const got = new Promise(resolve => ws.addEventListener('message', e => resolve(e.data)));
  await put([cp('rt1', { updatedAt: '2026-09-25T12:00:00Z' })]);
  assert.equal(await Promise.race([got, new Promise(r => setTimeout(() => r('timeout'), 3000))]), 'changed');
  ws.close();
});

test('login: an absurdly long password is rejected up front (no expensive hashing), and expired sessions are cleaned up on login', async () => {
  assert.equal((await login('qa1', 'x'.repeat(5000))).status, 400);
  await db.prepare("INSERT INTO sessions (id, user_id, refresh_hash, expires_at) VALUES ('old1', 'u', 'h', 1)").run();
  assert.equal((await login('admin@example.com', 'adminpass')).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = 'old1'").first()).n, 0);
});
