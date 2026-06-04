'use strict';

const BASE = window.location.pathname.includes('/rbm-emulator')
  ? '/rbm-emulator'
  : '.';

async function loadJSON(path) {
  const resp = await fetch(`${BASE}/data/${path}`);
  if (!resp.ok) throw new Error(`Failed to load ${path}: ${resp.status}`);
  return resp.json();
}

const PALETTE = [
  '#6e40c9', '#9f7aea', '#4299e1', '#48bb78', '#f4c542',
  '#ed8936', '#fc8181', '#76e4f7', '#b794f4', '#68d391',
];

const fmt = {
  usd(v) {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v.toLocaleString()}`;
  },
  num(v) {
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    return v.toLocaleString();
  },
  pct(v) { return `${v.toFixed(2)}%`; },
  delta(v, isShares = false) {
    if (v === 0) return { text: '—', cls: 'delta-neutral' };
    const sign = v > 0 ? '+' : '';
    const text = isShares ? `${sign}${fmt.num(v)}` : `${sign}${fmt.usd(v * 1000)}`;
    return { text, cls: v > 0 ? 'delta-positive' : 'delta-negative' };
  },
};

let state = {
  meta: null,
  latestHoldings: null,
  holdingsByQuarter: null,
  filings: null,
  activeQuarter: null,
  sortCol: 'value_usd',
  sortDir: 'desc',
  filter: '',
  showExited: false,
  historyChart: null,
  donutChart: null,
  sparklineChart: null,
};

async function boot() {
  try {
    [state.meta, state.latestHoldings, state.holdingsByQuarter, state.filings] = await Promise.all([
      loadJSON('meta.json'),
      loadJSON('latest_holdings.json'),
      loadJSON('holdings_by_quarter.json'),
      loadJSON('filings.json'),
    ]);
  } catch (e) {
    showEmptyState(e.message);
    return;
  }

  state.activeQuarter = state.meta.latest_quarter;
  renderHeader();
  renderStats();
  renderQuarterSelect();
  renderHoldingsTable();
  renderHistoryChart();
  renderDonutChart();
  renderFilingsTable();
  bindEvents();
}

function showEmptyState(msg) {
  document.getElementById('holdings-body').innerHTML = `
    <tr><td colspan="7" class="empty-state">
      <h3>No data available yet</h3>
      <p>${msg || 'Run <code>scripts/fetch_filings.py</code> to populate the dashboard.'}</p>
    </td></tr>`;
}

function renderHeader() {
  const { meta } = state;
  const updated = meta.last_updated
    ? new Date(meta.last_updated).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Never';
  document.getElementById('last-updated').textContent = `Last updated: ${updated}`;
  document.getElementById('latest-quarter').textContent = meta.latest_quarter
    ? `Latest filing: ${meta.latest_quarter}`
    : '';
}

function renderStats() {
  const { latestHoldings, meta } = state;
  if (!latestHoldings || !latestHoldings.holdings) return;

  const active = latestHoldings.holdings.filter(h => h.qoq_status !== 'exited');
  const total = active.reduce((s, h) => s + h.value_thousands, 0) * 1000;
  const largest = active[0];

  document.getElementById('stat-total-value').textContent = fmt.usd(total);
  document.getElementById('stat-quarter').textContent = latestHoldings.quarter || '—';
  document.getElementById('stat-holdings').textContent = active.length;
  document.getElementById('stat-largest').textContent = largest
    ? (largest.ticker || largest.display_name || '—')
    : '—';
  document.getElementById('stat-largest-pct').textContent = largest
    ? `${largest.pct_of_portfolio?.toFixed(1)}% of portfolio`
    : '';
  document.getElementById('stat-filings').textContent = meta.total_filing_count || 0;
}

function renderQuarterSelect() {
  const sel = document.getElementById('quarter-select');
  const quarters = Object.keys(state.holdingsByQuarter).sort().reverse();
  quarters.forEach(q => {
    const opt = document.createElement('option');
    opt.value = q;
    opt.textContent = q;
    if (q === state.activeQuarter) opt.selected = true;
    sel.appendChild(opt);
  });
}

function getDisplayHoldings() {
  const quarterData = state.holdingsByQuarter[state.activeQuarter] || [];
  let rows = quarterData.slice();

  if (!state.showExited) rows = rows.filter(h => h.qoq_status !== 'exited');

  const q = state.filter.toLowerCase();
  if (q) {
    rows = rows.filter(h =>
      (h.ticker || '').toLowerCase().includes(q) ||
      (h.display_name || '').toLowerCase().includes(q) ||
      (h.name_of_issuer || '').toLowerCase().includes(q)
    );
  }

  rows.sort((a, b) => {
    let av = a[state.sortCol] ?? 0;
    let bv = b[state.sortCol] ?? 0;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return state.sortDir === 'asc' ? -1 : 1;
    if (av > bv) return state.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  return rows;
}

function renderHoldingsTable() {
  const tbody = document.getElementById('holdings-body');
  const rows = getDisplayHoldings();

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">
      <h3>No positions found</h3><p>Try adjusting the filter or quarter.</p>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(h => {
    const isExited = h.qoq_status === 'exited';
    const sdelta = fmt.delta(h.qoq_shares_delta ?? 0, true);
    const vdelta = fmt.delta(h.qoq_value_delta ?? 0);
    const badge = h.qoq_status === 'new'
      ? '<span class="badge badge-new">NEW</span>'
      : h.qoq_status === 'exited'
        ? '<span class="badge badge-exited">EXITED</span>'
        : '';
    return `<tr class="${isExited ? 'row-exited' : ''}" data-cusip="${h.cusip}">
      <td class="ticker-cell">${h.ticker || '—'}${badge}</td>
      <td>${h.display_name || h.name_of_issuer || '—'}</td>
      <td class="num">${fmt.num(h.shares)}</td>
      <td class="num">${fmt.usd(h.value_usd || h.value_thousands * 1000)}</td>
      <td class="num">${h.pct_of_portfolio != null ? fmt.pct(h.pct_of_portfolio) : '—'}</td>
      <td class="num ${sdelta.cls}">${sdelta.text}</td>
      <td class="num ${vdelta.cls}">${vdelta.text}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-cusip]').forEach(tr => {
    tr.addEventListener('click', () => openDrawer(tr.dataset.cusip));
  });
}

