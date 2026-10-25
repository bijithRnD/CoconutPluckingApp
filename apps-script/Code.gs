/**
 * Coconut Plucking – Google Sheets backend.
 *
 * Paste this file into Extensions → Apps Script of your Google Sheet,
 * run `setup` once, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). See README.md.
 */

// Client table key → sheet name + columns. Column order in the sheet doesn't
// matter after creation: reads and writes are mapped by the header row.
const TABLES = {
  sessions:      { sheet: 'PluckingSessions', cols: ['id', 'name', 'date', 'status', 'workers', 'workerFee', 'climberRate', 'notes', 'updatedAt'] },
  workers:       { sheet: 'Workers',          cols: ['id', 'sessionId', 'name', 'type', 'fee', 'sortOrder', 'updatedAt'] },
  plots:         { sheet: 'Plots',            cols: ['id', 'sessionId', 'name', 'workers', 'trees', 'coconuts', 'sortOrder', 'updatedAt'] },
  plotTrees:     { sheet: 'ClimberTrees',     cols: ['id', 'plotId', 'workerId', 'trees', 'updatedAt'] },
  transport:     { sheet: 'Transport',        cols: ['id', 'plotId', 'name', 'fee', 'sortOrder', 'updatedAt'] },
  dehusking:     { sheet: 'Dehusking',        cols: ['id', 'sessionId', 'date', 'coconuts', 'fee', 'notes', 'updatedAt'] },
  dehuskWorkers: { sheet: 'DehuskWorkers',    cols: ['id', 'dehuskId', 'name', 'fee', 'sortOrder', 'updatedAt'] },
  sales:         { sheet: 'SalesSessions',    cols: ['id', 'sessionId', 'date', 'notes', 'updatedAt'] },
  saleItems:     { sheet: 'SaleItems',        cols: ['id', 'saleId', 'customer', 'kg', 'rate', 'total', 'paid', 'sortOrder', 'updatedAt'] },
};

// Stored as plain text so Sheets doesn't turn dates/IDs/names into other types.
const TEXT_COLS = ['id', 'sessionId', 'saleId', 'plotId', 'workerId', 'dehuskId', 'date', 'status', 'name', 'type', 'customer', 'notes'];

/** Run once from the Apps Script editor. Creates sheets and the API token. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach(function (key) {
    const t = TABLES[key];
    const sh = ss.getSheetByName(t.sheet) || ss.insertSheet(t.sheet);
    const existing = sh.getLastColumn() > 0
      ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].filter(String)
      : [];
    const header = existing.concat(t.cols.filter(function (c) { return existing.indexOf(c) < 0; }));
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    header.forEach(function (c, i) {
      if (TEXT_COLS.indexOf(c) >= 0) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('API_TOKEN');
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty('API_TOKEN', token);
  }
  Logger.log('API token (enter this in the app Settings): ' + token);
}

function doGet(e) {
  return handle_(function () {
    checkToken_(e.parameter.token);
    return readAll_();
  });
}

function doPost(e) {
  return handle_(function () {
    const body = JSON.parse(e.postData.contents);
    checkToken_(body.token);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      applyOps_(body.ops || []);
    } finally {
      lock.releaseLock();
    }
    return body.pull ? readAll_() : { applied: (body.ops || []).length };
  });
}

function handle_(fn) {
  let out;
  try {
    out = { ok: true, data: fn() };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected) throw new Error('Run setup() in Apps Script first.');
  if (token !== expected) throw new Error('Invalid API token.');
}

function sheetFor_(key) {
  const t = TABLES[key];
  if (!t) throw new Error('Unknown table: ' + key);
  const sh = SpreadsheetApp.getActive().getSheetByName(t.sheet);
  if (!sh) throw new Error('Missing sheet ' + t.sheet + '. Run setup().');
  return sh;
}

function readAll_() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const out = {};
  Object.keys(TABLES).forEach(function (key) {
    const values = sheetFor_(key).getDataRange().getValues();
    const header = values.shift() || [];
    out[key] = values
      .filter(function (r) { return r[0] !== ''; })
      .map(function (r) {
        const o = {};
        header.forEach(function (h, i) {
          if (!h) return;
          const v = r[i];
          o[h] = v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v;
        });
        return o;
      });
  });
  return out;
}

/** ops: [{op: 'upsert', table, record}] or [{op: 'delete', table, id}] */
function applyOps_(ops) {
  const byTable = {};
  ops.forEach(function (o) { (byTable[o.table] = byTable[o.table] || []).push(o); });

  Object.keys(byTable).forEach(function (key) {
    const sh = sheetFor_(key);
    const lastCol = sh.getLastColumn();
    const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    const idCol = header.indexOf('id');
    const lastRow = sh.getLastRow();
    const rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
    const rowOf = {};
    rows.forEach(function (r, i) { rowOf[r[idCol]] = i + 2; });

    const toRow = function (rec, current) {
      return header.map(function (h, i) {
        return h in rec ? (rec[h] === null || rec[h] === undefined ? '' : rec[h]) : (current ? current[i] : '');
      });
    };

    const appends = [];
    const deletes = [];
    byTable[key].forEach(function (o) {
      if (o.op === 'upsert') {
        const n = rowOf[o.record.id];
        if (n) sh.getRange(n, 1, 1, lastCol).setValues([toRow(o.record, rows[n - 2])]);
        else appends.push(toRow(o.record, null));
      } else if (o.op === 'delete') {
        if (rowOf[o.id]) deletes.push(rowOf[o.id]);
      }
    });

    deletes.sort(function (a, b) { return b - a; }).forEach(function (n) { sh.deleteRow(n); });
    if (appends.length) {
      const start = sh.getLastRow() + 1;
      const range = sh.getRange(start, 1, appends.length, lastCol);
      header.forEach(function (h, i) {
        if (TEXT_COLS.indexOf(h) >= 0) sh.getRange(start, i + 1, appends.length, 1).setNumberFormat('@');
      });
      range.setValues(appends);
    }
  });
}
