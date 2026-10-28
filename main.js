/* Independent local companion for Crisp Tempo and Pulse. No source-file patches. */
const { Plugin, PluginSettingTab, Setting, Notice, Modal, moment } = require('obsidian');

const DEFAULT_SETTINGS = {
  diaryFolder: 'Day_Planner',
  heading: 'Day planner',
  templatePath: 'Template/日报.md',
  createMissingDiary: true,
  adoptExactMatches: false,
  tomatoScope: 'day',
  strictPomodoro: false,
  pulseDiaryEnabled: true,
  pulseDiaryFolder: 'Day_Planner',
  pulseDiaryField: 'tomato',
};
const WRITE_QUEUE = Symbol.for('tempo-diary-sync.write-queue');

function localDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function relativePath(value, allowEmpty = false) {
  const path = String(value ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if ((!path && !allowEmpty) || path.startsWith('/') || /^[A-Za-z]:/.test(path)
    || path.split('/').some(part => part === '..' || part === '.')) throw new Error('目录必须是库内相对路径，不能包含 ..');
  return path;
}
function taskTitle(task) { return String(task.title || '').replace(/[\r\n]+/g, ' ').trim(); }
function taskLine(task, tomatoCount = 0) {
  const count = Number.isSafeInteger(tomatoCount) && tomatoCount >= 0 && tomatoCount <= 500 ? tomatoCount : 0;
  return `- [${task.status === 'done' ? 'x' : task.status === 'canceled' ? '-' : ' '}] ${taskTitle(task)}${count ? ' ' + '🍅'.repeat(count) : ''}`;
}
function countCompletedFocus(entries, day, settings = {}) {
  if (entries == null) return 0;
  if (!Array.isArray(entries)) throw new Error('Tempo 专注记录格式异常，本次不改写日记');
  const seen = new Set();
  let count = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)
      || entry.completed !== true || typeof entry.pomodoro !== 'boolean'
      || !Number.isFinite(entry.startedAt) || !Number.isFinite(entry.endedAt)
      || !Number.isFinite(entry.minutes) || entry.minutes < 1 || entry.minutes > 240) continue;
    const endedDay = localDate(entry.endedAt);
    if (endedDay > day || (settings.tomatoScope !== 'total' && endedDay !== day)) continue;
    if (settings.strictPomodoro && !entry.pomodoro) continue;
    seen.add(entry.id); count++;
  }
  return Math.min(500, count);
}
function parseTempo(raw) {
  const data = JSON.parse(raw);
  const db = data?.database;
  if (data?.schemaVersion !== 1 || db?.schemaVersion !== 1 || !db.tasks || Array.isArray(db.tasks) || typeof db.tasks !== 'object') {
    throw new Error('Tempo 数据结构不受支持；已暂停本次写入');
  }
  const tasks = Object.values(db.tasks);
  const allowed = new Set(['todo', 'in_progress', 'waiting', 'done', 'canceled']);
  for (const [id, task] of Object.entries(db.tasks)) {
    if (!task || task.id !== id || typeof task.title !== 'string' || !allowed.has(task.status)) {
      throw new Error('Tempo 任务数据不完整；已暂停本次写入');
    }
  }
  return tasks;
}
// Same membership rules as Tempo 0.6.1's Today view; only top-level tasks.
function isTodayTask(task, today) {
  if (task.parentTaskId || task.availability === 'someday' || task.triage !== 'processed') return false;
  if (task.status === 'done') return typeof task.completedAt === 'number'
    ? localDate(task.completedAt) === today : task.focusDate === today || task.dueDate === today;
  if (task.status === 'canceled') return false;
  return ['focusDate', 'startDate', 'dueDate'].some(key => typeof task[key] === 'string' && task[key] && task[key] <= today);
}
function scanLines(content) {
  const lines = content.split('\n');
  const active = [];
  let fence = null, yaml = lines[0]?.replace(/\r$/, '') === '---';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (yaml) {
      active.push(false);
      if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) yaml = false;
      continue;
    }
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      active.push(false); continue;
    }
    active.push(!fence);
  }
  return { lines, active };
}
function locateSection(content, heading) {
  const { lines, active } = scanLines(content);
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const match = active[i] && /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(lines[i].replace(/\r$/, ''));
    if (match) headings.push({ index: i, level: match[1].length, text: match[2].trim() });
  }
  const found = headings.filter(h => h.text.toLowerCase() === heading.toLowerCase());
  if (found.length > 1) throw new Error(`有多个“${heading}”标题，无法安全确定同步位置`);
  if (!found.length) return null;
  const target = found[0];
  const end = headings.find(h => h.index > target.index && h.level <= target.level)?.index ?? lines.length;
  return { lines, active, start: target.index, end };
}
function reconcile(content, tasks, previousItems, settings, today, tomatoCounts = {}) {
  const originalContent = content;
  const heading = String(settings.heading || 'Day planner').replace(/^#+\s*/, '').trim();
  if (!heading || /[\r\n]/.test(heading)) throw new Error('同步标题不能为空或包含换行');
  const all = new Map(tasks.map(task => [task.id, task]));
  const selected = tasks.filter(task => isTodayTask(task, today));
  // A canceled, previously owned task stays in today's record as a canceled row.
  for (const id of Object.keys(previousItems)) {
    const task = all.get(id);
    if (task?.status === 'canceled' && !selected.some(t => t.id === id)) selected.push(task);
  }
  selected.sort((a, b) => String(a.order || '').localeCompare(String(b.order || '')) || a.id.localeCompare(b.id));
  const report = { added: 0, updated: 0, adopted: 0, preserved: 0, conflicts: [], total: selected.length };
  const items = JSON.parse(JSON.stringify(previousItems));
  if (!selected.length) return { content, items, ...report, preserved: Object.keys(items).length };
  let section = locateSection(content, heading);
  if (!section) {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    content += `${content && !content.endsWith('\n') ? eol : ''}${content ? eol : ''}# ${heading}${eol}${eol}`;
    section = locateSection(content, heading);
  }
  const { lines, active, start, end } = section;
  const eolSuffix = content.includes('\r\n') ? '\r' : '';
  const rows = [];
  for (let i = start + 1; i < end; i++) {
    if (!active[i]) continue;
    const line = lines[i].replace(/\r$/, '');
    const match = /^\s*[-*+] \[[^\]]\] (.*)$/.exec(line);
    if (match) rows.push({ index: i, line, title: match[1].trim() });
  }
  const titleCounts = new Map();
  for (const task of selected) titleCounts.set(taskTitle(task), (titleCounts.get(taskTitle(task)) || 0) + 1);
  const used = new Set(), append = [];
  for (const task of selected) {
    const title = taskTitle(task), desired = taskLine(task, tomatoCounts[task.id]), old = items[task.id];
    if (!title || titleCounts.get(title) > 1) {
      report.conflicts.push(`Tempo 中任务标题为空或重名：${title || task.id}`); continue;
    }
    let row;
    if (old) {
      const matches = rows.filter(r => r.line === old.lastLine && !used.has(r.index));
      if (matches.length !== 1) { report.conflicts.push(`已同步行被手动修改、移出该段或出现重名，保留原文：${title}`); continue; }
      row = matches[0];
      if (rows.some(r => r.index !== row.index && r.title.replace(/[ \t]*🍅+$/u, '').trim() === title)) {
        report.conflicts.push(`更新后会与现有手写任务同名，保留原文：${title}`); continue;
      }
    } else {
      const matches = rows.filter(r => r.title.replace(/[ \t]*🍅+$/u, '').trim() === title);
      if (matches.length) {
        if (!settings.adoptExactMatches || matches.length !== 1 || matches[0].title !== title || used.has(matches[0].index)) {
          report.conflicts.push(`日记已有同名任务，未重复添加或接管：${title}`); continue;
        }
        row = matches[0]; report.adopted++;
      }
    }
    if (row) {
      used.add(row.index);
      if (row.line !== desired) { lines[row.index] = desired + eolSuffix; report.updated++; }
    } else { append.push(desired + eolSuffix); report.added++; }
    items[task.id] = { id: task.id, title, lastLine: desired };
  }
  if (append.length) {
    let at = end;
    while (at > start + 1 && !lines[at - 1].trim()) at--;
    if (at === start + 1 && at < end && !lines[at].trim()) at++;
    if (at === start + 1) append.unshift(eolSuffix);
    if (at === end && end < lines.length) append.push(eolSuffix);
    lines.splice(at, 0, ...append);
  }
  // Never create a heading when all selected tasks were skipped.
  report.preserved = Object.keys(previousItems).filter(id => !selected.some(t => t.id === id)).length;
  return { content: report.added || report.updated ? lines.join('\n') : originalContent, items, ...report };
}