function renderHistoryChart() {
  const { meta } = state;
  const series = meta.chart_series || {};
  const quarters = meta.quarters || [];

  if (!quarters.length) return;

  const datasets = Object.entries(series).map(([cusip, s], i) => ({
    label: s.label || cusip,
    data: quarters.map(q => {
      const pt = s.data.find(d => d.quarter === q);
      return pt ? pt.value_usd / 1e6 : 0;
    }),
    borderColor: PALETTE[i % PALETTE.length],
    backgroundColor: PALETTE[i % PALETTE.length] + '22',
    tension: 0.3,
    pointRadius: 4,
    fill: false,
  }));

  const ctx = document.getElementById('history-chart').getContext('2d');
  if (state.historyChart) state.historyChart.destroy();
  state.historyChart = new Chart(ctx, {
    type: 'line',
    data: { labels: quarters, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#c9d1d9', font: { size: 12 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: $${ctx.parsed.y.toFixed(1)}M` } },
      },
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
        y: { ticks: { color: '#8b949e', callback: v => `$${v}M` }, grid: { color: '#21262d' } },
      },
    },
  });
}

function renderDonutChart() {
  const holdings = (state.latestHoldings?.holdings || []).filter(h => h.qoq_status !== 'exited');
  if (!holdings.length) return;

  const top10 = holdings.slice(0, 10);
  const othersValue = holdings.slice(10).reduce((s, h) => s + h.value_thousands, 0);

  const labels = [...top10.map(h => h.ticker || h.display_name || h.cusip)];
  const data = [...top10.map(h => h.value_thousands)];
  const colors = [...PALETTE.slice(0, top10.length)];

  if (othersValue > 0) { labels.push('Other'); data.push(othersValue); colors.push('#30363d'); }

  const ctx = document.getElementById('donut-chart').getContext('2d');
  if (state.donutChart) state.donutChart.destroy();
  state.donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 1, borderColor: '#161b22' }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
              const pct = (ctx.parsed / total * 100).toFixed(1);
              return ` ${ctx.label}: ${fmt.usd(ctx.parsed * 1000)} (${pct}%)`;
            },
          },
        },
      },
    },
  });

  const legend = document.getElementById('composition-legend');
  legend.innerHTML = top10.map((h, i) => `
    <div class="legend-item">
      <div class="legend-dot" style="background:${colors[i]}"></div>
      <span class="legend-ticker">${h.ticker || '—'}</span>
      <span class="legend-name">${h.display_name || h.name_of_issuer || ''}</span>
      <span class="legend-pct">${fmt.pct(h.pct_of_portfolio || 0)}</span>
    </div>
  `).join('');
}

