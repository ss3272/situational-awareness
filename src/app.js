'use strict';

const BASE = window.location.pathname.includes('/rbm-emulator') ? '/rbm-emulator' : '.';
const NS = 'http://www.w3.org/2000/svg';

async function loadJSON(p) {
  const r = await fetch(`${BASE}/data/${p}`);
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
}

const fmt = {
  usd(v) {
    if (v >= 1e12) return `$${(v/1e12).toFixed(2)}T`;
    if (v >= 1e9)  return `$${(v/1e9).toFixed(2)}B`;
    if (v >= 1e6)  return `$${(v/1e6).toFixed(1)}M`;
    if (v >= 1e3)  return `$${(v/1e3).toFixed(0)}K`;
    return `$${v.toLocaleString()}`;
  },
  usdB(v) { return `$${(v/1e9).toFixed(2)}B`; },
  shares(v) {
    if (!v) return '—';
    if (Math.abs(v) >= 1e6) return `${(v/1e6).toFixed(1)}M sh`;
    if (Math.abs(v) >= 1e3) return `${(v/1e3).toFixed(0)}K sh`;
    return v.toLocaleString();
  },
  pct(v) { return `${v.toFixed(2)}%`; },
};

function holdingType(h) {
  const pc = (h.put_call || '').toLowerCase();
  if (pc === 'put')  return 'put';
  if (pc === 'call') return 'call';
  return 'long';
}

let S = {
  meta: null, latestHoldings: null, holdingsByQuarter: null, filings: null,
  quarter: null, typeFilter: 'all', searchQ: '',
};

async function boot() {
  try {
    [S.meta, S.latestHoldings, S.holdingsByQuarter, S.filings] = await Promise.all([
      loadJSON('meta.json'), loadJSON('latest_holdings.json'),
      loadJSON('holdings_by_quarter.json'), loadJSON('filings.json'),
    ]);
  } catch(e) {
    document.getElementById('holdings-body').innerHTML =
      `<tr><td colspan="7" class="empty-msg">No data yet — ${e.message}</td></tr>`;
    return;
  }

  S.quarter = S.meta.latest_quarter;

  const upd = S.meta.last_updated
    ? new Date(S.meta.last_updated).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
    : 'Never';
  document.getElementById('nav-updated').textContent = `Last updated: ${upd}`;

  buildQuarterTabs();
  renderStats();
  renderHoldings();
  renderDonut();
  renderBarChart();
  renderTimeline();
  bindEvents();
}

function buildQuarterTabs() {
  const quarters = Object.keys(S.holdingsByQuarter)
    .filter(q => /^\d{4}-Q\d$/.test(q))
    .sort((a,b) => a.localeCompare(b));

  const container = document.getElementById('qtabs');
  container.innerHTML = '';
  quarters.forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'qtab' + (q === S.quarter ? ' active' : '');
    btn.textContent = q.replace('-Q', ' Q').replace(/(\d{4}) Q(\d)/, (_, y, n) => `Q${n} ${y}`);
    btn.dataset.q = q;
    btn.addEventListener('click', () => switchQuarter(q));
    container.appendChild(btn);
  });
}

function switchQuarter(q) {
  S.quarter = q;
  document.querySelectorAll('.qtab').forEach(b => b.classList.toggle('active', b.dataset.q === q));
  renderStats();
  renderHoldings();
  renderDonut();
}

function getQHoldings(q) {
  return (S.holdingsByQuarter[q] || []).filter(h => h.qoq_status !== 'exited');
}

function prevQuarter(q) {
  const qs = Object.keys(S.holdingsByQuarter).filter(x => /^\d{4}-Q\d$/.test(x)).sort();
  const idx = qs.indexOf(q);
  return idx > 0 ? qs[idx - 1] : null;
}

