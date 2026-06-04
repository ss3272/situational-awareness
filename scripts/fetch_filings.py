#!/usr/bin/env python3
"""
Fetches 13F-HR filings for Situational Awareness LP from SEC EDGAR.
Uses only Python stdlib. Respects SEC fair-use rate limit (10 req/sec).
Delta-only: skips filings already present in data/filings.json.
"""

import json
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
    "Accept-Encoding": "gzip, deflate",
}
REQUEST_DELAY = 0.11  # ~9 req/sec, safely under the 10/sec limit


def fetch(url: str, retries: int = 3) -> bytes:
    req = urllib.request.Request(
        url,
        headers={**HEADERS, "Host": urllib.parse.urlparse(url).netloc},
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited (429), waiting {wait}s...")
                time.sleep(wait)
            else:
                raise
        except urllib.error.URLError:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed to fetch {url} after {retries} attempts")


def resolve_cik() -> str | None:
    """Return CIK from cache or EDGAR search. Returns None if not found."""
    meta_path = DATA_DIR / "meta.json"
    meta = json.loads(meta_path.read_text())
    if meta.get("cik"):
        print(f"Using cached CIK: {meta['cik']}")
        return str(meta["cik"]).zfill(10)

    print("Searching EDGAR for 'Situational Awareness LP'...")
    for term in ["situational+awareness+lp", "situational+awareness"]:
        url = f"https://efts.sec.gov/LATEST/search-index?q=%22{term}%22&forms=13F-HR"
        time.sleep(REQUEST_DELAY)
        try:
            result = json.loads(fetch(url))
            for hit in result.get("hits", {}).get("hits", []):
                src = hit.get("_source", {})
                entity = src.get("entity_name", "")
                if "situational awareness" in entity.lower():
                    entity_id = src.get("entity_id", "")
                    if entity_id:
                        print(f"Found: {entity}, CIK: {entity_id}")
                        meta["cik"] = entity_id
                        meta["entity_name"] = entity
                        meta_path.write_text(json.dumps(meta, indent=2))
                        return str(entity_id).zfill(10)
        except Exception as e:
            print(f"  EDGAR search failed for '{term}': {e}")

    print("WARNING: CIK not found via search. Set data/meta.json 'cik' manually.")
    return None


def get_filing_xml_url(cik_int: int, accession_raw: str) -> str | None:
    """
    Find the information-table XML URL within a 13F filing.
    Tries the JSON index first, then falls back to the HTML index.
    """
    accession_nodash = accession_raw.replace("-", "")
    base = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}"

    # --- Try JSON index ---
    idx_url = f"{base}/{accession_raw}-index.json"
    time.sleep(REQUEST_DELAY)
    try:
        idx = json.loads(fetch(idx_url))
        docs = idx.get("documents", [])
        print(f"  Index has {len(docs)} documents: {[d.get('type','?')+'/'+d.get('name','?') for d in docs]}")

        # Priority 1: explicit INFORMATION TABLE type
        for doc in docs:
            if doc.get("type", "").upper() == "INFORMATION TABLE":
                print(f"  Found info table by type: {doc['name']}")
                return f"{base}/{doc['name']}"

        # Priority 2: filename contains 'infotable'
        for doc in docs:
            if "infotable" in doc.get("name", "").lower():
                print(f"  Found info table by filename: {doc['name']}")
                return f"{base}/{doc['name']}"

        # Priority 3: any .xml that isn't the cover page (type 13F-HR)
        for doc in docs:
            name = doc.get("name", "").lower()
            doc_type = doc.get("type", "").upper()
            if name.endswith(".xml") and doc_type not in ("13F-HR", "13F-HR/A", "13F-NT"):
                print(f"  Found XML (fallback): {doc['name']} (type={doc_type})")
                return f"{base}/{doc['name']}"

        # Priority 4: any .xml at all (last resort)
        for doc in docs:
            if doc.get("name", "").lower().endswith(".xml"):
                print(f"  Found XML (last resort): {doc['name']}")
                return f"{base}/{doc['name']}"

    except Exception as e:
        print(f"  JSON index failed for {accession_raw}: {e}")

    # --- Fallback: try common filename patterns ---
    for candidate in ["infotable.xml", "form13fInfoTable.xml", "informationtable.xml"]:
        url = f"{base}/{candidate}"
        time.sleep(REQUEST_DELAY)
        try:
            fetch(url)  # just check it exists (200 = exists)
            print(f"  Found via pattern guess: {candidate}")
            return url
        except urllib.error.HTTPError as e:
            if e.code != 404:
                print(f"  Pattern {candidate}: HTTP {e.code}")
        except Exception:
            pass

    print(f"  Could not locate info table XML for {accession_raw}")
    return None


