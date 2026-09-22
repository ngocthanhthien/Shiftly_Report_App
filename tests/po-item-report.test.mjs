import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers 3 groups of new requirements layered on top of the existing Input
// Form / Report tab (see HANDOFF.md for the surrounding architecture):
//   1) PO validation historical exception (format check skipped when
//      EDITING a pre-existing checkpoint) + "1 PO = 1 Item Code" (auto-fill
//      + hard block on conflict) — findItemCodeForPO().
//   2) Report tab "Theo ca": independent Date + Ca(1/2/3/Tất cả) controls,
//      "Tất cả" stacking Ca 1 -> 2 -> 3 with per-shift empty placeholders.
//   3) Report tab "Theo PO": PO Production Timeline (header shown once,
//      Process first/last Date+Shift, Issue/Action tied to their own
//      checkpoint) with inline Issue/Action editing that writes back to the
//      SAME checkpoint (no separate Report data store).
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
function evalJson(w, expr) { return JSON.parse(w.eval(`JSON.stringify(${expr})`)); }

// Item Code is ALSO an autocomplete positioned before PO — disambiguate by placeholder.
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
async function fillQcAndItemCode(doc, w, {itemCode='11000011'}={}) {
  const qcSelect = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Chọn QC')));
  qcSelect.value = [...qcSelect.options].find(o => o.value).value;
  qcSelect.dispatchEvent(new w.Event('change'));
  const itemCodeInp = itemCodeInputOf(doc);
  itemCodeInp.value = itemCode;
  itemCodeInp.dispatchEvent(new w.Event('blur'));
  await new Promise(r => setTimeout(r, 50));
}
function saveBtnOf(doc) {
  return [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Lưu điểm kiểm tra'));
}
function toastTextOf(doc) { return doc.querySelector('#toast').textContent; }

// ===================== 1a) findItemCodeForPO() pure-function unit test =====================

test('findItemCodeForPO: finds the Item Code already used by ANY other checkpoint sharing this PO, ignores the excluded key', async () => {
  const {dom, w, errors} = await boot();
  try {
    const cp1 = w.blankCheckpoint('2026-09-19', '1', 'ROA', '712600111', 'QA'); cp1.itemCode = '11000011';
    const cp2 = w.blankCheckpoint('2026-09-19', '1', 'EXT', '712600111', 'QA'); cp2.itemCode = '';
    await w.idbPut('shifts', cp1); await w.idbPut('shifts', cp2);
    await w.refreshCache();
    assert.equal(w.eval("findItemCodeForPO('712600111', null)"), '11000011');
    assert.equal(w.eval(`findItemCodeForPO('712600111', '${cp1.key}')`), '', 'excluding the only checkpoint that has an itemCode must leave no match');
    assert.equal(w.eval("findItemCodeForPO('999999999', null)"), '', 'unknown PO -> no match');
    assert.equal(w.eval("findItemCodeForPO('', null)"), '');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

// ===================== 1b) Input Form: PO format historical exception =====================

test('PO format validation (9 digits / SHUTDOWN) is skipped when EDITING a historical checkpoint, but still enforced for NEW ones', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(`ITEM_CODE_LIST = [{type:'FGs', itemCode:'11000011', name:'Test Product', recipe:'452'}];`);
    // Legacy checkpoint saved before the PO-format rule existed — 4-digit PO.
    const legacyCp = w.eval(`(function(){
      const cp = blankCheckpoint('2026-01-05','2','ROA','7126','Trân');
      cp.itemCode = '11000011';
      return cp;
    })()`);
    await w.idbPut('shifts', legacyCp);
    await w.refreshCache();

    w.renderInputForm._date = '2026-01-05';
    w.renderInputForm._shift = '2';
    w.renderInputForm._editKey = legacyCp.key;
    w.renderInputForm._addOpen = false;
    w.showTab('input');
    w.renderInputForm();

    // PO input still shows the old, invalid-format value — editing it must
    // NOT be blocked by the 9-digit/SHUTDOWN format rule.
    const poInput = poInputOf(doc);
    assert.equal(poInput.value, '7126');
    w.confirm = () => true; // the chỉ tiêu grid is empty on this legacy checkpoint -> accept the existing "còn thiếu chỉ tiêu, vẫn lưu?" soft confirm
    saveBtnOf(doc).click();
    await new Promise(r => setTimeout(r, 50));
    assert.match(toastTextOf(doc), /Đã lưu/, 'editing a historical checkpoint must save despite its PO not matching the new format');
    assert.equal(w.eval('allCheckpoints.length'), 1);
    assert.equal(w.eval('allCheckpoints[0].po'), '7126', 'PO must be preserved as-is, not rejected/altered');

    // A brand-new checkpoint must still be blocked by the same invalid PO format.
    driveToNewCheckpointForm(doc, w, {shift: '1', process: 'EXT', po: '7126'});
    await new Promise(r => setTimeout(r, 50));
    assert.match(doc.querySelector('#view-input').textContent, /9 chữ số|SHUTDOWN/, 'a NEW checkpoint must still be gated by the PO format rule');
    assert.equal(w.eval('allCheckpoints.length'), 1, 'the blocked new-checkpoint attempt must not have saved anything');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

// ===================== 1c) Input Form: 1 PO = 1 Item Code =====================

test('1 PO = 1 Item Code: reusing an existing PO auto-fills its Item Code; saving with a DIFFERENT Item Code for that PO is blocked; matching Item Code saves fine', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.eval(`ITEM_CODE_LIST = [
      {type:'FGs', itemCode:'11000011', name:'Product A', recipe:'452'},
      {type:'FGs', itemCode:'22000022', name:'Product B', recipe:'400'},
    ];`);

    // 1st checkpoint for PO 712600222, Item Code 11000011.
    driveToNewCheckpointForm(doc, w, {shift: '1', process: 'ROA', po: '712600222'});
    await new Promise(r => setTimeout(r, 50));
    await fillQcAndItemCode(doc, w, {itemCode: '11000011'});
    w.confirm = () => true; // chỉ tiêu grid left blank on purpose
    saveBtnOf(doc).click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval('allCheckpoints.length'), 1);

    // 2nd checkpoint, DIFFERENT process, SAME PO -> Item Code must auto-fill to 11000011.
    driveToNewCheckpointForm(doc, w, {shift: '1', process: 'EXT', po: '712600222'});
    await new Promise(r => setTimeout(r, 80));
    assert.equal(itemCodeInputOf(doc).value, '11000011', 'Item Code must auto-fill from the PO already used by another checkpoint');
    assert.match(toastTextOf(doc), /tự điền/, 'must inform the user the Item Code was auto-filled');
    // Also verify Item Name/Recipe (read-only) resolved from the Item Code Master via the auto-filled code.
    const readonlyInputs = [...doc.querySelectorAll('#view-input input[readonly]')];
    assert.ok(readonlyInputs.some(i => i.value === 'Product A'), 'Item Name must resolve automatically after the auto-fill');

    const qcSelect2 = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Chọn QC')));
    qcSelect2.value = [...qcSelect2.options].find(o => o.value).value;
    qcSelect2.dispatchEvent(new w.Event('change'));
    // Save with the AUTO-FILLED (matching) Item Code -> must succeed.
    saveBtnOf(doc).click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval('allCheckpoints.length'), 2, 'saving with the SAME Item Code as the rest of this PO must be allowed');

    // 3rd checkpoint, yet another process, SAME PO, but the user overrides
    // Item Code to a DIFFERENT one -> must be blocked at Save.
    driveToNewCheckpointForm(doc, w, {shift: '1', process: 'EVA', po: '712600222'});
    await new Promise(r => setTimeout(r, 80));
    const itemCodeInp3 = itemCodeInputOf(doc);
    itemCodeInp3.value = '22000022';
    itemCodeInp3.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));
    const qcSelect3 = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Chọn QC')));
    qcSelect3.value = [...qcSelect3.options].find(o => o.value).value;
    qcSelect3.dispatchEvent(new w.Event('change'));
    saveBtnOf(doc).click();
    await new Promise(r => setTimeout(r, 50));
    assert.match(toastTextOf(doc), /đã được lưu với Item Code.*11000011/, 'must warn that this PO was already saved with a different Item Code');
    assert.equal(w.eval('allCheckpoints.length'), 2, 'the conflicting Item Code must NOT be saved');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

// ===================== 2) Report tab "Theo ca": Date + Ca controls, "Tất cả" =====================

test('Báo cáo tab (Theo ca): Ngày và Ca là 2 control độc lập; chọn "Tất cả" hiển thị Ca 1 -> 2 -> 3 phân tách, ca trống hiện "Chưa có dữ liệu"', async () => {
  const {dom, w, errors} = await boot();
  try {
    const cp = w.blankCheckpoint('2026-09-19', '1', 'ROA', '777700001', 'QA');
    cp.fields = { ROA_R6C: 120 };
    await w.idbPut('shifts', cp);
    await w.refreshCache();
    w.showTab('report');
    await new Promise(r => setTimeout(r, 100));

    const doc = w.document;
    const dateInp = doc.querySelector('#view-report input[type="date"]');
    assert.ok(dateInp, 'a standalone Date <input> must exist (no longer a single combined Date+Shift <select>)');
    assert.equal(dateInp.value, '2026-09-19', 'must default to the most recent date that already has data');
    const selects = [...doc.querySelectorAll('#view-report select')];
    // Both the Ca picker and the Process filter have an "ALL" option — the
    // Ca picker is the one with exactly 4 options (Ca 1/2/3/Tất cả).
    const shiftSel = selects.find(s => s.options.length === 4 && [...s.options].some(o => o.value === 'ALL'));
    assert.ok(shiftSel, 'a Ca <select> with exactly 1/2/3/Tất cả options must exist');
    assert.equal(shiftSel.value, '1', 'must default to the shift that already has data');
    assert.ok(doc.querySelector('#view-report').textContent.includes('777700001'), 'default single-shift preview must show existing data');

    shiftSel.value = 'ALL';
    shiftSel.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 100));
    const txt = doc.querySelector('#view-report').textContent;
    assert.ok(txt.includes('CA 1') && txt.includes('CA 2') && txt.includes('CA 3'), '"Tất cả" must show all 3 shift dividers');
    assert.ok(txt.includes('777700001'), 'Ca 1 (which has data) must still show its checkpoint');
    const emptyCount = (txt.match(/Chưa có dữ liệu nào cho ca này/g) || []).length;
    assert.equal(emptyCount, 2, 'Ca 2 và Ca 3 (không có dữ liệu) đều phải hiện trạng thái trống, riêng biệt');
    // Not asserting errors.length===0: renderLinesToSVG() measures text via a
    // <canvas> 2D context, which jsdom can't back without the optional
    // `canvas` npm package (not installed) — a pre-existing, unrelated
    // environment gap (see process-qms-export.test.mjs), not a bug here.
  } finally { dom.window.close(); }
});

