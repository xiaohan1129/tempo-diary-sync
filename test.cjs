const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Empty {}
class Notice { constructor(message) { this.message = message; } }
const source = fs.readFileSync(`${__dirname}/main.js`, 'utf8');
const context = {
  module: { exports: {} }, console, window: { setInterval, clearInterval, setTimeout, clearTimeout },
  require(name) {
    assert.equal(name, 'obsidian');
    return { Plugin: Empty, PluginSettingTab: Empty, Setting: Empty, Modal: Empty, Notice, moment: null };
  },
};
vm.runInNewContext(source, context);
const Plugin = context.module.exports;
const h = Plugin.helpers;
const clean = value => JSON.parse(JSON.stringify(value));
const settings = { ...h.DEFAULT_SETTINGS };
const day = h.localDate();
const makeTask = (id = 'a', title = '写论文', extra = {}) => ({ id, title, status: 'todo', triage: 'processed', availability: 'anytime', focusDate: day, order: id, ...extra });
const note = '# Day planner\n\n- [ ] 手写事项\n\n# Note\n\n保留的研究内容\n';
const own = content => h.reconcile(content, [makeTask()], {}, settings, day);

test('matches Tempo Today, including overdue and today completions only', () => {
  assert(h.isTodayTask(makeTask(), day));
  assert(h.isTodayTask(makeTask('a', '过去任务', { focusDate: '2020-01-01' }), day));
  for (const extra of [{ focusDate: '2099-01-01' }, { triage: 'inbox' }, { availability: 'someday' }, { parentTaskId: 'parent' }, { status: 'canceled' }]) {
    assert.equal(h.isTodayTask(makeTask('a', 'x', extra), day), false);
  }
  assert(h.isTodayTask(makeTask('a', '完成', { status: 'done', completedAt: Date.now() }), day));
  assert.equal(h.isTodayTask(makeTask('a', '昨天完成', { status: 'done', completedAt: Date.now() - 86400000 }), day), false);
});
test('preserves handwriting and other sections, has no markers, is idempotent', () => {
  const first = own(note);
  assert.equal(first.added, 1);
  assert(first.content.includes('- [ ] 手写事项'));
  assert(first.content.endsWith('# Note\n\n保留的研究内容\n'));
  assert(!first.content.includes('<!--'));
  const again = h.reconcile(first.content, [makeTask()], first.items, settings, day);
  assert.equal(again.content, first.content);
  assert.equal(again.added, 0); assert.equal(again.updated, 0);
});
test('updates owned completion/title, preserves removed and rescheduled snapshots', () => {
  const first = own(note);
  const done = h.reconcile(first.content, [makeTask('a', '修改后标题', { status: 'done' })], first.items, settings, day);
  assert(done.content.includes('- [x] 修改后标题'));
  assert.equal(done.updated, 1);
  for (const tasks of [[], [makeTask('a', '不更新历史快照', { focusDate: '2099-01-01' })]]) {
    assert.equal(h.reconcile(first.content, tasks, first.items, settings, day).content, first.content);
  }
  const canceled = h.reconcile(first.content, [makeTask('a', '写论文', { status: 'canceled' })], first.items, settings, day);
  assert(canceled.content.includes('- [-] 写论文'));
});
test('never adopts handwriting by default; explicit unique adoption is available', () => {
  const manual = note.replace('手写事项', '写论文');
  const skipped = own(manual);
  assert.equal(skipped.content, manual);
  assert.equal(skipped.conflicts.length, 1);
  assert.equal(Object.keys(skipped.items).length, 0);
  const adopt = h.reconcile(manual, [makeTask('a', '写论文', { status: 'done' })], {}, { ...settings, adoptExactMatches: true }, day);
  assert.equal(adopt.adopted, 1); assert(adopt.content.includes('- [x] 写论文'));
});
test('ambiguous/edited/moved rows are protected', () => {
  const first = own(note);
  const edited = first.content.replace('- [ ] 写论文', '- [x] 写论文（我的备注）');
  const conflict = h.reconcile(edited, [makeTask('a', '写论文', { status: 'done' })], first.items, settings, day);
  assert.equal(conflict.content, edited); assert.equal(conflict.conflicts.length, 1);
  const duplicated = first.content.replace('- [ ] 写论文', '- [ ] 写论文\n- [ ] 写论文');
  assert.equal(h.reconcile(duplicated, [makeTask()], first.items, settings, day).content, duplicated);
  const manual = note.replace('手写事项', '写论文\n- [ ] 写论文');
  assert.equal(h.reconcile(manual, [makeTask()], {}, { ...settings, adoptExactMatches: true }, day).content, manual);
  const duplicateTempo = h.reconcile(note, [makeTask('a'), makeTask('b')], {}, settings, day);
  assert.equal(duplicateTempo.added, 0); assert.equal(duplicateTempo.content, note);
});
test('ignores frontmatter/code headings and refuses genuinely duplicate sections', () => {
  const base = '---\nname: "# Day planner"\n---\n```md\n# Day planner\n```\n' + note;
  const first = own(base);
  assert(first.content.startsWith(base.slice(0, base.indexOf('# Day planner\n\n'))));
  assert.throws(() => own(note + '\n# Day planner\n'), /多个/);
  const crlf = note.replace(/\n/g, '\r\n');
  const changed = own(crlf).content;
  assert(!/(?<!\r)\n/.test(changed));
});
test('malformed Tempo schemas and directory escapes do not produce writes', () => {
  assert.throws(() => h.parseTempo('{'), /JSON/);
  assert.throws(() => h.parseTempo(JSON.stringify({ schemaVersion: 2 })), /不受支持/);
  for (const path of ['../x', '/tmp/x', 'C:/x', 'a/../b']) assert.throws(() => h.relativePath(path));
  assert.equal(h.relativePath('Day_Planner'), 'Day_Planner');
});
function harness(content = note, tasks = [makeTask()]) {
  const plugin = new Plugin();
  const folder = '.obsidian/plugins/tempo-diary-sync';
  const diary = `Day_Planner/${day}.md`;
  const sourcePath = '.obsidian/plugins/crisp-tempo/data.json';
  const files = new Map([[sourcePath, JSON.stringify({ schemaVersion: 1, database: { schemaVersion: 1, tasks: Object.fromEntries(tasks.map(t => [t.id, t])) } })]]);
  if (content !== null) files.set(diary, content);
  const sourceBefore = files.get(sourcePath);
  const adapter = { exists: async p => files.has(p) || p === folder || p === 'Day_Planner', read: async p => { if (!files.has(p)) throw Error('missing ' + p); return files.get(p); }, write: async (p, text) => { files.set(p, text); }, mkdir: async p => { files.set(p, ''); } };
  plugin.data = { schemaVersion: 1, settings: { ...settings, templatePath: '' }, records: {}, pending: null };
  plugin.manifest = { id: 'tempo-diary-sync', dir: folder };
  plugin.app = { vault: { configDir: '.obsidian', adapter,
    getAbstractFileByPath: path => files.has(path) ? { path, extension: 'md' } : null,
    process: async (file, callback) => { files.set(file.path, callback(files.get(file.path))); },
    create: async (path, text) => { if (files.has(path)) throw Error('exists'); files.set(path, text); },
    createFolder: async path => { files.set(path, ''); },
  } };
  plugin.saveData = async data => { files.set(`${folder}/data.json`, JSON.stringify(data)); };
  return { plugin, files, diary, sourcePath, sourceBefore, folder };
}
test('actual sync backs up preimage, writes no Tempo data and persists ownership', async () => {
  const harn = harness();
  const { plugin, files, diary, sourcePath, sourceBefore, folder } = harn;
  await plugin.sync();
  assert(files.get(diary).includes('- [ ] 写论文'));
  const backups = [...files].filter(([path]) => path.startsWith(folder + '/backups/') && path.endsWith('.md'));
  assert.equal(backups.length, 1); assert.equal(backups[0][1], note);
  assert.equal(files.get(sourcePath), sourceBefore);
  assert.equal(plugin.data.pending, null);
  assert.equal(plugin.data.records[diary].items.a.lastLine, '- [ ] 写论文');
  const before = files.get(diary); await plugin.sync(); assert.equal(files.get(diary), before);
  assert.equal([...files.keys()].filter(p => p.endsWith('.md')).length, 2);
});
test('missing diaries are created only for selected tasks; historical records are frozen', async () => {
  const harn = harness(null);
  harn.files.set('Day_Planner/2020-01-01.md', '# Day planner\n- [ ] 历史快照\n');
  await harn.plugin.sync();
  assert(harn.files.get(harn.diary).includes('- [ ] 写论文'));
  assert.equal(harn.files.get('Day_Planner/2020-01-01.md'), '# Day planner\n- [ ] 历史快照\n');
  const none = harness(null, []); await none.plugin.sync(); assert(!none.files.has(none.diary));
});
test('failed state persistence prevents diary modification', async () => {
  const harn = harness();
  harn.plugin.saveData = async () => { throw Error('disk full'); };
  await harn.plugin.sync();
  assert.equal(harn.files.get(harn.diary), note);
  assert.match(harn.plugin.lastReport.error, /disk full/);
});
test('concurrent edits are preserved and do not leave a blocking pending journal', async () => {
  const harn = harness();
  const edited = note + '\n正在输入的内容\n';
  harn.plugin.app.vault.process = async (file, callback) => { harn.files.set(file.path, edited); callback(edited); };
  await harn.plugin.sync();
  assert.equal(harn.files.get(harn.diary), edited);
  assert.equal(harn.plugin.data.pending, null);
  assert.match(harn.plugin.lastReport.error, /正在被编辑/);
});
test('crash recovery commits matching written notes, but never overwrites changed notes', async () => {
  const harn = harness(); const after = own(note);
  harn.plugin.data.pending = { path: harn.diary, date: day, before: note, after: after.content, record: { date: day, items: clean(after.items) } };
  harn.files.set(harn.diary, after.content);
  await harn.plugin.recoverPending();
  assert.equal(harn.plugin.data.records[harn.diary].items.a.lastLine, '- [ ] 写论文');
  assert.equal(harn.plugin.data.pending, null);
  harn.plugin.data.pending = { path: harn.diary, date: day, before: note, after: after.content, record: { date: day, items: clean(after.items) } };
  harn.files.set(harn.diary, after.content + '\n后续手写');
  await assert.rejects(() => harn.plugin.recoverPending(), /暂停同步/);
  assert(harn.files.get(harn.diary).endsWith('后续手写'));
});