function renderStats() {
  const holdings = getQHoldings(S.quarter);
  const total = holdings.reduce((s,h) => s + (h.value_thousands||0), 0) * 1000;

  const prev = prevQuarter(S.quarter);
  const prevHoldings = prev ? getQHoldings(prev) : [];
  const prevTotal = prevHoldings.reduce((s,h) => s + (h.value_thousands||0), 0) * 1000;

  // Value card
  document.getElementById('s-value').textContent = fmt.usd(total);
  const valDelta = document.getElementById('s-value-delta');
  if (prev && prevTotal > 0) {
    const pct = ((total - prevTotal) / prevTotal * 100);
    valDelta.style.display = '';
    valDelta.textContent = (pct >= 0 ? '▲ +' : '▼ ') + pct.toFixed(1) + '% QoQ';
    valDelta.className = 'kdelta ' + (pct >= 0 ? 'up' : 'down');
  } else { valDelta.style.display = 'none'; }

  // Holdings count
  document.getElementById('s-count').textContent = holdings.length;
  document.getElementById('s-count-sub').textContent = `Positions (${S.quarter})`;
  const cntDelta = document.getElementById('s-count-delta');
  if (prev) {
    const diff = holdings.length - prevHoldings.length;
    cntDelta.style.display = '';
    cntDelta.textContent = (diff >= 0 ? '▲ +' : '▼ ') + diff + ` vs ${prev}`;
    cntDelta.className = 'kdelta ' + (diff >= 0 ? 'up' : 'down');
  } else { cntDelta.style.display = 'none'; }

  // Largest long
  const longs = holdings.filter(h => holdingType(h) === 'long').sort((a,b) => (b.value_thousands||0)-(a.value_thousands||0));
  const largest = longs[0];
  if (largest) {
    const name = largest.ticker || largest.display_name || largest.name_of_issuer || '—';
    const ticker = largest.ticker ? ` <span style="color:var(--muted);font-size:15px">(${largest.ticker})</span>` : '';
    document.getElementById('s-largest').innerHTML =
      (largest.display_name && largest.display_name !== largest.ticker ? largest.display_name : name) + ticker;
    document.getElementById('s-largest-sub').textContent =
      `${fmt.usd((largest.value_thousands||0)*1000)} · ${(largest.pct_of_portfolio||0).toFixed(2)}% of portfolio`;
    renderSparkline(largest.cusip);
  }

  // Short/Put exposure
  const puts = holdings.filter(h => holdingType(h) === 'put');
  const putTotal = puts.reduce((s,h) => s + (h.value_thousands||0), 0) * 1000;
  document.getElementById('s-put').textContent = fmt.usd(putTotal);
  const putPctEl = document.getElementById('s-put-pct');
  if (total > 0 && putTotal > 0) {
    const pp = (putTotal / total * 100).toFixed(0);
    putPctEl.style.display = '';
    putPctEl.textContent = `${pp}% of book`;
    putPctEl.className = 'kdelta warn';
  } else { putPctEl.style.display = 'none'; }
}

function renderSparkline(cusip) {
  const svg = document.getElementById('spark');
  svg.innerHTML = '';
  const qs = Object.keys(S.holdingsByQuarter).filter(q => /^\d{4}-Q\d$/.test(q)).sort();
  const vals = qs.map(q => {
    const h = (S.holdingsByQuarter[q]||[]).find(h => h.cusip === cusip);
    return h ? (h.shares||0) : 0;
  }).filter((v,i,a) => { const first = a.findIndex(x => x > 0); return i >= first; });
  if (vals.length < 2) return;
  const W=220, H=34, pad=3;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const range = mx - mn || 1;
  const pts = vals.map((v,i) => [
    pad + (i/(vals.length-1))*(W-2*pad),
    H-pad - ((v-mn)/range)*(H-2*pad)
  ]);
  const poly = pts.map(p=>p.join(',')).join(' ');
  const area = document.createElementNS(NS,'polygon');
  area.setAttribute('points', `${pad},${H-pad} ${poly} ${pts[pts.length-1][0]},${H-pad}`);
  area.setAttribute('fill','rgba(110,64,201,0.18)');
  svg.appendChild(area);
  const line = document.createElementNS(NS,'polyline');
  line.setAttribute('points', poly); line.setAttribute('fill','none');
  line.setAttribute('stroke','#8957e5'); line.setAttribute('stroke-width','2');
  line.setAttribute('stroke-linecap','round'); line.setAttribute('stroke-linejoin','round');
  svg.appendChild(line);
  const last = pts[pts.length-1];
  const dot = document.createElementNS(NS,'circle');
  dot.setAttribute('cx',last[0]); dot.setAttribute('cy',last[1]); dot.setAttribute('r','3');
  dot.setAttribute('fill','#8957e5'); dot.setAttribute('stroke','#161b22'); dot.setAttribute('stroke-width','1.5');
  svg.appendChild(dot);
}

