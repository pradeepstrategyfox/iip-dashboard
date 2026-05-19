// ─── IIP Leads CRM ─────────────────────────────────────────────────────────
// Front-end for /leads. Fetches the flat lead list from /api/leads, renders
// a filterable / sortable table, and persists inline edits back to the
// Google Sheet via /api/update (which proxies to an Apps Script web app).
// ───────────────────────────────────────────────────────────────────────────

// ─── State ─────────────────────────────────────────────────────────────────
let allLeads = [];
let options = { statuses: [], teams: [], campaigns: [] };
let view = { leads: [], page: 1, pageSize: 50 };
let sort = { key: 'date', dir: 'desc' };
let filters = {
  search: '',
  campaign: new Set(),
  status: new Set(),
  team: new Set(),
  called: '',
  responded: '',
};
let openDrawerId = null;
let saveTimers = {}; // debounce timers per lead id + field

// ─── Helpers ───────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

function formatPhone(p) {
  if (!p) return '';
  return String(p).replace(/^p:/, '').trim();
}

const CAMPAIGN_STYLES = {
  'Hindi Video':     { cls: 'campaign-hindi',     lbl: 'Hindi Video'     },
  'English Video':   { cls: 'campaign-english',   lbl: 'English Video'   },
  'Apple Carousel':  { cls: 'campaign-carousel',  lbl: 'Apple Carousel'  },
  'Interview Video': { cls: 'campaign-interview', lbl: 'Interview Video' },
  'LinkedIn':        { cls: 'campaign-linkedin',  lbl: 'LinkedIn'        },
};

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(message, kind = 'info') {
  const c = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ─── Fetch ─────────────────────────────────────────────────────────────────
// First-load timeout: if Vercel cold-starts and Google Sheets is slow,
// the initial fetch can take 30+ seconds. Show a progress message after
// 6 seconds, and abort after 60 seconds with a retry button.
async function loadLeads(forceRefresh = false) {
  const url = forceRefresh ? '/api/leads?refresh=true' : '/api/leads';

  const ctrl = new AbortController();
  const slowTimer = setTimeout(() => showLoadingMessage(
    'Still loading… the first load fetches every sheet from Google and can take up to 30 seconds.'
  ), 6000);
  const verySlowTimer = setTimeout(() => showLoadingMessage(
    'Almost there… Google Sheets is slow to respond. Hang on.'
  ), 18000);
  const killTimer = setTimeout(() => ctrl.abort(), 60000);

  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out after 60s. Try refreshing.');
    throw e;
  } finally {
    clearTimeout(slowTimer);
    clearTimeout(verySlowTimer);
    clearTimeout(killTimer);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Load failed');
  allLeads = json.leads;
  options = json.options || { statuses: [], teams: [], campaigns: [] };
  document.getElementById('last-updated').textContent =
    `Updated ${new Date(json.fetchedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`;
  document.getElementById('footer-info').textContent = `${json.count} leads · refreshed ${new Date(json.fetchedAt).toLocaleTimeString('en-IN')}`;
}

function showLoadingMessage(msg) {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  const p = overlay.querySelector('p');
  if (p) p.textContent = msg;
}

async function reloadLeads() {
  const btn = $('#btn-refresh');
  btn.disabled = true; btn.classList.add('spinning');
  try {
    await loadLeads(true);
    populateFilters();
    render();
    toast('Leads refreshed', 'success');
  } catch (e) {
    toast('Refresh failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.classList.remove('spinning');
  }
}

// ─── Filter / sort / paginate ──────────────────────────────────────────────
function applyFilters() {
  const q = filters.search.trim().toLowerCase();
  view.leads = allLeads.filter((l) => {
    if (q) {
      const hay = `${l.name} ${formatPhone(l.phone)} ${l.email}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filters.campaign.size && !filters.campaign.has(l.campaign)) return false;
    if (filters.status.size && !filters.status.has(l.status)) return false;
    if (filters.team.size) {
      const t = l.team || 'Unassigned';
      if (!filters.team.has(t)) return false;
    }
    if (filters.called === 'true' && !l.called) return false;
    if (filters.called === 'false' && l.called) return false;
    if (filters.responded === 'true' && !l.responded) return false;
    if (filters.responded === 'false' && l.responded) return false;
    return true;
  });
  applySort();
}

function applySort() {
  const { key, dir } = sort;
  const mul = dir === 'asc' ? 1 : -1;
  view.leads.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'called' || key === 'responded') {
      va = va ? 1 : 0; vb = vb ? 1 : 0;
    } else {
      va = va == null ? '' : String(va).toLowerCase();
      vb = vb == null ? '' : String(vb).toLowerCase();
    }
    if (va < vb) return -1 * mul;
    if (va > vb) return  1 * mul;
    return 0;
  });
  view.page = 1;
}

// ─── Stats ─────────────────────────────────────────────────────────────────
function updateStats() {
  $('#stat-total').textContent = allLeads.length.toLocaleString('en-IN');
  $('#stat-shown').textContent = view.leads.length.toLocaleString('en-IN');
  $('#stat-called').textContent = view.leads.filter((l) => l.called).length.toLocaleString('en-IN');
  $('#stat-responded').textContent = view.leads.filter((l) => l.responded).length.toLocaleString('en-IN');
  $('#stat-unassigned').textContent = view.leads.filter((l) => !l.team).length.toLocaleString('en-IN');
  $('#stat-not-updated').textContent = view.leads.filter((l) => l.status === 'Not Updated').length.toLocaleString('en-IN');
}

// ─── Active filter chips ───────────────────────────────────────────────────
function renderChips() {
  const chips = [];
  if (filters.search) {
    chips.push({ key: 'search', label: `Search: "${filters.search}"`, clear: () => { $('#search').value = ''; filters.search = ''; $('.crm-search').classList.remove('has-value'); } });
  }
  for (const c of filters.campaign) {
    chips.push({ key: 'c:' + c, label: c, clear: () => { filters.campaign.delete(c); updateTriggerLabel('campaign'); } });
  }
  for (const s of filters.status) {
    chips.push({ key: 's:' + s, label: s, clear: () => { filters.status.delete(s); updateTriggerLabel('status'); } });
  }
  for (const t of filters.team) {
    chips.push({ key: 't:' + t, label: 'Caller: ' + t, clear: () => { filters.team.delete(t); updateTriggerLabel('team'); } });
  }
  if (filters.called)    chips.push({ key: 'called', label: filters.called === 'true' ? 'Called' : 'Not called', clear: () => { filters.called = ''; updateTriggerLabel('called'); } });
  if (filters.responded) chips.push({ key: 'resp',   label: filters.responded === 'true' ? 'Responded' : 'No response', clear: () => { filters.responded = ''; updateTriggerLabel('responded'); } });

  const container = $('#crm-chips');
  container.innerHTML = chips.map((c) => `<span class="chip" data-key="${escHtml(c.key)}">${escHtml(c.label)} <button title="Remove">&times;</button></span>`).join('');
  $$('#crm-chips .chip').forEach((el) => {
    const idx = chips.findIndex((c) => c.key === el.dataset.key);
    el.querySelector('button').addEventListener('click', () => {
      chips[idx].clear();
      applyFilters(); render();
    });
  });
}

// ─── Render table ──────────────────────────────────────────────────────────
function render() {
  applyFilters();
  updateStats();
  renderChips();
  renderTable();
  renderPagination();
  renderSortIndicator();
}

function renderTable() {
  const tbody = $('#leads-tbody');
  const start = (view.page - 1) * view.pageSize;
  const slice = view.leads.slice(start, start + view.pageSize);

  if (slice.length === 0) {
    tbody.innerHTML = '';
    $('#empty-state').style.display = 'block';
    return;
  }
  $('#empty-state').style.display = 'none';

  const teamOptions = ['', 'Unassigned', ...options.teams.filter((t) => t && t !== 'Unassigned')];
  const statusOptions = options.statuses;

  tbody.innerHTML = slice.map((l) => {
    const cm = CAMPAIGN_STYLES[l.campaign] || { cls: '', lbl: l.campaign };
    const notes = (l.otherDetails || '').trim();
    const notesPreview = notes ? escHtml(notes) : 'No notes';
    const notesClass = notes ? '' : 'empty';
    return `
      <tr data-id="${escHtml(l.id)}">
        <td class="col-date">${formatDate(l.date)}</td>
        <td class="col-name">${escHtml(l.name) || '<em style="color:#CBD5E1">—</em>'}</td>
        <td class="col-phone">${escHtml(formatPhone(l.phone))}</td>
        <td class="col-campaign"><span class="campaign-badge ${cm.cls}">${escHtml(cm.lbl)}</span></td>
        <td class="col-status">
          <select class="status-select" data-field="STATUS" data-status="${escHtml(l.status)}">
            ${statusOptions.map((s) => `<option value="${escHtml(s)}"${s === l.status ? ' selected' : ''}>${escHtml(s)}</option>`).join('')}
          </select>
        </td>
        <td class="col-called">
          <button class="bool-toggle ${l.called ? 'on' : ''}" data-field="CALLED" title="Toggle Called"></button>
        </td>
        <td class="col-resp">
          <button class="bool-toggle ${l.responded ? 'on' : ''}" data-field="RESPONDED" title="Toggle Responded"></button>
        </td>
        <td class="col-team">
          <select class="team-select" data-field="IIP TEAM">
            ${teamOptions.map((t) => `<option value="${escHtml(t === 'Unassigned' ? '' : t)}"${(t === '' && !l.team) || t === l.team ? ' selected' : ''}>${escHtml(t || '—')}</option>`).join('')}
          </select>
        </td>
        <td class="col-notes"><div class="notes-preview ${notesClass}" title="Click to edit">${notesPreview}</div></td>
      </tr>
    `;
  }).join('');

  // Wire up inline editors
  $$('#leads-tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const lead = allLeads.find((l) => l.id === id);
    if (!lead) return;

    tr.querySelector('.status-select').addEventListener('change', (e) => {
      e.target.dataset.status = e.target.value;
      handleUpdate(lead, 'STATUS', e.target.value, { local: 'status' });
    });

    tr.querySelector('[data-field="CALLED"]').addEventListener('click', (e) => {
      const newVal = !lead.called;
      e.currentTarget.classList.toggle('on', newVal);
      handleUpdate(lead, 'CALLED', newVal, { local: 'called' });
    });

    tr.querySelector('[data-field="RESPONDED"]').addEventListener('click', (e) => {
      const newVal = !lead.responded;
      e.currentTarget.classList.toggle('on', newVal);
      handleUpdate(lead, 'RESPONDED', newVal, { local: 'responded' });
    });

    tr.querySelector('.team-select').addEventListener('change', (e) => {
      handleUpdate(lead, 'IIP TEAM', e.target.value, { local: 'team' });
    });

    tr.querySelector('.col-notes').addEventListener('click', () => openDrawer(lead.id));
    tr.querySelector('.col-name').addEventListener('click', () => openDrawer(lead.id));
  });
}

function renderSortIndicator() {
  $$('thead th[data-sort]').forEach((th) => {
    th.classList.toggle('sort-active', th.dataset.sort === sort.key);
    let icon = th.querySelector('.sort-icon');
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'sort-icon';
      th.appendChild(icon);
    }
    icon.textContent = th.dataset.sort === sort.key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕';
  });
}

// ─── Pagination ────────────────────────────────────────────────────────────
function renderPagination() {
  const total = view.leads.length;
  const totalPages = Math.max(1, Math.ceil(total / view.pageSize));
  if (view.page > totalPages) view.page = totalPages;

  const nav = $('#crm-pagination');
  if (totalPages <= 1) { nav.innerHTML = ''; return; }

  const start = (view.page - 1) * view.pageSize + 1;
  const end = Math.min(view.page * view.pageSize, total);

  let html = `<button id="page-prev" ${view.page === 1 ? 'disabled' : ''}>‹ Prev</button>`;
  html += `<span class="page-info">${start.toLocaleString('en-IN')}–${end.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}</span>`;
  html += `<button id="page-next" ${view.page === totalPages ? 'disabled' : ''}>Next ›</button>`;
  nav.innerHTML = html;

  $('#page-prev').addEventListener('click', () => { view.page--; renderTable(); renderPagination(); });
  $('#page-next').addEventListener('click', () => { view.page++; renderTable(); renderPagination(); });
}

// ─── Drawer (notes + full detail) ──────────────────────────────────────────
function openDrawer(id) {
  const lead = allLeads.find((l) => l.id === id);
  if (!lead) return;
  openDrawerId = id;
  $('#drawer-content').innerHTML = drawerHTML(lead);
  $('#lead-drawer').classList.add('open');

  const ta = $('#drawer-notes');
  ta.addEventListener('input', () => debouncedSaveNotes(lead, ta.value));

  $('#drawer-followup').addEventListener('input', (e) => debouncedSaveNotes(lead, e.target.value, 'FOLLOW UP', 'followUp'));
  if ($('#drawer-iip-followup')) {
    $('#drawer-iip-followup').addEventListener('input', (e) => debouncedSaveNotes(lead, e.target.value, 'IIP FOLLOWUP', 'iipFollowup'));
  }
}

function closeDrawer() {
  $('#lead-drawer').classList.remove('open');
  openDrawerId = null;
}

function drawerHTML(l) {
  const cm = CAMPAIGN_STYLES[l.campaign] || { cls: '', lbl: l.campaign };
  const sheetUrlGid = {
    'Sheet1': '0',
    'Hindi Leads': '1742101338',
    'Interview': '160795216',
    'LinkedIn': '1243349840',
  }[l.sheet] || '0';
  const sheetLink = `https://docs.google.com/spreadsheets/d/14YB5KhwvAVnyw6zDdxa0AZhscIIDq4l7OUyzi3vfODk/edit?gid=${sheetUrlGid}&range=A${l.rowNumber}`;
  // Sheet1 doesn't have a follow-up column for IIP; only show that field for sheets that have it.
  const showIIPFollowup = l.sheet === 'Hindi Leads';
  const showFollowUp = l.sheet === 'Sheet1' || l.sheet === 'Hindi Leads' || l.sheet === 'LinkedIn';

  return `
    <h2 style="margin:0 0 4px;font-size:1.2rem;">${escHtml(l.name) || '—'}</h2>
    <p style="margin:0 0 16px;color:var(--text-muted);font-size:0.85rem;">
      <span class="campaign-badge ${cm.cls}">${escHtml(cm.lbl)}</span>
      &middot; ${escHtml(formatPhone(l.phone)) || 'no phone'}
    </p>

    <div class="drawer-section">
      <h3>Lead Info</h3>
      <div class="field"><span class="label">Date</span><span class="value">${formatDate(l.date)}</span></div>
      <div class="field"><span class="label">Email</span><span class="value">${escHtml(l.email) || '—'}</span></div>
      <div class="field"><span class="label">Industry</span><span class="value">${escHtml(l.industry) || '—'}</span></div>
      <div class="field"><span class="label">Interest</span><span class="value">${escHtml(l.interest) || '—'}</span></div>
      <div class="field"><span class="label">Platform</span><span class="value">${escHtml(l.platform) || '—'}</span></div>
      ${l.city ? `<div class="field"><span class="label">City</span><span class="value">${escHtml(l.city)}</span></div>` : ''}
      ${l.campaignName ? `<div class="field"><span class="label">Campaign Name</span><span class="value">${escHtml(l.campaignName)}</span></div>` : ''}
      ${l.adsetName ? `<div class="field"><span class="label">Adset</span><span class="value">${escHtml(l.adsetName)}</span></div>` : ''}
    </div>

    <div class="drawer-section">
      <h3>Other Details / Notes</h3>
      <textarea id="drawer-notes" placeholder="Add notes about this lead…">${escHtml(l.otherDetails)}</textarea>
      <div class="save-status" id="drawer-notes-status"></div>
    </div>

    ${showFollowUp ? `
    <div class="drawer-section">
      <h3>Follow Up</h3>
      <textarea id="drawer-followup" placeholder="Follow-up history…">${escHtml(l.followUp)}</textarea>
      <div class="save-status" id="drawer-followup-status"></div>
    </div>` : ''}

    ${showIIPFollowup ? `
    <div class="drawer-section">
      <h3>IIP Follow-up</h3>
      <textarea id="drawer-iip-followup" placeholder="IIP team follow-up notes…">${escHtml(l.iipFollowup)}</textarea>
      <div class="save-status" id="drawer-iip-followup-status"></div>
    </div>` : ''}

    <div class="drawer-id">
      Sheet: <strong>${escHtml(l.sheet)}</strong>, row ${l.rowNumber}
      &middot; <a href="${sheetLink}" target="_blank" rel="noopener">Open in Google Sheet ↗</a>
    </div>
  `;
}

function debouncedSaveNotes(lead, value, field = 'OTHER DETAILS', localKey = 'otherDetails') {
  const tk = lead.id + ':' + field;
  if (saveTimers[tk]) clearTimeout(saveTimers[tk]);
  const statusEl = $(`#drawer-${field === 'OTHER DETAILS' ? 'notes' : field === 'FOLLOW UP' ? 'followup' : 'iip-followup'}-status`);
  if (statusEl) { statusEl.className = 'save-status saving'; statusEl.textContent = 'Saving…'; }
  saveTimers[tk] = setTimeout(async () => {
    try {
      await postUpdate(lead, { [field]: value });
      lead[localKey] = value;
      if (statusEl) { statusEl.className = 'save-status saved'; statusEl.textContent = '✓ Saved'; setTimeout(() => { statusEl.textContent = ''; }, 1500); }
      // Refresh the table row's notes preview if this was the notes field
      if (field === 'OTHER DETAILS') {
        const row = document.querySelector(`tr[data-id="${lead.id}"] .notes-preview`);
        if (row) { row.textContent = value || 'No notes'; row.className = 'notes-preview ' + (value ? '' : 'empty'); }
      }
    } catch (e) {
      if (statusEl) { statusEl.className = 'save-status error'; statusEl.textContent = '✗ ' + e.message; }
      toast('Save failed: ' + e.message, 'error');
    }
  }, 800);
}

// ─── Persist update ────────────────────────────────────────────────────────
async function handleUpdate(lead, field, value, opts = {}) {
  // Optimistic local update
  if (opts.local) lead[opts.local] = value;
  const tr = document.querySelector(`tr[data-id="${lead.id}"]`);
  if (tr) { tr.classList.remove('saved'); tr.classList.add('saving'); }

  try {
    await postUpdate(lead, { [field]: value });
    if (tr) {
      tr.classList.remove('saving');
      tr.classList.add('saved');
      setTimeout(() => tr.classList.remove('saved'), 1200);
    }
    updateStats();
  } catch (e) {
    if (tr) tr.classList.remove('saving');
    toast(`Save failed for ${lead.name || 'lead'}: ${e.message}`, 'error');
    // Re-render the row to revert the optimistic UI
    renderTable();
  }
}

async function postUpdate(lead, updates) {
  const res = await fetch('/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sheet: lead.sheet,
      rowNumber: lead.rowNumber,
      updates,
    }),
  });
  let json;
  try { json = await res.json(); } catch { throw new Error('Server returned non-JSON'); }
  if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ─── Filter dropdowns ──────────────────────────────────────────────────────
// Each filter has a trigger button that opens an absolutely-positioned
// popover. Inside the popover the user makes checkbox/radio selections —
// those selections only commit to `filters` (and trigger a re-render)
// when they click Apply, exactly like the user requested.

const FILTER_DEFS = {
  campaign: { kind: 'multi', label: 'campaigns', allLabel: 'All campaigns' },
  status:   { kind: 'multi', label: 'statuses',  allLabel: 'All statuses'  },
  team:     { kind: 'multi', label: 'callers',   allLabel: 'All callers'   },
  called: {
    kind: 'single', label: 'called', allLabel: 'All',
    values: [
      { v: '',      l: 'All'        },
      { v: 'true',  l: 'Called'     },
      { v: 'false', l: 'Not called' },
    ],
  },
  responded: {
    kind: 'single', label: 'responded', allLabel: 'All',
    values: [
      { v: '',      l: 'All'         },
      { v: 'true',  l: 'Responded'   },
      { v: 'false', l: 'No response' },
    ],
  },
};

// Returns the list of options for a given filter, derived from the API
// response. Multi-selects get their option set from `options`.
function getFilterOptions(key) {
  if (key === 'campaign') return options.campaigns;
  if (key === 'status') {
    return [...options.statuses].sort((a, b) => {
      if (a === 'Not Updated') return 1;
      if (b === 'Not Updated') return -1;
      return a.localeCompare(b);
    });
  }
  if (key === 'team') {
    return ['Unassigned', ...options.teams.filter((t) => t && t !== 'Unassigned')];
  }
  return [];
}

// Build (or rebuild) the popover body for one filter.
function renderFilterPopover(key) {
  const def = FILTER_DEFS[key];
  const pop = document.getElementById('pop-' + key);
  if (!pop) return;

  const current = filters[key];

  if (def.kind === 'multi') {
    const opts = getFilterOptions(key);
    // Pending state is a fresh Set, seeded with the currently-applied values.
    pop.dataset.pending = JSON.stringify([...current]);
    pop.innerHTML = `
      <div class="filter-pop-options">
        ${opts.length === 0
          ? '<div style="padding:14px;text-align:center;color:#94A3B8;font-size:0.8rem;">No options yet</div>'
          : opts.map((v) => `
              <label class="filter-pop-option">
                <input type="checkbox" value="${escHtml(v)}" ${current.has(v) ? 'checked' : ''} />
                <span class="opt-label">${escHtml(v)}</span>
              </label>
            `).join('')}
      </div>
      <div class="filter-pop-actions">
        <button type="button" data-action="clear">Clear</button>
        <button type="button" class="primary" data-action="apply">Apply</button>
      </div>
    `;
  } else {
    // single-select (radio)
    pop.innerHTML = `
      <div class="filter-pop-options">
        ${def.values.map((opt) => `
          <label class="filter-pop-option">
            <input type="radio" name="pop-${escHtml(key)}-radio" value="${escHtml(opt.v)}" ${current === opt.v ? 'checked' : ''} />
            <span class="opt-label">${escHtml(opt.l)}</span>
          </label>
        `).join('')}
      </div>
      <div class="filter-pop-actions">
        <button type="button" data-action="clear">Clear</button>
        <button type="button" class="primary" data-action="apply">Apply</button>
      </div>
    `;
  }

  // Wire Apply / Clear inside the popover
  pop.querySelector('[data-action="apply"]').addEventListener('click', (e) => {
    e.stopPropagation();
    commitFilter(key);
    closeAllPopovers();
  });
  pop.querySelector('[data-action="clear"]').addEventListener('click', (e) => {
    e.stopPropagation();
    // Just uncheck inside the popover; don't apply until user clicks Apply
    pop.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
    const firstRadio = pop.querySelector('input[type="radio"][value=""]');
    if (firstRadio) firstRadio.checked = true;
  });
}

function commitFilter(key) {
  const def = FILTER_DEFS[key];
  const pop = document.getElementById('pop-' + key);
  if (!pop) return;
  if (def.kind === 'multi') {
    const chosen = new Set();
    pop.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => chosen.add(cb.value));
    filters[key] = chosen;
  } else {
    const sel = pop.querySelector('input[type="radio"]:checked');
    filters[key] = sel ? sel.value : '';
  }
  updateTriggerLabel(key);
  render();
}

function updateTriggerLabel(key) {
  const def = FILTER_DEFS[key];
  const trigger = document.querySelector(`.filter-trigger[data-target="pop-${key}"]`);
  if (!trigger) return;
  const labelEl = trigger.querySelector('.filter-trigger-label');
  const current = filters[key];

  if (def.kind === 'multi') {
    const n = current.size;
    if (n === 0) {
      labelEl.textContent = def.allLabel;
      trigger.classList.remove('active');
      // remove count badge if present
      const b = trigger.querySelector('.count-badge');
      if (b) b.remove();
    } else if (n === 1) {
      labelEl.textContent = [...current][0];
      trigger.classList.add('active');
      const b = trigger.querySelector('.count-badge');
      if (b) b.remove();
    } else {
      labelEl.textContent = `${n} ${def.label}`;
      trigger.classList.add('active');
      let b = trigger.querySelector('.count-badge');
      if (!b) {
        b = document.createElement('span');
        b.className = 'count-badge';
        trigger.insertBefore(b, trigger.querySelector('svg'));
      }
      b.textContent = String(n);
    }
  } else {
    if (!current) {
      labelEl.textContent = def.allLabel;
      trigger.classList.remove('active');
    } else {
      const matched = def.values.find((v) => v.v === current);
      labelEl.textContent = matched ? matched.l : current;
      trigger.classList.add('active');
    }
  }
}

function openPopover(key) {
  closeAllPopovers();
  renderFilterPopover(key);
  const pop = document.getElementById('pop-' + key);
  const trigger = document.querySelector(`.filter-trigger[data-target="pop-${key}"]`);
  if (!pop || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  pop.style.top = `${rect.bottom + window.scrollY + 4}px`;
  pop.style.left = `${rect.left + window.scrollX}px`;
  pop.hidden = false;
  trigger.classList.add('open');
}

function closeAllPopovers() {
  $$('.filter-pop').forEach((p) => { p.hidden = true; });
  $$('.filter-trigger.open').forEach((t) => t.classList.remove('open'));
}

function populateFilters() {
  // Refresh trigger labels (e.g. after data reload). Popovers are
  // re-rendered lazily on open, so options always reflect latest data.
  ['campaign', 'status', 'team', 'called', 'responded'].forEach(updateTriggerLabel);
}

// ─── CSV export ────────────────────────────────────────────────────────────
function exportCSV() {
  const headers = ['Date', 'Name', 'Phone', 'Email', 'Campaign', 'Industry', 'Status', 'Called', 'Responded', 'Caller', 'Notes', 'Follow Up'];
  const rows = view.leads.map((l) => [
    l.date || '', l.name, formatPhone(l.phone), l.email, l.campaign,
    l.industry, l.status, l.called ? 'TRUE' : 'FALSE', l.responded ? 'TRUE' : 'FALSE',
    l.team, (l.otherDetails || '').replace(/\n/g, ' / '),
    (l.followUp || '').replace(/\n/g, ' / '),
  ]);
  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `iip-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ─── Init ──────────────────────────────────────────────────────────────────
function wireFilters() {
  const search = $('#search');
  search.addEventListener('input', () => {
    filters.search = search.value;
    $('.crm-search').classList.toggle('has-value', !!search.value);
    render();
  });
  $('#search-clear').addEventListener('click', () => {
    search.value = ''; filters.search = '';
    $('.crm-search').classList.remove('has-value');
    render();
  });

  // Each trigger button opens its popover; clicking the same trigger
  // again toggles it; clicking outside closes any open popover.
  $$('.filter-trigger').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.target.replace(/^pop-/, '');
      const pop = document.getElementById(btn.dataset.target);
      if (pop && !pop.hidden) {
        closeAllPopovers();
      } else {
        openPopover(key);
      }
    });
  });

  // Click outside any popover closes them all
  document.addEventListener('click', (e) => {
    if (e.target.closest('.filter-pop') || e.target.closest('.filter-trigger')) return;
    closeAllPopovers();
  });

  // Reposition open popovers if the window resizes / scrolls
  window.addEventListener('resize', closeAllPopovers);
  window.addEventListener('scroll', closeAllPopovers, true);

  $('#btn-clear').addEventListener('click', () => {
    filters = { search: '', campaign: new Set(), status: new Set(), team: new Set(), called: '', responded: '' };
    $('#search').value = '';
    $('.crm-search').classList.remove('has-value');
    closeAllPopovers();
    populateFilters();
    render();
  });

  $('#btn-export').addEventListener('click', exportCSV);

  $$('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else { sort.key = key; sort.dir = 'asc'; }
      render();
    });
  });

  // Keyboard: Escape closes drawer
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openDrawerId) closeDrawer();
  });
}

async function init() {
  wireFilters();
  try {
    await loadLeads();
    populateFilters();
    render();
    document.getElementById('loading-overlay').classList.add('fade-out');
    setTimeout(() => document.getElementById('loading-overlay').remove(), 500);
  } catch (e) {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.innerHTML = `
        <div class="loading-content">
          <p style="color:#DC2626;font-weight:600;margin-bottom:8px;">Failed to load leads</p>
          <p style="color:#64748B;margin-bottom:16px;">${escHtml(e.message)}</p>
          <button class="btn-refresh" onclick="location.reload()">Retry</button>
        </div>`;
    }
    toast('Failed to load leads: ' + e.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
