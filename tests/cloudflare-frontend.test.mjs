import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { startBackend, seedUsers, API } from './helpers/cf-backend.mjs';

// App thật (index.html chạy trong jsdom) nói chuyện với Worker thật (Miniflare). Kiểm luồng người dùng: đăng nhập bằng tài khoản
// cũ, đồng bộ điểm kiểm tra + ảnh sang máy thứ hai, thu hồi quyền giữa phiên, phục hồi JSON v2, chuyển cấu hình từ Supabase.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let backend;
before(async () => { backend = await startBackend(); await seedUsers(backend.mf); });
after(async () => { await backend.mf.dispose(); });

const rpcCalls = [];
async function boot({ session } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'https://ngocthanhthien.github.io/Shiftly_Report_App/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.indexedDB = new IDBFactory();
      w.AbortSignal = AbortSignal;
      Object.defineProperty(w, 'WebSocket', { value: undefined, configurable: true });
      if (session) w.localStorage.setItem('shiftly-cf-auth', JSON.stringify(session));
      w.fetch = async (url, opts) => {
        const u = String(url).replace(/^https:\/\/shiftly-report-api\.[^/]+/, API); // app gọi địa chỉ Worker mặc định -> Worker cục bộ
        const m = u.match(/\/rpc\/([a-z_]+)/); if (m) rpcCalls.push(m[1]);
        return backend.mf.dispatchFetch(u, opts);
      };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.eval('typeof DB !== "undefined" && DB !== null'); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 150));
  return { dom, w, errors };
}
const gateVisible = w => w.document.getElementById('loginGate').style.display !== 'none';
async function loginAs(w, who) {
  return who === 'admin' ? w.eval("signInAdmin('admin@example.com','adminpass')") : w.eval("signInUser('qa1','userpass')");
}
const settle = ms => new Promise(r => setTimeout(r, ms));
// Chờ tới khi hàng đợi gửi lên của máy đã rỗng và không còn dòng nào chưa đồng bộ (thay cho khoảng chờ cố định — tránh chập chờn khi máy chậm)
async function drained(w, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await w.eval('(async () => { await flushOutbox(); })()');
    if ((await w.idbGetAll('outbox')).length === 0 && (await w.collectDirtyCheckpointRows()).length === 0) return true;
    await settle(150);
  }
  return false;
}

test('boot without a session shows the login gate; wrong password is rejected with the same wording as before; the OLD (bcrypt) password logs in', async () => {
  const { dom, w, errors } = await boot();
  try {
    assert.equal(gateVisible(w), true);
    assert.equal(await w.eval("signInUser('qa1','wrong')"), 'Sai tên đăng nhập hoặc mật khẩu');
    assert.equal(await w.eval("signInAdmin('admin@example.com','wrong')"), 'Sai email hoặc mật khẩu');
    assert.equal(await loginAs(w, 'user'), null);
    assert.equal(gateVisible(w), false);
    assert.equal(w.eval('currentMember.role'), 'user');
    assert.equal(w.eval('currentMember.displayName'), 'QA Một');
    assert.equal(w.eval("JSON.parse(localStorage.getItem('shiftly-cf-auth')).user.username"), 'qa1', 'phiên lưu để lần mở sau không phải đăng nhập lại');
    assert.equal(errors.length, 0, errors.join(' | '));
    await settle(200);
  } finally { dom.window.close(); }
});

