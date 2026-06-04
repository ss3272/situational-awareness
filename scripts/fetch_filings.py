#!/usr/bin/env python3
"""
Fetches 13F-HR filings for Situational Awareness LP from SEC EDGAR.
Uses only Python stdlib. Respects SEC fair-use rate limit (10 req/sec).
Delta-only: skips filings already present in data/filings.json.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"

HEADERS = {
    "User-Agent": "situational-awareness-dashboard saransh.mega@gmail.com",
    "Accept-Encoding": "identity",
}
REQUEST_DELAY = 0.15  # safely under SEC 10 req/sec limit

# Known filings to seed even if submissions API returns nothing.
# Format: (accession_with_dashes, period_end_date, filed_date, form_type)
SEED_FILINGS = [
    ("0002045724-26-000008", "2026-03-31", "2026-05-15", "13F-HR"),
]


def fetch(url: str, retries: int = 3) -> bytes:
    parsed = urllib.parse.urlparse(url)
    headers = {**HEADERS, "Host": parsed.netloc}
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited (429), waiting {wait}s...")
                time.sleep(wait)
            elif e.code == 404:
                raise
            else:
                print(f"  HTTP {e.code} for {url}, attempt {attempt+1}/{retries}")
                if attempt == retries - 1:
                    raise
                time.sleep(2 ** attempt)
        except urllib.error.URLError as e:
            print(f"  URLError for {url}: {e}, attempt {attempt+1}/{retries}")
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed to fetch {url} after {retries} attempts")


def resolve_cik() -> str:
    meta_path = DATA_DIR / "meta.json"
    meta = json.loads(meta_path.read_text())
    if meta.get("cik"):
        cik = str(meta["cik"]).zfill(10)
        print(f"Using cached CIK: {cik}")
        return cik
    print("ERROR: CIK not set in data/meta.json")
    sys.exit(1)


def get_filing_xml_url(cik_int: int, accession_raw: str) -> str | None:
    """Find the XML info table file URL within a filing index."""
    accession_nodash = accession_raw.replace("-", "")
    base = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}"
    idx_url = f"{base}/{accession_raw}-index.json"

    print(f"  Fetching index: {idx_url}")
    time.sleep(REQUEST_DELAY)
    try:
        data = fetch(idx_url)
        idx = json.loads(data)
    except Exception as e:
        print(f"  Could not fetch filing index for {accession_raw}: {e}")
        return _fallback_xml_url(base, accession_nodash)

    documents = idx.get("documents", [])
    print(f"  Filing index has {len(documents)} documents:")
    for doc in documents:
        print(f"    name={doc.get('name')!r}  type={doc.get('type')!r}")

    # Priority 1: type == "INFORMATION TABLE"
    for doc in documents:
        if doc.get("type", "").upper() == "INFORMATION TABLE":
            print(f"  Selected by type=INFORMATION TABLE: {doc['name']}")
            return f"{base}/{doc['name']}"

    # Priority 2: "infotable" in filename
    for doc in documents:
        if "infotable" in doc.get("name", "").lower():
            print(f"  Selected by infotable in name: {doc['name']}")
            return f"{base}/{doc['name']}"

    # Priority 3: any .xml that isn't the primary 13F-HR cover document
    cover_types = {"13F-HR", "13F-HR/A", "13F-NT", "13F-NT/A"}
    for doc in documents:
        name = doc.get("name", "")
        doc_type = doc.get("type", "").upper()
        if name.lower().endswith(".xml") and doc_type not in cover_types:
            print(f"  Selected by .xml not cover: {name}")
            return f"{base}/{name}"

    # Priority 4: any .xml
    for doc in documents:
        if doc.get("name", "").lower().endswith(".xml"):
            print(f"  Selected first .xml: {doc['name']}")
            return f"{base}/{doc['name']}"

    print(f"  No XML found in index, trying fallback names...")
    return _fallback_xml_url(base, accession_nodash)


def _fallback_xml_url(base: str, accession_nodash: str) -> str | None:
    """Try common XML info table filenames."""
    candidates = [
        "infotable.xml",
        "form13fInfoTable.xml",
        "informationtable.xml",
        "13fInfoTable.xml",
    ]
    for name in candidates:
        url = f"{base}/{name}"
        time.sleep(REQUEST_DELAY)
        try:
            fetch(url)
            print(f"  Fallback found: {name}")
            return url
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
        except Exception:
            pass
    return None


def collect_filings_from_submissions(cik_padded: str) -> list[dict]:
    """Fetch submission history and extract all 13F-HR filings."""
    subs_url = f"https://data.sec.gov/submissions/CIK{cik_padded}.json"
    print(f"\nFetching submissions: {subs_url}")
    time.sleep(REQUEST_DELAY)

    try:
        raw = fetch(subs_url)
    except Exception as e:
        print(f"  ERROR fetching submissions: {e}")
        return []

    subs_data = json.loads(raw)
    entity_name = subs_data.get("name", "")
    print(f"Entity name from EDGAR: {entity_name!r}")

    recent = subs_data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    filed_dates = recent.get("filingDate", [])
    periods = recent.get("reportDate", [])

    print(f"Total recent filings: {len(forms)}")
    print(f"Form types present: {sorted(set(forms))}")

    all_13f = []
    for i, form in enumerate(forms):
        if form in ("13F-HR", "13F-HR/A"):
            entry = {
                "form": form,
                "accession_number": accessions[i],
                "filed_date": filed_dates[i],
                "period": periods[i],
            }
            print(f"  Found 13F: {form} acc={accessions[i]} period={periods[i]}")
            all_13f.append(entry)

    # Also check paginated older filings
    older_files = subs_data.get("filings", {}).get("files", [])
    for older_ref in older_files:
        older_url = f"https://data.sec.gov/submissions/{older_ref['name']}"
        print(f"  Fetching older filings page: {older_ref['name']}")
        time.sleep(REQUEST_DELAY)
        try:
            older_data = json.loads(fetch(older_url))
            o_forms = older_data.get("form", [])
            o_accessions = older_data.get("accessionNumber", [])
            o_dates = older_data.get("filingDate", [])
            o_periods = older_data.get("reportDate", [])
            for i, form in enumerate(o_forms):
                if form in ("13F-HR", "13F-HR/A"):
                    all_13f.append({
                        "form": form,
                        "accession_number": o_accessions[i],
                        "filed_date": o_dates[i],
                        "period": o_periods[i],
                    })
        except Exception as e:
            print(f"  Could not fetch older page {older_ref['name']}: {e}")

    return all_13f


def merge_seed_filings(api_filings: list[dict]) -> list[dict]:
    """Add SEED_FILINGS entries that aren't already in api_filings."""
    known = {f["accession_number"] for f in api_filings}
    result = list(api_filings)
    for acc, period, filed, form in SEED_FILINGS:
        if acc not in known:
            print(f"  Adding seed filing: {acc} ({period})")
            result.append({
                "form": form,
                "accession_number": acc,
                "filed_date": filed,
                "period": period,
            })
    return result


