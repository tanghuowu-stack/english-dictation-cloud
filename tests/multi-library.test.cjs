const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Run the real application functions without bootstrapping its DOM or cloud connection.
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('  <script>') + '  <script>'.length, html.indexOf('    window.addEventListener("beforeunload"'));
function app() {
  const storage = new Map();
  const env = vm.createContext({
    console, setTimeout: () => 0, clearTimeout() {},
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null }, window: {}
  });
  env.window = env;
  vm.runInContext(source, env);
  const api = vm.runInContext(`({
    makeWord, buildTodayTask, planCombinedTask, getStudyLibraries, getDictationLibrary,
    getTaskCategoryCounts, saveCombinedResult, saveData, loadData, getNextDayNumber,
    getSupplementReviewWords, getDueDelayedReviewWords, renderStudyPlanSection,
    renderMarkWrongPanel, renderPlayerPanel, renderAnswerRevealHtml, exportDictationPaperXlsx, startDictation,
    stubExcel: (excel, download) => { requireExcelJs = () => excel; downloadWorkbook = download; },
    handleStudyPlanChange,
    setData: value => { data = value; }, getData: () => data,
    stubRender: () => { renderTodayView = () => {}; },
    stubAppRender: () => { renderApp = () => {}; },
    confirm: value => { requestAppConfirmation = async () => value; },
    queuedMessages: () => appMessageQueue
  })`, env);
  function library(id, texts, day = 1, settings = {}) {
    return {
      libraryId: id, libraryName: id, settings: { dailyTargetWords: 20, dailyReviewWords: 35,
        reviewDelayDays: 15, correctTimesToExitWrongPool: 1, autoFillReviewWords: true, ...settings },
      words: texts.map((text, i) => api.makeWord(text, id + '释义' + i, i)),
      dailyRecords: day > 1 ? [{ dayNumber: day - 1, taskWordIds: [], wrongWordIds: [] }] : [],
      currentDraftTask: null, reviewRuleVersion: 'wrong-only-review-v1', wrongClassificationVersion: 'review-failure-stubborn-v2'
    };
  }
  function setup(libs) {
    api.setData({ version: '1.0.0', libraries: libs, activeLibraryId: libs[0].libraryId, studyLibraryIds: libs.map(lib => lib.libraryId) });
    return libs;
  }
  return { api, env, storage, library, setup };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('three libraries: deduplicate English, namespace identical IDs, retain library meanings and independent Days', () => {
  const { api, library, setup } = app();
  const libs = setup([library('A', ['Apple', 'pear'], 65), library('B', ['apple', 'orange'], 12), library('C', ['grape'], 3)]);
  libs[1].words[1].id = libs[0].words[1].id; // Same ID, different words, separate libraries.
  const before = JSON.stringify(libs);
  const task = api.planCombinedTask(libs);
  assert.equal(JSON.stringify(libs), before, 'preview must not mutate libraries or drafts');
  assert.equal(task.entries.length, 4);
  assert.deepEqual(plain(task.parts.map(part => part.task.dayNumber)), [65, 12, 3]);
  const apple = task.entries.find(entry => entry.word === 'Apple');
  assert.equal(apple.references.length, 2);
  api.getData().combinedDraftTask = task;
  const display = api.getDictationLibrary();
  // 释义只放纯释义，不再拼接词库名；来源词库单独放在 libraryNames 里。
  assert.equal(display.words[0].meaning, 'A释义0；B释义0');
  assert.deepEqual(plain(display.words[0].libraryNames), ['A', 'B']);
  const summaries = api.saveCombinedResult(task, [apple.id]);
  assert.equal(summaries.length, 3);
  const saved = api.getData().libraries;
  assert.deepEqual(plain(saved.map(lib => api.getNextDayNumber(lib))), [66, 13, 4]);
  assert.equal(saved[0].words[0].wrongCount, 1);
  assert.equal(saved[1].words[0].wrongCount, 1);
  assert.equal(saved[2].words[0].wrongCount, 0);
  assert.equal(saved[1].dailyRecords.at(-1).wrongWordIds[0], 'apple');
  assert.ok(saved.every(lib => lib.dailyRecords.at(-1).taskWordIds.every(id => !id.startsWith('combined_'))));
  assert.throws(() => api.saveCombinedResult(task, []), /已提交或失效/);
});

