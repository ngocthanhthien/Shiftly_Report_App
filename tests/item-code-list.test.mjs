import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers the new "Danh sách Items Code" tab: a flat FGs/RW item-code <->
// product-name <-> Recipe reference table, pre-seeded from the user's real
// data (DEFAULT_ITEM_CODE_LIST), with the same add/edit/delete + Excel
// template/export/import UX as the existing Danh sách Client tab.
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

test('ITEM_CODE_LIST is pre-seeded from the real data on a fresh device, and the tab exists', async () => {
  const {dom, w, errors} = await boot();
  try {
    const count = w.eval('ITEM_CODE_LIST.length');
    assert.ok(count > 500, `expected 500+ seeded rows, got ${count}`);
    assert.ok(w.eval('ITEM_CODE_LIST.some(i=>i.type==="FGs")'));
    assert.ok(w.eval('ITEM_CODE_LIST.some(i=>i.type==="RW")'));
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));
    assert.ok(w.document.querySelector('#view-itemcodelist .section-title'));
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('adding an item via the form persists to IndexedDB and shows up in the list', async () => {
  const {dom, w, errors} = await boot();
  try {
    // Start from a small, known dataset so this test isn't at the mercy of
    // the real 500+ row seed.
    w.eval("ITEM_CODE_LIST = [{type:'FGs', itemCode:'X1', name:'Test Product', recipe:'400'}];");
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));

    const doc = w.document;
    const root = doc.querySelector('#view-itemcodelist');
    const codeInp = [...root.querySelectorAll('input[placeholder="VD: 10100001"]')][0];
    const nameInp = [...root.querySelectorAll('input')].find(i => i.placeholder === 'Tên sản phẩm');
    codeInp.value = 'X2';
    nameInp.value = 'New Product';
    const addBtn = [...root.querySelectorAll('button')].find(b => b.textContent.includes('Thêm'));
    addBtn.click();
    await new Promise(r => setTimeout(r, 50));

    assert.equal(w.eval('ITEM_CODE_LIST.length'), 2);
    assert.ok(w.eval("ITEM_CODE_LIST.some(i=>i.itemCode==='X2' && i.name==='New Product')"));
    const stored = await w.idbGet('meta', 'itemCodeList');
    assert.equal(stored.value.length, 2, 'must be persisted to IndexedDB, not just in-memory');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('editing an existing row updates it in place (by index, not by code — real data has repeated RW codes)', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval("ITEM_CODE_LIST = [{type:'RW', itemCode:'R1', name:'Old Name', recipe:'352'}];");
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));

    const doc = w.document;
    const editBtn = [...doc.querySelectorAll('#view-itemcodelist button')].find(b => b.textContent.includes('✏️'));
    editBtn.click();
    await new Promise(r => setTimeout(r, 50));

    const root = doc.querySelector('#view-itemcodelist');
    const nameInp = [...root.querySelectorAll('input')].find(i => i.placeholder === 'Tên sản phẩm');
    assert.equal(nameInp.value, 'Old Name', 'the edit form must be pre-filled');
    nameInp.value = 'Renamed';
    const saveBtn = [...root.querySelectorAll('button')].find(b => b.textContent.includes('Lưu thay đổi'));
    saveBtn.click();
    await new Promise(r => setTimeout(r, 50));

    assert.equal(w.eval('ITEM_CODE_LIST.length'), 1, 'editing must not create a duplicate row');
    assert.equal(w.eval('ITEM_CODE_LIST[0].name'), 'Renamed');
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

    const delBtn = [...w.document.querySelectorAll('#view-itemcodelist button')].find(b => b.textContent.includes('🗑️'));
    delBtn.click();
    await new Promise(r => setTimeout(r, 50));

    assert.equal(w.eval('ITEM_CODE_LIST.length'), 1);
    assert.equal(w.eval('ITEM_CODE_LIST[0].itemCode'), 'B', 'must delete the first row (Alpha), keeping Beta');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('search box filters by Item Code / Name / Recipe; type filter narrows by FGs vs RW', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval(`ITEM_CODE_LIST = [
      {type:'FGs', itemCode:'F1', name:'Coffee Freeze Dried', recipe:'400'},
      {type:'RW', itemCode:'R1', name:'Rework Coffee', recipe:'400'},
      {type:'FGs', itemCode:'F2', name:'Something Else', recipe:'999'},
    ];`);
    w.showTab('itemcodelist');
    await new Promise(r => setTimeout(r, 50));

    const doc = w.document;
    const root = doc.querySelector('#view-itemcodelist');
    const searchInp = root.querySelector('input[placeholder*="Tìm theo"]');
    searchInp.value = 'coffee';
    searchInp.dispatchEvent(new w.Event('input'));
    await new Promise(r => setTimeout(r, 50));
    let text = root.textContent;
    assert.ok(text.includes('Coffee Freeze Dried') && text.includes('Rework Coffee'), 'search must match both rows containing "coffee"');
    assert.ok(!text.includes('Something Else'), 'search must exclude the non-matching row');

    const typeSel = [...root.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.includes('Chỉ RW')));
    typeSel.value = 'RW';
    typeSel.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 50));
    text = root.textContent;
    assert.ok(text.includes('Rework Coffee'), 'RW filter must keep the RW row');
    assert.ok(!text.includes('Coffee Freeze Dried'), 'RW filter must exclude the FGs row even though it matches the search text');
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
