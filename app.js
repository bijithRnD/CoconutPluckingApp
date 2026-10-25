'use strict';

/* ---------- Schema ---------- */

const SCHEMA = {
  sessions:      { num: ['workers', 'workerFee', 'climberRate', 'updatedAt'] },
  workers:       { num: ['fee', 'sortOrder', 'updatedAt'] },
  plots:         { num: ['workers', 'trees', 'coconuts', 'nutsTaken', 'nutRate', 'sortOrder', 'updatedAt'] },
  plotTrees:     { num: ['trees', 'updatedAt'] },
  transport:     { num: ['fee', 'sortOrder', 'updatedAt'] },
  dehusking:     { num: ['coconuts', 'fee', 'updatedAt'] },
  dehuskWorkers: { num: ['fee', 'sortOrder', 'updatedAt'] },
  sales:         { num: ['updatedAt'] },
  saleItems:     { num: ['kg', 'rate', 'total', 'sortOrder', 'updatedAt'], bool: ['paid'] },
  jobs:          { num: ['plants', 'updatedAt'] },
  jobWorkers:    { num: ['fee', 'sortOrder', 'updatedAt'] },
  jobItems:      { num: ['qty', 'rate', 'amount', 'sortOrder', 'updatedAt'] },
  jobExpenses:   { num: ['amount', 'sortOrder', 'updatedAt'] },
};
const TABLES = Object.keys(SCHEMA);
const TEXT_FIELDS = ['date', 'status', 'name', 'type', 'customer', 'notes', 'kind', 'unit'];

/* ---------- Utilities ---------- */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const sum = (arr, f) => arr.reduce((a, r) => a + (Number(f ? r[f] : r) || 0), 0);
const round2 = v => Math.round((Number(v) || 0) * 100) / 100;
const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const num = v => nf0.format(v || 0);
const inr = v => (v < 0 ? '−₹' : '₹') + nf0.format(Math.abs(Math.round(v || 0)));
const inr2 = v => (v < 0 ? '−₹' : '₹') + nf2.format(Math.abs(v || 0));
const dash = (v, f) => (v === null || v === undefined || !isFinite(v) ? '—' : f(v));
const parseDate = d => new Date(String(d) + 'T00:00:00');
const fmtDate = d => (d ? parseDate(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtShortDate = d => (d ? parseDate(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + " '" + String(d).slice(2, 4) : '');
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
const valAttr = v => (v ? h(v) : '');
const normName = s => String(s || '').trim().toLowerCase();
const plural = (n, w) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- Store ---------- */

const emptyData = () => Object.fromEntries(TABLES.map(t => [t, []]));
const store = {
  data: Object.assign(emptyData(), loadJSON('cp.data', {})),
  outbox: loadJSON('cp.outbox', {}),
  config: loadJSON('cp.config', { url: '', token: '' }),
  lastSync: loadJSON('cp.lastSync', null),
  syncState: 'idle',
  syncError: '',
};
const db = () => store.data;
const saveLocal = () => { saveJSON('cp.data', store.data); saveJSON('cp.outbox', store.outbox); };
const configured = () => !!(store.config.url && store.config.token);

function coerce(table, r) {
  const o = { ...r };
  (SCHEMA[table].num || []).forEach(f => { o[f] = o[f] === '' || o[f] == null ? 0 : Number(o[f]) || 0; });
  (SCHEMA[table].bool || []).forEach(f => { o[f] = o[f] === true || o[f] === 'TRUE' || o[f] === 'true'; });
  TEXT_FIELDS.forEach(f => { if (f in o) o[f] = String(o[f] ?? ''); });
  return o;
}

function put(table, rec) {
  rec.updatedAt = Date.now();
  const list = db()[table];
  const i = list.findIndex(r => r.id === rec.id);
  if (i < 0) list.push(rec); else list[i] = rec;
  queue({ op: 'upsert', table, record: { ...rec } }, rec.id);
}
function del(table, id) {
  db()[table] = db()[table].filter(r => r.id !== id);
  queue({ op: 'delete', table, id }, id);
}
function queue(op, id) {
  store.outbox[`${op.table}:${id}`] = op;
  saveLocal();
  updateSyncUI();
  scheduleSync();
}
// Update a record only if a value actually changes (keeps the sync queue small).
function patch(table, rec, changes) {
  if (!rec || Object.keys(changes).every(k => rec[k] === changes[k])) return;
  Object.assign(rec, changes);
  put(table, rec);
}

const byId = (t, id) => db()[t].find(r => r.id === id);
const bySort = (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0);
const byDate = (a, b) => String(a.date).localeCompare(String(b.date)) || (a.updatedAt || 0) - (b.updatedAt || 0);
const plotsOf = sid => db().plots.filter(p => p.sessionId === sid).sort(bySort);
const workersOf = sid => db().workers.filter(w => w.sessionId === sid).sort(bySort);
const climbersOf = sid => workersOf(sid).filter(w => w.type === 'climber');
const collectorsOf = sid => workersOf(sid).filter(w => w.type !== 'climber');
const transportOf = pid => db().transport.filter(t => t.plotId === pid).sort(bySort);
const treeRecsOfPlot = pid => db().plotTrees.filter(r => r.plotId === pid);
const treeId = (pid, wid) => `${pid}_${wid}`;
const treesOf = (pid, wid) => (byId('plotTrees', treeId(pid, wid)) || {}).trees || 0;
const workerTrees = wid => sum(db().plotTrees.filter(r => r.workerId === wid), 'trees');
const dehuskOf = sid => db().dehusking.filter(d => d.sessionId === sid).sort(byDate);
const dehuskWorkersOf = did => db().dehuskWorkers.filter(w => w.dehuskId === did).sort(bySort);
const salesOf = sid => db().sales.filter(s => s.sessionId === sid).sort(byDate);
const itemsOf = saleId => db().saleItems.filter(i => i.saleId === saleId).sort(bySort);
const sessionsAsc = () => [...db().sessions].sort(byDate);
const isActive = s => s.status === 'active';

/* ---------- Farm care (fertilizing & pesticide) ---------- */

const KIND = {
  fertilizer: { label: 'Fertilizing', icon: '🌱', materials: 'Fertilizers purchased', material: 'Fertilizer' },
  pesticide: { label: 'Pesticide', icon: '🧴', materials: 'Pesticides', material: 'Pesticide' },
};
const prefs = Object.assign({ fertLagMin: 8, fertLagMax: 12, pestLag: 12, remindDays: 14 }, loadJSON('cp.prefs', {}));
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (date, n) => { const x = parseDate(date); x.setDate(x.getDate() + n); return ymd(x); };
function addMonths(date, n) {
  const x = parseDate(date);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
  return ymd(x);
}
const fmtMonth = d => parseDate(d).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
const jobsOf = kind => db().jobs.filter(j => j.kind === kind);
const jobWorkersOf = id => db().jobWorkers.filter(w => w.jobId === id).sort(bySort);
const jobItemsOf = id => db().jobItems.filter(i => i.jobId === id).sort(bySort);
const jobExpensesOf = id => db().jobExpenses.filter(x => x.jobId === id).sort(bySort);
const isPlanned = j => j.status === 'planned';
const jobName = j => String(j.name || '').trim() || `${KIND[j.kind] ? KIND[j.kind].label : 'Care'} ${fmtDate(j.date)}`;

function jobStats(j) {
  const labour = sum(jobWorkersOf(j.id), 'fee');
  const materials = sum(jobItemsOf(j.id), 'amount');
  const other = sum(jobExpensesOf(j.id), 'amount');
  return { labour, materials, other, total: labour + materials + other };
}
function deleteJob(id) {
  jobWorkersOf(id).forEach(w => del('jobWorkers', w.id));
  jobItemsOf(id).forEach(i => del('jobItems', i.id));
  jobExpensesOf(id).forEach(x => del('jobExpenses', x.id));
  del('jobs', id);
}

// Which care sessions are expected to show up in a given plucking's harvest.
function fertForPlucking(s) {
  const from = addMonths(s.date, -prefs.fertLagMax), to = addMonths(s.date, -prefs.fertLagMin);
  return jobsOf('fertilizer').filter(j => !isPlanned(j) && j.date >= from && j.date <= to).sort(byDate);
}
function pestForPlucking(s) {
  const from = addMonths(s.date, -prefs.pestLag);
  return jobsOf('pesticide').filter(j => !isPlanned(j) && j.date > from && j.date <= s.date).sort(byDate);
}

function dueReminders() {
  const limit = addDays(today(), prefs.remindDays);
  return jobsOf('pesticide').filter(j => isPlanned(j) && j.date && j.date <= limit).sort(byDate);
}
function dueText(j) {
  const d = daysBetween(today(), j.date);
  return d < 0 ? `overdue by ${plural(-d, 'day')}` : d === 0 ? 'due today' : `due in ${plural(d, 'day')}`;
}
function reminderBanner() {
  const due = dueReminders();
  if (!due.length) return '';
  return `<div class="banner remind"><strong>🔔 Pesticide reminder</strong>${due.map(j => `
    <a class="remind-row" href="#/care/${j.id}"><span>${h(jobName(j))} · ${fmtDate(j.date)}</span><span class="${j.date < today() ? 'bad' : ''}">${dueText(j)}</span></a>`).join('')}</div>`;
}

// Derived totals: computed from detail rows when present, else the stored value (older data).
const plotTreeTotal = p => { const r = treeRecsOfPlot(p.id); return r.length ? sum(r, 'trees') : (p.trees || 0); };
const nutsValue = p => (p.nutsTaken || 0) * (p.nutRate || 0);
const dehuskFeeOf = d => { const w = dehuskWorkersOf(d.id); return w.length ? sum(w, 'fee') : (d.fee || 0); };
const sessionWorkerFee = s => { const w = workersOf(s.id); return w.length ? sum(w, 'fee') : (s.workerFee || 0); };

// Keep summary columns in the sheet readable alongside the detail rows.
function refreshDerived(sid) {
  const s = byId('sessions', sid);
  if (!s) return;
  const ws = workersOf(sid);
  patch('sessions', s, { workers: ws.length, workerFee: sum(ws, 'fee') });
  plotsOf(sid).forEach(p => {
    if (treeRecsOfPlot(p.id).length || climbersOf(sid).length) patch('plots', p, { trees: plotTreeTotal(p), workers: ws.length });
  });
  dehuskOf(sid).forEach(d => { if (dehuskWorkersOf(d.id).length) patch('dehusking', d, { fee: dehuskFeeOf(d) }); });
}

function deleteSale(saleId) {
  itemsOf(saleId).forEach(i => del('saleItems', i.id));
  del('sales', saleId);
}
function deletePlot(pid) {
  treeRecsOfPlot(pid).forEach(r => del('plotTrees', r.id));
  transportOf(pid).forEach(t => del('transport', t.id));
  del('plots', pid);
}
function deleteWorker(wid) {
  db().plotTrees.filter(r => r.workerId === wid).forEach(r => del('plotTrees', r.id));
  del('workers', wid);
}
function deleteDehusk(did) {
  dehuskWorkersOf(did).forEach(w => del('dehuskWorkers', w.id));
  del('dehusking', did);
}
function deleteSession(sid) {
  plotsOf(sid).forEach(p => deletePlot(p.id));
  workersOf(sid).forEach(w => deleteWorker(w.id));
  dehuskOf(sid).forEach(d => deleteDehusk(d.id));
  salesOf(sid).forEach(s => deleteSale(s.id));
  del('sessions', sid);
}

function stats(s) {
  const plots = plotsOf(s.id);
  const ws = workersOf(s.id);
  const trees = sum(plots.map(plotTreeTotal));
  const coconuts = sum(plots, 'coconuts');
  const nutsTaken = sum(plots, 'nutsTaken');
  const nutsTakenValue = sum(plots.map(nutsValue));
  const workerFee = sessionWorkerFee(s);
  const transportFee = sum(plots.flatMap(p => transportOf(p.id)), 'fee');
  const dh = dehuskOf(s.id);
  const dehuskFee = sum(dh.map(dehuskFeeOf));
  const sales = salesOf(s.id);
  const items = sales.flatMap(x => itemsOf(x.id));
  const kg = sum(items, 'kg');
  const revenue = sum(items, 'total');
  const received = sum(items.filter(i => i.paid), 'total');
  const cost = workerFee + transportFee + dehuskFee + nutsTakenValue;
  return {
    s, plots, trees, coconuts, nutsTaken, nutsTakenValue, saleNuts: Math.max(0, coconuts - nutsTaken),
    workerFee, transportFee, dehuskFee,
    workers: ws.length || s.workers || 0,
    climbers: ws.filter(w => w.type === 'climber').length,
    collectors: ws.filter(w => w.type !== 'climber').length,
    dehuskCoconuts: sum(dh, 'coconuts'), dehusked: dh.length > 0,
    salesCount: sales.length, customers: items.length,
    kg, revenue, received, pending: revenue - received, cost, net: revenue - cost,
    perTree: trees ? coconuts / trees : null,
    rate: kg ? revenue / kg : null,
    kgPerNut: coconuts - nutsTaken > 0 && kg ? kg / (coconuts - nutsTaken) : null,
    costPerNut: coconuts ? cost / coconuts : null,
  };
}

/* ---------- Sync with Google Sheets (Apps Script web app) ---------- */

let syncTimer = null;
let syncing = false;
let resyncWanted = false;

function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), delay);
}