// ===================== 3) Report tab "Theo PO": Gantt (Process x Date x Shift) =====================
// Scenario straight out of the prompt's own required test case:
//   ROA: 22/07 Ca1, 22/07 Ca3        EXT: 23/07 Ca1, 23/07 Ca3
//   EVA: 23/07 Ca1, 24/07 Ca1        FD:  23/07 Ca2, 24/07 Ca2
//   FP:  23/07 Ca3, 24/07 Ca2
// Expected CONTINUOUS timeline: 22/07(1,2,3) 23/07(1,2,3) 24/07(1,2) = 8 cols
// (columns 0..7), even though several of those Date+Shift combos have no
// checkpoint at all — the Gantt must still generate them so bars show the
// true run length, not just the data points.
async function seedPOGanttData(w) {
  w.eval(`ITEM_CODE_LIST = [{type:'FGs', itemCode:'12000056', name:'Freeze Dried Instant Coffee FDR2 452', recipe:'452'}];`);
  await w.eval(`(async function(){
    const mk = (date, shift, section) => blankCheckpoint(date, shift, section, '612600069', 'QA');
    const roa1 = mk('2026-07-22','1','ROA'); roa1.itemCode='12000056'; roa1.recipe='452'; roa1.fields={};
    const roa3 = mk('2026-07-22','3','ROA'); roa3.fields={};
    const ext1 = mk('2026-07-23','1','EXT'); ext1.fields={};
    const ext3 = mk('2026-07-23','3','EXT'); ext3.fields={};
    const eva1 = mk('2026-07-23','1','EVA'); eva1.fields={};
    const eva2 = mk('2026-07-24','1','EVA'); eva2.fields={}; eva2.fields[ISSUE_PAIRS_KEY]=[{issue:'Sediment high', action:'Check centrifuge'}];
    const fd2 = mk('2026-07-23','2','FD'); fd2.fields={};
    const fd3 = mk('2026-07-24','2','FD'); fd3.fields={};
    const fp3 = mk('2026-07-23','3','FP'); fp3.fields={};
    const fp4 = mk('2026-07-24','2','FP'); fp4.fields={};
    for (const cp of [roa1,roa3,ext1,ext3,eva1,eva2,fd2,fd3,fp3,fp4]) await idbPut('shifts', cp);
    await refreshCache();
  })()`);
}
function doSearchPO(doc, w, q) {
  const modeBtn = [...doc.querySelectorAll('#view-report button')].find(b => b.textContent.includes('Theo PO'));
  modeBtn.click();
  const poInp = doc.querySelector('#view-report .card input[type="text"]');
  poInp.value = q;
  const findBtn = [...doc.querySelectorAll('#view-report button')].find(b => b.textContent.includes('Tìm & Tạo'));
  findBtn.click();
}
function ganttBarRowInfo(doc, processLabel) {
  const rows = [...doc.querySelectorAll('#view-report .gantt-table tbody tr')];
  const row = rows.find(r => {
    const th = r.querySelector('th.gantt-sticky');
    return th && th.textContent.trim() === processLabel;
  });
  if (!row) return null;
  const dataCells = [...row.children].slice(1); // drop the sticky <th>
  let startIdx = -1, span = 1;
  dataCells.forEach((td, i) => { if (td.classList.contains('gantt-bar-cell')) { startIdx = i; span = parseInt(td.getAttribute('colspan') || '1', 10); } });
  return { startIdx, endIdx: startIdx + span - 1 };
}
function ganttTextRow(doc, processLabel, subLabel) {
  const rows = [...doc.querySelectorAll('#view-report .gantt-table tbody tr')];
  // Rows for 1 process appear in order: bar row (th=label), issue row (th="Issues/Abnormal"), action row (th="Action").
  const barIdx = rows.findIndex(r => { const th = r.querySelector('th.gantt-sticky'); return th && th.textContent.trim() === processLabel; });
  if (barIdx === -1) return null;
  const offset = subLabel === 'Issues/Abnormal' ? 1 : 2;
  return rows[barIdx + offset];
}

