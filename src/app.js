'use strict';

const BASE = window.location.pathname.includes('/rbm-emulator') ? '/rbm-emulator' : '.';
const NS = 'http://www.w3.org/2000/svg';

/* ══════════════════════════════════════════════
   STATE
══════════════════════════════════════════════ */
const state = {
  meta: null,
  latestHoldings: null,
  holdingsByQuarter: null,
  filings: null,
  selectedQuarter: null,
  typeFilter: 'all',
  searchQ: '',
};

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */

function holdingType(h) {
  const pc = (h.put_call || '').toLowerCase().trim();
  if (pc === 'put')  return 'put';
  if (pc === 'call') return 'call';
  return 'long';
}

const fmt = {
  usd(v) {
    if (v == null || isNaN(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9)  return '$' + (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6)  return '$' + (v / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3)  return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + v.toFixed(0);
  },
  usdShort(v) {
    if (v == null || isNaN(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9)  return (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6)  return (v / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3)  return (v / 1e3).toFixed(0) + 'K';
    return String(v);
  },
  shares(v) {
    if (v == null || isNaN(v) || v === 0) return '—';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M sh';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K sh';
    return String(v);
  },
  pct(v) {
    if (v == null || isNaN(v)) return '—';
    return v.toFixed(2) + '%';
  },
  date(s) {
    if (!s) return '—';
    const d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  },
  quarter(q) {
    if (!q) return q;
    const [year, qpart] = q.split('-');
    return `${qpart} ${year}`;
  },
};

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (k === 'innerHTML') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  children.forEach(c => c && node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return node;
}

function sortedQuarters(holdingsByQuarter) {
  return Object.keys(holdingsByQuarter)
    .filter(q => /^\d{4}-Q\d$/.test(q))
    .sort();
}

/* ══════════════════════════════════════════════
   DATA LOADING
══════════════════════════════════════════════ */
async function loadData() {
  const load = p => fetch(`${BASE}/data/${p}`).then(r => { if (!r.ok) throw new Error(p + ': ' + r.status); return r.json(); });
  [state.meta, state.latestHoldings, state.holdingsByQuarter, state.filings] = await Promise.all([
    load('meta.json'), load('latest_holdings.json'),
    load('holdings_by_quarter.json'), load('filings.json'),
  ]);
}

/* ══════════════════════════════════════════════
   QUARTER DROPDOWN
══════════════════════════════════════════════ */
function buildDropdown() {
  const quarters = sortedQuarters(state.holdingsByQuarter).reverse(); // newest first
  const latestQ  = state.meta.latest_quarter;
  const btn      = document.getElementById('quarter-btn');
  const label    = document.getElementById('quarter-btn-label');
  const menu     = document.getElementById('quarter-menu');

  // Set button label
  label.textContent = fmt.quarter(state.selectedQuarter);
  if (state.selectedQuarter === latestQ) {
    const chip = el('span', { className: 'new-chip', textContent: 'NEW' });
    label.after(chip);
  }

  // Populate menu
  menu.innerHTML = '';
  quarters.forEach(q => {
    const opt = el('div', {
      className: 'quarter-opt' + (q === state.selectedQuarter ? ' active' : ''),
      role: 'option',
    });
    opt.appendChild(el('span', { textContent: fmt.quarter(q) }));
    if (q === latestQ) {
      opt.appendChild(el('span', { className: 'new-chip', textContent: 'NEW' }));
    }
    opt.addEventListener('click', () => {
      switchQuarter(q);
      closeMenu();
    });
    menu.appendChild(opt);
  });

  // Toggle menu on button click
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    if (isOpen) closeMenu();
    else openMenu();
  });

  document.addEventListener('click', () => closeMenu());
  menu.addEventListener('click', e => e.stopPropagation());

  function openMenu() {
    menu.classList.add('open');
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    menu.classList.remove('open');
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
}

function switchQuarter(q) {
  state.selectedQuarter = q;
  // Update button label
  const label = document.getElementById('quarter-btn-label');
  label.textContent = fmt.quarter(q);
  // Remove any existing chip next to label
  const existing = document.getElementById('quarter-btn').querySelector('.new-chip');
  if (existing) existing.remove();
  if (q === state.meta.latest_quarter) {
    label.after(el('span', { className: 'new-chip', textContent: 'NEW' }));
  }
  // Update active state in menu
  document.querySelectorAll('.quarter-opt').forEach(opt => {
    opt.classList.toggle('active', opt.querySelector('span')?.textContent === fmt.quarter(q));
  });
  renderSnapshot();
}

/* ══════════════════════════════════════════════
   SECTION 1 — TREND CHARTS
══════════════════════════════════════════════ */

function renderAumChart() {
  const quarters = sortedQuarters(state.holdingsByQuarter);
  const values = quarters.map(q => {
    const hs = (state.holdingsByQuarter[q] || []).filter(h => h.qoq_status !== 'exited');
    return hs.reduce((s, h) => s + (h.value_thousands || 0), 0) * 1000;
  });

  const W = 320, H = 160, pL = 36, pR = 308, pT = 18, pB = 130;
  const pH = pB - pT;
  const maxV = Math.max(...values, 1);
  const maxB = Math.ceil(maxV / 1e9) * 1e9 || 1e9;

  const svg = svgEl('svg', { width: '100%', viewBox: `0 0 ${W} ${H + 28}`, preserveAspectRatio: 'xMidYMid meet' });

  // defs: gradient fill
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'aumGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
  const s1 = svgEl('stop', { offset: '0%', 'stop-color': '#8957e5', 'stop-opacity': '0.4' });
  const s2 = svgEl('stop', { offset: '100%', 'stop-color': '#8957e5', 'stop-opacity': '0.0' });
  grad.append(s1, s2); defs.append(grad); svg.append(defs);

  // gridlines
  [0, 0.25, 0.5, 0.75, 1].forEach(frac => {
    const v = maxB * frac;
    const y = pB - frac * pH;
    const line = svgEl('line', { x1: pL, x2: pR, y1: y, y2: y, stroke: '#21262d', 'stroke-width': '1' });
    svg.append(line);
    if (frac > 0) {
      const t = svgEl('text', { x: pL - 4, y: y + 3, 'text-anchor': 'end', 'font-size': '8', 'font-family': 'JetBrains Mono,monospace', fill: '#8b949e' });
      t.textContent = '$' + (v / 1e9).toFixed(0) + 'B';
      svg.append(t);
    }
  });

  const n = quarters.length;
  const xFor = i => pL + (n > 1 ? (i / (n - 1)) * (pR - pL) : (pR - pL) / 2);
  const yFor = v => pB - (v / maxB) * pH;

  const pts = values.map((v, i) => [xFor(i), yFor(v)]);
  const polyPts = pts.map(p => p.join(',')).join(' ');

  // area
  const areaPath = `M${pts[0][0]},${pB} ` + pts.map(p => `L${p[0]},${p[1]}`).join(' ') + ` L${pts[pts.length-1][0]},${pB} Z`;
  svg.append(svgEl('path', { d: areaPath, fill: 'url(#aumGrad)' }));

  // line
  svg.append(svgEl('polyline', { points: polyPts, fill: 'none', stroke: '#8957e5', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // data points + labels
  pts.forEach((p, i) => {
    svg.append(svgEl('circle', { cx: p[0], cy: p[1], r: '3.5', fill: '#8957e5', stroke: '#161b22', 'stroke-width': '1.5' }));
    const vl = svgEl('text', { x: p[0], y: p[1] - 8, 'text-anchor': 'middle', 'font-size': '8.5', 'font-family': 'JetBrains Mono,monospace', fill: i === n - 1 ? '#f4c542' : '#8b949e', 'font-weight': i === n - 1 ? '600' : '400' });
    vl.textContent = fmt.usdShort(values[i]);
    svg.append(vl);
    const ql = svgEl('text', { x: p[0], y: pB + 18, 'text-anchor': 'middle', 'font-size': '8', 'font-family': 'JetBrains Mono,monospace', fill: '#8b949e' });
    ql.textContent = fmt.quarter(quarters[i]);
    svg.append(ql);
  });

  document.getElementById('aum-chart-svg').innerHTML = '';
  document.getElementById('aum-chart-svg').appendChild(svg);
}

function renderExposureChart() {
  const quarters = sortedQuarters(state.holdingsByQuarter);
  const data = quarters.map(q => {
    const hs = (state.holdingsByQuarter[q] || []).filter(h => h.qoq_status !== 'exited');
    const longV = hs.filter(h => holdingType(h) === 'long').reduce((s, h) => s + (h.value_thousands || 0), 0) * 1000;
    const putV  = hs.filter(h => holdingType(h) === 'put').reduce((s, h) => s + (h.value_thousands || 0), 0) * 1000;
    const callV = hs.filter(h => holdingType(h) === 'call').reduce((s, h) => s + (h.value_thousands || 0), 0) * 1000;
    return { q, longV, putV, callV };
  });

  const W = 320, H = 160, pL = 36, pR = 308, pT = 18, pB = 130;
  const pH = pB - pT;
  const maxV = Math.max(...data.map(d => d.longV + d.putV + d.callV), 1);
  const maxB = Math.ceil(maxV / 1e9) * 1e9 || 1e9;
  const n = data.length;
  const slotW = (pR - pL) / n;
  const barW = Math.min(slotW * 0.3, 22);

  const svg = svgEl('svg', { width: '100%', viewBox: `0 0 ${W} ${H + 28}`, preserveAspectRatio: 'xMidYMid meet' });

  // gridlines
  [0, 0.25, 0.5, 0.75, 1].forEach(frac => {
    const y = pB - frac * pH;
    svg.append(svgEl('line', { x1: pL, x2: pR, y1: y, y2: y, stroke: '#21262d', 'stroke-width': '1' }));
    if (frac > 0) {
      const t = svgEl('text', { x: pL - 4, y: y + 3, 'text-anchor': 'end', 'font-size': '8', 'font-family': 'JetBrains Mono,monospace', fill: '#8b949e' });
      t.textContent = '$' + ((maxB * frac) / 1e9).toFixed(0) + 'B';
      svg.append(t);
    }
  });

  data.forEach((d, i) => {
    const cx = pL + slotW * i + slotW / 2;
    const longH = (d.longV / maxB) * pH;
    const putH  = (d.putV  / maxB) * pH;

    // Long bar (green, left)
    if (longH > 0) {
      svg.append(svgEl('rect', { x: cx - barW - 2, y: pB - longH, width: barW, height: Math.max(longH, 1), rx: '3', fill: 'rgba(63,185,80,0.7)' }));
    }
    // Put bar (red, right)
    if (putH > 0) {
      svg.append(svgEl('rect', { x: cx + 2, y: pB - putH, width: barW, height: Math.max(putH, 1), rx: '3', fill: 'rgba(248,81,73,0.7)' }));
    }

    // Quarter label
    const ql = svgEl('text', { x: cx, y: pB + 18, 'text-anchor': 'middle', 'font-size': '8', 'font-family': 'JetBrains Mono,monospace', fill: '#8b949e' });
    ql.textContent = fmt.quarter(d.q);
    svg.append(ql);
  });

  // legend
  const lgY = H + 24;
  [{ color: 'rgba(63,185,80,0.7)', label: 'Long' }, { color: 'rgba(248,81,73,0.7)', label: 'Put/Short' }].forEach((item, i) => {
    const lx = pL + i * 80;
    svg.append(svgEl('rect', { x: lx, y: lgY - 7, width: 10, height: 7, rx: '2', fill: item.color }));
    const lt = svgEl('text', { x: lx + 14, y: lgY, 'font-size': '8', 'font-family': 'JetBrains Mono,monospace', fill: '#8b949e' }));
    lt.textContent = item.label;
    svg.append(lt);
  });

  document.getElementById('exposure-chart-svg').innerHTML = '';
  document.getElementById('exposure-chart-svg').appendChild(svg);
}

function renderPositionChart() {
  const quarters = sortedQuarters(state.holdingsByQuarter);
  const counts = quarters.map(q => (state.holdingsByQuarter[q] || []).filter(h => h.qoq_status !== 'exited').length);

  const W = 320, H = 160, pL = 28, pR = 308, pT = 18, pB = 130;
  const pH = pB - pT;
  const maxV = Math.max(...counts, 1);
  const maxC = Math.ceil(maxV / 10) * 10 || 10;
  const n = quarters.length;
  const slotW = (pR - pL) / n;
  const barW = Math.min(slotW * 0.55, 38);

  const svg = svgEl('svg', { width: '100%', viewBox: `0 0 ${W} ${H + 28}`, preserveAspectRatio: 'xMidYMid meet' });

  [0, 0.25, 0.5, 0.75, 1].forEach(frac => {
    const y = pB - frac * pH;
    svg.append(svgEl('line', { x1: pL, x2: pR, y1: y, y2: y, stroke: '#21262d', 'stroke-width': '1' }));
    if (frac > 0) {
      const t = svgEl('text', { x: pL - 4, y: y + 3, 'text-anchor': 'end', 'font-size': '8', 'font-family': 'JetBrains Mono,monospace', fill: '#8b949e' });
      t.textContent = Math.round(maxC * frac);
      svg.append(t);
    }
  });

  quarters.forEach((q, i) => {
    const cx = pL + slotW * i + slotW / 2;
    const barH = (counts[i] / maxC) * pH;
    const isLast = i === n - 1;
    svg.append(svgEl('rect', { x: cx - barW / 2, y: pB - Math.max(barH, 2), width: barW, height: Math.max(barH, 2), rx: '4', fill: isLast ? '#6e40c9' : 'rgba(110,64,201,0.45)' }));
    const vl = svgEl('text', { x: cx, y: pB - Math.max(barH, 2) - 6, 'text-anchor': 'middle', 'font-size': '9', 'font-family': 'JetBrains Mono,monospace', fill: isLast ? '#f4c542' : '#8b949e', 'font-weight': isLast ? '600' : '400' });
    vl.textContent = counts[i];
    svg.append(vl);
    const ql = svgEl('text', { x: cx, y: pB + 18, 'text-anchor': 'middle', 'font-size': '8', 'font-family': 'JetBrains Mono,monospace', fill: '#8b949e' });
    ql.textContent = fmt.quarter(q);
    svg.append(ql);
  });

  document.getElementById('positions-chart-svg').innerHTML = '';
  document.getElementById('positions-chart-svg').appendChild(svg);
}

function renderTrendStats() {
  const quarters = sortedQuarters(state.holdingsByQuarter);
  if (!quarters.length) return;

  const getTotal = q => (state.holdingsByQuarter[q] || []).filter(h => h.qoq_status !== 'exited').reduce((s, h) => s + (h.value_thousands || 0), 0) * 1000;

  const firstV = getTotal(quarters[0]);
  const lastV  = getTotal(quarters[quarters.length - 1]);
  const growth = firstV > 0 ? ((lastV - firstV) / firstV * 100).toFixed(0) + '%' : '—';

  const peakQ = quarters.reduce((best, q) => getTotal(q) > getTotal(best) ? q : best, quarters[0]);

  const allCusips = new Set();
  quarters.forEach(q => (state.holdingsByQuarter[q] || []).forEach(h => allCusips.add(h.cusip)));

  const mostActiveQ = quarters.slice(1).reduce((best, q) => {
    const newCount = (state.holdingsByQuarter[q] || []).filter(h => h.qoq_status === 'new').length;
    const bestCount = (state.holdingsByQuarter[best] || []).filter(h => h.qoq_status === 'new').length;
    return newCount > bestCount ? q : best;
  }, quarters[1] || quarters[0]);

  const stats = [
    { label: 'AUM Growth (Total)', value: '+' + growth, cls: 'green', meta: `${fmt.quarter(quarters[0])} → ${fmt.quarter(quarters[quarters.length-1])}` },
    { label: 'Peak Quarter',       value: fmt.quarter(peakQ), cls: 'gold',  meta: fmt.usd(getTotal(peakQ)) },
    { label: 'Positions Tracked',  value: allCusips.size,     cls: 'blue',  meta: 'Unique CUSIPs ever held' },
    { label: 'Most Active Quarter',value: fmt.quarter(mostActiveQ), cls: 'accent', meta: (state.holdingsByQuarter[mostActiveQ] || []).filter(h => h.qoq_status === 'new').length + ' new positions' },
  ];

  document.getElementById('trend-stats').innerHTML = stats.map(s => `
    <div class="stat-card">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value ${s.cls}">${s.value}</div>
      <div class="stat-meta">${s.meta}</div>
    </div>`).join('');
}

/* ══════════════════════════════════════════════
   SECTION 2 — QUARTER SNAPSHOT
══════════════════════════════════════════════ */

function renderSnapshot() {
  const q = state.selectedQuarter;
  document.getElementById('snapshot-title').textContent = fmt.quarter(q) + ' Snapshot';
  renderSnapshotStats(q);
  renderHoldings(q);
  renderDonut(q);
  renderTopMovers(q);
}

function renderSnapshotStats(q) {
  const hs = (state.holdingsByQuarter[q] || []);
  const active = hs.filter(h => h.qoq_status !== 'exited');
  const totalV = active.reduce((s, h) => s + (h.value_thousands || 0), 0) * 1000;
  const newCount    = active.filter(h => h.qoq_status === 'new').length;
  const exitedCount = hs.filter(h => h.qoq_status === 'exited').length;

  // Prev quarter for delta
  const quarters = sortedQuarters(state.holdingsByQuarter);
  const idx = quarters.indexOf(q);
  const prevQ = idx > 0 ? quarters[idx - 1] : null;
  const prevActive = prevQ ? (state.holdingsByQuarter[prevQ] || []).filter(h => h.qoq_status !== 'exited') : [];
  const prevV = prevActive.reduce((s, h) => s + (h.value_thousands || 0), 0) * 1000;
  const valueDelta = prevV > 0 ? ((totalV - prevV) / prevV * 100) : null;

  document.getElementById('snapshot-stats').innerHTML = [
    {
      label: 'Total Portfolio Value',
      value: fmt.usd(totalV),
      meta: valueDelta !== null ? `<span style="color:${valueDelta >= 0 ? 'var(--green)' : 'var(--red)'}">${valueDelta >= 0 ? '▲' : '▼'} ${Math.abs(valueDelta).toFixed(1)}% QoQ</span>` : '13F Reportable',
    },
    { label: 'Active Holdings', value: active.length, meta: 'Positions reported' },
    { label: 'New This Quarter', value: newCount,    meta: `<span style="color:var(--green)">▲ Added</span>` },
    { label: 'Exited This Quarter', value: exitedCount, meta: `<span style="color:var(--red)">▼ Closed</span>` },
  ].map(s => `
    <div class="stat-card">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${s.value}</div>
      <div class="stat-meta">${s.meta}</div>
    </div>`).join('');
}

function renderHoldings(q) {
  const allHs = (state.holdingsByQuarter[q] || []);
  let hs = allHs.filter(h => h.qoq_status !== 'exited');

  if (state.typeFilter !== 'all') hs = hs.filter(h => holdingType(h) === state.typeFilter);
  if (state.searchQ) {
    const sq = state.searchQ.toLowerCase();
    hs = hs.filter(h =>
      (h.ticker || '').toLowerCase().includes(sq) ||
      (h.display_name || '').toLowerCase().includes(sq) ||
      (h.name_of_issuer || '').toLowerCase().includes(sq)
    );
  }

  const tbody = document.getElementById('holdings-tbody');
  if (!hs.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px;font-size:13px;">No positions found.</td></tr>`;
    return;
  }

  tbody.innerHTML = hs.map(h => {
    const type = holdingType(h);
    const typePill = `<span class="type-pill ${type}">${type.toUpperCase()}</span>`;
    const size = type === 'long' && h.shares ? fmt.shares(h.shares) : '—';
    const pct  = h.pct_of_portfolio || 0;
    const pctBar = `<div class="pct-bar-wrap">
      <span class="mono-cell">${fmt.pct(pct)}</span>
      <div class="pct-bar-bg"><div class="pct-bar-fill" style="width:${Math.min(pct * 3, 100)}%"></div></div>
    </div>`;

    let qoqHtml;
    if (h.qoq_status === 'new') {
      qoqHtml = '<span class="qoq-new">NEW</span>';
    } else if ((h.qoq_shares_delta || 0) !== 0 && h.value_thousands) {
      const prevV = h.value_thousands - (h.qoq_value_delta || 0);
      const pctChange = prevV > 0 ? ((h.qoq_value_delta || 0) / prevV * 100) : 0;
      const sign = pctChange >= 0 ? '+' : '';
      const cls  = pctChange >= 0 ? 'qoq-up' : 'qoq-down';
      qoqHtml = `<span class="${cls}">${sign}${pctChange.toFixed(1)}%</span>`;
    } else {
      qoqHtml = '<span class="qoq-flat">—</span>';
    }

    return `<tr data-cusip="${h.cusip}">
      <td class="ticker-cell">${h.ticker || '—'}</td>
      <td class="company-cell">${h.display_name || h.name_of_issuer || '—'}</td>
      <td>${typePill}</td>
      <td class="mono-cell">${size}</td>
      <td class="mono-cell">${fmt.usd((h.value_thousands || 0) * 1000)}</td>
      <td>${pctBar}</td>
      <td>${qoqHtml}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-cusip]').forEach(tr =>
    tr.addEventListener('click', () => openDrawer(tr.dataset.cusip))
  );
}

function renderDonut(q) {
  const hs = (state.holdingsByQuarter[q] || []).filter(h => h.qoq_status !== 'exited');
  const total = hs.reduce((s, h) => s + (h.value_thousands || 0), 0);
  if (!total) return;

  const putTotal  = hs.filter(h => holdingType(h) === 'put').reduce((s, h) => s + (h.value_thousands || 0), 0);
  const callTotal = hs.filter(h => holdingType(h) === 'call').reduce((s, h) => s + (h.value_thousands || 0), 0);
  const longs     = hs.filter(h => holdingType(h) === 'long').sort((a, b) => (b.value_thousands || 0) - (a.value_thousands || 0));
  const top3      = longs.slice(0, 3);
  const otherV    = longs.slice(3).reduce((s, h) => s + (h.value_thousands || 0), 0);

  const COLORS = ['#f85149', '#58a6ff', '#8957e5', '#3fb950', '#f4c542', '#e3934d'];
  const segs = [
    putTotal  > 0 ? { label: 'Put Options',  val: putTotal,  color: '#f85149' } : null,
    callTotal > 0 ? { label: 'Call Options', val: callTotal, color: '#58a6ff' } : null,
    ...top3.map((h, i) => ({ label: h.ticker || h.display_name || 'Long', val: h.value_thousands || 0, color: COLORS[2 + i] })),
    otherV > 0 ? { label: 'Other Longs', val: otherV, color: '#6e7681' } : null,
  ].filter(Boolean);

  const CX = 75, CY = 75, R = 55, SW = 18, C = 2 * Math.PI * R;
  const svg = svgEl('svg', { width: '150', height: '150', viewBox: '0 0 150 150' });

  svg.append(svgEl('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: '#21262d', 'stroke-width': SW }));

  let offset = 0;
  segs.forEach(seg => {
    const len = (seg.val / total) * C;
    const arc = svgEl('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: seg.color, 'stroke-width': SW, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -offset, transform: `rotate(-90 ${CX} ${CY})`, 'stroke-linecap': 'butt' });
    svg.append(arc);
    offset += len;
  });

  const putPct = putTotal / total * 100;
  const longPct = longs.reduce((s, h) => s + (h.value_thousands || 0), 0) / total * 100;
  const centerVal = putTotal > 0 ? putPct.toFixed(0) + '%' : longPct.toFixed(0) + '%';
  const centerLab = putTotal > 0 ? 'PUT EXP.' : 'LONG EXP.';

  const tv = svgEl('text', { x: CX, y: CY + 2, 'text-anchor': 'middle', 'font-family': 'JetBrains Mono,monospace', 'font-size': '16', 'font-weight': '700', fill: '#e6edf3' });
  tv.textContent = centerVal;
  const tl = svgEl('text', { x: CX, y: CY + 14, 'text-anchor': 'middle', 'font-family': 'Inter,sans-serif', 'font-size': '8', fill: '#8b949e' });
  tl.textContent = centerLab;
  svg.append(tv, tl);

  document.getElementById('donut-svg').innerHTML = '';
  document.getElementById('donut-svg').appendChild(svg);

  document.getElementById('donut-legend').innerHTML = segs.map(seg =>
    `<div class="legend-item">
      <div class="legend-dot" style="background:${seg.color}"></div>
      <span class="legend-label">${seg.label}</span>
      <span class="legend-pct">${(seg.val / total * 100).toFixed(1)}%</span>
    </div>`
  ).join('');
}

function renderTopMovers(q) {
  const hs = (state.holdingsByQuarter[q] || []);
  const active  = hs.filter(h => h.qoq_status !== 'exited' && h.qoq_status !== 'new' && (h.qoq_value_delta || 0) !== 0);
  const newOnes = hs.filter(h => h.qoq_status === 'new').slice(0, 3);
  const gainers = active.filter(h => (h.qoq_value_delta || 0) > 0).sort((a, b) => (b.qoq_value_delta || 0) - (a.qoq_value_delta || 0)).slice(0, 4);
  const losers  = active.filter(h => (h.qoq_value_delta || 0) < 0).sort((a, b) => (a.qoq_value_delta || 0) - (b.qoq_value_delta || 0)).slice(0, 3);

  let html = '';

  if (newOnes.length) {
    html += `<div class="movers-divider">★ New Positions</div>`;
    html += newOnes.map(h => `
      <div class="mover-row" data-cusip="${h.cusip}" style="cursor:pointer">
        <span class="mover-ticker">${h.ticker || '—'}</span>
        <span class="mover-name">${h.display_name || h.name_of_issuer || '—'}</span>
        <span class="mover-delta up">${fmt.usd((h.value_thousands || 0) * 1000)}</span>
      </div>`).join('');
  }

  if (gainers.length) {
    html += `<div class="movers-divider">▲ Increased</div>`;
    html += gainers.map(h => {
      const prevV = (h.value_thousands || 0) - (h.qoq_value_delta || 0);
      const pctCh = prevV > 0 ? (((h.qoq_value_delta || 0) / prevV) * 100).toFixed(1) : '0.0';
      return `<div class="mover-row" data-cusip="${h.cusip}" style="cursor:pointer">
        <span class="mover-ticker">${h.ticker || '—'}</span>
        <span class="mover-name">${h.display_name || h.name_of_issuer || '—'}</span>
        <span class="mover-delta up">+${pctCh}%</span>
      </div>`;
    }).join('');
  }

  if (losers.length) {
    html += `<div class="movers-divider">▼ Decreased</div>`;
    html += losers.map(h => {
      const prevV = (h.value_thousands || 0) - (h.qoq_value_delta || 0);
      const pctCh = prevV > 0 ? (((h.qoq_value_delta || 0) / prevV) * 100).toFixed(1) : '0.0';
      return `<div class="mover-row" data-cusip="${h.cusip}" style="cursor:pointer">
        <span class="mover-ticker">${h.ticker || '—'}</span>
        <span class="mover-name">${h.display_name || h.name_of_issuer || '—'}</span>
        <span class="mover-delta down">${pctCh}%</span>
      </div>`;
    }).join('');
  }

  if (!html) html = '<div style="color:var(--muted);font-size:12px;padding:8px 2px;">No significant moves this quarter.</div>';

  const container = document.getElementById('top-movers');
  container.innerHTML = html;
  container.querySelectorAll('[data-cusip]').forEach(row =>
    row.addEventListener('click', () => openDrawer(row.dataset.cusip))
  );
}

/* ══════════════════════════════════════════════
   SECTION 3 — FILING TIMELINE
══════════════════════════════════════════════ */

function renderFilingTimeline() {
  const filings = [...(state.filings || [])].sort((a, b) => b.period.localeCompare(a.period));
  const latestAcc = filings[0]?.accession_number;

  if (!filings.length) {
    document.getElementById('filing-timeline').innerHTML = '<div class="loading-msg">No filings found.</div>';
    return;
  }

  document.getElementById('filing-timeline').innerHTML = filings.map(f => {
    const isLatest = f.accession_number === latestAcc;
    const val = f.total_value_thousands ? fmt.usd(f.total_value_thousands * 1000) : '—';
    return `<div class="timeline-row${isLatest ? ' latest' : ''}">
      <div class="timeline-quarter">${f.quarter || f.period}${isLatest ? '<span class="latest-chip">LATEST</span>' : ''}</div>
      <div class="timeline-date">Filed ${fmt.date(f.filed_date)}</div>
      <div class="timeline-count">${f.num_holdings ?? '—'} pos.</div>
      <div class="timeline-value">${val}</div>
      <a class="edgar-link" href="${f.filing_url || '#'}" target="_blank" rel="noopener">View on EDGAR →</a>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════
   DETAIL DRAWER
══════════════════════════════════════════════ */

function openDrawer(cusip) {
  const quarters = sortedQuarters(state.holdingsByQuarter);
  const history = quarters.map(q => {
    const h = (state.holdingsByQuarter[q] || []).find(h => h.cusip === cusip);
    return h ? { quarter: q, ...h } : null;
  }).filter(Boolean);

  if (!history.length) return;
  const latest = history[history.length - 1];
  const name   = latest.display_name || latest.name_of_issuer || latest.ticker || cusip;

  document.getElementById('drawer-company').textContent = name;
  document.getElementById('drawer-sub').textContent = `CUSIP: ${cusip}${latest.ticker ? '  ·  ' + latest.ticker : ''}  ·  ${holdingType(latest).toUpperCase()}`;

  const active = history.filter(h => (h.value_thousands || 0) > 0);
  const latestActive = active[active.length - 1] || latest;

  const drawerBody = document.getElementById('drawer-body');
  drawerBody.innerHTML = '';

  // Stat cards
  const statsGrid = el('div', { className: 'drawer-stats' });
  [
    { label: 'Latest Value',   value: fmt.usd((latestActive.value_thousands || 0) * 1000) },
    { label: 'Shares',         value: fmt.shares(latestActive.shares || 0) },
    { label: '% Portfolio',    value: fmt.pct(latestActive.pct_of_portfolio || 0) },
    { label: 'Quarters Held',  value: active.length },
  ].forEach(s => {
    const card = el('div', { className: 'drawer-stat' });
    card.appendChild(el('div', { className: 'drawer-stat-label', textContent: s.label }));
    card.appendChild(el('div', { className: 'drawer-stat-value', textContent: s.value }));
    statsGrid.appendChild(card);
  });
  drawerBody.appendChild(statsGrid);

  // Sparkline
  const sparkTitle = el('div', { className: 'drawer-section-title', textContent: 'Value Over Time' });
  drawerBody.appendChild(sparkTitle);

  const sparkData = quarters.map(q => {
    const h = (state.holdingsByQuarter[q] || []).find(h => h.cusip === cusip);
    return { q, v: h ? (h.value_thousands || 0) * 1000 : 0 };
  });
  drawerBody.appendChild(renderSparkline(sparkData));

  // History table
  const histTitle = el('div', { className: 'drawer-section-title', textContent: 'Quarter History' });
  drawerBody.appendChild(histTitle);

  const table = el('table');
  table.innerHTML = `<thead><tr><th>Quarter</th><th>Shares</th><th>Value</th><th>% Port.</th></tr></thead>`;
  const tbody = el('tbody');
  [...history].reverse().forEach(h => {
    const tr = el('tr');
    tr.innerHTML = `
      <td>${fmt.quarter(h.quarter)}</td>
      <td class="mono-cell">${fmt.shares(h.shares || 0)}</td>
      <td class="mono-cell">${fmt.usd((h.value_thousands || 0) * 1000)}</td>
      <td class="mono-cell">${fmt.pct(h.pct_of_portfolio || 0)}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  drawerBody.appendChild(table);

  document.getElementById('drawer-backdrop').classList.add('open');
  document.getElementById('drawer').classList.add('open');
}

function closeDrawer() {
  document.getElementById('drawer-backdrop').classList.remove('open');
  document.getElementById('drawer').classList.remove('open');
}

function renderSparkline(data) {
  const W = 452, H = 100, pL = 10, pR = 442, pT = 14, pB = 80;
  const pH = pB - pT;
  const vals = data.map(d => d.v);
  const maxV = Math.max(...vals, 1);
  const n = data.length;

  const svg = svgEl('svg', { width: '100%', viewBox: `0 0 ${W} ${H + 20}`, preserveAspectRatio: 'xMidYMid meet' });

  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'sparkGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    svgEl('stop', { offset: '0%', 'stop-color': '#8957e5', 'stop-opacity': '0.4' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#8957e5', 'stop-opacity': '0' })
  );
  defs.append(grad); svg.append(defs);

  const xFor = i => pL + (n > 1 ? (i / (n - 1)) * (pR - pL) : (pR - pL) / 2);
  const yFor = v => pB - (v / maxV) * pH;
  const pts = data.map((d, i) => [xFor(i), yFor(d.v)]);
  const polyPts = pts.map(p => p.join(',')).join(' ');

  const areaPath = `M${pts[0][0]},${pB} ` + pts.map(p => `L${p[0]},${p[1]}`).join(' ') + ` L${pts[pts.length-1][0]},${pB} Z`;
  svg.append(svgEl('path', { d: areaPath, fill: 'url(#sparkGrad)' }));
  svg.append(svgEl('polyline', { points: polyPts, fill: 'none', stroke: '#8957e5', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  data.forEach((d, i) => {
    if (d.v > 0) {
      svg.append(svgEl('circle', { cx: pts[i][0], cy: pts[i][1], r: '3', fill: '#8957e5', stroke: '#161b22', 'stroke-width': '1.5' }));
    }
    const ql = svgEl('text', { x: pts[i][0], y: pB + 16, 'text-anchor': 'middle', 'font-size': '8', 'font-family': 'JetBrains Mono,monospace', fill: '#8b949e' });
    ql.textContent = fmt.quarter(d.q);
    svg.append(ql);
  });

  return svg;
}

/* ══════════════════════════════════════════════
   FILTERS
══════════════════════════════════════════════ */

function wireFilters() {
  document.getElementById('holdings-search').addEventListener('input', e => {
    state.searchQ = e.target.value;
    renderHoldings(state.selectedQuarter);
  });

  document.querySelectorAll('#type-filter .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#type-filter .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.typeFilter = btn.dataset.type;
      renderHoldings(state.selectedQuarter);
    });
  });

  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
}

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */

async function init() {
  try {
    await loadData();
  } catch (e) {
    document.getElementById('holdings-tbody').innerHTML =
      `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:48px;">⚠️ Failed to load data: ${e.message}</td></tr>`;
    return;
  }

  // Nav last-updated
  if (state.meta.last_updated) {
    const d = new Date(state.meta.last_updated);
    document.getElementById('nav-updated').textContent =
      'Last updated: ' + d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  state.selectedQuarter = state.meta.latest_quarter || sortedQuarters(state.holdingsByQuarter).slice(-1)[0];

  buildDropdown();

  // Trends (all-quarters)
  renderAumChart();
  renderExposureChart();
  renderPositionChart();
  renderTrendStats();

  // Quarter snapshot
  renderSnapshot();

  // Filing timeline
  renderFilingTimeline();

  // Wire interactive elements
  wireFilters();
}

init();
