// ─── /api/leads ────────────────────────────────────────────────────────────
// Returns the flat CRM lead list — one row per support-sheet lead, with the
// _sheet + _rowNumber metadata needed by /api/update to write back to the
// exact cell. Each call shares the same in-memory cache as /api/data.

const dataModule = require('./data');

// Canonical lists the CRM uses to populate dropdowns. Derived from existing
// data plus a few values we want present even when no lead has them yet.
const STATUS_OPTIONS = [
  'Not Updated',
  'Not Answered',
  'No Response',
  'Need Time',
  'Need Second Follow-up',
  'Have more Questions',
  'Prospectus Shared',
  'Interested',
  'Not Interested',
  'Ineligible',
  'Other Programmes',
  'Registered',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  // Aggressive edge caching: Vercel CDN serves cached response for 10 min,
  // then up to 24 h of stale-while-revalidate so subsequent users never
  // wait on a cold function start.
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');

  try {
    const forceRefresh = req.url?.includes('refresh=true') || req.query?.refresh === 'true';
    const leads = await dataModule.getLeads(forceRefresh);

    // Collect caller/team values actually present (plus a baseline)
    const teamSet = new Set(['SS', 'AR', 'DV', 'JA']);
    const statusSet = new Set(STATUS_OPTIONS);
    for (const l of leads) {
      if (l.team) teamSet.add(l.team);
      if (l.status) statusSet.add(l.status);
    }

    res.status(200).json({
      success: true,
      count: leads.length,
      leads,
      options: {
        statuses: [...statusSet],
        teams: [...teamSet].sort(),
        campaigns: ['Hindi Video', 'English Video', 'Apple Carousel', 'Interview Video', 'LinkedIn'],
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('/api/leads error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
