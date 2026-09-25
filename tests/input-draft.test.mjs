import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Regression test for the "data loss while entering a checkpoint" bug
// (see HANDOFF.md #3): changing Process/PO/QC/Item Code/Client re-renders
// the whole Input form, and for a brand-new (unsaved) checkpoint that used
// to throw away every value already typed into the chỉ tiêu fields, because
// they only ever got written back into the in-memory checkpoint object at
// Save time. Updated for the reworked Input Form (Date/Shift/QC/Process/
// Item Code/Item Name/Recipe/PO/Checkpoint/Issue-Action — see HANDOFF.md):
// Shift now has a blank default and gates the whole tab, and Recipe is no
// longer a manual select (auto-looked-up from Item Code), so the re-render
// trigger used here is the QC select instead.
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

function selectShift(doc, w, value) {
  const shiftSel = doc.querySelector('#hdrShift');
  shiftSel.value = value;
  shiftSel.dispatchEvent(new w.Event('change'));
}

test('typed field values survive a QC change before Save (new checkpoint)', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.showTab('input');

    // Ca is blank by default now — must pick one before anything else shows.
    assert.equal(doc.querySelector('#view-input').textContent.includes('Vui lòng chọn Ca'), true, 'Ca gate must be shown before a Shift is picked');
    selectShift(doc, w, '1');

    const addBtn = [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Thêm điểm kiểm tra'));
    assert.ok(addBtn, 'add-checkpoint button exists once a Shift is chosen');
    addBtn.click();

    // Process is blank by default now too — pick one before PO/checkpoint fields show.
    const secSel = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.value === 'ROA'));
    assert.ok(secSel, 'Process select (ROA/EXT/EVA/FD/FP) exists');
    secSel.value = 'ROA';
    secSel.dispatchEvent(new w.Event('change'));

    // First PO entry: this render pass has no PO yet, so it returns before
    // ever creating the chỉ tiêu fields — exercises the early-return guard.
    // Item Code is ALSO an autocomplete (.ac-wrap) now, positioned before PO,
    // so ".ac-wrap input" alone is ambiguous — disambiguate by placeholder.
    const poInput = [...doc.querySelectorAll('#view-input .ac-wrap input')].find(i => i.placeholder.includes('SHUTDOWN'));
    assert.ok(poInput, 'PO autocomplete input exists');
    poInput.value = '712600001';
    poInput.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 200)); // commit() debounces via setTimeout internally

    // Now the chỉ tiêu fields for the chosen section (ROA) should exist.
    const numberInput = doc.querySelector('#view-input .inp.num');
    assert.ok(numberInput, 'a number field is now rendered');
    numberInput.value = '92.5';

    // Change QC — this is one of the exact triggers reported as wiping out
    // already-typed values, and QC now sits ABOVE Process/PO/checkpoint
    // fields in the new field order, making it the highest-risk trigger.
    const qcSelect = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Chọn QC')));
    assert.ok(qcSelect, 'QC select exists');
    const realOption = [...qcSelect.options].find(o => o.value && o.value !== '');
    assert.ok(realOption, 'at least one real QC option exists');
    qcSelect.value = realOption.value;
    qcSelect.dispatchEvent(new w.Event('change'));

    const numberInputAfter = doc.querySelector('#view-input .inp.num');
    assert.ok(numberInputAfter, 'number field still rendered after QC change');
    assert.equal(numberInputAfter.value, '92.5', 'typed value must survive the QC-change re-render');

    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    dom.window.close();
  }
});

test('typed field values survive a Client change while editing an existing checkpoint', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    const cp = w.blankCheckpoint('2026-09-18', '1', 'ROA', '712600002', 'QA');
    cp.fields = {};
    await w.idbPut('shifts', cp);
    await w.refreshCache();

    w.renderInputForm._shift = '1';
    w.renderInputForm._editKey = cp.key;
    w.renderInputForm._addOpen = false;
    w.renderInputForm._draft = null;
    w.showTab('input');
    w.renderInputForm();

    const numberInput = doc.querySelector('#view-input .inp.num');
    assert.ok(numberInput, 'a number field is rendered for the existing checkpoint');
    numberInput.value = '45.6';

    const clientSelect = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Client')));
    assert.ok(clientSelect, 'client select exists');
    clientSelect.dispatchEvent(new w.Event('change'));

    const numberInputAfter = doc.querySelector('#view-input .inp.num');
    assert.equal(numberInputAfter.value, '45.6', 'typed value must survive the Client-change re-render while editing');

    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    dom.window.close();
  }
});
