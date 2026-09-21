import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers tab Specs as an editable spreadsheet table — sortable/filterable
// columns, inline edit, and a "➕ Thêm chỉ tiêu" popup for adding a new chỉ
// tiêu (2026-09-21 redesign: options/"Lựa chọn" column moved last, the old
// inline add-row replaced by the popup, an extra "Bắt buộc" filter added,
// and higher-contrast styling — see HANDOFF.md). Recipe overrides (a nested
// per-Recipe sub-table, only meaningful for type "number") stay as a
// separate expandable panel opened via the "🧬 Ghi đè" action button, not
// inlined into the row itself. Recipe is no longer a separately managed
// list — its autocomplete suggestions come from ITEM_CODE_LIST.
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

function sectionCard(doc, name) {
  return [...doc.querySelectorAll('#view-specs .card')].find(c => {
    const h = c.querySelector('.card-h');
    return h && h.textContent.includes(name);
  });
}
function dataRows(card) { return [...card.querySelectorAll('table.edittable tbody tr')].filter(tr => !tr.classList.contains('addrow')); }
function rowFor(card, fieldLabel) { return dataRows(card).find(tr => tr.children[0].querySelector('textarea').value.split('\n')[0] === fieldLabel); }
function addSpecBtn(card) { return [...card.querySelector('.card-h').querySelectorAll('button')].find(b => b.textContent.includes('Thêm chỉ tiêu')); }
function openModalFor(doc, card) { addSpecBtn(card).click(); return doc.querySelector('.modal-backdrop'); }
function modalSubmitBtn(modal) { return [...modal.querySelectorAll('button')].find(b => b.classList.contains('teal') && b.textContent.includes('Thêm chỉ tiêu')); }
// w.eval(...) returns arrays/objects constructed in the jsdom window's own
// realm — deepEqual (strict) treats those as unequal to a same-shaped Node
// realm value even when every element matches, so round-trip through JSON.
function evalJson(w, expr) { return JSON.parse(w.eval(`JSON.stringify(${expr})`)); }

const TEST_SCHEMA = `SCHEMA = [
  {id:'TST', name:'Test Section', fields: [
    {id:'TST_A', label:'Nhiet do', type:'number', hardMin:10, tMin:12, tMax:18, hardMax:20, required:true},
    {id:'TST_B', label:'Kiem tra ngoai quan', type:'boolean', trueLabel:'OK', falseLabel:'NG'},
  ]},
];`;

