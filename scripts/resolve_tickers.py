#!/usr/bin/env python3
"""
Resolves CUSIP identifiers to ticker symbols using the OpenFIGI API.
Caches results in data/cusip_map.json. Only resolves new CUSIPs.
"""

import json
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"

OPENFIGI_URL = "https://api.openfigi.com/v3/mapping"
BATCH_SIZE = 100
OPENFIGI_DELAY = 2.5


def fetch_figi_batch(cusips: list[str]) -> dict[str, dict]:
    payload = json.dumps([{"idType": "ID_CUSIP", "idValue": c} for c in cusips]).encode()
    req = urllib.request.Request(
        OPENFIGI_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "situational-awareness-dashboard saransh.mega@gmail.com",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            results = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print("  OpenFIGI rate limited, waiting 60s...")
            time.sleep(60)
            return {}
        print(f"  OpenFIGI error {e.code}: {e.reason}")
        return {}
    except Exception as e:
        print(f"  OpenFIGI request failed: {e}")
        return {}

    resolved = {}
    for cusip, result in zip(cusips, results):
        data_list = result.get("data", [])
        if data_list:
            best = data_list[0]
            resolved[cusip] = {
                "ticker": best.get("ticker", ""),
                "name": best.get("name", ""),
                "security_type": best.get("securityType", ""),
                "exchange": best.get("exchCode", ""),
            }
    return resolved


def main():
    cusip_map_path = DATA_DIR / "cusip_map.json"
    holdings_path = DATA_DIR / "holdings_by_quarter.json"

    cusip_map: dict = json.loads(cusip_map_path.read_text())
    holdings_by_quarter: dict = json.loads(holdings_path.read_text())

    all_cusips = set()
    for quarter, holdings in holdings_by_quarter.items():
        for h in holdings:
            cusip = h.get("cusip", "").strip()
            if cusip and cusip not in cusip_map:
                all_cusips.add(cusip)

    if not all_cusips:
        print("All CUSIPs already resolved, nothing to do.")
        return

    print(f"Resolving {len(all_cusips)} new CUSIPs via OpenFIGI...")
    cusip_list = list(all_cusips)

    for i in range(0, len(cusip_list), BATCH_SIZE):
        batch = cusip_list[i : i + BATCH_SIZE]
        print(f"  Batch {i // BATCH_SIZE + 1}: resolving {len(batch)} CUSIPs...")
        resolved = fetch_figi_batch(batch)
        cusip_map.update(resolved)
        print(f"  Resolved {len(resolved)}/{len(batch)} in this batch")
        if i + BATCH_SIZE < len(cusip_list):
            time.sleep(OPENFIGI_DELAY)

    cusip_map_path.write_text(json.dumps(cusip_map, indent=2, sort_keys=True))
    print(f"\nCUSIP map now has {len(cusip_map)} entries.")


if __name__ == "__main__":
    main()
