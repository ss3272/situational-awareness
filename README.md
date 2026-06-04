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

## Local Development

```bash
git clone https://github.com/ss3272/rbm-emulator.git
cd rbm-emulator
python scripts/fetch_filings.py
python scripts/resolve_tickers.py
python scripts/build_data.py
python -m http.server 8080 --directory src/
```

## GitHub Pages Setup

1. Go to **Settings → Pages**
2. Under **Source**, select **GitHub Actions**
3. Trigger the first run: **Actions → Update SEC 13F Data → Run workflow**

## Stack

| Layer | Tool |
|---|---|
| Data | SEC EDGAR (free) + OpenFIGI (free) |
| Storage | Flat JSON files in repo |
| Frontend | Vanilla HTML/CSS/JS + Chart.js (CDN) |
| Automation | GitHub Actions (daily cron) |
| Hosting | GitHub Pages |
| Scripts | Python 3.12 stdlib only |
