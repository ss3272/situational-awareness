#!/usr/bin/env python3
"""
Aggregates raw holding data into dashboard-ready JSON files.
Reads: holdings_by_quarter.json, cusip_map.json, filings.json
Writes: latest_holdings.json, meta.json (updates)
"""

import json
import datetime
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"


def quarter_sort_key(q: str) -> tuple:
    year, qnum = q.split("-Q")
    return (int(year), int(qnum))


def enrich_holding(h: dict, cusip_map: dict) -> dict:
    cusip = h.get("cusip", "")
    figi = cusip_map.get(cusip, {})
    ticker = figi.get("ticker", "") or ""
    name = figi.get("name", "") or h.get("name_of_issuer", "")
    return {
        **h,
        "ticker": ticker,
        "display_name": name or h.get("name_of_issuer", cusip),
        "value_usd": h["value_thousands"] * 1000,
    }


def compute_pct_of_portfolio(holdings: list[dict]) -> list[dict]:
    total = sum(h["value_thousands"] for h in holdings)
    if total == 0:
        return holdings
    for h in holdings:
        h["pct_of_portfolio"] = round(h["value_thousands"] / total * 100, 2)
    return holdings


def compute_qoq(current: list[dict], previous: list[dict]) -> list[dict]:
    prev_by_cusip = {h["cusip"]: h for h in previous}
    for h in current:
        prev = prev_by_cusip.get(h["cusip"])
        if prev is None:
            h["qoq_status"] = "new"
            h["qoq_shares_delta"] = h["shares"]
            h["qoq_value_delta"] = h["value_thousands"]
        else:
            h["qoq_status"] = "unchanged"
            h["qoq_shares_delta"] = h["shares"] - prev["shares"]
            h["qoq_value_delta"] = h["value_thousands"] - prev["value_thousands"]
            if h["qoq_shares_delta"] != 0:
                h["qoq_status"] = "changed"

    # Mark exited positions
    current_cusips = {h["cusip"] for h in current}
    exited = []
    for prev in previous:
        if prev["cusip"] not in current_cusips:
            exited.append({
                **prev,
                "qoq_status": "exited",
                "qoq_shares_delta": -prev["shares"],
                "qoq_value_delta": -prev["value_thousands"],
                "shares": 0,
                "value_thousands": 0,
                "value_usd": 0,
                "pct_of_portfolio": 0,
            })
    return current + exited


def main():
    cusip_map: dict = json.loads((DATA_DIR / "cusip_map.json").read_text())
    holdings_by_quarter: dict = json.loads((DATA_DIR / "holdings_by_quarter.json").read_text())
    filings: list = json.loads((DATA_DIR / "filings.json").read_text())
    meta: dict = json.loads((DATA_DIR / "meta.json").read_text())

    if not holdings_by_quarter:
        print("No holdings data yet. Run fetch_filings.py first.")
        return

    sorted_quarters = sorted(holdings_by_quarter.keys(), key=quarter_sort_key)
    print(f"Building data for {len(sorted_quarters)} quarters: {sorted_quarters[0]} → {sorted_quarters[-1]}")

    # Build enriched holdings for all quarters
    enriched_by_quarter = {}
    for i, quarter in enumerate(sorted_quarters):
        raw = holdings_by_quarter[quarter]
        enriched = [enrich_holding(h, cusip_map) for h in raw]
        enriched = sorted(enriched, key=lambda h: h["value_thousands"], reverse=True)
        enriched = compute_pct_of_portfolio(enriched)
        if i > 0:
            prev_quarter = sorted_quarters[i - 1]
            prev_enriched = enriched_by_quarter[prev_quarter]
            enriched = compute_qoq(enriched, prev_enriched)
        else:
            for h in enriched:
                h["qoq_status"] = "new"
                h["qoq_shares_delta"] = h["shares"]
                h["qoq_value_delta"] = h["value_thousands"]
        enriched_by_quarter[quarter] = enriched

    # Write latest_holdings.json
    latest_quarter = sorted_quarters[-1]
    latest = enriched_by_quarter[latest_quarter]
    latest_output = {
        "quarter": latest_quarter,
        "generated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_value_usd": sum(h["value_thousands"] for h in latest if h.get("qoq_status") != "exited") * 1000,
        "num_holdings": sum(1 for h in latest if h.get("qoq_status") != "exited"),
        "holdings": latest,
    }
    (DATA_DIR / "latest_holdings.json").write_text(json.dumps(latest_output, indent=2))
    print(f"Wrote latest_holdings.json ({len(latest)} positions in {latest_quarter})")

    # Write enriched holdings_by_quarter.json (overwrite with enriched version)
    (DATA_DIR / "holdings_by_quarter.json").write_text(json.dumps(enriched_by_quarter, indent=2))

    # Build chart data: top 10 by latest value, tracked across quarters
    top_cusips = [h["cusip"] for h in latest if h.get("qoq_status") != "exited"][:10]
    chart_series = {}
    for cusip in top_cusips:
        # Find display name
        name = cusip_map.get(cusip, {}).get("ticker", "") or cusip
        series = []
        for quarter in sorted_quarters:
            qdata = enriched_by_quarter[quarter]
            match = next((h for h in qdata if h["cusip"] == cusip), None)
            series.append({
                "quarter": quarter,
                "value_usd": match["value_usd"] if match else 0,
                "shares": match["shares"] if match else 0,
            })
        chart_series[cusip] = {"label": name, "data": series}

    # Update meta
    meta["last_updated"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    meta["latest_quarter"] = latest_quarter
    meta["total_filing_count"] = len(filings)
    meta["chart_series"] = chart_series
    meta["quarters"] = sorted_quarters
    (DATA_DIR / "meta.json").write_text(json.dumps(meta, indent=2))

    print("Done. Dashboard data is ready.")


if __name__ == "__main__":
    main()