test('Báo cáo tab (Theo PO): timeline liên tục Date x Shift, thứ tự Process, và Gantt bar đúng khoảng đầu/cuối như mẫu Excel', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    await seedPOGanttData(w);
    w.showTab('report');
    await new Promise(r => setTimeout(r, 80));
    doSearchPO(doc, w, '612600069');
    await new Promise(r => setTimeout(r, 150));

    const headerTxt = doc.querySelector('#view-report .card').textContent;
    assert.ok(headerTxt.includes('12000056') && headerTxt.includes('Freeze Dried Instant Coffee FDR2 452') && headerTxt.includes('612600069') && headerTxt.includes('452'),
      'header must show ITEM CODE/ITEM NAME/PO/RECIPE');

    // 8 continuous Date+Shift columns (22/07 x3, 23/07 x3, 24/07 x2), not
    // just the 2 data points per process.
    const shiftHeaders = [...doc.querySelectorAll('#view-report .gantt-table thead tr')][1];
    const shiftCells = [...shiftHeaders.children].slice(1);
    assert.deepEqual(shiftCells.map(c => c.textContent.trim()), ['Ca 1','Ca 2','Ca 3','Ca 1','Ca 2','Ca 3','Ca 1','Ca 2']);
    const dateHeaders = [...doc.querySelectorAll('#view-report .gantt-table thead tr')][0];
    const dateCells = [...dateHeaders.children].slice(1);
    assert.deepEqual(dateCells.map(c => ({txt:c.textContent.trim(), span:c.getAttribute('colspan')})),
      [{txt:'22/07/2026', span:'3'}, {txt:'23/07/2026', span:'3'}, {txt:'24/07/2026', span:'2'}]);

    // Process order: only ROA/EXT/EVA/FD/FP have data -> must render, in that order, no FOAMING/REWORK.
    const processLabels = [...doc.querySelectorAll('#view-report .gantt-table tbody th.gantt-sticky')]
      .map(th => th.textContent.trim()).filter(t => t && t !== 'Issues/Abnormal' && t !== 'Action');
    assert.deepEqual(processLabels, ['ROASTING','EXTRACTION','EVAPORATION','FREEZE DRYING','FILLING & PACKING']);

    // Gantt bars: column indices are 0-based across the 8-column timeline above.
    assert.deepEqual(ganttBarRowInfo(doc, 'ROASTING'), {startIdx:0, endIdx:2}, 'ROA: 22/07 Ca1 -> 22/07 Ca3');
    assert.deepEqual(ganttBarRowInfo(doc, 'EXTRACTION'), {startIdx:3, endIdx:5}, 'EXT: 23/07 Ca1 -> 23/07 Ca3');
    assert.deepEqual(ganttBarRowInfo(doc, 'EVAPORATION'), {startIdx:3, endIdx:6}, 'EVA: 23/07 Ca1 -> 24/07 Ca1');
    assert.deepEqual(ganttBarRowInfo(doc, 'FREEZE DRYING'), {startIdx:4, endIdx:7}, 'FD: 23/07 Ca2 -> 24/07 Ca2');
    assert.deepEqual(ganttBarRowInfo(doc, 'FILLING & PACKING'), {startIdx:5, endIdx:7}, 'FP: 23/07 Ca3 -> 24/07 Ca2');

    // Issue/Action must land in EVA's own 24/07 Ca1 column (index 6), not any other column/process.
    const evaIssueRow = ganttTextRow(doc, 'EVAPORATION', 'Issues/Abnormal');
    const evaActionRow = ganttTextRow(doc, 'EVAPORATION', 'Action');
    const evaIssueCells = [...evaIssueRow.children].slice(1);
    const evaActionCells = [...evaActionRow.children].slice(1);
    assert.equal(evaIssueCells[6].textContent.trim(), 'Sediment high');
    assert.equal(evaActionCells[6].textContent.trim(), 'Check centrifuge');
    evaIssueCells.forEach((c,i) => { if (i!==6) assert.equal(c.textContent.trim(), '', `EVA Issues column ${i} must be empty`); });
    const roaIssueRow = ganttTextRow(doc, 'ROASTING', 'Issues/Abnormal');
    assert.ok(![...roaIssueRow.children].some(c => c.textContent.includes('Sediment high')), 'ROA must not show an Issue that belongs to EVA');
    // Not asserting errors.length===0 — renderReport() also draws the SVG
    // export preview underneath the Gantt via buildPOReportSVG, which uses
    // <canvas> for text wrapping (unavailable in jsdom, see note above).
  } finally { dom.window.close(); }
});