function expandTemplate(template, day, momentFn, now = new Date()) {
  if (typeof momentFn !== 'function' && /\{\{(?:date|time)/.test(template)) throw new Error('日期模板运行时不可用，未创建日记');
  return template.replace(/\{\{\s*(date|time)(?::\s*([^}]+))?\s*\}\}/g, (_, kind, format) =>
    kind === 'date' ? momentFn(day, 'YYYY-MM-DD').format((format || 'YYYY-MM-DD').trim())
      : momentFn(now).format((format || 'HH:mm').trim())).replace(/\{\{title\}\}/g, day);
}

function parseDiaryTomato(value) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return null;
    value = Number(value.trim());
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function collectDiaryTomatoes(files, frontmatterFor, settings, today = localDate()) {
  const entries = new Map();
  if (!settings.pulseDiaryEnabled) return entries;
  const folder = relativePath(settings.pulseDiaryFolder, true);
  const field = String(settings.pulseDiaryField || '').trim();
  if (!field || /[\r\n]/.test(field)) throw new Error('日记番茄字段不能为空或包含换行');
  const prefix = folder ? folder + '/' : '';
  for (const file of files) {
    if (!file?.path?.startsWith(prefix)) continue;
    const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(file.path.slice(prefix.length));
    if (!match || match[1] > today) continue;
    const date = match[1];
    if (localDate(new Date(date + 'T12:00:00')) !== date) continue;
    const fm = frontmatterFor(file);
    if (!fm || !Object.prototype.hasOwnProperty.call(fm, field)) continue;
    const count = parseDiaryTomato(fm[field]);
    if (count !== null) entries.set(date, { date, count, path: file.path, field });
  }
  return entries;
}

// Overlay the displayed metric only. Never insert sessions or mutate Pulse's store.
function diaryIntensityOverlay(base, pulse, entries, scope, now = new Date()) {
  if (!base?.map || typeof base.map.get !== 'function' || typeof base.map[Symbol.iterator] !== 'function'
    || typeof base.getVal !== 'function') throw new Error('Pulse 番茄热力图接口已变化');
  const daily = pulse.store.daily;
  const accepted = new Map(), recordCounts = new WeakMap();
  const values = new Map([...base.map].map(([date, info]) => [date, { ...info }]));
  const today = localDate(now);
  const actualScope = scope || pulse.settings?.dataQualityScope || 'reliable';
  for (const [date, entry] of entries) {
    if (date > today) continue;
    // Diary-only history remains outside Pulse's reliable/recorded scopes.
    const record = daily[date] || { quality: 'estimated' };
    if (!pulse.recordMatchesScope(record, date, actualScope)) continue;
    accepted.set(date, entry);
    values.set(date, { value: entry.count });
    if (daily[date]) recordCounts.set(daily[date], entry.count);
  }
  const positive = [];
  for (const [date, info] of values) {
    const time = new Date(date + 'T00:00:00').getTime();
    if (info.value > 0 && time <= now.getTime() && now.getTime() - time <= 90 * 86400000) positive.push(info.value);
  }
  positive.sort((a, b) => a - b);
  for (const [date, info] of values) {
    const value = info.value || 0;
    let percentile = 0, level = 0;
    if (value > 0 && positive.length) {
      let low = 0, high = positive.length;
      while (low < high) { const middle = (low + high) >>> 1; if (positive[middle] <= value) low = middle + 1; else high = middle; }
      percentile = Math.round(low / positive.length * 100);
      level = percentile > 90 ? 5 : percentile > 75 ? 4 : percentile > 50 ? 3 : percentile > 25 ? 2 : 1;
    }
    values.set(date, { ...info, value, level, percentile, ...(accepted.has(date) ? { diarySource: accepted.get(date) } : {}) });
  }
  return { ...base, map: values, getVal: record => record && recordCounts.has(record) ? recordCounts.get(record) : base.getVal(record) };
}

class PulseDiaryBridge {
  constructor(owner) { this.owner = owner; this.app = owner.app; this.entries = new Map(); this.patches = []; this.views = new Map(); this.status = '尚未读取日记'; }
  start() {
    const listen = (target, event, callback) => {
      if (typeof target?.on === 'function') this.owner.registerEvent(target.on(event, callback));
    };
    listen(this.app.metadataCache, 'changed', file => { if (this.isDiary(file?.path)) this.schedule(); });
    listen(this.app.metadataCache, 'resolved', () => this.schedule());
    listen(this.app.vault, 'delete', file => { if (this.isDiary(file?.path)) this.schedule(); });
    listen(this.app.vault, 'rename', (file, oldPath) => { if (this.isDiary(file?.path) || this.isDiary(oldPath)) this.schedule(); });
    listen(this.app.workspace, 'layout-change', () => this.schedule());
    this.owner.registerInterval(window.setInterval(() => {
      if (this.disposed) return;
      if (this.day !== localDate()) this.refresh(); else this.connect();
    }, 5000));
    const ready = () => { if (!this.disposed) this.refresh(); };
    if (typeof this.app.workspace?.onLayoutReady === 'function') this.app.workspace.onLayoutReady(ready); else ready();
  }
  isDiary(path) {
    try {
      const folder = relativePath(this.owner.data.settings.pulseDiaryFolder, true);
      return typeof path === 'string' && path.startsWith(folder ? folder + '/' : '') && path.endsWith('.md');
    } catch (_) { return false; }
  }
  schedule() {
    if (this.disposed) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; this.refresh(); }, 250);
  }
  refresh(notify = false) {
    if (this.disposed) return;
    try {
      const settings = this.owner.data.settings;
      this.day = localDate();
      this.entries = collectDiaryTomatoes(this.app.vault.getMarkdownFiles(), file => this.app.metadataCache.getFileCache(file)?.frontmatter, settings, this.day);
      this.readError = null;
    } catch (error) { this.entries = new Map(); this.readError = error.message; }
    this.connect();
    this.redraw();
    if (notify) new Notice(this.summary(), 9000);
  }
  summary() {
    const total = [...this.entries.values()].reduce((sum, entry) => sum + entry.count, 0);
    return `${this.status}\n已读取 ${this.entries.size} 天日记，共 ${total} 个番茄。\n日记数覆盖当天热力图数量，不与 Focus 相加；查看历史请选“全部历史”。\nFocus 会话、时长、贡献分和日记原文不变。`;
  }
  wrap(object, key, factory, list = this.patches) {
    const original = object[key], descriptor = Object.getOwnPropertyDescriptor(object, key);
    const wrapped = factory(original);
    object[key] = wrapped;
    const patch = { object, key, original, wrapped, descriptor };
    list.push(patch); return patch;
  }
  restore(list) {
    for (const patch of list.reverse()) {
      if (patch.object[patch.key] !== patch.wrapped) continue;
      if (patch.descriptor) Object.defineProperty(patch.object, patch.key, patch.descriptor); else delete patch.object[patch.key];
    }
    list.length = 0;
  }
  detach() {
    this.restore(this.patches);
    for (const patches of this.views.values()) this.restore(patches);
    this.views.clear(); this.pulse = null;
  }
  connect() {
    if (this.disposed) return;
    const candidate = this.app.plugins?.plugins?.['crisp-pulse'];
    const enabled = this.owner.data.settings.pulseDiaryEnabled && !this.owner.blocked && !this.readError;
    const available = candidate && !candidate.stopped && !candidate.storeRetired && candidate.store?.daily;
    const compatible = available && typeof candidate.calculateIntensities === 'function' && typeof candidate.recordMatchesScope === 'function';
    const changed = this.pulse !== candidate || this.patches.some(p => p.object[p.key] !== p.wrapped);
    if (!enabled || !compatible || changed) this.detach();
    if (!enabled) { this.status = this.readError || this.owner.blocked || '日记番茄展示已关闭'; return; }
    if (!available) { this.status = '等待启用 Crisp Pulse；启用后自动连接'; return; }
    if (!compatible) { this.status = 'Pulse 接口不兼容，已保留原生显示'; return; }
    let attached = false;
    if (!this.pulse) {
      this.pulse = candidate;
      const bridge = this;
      this.wrap(candidate, 'calculateIntensities', original => function(metric, scope, ...args) {
        const base = original.call(this, metric, scope, ...args);
        if (metric !== 'pomodoro' || bridge.disposed || !bridge.owner.data.settings.pulseDiaryEnabled) return base;
        try { return diaryIntensityOverlay(base, this, bridge.entries, scope); }
        catch (error) { bridge.status = `${error.message}；已保留原生显示`; return base; }
      });
      attached = true;
    }
    this.status = `已连接 Crisp Pulse ${candidate.manifest?.version || ''}：日记番茄用于热力图`;
    const activeViews = new Set((this.app.workspace.getLeavesOfType?.('crisp-pulse-view') || []).map(leaf => leaf.view));
    for (const [view, patches] of this.views) if (!activeViews.has(view)) { this.restore(patches); this.views.delete(view); }
    for (const view of activeViews) {
      if (view.plugin !== candidate || typeof view.render !== 'function') continue;
      const existing = this.views.get(view);
      if (existing && existing.every(p => p.object[p.key] === p.wrapped)) continue;
      if (existing) this.restore(existing);
      const patches = [], bridge = this;
      this.wrap(view, 'render', original => function(...args) {
        const result = original.apply(this, args);
        try { bridge.decorate(this); } catch (error) { console.warn('[Tempo Diary Sync] Pulse display annotation:', error); }
        return result;
      }, patches);
      this.views.set(view, patches); attached = true;
    }
    if (attached) this.redraw();
  }
  redraw() {
    for (const { view } of this.app.workspace.getLeavesOfType?.('crisp-pulse-view') || []) {
      if (typeof view.render !== 'function') continue;
      try { view.intensityCache?.clear(); view.render(); }
      catch (error) { console.warn('[Tempo Diary Sync] Pulse refresh:', error); }
    }
  }
  decorate(view) {
    const root = view.containerEl;
    if (!root?.querySelector || this.disposed) return;
    root.querySelectorAll('.tempo-diary-pulse-note, .tempo-diary-pulse-tab').forEach(el => el.remove());
    const heat = root.querySelector('.pulse-v2-heat');
    if (!heat) return;
    const seg = heat.querySelector('[role="tablist"]');
    const buttons = seg ? [...seg.querySelectorAll('button')] : [];
    if (this.entries.size && seg && !buttons.some(b => /^(番茄|Pomodoros)$/.test(b.textContent?.trim()))) {
      const button = seg.ownerDocument.createElement('button');
      button.className = 'tempo-diary-pulse-tab'; button.textContent = '番茄'; button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(view.selectedMetric === 'pomodoro'));
      button.addEventListener('click', () => {
        // Preserve Pulse's existing paid-feature gate.
        if (typeof this.pulse?.requireEntitlement !== 'function' || !this.pulse.requireEntitlement('heatmapMetrics')) return;
        view.selectedMetric = 'pomodoro'; view.render();
      });
      seg.appendChild(button);
    }
    if (view.selectedMetric !== 'pomodoro') return;
    const { map } = view.intensities('pomodoro', view.currentScope);
    const addNote = (parent, text) => {
      if (!parent) return;
      const note = parent.ownerDocument.createElement('div');
      note.className = 'setting-item-description tempo-diary-pulse-note'; note.textContent = text; parent.appendChild(note);
    };
    addNote(heat.querySelector('.crisp-pulse-heatmap-footer'), '日记番茄：有效字段覆盖当天数量（0 也有效），其他日期沿用 Focus；历史日记请选择“全部历史”。');
    for (const cell of heat.querySelectorAll('[data-date]')) {
      const source = map.get(cell.dataset.date)?.diarySource;
      if (!source) continue;
      const label = (cell.getAttribute('aria-label') || '').split('\n来源：日记')[0];
      cell.setAttribute('aria-label', `${label}\n来源：日记 ${source.path} · ${source.field}: ${source.count}`);
    }
    const source = map.get(view.selectedDate)?.diarySource;
    if (source) addNote(root.querySelector('.crisp-pulse-detail-card'), `番茄：${source.count} 个，来自 ${source.path} 的 ${source.field}。仅用于数量展示，未生成 Focus 会话或推算时长、贡献分。`);
    addNote(root.querySelector('.pulse-v2-pomodoro'), '此卡片显示 Focus 实际计时记录；上方热力图可使用日记番茄数量。');
  }
  dispose() {
    this.disposed = true; window.clearTimeout(this.timer);
    this.detach();
    for (const { view } of this.app.workspace.getLeavesOfType?.('crisp-pulse-view') || []) view.containerEl?.querySelectorAll?.('.tempo-diary-pulse-note, .tempo-diary-pulse-tab').forEach(el => el.remove());
    this.redraw();
  }
}

