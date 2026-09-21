import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers the new "Danh sách Items Code" tab, rendered as a spreadsheet-style
// editable table (sortable columns, a filter row, a pinned add-row, cells
// editable in place) shared with the PO/Recipe/Client list tabs. Pre-seeded
// from the user's real data (DEFAULT_ITEM_CODE_LIST).
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

function tableRoot(w){ return w.document.querySelector('#view-itemcodelist table.edittable'); }
function dataRows(w){ return [...tableRoot(w).querySelectorAll('tbody tr')].filter(tr => !tr.classList.contains('addrow')); }
function cellInput(tr, colIndex){ return tr.children[colIndex].querySelector('input,select'); }

test('ITEM_CODE_LIST is pre-seeded from the real data on a fresh device, and the tab renders as a table', async () => {
  const {dom, w, errors} = await boot();
  try {
    const count = w.eval('ITEM_CODE_LIST.length');
    assert.ok(count > 500, `expected 500+ seeded rows, got ${count}`);
    assert.ok(w.eval('ITEM_CODE_LIST.some(i=>i.type==="FGs")'));
    assert.ok(w.eval('ITEM_CODE_LIST.some(i=>i.type==="RW")'));
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));
    assert.ok(tableRoot(w), 'expected an .edittable table in the Items Code tab');
    assert.equal(dataRows(w).length, count);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('adding an item via the add-row persists to IndexedDB and shows up in the table', async () => {
  const {dom, w, errors} = await boot();
  try {
    // Start from a small, known dataset so this test isn't at the mercy of
    // the real 500+ row seed.
    w.eval("ITEM_CODE_LIST = [{type:'FGs', itemCode:'X1', name:'Test Product', recipe:'400'}];");
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));

    const addRow = tableRoot(w).querySelector('tbody tr.addrow');
    // Columns: Loại(select), Item Code(text), Tên sản phẩm(text), Recipe(text), actions
    cellInput(addRow, 1).value = 'X2';
    cellInput(addRow, 2).value = 'New Product';
    const addBtn = addRow.querySelector('.rowbtn.add');
    addBtn.click();
    await new Promise(r => setTimeout(r, 50));

    assert.equal(w.eval('ITEM_CODE_LIST.length'), 2);
    assert.ok(w.eval("ITEM_CODE_LIST.some(i=>i.itemCode==='X2' && i.name==='New Product')"));
    const stored = await w.idbGet('meta', 'itemCodeList');
    assert.equal(stored.value.length, 2, 'must be persisted to IndexedDB, not just in-memory');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('editing a cell in place updates the row by index (no separate edit form, no duplication)', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("ITEM_CODE_LIST = [{type:'RW', itemCode:'R1', name:'Old Name', recipe:'352'}];");
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));

    const tr = dataRows(w)[0];
    const nameInp = cellInput(tr, 2);
    assert.equal(nameInp.value, 'Old Name', 'the cell must be pre-filled with the current value');
    nameInp.value = 'Renamed';
    nameInp.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));

    assert.equal(w.eval('ITEM_CODE_LIST.length'), 1, 'editing must not create a duplicate row');
    assert.equal(w.eval('ITEM_CODE_LIST[0].name'), 'Renamed');
    const stored = await w.idbGet('meta', 'itemCodeList');
    assert.equal(stored.value[0].name, 'Renamed', 'edit must persist to IndexedDB');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('deleting a row removes only that row', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("ITEM_CODE_LIST = [{type:'FGs',itemCode:'A',name:'Alpha',recipe:''},{type:'FGs',itemCode:'B',name:'Beta',recipe:''}];");
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));
    w.confirm = () => true;

    const delBtn = dataRows(w)[0].querySelector('.rowbtn.del');
    delBtn.click();
    await new Promise(r => setTimeout(r, 50));

    assert.equal(w.eval('ITEM_CODE_LIST.length'), 1);
    assert.equal(w.eval('ITEM_CODE_LIST[0].itemCode'), 'B', 'must delete the first row (Alpha), keeping Beta');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('column filter row narrows by Item Code / Name / Recipe text and by Loại (multi-select)', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval(`ITEM_CODE_LIST = [
      {type:'FGs', itemCode:'F1', name:'Coffee Freeze Dried', recipe:'400'},
      {type:'RW', itemCode:'R1', name:'Rework Coffee', recipe:'400'},
      {type:'FGs', itemCode:'F2', name:'Something Else', recipe:'999'},
    ];`);
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));

    const filterRow = tableRoot(w).querySelector('thead tr.filterrow');
    // Columns order: Loại, Item Code, Tên sản phẩm, Recipe — editable cells
    // store their value as an input/select .value, not as textContent.
    const names = () => dataRows(w).map(tr => cellInput(tr, 2).value);
    const nameFilterInp = filterRow.children[2].querySelector('input');
    nameFilterInp.value = 'coffee';
    nameFilterInp.dispatchEvent(new w.Event('input'));
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(names().sort(), ['Coffee Freeze Dried', 'Rework Coffee'], 'text filter must match both rows containing "coffee" and exclude the non-matching row');

    // Multi-select filter on Loại: tick only "RW".
    const typeMsf = filterRow.children[0].querySelector('details.msf');
    const rwCheckbox = [...typeMsf.querySelectorAll('.msf-opt')].find(o => o.textContent.includes('RW')).querySelector('input[type=checkbox]');
    rwCheckbox.checked = true;
    rwCheckbox.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(names(), ['Rework Coffee'], 'Loại=RW filter must further narrow to just the RW row, even though the FGs row also matches the text filter');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('clicking a sortable column header sorts the rows, and toggles asc/desc/none', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval(`ITEM_CODE_LIST = [
      {type:'FGs', itemCode:'C', name:'Charlie', recipe:''},
      {type:'FGs', itemCode:'A', name:'Alpha', recipe:''},
      {type:'FGs', itemCode:'B', name:'Beta', recipe:''},
    ];`);
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));

    const itemCodeHeader = [...tableRoot(w).querySelectorAll('thead tr:first-child th')].find(th => th.textContent.includes('Item Code'));
    itemCodeHeader.click();
    await new Promise(r => setTimeout(r, 20));
    let codes = dataRows(w).map(tr => cellInput(tr, 1).value);
    assert.deepEqual(codes, ['A', 'B', 'C'], 'first click must sort ascending');

    itemCodeHeader.click();
    await new Promise(r => setTimeout(r, 20));
    codes = dataRows(w).map(tr => cellInput(tr, 1).value);
    assert.deepEqual(codes, ['C', 'B', 'A'], 'second click must sort descending');

    itemCodeHeader.click();
    await new Promise(r => setTimeout(r, 20));
    codes = dataRows(w).map(tr => cellInput(tr, 1).value);
    assert.deepEqual(codes, ['C', 'A', 'B'], 'third click must clear the sort (back to original order)');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('Excel template/export/import round-trip: exported data can be re-imported without duplicating, template placeholder rows are skipped', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval(`ITEM_CODE_LIST = [
      {type:'FGs', itemCode:'10100001', name:'Freeze Dried Instant Coffee FD 4000 25kg', recipe:'400'},
      {type:'RW', itemCode:'11100010', name:'Rework Freeze Dried Instant Coffee FD 4000 25kg', recipe:'400'},
    ];`);
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));

    // 1. Template download must produce parseable XML with placeholder ("VD:") rows only.
    const templateXml = w.eval('buildTableExcelXml("t",["Loại (FGs/RW)","Item Code","Tên sản phẩm","Recipe"],[["FGs","VD: 10100001","VD: x","VD: 400"]])');
    const templateParsed = w.eval(`parseTableExcelXml(${JSON.stringify(templateXml)})`);
    assert.ok(templateParsed.length >= 2);

    // 2. Export the current 2-row list, wipe it, then drive the REAL file
    // input's change handler with that exported file — must restore both
    // rows with no duplicates, and persist to IndexedDB.
    const exportXml = w.eval(`buildTableExcelXml('Danh sách Items Code', ['Loại (FGs/RW)','Item Code','Tên sản phẩm','Recipe'],
      ITEM_CODE_LIST.map(i=>[i.type, i.itemCode||'', i.name||'', i.recipe||'']))`);
    w.eval('ITEM_CODE_LIST = [];');
    w.showTab('itemcodelist'); // re-render against the now-empty list
    await new Promise(r => setTimeout(r, 50));

    const doc = w.document;
    const fileInput = doc.querySelector('#itemCodeXlsInput');
    const file = new w.File([exportXml], 'export.xls', {type: 'application/vnd.ms-excel'});
    Object.defineProperty(fileInput, 'files', {value: [file], configurable: true});
    fileInput.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 150));

    assert.equal(w.eval('ITEM_CODE_LIST.length'), 2, 'both exported rows must be restored');
    assert.ok(w.eval("ITEM_CODE_LIST.some(i=>i.itemCode==='10100001' && i.type==='FGs')"));
    assert.ok(w.eval("ITEM_CODE_LIST.some(i=>i.itemCode==='11100010' && i.type==='RW')"));
    const stored = await w.idbGet('meta', 'itemCodeList');
    assert.equal(stored.value.length, 2, 'import must persist to IndexedDB');

    // Re-importing the SAME file again must not duplicate (exact type+code+name match is skipped).
    fileInput.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 150));
    assert.equal(w.eval('ITEM_CODE_LIST.length'), 2, 'importing the same file twice must not create duplicates');

    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});