test('startup never writes Tempo tasks; display-only Pulse bridge may observe startup', async () => {
  const plugin = new Plugin();
  const ribbons = [], commands = [];
  let syncCalls = 0;
  plugin.app = {
    vault: { adapter: {}, getMarkdownFiles: () => [] },
    metadataCache: { getFileCache: () => null },
    workspace: { onLayoutReady(callback) { callback(); }, getLeavesOfType: () => [] },
  };
  plugin.loadData = async () => ({ schemaVersion: 1, settings: { ...settings, enabled: true }, records: {}, pending: null });
  plugin.addSettingTab = () => {};
  plugin.addCommand = command => commands.push(command);
  plugin.addRibbonIcon = (icon, title, callback) => ribbons.push({ icon, title, callback });
  plugin.registerInterval = id => clearInterval(id);
  plugin.sync = async manual => { assert.equal(manual, true); syncCalls++; };
  await plugin.onload();
  assert.equal(syncCalls, 0);
  assert.equal(ribbons.length, 1);
  assert.equal(ribbons[0].icon, 'clipboard-check');
  assert.equal(ribbons[0].title, '同步 Tempo 到今日日记');
  ribbons[0].callback();
  assert.equal(syncCalls, 1);
  commands.find(command => command.id === 'sync-now').callback();
  assert.equal(syncCalls, 2);
  assert.equal(plugin.pulseDiary.entries.size, 0);
  plugin.onunload();
});

