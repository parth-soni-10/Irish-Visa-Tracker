"""
Irish Visa Decision Tracker — scraper for GitHub Actions
-----------------------------------------------------------
Same logic as local_scraper.py, but reads WEB_APP_URL from an
environment variable (set as a GitHub Actions secret) instead of
being hardcoded, since this file lives in a repo.
"""

import re
import io
import os
import sys
from datetime import datetime

import requests
import pandas as pd

PAGE_URL = "https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/"
WEB_APP_URL = os.environ.get("WEB_APP_URL", "").strip()
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.ireland.ie/",
}


def find_ods_link():
    resp = requests.get(PAGE_URL, headers=BROWSER_HEADERS, timeout=30)
    print(f"Page fetch status: {resp.status_code} | length: {len(resp.text)}")
    if resp.status_code != 200:
        raise RuntimeError(f"Blocked fetching page — status {resp.status_code}")

    match = re.search(r'href=["\']([^"\']+\.ods)["\']', resp.text, re.IGNORECASE)
    if not match:
        match = re.search(r'(https?://[^\s"\'<>]+\.ods)', resp.text, re.IGNORECASE)
    if not match:
        raise RuntimeError("No .ods link found in page HTML — site markup may have changed.")

    href = match.group(1)
    if href.startswith("//"):
        href = "https:" + href
    elif href.startswith("/"):
        href = "https://www.ireland.ie" + href
    print(f"Found ODS link: {href}")
    return href


def parse_date_from_filename(filename: str) -> str:
    digits = re.sub(r"[^0-9]", "", filename)
    stamp = digits[:8]
    if len(stamp) != 8:
        return datetime.today().strftime("%Y-%m-%d")
    return f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}"


def download_and_parse_ods(ods_url: str):
    filename = ods_url.split("/")[-1].split("?")[0]
    resp = requests.get(ods_url, headers=BROWSER_HEADERS, timeout=60)
    print(f"ODS fetch status: {resp.status_code} | bytes: {len(resp.content)}")
    if resp.status_code != 200:
        raise RuntimeError(f"Blocked fetching .ods — status {resp.status_code}")

    # Read raw, no assumed header row — some govt files have a title row above the real headers.
    raw = pd.read_excel(io.BytesIO(resp.content), engine="odf", header=None)
    header_row_idx = find_header_row(raw)
    print(f"Detected header row at index {header_row_idx}: {list(raw.iloc[header_row_idx])}")

    df = raw.iloc[header_row_idx + 1:].copy()
    df.columns = raw.iloc[header_row_idx]
    df = df.reset_index(drop=True)
    return filename, df


def find_header_row(raw: pd.DataFrame, scan_rows: int = 25) -> int:
    """Scan the first N rows for one containing both an IRL/application marker and a
    decision marker, in DIFFERENT cells (avoids matching a single title like
    'Application Decisions:' which contains both words in one cell)."""
    for i in range(min(scan_rows, len(raw))):
        row_vals = [str(v).lower() for v in raw.iloc[i].tolist()]
        app_cols = [j for j, v in enumerate(row_vals) if ("irl" in v or "application" in v)]
        dec_cols = [j for j, v in enumerate(row_vals) if ("decision" in v or "outcome" in v)]
        if app_cols and dec_cols and set(app_cols) != set(dec_cols):
            # also require they're not the exact same single cell
            if not (len(app_cols) == 1 and len(dec_cols) == 1 and app_cols[0] == dec_cols[0]):
                return i
    raise RuntimeError(
        f"Could not find a header row containing both an IRL/application marker "
        f"and a decision marker in separate cells within the first {scan_rows} rows. First rows:\n"
        + str(raw.head(scan_rows))
    )


def detect_columns(df: pd.DataFrame):
    app_col = decision_col = None
    for col in df.columns:
        s = str(col).lower()
        if app_col is None and ("irl" in s or "application" in s):
            app_col = col
        if decision_col is None and ("decision" in s or "outcome" in s):
            decision_col = col
    return app_col, decision_col


def fetch_existing_irl_numbers():
    print(f"WEB_APP_URL length: {len(WEB_APP_URL)} | starts: {WEB_APP_URL[:45]!r} | ends: {WEB_APP_URL[-15:]!r}")
    resp = requests.get(WEB_APP_URL, params={"action": "raw"}, timeout=30)
    print(f"Existing-rows fetch status: {resp.status_code} | first 300 chars of body: {resp.text[:300]!r}")
    resp.raise_for_status()
    rows = resp.json()
    return {r["irl"] for r in rows}


def push_new_rows(rows):
    resp = requests.post(WEB_APP_URL, json={"action": "append_rows", "rows": rows}, timeout=60)
    resp.raise_for_status()
    print("Server response:", resp.json())


def main():
    if not WEB_APP_URL:
        print("ERROR: WEB_APP_URL env var not set.")
        sys.exit(1)

    ods_url = find_ods_link()
    filename, df = download_and_parse_ods(ods_url)
    fetch_date = parse_date_from_filename(filename)

    app_col, decision_col = detect_columns(df)
    if not app_col or not decision_col:
        print("Could not detect columns. Headers seen:", list(df.columns))
        sys.exit(1)

    existing = fetch_existing_irl_numbers()
    print(f"{len(existing)} existing IRL numbers already on record.")

    new_rows = []
    for _, r in df.iterrows():
        irl = str(r[app_col]).strip()
        decision = str(r[decision_col]).strip()
        if not irl or irl in existing or irl.lower() == "nan":
            continue
        new_rows.append({"date": fetch_date, "irl": irl, "decision": decision})
        existing.add(irl)

    print(f"{len(new_rows)} new rows to push (out of {len(df)} rows in file).")
    if new_rows:
        push_new_rows(new_rows)
    else:
        print("Nothing new — Sheet already up to date.")


if __name__ == "__main__":
    main()