def period_to_quarter(period_date: str) -> str:
    """Convert '2024-09-30' to '2024-Q3'."""
    year, month, _ = period_date.split("-")
    quarter = (int(month) - 1) // 3 + 1
    return f"{year}-Q{quarter}"


def main():
    cik_padded = resolve_cik()
    cik_int = int(cik_padded)

    filings_path = DATA_DIR / "filings.json"
    existing_filings: list = json.loads(filings_path.read_text())
    known_accessions = {f["accession_number"] for f in existing_filings}

    # Collect filings from EDGAR submissions API
    api_filings = collect_filings_from_submissions(cik_padded)

    # Merge with seed to guarantee known filings are always included
    all_13f = merge_seed_filings(api_filings)
    print(f"\nTotal 13F filings (API + seed): {len(all_13f)}")
    print(f"Already stored: {len(known_accessions)}")

    new_filings = [f for f in all_13f if f["accession_number"] not in known_accessions]
    print(f"New filings to process: {len(new_filings)}")

    if not new_filings:
        print("No new filings. Data is up to date.")
        _update_meta(cik_int, "Situational Awareness LP", existing_filings)
        return

    sys.path.insert(0, str(Path(__file__).parent))
    from parse_13f import parse_info_table

    holdings_by_quarter_path = DATA_DIR / "holdings_by_quarter.json"
    holdings_by_quarter: dict = json.loads(holdings_by_quarter_path.read_text())

    for filing in sorted(new_filings, key=lambda x: x["filed_date"]):
        acc = filing["accession_number"]
        period = filing["period"]
        quarter_key = period_to_quarter(period)

        print(f"\nProcessing {filing['form']} for {quarter_key} (acc={acc})...")
        xml_url = get_filing_xml_url(cik_int, acc)
        if not xml_url:
            print(f"  SKIPPED: could not locate XML info table for {acc}")
            continue

        print(f"  Downloading: {xml_url}")
        time.sleep(REQUEST_DELAY)
        try:
            xml_data = fetch(xml_url)
            print(f"  Downloaded {len(xml_data):,} bytes")
        except Exception as e:
            print(f"  SKIPPED: download error: {e}")
            continue

        try:
            holdings = parse_info_table(xml_data)
            print(f"  Parsed {len(holdings)} holdings")
            if holdings:
                print(f"  First holding: {holdings[0]}")
        except Exception as e:
            print(f"  SKIPPED: parse error: {e}")
            import traceback
            traceback.print_exc()
            continue

        total_value = sum(h["value_thousands"] for h in holdings)
        print(f"  Total value: ${total_value:,}k")

        holdings_by_quarter[quarter_key] = holdings

        filing_record = {
            **filing,
            "quarter": quarter_key,
            "total_value_thousands": total_value,
            "num_holdings": len(holdings),
            "edgar_url": (
                f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"
                f"&CIK={cik_int}&type=13F&dateb=&owner=include&count=40"
            ),
            "filing_url": (
                f"https://www.sec.gov/Archives/edgar/data/{cik_int}/"
                f"{acc.replace('-','')}/{acc}-index.htm"
            ),
        }
        existing_filings.append(filing_record)
        known_accessions.add(acc)

    filings_path.write_text(json.dumps(existing_filings, indent=2))
    holdings_by_quarter_path.write_text(json.dumps(holdings_by_quarter, indent=2))

    _update_meta(cik_int, "Situational Awareness LP", existing_filings)
    print(f"\nDone. Processed {len(new_filings)} new filings.")


def _update_meta(cik_int: int, entity_name: str, filings: list):
    import datetime
    meta_path = DATA_DIR / "meta.json"
    meta = json.loads(meta_path.read_text())
    meta["cik"] = cik_int
    meta["entity_name"] = entity_name
    meta["last_updated"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    meta["total_filing_count"] = len(filings)
    if filings:
        meta["latest_quarter"] = max(f["quarter"] for f in filings)
    meta_path.write_text(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