test('Specs tab renders each Công đoạn as a sortable/filterable editable table, with "Lựa chọn" as the last data column', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(TEST_SCHEMA);
    w.showTab('specs');
    const card = sectionCard(doc, 'Test Section');
    assert.ok(card, 'expected a card for the Test Section');
    assert.ok(card.querySelector('table.specs-table.edittable'), 'expected an .edittable table with the specs-table styling hook');
    assert.equal(dataRows(card).length, 2);
    const headers = [...card.querySelectorAll('thead tr:first-child th')].map(th => th.textContent);
    assert.ok(headers.some(h => h.includes('Tên chỉ tiêu')));
    assert.ok(headers.some(h => h.includes('Loại')));
    const lastDataHeaderIdx = headers.length - 2; // last column is the blank actions header
    assert.ok(headers[lastDataHeaderIdx].includes('Lựa chọn'), 'Lựa chọn (Danh sách) must be the last data column');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('inline edit: renaming a chỉ tiêu, and editing LSL/LCL/UCL/USL, persists to SCHEMA + IndexedDB', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(TEST_SCHEMA);
    w.showTab('specs');
    const card = sectionCard(doc, 'Test Section');
    const tr = rowFor(card, 'Nhiet do');

    const labelTa = tr.children[0].querySelector('textarea');
    labelTa.value = 'Nhiet do Rang';
    labelTa.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields[0].label"), 'Nhiet do Rang');

    const limitInputs = tr.children[2].querySelectorAll('input');
    assert.equal(limitInputs.length, 4, 'LSL/LCL/UCL/USL must be 4 mini inputs for a number field');
    limitInputs[0].value = '9.5'; // LSL
    limitInputs[0].dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields[0].hardMin"), 9.5);

    const stored = await w.idbGet('meta', 'schema');
    const savedField = stored.value.find(s => s.id === 'TST').fields[0];
    assert.equal(savedField.label, 'Nhiet do Rang');
    assert.equal(savedField.hardMin, 9.5);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('changing Loại clears the previous type\'s config (LSL/LCL/UCL/USL) and switches the row to the new type\'s columns', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(TEST_SCHEMA);
    w.showTab('specs');
    let card = sectionCard(doc, 'Test Section');
    const tr = rowFor(card, 'Nhiet do');
    const typeSel = tr.children[1].querySelector('select');
    typeSel.value = 'boolean';
    typeSel.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));

    const f = w.eval("SCHEMA.find(s=>s.id==='TST').fields[0]");
    assert.equal(f.type, 'boolean');
    assert.equal('hardMin' in f, false, 'switching type away from Số must clear its LSL/LCL/UCL/USL config');

    card = sectionCard(doc, 'Test Section'); // table rebuilt after a type change
    const tr2 = rowFor(card, 'Nhiet do');
    assert.equal(tr2.children[2].textContent.includes('chỉ áp dụng cho Loại Số'), true);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('flags (Bắt buộc/Ghi chú) and QMS checkboxes toggle and persist', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(TEST_SCHEMA);
    w.showTab('specs');
    const card = sectionCard(doc, 'Test Section');
    const tr = rowFor(card, 'Kiem tra ngoai quan');

    const boolInputs = tr.children[3].querySelectorAll('input');
    assert.equal(boolInputs[0].value, 'OK');
    assert.equal(boolInputs[1].value, 'NG');

    const flagChecks = tr.children[4].querySelectorAll('input[type=checkbox]');
    flagChecks[0].checked = true; // Bắt buộc
    flagChecks[0].dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields[1].required"), true);

    const qmsCb = tr.children[5].querySelector('input[type=checkbox]');
    qmsCb.checked = true;
    qmsCb.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields[1].isQMS"), true);
    const qmsNameInp = tr.children[5].querySelector('input[type=text]');
    assert.notEqual(qmsNameInp.style.display, 'none', 'QMS column-name input must appear once QMS is checked');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('"➕ Thêm chỉ tiêu" popup adds a new chỉ tiêu (Loại Số with LSL/USL); delete removes it; reorder (▲▼) swaps the underlying field order', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(TEST_SCHEMA);
    w.showTab('specs');
    let card = sectionCard(doc, 'Test Section');

    const modal = openModalFor(doc, card);
    assert.ok(modal, 'expected the "Thêm chỉ tiêu" popup to open');
    modal.querySelector('textarea.inp').value = 'Mau sac';
    // Loại select defaults to 'number' — fill LSL/USL to check the popup
    // captures type-conditional config up front, not just Tên+Loại.
    const numInputs = modal.querySelectorAll('input.inp.num');
    numInputs[0].value = '1'; // LSL
    numInputs[3].value = '9'; // USL
    modalSubmitBtn(modal).click();
    await new Promise(r => setTimeout(r, 30));

    assert.equal(doc.querySelector('.modal-backdrop'), null, 'popup must close after a successful add');
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields.length"), 3);
    const added = w.eval("SCHEMA.find(s=>s.id==='TST').fields[2]");
    assert.equal(added.label, 'Mau sac');
    assert.equal(added.hardMin, 1);
    assert.equal(added.hardMax, 9);

    card = sectionCard(doc, 'Test Section');
    let rows = dataRows(card);
    assert.equal(rows[2].children[0].querySelector('textarea').value, 'Mau sac');

    // Reorder: move "Mau sac" (index 2) up once -> becomes index 1.
    w.confirm = () => true;
    const upBtn = rows[2].querySelectorAll('.rowbtn')[0];
    upBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(evalJson(w, "SCHEMA.find(s=>s.id==='TST').fields.map(f=>f.label)"), ['Nhiet do', 'Mau sac', 'Kiem tra ngoai quan']);

    // Delete "Mau sac".
    card = sectionCard(doc, 'Test Section');
    const target = rowFor(card, 'Mau sac');
    const delBtn = target.querySelector('.rowbtn.del');
    delBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields.length"), 2);
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields.some(f=>f.label==='Mau sac')"), false);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('"➕ Thêm chỉ tiêu" popup: switching Loại to Danh sách reveals the Lựa chọn textarea, and its lines become f.options', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(TEST_SCHEMA);
    w.showTab('specs');
    const card = sectionCard(doc, 'Test Section');
    const modal = openModalFor(doc, card);

    modal.querySelector('textarea.inp').value = 'Loai lo';
    const typeSel = modal.querySelector('select.inp');
    typeSel.value = 'select';
    typeSel.dispatchEvent(new w.Event('change'));
    const optionsBox = modal.querySelector('[data-box=select]');
    assert.notEqual(optionsBox.style.display, 'none', 'Lựa chọn box must appear once Loại = Danh sách');
    const optionsTa = optionsBox.querySelector('textarea');
    optionsTa.value = 'A\nB\nC';
    modalSubmitBtn(modal).click();
    await new Promise(r => setTimeout(r, 30));

    const added = w.eval("SCHEMA.find(s=>s.id==='TST').fields[2]");
    assert.equal(added.type, 'select');
    assert.deepEqual(evalJson(w, "SCHEMA.find(s=>s.id==='TST').fields[2].options"), ['A', 'B', 'C']);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('Recipe override panel: "🧬 Ghi đè" toggles an editor below the table, only for type Số; adding a row persists recipeOverrides (Recipe suggestions come from Item Code Master)', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(TEST_SCHEMA);
    w.eval("ITEM_CODE_LIST = [{itemCode:'X1', name:'Foo', recipe:'400'}, {itemCode:'X2', name:'Bar', recipe:'452'}];");
    w.showTab('specs');
    let card = sectionCard(doc, 'Test Section');

    // Not applicable for the boolean field.
    const boolRow = rowFor(card, 'Kiem tra ngoai quan');
    const boolOvBtn = [...boolRow.querySelectorAll('.rowbtn')].find(b => b.textContent.includes('Ghi đè'));
    boolOvBtn.click();
    assert.equal(card.parentElement.querySelector('.overriderow'), null, 'no override editor must open for a non-number field');

    const numRow = rowFor(card, 'Nhiet do');
    const numOvBtn = [...numRow.querySelectorAll('.rowbtn')].find(b => b.textContent.includes('Ghi đè'));
    numOvBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.ok(doc.querySelector('#view-specs').textContent.includes('Ghi đè theo Recipe — Nhiet do'), 'override panel must open for the Số field');

    const addOvBtn = [...doc.querySelectorAll('#view-specs button')].find(b => b.textContent.includes('Thêm ghi đè theo Recipe'));
    addOvBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("Object.keys(SCHEMA.find(s=>s.id==='TST').fields[0].recipeOverrides||{}).length"), 1);
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields[0].recipeOverrides['400']!==undefined"), true, 'the first suggested Recipe (from ITEM_CODE_LIST) must be used as the new row\'s default');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('filter by Loại (multi-select), by Bắt buộc, and text-filter by Tên chỉ tiêu narrow the table', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(`SCHEMA = [
      {id:'TST', name:'Test Section', fields: [
        {id:'TST_A', label:'Nhiet do Rang', type:'number', required:true},
        {id:'TST_B', label:'Kiem tra mau', type:'boolean'},
        {id:'TST_C', label:'Nhiet do Say', type:'number'},
      ]},
    ];`);
    w.showTab('specs');
    const card = sectionCard(doc, 'Test Section');
    const filterRow = card.querySelector('thead tr.filterrow');

    const labelFilter = filterRow.children[0].querySelector('input');
    labelFilter.value = 'nhiet';
    labelFilter.dispatchEvent(new w.Event('input'));
    await new Promise(r => setTimeout(r, 30));
    let labels = dataRows(card).map(tr => tr.children[0].querySelector('textarea').value);
    assert.deepEqual(labels.sort(), ['Nhiet do Rang', 'Nhiet do Say']);

    labelFilter.value = '';
    labelFilter.dispatchEvent(new w.Event('input'));
    const typeMsf = filterRow.children[1].querySelector('details.msf');
    const boolCb = [...typeMsf.querySelectorAll('.msf-opt')].find(o => o.textContent.includes('Đạt/Lỗi')).querySelector('input[type=checkbox]');
    boolCb.checked = true;
    boolCb.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));
    labels = dataRows(card).map(tr => tr.children[0].querySelector('textarea').value);
    assert.deepEqual(labels, ['Kiem tra mau']);
    boolCb.checked = false;
    boolCb.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));

    // "Bắt buộc" filter lives on the flags column (index 4).
    const flagsMsf = filterRow.children[4].querySelector('details.msf');
    const requiredCb = [...flagsMsf.querySelectorAll('.msf-opt')].find(o => o.textContent.includes('Bắt buộc') && !o.textContent.includes('Không')).querySelector('input[type=checkbox]');
    requiredCb.checked = true;
    requiredCb.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));
    labels = dataRows(card).map(tr => tr.children[0].querySelector('textarea').value);
    assert.deepEqual(labels, ['Nhiet do Rang']);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('historical/default SCHEMA (real ROA/FOAMING/REWORK sections) still renders correctly as tables', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.showTab('specs');
    const card = sectionCard(doc, 'Rang (ROA)');
    assert.ok(card, 'the real default ROA section must render');
    assert.ok(dataRows(card).length > 0);
    const foamingCard = sectionCard(doc, 'Tạo bọt (Foaming)');
    assert.ok(foamingCard, 'historical FOAMING section must still be manageable in Specs');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('"Hiển thị trong báo cáo QMS" defaults to unchecked for every chỉ tiêu on a fresh device (isQMS auto-seeding removed)', async () => {
  const {dom, w, errors} = await boot();
  try {
    const anyQms = w.eval('SCHEMA.some(s=>s.fields.some(f=>f.isQMS))');
    assert.equal(anyQms, false, 'no field should come pre-checked for QMS export on a brand-new device');

    const doc = w.document;
    w.showTab('specs');
    const card = sectionCard(doc, 'Rang (ROA)');
    const qmsChecks = [...card.querySelectorAll('table.edittable tbody tr:not(.addrow)')].map(tr => tr.children[5].querySelector('input[type=checkbox]'));
    assert.ok(qmsChecks.every(cb => cb.checked === false), 'every QMS checkbox in the Specs table must render unchecked by default');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});
