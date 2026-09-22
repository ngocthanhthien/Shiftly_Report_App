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

// ===================== 3) Report tab "Theo PO": PO Production Timeline =====================

async function seedPOTimelineData(w) {
  w.eval(`ITEM_CODE_LIST = [{type:'FGs', itemCode:'11000011', name:'Coffee X', recipe:'452'}];`);
  await w.eval(`(async function(){
    const roa1 = blankCheckpoint('2026-07-22','1','ROA','712600555','QA');
    roa1.itemCode='11000011'; roa1.recipe='452'; roa1.fields={};
    const roa2 = blankCheckpoint('2026-07-23','1','ROA','712600555','QA');
    roa2.fields={};
    const ext1 = blankCheckpoint('2026-07-23','1','EXT','712600555','QA');
    ext1.fields={}; ext1.fields[ISSUE_PAIRS_KEY] = [{issue:'Sediment high', action:'Check centrifuge'}];
    await idbPut('shifts', roa1); await idbPut('shifts', roa2); await idbPut('shifts', ext1);
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
function poCardWithHeading(doc, textFragment) {
  return [...doc.querySelectorAll('#view-report .reportcard .card')].find(c => {
    const h3 = c.querySelector('h3');
    return h3 && h3.textContent.includes(textFragment);
  });
}

test('Báo cáo tab (Theo PO): header hiện Item Code/Item Name/Recipe 1 lần, Process Timeline đúng thứ tự + khoảng Date/Shift, Issue/Action gắn đúng checkpoint gốc', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    await seedPOTimelineData(w);
    w.showTab('report');
    await new Promise(r => setTimeout(r, 80));
    doSearchPO(doc, w, '712600555');
    await new Promise(r => setTimeout(r, 150));

    const previewTxt = doc.querySelector('#view-report .reportcard').textContent;
    // Header shown once.
    assert.ok(previewTxt.includes('11000011') && previewTxt.includes('Coffee X') && previewTxt.includes('452'), 'header must show Item Code/Item Name/Recipe');
    const nameOccurrences = previewTxt.split('Coffee X').length - 1;
    assert.equal(nameOccurrences, 1, 'Item Name must appear exactly ONCE (header only), not repeated per checkpoint card');

    // Process Timeline: ROA range spans 22/07 -> 23/07, EXT is a single point (no arrow).
    const timelineCard = [...doc.querySelectorAll('#view-report .reportcard .card')].find(c => c.textContent.includes('Process Timeline'));
    assert.ok(timelineCard, 'a "Process Timeline" card must exist');
    assert.ok(timelineCard.textContent.includes('22/07/2026 Ca 1 → 23/07/2026 Ca 1'), 'ROA must show its first->last Date+Shift range');
    assert.ok(timelineCard.textContent.includes('23/07/2026 Ca 1') && !timelineCard.textContent.includes('23/07/2026 Ca 1 → 23/07/2026 Ca 1'), 'EXT (single checkpoint) must show one Date+Shift, not a self-range');

    // Process order: ROA's detail card(s) must appear before EXT's in the DOM.
    const roaCard = poCardWithHeading(doc, 'Rang (ROA)');
    const extCard = poCardWithHeading(doc, 'Trích ly (EXT)');
    assert.ok(roaCard && extCard, 'both ROA and EXT detail cards must render');
    const allCards = [...doc.querySelectorAll('#view-report .reportcard .card')];
    assert.ok(allCards.indexOf(roaCard) < allCards.indexOf(extCard), 'ROA must be listed before EXT (PROCESS_TIMELINE_ORDER)');

    // Issue/Action must be attached to the EXT card (where it actually happened), not ROA, not merged away.
    assert.ok(extCard.textContent.includes('Sediment high') && extCard.textContent.includes('Check centrifuge'), 'EXT card must show its own Issue/Action pair');
    const roaCards = allCards.filter(c => (c.querySelector('h3')||{}).textContent && c.querySelector('h3').textContent.includes('Rang (ROA)'));
    assert.equal(roaCards.length, 2, 'both ROA checkpoints (22/07 and 23/07) must render their own detail card');
    roaCards.forEach(c => assert.ok(!c.textContent.includes('Sediment high'), 'no ROA card must show an Issue/Action that belongs to EXT'));
    // Not asserting errors.length===0 — see the canvas-measurement note above.
  } finally { dom.window.close(); }
});

test('Báo cáo tab (Theo PO): sửa Issue/Action ngay tại báo cáo ghi NGƯỢC vào checkpoint gốc — Input tab và Data Log đều thấy thay đổi, không tạo bản ghi Report riêng', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    await seedPOTimelineData(w);
    w.showTab('report');
    await new Promise(r => setTimeout(r, 80));
    doSearchPO(doc, w, '712600555');
    await new Promise(r => setTimeout(r, 150));

    const extCard = poCardWithHeading(doc, 'Trích ly (EXT)');
    assert.ok(extCard, 'EXT detail card must exist');
    const editBtn = [...extCard.querySelectorAll('button')].find(b => b.textContent.includes('Sửa'));
    assert.ok(editBtn, '"✎ Sửa" button must exist on the Issue/Action block');
    editBtn.click();

    const textareas = extCard.querySelectorAll('textarea');
    assert.equal(textareas.length, 2, 'editing must open 2 textareas: Issue and Action');
    textareas[0].value = 'Sediment cao bất thường (đã sửa)';
    textareas[1].value = 'Đã kiểm tra ly tâm và điều chỉnh lại';
    const saveBtn = [...extCard.querySelectorAll('button')].find(b => b.textContent.includes('Lưu'));
    saveBtn.click();
    await new Promise(r => setTimeout(r, 150));

    // 1) The underlying checkpoint itself was updated (no separate Report record).
    const savedCp = w.eval("allCheckpoints.find(c=>c.section==='EXT' && c.po==='712600555')");
    const savedCpJson = evalJson(w, "allCheckpoints.find(c=>c.section==='EXT' && c.po==='712600555')");
    assert.deepEqual(savedCpJson.fields[w.eval('ISSUE_PAIRS_KEY')], [{issue:'Sediment cao bất thường (đã sửa)', action:'Đã kiểm tra ly tâm và điều chỉnh lại'}]);
    assert.equal(savedCpJson.fields.EXT_ISSUE, 'Sediment cao bất thường (đã sửa)', 'must sync back into the legacy EXT_ISSUE field too');

    // 2) The Report preview itself updates immediately (re-drawn via onEdited).
    const reportTxtAfter = doc.querySelector('#view-report .reportcard').textContent;
    assert.ok(reportTxtAfter.includes('Sediment cao bất thường (đã sửa)'), 'Report preview must reflect the edit immediately');

    // 3) Opening the SAME checkpoint from Input tab must show the new text.
    w.renderInputForm._date = '2026-07-23';
    w.renderInputForm._shift = '1';
    w.renderInputForm._editKey = savedCp && w.eval(`allCheckpoints.find(c=>c.section==='EXT' && c.po==='712600555').key`);
    w.renderInputForm._addOpen = false;
    w.showTab('input');
    w.renderInputForm();
    const issueTa = doc.querySelector('#view-input textarea[placeholder="Issue/ Abnormal"]');
    assert.equal(issueTa.value, 'Sediment cao bất thường (đã sửa)', 'Input tab must show the edit made from the Report tab');

    // 4) Data Log/Audit must have recorded the change.
    const logs = JSON.parse(await w.eval('getAllLogs().then(r=>JSON.stringify(r))'));
    const relevant = logs.filter(l => l.po === '712600555' && l.section === 'Trích ly (EXT)');
    assert.ok(relevant.length >= 1, 'Data Log must record the Issue/Action edit made from the Report tab');
    assert.ok(relevant.some(l => (l.changes||[]).some(c => /Issue\/Action/.test(c.label))), 'the log entry must reference the Issue/Action change');
    // Not asserting errors.length===0 — see the canvas-measurement note above
    // (this test also exercises the SVG preview via doSearchPO's redraw).
  } finally { dom.window.close(); }
});
