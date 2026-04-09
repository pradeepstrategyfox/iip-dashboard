// ─── IIP Dashboard - Frontend Application ──────────────────────────────────
// Fetches data from the Express API, computes visualizations, and renders
// an agency-grade performance dashboard for the IIP client.
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour
let chartInstances = {};
let currentData = null;
let dailyViewMode = 'daily';

// ─── Color Palette ──────────────────────────────────────────────────────────
const COLORS = {
  primary: '#4F46E5',
  primaryLight: '#818CF8',
  newCampaign: '#7C3AED',
  newLight: '#A78BFA',
  oldCampaign: '#0891B2',
  oldLight: '#22D3EE',
  success: '#059669',
  warning: '#D97706',
  danger: '#DC2626',
  pink: '#EC4899',
  palette: [
    '#4F46E5', '#7C3AED', '#0891B2', '#059669', '#D97706',
    '#DC2626', '#EC4899', '#8B5CF6', '#06B6D4', '#10B981',
    '#F59E0B', '#EF4444', '#14B8A6', '#F97316', '#6366F1',
  ],
  paletteAlpha: (alpha) => [
    `rgba(79,70,229,${alpha})`, `rgba(124,58,237,${alpha})`,
    `rgba(8,145,178,${alpha})`, `rgba(5,150,105,${alpha})`,
    `rgba(217,119,6,${alpha})`, `rgba(220,38,38,${alpha})`,
    `rgba(236,72,153,${alpha})`, `rgba(139,92,246,${alpha})`,
    `rgba(6,182,212,${alpha})`, `rgba(16,185,129,${alpha})`,
  ],
};

// ─── Chart.js Global Defaults ───────────────────────────────────────────────
Chart.defaults.font.family = "'Inter', -apple-system, sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.color = '#64748B';
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.padding = 16;
Chart.defaults.plugins.legend.labels.font = { size: 11, weight: '600' };
Chart.defaults.plugins.tooltip.backgroundColor = '#1E293B';
Chart.defaults.plugins.tooltip.titleFont = { size: 12, weight: '700' };
Chart.defaults.plugins.tooltip.bodyFont = { size: 11 };
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;
Chart.defaults.plugins.tooltip.displayColors = true;
Chart.defaults.elements.bar.borderRadius = 6;
Chart.defaults.elements.line.tension = 0.35;

// ─── Data Fetching ──────────────────────────────────────────────────────────
async function fetchData(forceRefresh = false) {
  const url = forceRefresh ? '/api/data?refresh=true' : '/api/data';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Unknown error');
  return json;
}

async function loadDashboard() {
  try {
    const data = await fetchData();
    currentData = data;
    renderAll(data);
    hideLoading();
  } catch (err) {
    console.error('Dashboard load error:', err);
    showError(err.message);
    hideLoading();
  }
}

async function refreshData() {
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const data = await fetchData(true);
    currentData = data;
    renderAll(data);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

// ─── UI Helpers ─────────────────────────────────────────────────────────────
function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.add('fade-out');
  setTimeout(() => overlay.remove(), 500);
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-text').textContent = `Error: ${msg}`;
  banner.classList.remove('hidden');
}

function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-IN');
}

