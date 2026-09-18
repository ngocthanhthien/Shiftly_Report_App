import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

// Regression test for the "data loss while entering a checkpoint" bug
// (see HANDOFF.md #3): changing PO/Recipe/Client re-renders the whole Input
// form, and for a brand-new (unsaved) checkpoint that used to throw away
// every value already typed into the chỉ tiêu fields, because they only
// ever got written back into the in-memory checkpoint object at Save time.
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

test('typed field values survive a PO change before Save (new checkpoint)', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    w.showTab('input');

    const addBtn = [...doc.querySelectorAll('#view-input button')].find(b => b.textContent.includes('Thêm điểm kiểm tra'));
    assert.ok(addBtn, 'add-checkpoint button exists');
    addBtn.click();

    // First PO entry: this render pass has no PO yet, so it returns before
    // ever creating the chỉ tiêu fields — exercises the early-return guard.
    const poInput = doc.querySelector('#view-input .ac-wrap input');
    assert.ok(poInput, 'PO autocomplete input exists');
    poInput.value = 'PO-TEST-1';
    poInput.dispatchEvent(new w.Event('blur'));
    await new Promise(r => setTimeout(r, 200)); // commit() debounces via setTimeout internally

    // Now the chỉ tiêu fields for the default section (ROA) should exist.
    const numberInput = doc.querySelector('#view-input .inp.num');
    assert.ok(numberInput, 'a number field is now rendered');
    numberInput.value = '92.5';

    // Change Recipe — this is one of the exact triggers reported as wiping
    // out already-typed values.
    const recipeSelect = [...doc.querySelectorAll('#view-input select')].find(s => [...s.options].some(o => o.textContent.includes('Recipe')));
    assert.ok(recipeSelect, 'recipe select exists');
    const realOption = [...recipeSelect.options].find(o => o.value && o.value !== '');
    assert.ok(realOption, 'at least one real recipe option exists');
    recipeSelect.value = realOption.value;
    recipeSelect.dispatchEvent(new w.Event('change'));

    const numberInputAfter = doc.querySelector('#view-input .inp.num');
    assert.ok(numberInputAfter, 'number field still rendered after Recipe change');
    assert.equal(numberInputAfter.value, '92.5', 'typed value must survive the Recipe-change re-render');

    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    dom.window.close();
  }
});

test('typed field values survive a Client change while editing an existing checkpoint', async () => {
  const {dom, w, errors} = await boot();
  try {
    const doc = w.document;
    const cp = w.blankCheckpoint('2026-09-18', '1', 'ROA', 'PO-EXIST', 'QA');
    cp.fields = {};
    await w.idbPut('shifts', cp);
    await w.refreshCache();

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