class ReportModal extends Modal {
  constructor(app, title, text) { super(app); this.title = title; this.text = text; }
  onOpen() { this.contentEl.createEl('h2', { text: this.title }); this.contentEl.createEl('pre', { text: this.text, attr: { style: 'white-space:pre-wrap;user-select:text' } }); }
  onClose() { this.contentEl.empty(); }
}

class TempoDiarySync extends Plugin {
  async onload() {
    this.stopped = false; this.busy = false; this.blocked = null; this.lastReport = null;
    await this.app.vault.adapter[WRITE_QUEUE];
    const raw = await this.loadData();
    if (raw === undefined || (raw !== null && (raw.schemaVersion !== 1 || !raw.records || Array.isArray(raw.records) || typeof raw.records !== 'object'))) {
      this.blocked = '同步插件的数据文件无法安全读取，已暂停写入；原文件保留。';
      this.data = { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS, enabled: false }, records: {}, pending: null };
      new Notice(this.blocked, 10000);
    } else this.data = raw || { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS }, records: {}, pending: null };
    this.data.settings = { ...DEFAULT_SETTINGS, ...this.data.settings };
    this.addSettingTab(new SyncSettings(this.app, this));
    this.addRibbonIcon('clipboard-check', '同步 Tempo 到今日日记', () => { void this.sync(true); });
    this.addCommand({ id: 'sync-now', name: '立即同步今天的 Tempo 任务到日记', callback: () => this.sync(true) });
    this.addCommand({ id: 'preview-sync', name: '预览今天的日记同步（不写入）', callback: () => this.preview() });
    this.addCommand({ id: 'show-status', name: '查看同步状态', callback: () => this.showStatus() });
    this.addCommand({ id: 'open-diary', name: '打开今天的同步日记', callback: () => this.app.workspace.openLinkText(this.diaryPath(), '', false) });
    this.pulseDiary = new PulseDiaryBridge(this);
    this.addCommand({ id: 'refresh-pulse-tomatoes', name: '刷新 Pulse 日记番茄数量（不改写日记）', callback: () => this.pulseDiary.refresh(true) });
    this.addCommand({ id: 'show-pulse-status', name: '查看 Pulse 日记番茄连接状态', callback: () => new ReportModal(this.app, 'Pulse 日记番茄', this.pulseDiary.summary()).open() });
    this.pulseDiary.start();
    // Manual only: opening Obsidian or changing settings never writes a diary.
  }
  onunload() { this.stopped = true; this.pulseDiary?.dispose(); }
  pluginPath() { return this.manifest.dir || `${this.app.vault.configDir || '.obsidian'}/plugins/${this.manifest.id}`; }
  diaryPath(day = localDate()) {
    const folder = relativePath(this.data.settings.diaryFolder, true);
    return `${folder ? folder + '/' : ''}${day}.md`;
  }
  async persist() {
    if (this.blocked) throw new Error(this.blocked);
    const payload = JSON.stringify(this.data);
    const adapter = this.app.vault.adapter;
    const previous = adapter[WRITE_QUEUE] || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await this.saveData(JSON.parse(payload));
      const saved = JSON.parse(await adapter.read(`${this.pluginPath()}/data.json`));
      if (JSON.stringify(saved) !== payload) throw new Error('同步状态没有成功保存；暂停写入日记');
    });
    adapter[WRITE_QUEUE] = next.catch(() => {});
    await next;
  }
  async ensureFolder(path, useVault = false) {
    const adapter = this.app.vault.adapter;
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) {
        if (useVault) await this.app.vault.createFolder(current); else await adapter.mkdir(current);
      }
    }
  }
  async backup(path, content) {
    const folder = `${this.pluginPath()}/backups`;
    await this.ensureFolder(folder);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const target = `${folder}/${path.split('/').pop().replace(/\.md$/, '')}-${stamp}.md`;
    await this.app.vault.adapter.write(target, content);
    if (await this.app.vault.adapter.read(target) !== content) throw new Error('日记备份校验失败，本次不写入');
    return target;
  }
  async recoverPending() {
    const pending = this.data.pending;
    if (!pending) return;
    if (pending.path !== this.diaryPath(pending.date)) throw new Error('未完成写入的目录与当前设置不同，需先处理同步状态');
    const adapter = this.app.vault.adapter;
    const current = await adapter.exists(pending.path) ? await adapter.read(pending.path) : null;
    if (current === pending.after) this.data.records[pending.path] = pending.record;
    else if (current !== pending.before) throw new Error('上次写入后日记发生变化；为保护内容，已暂停同步。请查看同步状态。');
    this.data.pending = null;
    await this.persist();
  }
  async buildPlan() {
    const day = localDate(), path = this.diaryPath(day), adapter = this.app.vault.adapter;
    const source = `${this.app.vault.configDir || '.obsidian'}/plugins/crisp-tempo/data.json`;
    if (!(await adapter.exists(source))) throw new Error('未找到 Crisp Tempo 的数据文件');
    const sourceText = await adapter.read(source);
    const tasks = parseTempo(sourceText);
    const focusLog = JSON.parse(sourceText).focusLog ?? {};
    if (!focusLog || typeof focusLog !== 'object' || Array.isArray(focusLog)) throw new Error('Tempo 专注记录格式异常，本次不改写日记');
    const tomatoCounts = Object.fromEntries(tasks.map(task => [task.id, countCompletedFocus(focusLog[task.id], day, this.data.settings)]));
    const exists = await adapter.exists(path);
    let before = exists ? await adapter.read(path) : null;
    let base = before;
    const items = this.data.records[path]?.items || {};
    if (!exists) {
      if (!tasks.some(task => isTodayTask(task, day))) return { path, day, before, after: null, skipped: '今天没有需要同步的任务', items, conflicts: [], added: 0, updated: 0, adopted: 0, total: 0 };
      if (!this.data.settings.createMissingDiary) throw new Error('今天的日记尚不存在；自动创建已关闭');
      const templatePath = relativePath(this.data.settings.templatePath, true);
      if (templatePath) {
        const templateFile = templatePath.endsWith('.md') ? templatePath : `${templatePath}.md`;
        if (!(await adapter.exists(templateFile))) throw new Error('找不到配置的日记模板，未创建日记');
        base = expandTemplate(await adapter.read(templateFile), day, moment);
      } else base = '';
    }
    const result = reconcile(base, tasks, items, this.data.settings, day, tomatoCounts);
    if (!exists && !result.added) return { ...result, path, day, before, after: null, skipped: '没有可安全写入的任务，未创建日记' };
    return { ...result, path, day, before, after: result.content };
  }
  summary(report) {
    if (!report) return '尚未同步。';
    if (report.error) return `同步暂停：${report.error}`;
    return `${report.path}\nTempo 今天：${report.total || 0} 项；新增 ${report.added || 0}，更新 ${report.updated || 0}，接管 ${report.adopted || 0}。\n${report.skipped || ''}${report.conflicts?.length ? '\n需要处理：\n' + report.conflicts.join('\n') : '\n没有冲突。'}`;
  }
  showStatus() {
    new ReportModal(this.app, 'Tempo 日记同步状态', (this.blocked || this.summary(this.lastReport)) + '\n\n' + (this.pulseDiary?.summary() || '')).open();
  }
  async preview() {
    try {
      const plan = await this.buildPlan();
      new ReportModal(this.app, '同步预览（未写入）', this.summary(plan) + '\n\n' + (plan.after || '不创建或修改日记')).open();
    } catch (error) { new Notice(`Tempo 日记同步：${error.message}`, 8000); }
  }
  async sync(manual = false) {
    if (this.busy || this.stopped || (this.blocked && !manual)) return;
    this.busy = true;
    try {
      if (this.blocked) throw new Error(this.blocked);
      await this.recoverPending();
      const plan = await this.buildPlan();
      if (this.stopped) return;
      const record = { date: plan.day, items: plan.items };
      const previousRecord = this.data.records[plan.path];
      if (plan.after !== null && plan.after !== plan.before) {
        if (plan.before !== null) await this.backup(plan.path, plan.before);
        this.data.pending = { path: plan.path, date: plan.day, before: plan.before, after: plan.after, record };
        await this.persist();
        if (this.stopped) return;
        if (plan.before === null) {
          const parent = plan.path.split('/').slice(0, -1).join('/');
          if (parent) await this.ensureFolder(parent, true);
          await this.app.vault.create(plan.path, plan.after);
        } else {
          const file = this.app.vault.getAbstractFileByPath(plan.path);
          if (!file || file.extension !== 'md' || typeof this.app.vault.process !== 'function') throw new Error('无法安全更新日记');
          let prevented = false;
          try {
            await this.app.vault.process(file, current => {
              if (this.stopped || current !== plan.before) {
                prevented = true;
                throw new Error('日记正在被编辑，本次不覆盖；稍后重试');
              }
              return plan.after;
            });
          } catch (error) {
            if (prevented) { this.data.pending = null; await this.persist(); }
            throw error;
          }
        }
        this.data.records[plan.path] = record;
        this.data.pending = null;
        await this.persist();
      } else if (Object.keys(plan.items).length && JSON.stringify(previousRecord) !== JSON.stringify(record)) {
        this.data.records[plan.path] = record;
        await this.persist();
      }
      this.lastReport = { ...plan, before: undefined, after: undefined, content: undefined, items: undefined, at: Date.now() };
      this.lastError = null;
      if (manual) new Notice(this.summary(this.lastReport), 9000);
    } catch (error) {
      this.lastReport = { error: error.message, at: Date.now() };
      if (manual || this.lastError !== error.message) new Notice(`Tempo 日记同步：${error.message}`, 10000);
      this.lastError = error.message;
    } finally { this.busy = false; }
  }
}

