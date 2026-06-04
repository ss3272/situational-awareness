#!/usr/bin/env python3
"""
Parses SEC 13F-HR XML information tables into structured dicts.
Handles modern namespace, legacy no-namespace, and edge-case formats.
"""

import xml.etree.ElementTree as ET


def parse_info_table(xml_bytes: bytes) -> list[dict]:
    """
    Parse raw 13F XML bytes into a list of holding dicts.

    Handles:
      - Namespace: {http://www.sec.gov/edgar/document/thirteenf/informationtable}
      - No namespace (older filings)
      - Mixed namespace (root has ns, children don't)
    """
    # Strip UTF-8 BOM and leading whitespace
    data = xml_bytes.lstrip(b"\xef\xbb\xbf").lstrip()

    # Decode for debugging
    try:
        text_sample = data[:500].decode("utf-8", errors="replace")
    except Exception:
        text_sample = ""
    print(f"  XML preview (first 500 chars): {text_sample!r}")

    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise ValueError(f"XML parse error: {e}")

    print(f"  Root tag: {root.tag}")

    # Extract namespace URI from root tag (if present)
    ns_uri = ""
    if root.tag.startswith("{"):
        ns_uri = root.tag[1:root.tag.index("}")]
    print(f"  Namespace URI: {ns_uri!r}")

    def q(tag: str) -> str:
        return f"{{{ns_uri}}}{tag}" if ns_uri else tag

    # Find all <infoTable> elements anywhere in the tree
    rows = root.findall(f".//{q('infoTable')}")
    if not rows:
        rows = root.findall(".//infoTable")
    print(f"  Found {len(rows)} infoTable rows")

    holdings = []
    for row in rows:
        def t(tag: str) -> str:
            # Try namespaced first, then bare
            child = row.find(q(tag))
            if child is None and ns_uri:
                child = row.find(tag)
            return (child.text or "").strip() if child is not None else ""

        # votingAuthority is a sub-element
        va_el = row.find(q("votingAuthority"))
        if va_el is None and ns_uri:
            va_el = row.find("votingAuthority")

        def va(tag: str) -> str:
            if va_el is None:
                return "0"
            child = va_el.find(q(tag))
            if child is None and ns_uri:
                child = va_el.find(tag)
            return (child.text or "").strip() if child is not None else "0"

        try:
            value_thousands = int(t("value").replace(",", "") or "0")
        except ValueError:
            value_thousands = 0

        try:
            shares = int(t("sshPrnamt").replace(",", "") or "0")
        except ValueError:
            shares = 0

        holdings.append({
            "cusip": t("cusip"),
            "name_of_issuer": t("nameOfIssuer"),
            "title_of_class": t("titleOfClass"),
            "value_thousands": value_thousands,
            "shares": shares,
            "share_type": t("sshPrnamtType"),
            "investment_discretion": t("investmentDiscretion"),
            "voting_sole": va("Sole"),
            "voting_shared": va("Shared"),
            "voting_none": va("None"),
        })

    return holdings