test('shared English keeps each library category and wrong-pool exit / 15-Day schedule', () => {
  const { api, library, setup } = app();
  const libs = setup([library('A', ['shared'], 65), library('B', ['SHARED'], 12)]);
  Object.assign(libs[0].words[0], { firstLearnDay: 1, wrongCount: 2, isPendingWrong: true });
  Object.assign(libs[1].words[0], { firstLearnDay: 1, wrongCount: 1, wrongReviewDueDay: 12, delayedReviewCompleted: false });
  const task = api.planCombinedTask(libs);
  assert.equal(task.taskWordIds.length, 1);
  assert.deepEqual(plain(api.getTaskCategoryCounts(task)), { total: 1, wrong: 1, review: 0, new: 0 });
  api.getData().combinedDraftTask = task;
  api.saveCombinedResult(task, []);
  const a = api.getData().libraries[0];
  assert.equal(a.words[0].isPendingWrong, false);
  assert.equal(a.words[0].wrongReviewDueDay, 80);
  const b = api.getData().libraries[1];
  assert.equal(b.dailyRecords.at(-1).delayedReviewWordIds[0], 'shared');
  assert.equal(b.words[0].wrongCount, 1);
});

test('7-Day supplement cooldown is independent from formal 15-Day due dates', () => {
  const { api, library, setup } = app();
  const [lib] = setup([library('A', ['eligible', 'recent', 'due'], 65)]);
  lib.words.forEach(word => Object.assign(word, { firstLearnDay: 1, wrongCount: 1, wrongReviewDueDay: 80 }));
  lib.words[2].wrongReviewDueDay = 65;
  lib.dailyRecords.push({ dayNumber: 58, delayedReviewWordIds: ['eligible'] }, { dayNumber: 59, supplementReviewWordIds: ['recent'] });
  assert.equal(api.getSupplementReviewWords(65, lib, ['due']).length, 1);
  assert.equal(api.getDueDelayedReviewWords(65, lib).length, 1);
});

test('more than 60 unique words blocks start, without truncating plans or changing progress', () => {
  const { api, library, setup } = app();
  const libs = setup([library('A', Array.from({ length: 40 }, (_, i) => 'a' + i), 1, { dailyTargetWords: 40 }),
    library('B', Array.from({ length: 30 }, (_, i) => 'b' + i), 1, { dailyTargetWords: 30 })]);
  assert.equal(api.planCombinedTask(libs).taskWordIds.length, 70);
  api.stubRender();
  api.startDictation();
  assert.match(api.queuedMessages().at(-1), /超过整场 60/);
  assert.equal(api.getData().combinedDraftTask, undefined);
  assert.ok(libs.every(lib => lib.dailyRecords.length === 0 && !lib.currentDraftTask));
});

test('exactly 60 accepted; deduplicated total determines the limit', () => {
  const { api, library, setup } = app();
  const libs = setup([library('A', Array.from({ length: 40 }, (_, i) => 'w' + i), 1, { dailyTargetWords: 40 }),
    library('B', Array.from({ length: 30 }, (_, i) => 'w' + (i + 30)), 1, { dailyTargetWords: 30 })]);
  assert.equal(api.planCombinedTask(libs).taskWordIds.length, 60);
  api.stubRender();
  api.startDictation();
  assert.equal(api.getData().combinedDraftTask.taskWordIds.length, 60);
});

test('empty and unselected libraries do not advance or lose their drafts', () => {
  const { api, library, setup } = app();
  const libs = setup([library('A', ['a']), library('B', [], 9), library('C', ['c'], 4)]);
  libs[2].currentDraftTask = api.buildTodayTask(libs[2], false);
  const cBefore = JSON.stringify(libs[2]);
  const task = api.planCombinedTask(libs.slice(0, 2));
  api.getData().combinedDraftTask = task;
  api.saveCombinedResult(task, []);
  assert.equal(api.getData().libraries[1].dailyRecords.length, 1);
  assert.equal(api.getNextDayNumber(api.getData().libraries[1]), 9);
  assert.equal(JSON.stringify(api.getData().libraries[2]), cBefore);
});

test('reload restores ordering, playback index, checked mistakes and mark mode', () => {
  const { api, library, setup } = app();
  const libs = setup([library('A', ['a', 'b']), library('B', ['c'])]);
  // Normalize existing libraries before taking snapshots, like the application bootstrap.
  api.saveData(); api.loadData();
  const task = api.planCombinedTask(api.getData().libraries);
  Object.assign(task, { currentIndex: 2, mode: 'mark', checkedWrongWordIds: [task.entries[0].id] });
  api.getData().combinedDraftTask = task;
  api.saveData(); api.setData(null); api.loadData();
  const restored = api.getData().combinedDraftTask;
  assert.equal(restored.currentIndex, 2);
  assert.equal(restored.mode, 'mark');
  assert.deepEqual(plain(restored.taskWordIds), plain(task.taskWordIds));
  assert.match(api.renderMarkWrongPanel(api.getDictationLibrary(), restored), /data-wrong-check value="combined_0" checked/);
  api.saveCombinedResult(restored, restored.checkedWrongWordIds);
  assert.equal(api.getData().libraries[0].words[0].wrongCount, 1);
});