const focusEntry = (id, extra = {}) => ({
  id, startedAt: new Date(`${day}T09:00:00`).getTime(), endedAt: new Date(`${day}T09:25:00`).getTime(),
  minutes: 25, completed: true, pomodoro: false, ...extra,
});
test('tomatoes count today completed task sessions, not minutes, interruptions or other dates', () => {
  const yesterday = new Date(`${day}T09:25:00`).getTime() - 86400000;
  const entries = [focusEntry('single'), focusEntry('pomodoro', { pomodoro: true }),
    focusEntry('single'), focusEntry('cut', { completed: false }),
    focusEntry('old', { startedAt: yesterday - 1500000, endedAt: yesterday }),
    focusEntry('invalid', { minutes: 0 })];
  assert.equal(h.countCompletedFocus(entries, day, settings), 2);
  assert.equal(h.countCompletedFocus(entries, day, { tomatoScope: 'total' }), 3);
  assert.equal(h.countCompletedFocus(entries, day, { strictPomodoro: true }), 1);
  assert.equal(h.countCompletedFocus([focusEntry('long', { minutes: 100 })], day), 1);
  assert.equal(h.countCompletedFocus(undefined, day), 0);
  assert.throws(() => h.countCompletedFocus('bad', day), /记录格式异常/);
});
test('an owned row upgrades to emojis, changes the count once, and remains idempotent', () => {
  const initial = own(note);
  const withTwo = h.reconcile(initial.content, [makeTask()], initial.items, settings, day, { a: 2 });
  assert(withTwo.content.includes('- [ ] 写论文 🍅🍅'));
  const again = h.reconcile(withTwo.content, [makeTask()], withTwo.items, settings, day, { a: 2 });
  assert.equal(again.content, withTwo.content); assert.equal(again.updated, 0);
  const withThree = h.reconcile(again.content, [makeTask()], again.items, settings, day, { a: 3 });
  assert(withThree.content.includes('- [ ] 写论文 🍅🍅🍅'));
  assert(!withThree.content.includes('🍅🍅🍅🍅'));
  const zero = h.reconcile(withThree.content, [makeTask()], withThree.items, settings, day, { a: 0 });
  assert(zero.content.includes('- [ ] 写论文\n'));
  assert(!zero.content.includes('🍅'));
});
test('existing handwritten tomato suffixes are never silently adopted or duplicated', () => {
  const manual = note.replace('手写事项', '写论文 🍅🍅');
  for (const adoptExactMatches of [true, false]) {
    const result = h.reconcile(manual, [makeTask()], {}, { ...settings, adoptExactMatches }, day, { a: 3 });
    assert.equal(result.content, manual);
    assert.equal(result.conflicts.length, 1);
  }
});
test('actual manual sync reads task focusLog and leaves source and diary tomato property intact', async () => {
  const originalDiary = '---\ntomato: 12\n---\n' + note;
  const harn = harness(originalDiary);
  const originalSource = JSON.parse(harn.files.get(harn.sourcePath));
  originalSource.focusLog = { a: [focusEntry('one'), focusEntry('two', { pomodoro: true }), focusEntry('cut', { completed: false })] };
  harn.files.set(harn.sourcePath, JSON.stringify(originalSource));
  const sourceBefore = harn.files.get(harn.sourcePath);
  await harn.plugin.sync(true);
  const written = harn.files.get(harn.diary);
  assert(written.includes('- [ ] 写论文 🍅🍅'));
  assert(written.startsWith('---\ntomato: 12\n---\n'));
  assert.equal(harn.files.get(harn.sourcePath), sourceBefore);
  await harn.plugin.sync(true);
  assert.equal(harn.files.get(harn.diary), written);
});

