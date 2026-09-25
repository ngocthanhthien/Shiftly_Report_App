import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers the PO/Client tabs after they were converted (alongside Items
// Code, see tests/item-code-list.test.mjs) from a "form above + list below"
// UI to a shared spreadsheet-style editable table: sortable columns, a
// filter row, a pinned add-row, and cells editable in place
// (buildEditableTable in index.html). Recipe no longer has its own managed
// list/tab — see tests/specs-table.test.mjs for the Recipe-override editor
// that now sources suggestions from ITEM_CODE_LIST.
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

function tableIn(w, tabId){ return w.document.querySelector(`#view-${tabId} table.edittable`); }
function dataRows(tbl){ return [...tbl.querySelectorAll('tbody tr')].filter(tr => !tr.classList.contains('addrow')); }
function cellAt(tr, i){ return tr.children[i].querySelector('input,select'); }

test('Danh sách PO: table lists declared + checkpoint-derived POs, add-row adds a new one, status select closes/reopens it', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("PO_LIST = ['PO-100'];");
    w.showTab('polist');
    await new Promise(r => setTimeout(r, 50));
    const tbl = tableIn(w, 'polist');
    assert.ok(tbl, 'expected an .edittable table in the PO tab');
    assert.equal(dataRows(tbl).length, 1);

    const addRow = tbl.querySelector('tbody tr.addrow');
    cellAt(addRow, 0).value = 'PO-200';
    addRow.querySelector('.rowbtn.add').click();
    await new Promise(r => setTimeout(r, 50));
    assert.ok(w.eval("PO_LIST.includes('PO-200')"), 'add-row must push the new PO code into PO_LIST');
    const stored = await w.idbGet('meta', 'poList');
    assert.ok(stored.value.includes('PO-200'), 'must persist to IndexedDB');

    // Close it via the Trạng thái select (100% fill since there are no checkpoints -> no confirm needed).
    w.confirm = () => true;
    const rows2 = dataRows(tableIn(w, 'polist'));
    const row200 = rows2.find(tr => cellAt(tr, 0).value === 'PO-200');
    const statusSel = cellAt(row200, 1);
    statusSel.value = 'closed';
    statusSel.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval("isPOClosed('PO-200')"), true);

    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('Danh sách Client: add-row adds a Client with highlight, editing highlight persists, row background reflects it', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval('CLIENT_LIST = [];');
    w.showTab('clientlist');
    await new Promise(r => setTimeout(r, 50));
    const tbl = tableIn(w, 'clientlist');

    const addRow = tbl.querySelector('tbody tr.addrow');
    cellAt(addRow, 0).value = 'ACME Corp';
    cellAt(addRow, 1).value = 'Yêu cầu riêng';
    cellAt(addRow, 2).value = 'red';
    addRow.querySelector('.rowbtn.add').click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval('CLIENT_LIST.length'), 1);
    assert.equal(w.eval('CLIENT_LIST[0].highlight'), 'red');

    const rows = dataRows(tableIn(w, 'clientlist'));
    const row = rows[0];
    assert.ok(/background:#FEE2E2/.test(row.getAttribute('style') || ''), 'row background should reflect the red highlight');
    const hlSel = cellAt(row, 2);
    hlSel.value = 'teal';
    hlSel.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval('CLIENT_LIST[0].highlight'), 'teal');
    const stored = await w.idbGet('meta', 'clientList');
    assert.equal(stored.value[0].highlight, 'teal', 'must persist to IndexedDB');

    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});