test('changed source library rejects whole submission, without partially saving other library', () => {
  const { api, library, setup } = app();
  const libs = setup([library('A', ['a']), library('B', ['b'])]);
  const task = api.planCombinedTask(libs);
  api.getData().combinedDraftTask = task;
  libs[1].words[0].wrongCount = 1;
  assert.throws(() => api.saveCombinedResult(task, []), /数据发生变化/);
  assert.equal(api.getData().libraries[0].dailyRecords.length, 0);
  assert.equal(api.getData().combinedDraftTask, task);
});

test('storage failure preserves all library progress and combined draft for retry', () => {
  const { api, env, library, setup } = app();
  const libs = setup([library('A', ['a']), library('B', ['b'])]);
  const task = api.planCombinedTask(libs);
  api.getData().combinedDraftTask = task;
  const before = JSON.stringify(api.getData());
  env.localStorage.setItem = () => { throw new Error('quota'); };
  env.console = { error() {} };
  assert.throws(() => api.saveCombinedResult(task, []), /保存失败/);
  assert.equal(JSON.stringify(api.getData()), before);
});

test('single-library tasks still use original IDs and independent settings', () => {
  const { api, library, setup } = app();
  const [lib] = setup([library('A', ['a', 'b'], 6, { dailyTargetWords: 1 })]);
  const task = api.buildTodayTask(lib);
  assert.equal(lib.currentDraftTask, task);
  assert.deepEqual(plain(task.taskWordIds), ['a']);
  assert.equal(task.dayNumber, 6);
  assert.equal(api.buildTodayTask(lib), task);
  assert.match(api.renderStudyPlanSection(lib, 'intro'), /data-study-select="A" checked/);
});

test('per-library form saves independent quantities and canceling a change preserves the draft', async () => {
  const { api, env, library, setup } = app();
  const libs = setup([library('A', ['a', 'b']), library('B', ['c', 'd'])]);
  const roots = libs.map((lib, i) => ({ dataset: { studyLibrary: lib.libraryId }, querySelectorAll: () => [
    { dataset: { planSetting: 'dailyTargetWords' }, type: 'number', value: i ? '2' : '1' },
    { dataset: { planSetting: 'dailyReviewWords' }, type: 'number', value: i ? '8' : '5' }
  ] }));
  const section = {
    querySelectorAll: selector => selector === '[data-study-select]:checked'
      ? libs.map(lib => ({ dataset: { studySelect: lib.libraryId } })) : roots,
    querySelector: () => ({ value: 'random' })
  };
  env.document.querySelector = () => section;
  api.stubAppRender();
  await api.handleStudyPlanChange('intro');
  assert.equal(libs[0].settings.dailyTargetWords, 1);
  assert.equal(libs[1].settings.dailyTargetWords, 2);
  assert.equal(libs[0].settings.dailyReviewWords, 5);
  assert.equal(libs[1].settings.dailyReviewWords, 8);
  const task = api.planCombinedTask(libs);
  assert.equal(task.parts[0].task.newWordIds.length, 1);
  assert.equal(task.parts[1].task.newWordIds.length, 2);
  api.getData().combinedDraftTask = task;
  api.confirm(false);
  await api.handleStudyPlanChange('mark');
  assert.equal(api.getData().combinedDraftTask, task);
});

test('global random order is persistent and does not change membership or source attribution', () => {
  const { api, env, library, setup } = app();
  const libs = setup([library('A', ['a', 'b']), library('B', ['c'])]);
  api.getData().studyPlayOrder = 'random';
  vm.runInContext('Math.random = () => 0', env);
  const task = api.planCombinedTask(libs);
  assert.deepEqual(plain(task.taskWordIds), ['combined_1', 'combined_2', 'combined_0']);
  assert.equal(task.entries[0].references[0].libraryId, 'A');
  api.getData().combinedDraftTask = task;
  api.saveData(); api.loadData();
  assert.deepEqual(plain(api.getData().combinedDraftTask.taskWordIds), plain(task.taskWordIds));
});

// 最小化的 ExcelJS 替身：只记录单元格的值，用来检查导出的打印纸内容。
function fakeExcel() {
  const sheets = [];
  class Workbook {
    addWorksheet() {
      const cells = new Map();
      const cell = (row, col) => {
        const key = typeof row === 'string' ? row : row + ',' + col;
        if (!cells.has(key)) cells.set(key, {});
        return cells.get(key);
      };
      const sheet = { cells, getCell: cell, getRow: () => ({}), mergeCells() {} };
      sheets.push(sheet);
      return sheet;
    }
  }
  return { ExcelJS: { Workbook }, sheets };
}