function renderFilingsTable() {
  const filings = [...(state.filings || [])].sort((a, b) => b.filed_date.localeCompare(a.filed_date));
  const tbody = document.getElementById('filings-body');

  if (!filings.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><h3>No filings yet</h3></td></tr>`;
    return;
  }

  tbody.innerHTML = filings.map(f => `
    <tr>
      <td>${f.quarter || '—'}</td>
      <td>${f.filed_date || '—'}</td>
      <td><span class="badge badge-new">${f.form}</span></td>
      <td class="num">${f.num_holdings ?? '—'}</td>
      <td class="num">${f.total_value_thousands ? fmt.usd(f.total_value_thousands * 1000) : '—'}</td>
      <td><a href="${f.filing_url || '#'}" target="_blank" rel="noopener">EDGAR ↗</a></td>
    </tr>
  `).join('');
}

function openDrawer(cusip) {
  const allQuarters = Object.keys(state.holdingsByQuarter).sort();
  const history = allQuarters.map(q => {
    const h = state.holdingsByQuarter[q].find(h => h.cusip === cusip);
    return h ? { quarter: q, ...h } : { quarter: q, shares: 0, value_thousands: 0, pct_of_portfolio: 0 };
  }).filter(h => h.shares > 0 || allQuarters.indexOf(h.quarter) === allQuarters.length - 1);

  const latest = history[history.length - 1];
  const label = latest?.ticker || latest?.display_name || latest?.name_of_issuer || cusip;

  document.getElementById('drawer-title').textContent = label;
  document.getElementById('drawer-cusip').textContent = `CUSIP: ${cusip}`;

  document.getElementById('drawer-stats').innerHTML = `
    <div class="drawer-stat"><div class="drawer-stat-label">Shares</div><div class="drawer-stat-value">${fmt.num(latest?.shares || 0)}</div></div>
    <div class="drawer-stat"><div class="drawer-stat-label">Market Value</div><div class="drawer-stat-value">${fmt.usd((latest?.value_thousands || 0) * 1000)}</div></div>
    <div class="drawer-stat"><div class="drawer-stat-label">% Portfolio</div><div class="drawer-stat-value">${fmt.pct(latest?.pct_of_portfolio || 0)}</div></div>
    <div class="drawer-stat"><div class="drawer-stat-label">Quarters held</div><div class="drawer-stat-value">${history.filter(h => h.shares > 0).length}</div></div>
  `;

  const ctx = document.getElementById('sparkline-chart').getContext('2d');
  if (state.sparklineChart) state.sparklineChart.destroy();
  state.sparklineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: history.map(h => h.quarter),
      datasets: [{ data: history.map(h => h.shares), borderColor: '#6e40c9', backgroundColor: '#6e40c922', fill: true, tension: 0.3, pointRadius: 3 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: '#21262d' } },
        y: { ticks: { color: '#8b949e', callback: v => fmt.num(v) }, grid: { color: '#21262d' } },
      },
    },
  });

  document.getElementById('drawer-history-body').innerHTML = history.map(h => `
    <tr>
      <td>${h.quarter}</td>
      <td class="num">${fmt.num(h.shares)}</td>
      <td class="num">${fmt.usd(h.value_thousands * 1000)}</td>
      <td class="num">${h.pct_of_portfolio != null ? fmt.pct(h.pct_of_portfolio) : '—'}</td>
    </tr>
  `).join('');

  document.getElementById('drawer-overlay').classList.add('open');
  document.getElementById('detail-drawer').classList.add('open');
}

function closeDrawer() {
  document.getElementById('drawer-overlay').classList.remove('open');
  document.getElementById('detail-drawer').classList.remove('open');
}

function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  document.getElementById('search-input').addEventListener('input', e => {
    state.filter = e.target.value;
    renderHoldingsTable();
  });

  document.getElementById('quarter-select').addEventListener('change', e => {
    state.activeQuarter = e.target.value || state.meta.latest_quarter;
    renderHoldingsTable();
  });

  document.getElementById('show-exited').addEventListener('change', e => {
    state.showExited = e.target.checked;
    renderHoldingsTable();
  });

  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col;
        state.sortDir = 'desc';
      }
      document.querySelectorAll('th.sortable').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderHoldingsTable();
    });
  });

  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);
}

boot();
