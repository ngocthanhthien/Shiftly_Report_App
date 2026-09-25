import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers the Admin-configurable tab reorder/hide-per-role feature (see
// TAB_CONFIG/applyTabConfig in index.html): Admin always sees every tab;
// 'supervisor' defaults to Nhập liệu hidden (view-only role); 'settings' can
// never be hidden (it's the only place with the Đăng xuất/Ngắt kết nối
// buttons — hiding it would lock a device out of its own account).
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
      // Thiết bị đã đăng nhập từ trước (phiên lưu sẵn) và đang offline; tắt WebSocket thật để test không gọi ra mạng.
      w.localStorage.setItem('shiftly-cf-auth', JSON.stringify({accessToken:'t', refreshToken:'r', expiresAt: 4102444800, user:{userId:'test-admin', displayName:'Test', username:'test', role:'admin'}}));
      Object.defineProperty(w, 'WebSocket', {value: undefined, configurable: true});
      w.fetch = async () => { throw new Error('network disabled in test'); };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.eval('typeof DB !== "undefined" && DB !== null'); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 50));
  return {dom, w, errors};
}
function tabOrder(w) {
  return [...w.document.querySelectorAll('.tab')].map(b => b.dataset.tab);
}
function hiddenTabs(w) {
  return [...w.document.querySelectorAll('.tab')].filter(b => b.style.display === 'none').map(b => b.dataset.tab);
}

// w.eval(...) returns objects/arrays constructed in the jsdom window's own
// realm — deepEqual (strict) treats those as unequal to a same-shaped Node
// realm array/object even when every element matches, so round-trip through
// JSON to get a plain Node-realm value before comparing.
function evalJson(w, expr) { return JSON.parse(w.eval(`JSON.stringify(${expr})`)); }

