import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers the 11-requirement Input Form rework (Date/Shift/QC/Process/Item
// Code/Item Name/Recipe/PO/Checkpoint/Issue-Action/Save — see HANDOFF.md):
// getProductionDate() cutoff, blank-by-default Shift/QC/Process with hard
// validation, strict Item Code (8-digit + Item Code Master lookup) and PO
// (9-digit or SHUTDOWN) validation, paired Issue/Action rows, and backward
// compatibility with historical FOAMING/REWORK checkpoints and their legacy
// single "<Section>_ISSUE"/"_ACTION" fields.
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

function withFixedClock(w, y, m, d, hh, mm) {
  w.eval(`
    window.__RealDate = Date;
    Date = class extends window.__RealDate {
      constructor(...args) {
        if (args.length === 0) super(${y}, ${m}, ${d}, ${hh}, ${mm});
        else super(...args);
      }
    };
  `);
}
function restoreClock(w) {
  w.eval('Date = window.__RealDate; delete window.__RealDate;');
}
// w.eval(...) returns objects constructed in the jsdom window's own realm —
// deepEqual (strict) treats those as unequal to a same-shaped Node-realm
// object even when every field matches, so round-trip through JSON first.
function evalJson(w, expr) { return JSON.parse(w.eval(`JSON.stringify(${expr})`)); }

// ---- getProductionDate() cutoff (Requirement #1) ----
test('getProductionDate(): 05:59 -> ngày hôm trước; 06:00/14:00/23:59 -> ngày hôm nay', async () => {
  const {dom, w, errors} = await boot();
  try {
    withFixedClock(w, 2026, 8, 21, 5, 59); // month 8 = September (0-indexed)
    assert.equal(w.eval('getProductionDate()'), '2026-09-20');
    restoreClock(w);

    withFixedClock(w, 2026, 8, 21, 6, 0);
    assert.equal(w.eval('getProductionDate()'), '2026-09-21');
    restoreClock(w);

    withFixedClock(w, 2026, 8, 21, 14, 0);
    assert.equal(w.eval('getProductionDate()'), '2026-09-21');
    restoreClock(w);

    withFixedClock(w, 2026, 8, 21, 23, 59);
    assert.equal(w.eval('getProductionDate()'), '2026-09-21');
    restoreClock(w);

    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

// ---- lookupItemByCode() (Requirements #8/#9) ----
test('lookupItemByCode: not_found, ok, ambiguous (conflicting duplicates), missing_recipe', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval(`ITEM_CODE_LIST = [
      {type:'FGs', itemCode:'11000011', name:'Freeze Dried Instant Coffee Prima 02', recipe:'452'},
      {type:'FGs', itemCode:'11000011', name:'Freeze Dried Instant Coffee Prima 02', recipe:'452'},
      {type:'FGs', itemCode:'22000022', name:'Product A', recipe:'400'},
      {type:'RW', itemCode:'22000022', name:'Product B (Rework)', recipe:'400C'},
      {type:'FGs', itemCode:'33000033', name:'No Recipe Yet', recipe:''},
    ];`);
    assert.deepEqual(evalJson(w, "lookupItemByCode('99999999')"), {status:'not_found'});
    assert.deepEqual(evalJson(w, "lookupItemByCode('')"), {status:'not_found'});
    // Exact duplicate rows (same name+recipe) must NOT be treated as ambiguous.
    assert.deepEqual(evalJson(w, "lookupItemByCode('11000011')"), {status:'ok', name:'Freeze Dried Instant Coffee Prima 02', recipe:'452'});
    // Same Item Code, genuinely different name/recipe -> ambiguous, must block.
    const ambiguous = evalJson(w, "lookupItemByCode('22000022')");
    assert.equal(ambiguous.status, 'ambiguous');
    // Recipe blank in the master -> distinct failure mode.
    assert.equal(w.eval("lookupItemByCode('33000033').status"), 'missing_recipe');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

// ---- Issue/Action legacy adapter (Requirement #10/#14) ----
test('getIssueActionPairs/syncIssueActionToLegacyFields: new format round-trips, legacy single-field checkpoints still read correctly', async () => {
  const {dom, w, errors} = await boot();
  try {
    const secRoa = w.eval("sectionById('ROA')");
    // New-format checkpoint (has the pairs array already).
    w.eval(`window.__newCp = {fields: {[ISSUE_PAIRS_KEY]: [{issue:'Nhiệt độ cao', action:'Dừng và kiểm tra'}]}};`);
    assert.deepEqual(evalJson(w, `getIssueActionPairs(window.__newCp, sectionById('ROA'))`), [{issue:'Nhiệt độ cao', action:'Dừng và kiểm tra'}]);

    // Legacy checkpoint: only ROA_ISSUE populated (no ROA_ACTION field exists by default).
    w.eval(`window.__legacyCp = {fields: {ROA_ISSUE:'Máy rung bất thường'}};`);
    assert.deepEqual(evalJson(w, `getIssueActionPairs(window.__legacyCp, sectionById('ROA'))`), [{issue:'Máy rung bất thường', action:''}]);

    // Saving multiple pairs must join them back into the legacy ROA_ISSUE field for old export code.
    const cpToSync = w.eval(`({fields: {[ISSUE_PAIRS_KEY]: [{issue:'A', action:'X'},{issue:'B', action:'Y'}]}})`);
    const synced = w.eval(`(function(){ const cp=${JSON.stringify(cpToSync)}; syncIssueActionToLegacyFields(cp, sectionById('ROA')); return cp.fields; })()`);
    assert.equal(synced.ROA_ISSUE, '1. A\n2. B');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

// ---- Full Input Form flow ----
// Item Code is ALSO an autocomplete (.ac-wrap) now, positioned before PO in
// the field order, so ".ac-wrap input" alone is ambiguous — disambiguate by
// placeholder text.
function poInputOf(doc) {
  return [...doc.querySelectorAll('#view-input .ac-wrap input')].find(i => i.placeholder.includes('SHUTDOWN'));
}
function itemCodeInputOf(doc) {
  return [...doc.querySelectorAll('#view-input .ac-wrap input')].find(i => i.placeholder === 'VD: 11000011');
}

function driveToNewCheckpointForm(doc, w, {shift='1', process='ROA', po}={}) {
  w.showTab('input');
  const shiftSel = doc.querySelector('#hdrShift');
  shiftSel.value = shift;
  shiftSel.dispatchEvent(new w.Event('change'));
  const addBtn = [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Thêm điểm kiểm tra'));
  addBtn.click();
  const secSel = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.value === process));
  secSel.value = process;
  secSel.dispatchEvent(new w.Event('change'));
  if (po !== undefined) {
    const poInput = poInputOf(doc);
    poInput.value = po;
    poInput.dispatchEvent(new w.Event('blur'));
  }
}

test('Item Code field offers a searchable dropdown of codes already in the Item Code Master', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(`ITEM_CODE_LIST = [
      {type:'FGs', itemCode:'11000011', name:'Test Product', recipe:'452'},
      {type:'RW', itemCode:'22000022', name:'Other Product', recipe:'400'},
    ];`);
    driveToNewCheckpointForm(doc, w, {po: '712600444'});
    await new Promise(r => setTimeout(r, 50));

    const itemCodeInp = itemCodeInputOf(doc);
    assert.ok(itemCodeInp, 'Item Code input exists');
    // Focusing/typing must surface matching known codes as clickable suggestions,
    // same widget/mechanism as the existing PO field.
    itemCodeInp.dispatchEvent(new w.Event('focus'));
    itemCodeInp.value = '11';
    itemCodeInp.dispatchEvent(new w.Event('input'));
    const suggestions = [...itemCodeInp.parentElement.querySelectorAll('.ac-item')].map(n => n.textContent);
    assert.deepEqual(suggestions, ['11000011'], 'only the matching known code must be suggested, not the unrelated 22000022');

    // Picking the suggestion must fill the input and trigger the lookup (Item Name/Recipe).
    const item = itemCodeInp.parentElement.querySelector('.ac-item');
    item.dispatchEvent(new w.MouseEvent('mousedown'));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(itemCodeInputOf(doc).value, '11000011');
    assert.equal(doc.querySelector('#view-input input[readonly]').value, 'Test Product');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('Process select for a NEW checkpoint only offers ROA/EXT/EVA/FD/FP — no FOAMING/REWORK/META', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.showTab('input');
    const shiftSel = doc.querySelector('#hdrShift');
    shiftSel.value = '1';
    shiftSel.dispatchEvent(new w.Event('change'));
    const addBtn = [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Thêm điểm kiểm tra'));
    addBtn.click();
    const secSel = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.value === 'ROA'));
    const values = [...secSel.options].map(o => o.value).filter(Boolean);
    assert.deepEqual(values, ['ROA', 'EXT', 'EVA', 'FD', 'FP']);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('Save is blocked with a clear message when QC, Item Code, or PO are invalid — nothing is persisted', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(`ITEM_CODE_LIST = [{type:'FGs', itemCode:'11000011', name:'Test Product', recipe:'452'}];`);
    driveToNewCheckpointForm(doc, w, {po: '712600111'});
    await new Promise(r => setTimeout(r, 50));

    const findBtn = () => [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Lưu điểm kiểm tra'));
    const toastText = () => doc.querySelector('#toast').textContent;
    const itemCodeInp = () => doc.querySelector('#view-input input[placeholder="VD: 11000011"]');

    // QC blank -> blocked.
    findBtn().click();
    assert.match(toastText(), /QC/);
    assert.equal(w.eval('allCheckpoints.length'), 0, 'must not save with QC blank');

    // Pick QC, leave Item Code blank -> blocked on Item Code.
    const qcSelect = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Chọn QC')));
    qcSelect.value = [...qcSelect.options].find(o => o.value).value;
    qcSelect.dispatchEvent(new w.Event('change'));
    [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Lưu điểm kiểm tra')).click();
    assert.match(toastText(), /Item Code.*8 chữ số/);

    // Item Code with 7 digits -> still blocked (wrong length).
    itemCodeInp().value = '1234567';
    itemCodeInp().dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));
    findBtn().click();
    assert.match(toastText(), /8 chữ số/);

    // Item Code with letters -> blocked.
    itemCodeInp().value = 'ABCDEFGH';
    itemCodeInp().dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));
    findBtn().click();
    assert.match(toastText(), /8 chữ số/);

    // Valid 8-digit format but NOT in Item Code Master -> blocked.
    itemCodeInp().value = '99999999';
    itemCodeInp().dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));
    findBtn().click();
    assert.match(toastText(), /không tồn tại|Master/i);

    // Valid + found -> Item Code no longer blocks; now PO becomes the failure.
    itemCodeInp().value = '11000011';
    itemCodeInp().dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));
    // Clear the PO to trigger the "blank PO" message specifically.
    const poInput = poInputOf(doc);
    poInput.value = '';
    poInput.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 200));
    // Blank PO on a NEW checkpoint re-shows the "nhập PO" gate instead of a Save button.
    assert.ok(doc.querySelector('#view-input').textContent.includes('Nhập/chọn mã PO'));

    poInput.value = '12345';
    poInput.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 200));
    // An invalid-format PO (not SHUTDOWN, not exactly 9 digits) now blocks
    // the rest of the form — including the Save button — from opening at
    // all, instead of only failing at Save time.
    assert.match(doc.querySelector('#view-input').textContent, /9 chữ số|SHUTDOWN/);
    assert.equal([...doc.querySelectorAll('#view-input button')].some(b => b.textContent.includes('Lưu điểm kiểm tra')), false, 'Save button must not render while the PO format is invalid');

    assert.equal(w.eval('allCheckpoints.length'), 0, 'nothing must have been saved through any of the above attempts');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('PO = SHUTDOWN (any case): Item Code is now OPTIONAL (bypassed) when left blank, but still validated normally if the user does type one', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.confirm = () => true; // the chỉ tiêu grid is left blank on purpose here — accept the existing "còn thiếu chỉ tiêu, vẫn lưu?" soft confirms
    w.eval(`ITEM_CODE_LIST = [{type:'FGs', itemCode:'11000011', name:'Test Product', recipe:'452'}];`);
    driveToNewCheckpointForm(doc, w, {po: 'shutdown'});
    await new Promise(r => setTimeout(r, 50));

    // Label must reflect that Item Code is not required for this PO.
    assert.match(doc.querySelector('#view-input').textContent, /Item Code \(không bắt buộc — PO là SHUTDOWN\)/);

    const qcSelect = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Chọn QC')));
    qcSelect.value = [...qcSelect.options].find(o => o.value).value;
    qcSelect.dispatchEvent(new w.Event('change'));

    // Item Code left BLANK -> must now save fine (bypassed for SHUTDOWN).
    [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Lưu điểm kiểm tra')).click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval('allCheckpoints.length'), 1, 'PO=SHUTDOWN with a blank Item Code must save');
    assert.equal(w.eval('allCheckpoints[0].po'), 'SHUTDOWN', 'lowercase "shutdown" must be normalized to SHUTDOWN');
    assert.equal(w.eval('allCheckpoints[0].itemCode'), '', 'Item Code must be saved empty, not forced/guessed');
    assert.equal(w.eval('allCheckpoints[0].recipe'), '', 'Recipe must be empty too — no Item Code to look it up from');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('PO = SHUTDOWN: if the user DOES type an Item Code anyway, it is still validated (format/lookup) and used for Recipe as normal', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.confirm = () => true;
    w.eval(`ITEM_CODE_LIST = [{type:'FGs', itemCode:'11000011', name:'Test Product', recipe:'452'}];`);
    driveToNewCheckpointForm(doc, w, {shift: '1', process: 'EXT', po: 'SHUTDOWN'});
    await new Promise(r => setTimeout(r, 50));
    const qcSelect = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Chọn QC')));
    qcSelect.value = [...qcSelect.options].find(o => o.value).value;
    qcSelect.dispatchEvent(new w.Event('change'));

    // An invalid Item Code (not in the Master) must still block Save, even though PO=SHUTDOWN.
    const itemCodeInp = () => doc.querySelector('#view-input input[placeholder="VD: 11000011"]');
    itemCodeInp().value = '99999999';
    itemCodeInp().dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));
    [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Lưu điểm kiểm tra')).click();
    assert.match(doc.querySelector('#toast').textContent, /không tồn tại|Master/i, 'typing an unknown Item Code must still be validated normally, not silently accepted');
    assert.equal(w.eval('allCheckpoints.length'), 0);

    // A valid Item Code must save with Recipe auto-filled, same as any other PO.
    itemCodeInp().value = '11000011';
    itemCodeInp().dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));
    [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Lưu điểm kiểm tra')).click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval('allCheckpoints.length'), 1);
    assert.equal(w.eval('allCheckpoints[0].itemCode'), '11000011');
    assert.equal(w.eval('allCheckpoints[0].recipe'), '452', 'Recipe must be auto-filled from the Item Code Master lookup');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('PO gate: an invalid-format PO (not SHUTDOWN, not exactly 9 digits) warns and keeps the rest of the form (chỉ tiêu grid, Save) closed on a NEW checkpoint', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    driveToNewCheckpointForm(doc, w, {po: '71260'}); // only 5 digits
    await new Promise(r => setTimeout(r, 50));

    const bodyText = () => doc.querySelector('#view-input').textContent;
    assert.match(bodyText(), /9 chữ số|SHUTDOWN/, 'must warn inline while the PO is the wrong length');
    assert.doesNotMatch(bodyText(), /Client \(tuỳ chọn\)/, 'the rest of the form (e.g. Client) must not render yet');
    assert.equal([...doc.querySelectorAll('#view-input button')].some(b => b.textContent.includes('Lưu điểm kiểm tra')), false, 'Save button must not render yet');

    // Completing it to exactly 9 digits opens the rest of the form.
    const poInput = poInputOf(doc);
    poInput.value = '712600111';
    poInput.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));
    assert.doesNotMatch(bodyText(), /9 chữ số|SHUTDOWN/);
    assert.ok([...doc.querySelectorAll('#view-input button')].some(b => b.textContent.includes('Lưu điểm kiểm tra')), 'Save button must render once the PO is exactly 9 digits');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('Issue/Action rows: an unused blank row is ignored, but a half-filled row blocks Save with a row-numbered message', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.confirm = () => true; // the chỉ tiêu grid is left blank on purpose here — accept the existing "còn thiếu chỉ tiêu, vẫn lưu?" soft confirms
    w.eval(`ITEM_CODE_LIST = [{type:'FGs', itemCode:'11000011', name:'Test Product', recipe:'452'}];`);
    driveToNewCheckpointForm(doc, w, {po: '712600222'});
    await new Promise(r => setTimeout(r, 50));
    const qcSelect = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Chọn QC')));
    qcSelect.value = [...qcSelect.options].find(o => o.value).value;
    qcSelect.dispatchEvent(new w.Event('change'));
    const itemCodeInp = doc.querySelector('#view-input input[placeholder="VD: 11000011"]');
    itemCodeInp.value = '11000011';
    itemCodeInp.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));

    const saveBtn = () => [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Lưu điểm kiểm tra'));
    const toastText = () => doc.querySelector('#toast').textContent;

    // Leaving the single default row blank entirely must be allowed (unused row).
    saveBtn().click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval('allCheckpoints.length'), 1, 'a fully blank Issue/Action row must not block saving');

    // Re-open: start a fresh add for a different PO with a half-filled row.
    const addBtn = [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Thêm điểm kiểm tra'));
    addBtn.click();
    const secSel = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.value === 'ROA'));
    secSel.value = 'ROA';
    secSel.dispatchEvent(new w.Event('change'));
    const poInput = poInputOf(doc);
    poInput.value = '712600333';
    poInput.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 200));
    const qcSelect2 = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Chọn QC')));
    qcSelect2.value = [...qcSelect2.options].find(o => o.value).value;
    qcSelect2.dispatchEvent(new w.Event('change'));
    const itemCodeInp2 = doc.querySelector('#view-input input[placeholder="VD: 11000011"]');
    itemCodeInp2.value = '11000011';
    itemCodeInp2.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));

    const issueTextareas = [...doc.querySelectorAll('#view-input textarea[placeholder="Issue/ Abnormal"]')];
    issueTextareas[0].value = 'Nhiệt độ cao bất thường';
    // Action left blank on purpose.
    [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Lưu điểm kiểm tra')).click();
    assert.match(toastText(), /dòng #1.*Action/i);
    assert.equal(w.eval('allCheckpoints.length'), 1, 'the half-filled row must block this second save attempt');

    // Fill the Action too -> now it must save, and the pair must be stored.
    const actionTextareas = [...doc.querySelectorAll('#view-input textarea[placeholder="Action"]')];
    actionTextareas[0].value = 'Dừng máy và kiểm tra cảm biến';
    [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Lưu điểm kiểm tra')).click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval('allCheckpoints.length'), 2);
    const savedCp = w.eval("allCheckpoints.find(c=>c.po==='712600333')");
    assert.deepEqual(savedCp.fields[w.eval('ISSUE_PAIRS_KEY')], [{issue:'Nhiệt độ cao bất thường', action:'Dừng máy và kiểm tra cảm biến'}]);
    assert.equal(savedCp.fields.ROA_ISSUE, 'Nhiệt độ cao bất thường', 'must sync back into the legacy ROA_ISSUE field for old export/report code');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('Editing a historical REWORK checkpoint still works: Process shown read-only, historical data intact', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    const cp = w.eval(`(function(){
      const cp = blankCheckpoint('2026-01-05','2','REWORK','712600555','Trân');
      cp.fields['REWORK_ISSUE'] = 'Bọt không ổn định (dữ liệu lịch sử)';
      return cp;
    })()`);
    await w.idbPut('shifts', cp);
    await w.eval('refreshCache()');

    w.renderInputForm._shift = '2';
    w.renderInputForm._editKey = cp.key;
    w.renderInputForm._addOpen = false;
    w.showTab('input');
    w.renderInputForm();

    const root = doc.querySelector('#view-input');
    assert.ok(root.textContent.includes('Tái chế (Rework)'), 'REWORK historical section name must still display correctly');
    // Process must be shown as read-only text, not a restricted dropdown.
    assert.equal([...root.querySelectorAll('select')].some(s => [...s.options].some(o => o.value === 'REWORK')), false);

    const issueTextarea = root.querySelector('textarea[placeholder="Issue/ Abnormal"]');
    assert.equal(issueTextarea.value, 'Bọt không ổn định (dữ liệu lịch sử)', 'legacy REWORK_ISSUE text must be loaded into the new paired-row editor');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

// FOAMING (Tạo bọt) was fully removed from SCHEMA at the user's explicit
// request — it's no longer a valid Công đoạn ANYWHERE, not even for
// historical editing (previously it was excluded only from the NEW-checkpoint
// dropdown, see INPUT_PROCESS_OPTIONS, while still fully defined in SCHEMA
// for legacy edits). A checkpoint saved before this change (section='FOAMING')
// can still exist in IndexedDB/Supabase — opening it for editing must not
// crash (sectionById('FOAMING') now returns undefined); it must show a clear
// message and refuse to render the (now-nonexistent) field grid.
test('Opening a historical FOAMING checkpoint for editing does not crash — shows a clear "no longer supported" message instead of a field grid', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    assert.equal(w.eval("sectionById('FOAMING')"), undefined, 'sanity: FOAMING must no longer exist in SCHEMA at all');
    const cp = w.eval(`(function(){
      const cp = blankCheckpoint('2026-01-05','2','FOAMING','712600555','Trân');
      cp.fields['FOAMING_ISSUE'] = 'Bọt không ổn định (dữ liệu lịch sử)';
      return cp;
    })()`);
    await w.idbPut('shifts', cp);
    await w.eval('refreshCache()');

    w.renderInputForm._shift = '2';
    w.renderInputForm._editKey = cp.key;
    w.renderInputForm._addOpen = false;
    w.showTab('input');
    w.renderInputForm();

    const root = doc.querySelector('#view-input');
    assert.match(root.textContent, /FOAMING.*không còn được hỗ trợ/, 'must show a clear message naming the unsupported section, not crash');
    // The 2 textareas that DO always render here belong to "Bàn giao ca"
    // (metaCard, unrelated to this checkpoint's own Công đoạn) — what must
    // NOT render is the section-specific Issue/Action editor.
    assert.equal(root.querySelectorAll('textarea[placeholder="Issue/ Abnormal"]').length, 0, 'must not attempt to render a field grid for a section with no SCHEMA definition');
    // The underlying checkpoint itself must be untouched (data preserved, not deleted).
    assert.equal(w.eval('allCheckpoints.length'), 1);
    assert.equal(w.eval("allCheckpoints[0].fields.FOAMING_ISSUE"), 'Bọt không ổn định (dữ liệu lịch sử)');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});
