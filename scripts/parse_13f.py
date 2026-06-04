#!/usr/bin/env python3
"""
Parses SEC 13F-HR XML information tables into structured dicts.
Handles both modern and legacy XML namespace variants.
"""

import xml.etree.ElementTree as ET


def parse_info_table(xml_bytes: bytes) -> list[dict]:
    """
    Parse raw 13F XML bytes into a list of holding dicts.
    """
    data = xml_bytes.lstrip(b"\xef\xbb\xbf")

    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise ValueError(f"XML parse error: {e}")

    ns_uri = ""
    if root.tag.startswith("{"):
        ns_uri = root.tag[1:root.tag.index("}")]

    entries_tag = f"{{{ns_uri}}}infoTable" if ns_uri else "infoTable"
    rows = root.findall(f".//{entries_tag}")

    if not rows:
        rows = root.findall(".//infoTable")

    holdings = []
    for row in rows:
        def t(tag):
            child = row.find(f"{{{ns_uri}}}{tag}") if ns_uri else None
            if child is None:
                child = row.find(tag)
            return child.text.strip() if child is not None and child.text else ""

        va_tag = f"{{{ns_uri}}}votingAuthority" if ns_uri else "votingAuthority"
        va_el = row.find(va_tag) or row.find("votingAuthority")

        def va(tag):
            if va_el is None:
                return "0"
            child = va_el.find(f"{{{ns_uri}}}{tag}") if ns_uri else None
            if child is None:
                child = va_el.find(tag)
            return child.text.strip() if child is not None and child.text else "0"

        try:
            value_thousands = int(t("value").replace(",", "") or "0")
            shares = int(t("sshPrnamt").replace(",", "") or "0")
        except ValueError:
            value_thousands = 0
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