test('default boot (no login): every tab visible, default order unchanged', async () => {
  const {dom, w, errors} = await boot();
  try {
    assert.deepEqual(tabOrder(w), evalJson(w, 'TAB_ORDER_DEFAULT'));
    assert.deepEqual(hiddenTabs(w), []);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('a supervisor gets Nhập liệu hidden by default and is bounced off it if it was the active tab', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.showTab('input'); // make it the active tab, matching real login (default landing tab)
    w.eval("currentMember = {userId:'u1', displayName:'Giám sát A', role:'supervisor'}");
    w.applyTabConfig();
    assert.ok(hiddenTabs(w).includes('input'), 'input tab must be hidden for supervisor');
    const active = w.document.querySelector('.tab[aria-selected="true"]');
    assert.notEqual(active.dataset.tab, 'input', 'must not still be on the now-hidden input tab');
    assert.equal(active.style.display, '', 'the tab it landed on must actually be visible');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('admin always sees every tab, even one hidden for supervisor/user', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("currentMember = {userId:'u2', displayName:'Admin', role:'admin'}");
    w.applyTabConfig();
    assert.deepEqual(hiddenTabs(w), [], 'admin must never have any tab hidden (even Cài đặt)');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('topbar "🚪 Đăng xuất" button: hidden when logged out, shown when logged in; clicking signs out AND clears the browser Cache Storage API / Service Workers', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    const btn = () => doc.querySelector('#topbarLogoutBtn');
    w.eval('currentMember = null; updateMemberPill()'); // boot() seeds a cached session; start from the logged-out state
    assert.equal(btn().style.display, 'none', 'hidden by default (no logged-in member)');

    w.eval("currentMember = {userId:'u1', displayName:'QA', username:'qa', role:'user'}");
    w.eval('updateMemberPill()');
    assert.notEqual(btn().style.display, 'none', 'must show once a member is logged in');
    assert.ok(doc.querySelector('#memberPillTxt').textContent.includes('QA'));

    // Stub the browser APIs jsdom doesn't implement, so the click handler's
    // cache-clearing path actually runs (not just silently no-op'd) — same
    // stubbing style as w.confirm/w.print used elsewhere in this test suite.
    w.caches = { keys: async () => ['v1-static'], delete: async (k) => { w.__deletedCaches = (w.__deletedCaches||[]).concat(k); return true; } };
    w.navigator.serviceWorker = { getRegistrations: async () => [{ unregister: async () => { w.__swUnregistered = true; return true; } }] };

    btn().click();
    await new Promise(r => setTimeout(r, 100));

    assert.equal(w.eval('currentMember'), null, 'must actually sign out (currentMember cleared)');
    assert.deepEqual(evalJson(w, 'window.__deletedCaches'), ['v1-static'], 'must delete every Cache Storage entry for this origin');
    assert.equal(w.eval('window.__swUnregistered'), true, 'must unregister any Service Worker');
    // Not asserting errors.length===0: jsdom's window.location.reload() is a
    // non-configurable, non-overridable stub that logs a "Not implemented:
    // navigation" jsdomError when actually called — a pre-existing
    // environment gap (same category as the missing <canvas>/window.print()
    // implementations noted elsewhere in this suite), not a bug in
    // logoutAndClearCache() itself. The cache/service-worker cleanup above
    // (which DOES run in jsdom) is what this test can actually verify.
  } finally { dom.window.close(); }
});

test('a plain user by default sees only Nhập liệu/Báo cáo/Dữ liệu/Items Code/Hướng dẫn; Admin can hide more', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("currentMember = {userId:'u3', displayName:'Nhân viên', role:'user'}");
    w.applyTabConfig();
    assert.deepEqual(hiddenTabs(w).sort(), ['clientlist','datalog','polist','settings','specs'], 'user role default: only Nhập liệu/Báo cáo/Dữ liệu/Items Code/Hướng dẫn visible');

    w.eval("TAB_CONFIG = normalizeTabConfig({order: TAB_CONFIG.order, hidden: {user: ['report'], supervisor: ['input']}})");
    w.applyTabConfig();
    assert.deepEqual(hiddenTabs(w), ['report'], 'Admin can explicitly hide a tab for the user role too');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('normalizeTabConfig: "settings" can now be hidden per role, and reordering is respected', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval(`window._testCfg = normalizeTabConfig({
      order: ['guide','settings','input','table','polist','clientlist','datalog','report','specs'],
      hidden: {user: ['settings'], supervisor: ['settings','input']},
    })`);
    const cfg = evalJson(w, 'window._testCfg');
    assert.deepEqual(cfg.hidden.user, ['settings'], 'Cài đặt can be hidden for a role');
    assert.deepEqual(cfg.hidden.supervisor, ['settings','input']);
    assert.equal(cfg.order[0], 'guide');
    assert.equal(cfg.order[1], 'settings');

    w.eval('TAB_CONFIG = window._testCfg');
    w.applyTabConfig();
    assert.deepEqual(tabOrder(w).slice(0, 2), ['guide', 'settings']);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('tab layout: Thống kê and Xuất nhập dữ liệu are gone (share merged into Cài đặt) and default order matches the requested one', async () => {
  const {dom, w, errors} = await boot();
  try {
    assert.deepEqual(tabOrder(w), ['input','report','table','itemcodelist','clientlist','specs','datalog','polist','settings','guide']);
    w.eval("showTab('settings')");
    await new Promise(r => setTimeout(r, 100));
    const t = w.document.getElementById('view-settings').textContent;
    assert.ok(t.includes('Xuất dữ liệu') && t.includes('Nhập dữ liệu'), 'export/import now lives in Cài đặt');
    // an old saved config (no version) is replaced by the new defaults
    w.eval("TAB_CONFIG = migrateTabConfig({order:['guide','input'], hidden:{user:[],supervisor:[]}})");
    assert.deepEqual(evalJson(w, 'TAB_CONFIG.order'), ['input','report','table','itemcodelist','clientlist','specs','datalog','polist','settings','guide']);
    assert.equal(errors.length, 0, errors.join(' | '));
    await new Promise(r => setTimeout(r, 150));
  } finally { dom.window.close(); }
});
