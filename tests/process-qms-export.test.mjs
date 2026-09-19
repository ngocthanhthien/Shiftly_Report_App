import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Covers the "Xuất theo mẫu Process/QMS" feature: Item Code as a new
// top-level checkpoint field, the isQMS/qmsLabel flag on Specs fields
// (Admin-configurable, no hardcoded field-name guessing — see the comment
// above buildProcessQmsExcelXml in index.html for why), and the Excel/PDF
// builders that group by Process and only include marked QMS columns.
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

test('fmtDateExport: d-mmm-yyyy (English month, no leading zero on the day)', async () => {
  const {dom, w} = await boot();
  try {
    assert.equal(w.fmtDateExport('2026-01-05'), '5-Jan-2026');
    assert.equal(w.fmtDateExport('2026-09-19'), '19-Sep-2026');
    assert.equal(w.fmtDateExport('2026-12-31'), '31-Dec-2026');
  } finally { dom.window.close(); }
});

test('buildProcessQmsExcelXml: groups by Process, only marked isQMS columns, Item Code + ISSUES carried through, no images', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval(`(() => {
      const f = SCHEMA.find(s=>s.id==='ROA').fields.find(x=>x.id==='ROA_R6E');
      f.isQMS = true; f.qmsLabel = 'Color';
    })()`);
    const cp = w.blankCheckpoint('2026-09-19', '1', 'ROA', 'PO1', 'QA');
    cp.itemCode = '1100011';
    cp.fields = {ROA_R6E: 46, ROA_ISSUE: 'Máy rung bất thường'};
    cp.images = [{name:'a.jpg', dataUrl:'data:image/jpeg;base64,AAAA'}];
    await w.idbPut('shifts', cp);
    await w.refreshCache();

    const xml = w.eval('buildProcessQmsExcelXml(allCheckpoints)');
    assert.ok(xml.includes('>Color<'), 'qmsLabel "Color" must appear as a column header');
    assert.ok(xml.includes('>1100011<'), 'Item Code value must appear');
    assert.ok(xml.includes('>19-Sep-2026<'), 'date must be formatted d-mmm-yyyy');
    assert.ok(xml.includes('>Máy rung bất thường<'), 'the _ISSUE field must feed the ISSUES/ Abnormal column');
    assert.ok(!xml.includes('base64'), 'attached images must never appear in the export');
    // A field NOT marked isQMS (e.g. the roasting time) must not get its own column.
    assert.ok(!xml.includes('Roasting time'), 'a non-QMS field must not appear as a column');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('buildProcessQmsExcelXml: a section with no matching rows is skipped entirely; a section with no isQMS fields still gets its base columns', async () => {
  const {dom, w, errors} = await boot();
  try {
    const cp = w.blankCheckpoint('2026-09-19', '1', 'FD', 'PO9', 'QA'); // FD has no QMS-labelled fields in the template
    cp.fields = {FD_ISSUE: 'Rung nhẹ'};
    await w.idbPut('shifts', cp);
    await w.refreshCache();

    const xml = w.eval('buildProcessQmsExcelXml(allCheckpoints)');
    assert.ok(xml.includes('>FD<'), 'FD section must still appear with its base columns');
    assert.ok(!xml.includes('>ROA<'), 'a Process with zero rows must not appear at all');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('buildProcessQmsPrintHtml: same grouping/columns as the Excel builder, rendered as an HTML table', async () => {
  const {dom, w, errors} = await boot();
  try {
    w.eval(`(() => {
      const f = SCHEMA.find(s=>s.id==='EVA').fields.find(x=>x.id==='EVA_R23E');
      f.isQMS = true; // no qmsLabel override -> falls back to the field's own label
    })()`);
    const cp = w.blankCheckpoint('2026-01-05', '2', 'EVA', 'PO2', 'QA');
    cp.fields = {EVA_R23E: 5.0};
    await w.idbPut('shifts', cp);
    await w.refreshCache();

    const out = w.eval('buildProcessQmsPrintHtml(allCheckpoints)');
    assert.ok(out.includes('<table>'), 'must render an actual HTML table');
    assert.ok(out.includes('5-Jan-2026'));
    assert.ok(out.includes('>5<') || out.includes('>5</td>'), 'the QMS numeric value must appear');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});

test('Báo cáo tab: template export is scoped to the selected Date+Shift+Process, never the whole dataset', async () => {
  const {dom, w, errors} = await boot();
  try {
    const cp1 = w.blankCheckpoint('2026-09-19', '1', 'ROA', 'PO1', 'QA'); cp1.fields = {};
    const cp2 = w.blankCheckpoint('2026-09-19', '1', 'EXT', 'PO2', 'QA'); cp2.fields = {};
    const cp3 = w.blankCheckpoint('2026-08-01', '2', 'ROA', 'PO3', 'QA'); cp3.fields = {}; // different date+shift entirely
    await w.idbPut('shifts', cp1); await w.idbPut('shifts', cp2); await w.idbPut('shifts', cp3);
    await w.refreshCache();
    w.showTab('report');
    await new Promise(r => setTimeout(r, 80));

    // Stub the file-writing step so this test only checks WHAT gets built,
    // not the browser download/share plumbing (not fully implemented in jsdom).
    w.eval('window.exportFileToPreferredLocation = async (file) => { window.__capturedFile = file; };');
    // No field is marked isQMS in this test's SCHEMA, which now triggers a
    // confirm() warning ("file will be MAIN INFORMATION only") — proceed
    // anyway, since this test is only about Date/Shift/Process scoping.
    w.confirm = () => true;

    const doc = w.document;
    const selects = doc.querySelectorAll('#view-report select');
    assert.equal(selects.length, 3, 'expects Date+Shift picker, Process filter, and the format dropdown');
    selects[1].value = 'ROA'; // narrow the shift's report down to just the ROA process
    selects[2].value = 'qms-xlsx';
    selects[2].dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 100));

    const xmlContent = await w.eval('window.__capturedFile.text()');
    assert.ok(xmlContent.includes('PO1'), 'must include the ROA checkpoint from the selected shift');
    assert.ok(!xmlContent.includes('PO2'), 'must exclude EXT once the Process filter narrows to ROA');
    assert.ok(!xmlContent.includes('PO3'), 'must exclude a checkpoint from a completely different date/shift');
  } finally { dom.window.close(); }
});

test('Báo cáo tab: warns (and can be cancelled) when exporting the template with zero isQMS fields configured anywhere', async () => {
  const {dom, w, errors} = await boot();
  try {
    const cp1 = w.blankCheckpoint('2026-09-19', '1', 'ROA', 'PO1', 'QA'); cp1.fields = {};
    await w.idbPut('shifts', cp1);
    await w.refreshCache();
    w.showTab('report');
    await new Promise(r => setTimeout(r, 80));
    w.eval('window.exportFileToPreferredLocation = async (file) => { window.__capturedFile = file; };');
    // seedQmsDefaults() (run once at boot) pre-checks isQMS for the fields
    // that clearly match the template (see QMS_DEFAULT_SEED) — clear all of
    // them here to exercise the "nothing configured yet" warning in isolation.
    w.eval(`SCHEMA.forEach(s=>s.fields.forEach(f=>{ delete f.isQMS; delete f.qmsLabel; }));`);

    let confirmCalls = 0;
    w.confirm = (msg) => { confirmCalls++; assert.ok(msg.includes('QMS'), 'the warning must mention QMS'); return false; };
    const doc = w.document;
    const fmtSel = doc.querySelectorAll('#view-report select')[2];
    fmtSel.value = 'qms-xlsx';
    fmtSel.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 80));
    assert.equal(confirmCalls, 1, 'must warn once when no field anywhere is marked isQMS');
    assert.equal(w.eval('window.__capturedFile'), undefined, 'cancelling the warning must abort the export');

    // Mark one field isQMS anywhere in SCHEMA — the warning must no longer fire.
    w.eval(`SCHEMA.find(s=>s.id==='ROA').fields.find(f=>f.id==='ROA_R6E').isQMS = true;`);
    confirmCalls = 0;
    fmtSel.value = 'qms-xlsx';
    fmtSel.dispatchEvent(new w.Event('change'));
    await new Promise(r => setTimeout(r, 80));
    assert.equal(confirmCalls, 0, 'must not warn once at least one field is marked isQMS');
    assert.ok(w.eval('window.__capturedFile'), 'export must proceed without confirmation this time');
    // Not asserting errors.length===0 here: jsdom has no <canvas> implementation
    // (see package.json — the `canvas` package isn't installed), and drawing the
    // shift's report preview touches it incidentally; unrelated to this test.
  } finally { dom.window.close(); }
});

test('stripLocalMarkers: omits `images` only when unchanged since the last sync; always includes it on first sync or a real change', async () => {
  const {dom, w} = await boot();
  try {
    const cp = w.blankCheckpoint('2026-09-19', '1', 'ROA', 'PO1', 'QA');
    cp.images = [{ name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,AAAA', ts: 100 }];

    // Never synced yet (no _imagesSyncedFp) -> first push must include images.
    let clean = w.eval(`stripLocalMarkers(${JSON.stringify(cp)})`);
    assert.ok('images' in clean, 'first-ever sync must include images');

    // Mark it as already synced at the CURRENT fingerprint -> a pure field
    // edit (photos untouched) must omit `images` from the outgoing payload.
    cp._imagesSyncedFp = w.eval(`imagesFingerprint(${JSON.stringify(cp)})`);
    clean = w.eval(`stripLocalMarkers(${JSON.stringify(cp)})`);
    assert.ok(!('images' in clean), 'unchanged photos must be omitted from the push payload');
    assert.ok(!('_imagesSyncedFp' in clean), 'the local-only marker must never itself be sent to the server');
    assert.ok(!('_syncedAt' in clean), 'the pre-existing _syncedAt marker must still be stripped too');

    // Add a new photo -> fingerprint changes -> must include images again.
    cp.images.push({ name: 'b.jpg', dataUrl: 'data:image/jpeg;base64,BBBB', ts: 200 });
    clean = w.eval(`stripLocalMarkers(${JSON.stringify(cp)})`);
    assert.ok('images' in clean, 'a real photo change must be included in the push payload');
    assert.equal(clean.images.length, 2);
  } finally { dom.window.close(); }
});

test('Item Code: typed value survives a PO change before Save (same draft-safety net as chỉ tiêu fields)', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.showTab('input');
    const addBtn = [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Thêm điểm kiểm tra'));
    addBtn.click();

    const poInput = doc.querySelector('#view-input .ac-wrap input');
    poInput.value = 'PO-IC-1';
    poInput.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 200));

    const itemCodeInp = [...doc.querySelectorAll('#view-input input[placeholder="VD: 1100011"]')][0];
    assert.ok(itemCodeInp, 'Item Code input exists once a section+PO are chosen');
    itemCodeInp.value = '1100099';
    itemCodeInp.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 50));

    // Changing Recipe re-renders the whole form — the exact trigger class
    // that used to wipe unsaved chỉ tiêu values (see HANDOFF.md #3).
    const recipeSelect = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Recipe')));
    const realOption = [...recipeSelect.options].find(o => o.value && o.value !== '');
    recipeSelect.value = realOption.value;
    recipeSelect.dispatchEvent(new w.Event('change'));

    const itemCodeAfter = [...doc.querySelectorAll('#view-input input[placeholder="VD: 1100011"]')][0];
    assert.equal(itemCodeAfter.value, '1100099', 'Item Code must survive the Recipe-change re-render');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally { dom.window.close(); }
});
