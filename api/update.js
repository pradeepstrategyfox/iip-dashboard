// ─── /api/update ───────────────────────────────────────────────────────────
// Proxy POST endpoint that forwards lead updates from the /leads CRM page
// to the Google Apps Script web app, which performs the actual sheet write.
//
// Why proxy through Vercel instead of POSTing directly from the browser?
//   • Keep the APPS_SCRIPT_URL out of the public client (it's still a
//     bearer-style URL even if the script itself enforces a shared secret).
//   • Centralize CORS and error handling.
//   • Allow the frontend to call a stable /api/update path regardless of
//     where the Apps Script is deployed.
//
// Required Vercel env vars:
//   APPS_SCRIPT_URL    — the /exec URL of the deployed Apps Script web app
//   APPS_SCRIPT_SECRET — (optional) must match SHARED_SECRET inside the
//                        Apps Script if you set one
//
// Expected request body (JSON):
//   {
//     "sheet":     "Hindi Leads",         // tab name in the IIP Leads sheet
//     "rowNumber": 127,                   // 1-based, matches the actual row
//     "updates":   { "STATUS": "Interested", "CALLED": true, ... }
//   }

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  // Express may not have parsed it; read the raw stream.
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const url = process.env.APPS_SCRIPT_URL;
  if (!url) {
    return res.status(500).json({
      ok: false,
      error: 'APPS_SCRIPT_URL env var not set. Deploy the Apps Script and add its URL to Vercel env vars.',
    });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body: ' + err.message });
  }

  if (!body || !body.sheet || !body.rowNumber || !body.updates) {
    return res.status(400).json({
      ok: false,
      error: 'Body must include { sheet, rowNumber, updates }',
    });
  }

  // Attach the shared secret if configured
  if (process.env.APPS_SCRIPT_SECRET) {
    body.secret = process.env.APPS_SCRIPT_SECRET;
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      return res.status(502).json({
        ok: false,
        error: 'Apps Script returned non-JSON',
        raw: text.slice(0, 500),
      });
    }
    res.status(parsed.ok ? 200 : 500).json(parsed);
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Upstream fetch failed: ' + err.message });
  }
};