def main():
    cik_padded = resolve_cik()
    if cik_padded is None:
        print("No CIK found. Dashboard will show empty state.")
        return

    cik_int = int(cik_padded)

    filings_path = DATA_DIR / "filings.json"
    existing_filings: list = json.loads(filings_path.read_text())
    known_accessions = {f["accession_number"] for f in existing_filings}

    print(f"\nFetching submission history for CIK {cik_padded}...")
    subs_url = f"https://data.sec.gov/submissions/CIK{cik_padded}.json"
    time.sleep(REQUEST_DELAY)
    try:
        subs_data = json.loads(fetch(subs_url))
    except Exception as e:
        print(f"ERROR fetching submissions: {e}")
        return

    entity_name = subs_data.get("name", "Situational Awareness LP")
    print(f"Entity: {entity_name}")

    recent = subs_data.get("filings", {}).get("recent", {})
    all_13f = [
        {
            "form": recent["form"][i],
            "accession_number": recent["accessionNumber"][i],
            "filed_date": recent["filingDate"][i],
            "period": recent["reportDate"][i],
        }
        for i, form in enumerate(recent.get("form", []))
        if form in ("13F-HR", "13F-HR/A")
    ]

    for older_ref in subs_data.get("filings", {}).get("files", []):
        older_url = f"https://data.sec.gov/submissions/{older_ref['name']}"
        time.sleep(REQUEST_DELAY)
        try:
            older = json.loads(fetch(older_url))
            all_13f += [
                {
                    "form": older["form"][i],
                    "accession_number": older["accessionNumber"][i],
                    "filed_date": older["filingDate"][i],
                    "period": older["reportDate"][i],
                }
                for i, form in enumerate(older.get("form", []))
                if form in ("13F-HR", "13F-HR/A")
            ]
        except Exception as e:
            print(f"  Could not fetch older filings {older_ref['name']}: {e}")

    if not all_13f:
        print("No 13F filings found for this entity.")
        return

    print(f"Found {len(all_13f)} 13F filings total, {len(known_accessions)} already stored.")
    new_filings = [f for f in all_13f if f["accession_number"] not in known_accessions]
    print(f"New filings to process: {len(new_filings)}")

    if not new_filings:
        print("No new filings. Data is up to date.")
        return

    sys.path.insert(0, str(Path(__file__).parent))
    from parse_13f import parse_info_table

    holdings_by_quarter_path = DATA_DIR / "holdings_by_quarter.json"
    holdings_by_quarter: dict = json.loads(holdings_by_quarter_path.read_text())
    # Strip any enrichment keys from prior build runs so raw data stays clean
    for q in list(holdings_by_quarter):
        for h in holdings_by_quarter[q]:
            for k in ("ticker", "display_name", "value_usd", "pct_of_portfolio",
                      "qoq_status", "qoq_shares_delta", "qoq_value_delta"):
                h.pop(k, None)

    for filing in sorted(new_filings, key=lambda x: x["filed_date"]):
        acc = filing["accession_number"]
        quarter_key = period_to_quarter(filing["period"])

        print(f"\nProcessing {filing['form']} for {quarter_key} (filed {filing['filed_date']})")
        xml_url = get_filing_xml_url(cik_int, acc)
        if not xml_url:
            print(f"  Skipping {acc}: info table XML not found")
            continue

        time.sleep(REQUEST_DELAY)
        try:
            xml_data = fetch(xml_url)
        except Exception as e:
            print(f"  Skipping {acc}: download error: {e}")
            continue

        try:
            holdings = parse_info_table(xml_data)
        except Exception as e:
            print(f"  Skipping {acc}: parse error: {e}")
            continue

        if not holdings:
            print(f"  WARNING: parsed 0 holdings from {xml_url}")
            continue

        total_value = sum(h["value_thousands"] for h in holdings)
        print(f"  Parsed {len(holdings)} holdings, total value ${total_value:,}k")

        if filing["form"] == "13F-HR/A" and quarter_key in holdings_by_quarter:
            print(f"  Replacing {quarter_key} data with amendment")
        holdings_by_quarter[quarter_key] = holdings

        existing_filings.append({
            **filing,
            "quarter": quarter_key,
            "total_value_thousands": total_value,
            "num_holdings": len(holdings),
            "edgar_url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik_int}&type=13F",
            "filing_url": f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc.replace('-','')}/{acc}-index.htm",
        })
        known_accessions.add(acc)

    filings_path.write_text(json.dumps(existing_filings, indent=2))
    holdings_by_quarter_path.write_text(json.dumps(holdings_by_quarter, indent=2))

    import datetime
    meta_path = DATA_DIR / "meta.json"
    meta = json.loads(meta_path.read_text())
    meta["cik"] = cik_int
    meta["entity_name"] = entity_name
    meta["last_updated"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    meta["total_filing_count"] = len(existing_filings)
    if existing_filings:
        meta["latest_quarter"] = max(f["quarter"] for f in existing_filings)
    meta_path.write_text(json.dumps(meta, indent=2))

    print(f"\nDone. Stored {len(new_filings)} new filings.")


def period_to_quarter(period_date: str) -> str:
    year, month, _ = period_date.split("-")
    return f"{year}-Q{(int(month) - 1) // 3 + 1}"


if __name__ == "__main__":
    main()