test('a checkpoint with a photo syncs from device A to device B (photo fetched separately, once); a field-only edit does not re-download it', async () => {
  const A = await boot(), B = await boot();
  try {
    await loginAs(A.w, 'user');
    await A.w.eval(`(async () => {
      const cp = blankCheckpoint('2026-09-25','1','ROA','123456789','QA');
      cp.fields = {ROA_R5C: 100}; cp.images = [{name:'a.jpg', dataUrl:'data:image/jpeg;base64,${'A'.repeat(20000)}', ts: 111}];
      cp.updatedAt = new Date().toISOString();
      await idbPut('shifts', cp); await refreshCache(); await persistAll(); await flushOutbox();
    })()`);
    assert.equal(await drained(A.w), true, 'hàng đợi đã đẩy hết');
    assert.equal((await A.w.collectDirtyCheckpointRows()).length, 0);
    assert.equal((await backend.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE po = '123456789'").first()).n, 1);

    await loginAs(B.w, 'admin');
    rpcCalls.length = 0;
    await B.w.eval('(async () => { await pullFromCloud(); })()');
    const got = (await B.w.idbGetAll('shifts')).find(r => r.po === '123456789');
    assert.equal(got.fields.ROA_R5C, 100);
    assert.equal(got.images.length, 1);
    assert.ok(got.images[0].dataUrl.length > 20000, 'ảnh về đủ nội dung');
    assert.equal(rpcCalls.filter(c => c === 'sync_get_checkpoint_images').length, 1);

    await A.w.eval(`(async () => {
      const cp = allCheckpoints.find(r=>r.po==='123456789'); cp.fields.ROA_R5C = 101; cp.updatedAt = new Date(Date.now()+5000).toISOString();
      await idbPut('shifts', cp); await refreshCache(); await persistAll(); await flushOutbox();
    })()`);
    rpcCalls.length = 0;
    await B.w.eval('(async () => { await pullFromCloud(); })()');
    const again = (await B.w.idbGetAll('shifts')).find(r => r.po === '123456789');
    assert.equal(again.fields.ROA_R5C, 101);
    assert.equal(again.images.length, 1, 'ảnh giữ nguyên');
    assert.equal(rpcCalls.filter(c => c === 'sync_get_checkpoint_images').length, 0, 'sửa số liệu không tải lại ảnh');
    await drained(A.w);
  } finally { A.dom.window.close(); B.dom.window.close(); }
});

test('an account disabled by an Admin mid-session is sent back to the login gate on the next sync', async () => {
  const A = await boot();
  const adm = await boot();
  try {
    await loginAs(A.w, 'user');
    assert.equal(gateVisible(A.w), false);
    await loginAs(adm.w, 'admin');
    const list = await adm.w.eval("adminUsersCall('list-users')");
    const qa = list.users.find(u => u.username === 'qa1');
    assert.equal((await adm.w.eval(`adminUsersCall('disable-user', {targetUserId: '${qa.userId}'})`)).status, 'Disabled');
    await A.w.eval('(async () => { await flushOutbox(); })()');
    await settle(300);
    assert.equal(gateVisible(A.w), true, 'thiết bị bị đá về màn hình đăng nhập');
    assert.equal(A.w.eval('currentMember'), null);
    assert.equal(await A.w.eval("signInUser('qa1','userpass')"), 'Sai tên đăng nhập hoặc mật khẩu', 'tài khoản bị vô hiệu hóa không đăng nhập được');
    await adm.w.eval(`adminUsersCall('enable-user', {targetUserId: '${qa.userId}'})`);
    assert.equal(await A.w.eval("signInUser('qa1','userpass')"), null, 'bật lại thì đăng nhập được với đúng mật khẩu cũ');
    await settle(300);
  } finally { A.dom.window.close(); adm.dom.window.close(); }
});

test('JSON backup v2 round-trips checkpoints AND meta, and restoring it uploads everything (local "already synced" markers are dropped)', async () => {
  const A = await boot(), B = await boot();
  try {
    await loginAs(A.w, 'admin');
    const backup = await A.w.eval(`(async () => {
      const cp = blankCheckpoint('2026-09-25','2','EXT','987654321','QA'); cp.fields = {}; cp.updatedAt = new Date().toISOString();
      cp._syncedAt = cp.updatedAt; cp._imagesSyncedFp = ''; // giả lập bản ghi vốn "đã đồng bộ" với server CŨ
      await idbPut('shifts', cp); await refreshCache();
      PO_LIST = ['987654321']; TECHNICIANS = ['QA Backup'];
      return JSON.stringify(buildBackupJson());
    })()`);
    const parsed = JSON.parse(backup);
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.meta.technicians, ['QA Backup']);

    await loginAs(B.w, 'admin');
    // mô phỏng đúng đoạn xử lý của nút "Phục hồi từ JSON"
    await B.w.eval(`(async () => {
      const parsed = ${backup};
      for (const r of parsed.checkpoints) await idbPut('shifts', forUpload(r));
      await restoreMetaFromBackup(parsed.meta);
      await refreshCache(); scheduleFlush(); await flushOutbox();
    })()`);
    assert.equal(await drained(B.w), true);
    assert.equal((await backend.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE po = '987654321'").first()).n, 1, 'bản ghi từ file sao lưu đã lên server');
    const meta = await backend.db.prepare("SELECT value FROM meta WHERE k = 'technicians'").first();
    assert.deepEqual(JSON.parse(meta.value), ['QA Backup']);
    assert.equal(B.w.eval("forUpload({key:'k', _syncedAt:'x', _imagesSyncedFp:'y', a:1})._syncedAt"), undefined);
    await settle(300);
  } finally { A.dom.window.close(); B.dom.window.close(); }
});

test('a device still configured for Supabase is switched to the Cloudflare Worker automatically (no manual setup), cursors reset, unsent outbox kept', async () => {
  const { dom, w } = await boot({ session: { accessToken: 't', refreshToken: 'r', expiresAt: 4102444800, user: { userId: 'u', displayName: 'X', username: 'x', role: 'user' } } });
  try {
    await w.eval(`(async () => {
      await idbPut('meta', {k:'cloudCfg', value:{url:'https://old.supabase.co', anonKey:'k'}});
      await idbPut('meta', {k:'syncCursors', value:{checkpoints:'777', meta:'2026-01-01'}});
      await idbPut('meta', {k:'backend', value:'supabase'});
      await queueOutbox('meta', {key:'poList', value:['A'], updatedAt:'2026-09-25T00:00:00Z'});
      await loadCloudState();
    })()`);
    assert.equal(w.eval('cloudCfg.url'), w.eval('DEFAULT_API_URL'));
    assert.equal(w.eval('syncCursors.checkpoints'), '0');
    assert.equal((await w.idbGetAll('outbox')).length >= 1, true, 'thay đổi chưa gửi không bị mất');
    await settle(200);
  } finally { dom.window.close(); }
});

test('a token refresh that fails only because of a flaky network does NOT log the user out; only a real rejection does', async () => {
  const { dom, w } = await boot();
  try {
    await loginAs(w, 'user');
    assert.equal(gateVisible(w), false);
    // Máy chủ nói "unauthorized" và lần làm mới phiên hỏng vì mạng (fetch ném lỗi) -> giữ phiên, không đá ra.
    w.fetch = async url => {
      if (String(url).includes('/auth/refresh')) throw new Error('network down');
      return { ok: true, status: 200, text: async () => JSON.stringify({ error: 'unauthorized' }) };
    };
    const res = await w.eval("(async () => { const r = await cloudFetch('sync_get_meta', {}); return r === null; })()");
    assert.equal(res, true);
    assert.equal(gateVisible(w), false, 'vẫn ở trong app');
    assert.ok(w.eval("!!authSession"), 'phiên còn nguyên');
    await settle(200);
  } finally { dom.window.close(); }
});

test('restoring a large backup does not build an outbox entry per row (no O(n^2) queue with photos): rows go out via the dirty scan and all reach the server', async () => {
  const { dom, w } = await boot();
  try {
    await loginAs(w, 'admin');
    await w.eval(`(async () => {
      for (let i = 0; i < 45; i++) {
        const cp = blankCheckpoint('2026-09-2' + (i % 9), '1', 'ROA', String(500000000 + i), 'QA');
        cp.updatedAt = new Date().toISOString(); cp.images = i % 5 === 0 ? [{name:'i.jpg', dataUrl:'data:image/jpeg;base64,QQ==', ts: i + 1}] : [];
        await idbPut('shifts', forUpload(Object.assign(cp, {_syncedAt: cp.updatedAt})));
      }
      await refreshCache(); scheduleFlush();
    })()`);
    assert.equal((await w.idbGetAll('outbox')).filter(i => i.kind === 'checkpoint').length, 0, 'không xếp từng dòng vào hàng đợi');
    assert.equal(await drained(w, 15000), true);
    assert.equal((await backend.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE po LIKE '5000000%'").first()).n, 45);
    await settle(200);
  } finally { dom.window.close(); }
});