function capitalize(s) {
  if (!s) return '';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function destroyChart(id) {
  if (chartInstances[id]) {
    chartInstances[id].destroy();
    delete chartInstances[id];
  }
}

// ─── Main Render ────────────────────────────────────────────────────────────
function renderAll(data) {
  const { aggregated, raw, fetchedAt } = data;

  // Update timestamp
  const dt = new Date(fetchedAt);
  document.getElementById('last-updated').textContent =
    `Updated ${dt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`;

  // KPIs
  renderKPIs(aggregated.kpis);

  // Funnel
  renderFunnel(aggregated.kpis);

  // Charts
  renderDailyLeadsChart(aggregated);
  renderCampaignSplit(aggregated.kpis);
  renderCallPerformance(aggregated.callPerformance);
  renderStatusDistribution(aggregated.statusDistribution);
  renderPlatformDistribution(aggregated.platformDistribution);
  renderIndustryChart(aggregated.industryDistribution);
  renderInterestChart(aggregated.interestDistribution);
  renderTeamChart(aggregated.teamPerformance);
  renderStatusByCampaign(aggregated.statusByCampaign);

  // Table
  renderRecentLeads(aggregated.recentLeads);

  // Source counts
  document.getElementById('src-new-direct').textContent = `${formatNumber(raw.newDirectCount)} rows`;
  document.getElementById('src-old-direct').textContent = `${formatNumber(raw.oldDirectCount)} rows`;
  document.getElementById('src-sheet1').textContent = `${formatNumber(raw.sheet1Count)} rows`;
  document.getElementById('src-hindi').textContent = `${formatNumber(raw.hindiLeadsCount)} rows`;
}

// ─── KPI Cards ──────────────────────────────────────────────────────────────
function renderKPIs(kpis) {
  animateValue('kpi-total-leads', kpis.totalMetaLeads);
  animateValue('kpi-new-leads', kpis.newCampaignLeads);
  animateValue('kpi-old-leads', kpis.oldCampaignLeads);
  animateValue('kpi-calls-made', kpis.totalCallsMade);
  animateValue('kpi-responded', kpis.totalResponded);
  document.getElementById('kpi-response-rate').textContent = `${kpis.responseRate}%`;
}

function animateValue(elementId, target) {
  const el = document.getElementById(elementId);
  const duration = 800;
  const start = parseInt(el.textContent) || 0;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    const current = Math.round(start + (target - start) * eased);
    el.textContent = formatNumber(current);
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ─── Funnel ─────────────────────────────────────────────────────────────────
function renderFunnel(kpis) {
  const container = document.getElementById('funnel-container');
  const steps = [
    { label: 'Total Leads', value: kpis.totalMetaLeads, color: COLORS.primary },
    { label: 'Transferred to Support', value: kpis.totalSupportLeads, color: COLORS.newCampaign },
    { label: 'Calls Made', value: kpis.totalCallsMade, color: COLORS.warning },
    { label: 'Responded', value: kpis.totalResponded, color: COLORS.success },
  ];

  let html = '';
  steps.forEach((step, i) => {
    const rate = i > 0 && steps[i - 1].value > 0
      ? ((step.value / steps[i - 1].value) * 100).toFixed(0) + '%'
      : '';

    if (i > 0) {
      html += `<div class="funnel-arrow">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
      </div>`;
    }

    html += `<div class="funnel-step">
      <div class="funnel-bar" style="background: ${step.color}">
        ${formatNumber(step.value)}
      </div>
      <div class="funnel-label">${step.label}</div>
      ${rate ? `<div class="funnel-rate">${rate} conversion</div>` : '<div class="funnel-rate">&nbsp;</div>'}
    </div>`;
  });

  container.innerHTML = html;
}

// ─── Daily Leads Chart ──────────────────────────────────────────────────────
function toggleDailyView(mode) {
  dailyViewMode = mode;
  document.querySelectorAll('.toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });
  if (currentData) renderDailyLeadsChart(currentData.aggregated);
}

function renderDailyLeadsChart(aggregated) {
  destroyChart('dailyLeads');

  const isDaily = dailyViewMode === 'daily';
  const source = isDaily ? aggregated.dailyLeads : aggregated.weeklyLeads;
  const labels = source.map((d) => {
    const dateStr = isDaily ? d.date : d.week;
    const dt = new Date(dateStr + 'T00:00:00');
    return isDaily
      ? dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      : `Week of ${dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  });

  const ctx = document.getElementById('chart-daily-leads').getContext('2d');
  chartInstances['dailyLeads'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'New Campaign (Hindi)',
          data: source.map((d) => d.new),
          backgroundColor: `rgba(124,58,237,0.8)`,
          borderColor: COLORS.newCampaign,
          borderWidth: 1,
          borderRadius: 4,
          stack: 'stack',
        },
        {
          label: 'Old Campaign (English)',
          data: source.map((d) => d.old),
          backgroundColor: `rgba(8,145,178,0.8)`,
          borderColor: COLORS.oldCampaign,
          borderWidth: 1,
          borderRadius: 4,
          stack: 'stack',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 45, font: { size: 10 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { stepSize: 1, precision: 0 },
          title: { display: true, text: 'Leads', font: { size: 11, weight: '600' } },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            footer: (items) => {
              const total = items.reduce((s, i) => s + i.raw, 0);
              return `Total: ${total}`;
            },
          },
        },
      },
    },
  });
}

// ─── Campaign Split Doughnut ────────────────────────────────────────────────
function renderCampaignSplit(kpis) {
  destroyChart('campaignSplit');
  const ctx = document.getElementById('chart-campaign-split').getContext('2d');

  chartInstances['campaignSplit'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['New Campaign (Hindi)', 'Old Campaign (English)'],
      datasets: [{
        data: [kpis.newCampaignLeads, kpis.oldCampaignLeads],
        backgroundColor: [COLORS.newCampaign, COLORS.oldCampaign],
        borderWidth: 0,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((ctx.raw / total) * 100).toFixed(1);
              return ` ${ctx.label}: ${formatNumber(ctx.raw)} (${pct}%)`;
            },
          },
        },
      },
    },
    plugins: [{
      id: 'centerText',
      beforeDraw(chart) {
        const { ctx, width, height } = chart;
        const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
        ctx.save();
        ctx.font = "800 28px 'Inter'";
        ctx.fillStyle = '#0F172A';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatNumber(total), width / 2, height / 2 - 8);
        ctx.font = "500 11px 'Inter'";
        ctx.fillStyle = '#94A3B8';
        ctx.fillText('Total Leads', width / 2, height / 2 + 14);
        ctx.restore();
      },
    }],
  });
}

// ─── Call Performance ───────────────────────────────────────────────────────
function renderCallPerformance(callPerf) {
  destroyChart('callPerf');
  const ctx = document.getElementById('chart-call-perf').getContext('2d');

  chartInstances['callPerf'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['New Campaign', 'Old Campaign'],
      datasets: [
        {
          label: 'Total Leads',
          data: [callPerf.new.total, callPerf.old.total],
          backgroundColor: 'rgba(148,163,184,0.3)',
          borderColor: '#94A3B8',
          borderWidth: 1,
        },
        {
          label: 'Calls Made',
          data: [callPerf.new.called, callPerf.old.called],
          backgroundColor: 'rgba(217,119,6,0.7)',
          borderColor: COLORS.warning,
          borderWidth: 1,
        },
        {
          label: 'Responded',
          data: [callPerf.new.responded, callPerf.old.responded],
          backgroundColor: 'rgba(5,150,105,0.7)',
          borderColor: COLORS.success,
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { precision: 0 },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const idx = items[0].dataIndex;
              const camp = idx === 0 ? callPerf.new : callPerf.old;
              const callRate = camp.total > 0 ? ((camp.called / camp.total) * 100).toFixed(0) : 0;
              const respRate = camp.called > 0 ? ((camp.responded / camp.called) * 100).toFixed(0) : 0;
              return `Call Rate: ${callRate}%\nResponse Rate: ${respRate}%`;
            },
          },
        },
      },
    },
  });
}

// ─── Status Distribution ────────────────────────────────────────────────────
function renderStatusDistribution(statusDist) {
  destroyChart('status');
  const entries = Object.entries(statusDist)
    .filter(([k]) => k && k !== 'Not Updated')
    .sort((a, b) => b[1] - a[1]);

  const notUpdated = statusDist['Not Updated'] || 0;
  if (notUpdated > 0) entries.push(['Not Updated', notUpdated]);

  const ctx = document.getElementById('chart-status').getContext('2d');
  chartInstances['status'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([k]) => k),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: COLORS.palette.slice(0, entries.length),
        borderWidth: 0,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '55%',
      plugins: {
        legend: {
          position: 'right',
          labels: { font: { size: 10 }, boxWidth: 12, padding: 8 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((ctx.raw / total) * 100).toFixed(1);
              return ` ${ctx.label}: ${ctx.raw} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

// ─── Platform Distribution ──────────────────────────────────────────────────
function renderPlatformDistribution(platformDist) {
  destroyChart('platform');
  const platformLabels = { fb: 'Facebook', ig: 'Instagram', unknown: 'Unknown' };
  const platformColors = { fb: '#1877F2', ig: '#E4405F', unknown: '#94A3B8' };
  const entries = Object.entries(platformDist).sort((a, b) => b[1] - a[1]);

  const ctx = document.getElementById('chart-platform').getContext('2d');
  chartInstances['platform'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([k]) => platformLabels[k] || capitalize(k)),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map(([k]) => platformColors[k] || '#94A3B8'),
        borderWidth: 0,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((ctx.raw / total) * 100).toFixed(1);
              return ` ${ctx.label}: ${formatNumber(ctx.raw)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

// ─── Industry Chart ─────────────────────────────────────────────────────────
function renderIndustryChart(industryDist) {
  destroyChart('industry');
  const entries = Object.entries(industryDist)
    .filter(([k]) => k && k !== 'unknown')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  const ctx = document.getElementById('chart-industry').getContext('2d');
  chartInstances['industry'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map(([k]) => capitalize(k)),
      datasets: [{
        label: 'Leads',
        data: entries.map(([, v]) => v),
        backgroundColor: COLORS.paletteAlpha(0.7),
        borderColor: COLORS.palette,
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { precision: 0 },
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 11 } },
        },
      },
      plugins: { legend: { display: false } },
    },
  });
}

// ─── Interest Chart ─────────────────────────────────────────────────────────
function renderInterestChart(interestDist) {
  destroyChart('interest');
  const entries = Object.entries(interestDist)
    .filter(([k]) => k && k !== 'unknown')
    .sort((a, b) => b[1] - a[1]);

  const ctx = document.getElementById('chart-interest').getContext('2d');
  chartInstances['interest'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map(([k]) => capitalize(k)),
      datasets: [{
        label: 'Leads',
        data: entries.map(([, v]) => v),
        backgroundColor: COLORS.paletteAlpha(0.7),
        borderColor: COLORS.palette,
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { precision: 0 },
        },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

// ─── Team Performance ───────────────────────────────────────────────────────
function renderTeamChart(teamPerf) {
  destroyChart('team');
  const entries = Object.entries(teamPerf)
    .filter(([k]) => k !== 'Unassigned')
    .sort((a, b) => b[1].total - a[1].total);

  if (entries.length === 0) {
    const container = document.getElementById('chart-team').parentElement;
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94A3B8;font-size:0.9rem;">No team data available</div>';
    return;
  }

  const ctx = document.getElementById('chart-team').getContext('2d');
  chartInstances['team'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map(([k]) => k),
      datasets: [
        {
          label: 'Assigned',
          data: entries.map(([, v]) => v.total),
          backgroundColor: 'rgba(148,163,184,0.3)',
          borderColor: '#94A3B8',
          borderWidth: 1,
        },
        {
          label: 'Called',
          data: entries.map(([, v]) => v.called),
          backgroundColor: 'rgba(217,119,6,0.7)',
          borderColor: COLORS.warning,
          borderWidth: 1,
        },
        {
          label: 'Responded',
          data: entries.map(([, v]) => v.responded),
          backgroundColor: 'rgba(5,150,105,0.7)',
          borderColor: COLORS.success,
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { precision: 0 },
        },
      },
    },
  });
}

// ─── Status by Campaign ─────────────────────────────────────────────────────
function renderStatusByCampaign(statusByCampaign) {
  destroyChart('statusCampaign');

  const allStatuses = new Set();
  Object.values(statusByCampaign).forEach((map) => {
    Object.keys(map).forEach((s) => { if (s) allStatuses.add(s); });
  });
  const statuses = [...allStatuses].filter((s) => s !== 'Not Updated').sort();
  if (statusByCampaign.old['Not Updated'] || statusByCampaign.new['Not Updated']) {
    statuses.push('Not Updated');
  }

  const datasets = [
    {
      label: 'Old Campaign',
      data: statuses.map((s) => statusByCampaign.old[s] || 0),
      backgroundColor: 'rgba(8,145,178,0.7)',
      borderColor: COLORS.oldCampaign,
      borderWidth: 1,
    },
    {
      label: 'New Campaign',
      data: statuses.map((s) => statusByCampaign.new[s] || 0),
      backgroundColor: 'rgba(124,58,237,0.7)',
      borderColor: COLORS.newCampaign,
      borderWidth: 1,
    },
  ];

  const ctx = document.getElementById('chart-status-campaign').getContext('2d');
  chartInstances['statusCampaign'] = new Chart(ctx, {
    type: 'bar',
    data: { labels: statuses, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { precision: 0 },
        },
      },
    },
  });
}

// ─── Recent Leads Table ─────────────────────────────────────────────────────
function renderRecentLeads(leads) {
  const tbody = document.getElementById('leads-tbody');
  document.getElementById('table-count').textContent = `${leads.length} recent leads`;

  tbody.innerHTML = leads
    .map((lead) => {
      const dt = lead.date ? new Date(lead.date + 'T00:00:00') : null;
      const dateStr = dt
        ? dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';
      const platformClass = lead.platform === 'fb' ? 'platform-fb' : 'platform-ig';
      const platformLabel = lead.platform === 'fb' ? 'FB' : lead.platform === 'ig' ? 'IG' : lead.platform;
      const campaignClass = lead.campaign === 'New Campaign' ? 'campaign-new' : 'campaign-old';
      const campaignLabel = lead.campaign === 'New Campaign' ? 'New' : 'Old';

      return `<tr>
        <td>${dateStr}</td>
        <td><strong>${lead.name || '—'}</strong></td>
        <td><span class="campaign-badge ${campaignClass}">${campaignLabel}</span></td>
        <td><span class="platform-badge ${platformClass}">${platformLabel}</span></td>
        <td>${capitalize(lead.industry) || '—'}</td>
        <td>${capitalize(lead.interest) || '—'}</td>
      </tr>`;
    })
    .join('');
}

// ─── Auto Refresh ───────────────────────────────────────────────────────────
setInterval(() => {
  console.log('Auto-refreshing dashboard data...');
  refreshData();
}, REFRESH_INTERVAL);

// ─── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadDashboard);
