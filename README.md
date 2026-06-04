# Situational Awareness LP — SEC 13F Dashboard

A production-ready, self-updating dashboard tracking **Situational Awareness LP** (Leopold Aschenbrenner's fund) institutional stock holdings from SEC EDGAR 13F-HR filings.

## Live Dashboard

**https://ss3272.github.io/rbm-emulator/**

## Features

- **Historical Holdings** — All 13F-HR filings parsed and stored as flat JSON
- **Interactive Table** — Sortable, filterable by ticker/company; QoQ change highlighting
- **Historical Chart** — Top 10 positions tracked across all quarters
- **Portfolio Donut** — Composition view for the latest quarter
- **Position Drawer** — Click any row to see full history of that holding
- **Filing Timeline** — Every 13F on record with EDGAR links
- **Auto-updated daily** — GitHub Actions fetches new filings every morning at 7 AM UTC

## How It Works

```
SEC EDGAR (free API)
     │
     ▼
scripts/fetch_filings.py   ← auto-resolves CIK, delta-only fetch
     │
     ▼
scripts/parse_13f.py       ← parses 13F XML info tables
     │
     ▼
scripts/resolve_tickers.py ← CUSIP → ticker via OpenFIGI (free)
     │
     ▼
scripts/build_data.py      ← aggregates into dashboard JSON
     │
     ▼
data/*.json                ← committed to repo (flat-file DB)
     │
     ▼
src/index.html + app.js    ← static dashboard (Chart.js CDN)
     │
     ▼
GitHub Pages               ← deployed automatically
```

## Local Development

```bash
# Clone the repo
git clone https://github.com/ss3272/rbm-emulator.git
cd rbm-emulator

# Fetch all historical filings (first run — full backfill)
python scripts/fetch_filings.py

# Resolve CUSIP → ticker symbols
python scripts/resolve_tickers.py

# Build dashboard data
python scripts/build_data.py

# Serve locally
python -m http.server 8080 --directory src/
# Open http://localhost:8080
```

## Stack

| Layer | Tool |
|---|---|
| Data | SEC EDGAR (free, no key) + OpenFIGI (free, no key) |
| Storage | Flat JSON files committed to repo |
| Frontend | Vanilla HTML/CSS/JS + Chart.js (CDN) |
| Automation | GitHub Actions (cron daily) |
| Hosting | GitHub Pages |
| Scripts | Python 3.12 stdlib only (no pip installs) |

## GitHub Pages Setup

1. Go to **Settings → Pages**
2. Under **Source**, select **GitHub Actions**
3. Trigger the first run manually: **Actions → Update SEC 13F Data → Run workflow**

## Data Files

| File | Contents |
|---|---|
| `data/filings.json` | Index of every 13F filing (accession no, date, period) |
| `data/holdings_by_quarter.json` | All holdings per quarter, enriched with tickers |
| `data/latest_holdings.json` | Most recent quarter snapshot + QoQ deltas |
| `data/cusip_map.json` | Permanent CUSIP → ticker/name cache |
| `data/meta.json` | CIK, last updated, chart series data |

## SEC Fair Use

All requests to SEC EDGAR respect the 10 requests/second limit (0.11s delay between calls).
See [SEC EDGAR developer docs](https://www.sec.gov/developer).
