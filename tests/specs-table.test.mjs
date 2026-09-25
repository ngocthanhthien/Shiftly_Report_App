import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers tab Specs as an editable spreadsheet table — sortable/filterable
// columns, inline edit, a "➕ Thêm chỉ tiêu" popup for adding a new chỉ
// tiêu, and multi-select + password-gated bulk delete (2026-09-21 redesign:
// options/"Lựa chọn" column moved last, the old inline add-row replaced by
// the popup, an extra "Bắt buộc" filter added, higher-contrast styling, and
// — this round — a checkbox column for selecting several chỉ tiêu at once
// and deleting them together behind the same Admin password (APP_PASSWORD)
// used for Force-editing/deleting checkpoint data elsewhere in the app —
// see HANDOFF.md). Recipe overrides (a nested per-Recipe sub-table, only
// meaningful for type "number") stay as a separate expandable panel opened
// via the "🧬 Ghi đè" action button, not inlined into the row itself.
// Recipe is no longer a separately managed list — its autocomplete
// suggestions come from ITEM_CODE_LIST.
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

function sectionCard(doc, name) {
  return [...doc.querySelectorAll('#view-specs .card')].find(c => {
    const h = c.querySelector('.card-h');
    return h && h.textContent.includes(name);
  });
}
// Column 0 in every data row is now the bulk-select checkbox (see the new
// "selectable" table below) — the label textarea starts at index 1.
function dataRows(card) { return [...card.querySelectorAll('table.edittable tbody tr')].filter(tr => !tr.classList.contains('addrow')); }
function rowFor(card, fieldLabel) { return dataRows(card).find(tr => tr.children[1].querySelector('textarea').value.split('\n')[0] === fieldLabel); }
function rowCheckbox(tr) { return tr.children[0].querySelector('input[type=checkbox]'); }
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

    const labelTa = tr.children[1].querySelector('textarea');
    labelTa.value = 'Nhiet do Rang';
    labelTa.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields[0].label"), 'Nhiet do Rang');

    const limitInputs = tr.children[3].querySelectorAll('input');
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
    const typeSel = tr.children[2].querySelector('select');
    typeSel.value = 'boolean';
    typeSel.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));

    const f = w.eval("SCHEMA.find(s=>s.id==='TST').fields[0]");
    assert.equal(f.type, 'boolean');
    assert.equal('hardMin' in f, false, 'switching type away from Số must clear its LSL/LCL/UCL/USL config');

    card = sectionCard(doc, 'Test Section'); // table rebuilt after a type change
    const tr2 = rowFor(card, 'Nhiet do');
    assert.equal(tr2.children[3].textContent.includes('chỉ áp dụng cho Loại Số'), true);
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

    const boolInputs = tr.children[4].querySelectorAll('input');
    assert.equal(boolInputs[0].value, 'OK');
    assert.equal(boolInputs[1].value, 'NG');

    const flagChecks = tr.children[5].querySelectorAll('input[type=checkbox]');
    flagChecks[0].checked = true; // Bắt buộc
    flagChecks[0].dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields[1].required"), true);

    const qmsCb = tr.children[6].querySelector('input[type=checkbox]');
    qmsCb.checked = true;
    qmsCb.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields[1].isQMS"), true);
    const qmsNameInp = tr.children[6].querySelector('input[type=text]');
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
    assert.equal(rows[2].children[1].querySelector('textarea').value, 'Mau sac');

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

    const labelFilter = filterRow.children[1].querySelector('input');
    labelFilter.value = 'nhiet';
    labelFilter.dispatchEvent(new w.Event('input'));
    await new Promise(r => setTimeout(r, 30));
    let labels = dataRows(card).map(tr => tr.children[1].querySelector('textarea').value);
    assert.deepEqual(labels.sort(), ['Nhiet do Rang', 'Nhiet do Say']);

    labelFilter.value = '';
    labelFilter.dispatchEvent(new w.Event('input'));
    const typeMsf = filterRow.children[2].querySelector('details.msf');
    const boolCb = [...typeMsf.querySelectorAll('.msf-opt')].find(o => o.textContent.includes('Đạt/Lỗi')).querySelector('input[type=checkbox]');
    boolCb.checked = true;
    boolCb.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));
    labels = dataRows(card).map(tr => tr.children[1].querySelector('textarea').value);
    assert.deepEqual(labels, ['Kiem tra mau']);
    boolCb.checked = false;
    boolCb.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));

    // "Bắt buộc" filter lives on the flags column (index 5, after the new
    // select-checkbox column at index 0).
    const flagsMsf = filterRow.children[5].querySelector('details.msf');
    const requiredCb = [...flagsMsf.querySelectorAll('.msf-opt')].find(o => o.textContent.includes('Bắt buộc') && !o.textContent.includes('Không')).querySelector('input[type=checkbox]');
    requiredCb.checked = true;
    requiredCb.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 30));
    labels = dataRows(card).map(tr => tr.children[1].querySelector('textarea').value);
    assert.deepEqual(labels, ['Nhiet do Rang']);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('historical/default SCHEMA (real ROA section) still renders correctly as a table; FOAMING and REWORK were both removed entirely', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.showTab('specs');
    const card = sectionCard(doc, 'Rang (ROA)');
    assert.ok(card, 'the real default ROA section must render');
    assert.ok(dataRows(card).length > 0);
    // "Tạo bọt (Foaming)" and "Tái chế (Rework)" were both fully removed
    // from SCHEMA at the user's request — neither must appear in Specs.
    assert.equal(sectionCard(doc, 'Tạo bọt (Foaming)'), undefined, 'FOAMING must no longer render as a Specs section');
    assert.equal(sectionCard(doc, 'Tái chế (Rework)'), undefined, 'REWORK must no longer render as a Specs section');
    assert.equal(w.eval("sectionById('FOAMING')"), undefined);
    assert.equal(w.eval("sectionById('REWORK')"), undefined);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

// ===================== Migration: an ALREADY-PERSISTED SCHEMA (from before
// FOAMING/REWORK were removed) must also get cleaned up, not just fresh
// devices ===== DEFAULT_SCHEMA no longer contains either, but a device that
// already booted before this change has them saved in IndexedDB
// (meta.schema) — and init() prefers that saved SCHEMA over DEFAULT_SCHEMA.
// Both call sites that adopt a SCHEMA value (init() on boot, applyRemoteMeta()
// on a Supabase pull) route through stripRemovedSections(), tested directly here.
function withRemovedSections(sections) {
  return [...sections,
    {id:'FOAMING', name:'Tạo bọt (Foaming)', fields:[{id:'FOAMING_ISSUE', label:'Issue/ Abnormal', type:'textarea'}]},
    {id:'REWORK', name:'Tái chế (Rework)', fields:[{id:'REWORK_ISSUE', label:'Issue/ Abnormal', type:'textarea'}]},
  ];
}
async function bootWithSeededSchema(seedSchemaArr) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const factory = new IDBFactory();
  // Pre-seed the EXACT database the app itself opens (mirrors idbOpen() in
  // index.html: name 'shiftly_db', version 4, stores shifts/meta/logs/outbox)
  // so init() sees this schema as ALREADY PERSISTED — the same code path a
  // real pre-existing device hits, not the fresh-empty-IndexedDB path every
  // other test in this repo exercises.
  await new Promise((resolve, reject) => {
    const req = factory.open('shiftly_db', 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      const shiftsStore = db.createObjectStore('shifts', {keyPath: 'key'});
      shiftsStore.createIndex('by_date', 'date');
      shiftsStore.createIndex('by_po', 'po');
      db.createObjectStore('meta', {keyPath: 'k'});
      db.createObjectStore('logs', {keyPath: 'id', autoIncrement: true});
      db.createObjectStore('outbox', {keyPath: 'id', autoIncrement: true});
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({k: 'schema', value: seedSchemaArr});
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });

  const dom = new JSDOM(html, {
    url: 'https://shiftly-report-app.example.workers.dev',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.indexedDB = factory;
      w.fetch = async () => { throw new Error('network disabled in test'); };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.eval('typeof DB !== "undefined" && DB !== null'); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 80)); // let the async init()/saveSchema() migration settle
  return {dom, w, errors};
}

test('stripRemovedSections(): drops FOAMING and REWORK together and returns the SAME array reference when nothing needed removing', async () => {
  const {dom, w, errors} = await boot();
  try {
    const withBoth = w.eval(`(() => { const s = sectionById('ROA'); return [s, {id:'FOAMING', name:'Tạo bọt (Foaming)', fields:[]}, {id:'REWORK', name:'Tái chế (Rework)', fields:[]}]; })()`);
    const ids = JSON.parse(w.eval(`JSON.stringify(stripRemovedSections(${JSON.stringify(withBoth)}).map(s=>s.id))`));
    assert.deepEqual(ids, ['ROA'], 'both removed ids must be dropped in 1 pass, unrelated sections untouched');
    // Neither present -> must return the exact same array object (used by
    // both call sites to decide whether a re-save/re-sync is needed).
    const unchanged = w.eval(`(() => { const arr = [sectionById('ROA')]; return stripRemovedSections(arr) === arr; })()`);
    assert.equal(unchanged, true);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('init(): a SCHEMA already persisted in IndexedDB from BEFORE the removal (still containing FOAMING and REWORK) gets cleaned up on boot, not just fresh devices', async () => {
  const seed = withRemovedSections([{id: 'ROA', name: 'Rang (ROA)', fields: [{id: 'ROA_TEST', label: 'Test field', type: 'number'}]}]);
  const {dom, w, errors} = await bootWithSeededSchema(seed);
  try {
    const doc = w.document;
    const ids = w.eval('SCHEMA.map(s=>s.id)');
    assert.ok(!ids.includes('FOAMING'), 'FOAMING must be stripped from an already-persisted SCHEMA at boot, not just DEFAULT_SCHEMA');
    assert.ok(!ids.includes('REWORK'), 'REWORK must be stripped too, in the same pass');
    assert.ok(ids.includes('ROA'), 'the rest of the persisted SCHEMA (ROA) must survive untouched');

    w.showTab('specs');
    assert.equal(sectionCard(doc, 'Tạo bọt (Foaming)'), undefined, 'Specs must not show FOAMING even on a device that had it persisted before');
    assert.equal(sectionCard(doc, 'Tái chế (Rework)'), undefined, 'Specs must not show REWORK even on a device that had it persisted before');

    // The cleanup must have been WRITTEN BACK to IndexedDB (not just held in
    // memory) so it stays gone across reloads, not reappear on next boot.
    const persisted = JSON.parse(await w.eval(`idbGet('meta','schema').then(r=>JSON.stringify(r.value.map(s=>s.id)))`));
    assert.ok(!persisted.includes('FOAMING') && !persisted.includes('REWORK'), 'the cleaned SCHEMA must be persisted back to IndexedDB, not just in-memory');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('applyRemoteMeta(\'schema\', ...): a schema pulled from Supabase that still contains FOAMING/REWORK (from a not-yet-updated device) gets cleaned on arrival', async () => {
  const {dom, w, errors} = await boot();
  try {
    const incoming = w.eval(`(() => { const s = sectionById('EXT'); return [s, {id:'FOAMING', name:'Tạo bọt (Foaming)', fields:[]}, {id:'REWORK', name:'Tái chế (Rework)', fields:[]}]; })()`);
    w.eval(`applyRemoteMeta('schema', ${JSON.stringify(incoming)})`);
    const ids = w.eval('SCHEMA.map(s=>s.id)');
    assert.ok(!ids.includes('FOAMING'), 'a remotely-synced schema still carrying FOAMING must be cleaned on arrival');
    assert.ok(!ids.includes('REWORK'), 'REWORK must be cleaned too');
    assert.ok(ids.includes('EXT'));
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
    const qmsChecks = [...card.querySelectorAll('table.edittable tbody tr:not(.addrow)')].map(tr => tr.children[6].querySelector('input[type=checkbox]'));
    assert.ok(qmsChecks.every(cb => cb.checked === false), 'every QMS checkbox in the Specs table must render unchecked by default');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('bulk select + delete: checking several rows shows a "Xoá N mục đã chọn" bar; deleting requires confirm() then the Admin password (1234)', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(`SCHEMA = [
      {id:'TST', name:'Test Section', fields: [
        {id:'TST_A', label:'Nhiet do', type:'number'},
        {id:'TST_B', label:'Kiem tra mau', type:'boolean'},
        {id:'TST_C', label:'Ap suat', type:'number'},
      ]},
    ];`);
    w.showTab('specs');
    let card = sectionCard(doc, 'Test Section');

    // No selection toolbar until at least 1 row is checked.
    assert.equal(card.querySelector('.seltoolbar').style.display, 'none');

    rowCheckbox(rowFor(card, 'Nhiet do')).click();
    rowCheckbox(rowFor(card, 'Ap suat')).click();
    const bar = card.querySelector('.seltoolbar');
    assert.equal(bar.style.display, 'flex');
    assert.ok(bar.textContent.includes('2'), 'toolbar must show the selected count');
    const bulkDelBtn = [...bar.querySelectorAll('button')].find(b => b.textContent.includes('Xoá'));
    assert.ok(bulkDelBtn, 'expected a bulk-delete button once rows are selected');

    // Cancelling the plain confirm() must not touch SCHEMA or prompt for a password.
    let promptCalled = false;
    w.confirm = () => false;
    w.prompt = () => { promptCalled = true; return '1234'; };
    bulkDelBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(promptCalled, false, 'must not even ask for the password if the confirm() step is cancelled');
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields.length"), 3);

    // Confirmed, but wrong password -> still nothing deleted.
    w.confirm = () => true;
    w.prompt = () => 'wrong';
    bulkDelBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(w.eval("SCHEMA.find(s=>s.id==='TST').fields.length"), 3, 'a wrong Admin password must not delete anything');

    // Confirmed + correct password (1234) -> both selected rows are deleted.
    w.prompt = (msg) => { assert.ok(/mật khẩu/i.test(msg)); return '1234'; };
    bulkDelBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(evalJson(w, "SCHEMA.find(s=>s.id==='TST').fields.map(f=>f.label)"), ['Kiem tra mau']);

    // Selection must be cleared after a successful bulk delete.
    card = sectionCard(doc, 'Test Section');
    assert.equal(card.querySelector('.seltoolbar').style.display, 'none');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('bulk select: the header "select all" checkbox only selects the currently filtered rows', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(`SCHEMA = [
      {id:'TST', name:'Test Section', fields: [
        {id:'TST_A', label:'Nhiet do Rang', type:'number'},
        {id:'TST_B', label:'Kiem tra mau', type:'boolean'},
        {id:'TST_C', label:'Nhiet do Say', type:'number'},
      ]},
    ];`);
    w.showTab('specs');
    const card = sectionCard(doc, 'Test Section');
    const filterRow = card.querySelector('thead tr.filterrow');
    const labelFilter = filterRow.children[1].querySelector('input');
    labelFilter.value = 'nhiet';
    labelFilter.dispatchEvent(new w.Event('input'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(dataRows(card).length, 2, 'filter must narrow to the 2 "nhiet" rows first');

    const selectAllCb = card.querySelector('thead tr:first-child th input[type=checkbox]');
    selectAllCb.click();
    await new Promise(r => setTimeout(r, 30));
    const bar = card.querySelector('.seltoolbar');
    assert.ok(bar.textContent.includes('2'), '"select all" while filtered must only select the 2 visible rows, not all 3');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});
