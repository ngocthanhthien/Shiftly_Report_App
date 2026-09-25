import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers merging the standalone "Truy xuất" tab into "Dữ liệu" (tab "table"):
// the PO/Ca/date-range filter now lives directly above the Dữ liệu list
// table instead of a separate tab+result-table, and narrows that same table
// live (no search button) — see renderTable() in index.html.
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

async function seedCheckpoint(w, {date, shift, section, po, technician}) {
  await w.eval(`(async () => {
    const cp = blankCheckpoint(${JSON.stringify(date)}, ${JSON.stringify(shift)}, ${JSON.stringify(section)}, ${JSON.stringify(po)}, ${JSON.stringify(technician||'')});
    await idbPut('shifts', cp);
  })()`);
}

test('there is no standalone "trace" tab any more — Truy xuất is folded into Dữ liệu', async () => {
  const {dom, w, errors} = await boot();
  try {
    assert.equal(w.document.querySelector('[data-tab="trace"]'), null, 'the old Truy xuất tab button must be gone');
    assert.equal(w.document.querySelector('#view-trace'), null);
    assert.equal(typeof w.renderTrace, 'undefined', 'renderTrace() must no longer exist');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('Dữ liệu tab shows a PO/Ca/date filter above the table, and filtering narrows the same table live', async () => {
  const {dom, w, errors} = await boot();
  try {
    await seedCheckpoint(w, {date:'2026-09-10', shift:'1', section:'ROA', po:'PO-A', technician:'QC1'});
    await seedCheckpoint(w, {date:'2026-09-11', shift:'2', section:'EXT', po:'PO-B', technician:'QC2'});
    await w.eval('refreshCache()');
    w.showTab('table');
    await new Promise(r => setTimeout(r, 50));

    const root = w.document.querySelector('#view-table');
    assert.ok(root.textContent.includes('Truy xuất'), 'the filter card must be present in the Dữ liệu tab');
    let poCells = [...root.querySelectorAll('table.datatable tbody tr')].map(tr => tr.children[5]?.textContent || '');
    assert.equal(poCells.length, 2, 'unfiltered, both checkpoints must show');

    // Apply the PO filter the same way the autocomplete's onChange does.
    w.eval("renderTable._filter = {po:'PO-A', shift:'', from:'', to:''}; renderTable();");
    await new Promise(r => setTimeout(r, 50));
    const rows = [...root.querySelectorAll('table.datatable tbody tr')];
    assert.equal(rows.length, 1, 'filtering by PO-A must narrow to just that row');
    assert.ok(rows[0].textContent.includes('PO-A'));
    assert.ok(root.textContent.includes('Xuất Excel kết quả'), 'a filtered result set must offer the Excel export button');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('PO tab "Xem" button jumps to Dữ liệu pre-filtered to that PO', async () => {
  const {dom, w, errors} = await boot();
  try {
    await seedCheckpoint(w, {date:'2026-09-12', shift:'3', section:'ROA', po:'PO-Z'});
    await w.eval('refreshCache()');
    w.showTab('polist');
    await new Promise(r => setTimeout(r, 50));

    const poRoot = w.document.querySelector('#view-polist');
    const viewBtn = [...poRoot.querySelectorAll('.rowbtn')].find(b => b.textContent.includes('Xem'));
    assert.ok(viewBtn, 'expected a "Xem" action button for the PO-Z row');
    viewBtn.click();
    await new Promise(r => setTimeout(r, 50));

    assert.equal(w.document.querySelector('.tab[aria-selected="true"]').dataset.tab, 'table');
    const dataRoot = w.document.querySelector('#view-table');
    const rows = [...dataRoot.querySelectorAll('table.datatable tbody tr')];
    assert.equal(rows.length, 1);
    assert.ok(rows[0].textContent.includes('PO-Z'));
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('editing a checkpoint whose PO is closed asks for the Force password in Dữ liệu (previously only enforced in Truy xuất)', async () => {
  const {dom, w, errors} = await boot();
  try {
    await seedCheckpoint(w, {date:'2026-09-13', shift:'1', section:'ROA', po:'PO-CLOSED'});
    await w.eval('refreshCache()');
    await w.eval("setPOClosed('PO-CLOSED', true)");
    w.showTab('table');
    await new Promise(r => setTimeout(r, 50));

    let promptedMessage = null;
    w.prompt = (msg) => { promptedMessage = msg; return null; }; // simulate Cancel
    const root = w.document.querySelector('#view-table');
    const editBtn = [...root.querySelectorAll('table.datatable .mini')].find(b => b.textContent.trim() === '✎');
    editBtn.click();
    await new Promise(r => setTimeout(r, 20));

    assert.ok(promptedMessage && promptedMessage.includes('Force'), 'must prompt for the Force password on a closed-PO checkpoint');
    assert.equal(w.document.querySelector('.tab[aria-selected="true"]').dataset.tab, 'table', 'must not navigate to Nhập liệu since the password prompt was cancelled');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});