async function callApi(ops, pull = true) {
  const res = await fetch(store.config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight
    body: JSON.stringify({ token: store.config.token, ops, pull }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Unknown error');
  return json.data;
}

async function sync() {
  clearTimeout(syncTimer);
  if (!configured() || !navigator.onLine) return updateSyncUI();
  if (syncing) { resyncWanted = true; return; }
  syncing = true;
  store.syncState = 'syncing';
  updateSyncUI();
  const sent = Object.entries(store.outbox);
  try {
    const server = await callApi(sent.map(([, op]) => op));
    sent.forEach(([k, op]) => { if (store.outbox[k] === op) delete store.outbox[k]; });
    store.data = mergeServer(server);
    store.lastSync = Date.now();
    store.syncState = 'ok';
    store.syncError = '';
    saveJSON('cp.lastSync', store.lastSync);
    saveLocal();
    softRender();
  } catch (err) {
    store.syncState = 'error';
    store.syncError = String(err.message || err);
  } finally {
    syncing = false;
    updateSyncUI();
    if (resyncWanted) { resyncWanted = false; scheduleSync(300); }
  }
}

// Server is the source of truth, except for local changes not yet synced.
function mergeServer(server) {
  const data = Object.fromEntries(TABLES.map(t => [t, (server[t] || []).map(r => coerce(t, r))]));
  Object.values(store.outbox).forEach(op => {
    const list = data[op.table];
    if (!list) return;
    if (op.op === 'delete') {
      data[op.table] = list.filter(r => r.id !== op.id);
    } else {
      const i = list.findIndex(r => r.id === op.record.id);
      if (i < 0) list.push({ ...op.record }); else list[i] = { ...op.record };
    }
  });
  return data;
}

function updateSyncUI() {
  const btn = $('#syncBtn');
  const pending = Object.keys(store.outbox).length;
  let state, text, save;
  if (!configured()) { state = 'off'; text = 'Local only'; save = '✓ Saved on this device'; }
  else if (!navigator.onLine) { state = 'off'; text = pending ? `Offline · ${pending} unsynced` : 'Offline'; save = pending ? 'Saved on device · will sync when online' : '✓ All changes saved'; }
  else if (store.syncState === 'syncing') { state = 'syncing'; text = 'Syncing…'; save = 'Saving to Google Sheets…'; }
  else if (store.syncState === 'error') { state = 'error'; text = 'Sync error'; save = 'Saved on device · sync failed'; }
  else if (pending) { state = 'pending'; text = `${pending} unsynced`; save = 'Saving…'; }
  else { state = 'ok'; text = 'Synced'; save = '✓ All changes saved'; }
  btn.dataset.state = state;
  $('#syncText').textContent = text;
  btn.title = store.syncError || 'Sync now';
  $$('#saveState, [data-save]').forEach(sb => { sb.textContent = save; sb.dataset.state = state; });
  if ($('[data-calc="syncInfo"]')) refreshCalcs();
}

/* ---------- Charts (inline SVG) ---------- */

function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function axisFmt(v, money) {
  const a = Math.abs(v);
  const s = a >= 100000 ? nf1.format(v / 100000) + 'L' : a >= 1000 ? nf1.format(v / 1000) + 'k' : nf2.format(v);
  return money ? '₹' + s : s;
}
function barPath(x, y, w, hgt) {
  const r = Math.min(4, hgt, w / 2);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}
function legend(series) {
  return series.length < 2 ? '' :
    `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${h(s.name)}</span>`).join('')}</div>`;
}
function xLabels(labels, cx, y) {
  const every = labels.length > 8 ? Math.ceil(labels.length / 6) : 1;
  return labels.map((l, i) => ((labels.length - 1 - i) % every === 0
    ? `<text class="axis-label" x="${cx(i)}" y="${y}" text-anchor="middle">${h(l)}</text>` : '')).join('');
}
function tipHtml(label, rows) {
  return h(`<b>${h(label)}</b>` + rows.map(([k, v]) => `${h(k)}: ${h(v)}`).join('<br>'));
}

function barChart({ labels, titles = labels, series, fmt, money }) {
  const W = 640, H = 210, L = 52, R = 8, T = 14, B = 26;
  const ih = H - T - B;
  const max = Math.max(0, ...series.flatMap(s => s.values.map(v => v || 0)));
  const step = niceStep(max / 4 || 1);
  const top = Math.max(step * 4, step * Math.ceil(max / step));
  const n = labels.length, band = (W - L - R) / n, k = series.length;
  const bw = Math.max(4, Math.min(24, (band * 0.7 - (k - 1) * 2) / k));
  const gw = k * bw + (k - 1) * 2;
  const y = v => T + ih * (1 - v / top);
  let svg = '';
  for (let t = 0; t <= top + 1e-9; t += step) {
    svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>` +
      `<text class="axis-label" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${axisFmt(t, money)}</text>`;
  }
  labels.forEach((l, i) => {
    const x0 = L + i * band + (band - gw) / 2;
    series.forEach((s, j) => {
      const v = s.values[i] || 0;
      if (v > 0) svg += `<path d="${barPath(x0 + j * (bw + 2), y(v), bw, y(0) - y(v))}" fill="${s.color}"/>`;
    });
    if (k === 1 && i === n - 1 && series[0].values[i]) {
      svg += `<text class="value-label" x="${x0 + bw / 2}" y="${y(series[0].values[i]) - 5}" text-anchor="middle">${h(fmt(series[0].values[i]))}</text>`;
    }
    svg += `<rect class="hit" x="${L + i * band}" y="${T}" width="${band}" height="${ih}" data-tip="${tipHtml(titles[i], series.map(s => [s.name, fmt(s.values[i] || 0)]))}"/>`;
  });
  svg += xLabels(labels, i => L + i * band + band / 2, H - 6);
  return `<div class="chart">${legend(series)}<svg viewBox="0 0 ${W} ${H}" role="img">${svg}</svg></div>`;
}

function lineChart({ labels, titles = labels, values, name, fmt, color }) {
  const W = 640, H = 190, L = 52, R = 16, T = 16, B = 26;
  const ih = H - T - B;
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && isFinite(v));
  if (!pts.length) return '<p class="muted small">Not enough data yet.</p>';
  let lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1]));
  if (hi === lo) { hi += Math.abs(hi) * 0.1 || 1; lo -= Math.abs(lo) * 0.1 || 1; }
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  if (lo < 0 && Math.min(...pts.map(p => p[1])) >= 0) lo = 0;
  const n = labels.length, band = (W - L - R) / n;
  const x = i => L + i * band + band / 2;
  const y = v => T + ih * (1 - (v - lo) / (hi - lo));
  let svg = '';
  for (let t = lo; t <= hi + 1e-9; t += step) {
    svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>` +
      `<text class="axis-label" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${h(fmt(t))}</text>`;
  }
  svg += `<path d="${pts.map(([i, v], j) => `${j ? 'L' : 'M'}${x(i)},${y(v)}`).join('')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  pts.forEach(([i, v]) => { svg += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`; });
  const [li, lv] = pts[pts.length - 1];
  svg += `<text class="value-label" x="${x(li)}" y="${y(lv) - 9}" text-anchor="middle">${h(fmt(lv))}</text>`;
  labels.forEach((l, i) => {
    svg += `<rect class="hit" x="${L + i * band}" y="${T}" width="${band}" height="${ih}" data-tip="${tipHtml(titles[i], [[name, dash(values[i], fmt)]])}"/>`;
  });
  svg += xLabels(labels, x, H - 6);
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img">${svg}</svg></div>`;
}

function initTooltips() {
  const tip = $('#tooltip');
  const show = (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.innerHTML = t.getAttribute('data-tip');
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = e.clientX + 12, top = e.clientY - r.height - 10;
    if (left + r.width > innerWidth - 8) left = e.clientX - r.width - 12;
    if (top < 8) top = e.clientY + 16;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = top + 'px';
  };
  document.addEventListener('pointermove', show);
  document.addEventListener('pointerdown', show);
  document.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
}

/* ---------- View helpers ---------- */