test('diary tomato values accept explicit zero and reject blanks, fractions and coercions', () => {
  for (const [raw, expected] of [[0, 0], ['0', 0], [' 12 ', 12], [12, 12], [null, null], ['', null], [' ', null], [false, null], [[], null], [-1, null], [1.5, null], ['1.5', null], ['1e2', null], [Infinity, null], [Number.MAX_SAFE_INTEGER + 1, null]]) {
    assert.equal(h.parseDiaryTomato(raw), expected);
  }
});
test('collects valid direct diary dates only; disabling/deleting a field removes the overlay', () => {
  const notes = new Map([
    ['Day_Planner/2026-10-21.md', { tomato: '12' }],
    ['Day_Planner/2026-10-22.md', { tomato: 0 }],
    ['Day_Planner/2026-10-23.md', { tomato: null }],
    ['Day_Planner/2026-10-24.md', { tomato: -1 }],
    ['Day_Planner/2026-10-25.md', {}],
    ['Day_Planner/2099-10-21.md', { tomato: 5 }],
    ['Day_Planner/2026-02-30.md', { tomato: 5 }],
    ['Day_Planner/sub/2026-10-21.md', { tomato: 5 }],
    ['Day_Planner-other/2026-10-21.md', { tomato: 5 }],
    ['Day_Planner/日报.md', { tomato: 5 }],
  ]);
  const files = [...notes.keys()].map(path => ({ path }));
  const collect = extra => h.collectDiaryTomatoes(files, f => notes.get(f.path), { ...settings, ...extra }, '2026-10-28');
  const entries = collect();
  assert.equal(entries.size, 2); assert.equal(entries.get('2026-10-21').count, 12); assert.equal(entries.get('2026-10-22').count, 0);
  assert.equal(collect({ pulseDiaryEnabled: false }).size, 0);
  delete notes.get('Day_Planner/2026-10-21.md').tomato;
  assert.equal(collect().size, 1);
  assert.throws(() => collect({ pulseDiaryFolder: '../elsewhere' }), /相对路径/);
});

