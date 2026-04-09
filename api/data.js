const Papa = require('papaparse');

// ─── Sheet Configuration ───────────────────────────────────────────────────────
const SHEET_IDS = {
  IIP_LEADS: '14YB5KhwvAVnyw6zDdxa0AZhscIIDq4l7OUyzi3vfODk',
  NEW_LEADS_DIRECT: '1PA2orWXY7tEwP3fPtyrBQaTT7Nr5gleaeqzXegXR31I',
  OLD_LEADS_DIRECT: '1wW7AapS4ulJzUYRNiX7XTdOVknW_djZuyWRf3YdyNhs',
};

// ─── In-memory cache (persists across warm invocations) ─────────────────────
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ─── Helpers ────────────────────────────────────────────────────────────────────
function csvUrl(id, sheetName) {
  let url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv`;
  if (sheetName) url += `&sheet=${encodeURIComponent(sheetName)}`;
  return url;
}

async function fetchCSV(id, sheetName) {
  const url = csvUrl(id, sheetName);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'IIP-Dashboard/1.0' },
  });
  if (!res.ok) throw new Error(`Sheet fetch failed (${res.status}): ${sheetName || 'default'}`);
  const text = await res.text();
  const { data } = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return data;
}

function normBool(val) {
  if (!val) return false;
  const v = String(val).trim().toUpperCase();
  return v === 'TRUE' || v === 'YES' || v === '1';
}

function normDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ─── Process raw Meta leads ─────────────────────────────────────────────────
function processMetaLeads(rows, campaign) {
  return rows
    .filter((r) => r.full_name || r.phone_number)
    .map((r) => ({
      campaign,
      date: normDate(r.created_time),
      datetime: r.created_time || null,
      name: (r.full_name || '').trim(),
      phone: (r.phone_number || '').trim(),
      email: (r.email || '').trim(),
      platform: (r.platform || '').trim().toLowerCase(),
      industry: (r['which_industry_to_you_currently_work_in?'] || '').trim().toLowerCase(),
      interest: (r['why_are_you_interested_in_this_program?'] || '').trim().toLowerCase().replace(/_/g, ' '),
      campaignName: (r.campaign_name || '').trim(),
      adsetName: (r.adset_name || '').trim(),
      formName: (r.form_name || '').trim(),
      leadStatus: (r.lead_status || '').trim(),
    }));
}

// ─── Process IIP Leads Sheet1 (Old campaign) ────────────────────────────────
function processSheet1(rows) {
  return rows
    .filter((r) => r.NAME)
    .map((r) => ({
      campaign: 'Old Campaign',
      name: (r.NAME || '').trim(),
      phone: (r['PHONE NUMBER'] || '').trim(),
      industry: (r['CURRENT INDUSTRY'] || '').trim().toLowerCase(),
      interest: (r['WHY INTERESTED'] || '').trim().toLowerCase().replace(/_/g, ' '),
      called: normBool(r.CALLED),
      responded: normBool(r.RESPONDED),
      status: (r.STATUS || '').trim(),
      statusAlt: (r.Status || '').trim(),
      iipFollowup: (r['IIP FOLLOWUP'] || r['IIP FOLLOWUP '] || '').trim(),
      team: (r['IIP Team'] || '').trim(),
    }));
}

// ─── Process IIP Leads Hindi Leads (New campaign) ───────────────────────────
function processHindiLeads(rows) {
  return rows
    .filter((r) => r.NAME)
    .map((r) => {
      const industry = r[''] || r[' '] || r['  '] || Object.values(r)[4] || '';
      return {
        campaign: 'New Campaign',
        date: normDate(r.created_time),
        name: (r.NAME || '').trim(),
        phone: (r['PHONE NUMBER'] || '').trim(),
        email: (r.EMAIL || '').trim(),
        platform: (r.platform || '').trim().toLowerCase(),
        campaignName: (r.campaign_name || '').trim(),
        adsetName: (r.adset_name || '').trim(),
        industry: String(industry).trim().toLowerCase(),
        interest: (r['WHY INTERESTED'] || '').trim().toLowerCase().replace(/_/g, ' '),
        called: normBool(r.CALLED),
        responded: normBool(r.RESPONDED),
        status: (r.STATUS || '').trim(),
        iipFollowup: (r['IIP FOLLOWUP'] || '').trim(),
      };
    });
}

// ─── Aggregate ──────────────────────────────────────────────────────────────
function aggregate(metaNew, metaOld, sheet1, hindiLeads) {
  const allMetaLeads = [...metaNew, ...metaOld];
  const allSupportLeads = [...sheet1, ...hindiLeads];

  const totalMetaLeads = allMetaLeads.length;
  const newCampaignLeads = metaNew.length;
  const oldCampaignLeads = metaOld.length;
  const totalCallsMade = allSupportLeads.filter((l) => l.called).length;
  const totalResponded = allSupportLeads.filter((l) => l.responded).length;
  const totalSupportLeads = allSupportLeads.length;
  const callRate = totalSupportLeads > 0 ? ((totalCallsMade / totalSupportLeads) * 100).toFixed(1) : '0';
  const responseRate = totalCallsMade > 0 ? ((totalResponded / totalCallsMade) * 100).toFixed(1) : '0';

  // Daily Leads
  const dailyMap = {};
  for (const lead of allMetaLeads) {
    if (!lead.date) continue;
    if (!dailyMap[lead.date]) dailyMap[lead.date] = { new: 0, old: 0 };
    if (lead.campaign === 'New Campaign') dailyMap[lead.date].new++;
    else dailyMap[lead.date].old++;
  }
  const dailyLeads = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts, total: counts.new + counts.old }));

  // Weekly Leads
  const weeklyMap = {};
  for (const lead of allMetaLeads) {
    if (!lead.date) continue;
    const d = new Date(lead.date);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const weekKey = weekStart.toISOString().slice(0, 10);
    if (!weeklyMap[weekKey]) weeklyMap[weekKey] = { new: 0, old: 0 };
    if (lead.campaign === 'New Campaign') weeklyMap[weekKey].new++;
    else weeklyMap[weekKey].old++;
  }
  const weeklyLeads = Object.entries(weeklyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, counts]) => ({ week, ...counts, total: counts.new + counts.old }));

  // Distributions
  const platformMap = {}, industryMap = {}, interestMap = {}, statusMap = {};
  for (const lead of allMetaLeads) {
    const p = lead.platform || 'unknown';
    platformMap[p] = (platformMap[p] || 0) + 1;
    const ind = lead.industry || 'unknown';
    industryMap[ind] = (industryMap[ind] || 0) + 1;
    const i = lead.interest || 'unknown';
    interestMap[i] = (interestMap[i] || 0) + 1;
  }
  for (const lead of allSupportLeads) {
    const s = lead.status || lead.statusAlt || 'Not Updated';
    if (s) statusMap[s] = (statusMap[s] || 0) + 1;
  }

  // Call Performance by Campaign
  const callPerf = {
    old: { total: sheet1.length, called: sheet1.filter((l) => l.called).length, responded: sheet1.filter((l) => l.responded).length },
    new: { total: hindiLeads.length, called: hindiLeads.filter((l) => l.called).length, responded: hindiLeads.filter((l) => l.responded).length },
  };

  // Team Performance
  const teamMap = {};
  for (const lead of sheet1) {
    const t = lead.team || 'Unassigned';
    if (!teamMap[t]) teamMap[t] = { total: 0, called: 0, responded: 0 };
    teamMap[t].total++;
    if (lead.called) teamMap[t].called++;
    if (lead.responded) teamMap[t].responded++;
  }

  // Status by Campaign
  const statusByCampaign = { old: {}, new: {} };
  for (const lead of sheet1) {
    const s = lead.status || lead.statusAlt || 'Not Updated';
    statusByCampaign.old[s] = (statusByCampaign.old[s] || 0) + 1;
  }
  for (const lead of hindiLeads) {
    const s = lead.status || 'Not Updated';
    statusByCampaign.new[s] = (statusByCampaign.new[s] || 0) + 1;
  }

  // Recent Leads
  const recentLeads = allMetaLeads
    .filter((l) => l.date)
    .sort((a, b) => (b.datetime || b.date || '').localeCompare(a.datetime || a.date || ''))
    .slice(0, 30)
    .map((l) => ({ date: l.date, name: l.name, campaign: l.campaign, platform: l.platform, industry: l.industry, interest: l.interest }));

  return {
    kpis: {
      totalMetaLeads, newCampaignLeads, oldCampaignLeads,
      totalSupportLeads, totalCallsMade, totalResponded,
      callRate: parseFloat(callRate), responseRate: parseFloat(responseRate),
      notCalled: totalSupportLeads - totalCallsMade,
      notResponded: totalCallsMade - totalResponded,
    },
    dailyLeads, weeklyLeads,
    platformDistribution: platformMap, industryDistribution: industryMap,
    interestDistribution: interestMap, statusDistribution: statusMap,
    statusByCampaign, callPerformance: callPerf,
    teamPerformance: teamMap, recentLeads,
  };
}

// ─── Main handler ───────────────────────────────────────────────────────────
async function fetchAllData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache.data && now - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  const [sheet1Raw, hindiRaw, newDirectRaw, oldDirectRaw] = await Promise.all([
    fetchCSV(SHEET_IDS.IIP_LEADS, 'Sheet1'),
    fetchCSV(SHEET_IDS.IIP_LEADS, 'Hindi Leads'),
    fetchCSV(SHEET_IDS.NEW_LEADS_DIRECT, null),
    fetchCSV(SHEET_IDS.OLD_LEADS_DIRECT, null),
  ]);

  const metaNew = processMetaLeads(newDirectRaw, 'New Campaign');
  const metaOld = processMetaLeads(oldDirectRaw, 'Old Campaign');
  const sheet1 = processSheet1(sheet1Raw);
  const hindiLeads = processHindiLeads(hindiRaw);
  const aggregated = aggregate(metaNew, metaOld, sheet1, hindiLeads);

  const data = {
    success: true,
    aggregated,
    raw: {
      sheet1Count: sheet1Raw.length,
      hindiLeadsCount: hindiRaw.length,
      newDirectCount: newDirectRaw.length,
      oldDirectCount: oldDirectRaw.length,
    },
    fetchedAt: new Date().toISOString(),
  };

  cache = { data, timestamp: now };
  return data;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');

  try {
    const forceRefresh = req.url?.includes('refresh=true') || req.query?.refresh === 'true';
    const data = await fetchAllData(forceRefresh);
    res.status(200).json(data);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