class SyncSettings extends PluginSettingTab {
  display() {
    const el = this.containerEl; el.empty();
    el.createEl('h2', { text: 'Tempo 日记同步' });
    el.createEl('p', { text: '单向同步 Tempo 今天的顶层任务。只更新已确认由本插件写入的行；历史日记不回写，删除或移期的任务保留当日记录。日记不插入同步注释。' });
    const settings = this.plugin.data.settings;
    let folderDraft = settings.diaryFolder, headingDraft = settings.heading, templateDraft = settings.templatePath;
    const update = async (key, value) => {
      settings[key] = value;
      try { await this.plugin.persist(); this.plugin.pulseDiary?.refresh(); }
      catch (error) { new Notice(error.message, 8000); }
    };
    new Setting(el).setName('同步方式').setDesc('手动同步：点击左侧功能区的剪贴板打勾图标，或执行“立即同步”命令。启动、切换笔记和修改设置都不会自动写入日记。');
    new Setting(el).setName('日记目录').setDesc('日期文件名为 YYYY-MM-DD.md。')
      .addText(t => t.setValue(settings.diaryFolder).onChange(v => { folderDraft = v.trim(); }))
      .addButton(b => b.setButtonText('保存目录').onClick(() => update('diaryFolder', folderDraft)));
    new Setting(el).setName('目标标题').setDesc('不需要输入 #，默认 Day planner。')
      .addText(t => t.setValue(settings.heading).onChange(v => { headingDraft = v.trim(); }))
      .addButton(b => b.setButtonText('保存标题').onClick(() => update('heading', headingDraft)));
    new Setting(el).setName('自动创建缺失的当天日记').setDesc('仅在今天有任务时创建，并使用下方模板。')
      .addToggle(t => t.setValue(settings.createMissingDiary).onChange(v => update('createMissingDiary', v)));
    new Setting(el).setName('日记模板').setDesc('库内路径；留空则只建立目标标题。')
      .addText(t => t.setValue(settings.templatePath).onChange(v => { templateDraft = v.trim(); }))
      .addButton(b => b.setButtonText('保存模板').onClick(() => update('templatePath', templateDraft)));
    new Setting(el).setName('接管唯一同名任务').setDesc('默认关闭。开启后，允许接管当前日记中标题完全相同、且只有一行的手写任务，并按 Tempo 更新其勾选状态。多条重名仍跳过。')
      .addToggle(t => t.setValue(settings.adoptExactMatches).onChange(v => update('adoptExactMatches', v)));
    new Setting(el).setName('任务后的 🍅 统计范围').setDesc('每个已完成专注段显示一个 🍅，不按分钟数换算；只有点击同步才更新。')
      .addDropdown(d => d.addOption('day', '当天完成的专注段数').addOption('total', '任务累计完成的专注段数')
        .setValue(settings.tomatoScope || 'day').onChange(v => update('tomatoScope', v)));
    new Setting(el).setName('只统计番茄模式').setDesc('默认关闭：单次专注完成也计一段。正在计时和中断的记录不计入。')
      .addToggle(t => t.setValue(!!settings.strictPomodoro).onChange(v => update('strictPomodoro', v)));
    new Setting(el).setName('同步操作')
      .addButton(b => b.setButtonText('预览').onClick(() => this.plugin.preview()))
      .addButton(b => b.setButtonText('立即同步').onClick(() => this.plugin.sync(true)))
      .addButton(b => b.setButtonText('查看状态').onClick(() => this.plugin.showStatus()));
    el.createEl('h3', { text: 'Pulse 日记番茄' });
    el.createEl('p', { text: '只在内存中补充 Pulse 番茄热力图，不修改 Pulse 程序、统计文件、Focus 会话或日记。日记有有效值时覆盖当天数量；没有有效值时沿用 Focus。历史日记请在 Pulse 选择“全部历史”。' });
    new Setting(el).setName('让 Pulse 读取日记番茄').setDesc('日记字段变化后自动刷新显示；与 Tempo 手动写入日记互相独立。')
      .addToggle(t => t.setValue(!!settings.pulseDiaryEnabled).onChange(v => update('pulseDiaryEnabled', v)));
    let pulseFolderDraft = settings.pulseDiaryFolder, pulseFieldDraft = settings.pulseDiaryField;
    new Setting(el).setName('番茄日记目录').setDesc('仅读取此目录直接包含的 YYYY-MM-DD.md。')
      .addText(t => t.setValue(settings.pulseDiaryFolder).onChange(v => { pulseFolderDraft = v.trim(); }))
      .addButton(b => b.setButtonText('保存目录').onClick(() => update('pulseDiaryFolder', pulseFolderDraft)));
    new Setting(el).setName('番茄属性名').setDesc('默认 tomato。接受非负整数或整数字符串；0 有效，空值、负数、小数不覆盖 Focus。')
      .addText(t => t.setValue(settings.pulseDiaryField).onChange(v => { pulseFieldDraft = v.trim(); }))
      .addButton(b => b.setButtonText('保存字段').onClick(() => update('pulseDiaryField', pulseFieldDraft)));
    new Setting(el).setName('读取状态').setDesc(this.plugin.pulseDiary?.summary() || '等待初始化')
      .addButton(b => b.setButtonText('刷新日记番茄').onClick(() => { this.plugin.pulseDiary?.refresh(true); this.display(); }));
    if (this.plugin.data.pending) {
      new Setting(el).setName('未完成的同步写入').setDesc('保留日记当前内容，备份同步状态并取消待处理写入。之后不明确的同名行仍会跳过。')
        .addButton(b => b.setButtonText('保留日记并取消待处理写入').onClick(async () => {
          try {
            const folder = `${this.plugin.pluginPath()}/backups`;
            await this.plugin.ensureFolder(folder);
            await this.app.vault.adapter.write(`${folder}/state-${Date.now()}.json`, JSON.stringify(this.plugin.data, null, 2));
            this.plugin.data.pending = null;
            await this.plugin.persist();
            this.display();
          } catch (error) { new Notice(error.message, 8000); }
        }));
    }
    el.createEl('p', { text: `修改日记前自动备份到 ${this.plugin.pluginPath()}/backups/。本插件不修改 Tempo 数据，不把日记中的勾选反向写回 Tempo。` });
  }
}

module.exports = TempoDiarySync;
module.exports.helpers = { DEFAULT_SETTINGS, localDate, relativePath, parseTempo, isTodayTask, locateSection, reconcile, expandTemplate, taskLine, countCompletedFocus, parseDiaryTomato, collectDiaryTomatoes, diaryIntensityOverlay, PulseDiaryBridge };