test('combined display splits pure meaning from library tags and deduplicates identical meanings', () => {
  const { api, library, setup } = app();
  const libs = setup([library('A', ['same', 'diff']), library('B', ['SAME', 'Diff'])]);
  libs[1].words[0].meaning = libs[0].words[0].meaning; // 两个词库释义相同
  libs[0].words[1].meaning = '';                     // 一个词库没有释义
  const task = api.planCombinedTask(libs);
  api.getData().combinedDraftTask = task;
  const words = api.getDictationLibrary().words;
  const same = words.find(word => word.word === 'same');
  assert.equal(same.meaning, 'A释义0');
  assert.deepEqual(plain(same.libraryNames), ['A', 'B']);
  const diff = words.find(word => word.word === 'diff');
  assert.equal(diff.meaning, 'B释义1');
  assert.ok(words.every(word => !word.meaning.includes('：')));
});

test('combined sequence numbers follow play order on mark panel, player and printed paper', async () => {
  const { api, env, library, setup } = app();
  const libs = setup([library('A', ['a', 'b']), library('B', ['c'])]);
  api.getData().studyPlayOrder = 'random';
  vm.runInContext('Math.random = () => 0', env);
  const task = api.planCombinedTask(libs);
  assert.deepEqual(plain(task.taskWordIds), ['combined_1', 'combined_2', 'combined_0']);
  api.getData().combinedDraftTask = task;
  const lib = api.getDictationLibrary();
  const byId = id => lib.words.find(word => word.id === id);
  assert.deepEqual(plain(task.taskWordIds.map(id => byId(id).originalNo)), [1, 2, 3]);

  const mark = api.renderMarkWrongPanel(lib, task);
  assert.doesNotMatch(mark, /所属词库/);
  const rows = mark.split('<tr>').slice(2);
  assert.deepEqual(rows.map(row => row.match(/<td>(\d+)<\/td>/)[1]), ['1', '2', '3']);
  assert.match(rows[0], /<td>A释义1<span class="tag library-tag">A<\/span><\/td>/);
  assert.match(rows[1], /<td>B释义0<span class="tag library-tag">B<\/span><\/td>/);

  lib.settings.showAnswerMeaning = true;
  const reveal = api.renderAnswerRevealHtml(byId('combined_2'), lib);
  assert.match(reveal, /中文释义：<\/span>B释义0<span class="tag library-tag">B<\/span>/);
  const player = api.renderPlayerPanel(lib, task);
  assert.match(player, /第 1 \/ 3 个/);
  assert.doesNotMatch(player, /所属词库：/);

  const { ExcelJS, sheets } = fakeExcel();
  let filename = '';
  api.stubExcel(ExcelJS, async (_, name) => { filename = name; });
  await api.exportDictationPaperXlsx(lib, task);
  const cells = sheets[0].cells;
  // 打印纸左栏 3 行，从第 4 行开始：序号用本场顺序，中文只印纯释义。
  assert.deepEqual([4, 5].map(row => cells.get(row + ',1').value), [1, 2]);
  assert.deepEqual([4, 5].map(row => cells.get(row + ',2').value), ['A释义1', 'B释义0']);
  assert.equal(cells.get('4,5').value, 3);
  assert.equal(cells.get('4,6').value, 'A释义0');
  assert.match(filename, /听写纸-多词库-/);
});

test('single-library mark panel and paper keep original numbers without library tags', async () => {
  const { api, library, setup } = app();
  const [lib] = setup([library('A', ['a', 'b', 'c'], 1, { dailyTargetWords: 3 })]);
  lib.words[0].originalNo = 101;
  lib.words[1].originalNo = 102;
  lib.words[2].originalNo = 103;
  const task = api.buildTodayTask(lib);
  const mark = api.renderMarkWrongPanel(lib, task);
  assert.doesNotMatch(mark, /library-tag|所属词库/);
  assert.match(mark, /<td>1<\/td>\s*<td class="word-cell">a<\/td>\s*<td>A释义0<\/td>/);
  lib.settings.showAnswerMeaning = true;
  assert.doesNotMatch(api.renderAnswerRevealHtml(lib.words[0], lib), /library-tag/);
  const { ExcelJS, sheets } = fakeExcel();
  api.stubExcel(ExcelJS, async () => {});
  await api.exportDictationPaperXlsx(lib, task);
  assert.equal(sheets[0].cells.get('4,1').value, 101);
  assert.equal(sheets[0].cells.get('4,2').value, 'A释义0');
});
