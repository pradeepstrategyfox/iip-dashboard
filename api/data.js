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
// CRITICAL: We use `tq=SELECT *` to bypass any active Google Sheets filters.
// Without this, if someone has a filter active on the sheet, the CSV export
// returns only the visible (filtered) rows, causing incorrect counts.
function csvUrl(id, sheetName) {
  let url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv`;
  url += '&tq=' + encodeURIComponent('SELECT *');
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

// Strict boolean: ONLY actual checkbox TRUE counts.
// Rejects "CREATED", empty, numbers, or any other non-TRUE value.
function normBool(val) {
  if (!val) return false;
  const v = String(val).trim().toUpperCase();
  return v === 'TRUE';
}

function normDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ─── Campaign Classification ────────────────────────────────────────────────
// "IIP - New Leads - Direct" contains TWO campaigns:
//   - "SF - CPE Hindi Leads - ..."  → Hindi Video (Director speaking Hindi)
//   - "SF - CPE Video Leads - ..."  → English Video (Director speaking English)
// "IIP - Old Leads - Direct" contains ONE campaign:
//   - "SF - Instant Forms - ..."    → Apple Carousel (English carousel ad)
function classifyCampaign(campaignName, source) {
  const cn = (campaignName || '').toLowerCase();
  if (source === 'old') return 'Apple Carousel';
  if (cn.includes('hindi')) return 'Hindi Video';
  if (cn.includes('video') || cn.includes('cpe')) return 'English Video';
  return 'English Video'; // default for new leads
}

// ─── Process raw Meta leads ─────────────────────────────────────────────────
function processMetaLeads(rows, source) {
  return rows
    .filter((r) => r.full_name || r.phone_number)
    .map((r) => {
      const rawCampaign = (r.campaign_name || '').trim();
      return {
        campaign: classifyCampaign(rawCampaign, source),
        campaignRaw: rawCampaign,
        date: normDate(r.created_time),
        datetime: r.created_time || null,
        name: (r.full_name || '').trim(),
        phone: (r.phone_number || '').trim(),
        email: (r.email || '').trim(),
        platform: (r.platform || '').trim().toLowerCase(),
        industry: (r['which_industry_to_you_currently_work_in?'] || '').trim().toLowerCase(),
        interest: (r['why_are_you_interested_in_this_program?'] || '').trim().toLowerCase().replace(/_/g, ' '),
        campaignName: rawCampaign,
        adsetName: (r.adset_name || '').trim(),
        formName: (r.form_name || '').trim(),
        leadStatus: (r.lead_status || '').trim(),
      };
    });
}

// ─── Cross-verification helper ──────────────────────────────────────────────
// A call is "verified" if CALLED=TRUE AND there is content in OTHER DETAILS
// (meaning the support agent actually wrote notes about the call).
function hasContent(val) {
  return val && String(val).trim().length > 0;
}

// ─── Process IIP Leads Sheet1 (Apple Carousel support data) ─────────────────
function processSheet1(rows) {
  return rows
    .filter((r) => r.NAME)
    .map((r) => {
      const called = normBool(r.CALLED);
      const responded = normBool(r.RESPONDED);
      const otherDetails = (r['OTHER DETAILS'] || '').trim();
      const followUp = (r['FOLLOW UP UPDATES'] || '').trim();
      return {
        campaign: 'Apple Carousel',
        name: (r.NAME || '').trim(),
        phone: (r['PHONE NUMBER'] || '').trim(),
        industry: (r['CURRENT INDUSTRY'] || '').trim().toLowerCase(),
        interest: (r['WHY INTERESTED'] || '').trim().toLowerCase().replace(/_/g, ' '),
        called,
        responded,
        // Verified = checkbox TRUE + agent actually left notes
        calledVerified: called && (hasContent(otherDetails) || hasContent(followUp)),
        respondedVerified: responded && (hasContent(otherDetails) || hasContent(followUp)),
        status: (r.STATUS || '').trim(),
        statusAlt: (r.Status || '').trim(),
        otherDetails,
        followUp,
        iipFollowup: (r['IIP FOLLOWUP'] || r['IIP FOLLOWUP '] || '').trim(),
        team: (r['IIP Team'] || '').trim(),
        // Raw checkbox value for debugging
        _rawCalled: r.CALLED,
        _rawResponded: r.RESPONDED,
      };
    });
}

// ─── Process IIP Leads Hindi Leads (Video campaigns support data) ───────────
// This sheet contains support tracking for BOTH Hindi Video and English Video leads
function processHindiLeads(rows) {
  return rows
    .filter((r) => r.NAME)
    .map((r) => {
      const industry = r[''] || r[' '] || r['  '] || Object.values(r)[4] || '';
      const rawCampaign = (r.campaign_name || '').trim();
      const called = normBool(r.CALLED);
      const responded = normBool(r.RESPONDED);
      const otherDetails = (r['OTHER DETAILS'] || '').trim();
      const followUp = (r['FOLLOW UP'] || '').trim();
      return {
        campaign: classifyCampaign(rawCampaign, 'new'),
        campaignRaw: rawCampaign,
        date: normDate(r.created_time),
        name: (r.NAME || '').trim(),
        phone: (r['PHONE NUMBER'] || '').trim(),
        email: (r.EMAIL || '').trim(),
        platform: (r.platform || '').trim().toLowerCase(),
        campaignName: rawCampaign,
        adsetName: (r.adset_name || '').trim(),
        industry: String(industry).trim().toLowerCase(),
        interest: (r['WHY INTERESTED'] || '').trim().toLowerCase().replace(/_/g, ' '),
        called,
        responded,
        calledVerified: called && (hasContent(otherDetails) || hasContent(followUp)),
        respondedVerified: responded && (hasContent(otherDetails) || hasContent(followUp)),
        status: (r.STATUS || '').trim(),
        otherDetails,
        followUp,
        iipFollowup: (r['IIP FOLLOWUP'] || '').trim(),
        _rawCalled: r.CALLED,
        _rawResponded: r.RESPONDED,
      };
    });
}

// ─── Campaign keys ──────────────────────────────────────────────────────────
const CAMPAIGNS = ['Hindi Video', 'English Video', 'Apple Carousel'];

function countByCampaign(leads) {
  const out = {};
  CAMPAIGNS.forEach((c) => { out[c] = 0; });
  for (const l of leads) out[l.campaign] = (out[l.campaign] || 0) + 1;
  return out;
}

// ─── Aggregate ──────────────────────────────────────────────────────────────
function aggregate(metaNew, metaOld, sheet1, hindiLeads) {
  const allMetaLeads = [...metaNew, ...metaOld];
  const allSupportLeads = [...sheet1, ...hindiLeads];

  // Per-campaign counts from Meta
  const campCounts = countByCampaign(allMetaLeads);

  const totalMetaLeads = allMetaLeads.length;

  // Strict counts: only TRUE checkboxes
  const totalCallsMade = allSupportLeads.filter((l) => l.called).length;
  const totalResponded = allSupportLeads.filter((l) => l.responded).length;

  // Verified counts: TRUE checkbox + notes in OTHER DETAILS or FOLLOW UP
  const totalCallsVerified = allSupportLeads.filter((l) => l.calledVerified).length;
  const totalRespondedVerified = allSupportLeads.filter((l) => l.respondedVerified).length;

  // Leads not yet processed (no checkbox value at all)
  const notYetProcessed = allSupportLeads.filter(
    (l) => !l.called && !hasContent(l.otherDetails)
  ).length;

  const totalSupportLeads = allSupportLeads.length;
  const callRate = totalSupportLeads > 0 ? ((totalCallsMade / totalSupportLeads) * 100).toFixed(1) : '0';
  const responseRate = totalCallsMade > 0 ? ((totalResponded / totalCallsMade) * 100).toFixed(1) : '0';

  // Data quality: flag mismatches
  const calledButNoNotes = allSupportLeads.filter(
    (l) => l.called && !hasContent(l.otherDetails) && !hasContent(l.followUp)
  ).length;
  const notCalledButHasNotes = allSupportLeads.filter(
    (l) => !l.called && (hasContent(l.otherDetails) || hasContent(l.followUp))
  ).length;

  // Daily Leads (3 campaigns)
  const dailyMap = {};
  for (const lead of allMetaLeads) {
    if (!lead.date) continue;
    if (!dailyMap[lead.date]) dailyMap[lead.date] = { hindiVideo: 0, englishVideo: 0, appleCarousel: 0 };
    if (lead.campaign === 'Hindi Video') dailyMap[lead.date].hindiVideo++;
    else if (lead.campaign === 'English Video') dailyMap[lead.date].englishVideo++;
    else dailyMap[lead.date].appleCarousel++;
  }
  const dailyLeads = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, c]) => ({ date, ...c, total: c.hindiVideo + c.englishVideo + c.appleCarousel }));

  // Weekly Leads (3 campaigns)
  const weeklyMap = {};
  for (const lead of allMetaLeads) {
    if (!lead.date) continue;
    const d = new Date(lead.date);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const weekKey = weekStart.toISOString().slice(0, 10);
    if (!weeklyMap[weekKey]) weeklyMap[weekKey] = { hindiVideo: 0, englishVideo: 0, appleCarousel: 0 };
    if (lead.campaign === 'Hindi Video') weeklyMap[weekKey].hindiVideo++;
    else if (lead.campaign === 'English Video') weeklyMap[weekKey].englishVideo++;
    else weeklyMap[weekKey].appleCarousel++;
  }
  const weeklyLeads = Object.entries(weeklyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, c]) => ({ week, ...c, total: c.hindiVideo + c.englishVideo + c.appleCarousel }));

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

  // Call Performance by Campaign (3 campaigns from support data)
  const callPerf = {};
  for (const c of CAMPAIGNS) {
    const subset = allSupportLeads.filter((l) => l.campaign === c);
    callPerf[c] = {
      total: subset.length,
      called: subset.filter((l) => l.called).length,
      calledVerified: subset.filter((l) => l.calledVerified).length,
      responded: subset.filter((l) => l.responded).length,
      respondedVerified: subset.filter((l) => l.respondedVerified).length,
    };
  }

  // Team Performance
  const teamMap = {};
  for (const lead of sheet1) {
    const t = lead.team || 'Unassigned';
    if (!teamMap[t]) teamMap[t] = { total: 0, called: 0, responded: 0 };
    teamMap[t].total++;
    if (lead.called) teamMap[t].called++;
    if (lead.responded) teamMap[t].responded++;
  }

  // Status by Campaign (3 campaigns)
  const statusByCampaign = {};
  for (const c of CAMPAIGNS) statusByCampaign[c] = {};
  for (const lead of allSupportLeads) {
    const s = lead.status || lead.statusAlt || 'Not Updated';
    const c = lead.campaign;
    if (statusByCampaign[c]) statusByCampaign[c][s] = (statusByCampaign[c][s] || 0) + 1;
  }

  // Recent Leads
  const recentLeads = allMetaLeads
    .filter((l) => l.date)
    .sort((a, b) => (b.datetime || b.date || '').localeCompare(a.datetime || a.date || ''))
    .slice(0, 30)
    .map((l) => ({ date: l.date, name: l.name, campaign: l.campaign, platform: l.platform, industry: l.industry, interest: l.interest }));

  return {
    kpis: {
      totalMetaLeads,
      hindiVideoLeads: campCounts['Hindi Video'] || 0,
      englishVideoLeads: campCounts['English Video'] || 0,
      appleCarouselLeads: campCounts['Apple Carousel'] || 0,
      totalSupportLeads, totalCallsMade, totalResponded,
      totalCallsVerified, totalRespondedVerified,
      callRate: parseFloat(callRate), responseRate: parseFloat(responseRate),
      notCalled: totalSupportLeads - totalCallsMade,
      notResponded: totalCallsMade - totalResponded,
      notYetProcessed,
    },
    dataQuality: {
      calledButNoNotes,
      notCalledButHasNotes,
      totalRows: { sheet1: sheet1.length, hindiLeads: hindiLeads.length },
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

  const metaNew = processMetaLeads(newDirectRaw, 'new');
  const metaOld = processMetaLeads(oldDirectRaw, 'old');
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