function statTile(k, v, d = '') {
  return `<div class="stat"><div class="k">${h(k)}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
}
function calc(key, tag = 'span') { return `<${tag} data-calc="${key}"></${tag}>`; }
function numInput(t, rec, f, label, attrs = '') {
  return `<label class="field">${h(label)}<input type="number" inputmode="decimal" min="0" step="any" data-t="${t}" data-id="${rec.id}" data-f="${f}" value="${valAttr(rec[f])}" placeholder="0" ${attrs}></label>`;
}
function textInput(t, rec, f, label, attrs = '') {
  return `<label class="field">${h(label)}<input type="text" data-t="${t}" data-id="${rec.id}" data-f="${f}" value="${h(rec[f])}" ${attrs}></label>`;
}
function dateInput(t, rec, f, label) {
  return `<label class="field">${h(label)}<input type="date" data-t="${t}" data-id="${rec.id}" data-f="${f}" value="${h(rec[f])}"></label>`;
}
// A compact "name + fee + remove" row used for transport and dehusking workers.
function nameFeeRow(t, rec, { list, placeholder, delAction }) {
  return `<div class="line-row">
    <input class="grow" type="text" list="${list}" placeholder="${h(placeholder)}" aria-label="${h(placeholder)}" data-t="${t}" data-id="${rec.id}" data-f="name" value="${h(rec.name)}">
    <input class="fee" type="number" inputmode="decimal" min="0" step="any" placeholder="₹ fee" aria-label="Fee" data-t="${t}" data-id="${rec.id}" data-f="fee" value="${valAttr(rec.fee)}">
    <button class="icon-btn" title="Remove" data-action="${delAction}" data-id="${rec.id}">✕</button>
  </div>`;
}
function datalist(id, values) {
  return `<datalist id="${id}">${values.map(v => `<option value="${h(v)}">`).join('')}</datalist>`;
}
function uniqueNames(list, f) {
  const seen = new Map();
  list.forEach(r => { const k = normName(r[f]); if (k && !seen.has(k)) seen.set(k, String(r[f]).trim()); });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
function unpaidItems() {
  return db().saleItems.filter(i => !i.paid && (i.total || 0) > 0);
}
function saveBar() {
  return `<div class="savebar"><span id="saveState"></span><button class="btn primary sm" data-action="saveNow">Save</button></div>`;
}
const workerName = w => w.name.trim() || (w.type === 'climber' ? 'Unnamed climber' : 'Unnamed collector');
const workerLabel = w => h(workerName(w));
const sessionName = s => String(s.name || '').trim() || `Plucking ${fmtDate(s.date)}`;
const defaultSessionName = date => parseDate(date).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) + ' plucking';

/* ---------- Views ---------- */

function sessionCard(s, prev) {
  const st = stats(s);
  const active = isActive(s);
  return `
    <a class="card link ${active ? 'active-card' : ''}" href="#/session/${s.id}">
      <div class="row spread" style="margin-bottom:8px">
        <strong>${h(sessionName(s))}</strong>
        <span class="row">
          ${active ? '<span class="chip live">● In progress</span>' : ''}
          ${!active ? (st.dehusked ? '<span class="chip good">✓ Dehusked</span>' : '<span class="chip">Not dehusked</span>') : ''}
          ${st.pending > 0 ? `<span class="chip bad">${inr(st.pending)} due</span>` : st.revenue > 0 ? '<span class="chip good">✓ Paid</span>' : ''}
        </span>
      </div>
      <div class="stats">
        ${statTile('Trees', num(st.trees))}
        ${statTile('Coconuts', num(st.coconuts))}
        ${active ? statTile('Climbers', num(st.climbers)) + statTile('Collectors', num(st.collectors))
          : statTile('Sales', inr(st.revenue)) + statTile('Net', inr(st.net))}
      </div>
      <div class="muted small" style="margin-top:6px">${active ? 'Started ' : ''}${fmtDate(s.date)} · ${plural(st.plots.length, 'plot')} · ${plural(st.workers, 'worker')}${prev ? ` · ${daysBetween(prev.date, s.date)} days after previous` : ''}</div>
      ${active ? '<div class="continue">Continue plucking ›</div>' : ''}
    </a>`;
}

function viewHome() {
  const asc = sessionsAsc();
  const prevOf = s => asc[asc.indexOf(s) - 1];
  const active = asc.filter(isActive).reverse();
  const completed = asc.filter(s => !isActive(s)).reverse();
  const due = unpaidItems();
  const dueTotal = sum(due, 'total');

  return {
    html: `
      ${reminderBanner()}
      ${configured() ? '' : `<div class="banner">Data is saved on this device only. <a href="#/settings">Connect Google Sheets</a> to back it up and use it on other devices.</div>`}
      ${active.map(s => sessionCard(s, prevOf(s))).join('')}
      <button class="btn primary block" data-action="newSession" style="margin-bottom:12px">+ Start new plucking session</button>
      ${dueTotal > 0 ? `<a class="card link row spread" href="#/dues" style="display:flex"><span><strong>${inr(dueTotal)}</strong> pending from ${uniqueNames(due, 'customer').length || due.length} customer(s)</span><span>›</span></a>` : ''}
      <div class="section-title"><h2>Recently completed</h2></div>
      ${completed.map(s => sessionCard(s, prevOf(s))).join('') ||
        `<div class="empty"><div class="big">🥥</div><p>No completed plucking sessions yet.</p></div>`}`,
  };
}

function viewSession(id) {
  const s = byId('sessions', id);
  if (!s) return notFound();
  const active = isActive(s);
  const plots = plotsOf(id);
  const workers = workersOf(id);
  const climbers = workers.filter(w => w.type === 'climber');
  const collectors = workers.filter(w => w.type !== 'climber');
  const asc = sessionsAsc();
  const prev = asc[asc.findIndex(x => x.id === id) - 1];

  const workerRows = workers.map(w => `
    <div class="line-row">
      <input class="grow" type="text" list="workerNames" placeholder="Worker name" aria-label="Worker name" data-t="workers" data-id="${w.id}" data-f="name" value="${h(w.name)}">
      <select data-t="workers" data-id="${w.id}" data-f="type" aria-label="Worker type" class="type-select">
        <option value="climber" ${w.type === 'climber' ? 'selected' : ''}>Climber</option>
        <option value="collector" ${w.type !== 'climber' ? 'selected' : ''}>Collector</option>
      </select>
      <button class="icon-btn" title="Remove worker" data-action="delWorker" data-id="${w.id}">✕</button>
    </div>`).join('');

  const plotCards = plots.map((p, i) => {
    const hasTreeRecs = treeRecsOfPlot(p.id).length > 0;
    const counters = climbers.length ? `
      <div class="tree-summary">${climbers.map(w => `<span><span data-wname="${w.id}">${workerLabel(w)}</span> <strong data-count="${treeId(p.id, w.id)}">${treesOf(p.id, w.id)}</strong></span>`).join('')}</div>
      <button class="btn primary block count-btn" data-action="openCounter" data-id="${p.id}">🌴 Count trees climbed</button>`
      : hasTreeRecs ? '' : `<div class="grid g2">${numInput('plots', p, 'trees', 'Trees plucked', 'inputmode="numeric" step="1"')}</div>
         <p class="muted small">Add climbers above to count trees per climber.</p>`;
    return `
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <input class="grow" type="text" list="plotNames" aria-label="Plot name" data-t="plots" data-id="${p.id}" data-f="name" value="${h(p.name)}" placeholder="Plot ${i + 1}" style="font-weight:600">
        ${plots.length > 1 ? `<button class="icon-btn" title="Remove plot" data-action="delPlot" data-id="${p.id}">✕</button>` : ''}
      </div>
      ${climbers.length ? '<h3>Trees climbed</h3>' : ''}
      ${counters}
      ${collectors.length ? `<p class="small muted" style="margin:8px 0 0">Collectors: ${collectors.map(w => `<span data-wname="${w.id}">${workerLabel(w)}</span>`).join(', ')}</p>` : ''}
      <div class="grid g2" style="margin-top:12px">
        <div class="stat"><div class="k">Trees in this plot</div><div class="v">${calc('plotTrees_' + p.id)}</div></div>
        ${numInput('plots', p, 'coconuts', 'Coconuts plucked', 'inputmode="numeric" step="1"')}
      </div>
      <h3 style="margin-top:14px">Coconuts taken by climbers</h3>
      <div class="grid g3">
        ${numInput('plots', p, 'nutsTaken', 'Coconuts', 'inputmode="numeric" step="1"')}
        ${numInput('plots', p, 'nutRate', 'Rate (₹/coconut)')}
        <div class="stat"><div class="k">Expense</div><div class="v">${calc('nutsVal_' + p.id)}</div></div>
      </div>
      <p class="small muted" style="margin:6px 0 0">Coconuts left for sale from this plot: <strong>${calc('forSale_' + p.id)}</strong></p>
      <h3 style="margin-top:14px">Transport</h3>
      ${transportOf(p.id).map(t => nameFeeRow('transport', t, { list: 'transportNames', placeholder: 'Vehicle / driver', delAction: 'delTransport' })).join('')}
      <button class="btn sm ghost" data-action="addTransport" data-id="${p.id}">+ Add vehicle</button>
    </div>`;
  }).join('');

  const feeRows = workers.map(w => `
    <div class="line-row">
      <span class="grow"><span data-wname="${w.id}">${workerLabel(w)}</span>
        <span class="muted small">· ${w.type === 'climber' ? `Climber · ${calc('wTrees_' + w.id)} trees` : 'Collector'}</span></span>
      <input class="fee" type="number" inputmode="decimal" min="0" step="any" placeholder="₹ fee" aria-label="Fee" data-t="workers" data-id="${w.id}" data-f="fee" value="${valAttr(w.fee)}">
    </div>`).join('');

  const dhCards = dehuskOf(id).map(d => `
    <div class="card">
      <div class="row spread" style="margin-bottom:8px"><strong>Dehusking</strong><button class="icon-btn" title="Remove" data-action="delDehusk" data-id="${d.id}">✕</button></div>
      <div class="grid g2">
        ${dateInput('dehusking', d, 'date', 'Date')}
        ${numInput('dehusking', d, 'coconuts', 'Coconuts', 'inputmode="numeric" step="1"')}
      </div>
      <h3 style="margin-top:12px">Workers</h3>
      ${dehuskWorkersOf(d.id).map(w => nameFeeRow('dehuskWorkers', w, { list: 'dehuskNames', placeholder: 'Worker name', delAction: 'delDehuskWorker' })).join('')}
      <div class="row spread">
        <button class="btn sm ghost" data-action="addDehuskWorker" data-id="${d.id}">+ Add worker</button>
        <span class="small">Total: <strong>${calc('dhFee_' + d.id)}</strong></span>
      </div>
    </div>`).join('');

  const saleCards = salesOf(id).map(x => {
    const items = itemsOf(x.id);
    const total = sum(items, 'total'), pend = total - sum(items.filter(i => i.paid), 'total');
    return `
      <a class="card link" href="#/sale/${x.id}">
        <div class="row spread"><strong>${fmtDate(x.date)}</strong>${pend > 0 ? `<span class="chip bad">${inr(pend)} due</span>` : total > 0 ? '<span class="chip good">✓ All received</span>' : ''}</div>
        <div class="muted small">${plural(items.length, 'customer')} · ${nf2.format(sum(items, 'kg'))} kg · <strong style="color:var(--text)">${inr(total)}</strong></div>
      </a>`;
  }).join('');

  return {
    html: `
      <a class="back" href="#/">‹ Home</a>
      <div class="row spread"><h1 data-sname>${h(sessionName(s))}</h1>${active ? '<span class="chip live">● In progress</span>' : '<span class="chip good">✓ Completed</span>'}</div>
      ${prev ? `<p class="muted small" style="margin-top:-8px">${daysBetween(prev.date, s.date)} days after the previous plucking (${fmtDate(prev.date)})</p>` : ''}
      <div class="card"><div class="grid g2">${textInput('sessions', s, 'name', 'Session name', 'placeholder="e.g. October 2026 plucking"')}${dateInput('sessions', s, 'date', 'Date')}</div></div>

      <div class="section-title"><h2>Workers</h2><span class="muted small">${calc('workerCounts')}</span></div>
      <div class="card">
        ${workerRows || '<p class="muted small" style="margin-top:0">Add the workers who came today.</p>'}
        <div class="row" style="margin-top:6px">
          <button class="btn sm" data-action="addWorker" data-id="${id}" data-type="climber">+ Climber</button>
          <button class="btn sm" data-action="addWorker" data-id="${id}" data-type="collector">+ Collector</button>
        </div>
      </div>
      ${datalist('workerNames', uniqueNames(db().workers, 'name'))}

      <div class="section-title"><h2>Plots</h2><button class="btn sm" data-action="addPlot" data-id="${id}">+ Add plot</button></div>
      ${plotCards}
      ${datalist('plotNames', uniqueNames(db().plots, 'name'))}
      ${datalist('transportNames', uniqueNames(db().transport, 'name'))}
      <div class="card">
        <div class="stats">
          ${statTile('Total trees', calc('trees'))}
          ${statTile('Coconuts plucked', calc('coconuts'))}
          ${statTile('Taken by climbers', calc('nutsTaken'))}
          ${statTile('For sale', calc('saleNuts'))}
          ${statTile('Coconuts / tree', calc('perTree'))}
        </div>
      </div>

      <div class="section-title"><h2>Workers fee</h2></div>
      <div class="card">
        ${climbers.length ? `
          <div class="row" style="margin-bottom:10px">
            <label class="field grow">Climber rate (₹ per tree)<input type="number" inputmode="decimal" min="0" step="any" placeholder="0" data-t="sessions" data-id="${id}" data-f="climberRate" value="${valAttr(s.climberRate)}"></label>
            <button class="btn sm" data-action="applyRate" data-id="${id}" style="align-self:flex-end;margin-bottom:4px">Apply to climbers</button>
          </div>` : ''}
        ${feeRows || numInput('sessions', s, 'workerFee', 'Total fee paid to workers (₹)')}
        <div class="kv total"><span>Total workers fee</span>${calc('workerFee')}</div>
      </div>

      <div class="section-title"><h2>Dehusking</h2><button class="btn sm" data-action="addDehusk" data-id="${id}">+ Add</button></div>
      ${dhCards || '<p class="muted small">Not dehusked yet.</p>'}
      ${datalist('dehuskNames', uniqueNames(db().dehuskWorkers, 'name'))}

      <div class="section-title"><h2>Sales</h2><button class="btn sm" data-action="addSale" data-id="${id}">+ New sales session</button></div>
      ${saleCards || '<p class="muted small">No sales yet.</p>'}

      ${linkedCareCard(s)}
      <div class="section-title"><h2>Summary</h2></div>
      <div class="card">
        <div class="kv"><span>Workers fee</span>${calc('workerFee')}</div>
        <div class="kv"><span>Transport</span>${calc('transportFee')}</div>
        <div class="kv"><span>Coconuts given to climbers</span>${calc('nutsTakenValue')}</div>
        <div class="kv"><span>Dehusking fee</span>${calc('dehuskFee')}</div>
        <div class="kv"><span>Total cost</span>${calc('cost')}</div>
        <div class="kv"><span>Sales</span>${calc('revenue')}</div>
        <div class="kv"><span>Received</span>${calc('received')}</div>
        <div class="kv"><span>Pending from customers</span>${calc('pending')}</div>
        <div class="kv total"><span>Net (sales − cost)</span>${calc('net')}</div>
      </div>

      <div class="card"><label class="field">Notes<textarea data-t="sessions" data-id="${id}" data-f="notes">${h(s.notes)}</textarea></label></div>
      ${active
        ? `<button class="btn primary block" data-action="completeSession" data-id="${id}" style="margin-bottom:10px">✓ Mark plucking as completed</button>`
        : `<button class="btn block" data-action="reopenSession" data-id="${id}" style="margin-bottom:10px">Reopen as in progress</button>`}
      <button class="btn danger ghost block" data-action="delSession" data-id="${id}">Delete this session</button>
      ${saveBar()}`,
    calc: () => {
      const st = stats(s);
      const out = {
        workerCounts: `${plural(st.climbers, 'climber')} · ${plural(st.collectors, 'collector')}`,
        trees: num(st.trees), coconuts: num(st.coconuts), nutsTaken: num(st.nutsTaken), saleNuts: num(st.saleNuts), perTree: dash(st.perTree, nf1.format),
        nutsTakenValue: st.nutsTaken ? `${inr(st.nutsTakenValue)} (${num(st.nutsTaken)} coconuts)` : inr(0),
        workerFee: inr(st.workerFee), transportFee: inr(st.transportFee), dehuskFee: inr(st.dehuskFee), cost: inr(st.cost),
        revenue: inr(st.revenue), received: inr(st.received), pending: inr(st.pending), net: inr(st.net),
      };
      st.plots.forEach(p => {
        out['plotTrees_' + p.id] = num(plotTreeTotal(p));
        out['nutsVal_' + p.id] = inr(nutsValue(p));
        out['forSale_' + p.id] = num(Math.max(0, (p.coconuts || 0) - (p.nutsTaken || 0)));
      });
      workersOf(id).forEach(w => { out['wTrees_' + w.id] = num(workerTrees(w.id)); });
      dehuskOf(id).forEach(d => { out['dhFee_' + d.id] = inr(dehuskFeeOf(d)); });
      return out;
    },
  };
}

function viewSale(id) {
  const x = byId('sales', id);
  if (!x) return notFound();
  const s = byId('sessions', x.sessionId);
  const items = itemsOf(id);
  const itemCards = items.map((it, i) => `
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <input class="grow" type="text" list="customers" aria-label="Customer name" placeholder="Customer ${i + 1}" data-t="saleItems" data-id="${it.id}" data-f="customer" value="${h(it.customer)}" style="font-weight:600">
        <button class="icon-btn" title="Remove" data-action="delItem" data-id="${it.id}">✕</button>
      </div>
      <div class="grid g3">
        ${numInput('saleItems', it, 'kg', 'KG')}
        ${numInput('saleItems', it, 'rate', 'Rate (₹/kg)')}
        ${numInput('saleItems', it, 'total', 'Total (₹)')}
      </div>
      <div class="row spread" style="margin-top:10px">${paidToggle(it)}</div>
    </div>`).join('');

  return {
    html: `
      <a class="back" href="#/session/${x.sessionId}">‹ ${s ? h(sessionName(s)) : 'Plucking'}</a>
      <h1>Sales session</h1>
      <div class="card">
        <div class="grid g2">
          ${dateInput('sales', x, 'date', 'Date')}
          ${textInput('sales', x, 'notes', 'Notes')}
        </div>
      </div>
      <div class="section-title"><h2>Customers</h2>${items.length ? `<button class="btn sm" data-action="markAllPaid" data-id="${id}">Mark all received</button>` : ''}</div>
      ${itemCards}
      ${datalist('customers', uniqueNames(db().saleItems, 'customer'))}
      <button class="btn block" data-action="addItem" data-id="${id}" style="margin-bottom:12px">+ Add customer</button>
      <div class="card">
        <div class="kv"><span>Total weight</span>${calc('kg')}</div>
        <div class="kv"><span>Average rate</span>${calc('rate')}</div>
        <div class="kv"><span>Received</span>${calc('received')}</div>
        <div class="kv"><span>Pending</span>${calc('pending')}</div>
        <div class="kv total"><span>Total amount</span>${calc('total')}</div>
      </div>
      <button class="btn danger ghost block" data-action="delSale" data-id="${id}">Delete this sales session</button>
      ${saveBar()}`,
    calc: () => {
      const its = itemsOf(id);
      const kg = sum(its, 'kg'), total = sum(its, 'total'), rec = sum(its.filter(i => i.paid), 'total');
      return { kg: nf2.format(kg) + ' kg', rate: kg ? inr2(total / kg) + '/kg' : '—', received: inr(rec), pending: inr(total - rec), total: inr(total) };
    },
  };
}

function paidToggle(it) {
  return `<label class="paid-toggle ${it.paid ? 'on' : ''}"><input type="checkbox" data-paid="${it.id}" ${it.paid ? 'checked' : ''}><span>${it.paid ? '✓ Money received' : '○ Not received'}</span></label>`;
}

function viewDues() {
  const due = unpaidItems();
  const groups = new Map();
  due.forEach(i => {
    const k = normName(i.customer) || '(no name)';
    if (!groups.has(k)) groups.set(k, { name: i.customer.trim() || '(no name)', items: [] });
    groups.get(k).items.push(i);
  });
  const list = [...groups.values()].map(g => ({ ...g, total: sum(g.items, 'total') })).sort((a, b) => b.total - a.total);
  const cards = list.map(g => `
    <div class="card">
      <div class="row spread" style="margin-bottom:6px">
        <strong>${h(g.name)}</strong>
        <span class="row"><strong class="num">${inr(g.total)}</strong>${g.items.length > 1 ? `<button class="btn sm" data-action="payCustomer" data-name="${h(normName(g.name))}">All received</button>` : ''}</span>
      </div>
      ${g.items.map(i => {
        const sale = byId('sales', i.saleId);
        return `<div class="kv small"><a href="#/sale/${i.saleId}" class="muted">${fmtDate(sale && sale.date)} · ${nf2.format(i.kg)} kg × ${inr2(i.rate)}</a><span class="row">${inr(i.total)} <button class="btn sm" data-action="payItem" data-id="${i.id}">Received</button></span></div>`;
      }).join('')}
    </div>`).join('');
  return {
    html: `
      <h1>Pending payments</h1>
      ${list.length ? `<div class="card"><div class="stats">${statTile('Total pending', inr(sum(due, 'total')))}${statTile('Customers', list.length)}</div></div>${cards}`
        : `<div class="empty"><div class="big">✓</div><p>No pending payments.</p></div>`}`,
  };
}

function delta(cur, prev) {
  if (cur === null || prev === null || prev === undefined || !isFinite(cur) || !isFinite(prev) || prev === 0) return '';
  const p = (cur - prev) / Math.abs(prev);
  if (Math.abs(p) < 0.005) return 'Same as previous';
  return `<span class="${p > 0 ? 'up' : 'down'}">${nf1.format(Math.abs(p) * 100)}%</span> vs previous`;
}

function viewAnalytics() {
  const all = sessionsAsc().map(stats);
  if (!all.length) return { html: `<h1>Analytics</h1><div class="empty"><div class="big">📊</div><p>Analytics appear after your first plucking session.</p></div>` };
  const last = all[all.length - 1], P = all[all.length - 2] || {};
  const prev = all.length > 1 ? P : null;
  const recent = all.slice(-12);
  const labels = recent.map(x => fmtShortDate(x.s.date));
  const titles = recent.map(x => `${sessionName(x.s)} · ${fmtDate(x.s.date)}`);
  const gaps = all.slice(1).map((x, i) => daysBetween(all[i].s.date, x.s.date));
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const nextDue = avgGap ? new Date(parseDate(last.s.date).getTime() + avgGap * 86400000) : null;

  const tiles = [
    statTile('Coconuts', num(last.coconuts), delta(last.coconuts, P.coconuts)),
    statTile('Coconuts / tree', dash(last.perTree, nf1.format), delta(last.perTree, P.perTree)),
    statTile('Coconuts to climbers', `${num(last.nutsTaken)} · ${inr(last.nutsTakenValue)}`, delta(last.nutsTakenValue, P.nutsTakenValue)),
    statTile('Sales', inr(last.revenue), delta(last.revenue, P.revenue)),
    statTile('Workers fee', inr(last.workerFee), delta(last.workerFee, P.workerFee)),
    statTile('Transport', inr(last.transportFee), delta(last.transportFee, P.transportFee)),
    statTile('Dehusking', inr(last.dehuskFee), delta(last.dehuskFee, P.dehuskFee)),
    statTile('Net', inr(last.net), delta(last.net, P.net)),
    statTile('Avg rate', dash(last.rate, v => inr2(v) + '/kg'), delta(last.rate, P.rate)),
    statTile('Weight / coconut', dash(last.kgPerNut, v => nf2.format(v) + ' kg'), delta(last.kgPerNut, P.kgPerNut)),
    statTile('Cost / coconut', dash(last.costPerNut, inr2), delta(last.costPerNut, P.costPerNut)),
  ].join('');

  // Per-plot comparison, matched by plot name across sessions.
  const cols = all.slice(-6).reverse();
  const plotNames = uniqueNames(cols.flatMap(c => c.plots), 'name');
  const plotRows = plotNames.map(name => `<tr><td>${h(name)}</td>${cols.map(c => {
    const ps = c.plots.filter(p => normName(p.name) === normName(name));
    if (!ps.length) return '<td class="muted">—</td>';
    const nuts = sum(ps, 'coconuts'), tr = sum(ps.map(plotTreeTotal));
    return `<td>${num(nuts)}<div class="muted small">${tr ? nf1.format(nuts / tr) + '/tree' : ''}</div></td>`;
  }).join('')}</tr>`).join('');

  // Workers across sessions, by name and role.
  const people = new Map();
  const addPerson = (name, role, sid, trees, fee) => {
    const k = normName(name) + '|' + role;
    if (!normName(name)) return;
    const p = people.get(k) || { name: name.trim(), role, sessions: new Set(), trees: 0, fee: 0 };
    p.sessions.add(sid); p.trees += trees; p.fee += fee;
    people.set(k, p);
  };
  db().workers.forEach(w => addPerson(w.name, w.type === 'climber' ? 'Climber' : 'Collector', w.sessionId, workerTrees(w.id), w.fee || 0));
  db().dehuskWorkers.forEach(w => { const d = byId('dehusking', w.dehuskId); addPerson(w.name, 'Dehusking', d ? d.sessionId : w.dehuskId, 0, w.fee || 0); });
  const workerRows = [...people.values()].sort((a, b) => b.fee - a.fee).map(p =>
    `<tr><td>${h(p.name)}</td><td>${p.role}</td><td>${p.sessions.size}</td><td>${p.role === 'Climber' ? num(p.trees) : '—'}</td><td>${p.role === 'Climber' && p.trees ? inr2(p.fee / p.trees) : '—'}</td><td>${inr(p.fee)}</td></tr>`).join('');

  // Customers across all sales.
  const cust = new Map();
  db().saleItems.forEach(i => {
    const k = normName(i.customer); if (!k) return;
    const c = cust.get(k) || { name: i.customer.trim(), kg: 0, total: 0, pending: 0, n: 0 };
    c.kg += i.kg || 0; c.total += i.total || 0; c.pending += i.paid ? 0 : (i.total || 0); c.n += 1;
    cust.set(k, c);
  });
  const custRows = [...cust.values()].sort((a, b) => b.total - a.total).slice(0, 15).map(c =>
    `<tr><td>${h(c.name)}</td><td>${c.n}</td><td>${nf2.format(c.kg)}</td><td>${inr(c.total)}</td><td>${c.kg ? inr2(c.total / c.kg) : '—'}</td><td>${c.pending ? inr(c.pending) : '—'}</td></tr>`).join('');

  const tableRows = [...all].reverse().map((x, idx, arr) => {
    const before = arr[idx + 1];
    return `<tr>
      <td><a href="#/session/${x.s.id}">${h(sessionName(x.s))}</a><div class="muted small">${fmtDate(x.s.date)}</div></td>
      <td>${before ? daysBetween(before.s.date, x.s.date) : '—'}</td>
      <td>${num(x.climbers)} / ${num(x.collectors)}</td><td>${num(x.trees)}</td><td>${num(x.coconuts)}</td><td>${x.nutsTaken ? `${num(x.nutsTaken)} · ${inr(x.nutsTakenValue)}` : '—'}</td><td>${num(x.saleNuts)}</td>
      <td>${dash(x.perTree, nf1.format)}</td><td>${nf2.format(x.kg)}</td><td>${dash(x.rate, inr2)}</td>
      <td>${inr(x.revenue)}</td><td>${inr(x.workerFee)}</td><td>${inr(x.transportFee)}</td><td>${inr(x.dehuskFee)}</td>
      <td>${inr(x.net)}</td><td>${x.pending ? inr(x.pending) : '—'}</td>
    </tr>`;
  }).join('');

  const totals = all.reduce((a, x) => ({ c: a.c + x.coconuts, r: a.r + x.revenue, n: a.n + x.net }), { c: 0, r: 0, n: 0 });

  return {
    html: `
      <h1>Analytics</h1>
      <div class="card">
        <h3>Latest: ${h(sessionName(last.s))} · ${fmtDate(last.s.date)}${prev ? ` <span class="muted">vs ${h(sessionName(prev.s))} (${daysBetween(prev.s.date, last.s.date)} days earlier)</span>` : ''}</h3>
        <div class="stats">${tiles}</div>
      </div>
      <div class="card">
        <div class="stats">
          ${statTile('Sessions', all.length)}
          ${statTile('Avg gap', avgGap ? Math.round(avgGap) + ' days' : '—')}
          ${statTile('Next plucking ~', nextDue ? nextDue.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—')}
          ${statTile('All-time coconuts', num(totals.c))}
          ${statTile('All-time sales', inr(totals.r))}
          ${statTile('All-time net', inr(totals.n))}
        </div>
      </div>
      <div class="card"><h3>Coconuts per plucking</h3>${barChart({ labels, titles, series: [{ name: 'Coconuts', color: 'var(--series-1)', values: recent.map(x => x.coconuts) }], fmt: num })}</div>
      <div class="card"><h3>Coconuts per tree</h3>${lineChart({ labels, titles, name: 'Coconuts / tree', values: recent.map(x => x.perTree), fmt: nf1.format, color: 'var(--series-1)' })}</div>
      <div class="card"><h3>Sales vs cost</h3>${barChart({ labels, titles, money: true, fmt: inr, series: [
        { name: 'Sales', color: 'var(--series-1)', values: recent.map(x => x.revenue) },
        { name: 'Total cost', color: 'var(--series-2)', values: recent.map(x => x.cost) },
      ] })}</div>
      <div class="card"><h3>Average rate (₹/kg)</h3>${lineChart({ labels, titles, name: 'Rate', values: recent.map(x => x.rate), fmt: v => '₹' + nf1.format(v), color: 'var(--series-1)' })}</div>
      <div class="card"><h3>All sessions</h3><div class="table-wrap"><table>
        <thead><tr><th>Session</th><th>Gap (d)</th><th>Climbers / collectors</th><th>Trees</th><th>Coconuts</th><th>To climbers</th><th>For sale</th><th>Per tree</th><th>KG sold</th><th>₹/kg</th><th>Sales</th><th>Workers fee</th><th>Transport</th><th>Dehusk fee</th><th>Net</th><th>Pending</th></tr></thead>
        <tbody>${tableRows}</tbody></table></div></div>
      ${plotNames.length ? `<div class="card"><h3>Plots across sessions (coconuts)</h3><div class="table-wrap"><table>
        <thead><tr><th>Plot</th>${cols.map(c => `<th>${fmtShortDate(c.s.date)}</th>`).join('')}</tr></thead>
        <tbody>${plotRows}</tbody></table></div></div>` : ''}
      ${careAnalytics(all, recent, labels, titles)}
      ${workerRows ? `<div class="card"><h3>Workers</h3><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Role</th><th>Sessions</th><th>Trees climbed</th><th>₹/tree</th><th>Total paid</th></tr></thead>
        <tbody>${workerRows}</tbody></table></div></div>` : ''}
      ${custRows ? `<div class="card"><h3>Customers</h3><div class="table-wrap"><table>
        <thead><tr><th>Customer</th><th>Purchases</th><th>KG</th><th>Amount</th><th>Avg ₹/kg</th><th>Pending</th></tr></thead>
        <tbody>${custRows}</tbody></table></div></div>` : ''}`,
  };
}

function viewSettings() {
  return {
    html: `
      <h1>Settings</h1>
      <div class="card">
        <h2>Google Sheets connection</h2>
        <p class="muted small">Paste the Web app URL and API token from your Apps Script deployment (see README).</p>
        <div class="grid">
          <label class="field">Web app URL<input id="cfgUrl" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${h(store.config.url)}"></label>
          <label class="field">API token<input id="cfgToken" type="text" autocomplete="off" value="${h(store.config.token)}"></label>
        </div>
        <p class="small muted" style="margin:8px 0 0">Saved on this device automatically as you type.</p>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-action="saveSettings">Test connection</button>
          <button class="btn" data-action="syncNow">Sync now</button>
        </div>
        <p class="small muted" style="margin-top:10px">${calc('syncInfo')}</p>
      </div>
      <div class="card">
        <h2>Farm care analysis & reminders</h2>
        <p class="muted small">How long fertilizer takes to show in the harvest, and when pesticide reminders start.</p>
        <div class="grid g2">
          <label class="field">Fertilizer effect from (months)<input id="prefFertLagMin" type="number" inputmode="numeric" min="0" value="${prefs.fertLagMin}"></label>
          <label class="field">Fertilizer effect until (months)<input id="prefFertLagMax" type="number" inputmode="numeric" min="0" value="${prefs.fertLagMax}"></label>
          <label class="field">Pesticide linked to harvests within (months)<input id="prefPestLag" type="number" inputmode="numeric" min="1" value="${prefs.pestLag}"></label>
          <label class="field">Remind before a pesticide round (days)<input id="prefRemindDays" type="number" inputmode="numeric" min="0" value="${prefs.remindDays}"></label>
        </div>
        <p class="muted small" style="margin-bottom:0">Email reminders come from your Google Sheet's Apps Script (daily, from 14 days before). See README.</p>
      </div>
      <div class="card">
        <h2>Backup</h2>
        <p class="muted small">Download everything on this device as a JSON file.</p>
        <button class="btn" data-action="exportJson">Download backup</button>
      </div>`,
    calc: () => ({
      syncInfo: [
        store.lastSync ? `Last synced ${new Date(store.lastSync).toLocaleString('en-IN')}` : 'Never synced',
        `${Object.keys(store.outbox).length} unsynced change(s)`,
        store.syncError ? `Last error: ${store.syncError}` : '',
      ].filter(Boolean).join(' · '),
    }),
  };
}

function linkedCareCard(s) {
  const fert = fertForPlucking(s), pest = pestForPlucking(s);
  const line = j => `<div class="kv small"><a href="#/care/${j.id}">${KIND[j.kind].icon} ${h(jobName(j))} · ${fmtDate(j.date)}${j.kind === 'pesticide' && j.plants ? ` · ${plural(j.plants, 'sapling')}` : ''}</a><span>${inr(jobStats(j).total)}</span></div>`;
  return `
    <div class="section-title"><h2>Farm care for this harvest</h2></div>
    <div class="card">
      <h3>Fertilizer ${prefs.fertLagMin}–${prefs.fertLagMax} months earlier (${fmtMonth(addMonths(s.date, -prefs.fertLagMax))} – ${fmtMonth(addMonths(s.date, -prefs.fertLagMin))})</h3>
      ${fert.map(line).join('') || '<p class="muted small" style="margin:0 0 8px">None recorded in that window.</p>'}
      <h3 style="margin-top:10px">Pesticide in the ${prefs.pestLag} months before</h3>
      ${pest.map(line).join('') || '<p class="muted small" style="margin:0">None recorded.</p>'}
    </div>`;
}

function careAnalytics(all, recent, labels, titles) {
  const rows = all.map(x => {
    const fert = fertForPlucking(x.s), pest = pestForPlucking(x.s);
    return { x, fert, pest, fertSpend: sum(fert.map(j => jobStats(j).total)), pestSpend: sum(pest.map(j => jobStats(j).total)), plants: sum(pest, 'plants') };
  });
  if (!db().jobs.some(j => !isPlanned(j))) {
    return `<div class="card"><h3>Farm care vs production</h3><p class="muted small" style="margin:0">Record fertilizing and pesticide sessions in Farm care to see how they relate to later harvests.</p></div>`;
  }
  const avg = list => { const v = list.map(r => r.x.perTree).filter(v => v !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const withF = rows.filter(r => r.fert.length), withoutF = rows.filter(r => !r.fert.length);
  const insight = withF.length && withoutF.length && avg(withF) !== null && avg(withoutF) !== null
    ? `<p class="small" style="margin-top:0">Harvests with fertilizer applied ${prefs.fertLagMin}–${prefs.fertLagMax} months earlier averaged <strong>${nf1.format(avg(withF))}</strong> coconuts per tree, against <strong>${nf1.format(avg(withoutF))}</strong> without (${withF.length} vs ${withoutF.length} pluckings).</p>`
    : `<p class="muted small" style="margin-top:0">A comparison appears once there are pluckings both with and without fertilizer in the ${prefs.fertLagMin}–${prefs.fertLagMax} month window.</p>`;
  const recentRows = rows.slice(-recent.length);
  const table = [...rows].reverse().map(r => `<tr>
      <td><a href="#/session/${r.x.s.id}">${h(sessionName(r.x.s))}</a><div class="muted small">${fmtDate(r.x.s.date)}</div></td>
      <td>${num(r.x.coconuts)}</td><td>${dash(r.x.perTree, nf1.format)}</td>
      <td>${r.fertSpend ? inr(r.fertSpend) : '—'}<div class="muted small">${r.fert.map(j => h(jobName(j))).join(', ')}</div></td>
      <td>${r.pestSpend ? inr(r.pestSpend) : '—'}</td><td>${r.plants ? num(r.plants) : '—'}</td>
    </tr>`).join('');

  // Yearly view: everything spent and earned in each calendar year.
  const years = new Map();
  const yr = d => String(d).slice(0, 4);
  const Y = k => { if (!years.has(k)) years.set(k, { pluckings: 0, coconuts: 0, sales: 0, pluckCost: 0, fert: 0, pest: 0 }); return years.get(k); };
  all.forEach(x => { const y = Y(yr(x.s.date)); y.pluckings++; y.coconuts += x.coconuts; y.sales += x.revenue; y.pluckCost += x.cost; });
  db().jobs.filter(j => !isPlanned(j) && j.date).forEach(j => { Y(yr(j.date))[j.kind === 'pesticide' ? 'pest' : 'fert'] += jobStats(j).total; });
  const yearRows = [...years.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([y, v]) =>
    `<tr><td>${y}</td><td>${v.pluckings}</td><td>${num(v.coconuts)}</td><td>${inr(v.sales)}</td><td>${inr(v.pluckCost)}</td><td>${inr(v.fert)}</td><td>${inr(v.pest)}</td><td>${inr(v.sales - v.pluckCost - v.fert - v.pest)}</td></tr>`).join('');

  return `
    <div class="card"><h3>Farm care vs production</h3>
      <p class="muted small" style="margin-top:0">Fertilizer is linked to harvests ${prefs.fertLagMin}–${prefs.fertLagMax} months later; pesticide to harvests in the following ${prefs.pestLag} months.</p>
      ${insight}
      <h3>Fertilizer spend linked to each plucking</h3>
      ${barChart({ labels, titles, money: true, fmt: inr, series: [{ name: 'Fertilizer spend', color: 'var(--series-3)', values: recentRows.map(r => r.fertSpend) }] })}
      <div class="table-wrap" style="margin-top:10px"><table>
        <thead><tr><th>Plucking</th><th>Coconuts</th><th>Per tree</th><th>Fertilizer (${prefs.fertLagMin}–${prefs.fertLagMax} mo before)</th><th>Pesticide (${prefs.pestLag} mo before)</th><th>Saplings treated</th></tr></thead>
        <tbody>${table}</tbody></table></div>
    </div>
    <div class="card"><h3>Yearly summary</h3><div class="table-wrap"><table>
      <thead><tr><th>Year</th><th>Pluckings</th><th>Coconuts</th><th>Sales</th><th>Plucking costs</th><th>Fertilizer</th><th>Pesticide</th><th>Net after all costs</th></tr></thead>
      <tbody>${yearRows}</tbody></table></div></div>`;
}

function careCard(j) {
  const st = jobStats(j);
  const items = jobItemsOf(j.id).filter(i => i.name);
  const planned = isPlanned(j);
  const chip = planned
    ? (j.date < today() ? '<span class="chip bad">Overdue</span>' : j.date <= addDays(today(), prefs.remindDays) ? `<span class="chip warn">${dueText(j)}</span>` : `<span class="chip">${dueText(j)}</span>`)
    : `<strong class="num">${inr(st.total)}</strong>`;
  const extra = j.kind === 'fertilizer'
    ? `Effect expected ${fmtMonth(addMonths(j.date, prefs.fertLagMin))} – ${fmtMonth(addMonths(j.date, prefs.fertLagMax))}`
    : j.plants ? plural(j.plants, 'sapling') + ' treated' : '';
  return `
    <a class="card link" href="#/care/${j.id}">
      <div class="row spread"><strong>${KIND[j.kind].icon} ${h(jobName(j))}</strong>${chip}</div>
      <div class="muted small">${fmtDate(j.date)}${items.length ? ' · ' + items.map(i => h(i.name) + (i.qty ? ` ${nf2.format(i.qty)} ${h(i.unit || '')}` : '')).join(', ') : ''}</div>
      ${!planned && extra ? `<div class="muted small">${extra}</div>` : ''}
    </a>`;
}

function viewCare() {
  const fert = jobsOf('fertilizer').sort(byDate).reverse();
  const pest = jobsOf('pesticide');
  const planned = pest.filter(isPlanned).sort(byDate);
  const done = pest.filter(j => !isPlanned(j)).sort(byDate).reverse();
  const year = today().slice(0, 4);
  const spend = kind => sum(jobsOf(kind).filter(j => !isPlanned(j) && String(j.date).startsWith(year)).map(j => jobStats(j).total));
  return {
    html: `
      <h1>Farm care</h1>
      ${reminderBanner()}
      <div class="grid g2" style="margin-bottom:10px">
        <button class="btn primary" data-action="newJob" data-kind="fertilizer">+ Fertilizing</button>
        <button class="btn primary" data-action="newJob" data-kind="pesticide">+ Pesticide</button>
      </div>
      <div class="card"><div class="stats">
        ${statTile(`Fertilizer ${year}`, inr(spend('fertilizer')))}
        ${statTile(`Pesticide ${year}`, inr(spend('pesticide')))}
        ${statTile('Planned rounds', planned.length)}
      </div></div>

      <div class="section-title"><h2>Pesticide schedule</h2><a class="btn sm" href="#/care/plan">📅 Plan schedule</a></div>
      ${planned.map(careCard).join('') || '<p class="muted small">No rounds planned. Use “Plan schedule” to plan the year ahead.</p>'}

      <div class="section-title"><h2>Fertilizing sessions</h2></div>
      ${fert.map(careCard).join('') || '<p class="muted small">None recorded yet.</p>'}

      <div class="section-title"><h2>Pesticide sessions done</h2></div>
      ${done.map(careCard).join('') || '<p class="muted small">None recorded yet.</p>'}`,
  };
}

function viewJob(id) {
  const j = byId('jobs', id);
  if (!j) return notFound();
  const K = KIND[j.kind] || KIND.fertilizer;
  const pest = j.kind === 'pesticide';
  const planned = isPlanned(j);
  const workers = jobWorkersOf(id), items = jobItemsOf(id), expenses = jobExpensesOf(id);

  const workerRows = workers.map(w => `
    <div class="sub">
      <div class="row" style="margin-bottom:8px">
        <input class="grow" type="text" list="careWorkerNames" placeholder="Worker name" aria-label="Worker name" data-t="jobWorkers" data-id="${w.id}" data-f="name" value="${h(w.name)}">
        <button class="icon-btn" title="Remove" data-action="delJobWorker" data-id="${w.id}">✕</button>
      </div>
      <div class="grid g2">${dateInput('jobWorkers', w, 'date', 'Date worked')}${numInput('jobWorkers', w, 'fee', 'Fee (₹)')}</div>
    </div>`).join('');

  const itemRows = items.map(i => `
    <div class="sub">
      <div class="row" style="margin-bottom:8px">
        <input class="grow" type="text" list="materialNames" placeholder="${K.material} name" aria-label="${K.material} name" data-t="jobItems" data-id="${i.id}" data-f="name" value="${h(i.name)}">
        <button class="icon-btn" title="Remove" data-action="delJobItem" data-id="${i.id}">✕</button>
      </div>
      ${pest
        ? `<div class="grid g4">${numInput('jobItems', i, 'qty', 'Quantity')}${textInput('jobItems', i, 'unit', 'Unit', 'placeholder="L / ml / kg"')}${numInput('jobItems', i, 'rate', 'Rate (₹/unit)')}${numInput('jobItems', i, 'amount', 'Amount (₹)')}</div>`
        : `<div class="grid g2">${numInput('jobItems', i, 'qty', 'Weight (kg)')}${numInput('jobItems', i, 'amount', 'Amount (₹)')}</div>`}
    </div>`).join('');

  const expenseRows = expenses.map(x => `
    <div class="line-row">
      <input class="grow" type="text" placeholder="e.g. Transport, tools" aria-label="Expense" data-t="jobExpenses" data-id="${x.id}" data-f="name" value="${h(x.name)}">
      <input class="fee" type="number" inputmode="decimal" min="0" step="any" placeholder="₹" aria-label="Amount" data-t="jobExpenses" data-id="${x.id}" data-f="amount" value="${valAttr(x.amount)}">
      <button class="icon-btn" title="Remove" data-action="delJobExpense" data-id="${x.id}">✕</button>
    </div>`).join('');

  const canCopy = !workers.some(w => w.name) && !items.some(i => i.name) &&
    jobsOf(j.kind).some(o => o.id !== id && (jobItemsOf(o.id).length || jobWorkersOf(o.id).length));

  return {
    html: `
      <a class="back" href="#/care">‹ Farm care</a>
      <div class="row spread"><h1 data-jname>${K.icon} ${h(jobName(j))}</h1>
        ${pest ? (planned ? '<span class="chip warn">Planned</span>' : '<span class="chip good">✓ Done</span>') : ''}</div>
      ${planned ? `<div class="banner remind">Planned for <strong>${fmtDate(j.date)}</strong> (${dueText(j)}). Mark it as done once the pesticide is applied.</div>` : ''}
      <div class="card">
        <div class="grid g2">
          ${textInput('jobs', j, 'name', 'Session name')}
          ${dateInput('jobs', j, 'date', planned ? 'Planned date' : 'Date')}
          ${pest ? numInput('jobs', j, 'plants', 'Saplings / small trees treated', 'inputmode="numeric" step="1"') : ''}
        </div>
        ${!pest ? `<p class="muted small" style="margin-bottom:0">${calc('effect')}</p>` : ''}
        ${canCopy ? `<button class="btn sm" data-action="copyLastJob" data-id="${id}" style="margin-top:10px">Copy workers & ${K.materials.toLowerCase()} from last time</button>` : ''}
      </div>

      <div class="section-title"><h2>Workers</h2><button class="btn sm" data-action="addJobWorker" data-id="${id}">+ Add worker</button></div>
      ${workerRows || '<p class="muted small">No workers added.</p>'}
      ${datalist('careWorkerNames', uniqueNames([...db().jobWorkers, ...db().workers, ...db().dehuskWorkers], 'name'))}

      <div class="section-title"><h2>${K.materials}</h2><button class="btn sm" data-action="addJobItem" data-id="${id}">+ Add</button></div>
      ${itemRows || '<p class="muted small">Nothing added.</p>'}
      ${datalist('materialNames', uniqueNames(db().jobItems.filter(i => { const o = byId('jobs', i.jobId); return o && o.kind === j.kind; }), 'name'))}

      <div class="section-title"><h2>Other expenses</h2><button class="btn sm" data-action="addJobExpense" data-id="${id}">+ Add</button></div>
      ${expenseRows ? `<div class="card">${expenseRows}</div>` : '<p class="muted small">None.</p>'}

      <div class="card">
        <div class="kv"><span>Workers</span>${calc('labour')}</div>
        <div class="kv"><span>${K.materials}</span>${calc('materials')}</div>
        <div class="kv"><span>Other expenses</span>${calc('other')}</div>
        <div class="kv total"><span>Total</span>${calc('total')}</div>
      </div>

      <div class="card"><label class="field">Notes<textarea data-t="jobs" data-id="${id}" data-f="notes">${h(j.notes)}</textarea></label></div>
      ${pest ? (planned
        ? `<button class="btn primary block" data-action="markJobDone" data-id="${id}" style="margin-bottom:10px">✓ Mark as done (applied)</button>`
        : `<button class="btn block" data-action="markJobPlanned" data-id="${id}" style="margin-bottom:10px">Move back to planned</button>`) : ''}
      <button class="btn danger ghost block" data-action="delJob" data-id="${id}">Delete this session</button>
      ${saveBar()}`,
    calc: () => {
      const st = jobStats(j);
      return {
        labour: inr(st.labour), materials: inr(st.materials), other: inr(st.other), total: inr(st.total),
        effect: `Expected to show in harvests from ${fmtMonth(addMonths(j.date, prefs.fertLagMin))} to ${fmtMonth(addMonths(j.date, prefs.fertLagMax))}.`,
      };
    },
  };
}

function planDates() {
  const v = id => ($(`#${id}`) || {}).value;
  const start = v('planStart'), every = Math.max(1, Number(v('planEvery')) || 1), unit = v('planUnit'), rounds = Math.min(60, Math.max(1, Number(v('planRounds')) || 1));
  if (!start) return [];
  return Array.from({ length: rounds }, (_, i) => (unit === 'days' ? addDays(start, i * every) : addMonths(start, i * every)));
}
function updatePlanPreview() {
  const el = $('#planPreview');
  if (!el) return;
  const dates = planDates();
  const prefix = ($('#planName') || {}).value || 'Pesticide round';
  const n = jobsOf('pesticide').length;
  el.innerHTML = dates.length
    ? `<div class="muted small" style="margin-bottom:6px">${plural(dates.length, 'round')} until ${fmtDate(dates[dates.length - 1])}</div>` +
      dates.map((d, i) => `<div class="kv small"><span>${h(prefix)} ${n + i + 1}</span><span>${fmtDate(d)}</span></div>`).join('')
    : '<p class="muted small">Choose a start date.</p>';
}

function viewPlan() {
  const pest = jobsOf('pesticide').sort(byDate);
  const planned = pest.filter(isPlanned);
  const lastDate = pest.length ? pest[pest.length - 1].date : '';
  const start = lastDate && lastDate >= today() ? addMonths(lastDate, 2) : today();
  return {
    html: `
      <a class="back" href="#/care">‹ Farm care</a>
      <h1>Plan pesticide schedule</h1>
      <div class="card">
        <div class="grid g2">
          <label class="field">First round<input id="planStart" type="date" value="${start}"></label>
          <label class="field">Name<input id="planName" type="text" value="Pesticide round"></label>
          <label class="field">Repeat every<input id="planEvery" type="number" inputmode="numeric" min="1" value="2"></label>
          <label class="field">Unit<select id="planUnit"><option value="months" selected>Months</option><option value="days">Days</option></select></label>
          <label class="field">Number of rounds<input id="planRounds" type="number" inputmode="numeric" min="1" max="60" value="6"></label>
        </div>
        <div id="planPreview" style="margin-top:12px"></div>
        <button class="btn primary block" data-action="createPlan" style="margin-top:12px">Add these rounds to the schedule</button>
        <p class="muted small" style="margin-bottom:0">You'll be reminded from ${prefs.remindDays} days before each round, in the app and by email.</p>
      </div>
      ${planned.length ? `
        <div class="section-title"><h2>Already planned</h2><button class="btn sm danger" data-action="clearPlanned">Remove all planned</button></div>
        ${planned.map(careCard).join('')}` : ''}`,
    after: updatePlanPreview,
  };
}

function notFound() {
  return { html: `<div class="empty"><p>That record no longer exists.</p><a class="btn" href="#/">Back to home</a></div>` };
}

/* ---------- Actions ---------- */

function nextSortOrder(list) { return list.reduce((m, r) => Math.max(m, r.sortOrder || 0), 0) + 1; }
function lastTransportName(plotName) {
  const plotIds = new Set(db().plots.filter(p => normName(p.name) === normName(plotName)).map(p => p.id));
  const pool = db().transport.filter(t => plotIds.has(t.plotId) && t.name);
  const t = (pool.length ? pool : db().transport.filter(x => x.name)).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).pop();
  return t ? t.name : '';
}
// The most recent coconut rate entered for the climbers' share, by session date then plot order.
function lastNutRate() {
  const sessions = new Map(db().sessions.map(s => [s.id, s]));
  const rated = db().plots.filter(p => p.nutRate > 0)
    .sort((a, b) => byDate(sessions.get(a.sessionId) || {}, sessions.get(b.sessionId) || {}) || bySort(a, b));
  return rated.length ? rated[rated.length - 1].nutRate : 0;
}
function addPlotRecord(sid, name, sortOrder) {
  const p = { id: uid(), sessionId: sid, name, workers: workersOf(sid).length, trees: 0, coconuts: 0, nutsTaken: 0, nutRate: lastNutRate(), sortOrder };
  put('plots', p);
  put('transport', { id: uid(), plotId: p.id, name: lastTransportName(name), fee: 0, sortOrder: 1 });
  return p;
}
function setTrees(pid, wid, delta) {
  const id = treeId(pid, wid);
  const rec = byId('plotTrees', id) || { id, plotId: pid, workerId: wid, trees: 0 };
  rec.trees = Math.max(0, (rec.trees || 0) + delta);
  put('plotTrees', rec);
  const p = byId('plots', pid);
  patch('plots', p, { trees: plotTreeTotal(p) });
  $$(`[data-count="${id}"]`).forEach(el => { el.textContent = rec.trees; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); });
  if (delta > 0 && navigator.vibrate) navigator.vibrate(15);
  refreshCalcs();
}