test('Báo cáo tab (Theo PO): bấm ô Issue/Action mở modal sửa, ghi NGƯỢC vào checkpoint gốc — Input tab và Data Log đều thấy thay đổi, không tạo bản ghi Report riêng', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    await seedPOGanttData(w);
    w.showTab('report');
    await new Promise(r => setTimeout(r, 80));
    doSearchPO(doc, w, '612600069');
    await new Promise(r => setTimeout(r, 150));

    const evaIssueRow = ganttTextRow(doc, 'EVAPORATION', 'Issues/Abnormal');
    const evaIssueCells = [...evaIssueRow.children].slice(1);
    const cell = evaIssueCells[6]; // 24/07 Ca1, the only EVA checkpoint carrying an Issue/Action
    assert.ok(cell.classList.contains('clickable'), 'a cell backed by a checkpoint must be clickable');
    cell.click();

    const modal = doc.querySelector('.modal-card');
    assert.ok(modal, 'clicking the cell must open the edit modal');
    // The modal opens showing the pair read-only (buildIssueActionEditableList,
    // reused as-is) with its own "✎ Sửa" button — click it to reveal the 2 textareas.
    const innerEditBtn = [...modal.querySelectorAll('button')].find(b => b.textContent.includes('Sửa'));
    assert.ok(innerEditBtn, 'the modal must show the existing "✎ Sửa" control for this pair');
    innerEditBtn.click();
    const textareas = modal.querySelectorAll('textarea');
    assert.equal(textareas.length, 2, 'the modal must open 2 textareas: Issue and Action');
    textareas[0].value = 'Sediment cao bất thường (đã sửa)';
    textareas[1].value = 'Đã kiểm tra ly tâm và điều chỉnh lại';
    const saveBtn = [...modal.querySelectorAll('button')].find(b => b.textContent.includes('Lưu'));
    saveBtn.click();
    await new Promise(r => setTimeout(r, 150));

    // 1) The underlying checkpoint itself was updated (no separate Report record).
    const savedCpJson = evalJson(w, "allCheckpoints.find(c=>c.section==='EVA' && c.po==='612600069' && c.date==='2026-07-24')");
    assert.deepEqual(savedCpJson.fields[w.eval('ISSUE_PAIRS_KEY')], [{issue:'Sediment cao bất thường (đã sửa)', action:'Đã kiểm tra ly tâm và điều chỉnh lại'}]);
    assert.equal(savedCpJson.fields.EVA_ISSUE, 'Sediment cao bất thường (đã sửa)', 'must sync back into the legacy EVA_ISSUE field too');
    const savedKey = savedCpJson.key;

    // 2) The modal closes and the Gantt itself updates immediately (re-drawn via onEdited).
    assert.ok(!doc.querySelector('.modal-card'), 'the modal must close after saving');
    const reportTxtAfter = doc.querySelector('#view-report').textContent;
    assert.ok(reportTxtAfter.includes('Sediment cao bất thường (đã sửa)'), 'Gantt must reflect the edit immediately');

    // 3) Opening the SAME checkpoint from Input tab must show the new text.
    w.renderInputForm._date = '2026-07-24';
    w.renderInputForm._shift = '1';
    w.renderInputForm._editKey = savedKey;
    w.renderInputForm._addOpen = false;
    w.showTab('input');
    w.renderInputForm();
    const issueTa = doc.querySelector('#view-input textarea[placeholder="Issue/ Abnormal"]');
    assert.equal(issueTa.value, 'Sediment cao bất thường (đã sửa)', 'Input tab must show the edit made from the Report tab');

    // 4) Data Log/Audit must have recorded the change.
    const logs = JSON.parse(await w.eval('getAllLogs().then(r=>JSON.stringify(r))'));
    const relevantLogs = logs.filter(l => l.po === '612600069' && l.section === 'Cô đặc (EVA)');
    assert.ok(relevantLogs.length >= 1, 'Data Log must record the Issue/Action edit made from the Report tab');
    assert.ok(relevantLogs.some(l => (l.changes||[]).some(c => /Issue\/Action/.test(c.label))), 'the log entry must reference the Issue/Action change');
    // Not asserting errors.length===0 — see the canvas-measurement note above.
  } finally { dom.window.close(); }
});
