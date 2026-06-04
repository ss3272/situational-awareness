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
    """Auto-resolve CIK for Situational Awareness LP. Returns None if not found."""
    meta_path = DATA_DIR / "meta.json"
    meta = json.loads(meta_path.read_text())
    if meta.get("cik"):
        print(f"Using cached CIK: {meta['cik']}")
        return str(meta["cik"]).zfill(10)

    print("Searching EDGAR for 'Situational Awareness LP'...")

    # Try full-text search first
    for term in ["situational+awareness+lp", "situational+awareness"]:
        url = f"https://efts.sec.gov/LATEST/search-index?q=%22{term}%22&forms=13F-HR"
        time.sleep(REQUEST_DELAY)
        try:
            data = fetch(url)
            result = json.loads(data)
            hits = result.get("hits", {}).get("hits", [])
            for hit in hits:
                src = hit.get("_source", {})
                entity = src.get("entity_name", "") or ""
                if "situational awareness" in entity.lower():
                    entity_id = src.get("entity_id", "")
                    if entity_id:
                        print(f"Found entity: {entity}, CIK: {entity_id}")
                        meta["cik"] = entity_id
                        meta["entity_name"] = entity
                        meta_path.write_text(json.dumps(meta, indent=2))
                        return str(entity_id).zfill(10)
        except Exception as e:
            print(f"  EDGAR full-text search failed for '{term}': {e}")

    # Fallback: company search Atom feed
    print("Trying EDGAR company search...")
    url = (
        "https://www.sec.gov/cgi-bin/browse-edgar"
        "?company=situational+awareness&CIK=&type=13F"
        "&dateb=&owner=include&count=40&search_text=&action=getcompany&output=atom"
    )
    time.sleep(REQUEST_DELAY)
    try:
        data = fetch(url)
        root_el = ET.fromstring(data)
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        for entry in root_el.findall("atom:entry", ns):
            title = entry.findtext("atom:title", "", ns)
            if "situational awareness" in title.lower():
                content = entry.findtext("atom:content", "", ns)
                cik_idx = content.find("CIK=")
                if cik_idx >= 0:
                    cik_str = content[cik_idx + 4 : cik_idx + 14].split("&")[0].strip()
                    print(f"Found via company search: {title}, CIK: {cik_str}")
                    meta["cik"] = int(cik_str)
                    meta["entity_name"] = title.strip()
                    meta_path.write_text(json.dumps(meta, indent=2))
                    return cik_str.zfill(10)
    except Exception as e:
        print(f"  Company search failed: {e}")

    print("WARNING: Could not resolve CIK for Situational Awareness LP.")
    print("The fund may not have filed 13F reports yet (required only if AUM >= $100M).")
    print("To set manually: edit data/meta.json and set the 'cik' field.")
    print("Search: https://www.sec.gov/cgi-bin/browse-edgar?company=situational+awareness&type=13F&action=getcompany")
    return None


def get_filing_xml_url(cik_padded: str, accession_raw: str) -> str | None:
    accession_nodash = accession_raw.replace("-", "")
    idx_url = (
        f"https://www.sec.gov/Archives/edgar/data/{int(cik_padded)}/"
        f"{accession_nodash}/{accession_raw}-index.json"
    )
    time.sleep(REQUEST_DELAY)
    try:
        data = fetch(idx_url)
        idx = json.loads(data)
        for doc in idx.get("documents", []):
            name = doc.get("name", "").lower()
            doc_type = doc.get("type", "").lower()
            if ("infotable" in name or name.endswith(".xml")) and "primary" not in doc_type:
                return (
                    f"https://www.sec.gov/Archives/edgar/data/{int(cik_padded)}/"
                    f"{accession_nodash}/{doc['name']}"
                )
        for doc in idx.get("documents", []):
            if doc.get("name", "").lower().endswith(".xml"):
                return (
                    f"https://www.sec.gov/Archives/edgar/data/{int(cik_padded)}/"
                    f"{accession_nodash}/{doc['name']}"
                )
    except Exception as e:
        print(f"  Could not get index for {accession_raw}: {e}")
    return None


def main():
    cik_padded = resolve_cik()
    if cik_padded is None:
        print("No CIK found — skipping data fetch. Dashboard will show empty state.")
        return  # exit 0, workflow continues to deploy

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
        print("Skipping data fetch — dashboard will show existing data.")
        return

    entity_name = subs_data.get("name", "Situational Awareness LP")
    print(f"Entity: {entity_name}")

    recent = subs_data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    filed_dates = recent.get("filingDate", [])
    periods = recent.get("reportDate", [])

    all_13f = []
    for i, form in enumerate(forms):
        if form in ("13F-HR", "13F-HR/A"):
            all_13f.append({
                "form": form,
                "accession_number": accessions[i],
                "filed_date": filed_dates[i],
                "period": periods[i],
            })

    for older_ref in subs_data.get("filings", {}).get("files", []):
        older_url = f"https://data.sec.gov/submissions/{older_ref['name']}"
        time.sleep(REQUEST_DELAY)
        try:
            older_data = json.loads(fetch(older_url))
            for i, form in enumerate(older_data.get("form", [])):
                if form in ("13F-HR", "13F-HR/A"):
                    all_13f.append({
                        "form": form,
                        "accession_number": older_data["accessionNumber"][i],
                        "filed_date": older_data["filingDate"][i],
                        "period": older_data["reportDate"][i],
                    })
        except Exception as e:
            print(f"  Could not fetch older filings {older_ref['name']}: {e}")

    if not all_13f:
        print("No 13F filings found for this entity (AUM may be below $100M threshold).")
        print("Dashboard will show empty state until filings are available.")
        return

    print(f"Found {len(all_13f)} total 13F filings, {len(known_accessions)} already stored.")
    new_filings = [f for f in all_13f if f["accession_number"] not in known_accessions]
    print(f"New filings to fetch: {len(new_filings)}")

    if not new_filings:
        print("No new filings. Data is up to date.")
        return

    sys.path.insert(0, str(Path(__file__).parent))
    from parse_13f import parse_info_table

    holdings_by_quarter_path = DATA_DIR / "holdings_by_quarter.json"
    holdings_by_quarter: dict = json.loads(holdings_by_quarter_path.read_text())

    for filing in sorted(new_filings, key=lambda x: x["filed_date"]):
        acc = filing["accession_number"]
        quarter_key = period_to_quarter(filing["period"])

        print(f"\nFetching {filing['form']} for {quarter_key} (filed {filing['filed_date']}) ...")
        xml_url = get_filing_xml_url(cik_padded, acc)
        if not xml_url:
            print(f"  Skipping {acc}: could not locate XML info table")
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

        total_value = sum(h["value_thousands"] for h in holdings)
        print(f"  Parsed {len(holdings)} holdings, total value ${total_value:,}k")

        if filing["form"] == "13F-HR/A" and quarter_key in holdings_by_quarter:
            print(f"  Replacing existing {quarter_key} data with amendment")
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