const actions = {
  newSession() {
    const asc = sessionsAsc();
    const running = asc.filter(isActive);
    if (running.length && !confirm(`A plucking session started on ${fmtDate(running[running.length - 1].date)} is still in progress. Start a new one anyway?`)) return;
    const last = asc[asc.length - 1];
    const s = { id: uid(), name: defaultSessionName(today()), date: today(), status: 'active', workers: 0, workerFee: 0, climberRate: last ? last.climberRate || 0 : 0, notes: '' };
    put('sessions', s);
    // Start with the same crew as last time; remove anyone who didn't come.
    (last ? workersOf(last.id) : []).forEach((w, i) => put('workers', { id: uid(), sessionId: s.id, name: w.name, type: w.type, fee: 0, sortOrder: i + 1 }));
    const lastPlots = last ? plotsOf(last.id) : [];
    addPlotRecord(s.id, lastPlots[0] ? lastPlots[0].name : 'Main plot', 1);
    refreshDerived(s.id);
    location.hash = `#/session/${s.id}`;
  },
  addWorker({ id, type }) {
    const w = { id: uid(), sessionId: id, name: '', type, fee: 0, sortOrder: nextSortOrder(workersOf(id)) };
    put('workers', w);
    refreshDerived(id);
    render({ keepScroll: true, focusId: w.id, focusField: 'name' });
  },
  delWorker({ id }) {
    const w = byId('workers', id);
    const trees = workerTrees(id);
    if ((w.name || trees || w.fee) && !confirm(`Remove ${w.name || 'this worker'}${trees ? ` and their ${trees} tree count` : ''}?`)) return;
    deleteWorker(id);
    refreshDerived(w.sessionId);
    render({ keepScroll: true });
  },
  openCounter({ id }) {
    counterFromApp = true;
    location.hash = `#/session/${byId('plots', id).sessionId}/count/${id}`;
  },
  closeCounter({ id }) {
    if (counterFromApp) { counterFromApp = false; history.back(); } else location.replace(`#/session/${id}`);
  },
  treeInc({ plot, worker }) { setTrees(plot, worker, 1); },
  treeDec({ plot, worker }) { setTrees(plot, worker, -1); },
  applyRate({ id }) {
    const s = byId('sessions', id);
    if (!s.climberRate) return toast('Enter the rate per tree first');
    climbersOf(id).forEach(w => patch('workers', w, { fee: round2(workerTrees(w.id) * s.climberRate) }));
    refreshDerived(id);
    render({ keepScroll: true });
    toast('Climber fees updated from trees climbed');
  },
  addPlot({ id }) {
    const plots = plotsOf(id);
    const used = new Set(plots.map(p => normName(p.name)));
    const suggestion = uniqueNames(db().plots, 'name').find(n => !used.has(normName(n))) || `Plot ${plots.length + 1}`;
    const p = addPlotRecord(id, suggestion, nextSortOrder(plots));
    render({ keepScroll: true, focusId: p.id, focusField: 'name' });
  },
  delPlot({ id }) {
    const p = byId('plots', id);
    if ((plotTreeTotal(p) || p.coconuts) && !confirm(`Remove plot "${p.name}" and its tree counts?`)) return;
    deletePlot(id);
    render({ keepScroll: true });
  },
  addTransport({ id }) {
    const t = { id: uid(), plotId: id, name: '', fee: 0, sortOrder: nextSortOrder(transportOf(id)) };
    put('transport', t);
    render({ keepScroll: true, focusId: t.id, focusField: 'name' });
  },
  delTransport({ id }) {
    del('transport', id);
    render({ keepScroll: true });
  },
  addDehusk({ id }) {
    const st = stats(byId('sessions', id));
    const d = { id: uid(), sessionId: id, date: today(), coconuts: Math.max(0, st.saleNuts - st.dehuskCoconuts), fee: 0, notes: '' };
    put('dehusking', d);
    // Start with the people from the most recent dehusking.
    const lastD = db().dehusking.filter(x => x.id !== d.id && dehuskWorkersOf(x.id).length).sort(byDate).pop();
    const names = lastD ? dehuskWorkersOf(lastD.id).map(w => w.name) : [''];
    names.forEach((name, i) => put('dehuskWorkers', { id: uid(), dehuskId: d.id, name, fee: 0, sortOrder: i + 1 }));
    render({ keepScroll: true, focusId: d.id, focusField: 'coconuts' });
  },
  delDehusk({ id }) {
    if (!confirm('Remove this dehusking entry?')) return;
    deleteDehusk(id);
    render({ keepScroll: true });
  },
  addDehuskWorker({ id }) {
    const w = { id: uid(), dehuskId: id, name: '', fee: 0, sortOrder: nextSortOrder(dehuskWorkersOf(id)) };
    put('dehuskWorkers', w);
    render({ keepScroll: true, focusId: w.id, focusField: 'name' });
  },
  delDehuskWorker({ id }) {
    const w = byId('dehuskWorkers', id);
    del('dehuskWorkers', id);
    const d = byId('dehusking', w.dehuskId);
    if (d) patch('dehusking', d, { fee: dehuskFeeOf(d) });
    render({ keepScroll: true });
  },
  completeSession({ id }) {
    patch('sessions', byId('sessions', id), { status: 'completed' });
    actions.saveNow();
    render({ keepScroll: true });
  },
  reopenSession({ id }) {
    patch('sessions', byId('sessions', id), { status: 'active' });
    render({ keepScroll: true });
  },
  addSale({ id }) {
    const x = { id: uid(), sessionId: id, date: today(), notes: '' };
    put('sales', x);
    put('saleItems', { id: uid(), saleId: x.id, customer: '', kg: 0, rate: lastRate(), total: 0, paid: false, sortOrder: 1 });
    location.hash = `#/sale/${x.id}`;
  },
  delSale({ id }) {
    if (!confirm('Delete this sales session and all its customer entries?')) return;
    const x = byId('sales', id);
    deleteSale(id);
    location.hash = `#/session/${x.sessionId}`;
  },
  addItem({ id }) {
    const items = itemsOf(id);
    const it = { id: uid(), saleId: id, customer: '', kg: 0, rate: items.length ? items[items.length - 1].rate : lastRate(), total: 0, paid: false, sortOrder: nextSortOrder(items) };
    put('saleItems', it);
    render({ keepScroll: true, focusId: it.id, focusField: 'customer' });
  },
  delItem({ id }) {
    const it = byId('saleItems', id);
    if ((it.customer || it.total) && !confirm(`Remove ${it.customer || 'this customer'}?`)) return;
    del('saleItems', id);
    render({ keepScroll: true });
  },
  markAllPaid({ id }) {
    itemsOf(id).filter(i => !i.paid).forEach(i => { i.paid = true; put('saleItems', i); });
    render({ keepScroll: true });
  },
  payItem({ id }) {
    const i = byId('saleItems', id);
    i.paid = true;
    put('saleItems', i);
    toast(`Marked ${inr(i.total)} from ${i.customer || 'customer'} as received`);
    render({ keepScroll: true });
  },
  payCustomer({ name }) {
    const items = unpaidItems().filter(i => normName(i.customer) === name);
    items.forEach(i => { i.paid = true; put('saleItems', i); });
    toast(`Marked ${inr(sum(items, 'total'))} as received`);
    render({ keepScroll: true });
  },
  delSession({ id }) {
    if (!confirm('Delete this plucking session, including its workers, plots, transport, dehusking and sales?')) return;
    deleteSession(id);
    location.hash = '#/';
  },
  newJob({ kind }) {
    const date = today();
    const j = { id: uid(), kind, name: `${KIND[kind].label} ${fmtMonth(date)}`, date, status: kind === 'pesticide' ? 'done' : '', plants: 0, notes: '' };
    put('jobs', j);
    put('jobWorkers', { id: uid(), jobId: j.id, name: '', date, fee: 0, sortOrder: 1 });
    put('jobItems', { id: uid(), jobId: j.id, name: '', qty: 0, unit: kind === 'fertilizer' ? 'kg' : '', rate: 0, amount: 0, sortOrder: 1 });
    location.hash = `#/care/${j.id}`;
  },
  addJobWorker({ id }) {
    const ws = jobWorkersOf(id);
    const w = { id: uid(), jobId: id, name: '', date: ws.length ? ws[ws.length - 1].date : byId('jobs', id).date, fee: 0, sortOrder: nextSortOrder(ws) };
    put('jobWorkers', w);
    render({ keepScroll: true, focusId: w.id, focusField: 'name' });
  },
  addJobItem({ id }) {
    const j = byId('jobs', id);
    const it = { id: uid(), jobId: id, name: '', qty: 0, unit: j.kind === 'fertilizer' ? 'kg' : '', rate: 0, amount: 0, sortOrder: nextSortOrder(jobItemsOf(id)) };
    put('jobItems', it);
    render({ keepScroll: true, focusId: it.id, focusField: 'name' });
  },
  addJobExpense({ id }) {
    const x = { id: uid(), jobId: id, name: '', amount: 0, sortOrder: nextSortOrder(jobExpensesOf(id)) };
    put('jobExpenses', x);
    render({ keepScroll: true, focusId: x.id, focusField: 'name' });
  },
  delJobWorker({ id }) { del('jobWorkers', id); render({ keepScroll: true }); },
  delJobItem({ id }) { del('jobItems', id); render({ keepScroll: true }); },
  delJobExpense({ id }) { del('jobExpenses', id); render({ keepScroll: true }); },
  copyLastJob({ id }) {
    const j = byId('jobs', id);
    const last = jobsOf(j.kind).filter(o => o.id !== id && (jobItemsOf(o.id).length || jobWorkersOf(o.id).length) && !isPlanned(o)).sort(byDate).pop()
      || jobsOf(j.kind).filter(o => o.id !== id && (jobItemsOf(o.id).length || jobWorkersOf(o.id).length)).sort(byDate).pop();
    if (!last) return;
    // Replace the empty starter rows with last time's people and materials (prices kept as a starting point).
    jobWorkersOf(id).filter(w => !w.name && !w.fee).forEach(w => del('jobWorkers', w.id));
    jobItemsOf(id).filter(i => !i.name && !i.amount).forEach(i => del('jobItems', i.id));
    jobWorkersOf(last.id).forEach((w, n) => put('jobWorkers', { id: uid(), jobId: id, name: w.name, date: j.date, fee: w.fee, sortOrder: n + 1 }));
    jobItemsOf(last.id).forEach((i, n) => put('jobItems', { id: uid(), jobId: id, name: i.name, qty: i.qty, unit: i.unit, rate: i.rate, amount: i.amount, sortOrder: n + 1 }));
    if (j.kind === 'pesticide' && !j.plants && last.plants) patch('jobs', j, { plants: last.plants });
    toast(`Copied from ${jobName(last)}. Check the amounts.`);
    render({ keepScroll: true });
  },
  markJobDone({ id }) {
    const j = byId('jobs', id);
    patch('jobs', j, { status: 'done', date: j.date > today() ? today() : j.date });
    actions.saveNow();
    render({ keepScroll: true });
  },
  markJobPlanned({ id }) {
    patch('jobs', byId('jobs', id), { status: 'planned' });
    render({ keepScroll: true });
  },
  delJob({ id }) {
    if (!confirm('Delete this session with its workers, materials and expenses?')) return;
    deleteJob(id);
    location.hash = '#/care';
  },
  createPlan() {
    const dates = planDates();
    if (!dates.length) return toast('Choose a start date');
    const prefix = ($('#planName').value || 'Pesticide round').trim();
    const n = jobsOf('pesticide').length;
    dates.forEach((date, i) => put('jobs', { id: uid(), kind: 'pesticide', name: `${prefix} ${n + i + 1}`, date, status: 'planned', plants: 0, notes: '' }));
    toast(`${plural(dates.length, 'round')} added to the schedule`);
    location.hash = '#/care';
  },
  clearPlanned() {
    const planned = jobsOf('pesticide').filter(isPlanned);
    if (!confirm(`Remove all ${planned.length} planned rounds? Rounds already done are kept.`)) return;
    planned.forEach(j => deleteJob(j.id));
    render({ keepScroll: true });
  },
  async saveNow() {
    saveLocal();
    if (!configured()) return toast('Saved on this device');
    if (!navigator.onLine) return toast('Saved on this device · will sync when online');
    await sync();
    toast(store.syncState === 'ok' ? 'Saved to Google Sheets' : `Saved on device · sync failed: ${store.syncError}`);
  },
  async saveSettings() {
    store.config = { url: $('#cfgUrl').value.trim(), token: $('#cfgToken').value.trim() };
    saveJSON('cp.config', store.config);
    if (!configured()) { updateSyncUI(); return toast('Settings saved'); }
    toast('Connecting…');
    await sync();
    toast(store.syncState === 'ok' ? 'Connected · data is syncing to Google Sheets' : `Could not connect: ${store.syncError}`);
  },
  async syncNow() {
    if (!configured()) return toast('Connect Google Sheets first');
    await sync();
    toast(store.syncState === 'ok' ? 'Synced' : `Sync failed: ${store.syncError}`);
  },
  exportJson() {
    const blob = new Blob([JSON.stringify(store.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `coconut-backup-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};

function lastRate() {
  const withRate = db().saleItems.filter(i => i.rate > 0);
  if (!withRate.length) return 0;
  const sales = new Map(db().sales.map(s => [s.id, s]));
  withRate.sort((a, b) => byDate(sales.get(a.saleId) || {}, sales.get(b.saleId) || {}) || (a.sortOrder || 0) - (b.sortOrder || 0));
  return withRate[withRate.length - 1].rate;
}

/* ---------- Field editing (auto-save) ---------- */

function onFieldInput(el) {
  const { t, id, f } = el.dataset;
  const rec = byId(t, id);
  if (!rec) return;
  const isNum = (SCHEMA[t].num || []).includes(f);
  const prevVal = rec[f];
  rec[f] = isNum ? (el.value === '' ? 0 : Number(el.value) || 0) : el.value;
  if (t === 'saleItems' && (f === 'kg' || f === 'rate')) {
    rec.total = round2(rec.kg * rec.rate);
    const ti = $(`[data-t="saleItems"][data-id="${id}"][data-f="total"]`);
    if (ti) ti.value = rec.total || '';
  }
  put(t, rec);

  if (t === 'sessions' && (f === 'name' || f === 'date')) $$('[data-sname]').forEach(n => { n.textContent = sessionName(rec); });
  if (t === 'workers' && f === 'name') $$(`[data-wname="${id}"]`).forEach(n => { if (n !== el) n.textContent = workerName(rec); });
  if (t === 'workers') refreshDerived(rec.sessionId);
  if (t === 'dehuskWorkers') { const d = byId('dehusking', rec.dehuskId); if (d) patch('dehusking', d, { fee: dehuskFeeOf(d) }); }
  if (t === 'jobItems' && (f === 'qty' || f === 'rate') && rec.rate > 0) {
    patch('jobItems', rec, { amount: round2(rec.qty * rec.rate) });
    const ai = $(`[data-t="jobItems"][data-id="${id}"][data-f="amount"]`);
    if (ai) ai.value = rec.amount || '';
  }
  if (t === 'jobs' && f === 'date') {
    // Workers still on the session's old date move with it.
    jobWorkersOf(id).filter(w => w.date === prevVal).forEach(w => {
      patch('jobWorkers', w, { date: rec.date });
      const di = $(`[data-t="jobWorkers"][data-id="${w.id}"][data-f="date"]`);
      if (di) di.value = rec.date;
    });
  }
  if (t === 'jobs' && (f === 'name' || f === 'date')) $$('[data-jname]').forEach(n => { n.textContent = `${KIND[rec.kind].icon} ${jobName(rec)}`; });
  if (t === 'workers' && f === 'type') return render({ keepScroll: true });
  refreshCalcs();
}

/* ---------- Rendering & routing ---------- */

const routes = [
  [/^#\/?$/, viewHome, 'sessions'],
  [/^#\/session\/([\w-]+)$/, viewSession, 'sessions'],
  [/^#\/sale\/([\w-]+)$/, viewSale, 'sessions'],
  [/^#\/dues$/, viewDues, 'dues'],
  [/^#\/analytics$/, viewAnalytics, 'analytics'],
  [/^#\/settings$/, viewSettings, 'settings'],
  [/^#\/care\/?$/, viewCare, 'care'],
  [/^#\/care\/plan$/, viewPlan, 'care'],
  [/^#\/care\/([\w-]+)$/, viewJob, 'care'],
];
let currentView = null;
let pendingRender = false;

const COUNT_ROUTE = /^(#\/session\/[\w-]+)\/count\/([\w-]+)$/;
let lastBase = null;
let counterFromApp = false;

function render({ keepScroll = false, focusId = null, focusField = null, fromHash = false } = {}) {
  const hash = location.hash || '#/';
  const cm = hash.match(COUNT_ROUTE);
  const base = cm ? cm[1] : hash;
  // Opening/closing the counter or switching its plot keeps the page underneath as it is.
  if (!(fromHash && base === lastBase)) renderPage(base, { keepScroll, focusId, focusField });
  lastBase = base;
  renderCounter(cm ? cm[2] : null);
}

function renderPage(hash, { keepScroll, focusId, focusField }) {
  let view = null, tab = 'sessions';
  for (const [re, fn, t] of routes) {
    const m = hash.match(re);
    if (m) { view = fn(...m.slice(1)); tab = t; break; }
  }
  if (!view) view = notFound();
  const y = scrollY;
  $('#app').innerHTML = view.html;
  currentView = view;
  refreshCalcs();
  updateSyncUI();
  if (view.after) view.after();
  $$('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  window.scrollTo(0, keepScroll ? y : 0);
  if (focusId) {
    const el = $(`[data-id="${focusId}"][data-f="${focusField}"]`);
    if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
}

// Full-screen tree counter for use in the field: large buttons, screen kept awake.
function renderCounter(pid) {
  const el = $('#counter');
  const p = pid && byId('plots', pid);
  if (!p) {
    el.hidden = true;
    el.innerHTML = '';
    document.body.classList.remove('locked');
    releaseWake();
    return;
  }
  const s = byId('sessions', p.sessionId);
  const plots = plotsOf(p.sessionId);
  const climbers = climbersOf(p.sessionId);
  el.innerHTML = `
    <div class="counter-head">
      <button class="btn" data-action="closeCounter" data-id="${p.sessionId}">‹ Done</button>
      <div class="counter-title"><div class="muted small">${h(sessionName(s))}</div><strong>${h(p.name || 'Plot')}</strong></div>
      <div class="counter-total"><span data-calc="plotTrees_${p.id}">${num(plotTreeTotal(p))}</span><small>trees</small></div>
    </div>
    ${plots.length > 1 ? `<div class="plot-tabs">${plots.map(x => `<a href="#/session/${p.sessionId}/count/${x.id}" class="${x.id === p.id ? 'on' : ''}">${h(x.name || 'Plot')}</a>`).join('')}</div>` : ''}
    <div class="counter-list">
      ${climbers.map(w => `
        <div class="big-counter">
          <div class="bc-name">${workerLabel(w)}</div>
          <div class="bc-row">
            <button class="bc-minus" data-action="treeDec" data-plot="${p.id}" data-worker="${w.id}" aria-label="Remove one tree for ${workerLabel(w)}">−</button>
            <div class="bc-count" data-count="${treeId(p.id, w.id)}">${treesOf(p.id, w.id)}</div>
            <button class="bc-plus" data-action="treeInc" data-plot="${p.id}" data-worker="${w.id}" aria-label="Add one tree for ${workerLabel(w)}">+1</button>
          </div>
        </div>`).join('') || '<div class="empty">Add climbers in the Workers section first.</div>'}
    </div>
    <div class="counter-foot small"><span data-save></span></div>`;
  el.hidden = false;
  document.body.classList.add('locked');
  refreshCalcs();
  updateSyncUI();
  requestWake();
}

let wakeLock = null;
async function requestWake() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or not allowed */ }
}
function releaseWake() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function refreshCalcs() {
  if (!currentView || !currentView.calc) return;
  const vals = currentView.calc();
  $$('[data-calc]').forEach(el => { if (el.dataset.calc in vals) el.textContent = vals[el.dataset.calc]; });
}

const isEditing = () => { const a = document.activeElement; return a && $('#app').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };

// Re-render after a background sync without stealing focus from an input.
function softRender() {
  if (isEditing()) { pendingRender = true; return; }
  render({ keepScroll: true });
}

function init() {
  const app = $('#app');
  app.addEventListener('input', e => { if (e.target.dataset.t) onFieldInput(e.target); });
  app.addEventListener('change', e => {
    const id = e.target.dataset.paid;
    if (!id) return;
    const it = byId('saleItems', id);
    it.paid = e.target.checked;
    put('saleItems', it);
    e.target.closest('.paid-toggle').outerHTML = paidToggle(it);
    refreshCalcs();
  });
  const onAction = e => {
    const b = e.target.closest('[data-action]');
    if (b && actions[b.dataset.action]) { e.preventDefault(); actions[b.dataset.action]({ ...b.dataset }); }
  };
  app.addEventListener('click', onAction);
  $('#counter').addEventListener('click', onAction);
  // Settings save as you type; connecting happens when you leave the field.
  app.addEventListener('input', e => {
    if (e.target.id !== 'cfgUrl' && e.target.id !== 'cfgToken') return;
    store.config = { url: $('#cfgUrl').value.trim(), token: $('#cfgToken').value.trim() };
    saveJSON('cp.config', store.config);
    updateSyncUI();
  });
  app.addEventListener('change', e => { if (e.target.id === 'cfgUrl' || e.target.id === 'cfgToken') sync(); });
  app.addEventListener('input', e => {
    const id = e.target.id || '';
    if (id.startsWith('plan')) updatePlanPreview();
    if (id.startsWith('pref')) {
      const key = id[4].toLowerCase() + id.slice(5);
      if (key in prefs) { prefs[key] = Math.max(0, Number(e.target.value) || 0); saveJSON('cp.prefs', prefs); }
    }
  });
  app.addEventListener('focusout', () => {
    setTimeout(() => { if (pendingRender && !isEditing()) { pendingRender = false; render({ keepScroll: true }); } }, 0);
  });
  $('#syncBtn').addEventListener('click', () => (configured() ? actions.syncNow() : (location.hash = '#/settings')));
  addEventListener('hashchange', () => render({ fromHash: true }));
  addEventListener('online', () => sync());
  addEventListener('offline', updateSyncUI);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { sync(); if (!$('#counter').hidden) requestWake(); }
    else saveLocal();
  });
  initTooltips();
  render();
  sync();
  // Keep retrying while changes are waiting, e.g. after poor signal on the farm.
  setInterval(() => { if (Object.keys(store.outbox).length && navigator.onLine) sync(); }, 30000);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
