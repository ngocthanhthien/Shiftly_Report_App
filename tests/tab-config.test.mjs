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
    assert.deepEqual(hiddenTabs(w), [], 'admin must never have any tab hidden');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('a plain user is unaffected (default hidden list is empty) unless Admin explicitly hides something', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("currentMember = {userId:'u3', displayName:'Nhân viên', role:'user'}");
    w.applyTabConfig();
    assert.deepEqual(hiddenTabs(w), [], 'user role keeps its pre-existing full access by default');

    w.eval("TAB_CONFIG = normalizeTabConfig({order: TAB_CONFIG.order, hidden: {user: ['stats'], supervisor: ['input']}})");
    w.applyTabConfig();
    assert.deepEqual(hiddenTabs(w), ['stats'], 'Admin can explicitly hide a tab for the user role too');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('normalizeTabConfig: "settings" can never be hidden, and reordering is respected', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval(`window._testCfg = normalizeTabConfig({
      order: ['guide','settings','input','table','polist','clientlist','datalog','report','stats','specs','share'],
      hidden: {user: ['settings'], supervisor: ['settings','input']},
    })`);
    const cfg = evalJson(w, 'window._testCfg');
    assert.deepEqual(cfg.hidden.user, [], '"settings" must be stripped out even if the caller tried to hide it');
    assert.deepEqual(cfg.hidden.supervisor, ['input']);
    assert.equal(cfg.order[0], 'guide');
    assert.equal(cfg.order[1], 'settings');

    w.eval('TAB_CONFIG = window._testCfg');
    w.applyTabConfig();
    assert.deepEqual(tabOrder(w).slice(0, 2), ['guide', 'settings']);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});