const displayNow = new Date('2026-10-28T12:00:00');
function pulseFixture() {
  const daily = {
    '2026-10-21': { quality: 'estimated', activity: { focusSessions: [{ pomodoro: true, completed: true, minutes: 25 }] }, contribution: { score: 9 } },
    '2026-10-22': { quality: 'recorded', activity: { focusSessions: [{ pomodoro: true, completed: true, minutes: 25 }] }, contribution: { score: 7 } },
    '2026-10-23': { quality: 'recorded', activity: { focusSessions: [{ pomodoro: true, completed: true, minutes: 25 }] }, contribution: { score: 3 } },
  };
  return {
    manifest: { version: '1.34.0' }, store: { daily }, settings: { dataQualityScope: 'all' },
    recordMatchesScope: (rec, date, scope) => date <= '2026-10-28' && (scope === 'all' || rec.quality === 'recorded'),
    calculateIntensities(metric = 'contribution', scope = this.settings.dataQualityScope) {
      const getVal = rec => metric === 'pomodoro' ? rec.activity.focusSessions.filter(s => s.pomodoro && s.completed).length : rec.contribution.score;
      return { map: new Map(Object.entries(daily).map(([date, rec]) => [date, { value: this.recordMatchesScope(rec, date, scope) ? getVal(rec) : 0, level: 0, percentile: 0 }])), getVal };
    },
  };
}
const entryMap = () => new Map([
  ['2026-10-21', { date: '2026-10-21', path: 'Day_Planner/2026-10-21.md', field: 'tomato', count: 12 }],
  ['2026-10-22', { date: '2026-10-22', path: 'Day_Planner/2026-10-22.md', field: 'tomato', count: 0 }],
  ['2026-10-24', { date: '2026-10-24', path: 'Day_Planner/2026-10-24.md', field: 'tomato', count: 5 }],
]);
test('heatmap replaces rather than adds; supports diary-only history without touching source records', () => {
  const pulse = pulseFixture(), before = JSON.stringify(pulse.store);
  const base = pulse.calculateIntensities('pomodoro', 'all'), entries = entryMap();
  const result = h.diaryIntensityOverlay(base, pulse, entries, 'all', displayNow);
  assert.equal(result.map.get('2026-10-21').value, 12);
  assert.equal(result.map.get('2026-10-22').value, 0);
  assert.equal(result.map.get('2026-10-23').value, 1);
  assert.equal(result.map.get('2026-10-24').value, 5);
  assert.equal(result.getVal(pulse.store.daily['2026-10-21']), 12);
  assert.equal(base.map.get('2026-10-21').value, 1);
  assert.equal(result.map.get('2026-10-21').level, 5);
  assert.equal(JSON.stringify(pulse.store), before);
  assert.equal(pulse.store.daily['2026-10-24'], undefined);
  const removed = h.diaryIntensityOverlay(base, pulse, new Map(), 'all', displayNow);
  assert.equal(removed.map.get('2026-10-21').value, 1);
  assert.equal(removed.map.has('2026-10-24'), false);
});
test('Pulse reliable scopes stay intact; diary-only history is not mislabeled recorded', () => {
  const pulse = pulseFixture();
  const result = h.diaryIntensityOverlay(pulse.calculateIntensities('pomodoro', 'reliable'), pulse, entryMap(), 'reliable', displayNow);
  assert.equal(result.map.get('2026-10-21').value, 0);
  assert.equal(result.map.has('2026-10-24'), false);
  assert.equal(result.map.get('2026-10-22').value, 0);
  assert.equal(result.map.get('2026-10-23').value, 1);
  assert.throws(() => h.diaryIntensityOverlay({}, pulse, entryMap(), 'all', displayNow), /接口已变化/);
});
function bridgeFixture() {
  const pulse = pulseFixture(), owner = { data: { settings: { ...settings } }, app: {} };
  const views = [];
  owner.app = {
    plugins: { plugins: { 'crisp-pulse': pulse } },
    workspace: { getLeavesOfType: () => views.map(view => ({ view })) },
    vault: { getMarkdownFiles: () => [{ path: 'Day_Planner/2026-10-21.md' }] },
    metadataCache: { getFileCache: () => ({ frontmatter: { tomato: 12 } }) },
  };
  const bridge = new h.PulseDiaryBridge(owner);
  return { owner, pulse, views, bridge };
}
test('bridge reconnects after Pulse replacement; unloading restores inherited methods and Focus counts', () => {
  const { owner, pulse, views, bridge } = bridgeFixture();
  const original = pulse.calculateIntensities, stored = JSON.stringify(pulse.store);
  const prototype = { render() { this.renders = (this.renders || 0) + 1; }, plugin: pulse };
  const view = Object.create(prototype); views.push(view);
  bridge.refresh();
  assert.equal(pulse.calculateIntensities('pomodoro', 'all').map.get('2026-10-21').value, 12);
  const score = pulse.calculateIntensities('contribution', 'all');
  assert.equal(score.map.get('2026-10-21').value, 9);
  assert.equal(JSON.stringify(pulse.store), stored);
  assert(Object.hasOwn(view, 'render'));
  const newer = pulseFixture(); owner.app.plugins.plugins['crisp-pulse'] = newer; view.plugin = newer;
  bridge.connect();
  assert.equal(pulse.calculateIntensities, original);
  assert.equal(newer.calculateIntensities('pomodoro', 'all').map.get('2026-10-21').value, 12);
  bridge.dispose();
  assert.equal(newer.calculateIntensities('pomodoro', 'all').map.get('2026-10-21').value, 1);
  assert.equal(Object.hasOwn(view, 'render'), false);
  assert.equal(view.render, prototype.render);
});
test('disabling bridge or missing Pulse is safe; changed methods are not overwritten during cleanup', () => {
  const { owner, pulse, bridge } = bridgeFixture();
  bridge.refresh(); owner.data.settings.pulseDiaryEnabled = false; bridge.refresh();
  assert.equal(pulse.calculateIntensities('pomodoro', 'all').map.get('2026-10-21').value, 1);
  owner.data.settings.pulseDiaryEnabled = true; bridge.refresh();
  const external = function() { return 'new implementation'; };
  pulse.calculateIntensities = external; bridge.dispose(); assert.equal(pulse.calculateIntensities, external);
  const another = bridgeFixture(); delete another.owner.app.plugins.plugins['crisp-pulse'];
  another.bridge.refresh(); assert.match(another.bridge.status, /等待启用/); another.bridge.dispose();
});
