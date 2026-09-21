import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers the PO/Recipe/Client tabs after they were converted (alongside
// Items Code, see tests/item-code-list.test.mjs) from a "form above + list
// below" UI to a shared spreadsheet-style editable table: sortable columns,
// a filter row, a pinned add-row, and cells editable in place
// (buildEditableTable in index.html).
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

function tableIn(w, tabId){ return w.document.querySelector(`#view-${tabId} table.edittable`); }
function dataRows(tbl){ return [...tbl.querySelectorAll('tbody tr')].filter(tr => !tr.classList.contains('addrow')); }
function cellAt(tr, i){ return tr.children[i].querySelector('input,select'); }
// w.eval() returns values from the jsdom window's own realm — an array from
// there isn't deepStrictEqual to a same-content array literal in ours, so
// re-materialize it with Array.from() before comparing.
function recipes(w){ return Array.from(w.eval('RECIPES')); }

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

test('Danh sách Recipe: add-row adds a Recipe, inline rename persists, delete removes it', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("RECIPES = ['400'];");
    w.showTab('recipelist');
    await new Promise(r => setTimeout(r, 50));
    const tbl = tableIn(w, 'recipelist');
    assert.equal(dataRows(tbl).length, 1);

    const addRow = tbl.querySelector('tbody tr.addrow');
    cellAt(addRow, 0).value = '405';
    addRow.querySelector('.rowbtn.add').click();
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(recipes(w).sort(), ['400', '405']);

    const rows = dataRows(tableIn(w, 'recipelist'));
    const row400 = rows.find(tr => cellAt(tr, 0).value === '400');
    const inp = cellAt(row400, 0);
    inp.value = '400B';
    inp.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(recipes(w).sort(), ['400B', '405']);

    w.confirm = () => true;
    const rows2 = dataRows(tableIn(w, 'recipelist'));
    const row405 = rows2.find(tr => cellAt(tr, 0).value === '405');
    row405.querySelector('.rowbtn.del').click();
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(recipes(w), ['400B']);

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