function filteredHoldings() {
  let rows = (S.holdingsByQuarter[S.quarter] || []).slice();
  if (S.typeFilter !== 'all') rows = rows.filter(h => holdingType(h) === S.typeFilter);
  if (S.searchQ) {
    const q = S.searchQ.toLowerCase();
    rows = rows.filter(h =>
      (h.ticker||'').toLowerCase().includes(q) ||
      (h.display_name||'').toLowerCase().includes(q) ||
      (h.name_of_issuer||'').toLowerCase().includes(q)
    );
  }
  return rows;
}

function renderHoldings() {
  document.getElementById('holdings-qtag').textContent = S.quarter || '—';
  const tbody = document.getElementById('holdings-body');
  const rows = filteredHoldings();

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">No positions found.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(h => {
    const type = holdingType(h);
    const isExited = h.qoq_status === 'exited';
    const typePill = `<span class="type-pill type-${type}">${type.toUpperCase()}</span>`;

    const size = type === 'long' && h.shares ? fmt.shares(h.shares) : '—';

    let qoqHtml;
    if (h.qoq_status === 'new') {
      qoqHtml = '<span class="new-badge">★ NEW</span>';
    } else if (isExited) {
      qoqHtml = '<span class="exited-badge">EXITED</span>';
    } else if (h.qoq_shares_delta && h.qoq_shares_delta !== 0) {
      const pct = h.qoq_value_delta && h.value_thousands > 0
        ? ((h.qoq_value_delta / (h.value_thousands - h.qoq_value_delta)) * 100)
        : 0;
      const sign = pct >= 0 ? '▲ +' : '▼ ';
      const cls = pct >= 0 ? 'green' : 'red';
      qoqHtml = `<span class="qoq ${cls}">${sign}${Math.abs(pct).toFixed(1)}%</span>`;
    } else {
      qoqHtml = '<span class="qoq muted">—</span>';
    }

    const portPct = h.pct_of_portfolio || 0;
    const portBar = `<span class="portbar"><span class="portbar-fill" style="width:${Math.min(portPct*3,100)}%"></span></span>`;

    return `<tr class="${isExited?'exited-row':''}" data-cusip="${h.cusip}">
      <td><span class="tk">${h.ticker||'—'}</span></td>
      <td class="co">${h.display_name||h.name_of_issuer||'—'}</td>
      <td>${typePill}</td>
      <td class="num">${size}</td>
      <td class="num">${fmt.usd((h.value_thousands||0)*1000)}</td>
      <td class="num">${portPct ? fmt.pct(portPct) : '—'}${portBar}</td>
      <td class="num">${qoqHtml}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-cusip]').forEach(tr =>
    tr.addEventListener('click', () => openDrawer(tr.dataset.cusip))
  );
}

function renderDonut() {
  const holdings = getQHoldings(S.quarter);
  const total = holdings.reduce((s,h) => s + (h.value_thousands||0), 0);
  if (!total) return;

  const groups = {};
  holdings.forEach(h => {
    const type = holdingType(h);
    const key = type === 'long'
      ? (h.ticker || h.display_name || 'Long')
      : type === 'put' ? 'Puts' : 'Calls';
    groups[key] = (groups[key]||0) + (h.value_thousands||0);
  });

  // Bucket: Puts, Calls, top 3 longs, Other Longs
  const putTotal  = holdings.filter(h=>holdingType(h)==='put').reduce((s,h)=>s+(h.value_thousands||0),0);
  const callTotal = holdings.filter(h=>holdingType(h)==='call').reduce((s,h)=>s+(h.value_thousands||0),0);
  const longsSorted = holdings.filter(h=>holdingType(h)==='long').sort((a,b)=>(b.value_thousands||0)-(a.value_thousands||0));
  const topLongs = longsSorted.slice(0,3);
  const otherLong = longsSorted.slice(3).reduce((s,h)=>s+(h.value_thousands||0),0);

  const COLORS = ['#f85149','#58a6ff','#8957e5','#3fb950','#f4c542','#e3934d','#76e4f7'];
  const segments = [
    putTotal  > 0 ? { label:'Put Options',   val:putTotal,  color:'#f85149' } : null,
    callTotal > 0 ? { label:'Call Options',  val:callTotal, color:'#58a6ff' } : null,
    ...topLongs.map((h,i) => ({ label: h.ticker||h.display_name||'Long', val:h.value_thousands||0, color:COLORS[2+i] })),
    otherLong > 0 ? { label:'Other Longs',  val:otherLong, color:'#6e7681' } : null,
  ].filter(Boolean);

  const svg = document.getElementById('donut');
  svg.innerHTML = '';
  const cx=75, cy=75, r=54, sw=20;
  const C = 2*Math.PI*r;

  const track = document.createElementNS(NS,'circle');
  track.setAttribute('cx',cx); track.setAttribute('cy',cy); track.setAttribute('r',r);
  track.setAttribute('fill','none'); track.setAttribute('stroke','#21262d'); track.setAttribute('stroke-width',sw);
  svg.appendChild(track);

  let offset=0;
  segments.forEach(seg => {
    const pct = seg.val/total;
    const len = pct*C;
    const el = document.createElementNS(NS,'circle');
    el.setAttribute('cx',cx); el.setAttribute('cy',cy); el.setAttribute('r',r);
    el.setAttribute('fill','none'); el.setAttribute('stroke',seg.color); el.setAttribute('stroke-width',sw);
    el.setAttribute('stroke-dasharray',`${len} ${C-len}`);
    el.setAttribute('stroke-dashoffset', -offset);
    el.setAttribute('transform',`rotate(-90 ${cx} ${cy})`);
    el.setAttribute('stroke-linecap','butt');
    svg.appendChild(el);
    offset += len;
  });

  // Center label — put % or long %
  const putPct = putTotal/total*100;
  const centerVal = putTotal > 0 ? `${putPct.toFixed(0)}%` : `${((longsSorted.reduce((s,h)=>s+(h.value_thousands||0),0)/total)*100).toFixed(0)}%`;
  const centerLab = putTotal > 0 ? 'PUT EXPOSURE' : 'LONG EXPOSURE';

  const tv = document.createElementNS(NS,'text');
  tv.setAttribute('x',cx); tv.setAttribute('y',cy+1); tv.setAttribute('text-anchor','middle');
  tv.setAttribute('class','donut-center-val'); tv.textContent = centerVal;
  svg.appendChild(tv);
  const tl = document.createElementNS(NS,'text');
  tl.setAttribute('x',cx); tl.setAttribute('y',cy+14); tl.setAttribute('text-anchor','middle');
  tl.setAttribute('class','donut-center-lab'); tl.textContent = centerLab;
  svg.appendChild(tl);

  const legend = document.getElementById('donut-legend');
  legend.innerHTML = segments.map(seg => `
    <div class="legend-row">
      <span class="legend-dot" style="background:${seg.color}"></span>
      <span class="legend-label">${seg.label}</span>
      <span class="legend-pct">${(seg.val/total*100).toFixed(1)}%</span>
    </div>`).join('');
}

function renderBarChart() {
  const filings = [...(S.filings||[])].sort((a,b)=>a.period.localeCompare(b.period));
  if (!filings.length) return;

  const barData = filings.map(f => ({
    q: f.quarter || f.period,
    val: (f.total_value_thousands||0) * 1000,
  }));

  const maxVal = Math.max(...barData.map(b=>b.val), 1);
  const maxB = Math.ceil(maxVal/1e9) * 1e9; // round up to next billion

  const svg = document.getElementById('barchart');
  svg.innerHTML = '';
  const BW=560, BH=200, pL=46, pR=548, pT=18, pB=172;
  const pH = pB - pT;
  const yFor = v => pB - (v/maxB)*pH;

  // defs gradient
  const defs = document.createElementNS(NS,'defs');
  defs.innerHTML = '<linearGradient id="bGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#8957e5"/><stop offset="100%" stop-color="#6e40c9"/></linearGradient>';
  svg.appendChild(defs);

  // y-axis gridlines
  const steps = 4;
  for (let i=0; i<=steps; i++) {
    const v = (maxB/steps)*i;
    const y = yFor(v);
    const ln = document.createElementNS(NS,'line');
    ln.setAttribute('x1',pL); ln.setAttribute('x2',pR);
    ln.setAttribute('y1',y); ln.setAttribute('y2',y);
    ln.setAttribute('stroke','#21262d'); ln.setAttribute('stroke-width','1');
    svg.appendChild(ln);
    if (i > 0) {
      const t = document.createElementNS(NS,'text');
      t.setAttribute('x',pL-6); t.setAttribute('y',y+3); t.setAttribute('text-anchor','end');
      t.setAttribute('fill','#8b949e'); t.setAttribute('font-size','9');
      t.setAttribute('font-family','var(--mono)');
      t.textContent = `$${(v/1e9).toFixed(0)}B`;
      svg.appendChild(t);
    }
  }

  const n = barData.length;
  const slot = (pR-pL)/n;
  const bw = Math.min(slot*0.55, 52);
  const isLatest = i => i === n-1;

  barData.forEach((b,i) => {
    const cx = pL + slot*i + slot/2;
    const fullH = (b.val/maxB)*pH;
    const rect = document.createElementNS(NS,'rect');
    rect.setAttribute('x', cx-bw/2);
    rect.setAttribute('width', bw);
    rect.setAttribute('rx','5');
    rect.setAttribute('fill', isLatest(i) ? 'url(#bGrad)' : 'rgba(110,64,201,0.45)');
    rect.setAttribute('y', pB - Math.max(fullH,2));
    rect.setAttribute('height', Math.max(fullH,2));
    svg.appendChild(rect);

    const vl = document.createElementNS(NS,'text');
    vl.setAttribute('x',cx); vl.setAttribute('y', pB - Math.max(fullH,2) - 6);
    vl.setAttribute('text-anchor','middle'); vl.setAttribute('font-size','10');
    vl.setAttribute('font-weight','600'); vl.setAttribute('font-family','var(--mono)');
    vl.setAttribute('fill', isLatest(i) ? '#f4c542' : '#8b949e');
    vl.textContent = b.val >= 1e9 ? `$${(b.val/1e9).toFixed(2)}B` : b.val >= 1e6 ? `$${(b.val/1e6).toFixed(0)}M` : '—';
    svg.appendChild(vl);

    const ql = document.createElementNS(NS,'text');
    ql.setAttribute('x',cx); ql.setAttribute('y', pB+18);
    ql.setAttribute('text-anchor','middle'); ql.setAttribute('font-size','10');
    ql.setAttribute('font-family','var(--mono)'); ql.setAttribute('fill','#8b949e');
    ql.textContent = (b.q||'').replace('-Q',' Q').replace(/(\d{4}) Q(\d)/,(_,y,n)=>`Q${n} ${y}`);
    svg.appendChild(ql);
  });
}

function renderTimeline() {
  const filings = [...(S.filings||[])].sort((a,b)=>a.period.localeCompare(b.period));
  const container = document.getElementById('timeline');

  if (!filings.length) {
    container.innerHTML = '<div class="empty-msg">No filings found.</div>';
    return;
  }

  const latest = filings[filings.length-1];
  container.innerHTML = filings.map(f => {
    const isLat = f.accession_number === latest.accession_number;
    const val = f.total_value_thousands ? fmt.usd(f.total_value_thousands*1000) : '—';
    return `<div class="tl-row${isLat?' latest':''}">
      <div class="tl-q">${f.quarter||f.period} ${isLat?'<span class="latest-chip">LATEST</span>':''}</div>
      <div class="tl-meta">Filed ${f.filed_date||'—'}</div>
      <div class="tl-meta"><b>${f.num_holdings??'—'} holdings</b></div>
      <div class="tl-meta">Reported <b>${val}</b></div>
      <a class="edgar" href="${f.filing_url||'#'}" target="_blank" rel="noopener">View on EDGAR →</a>
    </div>`;
  }).reverse().join('');
}

function openDrawer(cusip) {
  const qs = Object.keys(S.holdingsByQuarter).filter(q=>/^\d{4}-Q\d$/.test(q)).sort();
  const history = qs.map(q => {
    const h = (S.holdingsByQuarter[q]||[]).find(h=>h.cusip===cusip);
    return h ? {quarter:q,...h} : {quarter:q,shares:0,value_thousands:0,pct_of_portfolio:0};
  });
  const withData = history.filter(h=>h.shares>0||h.value_thousands>0);
  if (!withData.length) return;

  const latest = withData[withData.length-1];
  const name = latest.display_name||latest.name_of_issuer||latest.ticker||cusip;

  document.getElementById('drawer-title').textContent = name;
  document.getElementById('drawer-cusip').textContent = `CUSIP: ${cusip}${latest.ticker?' · '+latest.ticker:''}`;
  document.getElementById('drawer-stats').innerHTML = `
    <div class="drawer-stat"><div class="drawer-stat-label">Shares</div><div class="drawer-stat-value">${fmt.shares(latest.shares||0)}</div></div>
    <div class="drawer-stat"><div class="drawer-stat-label">Market Value</div><div class="drawer-stat-value">${fmt.usd((latest.value_thousands||0)*1000)}</div></div>
    <div class="drawer-stat"><div class="drawer-stat-label">% Portfolio</div><div class="drawer-stat-value">${fmt.pct(latest.pct_of_portfolio||0)}</div></div>
    <div class="drawer-stat"><div class="drawer-stat-label">Quarters held</div><div class="drawer-stat-value">${withData.length}</div></div>`;

  // Sparkline
  const svg = document.getElementById('drawer-spark');
  svg.innerHTML = '';
  const vals = withData.map(h=>h.value_thousands||0);
  if (vals.length >= 2) {
    const W=332, H=110, pad=4;
    const mn=Math.min(...vals), mx=Math.max(...vals), range=mx-mn||1;
    const pts = vals.map((v,i) => [
      pad+(i/(vals.length-1))*(W-2*pad),
      H-pad-((v-mn)/range)*(H-2*pad)
    ]);
    const poly = pts.map(p=>p.join(',')).join(' ');
    const area = document.createElementNS(NS,'polygon');
    area.setAttribute('points',`${pad},${H-pad} ${poly} ${pts[pts.length-1][0]},${H-pad}`);
    area.setAttribute('fill','rgba(110,64,201,0.15)');
    svg.appendChild(area);
    const line = document.createElementNS(NS,'polyline');
    line.setAttribute('points',poly); line.setAttribute('fill','none');
    line.setAttribute('stroke','#8957e5'); line.setAttribute('stroke-width','2');
    line.setAttribute('stroke-linecap','round'); line.setAttribute('stroke-linejoin','round');
    svg.appendChild(line);
    const last=pts[pts.length-1];
    const dot = document.createElementNS(NS,'circle');
    dot.setAttribute('cx',last[0]); dot.setAttribute('cy',last[1]); dot.setAttribute('r','4');
    dot.setAttribute('fill','#8957e5'); dot.setAttribute('stroke','#161b22'); dot.setAttribute('stroke-width','2');
    svg.appendChild(dot);
  }

  document.getElementById('drawer-body').innerHTML = withData.map(h => `
    <tr>
      <td>${h.quarter}</td>
      <td class="num">${fmt.shares(h.shares||0)}</td>
      <td class="num">${fmt.usd((h.value_thousands||0)*1000)}</td>
      <td class="num">${h.pct_of_portfolio!=null?fmt.pct(h.pct_of_portfolio):'—'}</td>
    </tr>`).reverse().join('');

  document.getElementById('drawer-overlay').classList.add('open');
  document.getElementById('detail-drawer').classList.add('open');
}

function closeDrawer() {
  document.getElementById('drawer-overlay').classList.remove('open');
  document.getElementById('detail-drawer').classList.remove('open');
}

function bindEvents() {
  document.querySelectorAll('#type-seg button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#type-seg button').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      S.typeFilter = b.dataset.f;
      renderHoldings();
    });
  });

  document.getElementById('search-input').addEventListener('input', e => {
    S.searchQ = e.target.value;
    renderHoldings();
  });

  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);
}

boot();
