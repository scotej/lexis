import { BANK_ORDERS, listWords } from './core/bank.js';
import { relatedFingerprint, relatedWords } from './core/related.js';
import { createBankPdf } from './core/pdf.js';

/** Presentation state only. Rendering never starts an AI request. */
export function installBankTools({ document = globalThis.document, getWords, getAiSettings, onChange,
  savePdf, createPdf = createBankPdf, sortRelated = relatedWords }) {
  const $ = id => document.getElementById(id);
  const sort = $('bank-sort');
  const exportOrder = $('export-order');
  const dialog = $('export-dialog');
  for (const select of [sort, exportOrder]) {
    for (const [value, label] of BANK_ORDERS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
  }
  let standard = 'added-newest';
  let cache = null;
  let sortJob = null;
  let exportJob = null;
  const status = (id, message, error = false) => {
    $(id).textContent = message;
    $(id).classList.toggle('error', error);
    $(id).hidden = !message;
  };
  const abortSort = () => { sortJob?.ctl.abort(); sortJob = null; $('bank-sort-cancel').hidden = true; };
  const abortExport = () => { exportJob?.abort(); exportJob = null; $('export-save').disabled = false; exportOrder.disabled = false; };

  function displayWords() {
    const words = getWords();
    const fingerprint = relatedFingerprint(words);
    if ((sortJob && sortJob.fingerprint !== fingerprint) || (cache && cache.fingerprint !== fingerprint)) {
      abortSort();
      cache = null;
      if (sort.value === 'related') {
        sort.value = standard;
        status('bank-order-status', 'The bank changed. Choose related meanings — AI to sort it again.');
      }
    }
    $('bank-tools').hidden = !words.length;
    $('bank-export').disabled = !words.length;
    sort.disabled = words.length < 2;
    $('bank-ai-tools').hidden = sort.value !== 'related';
    $('bank-ai-refresh').disabled = Boolean(sortJob);
    if (sort.value === 'related' && cache?.fingerprint === fingerprint) {
      const byName = new Map(words.map(word => [word.word, word]));
      return cache.names.map(name => byName.get(name));
    }
    return listWords({ words }, sort.value === 'related' ? standard : sort.value);
  }

  async function orderedRelated(words, ctl, progress) {
    const fingerprint = relatedFingerprint(words);
    if (cache?.fingerprint === fingerprint) {
      const byName = new Map(words.map(word => [word.word, word]));
      return cache.names.map(name => byName.get(name));
    }
    if (!getAiSettings()?.key && words.length > 1) throw new Error('Add your OpenRouter key in settings → ai assist first.');
    const result = await sortRelated(words, getAiSettings(), { signal: ctl.signal, onProgress: progress });
    ctl.signal.throwIfAborted();
    // Cache only a complete permutation, even if a future sorter changes.
    const names = result.map(word => word.word);
    const expected = new Set(words.map(word => word.word));
    if (names.length !== words.length || new Set(names).size !== expected.size || names.some(name => !expected.has(name))) {
      throw new Error('AI did not return an order for every word. Try again.');
    }
    cache = { fingerprint, names };
    return result;
  }

  async function changeOrder() {
    abortSort();
    status('bank-order-status', '');
    if (sort.value !== 'related') { standard = sort.value; onChange(); return; }
    const words = structuredClone(getWords());
    const job = { ctl: new AbortController(), fingerprint: relatedFingerprint(words) };
    sortJob = job;
    $('bank-sort-cancel').hidden = false;
    status('bank-order-status', 'comparing related meanings…');
    onChange();
    try {
      await orderedRelated(words, job.ctl, text => {
        if (sortJob === job) status('bank-order-status', text);
      });
      job.ctl.signal.throwIfAborted();
      if (job.fingerprint !== relatedFingerprint(getWords())) {
        cache = null;
        throw new Error('The bank changed while sorting. Please try again.');
      }
      status('bank-order-status', `Linked ${words.length} words by meaning. Neighbours may be related without being synonyms.`);
    } catch (error) {
      if (sortJob !== job) return;
      sort.value = standard;
      status('bank-order-status', error.name === 'AbortError' ? 'Sorting cancelled.' : String(error.message ?? error), error.name !== 'AbortError');
    } finally {
      if (sortJob === job) { abortSort(); onChange(); }
    }
  }
  sort.addEventListener('change', changeOrder);
  $('bank-ai-refresh').addEventListener('click', () => { cache = null; changeOrder(); });
  $('bank-sort-cancel').addEventListener('click', () => {
    abortSort(); sort.value = standard;
    status('bank-order-status', 'Sorting cancelled.'); onChange();
  });

  function updateExportNote() { $('export-ai-note').hidden = exportOrder.value !== 'related'; }
  exportOrder.addEventListener('change', updateExportNote);
  $('bank-export').addEventListener('click', () => {
    displayWords();
    if (!getWords().length) return;
    exportOrder.value = sort.value;
    $('export-count').textContent = `${getWords().length} word${getWords().length === 1 ? '' : 's'} · all entries included`;
    status('export-status', '');
    updateExportNote();
    dialog.showModal();
  });
  const close = () => { abortExport(); dialog.close(); };
  $('export-close').addEventListener('click', close);
  dialog.addEventListener('cancel', () => abortExport());
  dialog.addEventListener('close', () => abortExport());
  $('export-save').addEventListener('click', async () => {
    if (exportJob) return;
    const ctl = new AbortController();
    exportJob = ctl;
    $('export-save').disabled = true;
    exportOrder.disabled = true;
    status('export-status', 'preparing PDF…');
    const words = structuredClone(getWords());
    const order = exportOrder.value;
    const date = new Date();
    try {
      const ordered = order === 'related'
        ? await orderedRelated(words, ctl, text => { if (exportJob === ctl) status('export-status', text); })
        : listWords({ words }, order);
      ctl.signal.throwIfAborted();
      status('export-status', 'preparing PDF…');
      const bytes = await createPdf(ordered, { orderLabel: BANK_ORDERS.find(([value]) => value === order)[1], date });
      ctl.signal.throwIfAborted();
      const saved = await savePdf(bytes, `lexis-word-bank-${date.toISOString().slice(0, 10)}.pdf`);
      ctl.signal.throwIfAborted();
      status('export-status', saved === false ? 'Save cancelled.' : `PDF ready · ${words.length} word${words.length === 1 ? '' : 's'}.`);
    } catch (error) {
      if (!ctl.signal.aborted) status('export-status', String(error.message ?? error), true);
    } finally {
      if (exportJob === ctl) abortExport();
    }
  });

  return { displayWords, reset() {
    abortSort(); abortExport(); cache = null;
    sort.value = standard;
    if (dialog.open) dialog.close();
    status('bank-order-status', '');
    onChange();
  } };
}
