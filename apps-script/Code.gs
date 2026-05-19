// ─────────────────────────────────────────────────────────────────────────────
// IIP Dashboard — Sheet Writer (Apps Script web app)
// ─────────────────────────────────────────────────────────────────────────────
// This Apps Script is the write-back endpoint for the /leads CRM page.
// The CRM POSTs JSON updates here; this script writes them to the sheet.
//
// DEPLOY INSTRUCTIONS:
//   1. Open the IIP Leads Google Sheet
//   2. Extensions → Apps Script
//   3. Replace any existing code with this file's contents
//   4. (Optional) change SHARED_SECRET below to a random string
//   5. Click "Deploy" → "New deployment"
//      • Type: Web app
//      • Execute as: Me (your account)
//      • Who has access: Anyone
//   6. Click "Deploy", authorize, copy the Web app URL
//   7. In Vercel project settings → Environment Variables, add:
//        APPS_SCRIPT_URL = <the URL you copied>
//        APPS_SCRIPT_SECRET = <same string as SHARED_SECRET below, or leave empty>
//   8. Redeploy the Vercel project so the new env vars take effect.
// ─────────────────────────────────────────────────────────────────────────────

// Set this to any random string to require the same string in every POST.
// Leave as '' to disable. Must match APPS_SCRIPT_SECRET in Vercel.
const SHARED_SECRET = '';

// The spreadsheet this script writes to. The script must be bound to this
// sheet (Extensions → Apps Script from inside the sheet does this for you).
const SPREADSHEET_ID = '14YB5KhwvAVnyw6zDdxa0AZhscIIDq4l7OUyzi3vfODk';

// ─── POST handler ───────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    if (SHARED_SECRET && body.secret !== SHARED_SECRET) {
      return _json({ ok: false, error: 'unauthorized' });
    }

    const { sheet, rowNumber, updates } = body;
    if (!sheet || !rowNumber || !updates || typeof updates !== 'object') {
      return _json({ ok: false, error: 'missing sheet, rowNumber, or updates' });
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sh = ss.getSheetByName(sheet);
    if (!sh) return _json({ ok: false, error: 'sheet not found: ' + sheet });

    const lastCol = sh.getLastColumn();
    const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    const normalize = (s) => String(s || '').trim().toLowerCase();
    const headerIdx = {};
    headerRow.forEach((h, i) => { headerIdx[normalize(h)] = i; });

    const applied = [];
    const skipped = [];
    for (const field of Object.keys(updates)) {
      const colIdx = _findColumn(headerIdx, field, sheet);
      if (colIdx === -1) {
        skipped.push(field);
        continue;
      }
      let value = updates[field];
      // Treat undefined / null as blank string so we can clear cells too.
      if (value === undefined || value === null) value = '';
      sh.getRange(rowNumber, colIdx + 1).setValue(value);
      applied.push({ field, column: colIdx + 1, value });
    }

    return _json({ ok: true, sheet, rowNumber, applied, skipped });
  } catch (err) {
    return _json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

// GET handler — useful for health-checking from a browser.
function doGet() {
  return _json({ ok: true, message: 'IIP Sheet writer ready. POST JSON updates here.' });
}

// Sheet-specific fallback column indices (0-based) for columns whose header
// row is blank or unusual. Used when header lookup fails.
const SHEET_COLUMN_FALLBACKS = {
  'Interview': {
    'other details': 20, // col U — notes column has no header on Interview
    'notes': 20,
  },
};

// Look up a column index by header name. Tries a few synonyms so the CRM
// frontend doesn't have to know each sheet's exact header spelling.
function _findColumn(headerIdx, field, sheetName) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const key = norm(field);
  if (headerIdx[key] !== undefined) return headerIdx[key];

  const aliases = {
    'status': ['status'],
    'called': ['called'],
    'responded': ['responded'],
    'other details': ['other details'],
    'follow up': ['follow up', 'follow up updates'],
    'iip followup': ['iip followup', 'iip followup ', 'follow up iip'],
    'iip team': ['iip team'],
    'notes': ['other details'],
    'assigned': ['iip team'],
    'followup': ['follow up', 'follow up updates'],
  };
  const tryList = aliases[key] || [];
  for (const alias of tryList) {
    if (headerIdx[norm(alias)] !== undefined) return headerIdx[norm(alias)];
  }
  // Last resort: sheet-specific fallback (e.g. Interview's unlabeled notes col)
  const sheetFallback = SHEET_COLUMN_FALLBACKS[sheetName];
  if (sheetFallback && sheetFallback[key] !== undefined) return sheetFallback[key];
  return -1;
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
