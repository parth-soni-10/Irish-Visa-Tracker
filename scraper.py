"""
Irish Visa Decision Tracker — scraper for GitHub Actions
-----------------------------------------------------------
Reads WEB_APP_URL from an environment variable (GitHub Actions secret).

Every single run decides a flag:
  - Defaults to "no file found" (true).
  - If the scrape successfully fetches and parses the .ods file, flips to false
    — regardless of whether that file contained any NEW rows or not.
  - If still true at the end of the run, upserts (insert-or-overwrite, never
    duplicates) a placeholder row dated YESTERDAY: "The visa office hasn't
    updated any file until now." This runs on every scheduled run, not just
    a "final" one, so a bad run gets self-corrected by the next one a few
    hours later automatically.
  - If a file WAS found this run, any stale placeholder for yesterday gets
    actively cleared, since it's no longer accurate.

Flags (env vars, all optional):
  ENABLE_NO_UPLOAD_PLACEHOLDER "true" (default) or "false" — turns the
                                placeholder mechanism on/off without touching code.
"""

import re
import io
import os
import sys
from datetime import datetime, timedelta, timezone

import requests
import pandas as pd

PAGE_URL = "https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/"
WEB_APP_URL = os.environ.get("WEB_APP_URL", "").strip()
ENABLE_NO_UPLOAD_PLACEHOLDER = os.environ.get("ENABLE_NO_UPLOAD_PLACEHOLDER", "true").strip().lower() == "true"
NO_FILE_MESSAGE = "The visa office hasn't updated any file until now"

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

    raw = pd.read_excel(io.BytesIO(resp.content), engine="odf", header=None)
    header_row_idx = find_header_row(raw)
    print(f"Detected header row at index {header_row_idx}: {list(raw.iloc[header_row_idx])}")

    df = raw.iloc[header_row_idx + 1:].copy()
    df.columns = raw.iloc[header_row_idx]
    df = df.reset_index(drop=True)
    return filename, df


def find_header_row(raw: pd.DataFrame, scan_rows: int = 25) -> int:
    for i in range(min(scan_rows, len(raw))):
        row_vals = [str(v).lower() for v in raw.iloc[i].tolist()]
        app_cols = [j for j, v in enumerate(row_vals) if ("irl" in v or "application" in v)]
        dec_cols = [j for j, v in enumerate(row_vals) if ("decision" in v or "outcome" in v)]
        if app_cols and dec_cols and set(app_cols) != set(dec_cols):
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


def looks_like_header(irl: str, decision: str) -> bool:
    i, d = irl.lower(), decision.lower()
    return i in ("application number", "irl", "irl number") or d in ("decision", "outcome")


def ist_today_str() -> str:
    ist = timezone(timedelta(hours=5, minutes=30))
    return datetime.now(ist).strftime("%Y-%m-%d")


def ist_yesterday_str() -> str:
    ist = timezone(timedelta(hours=5, minutes=30))
    return (datetime.now(ist) - timedelta(days=1)).strftime("%Y-%m-%d")


def fetch_existing_rows():
    """Full existing Raw sheet contents: list of [date, irl, decision]. Retries on cold-start timeouts."""
    print(f"WEB_APP_URL length: {len(WEB_APP_URL)} | starts: {WEB_APP_URL[:45]!r} | ends: {WEB_APP_URL[-15:]!r}")
    last_err = None
    for attempt in range(1, 4):
        try:
            print(f"Attempt {attempt}: fetching existing rows...")
            resp = requests.get(WEB_APP_URL, params={"action": "raw"}, timeout=90)
            print(f"Existing-rows fetch status: {resp.status_code} | first 300 chars of body: {resp.text[:300]!r}")
            resp.raise_for_status()
            return resp.json()  # list of [date, irl, decision]
        except (requests.exceptions.ReadTimeout, requests.exceptions.ConnectionError) as e:
            print(f"Attempt {attempt} failed: {e}")
            last_err = e
    raise last_err


def push_new_rows(rows):
    resp = requests.post(WEB_APP_URL, json={"action": "append_rows", "rows": rows}, timeout=90)
    resp.raise_for_status()
    result = resp.json()
    print("Server response:", result)
    return result


def set_no_file_placeholder(date_str):
    """Insert-or-overwrite (never duplicates) the 'no file yet' row for date_str."""
    resp = requests.post(WEB_APP_URL, json={
        "action": "set_no_file_placeholder",
        "date": date_str,
        "message": NO_FILE_MESSAGE,
    }, timeout=90)
    resp.raise_for_status()
    result = resp.json()
    print("Placeholder upsert response:", result)
    return result


def clear_no_file_placeholder(date_str):
    """Remove a stale placeholder for date_str, if one exists. No-op if not."""
    resp = requests.post(WEB_APP_URL, json={
        "action": "clear_no_file_placeholder",
        "date": date_str,
    }, timeout=90)
    resp.raise_for_status()
    result = resp.json()
    print("Placeholder clear response:", result)
    return result


def main():
    if not WEB_APP_URL:
        print("ERROR: WEB_APP_URL env var not set.")
        sys.exit(1)

    today_ist = ist_today_str()
    yesterday_ist = ist_yesterday_str()

    existing_rows = fetch_existing_rows()
    existing_dates = {r[0] for r in existing_rows}
    existing_irl = {r[1] for r in existing_rows}

    if today_ist in existing_dates:
        print(f"Data already present for {today_ist} — skipping this run entirely, no site fetch needed.")
        return

    no_file_found = True   # default every run, per the failsafe design
    scrape_failed = False
    new_rows = []
    try:
        ods_url = find_ods_link()
        filename, df = download_and_parse_ods(ods_url)
        fetch_date = parse_date_from_filename(filename)

        app_col, decision_col = detect_columns(df)
        if not app_col or not decision_col:
            raise RuntimeError(f"Could not detect columns. Headers seen: {list(df.columns)}")

        no_file_found = False  # we successfully got and parsed a file this run
        print(f"{len(existing_irl)} existing IRL numbers already on record.")

        for _, r in df.iterrows():
            irl = str(r[app_col]).strip()
            decision = str(r[decision_col]).strip()
            if not irl or irl in existing_irl or irl.lower() == "nan":
                continue
            if looks_like_header(irl, decision):
                continue
            new_rows.append({"date": fetch_date, "irl": irl, "decision": decision})
            existing_irl.add(irl)

        print(f"{len(new_rows)} new rows to push (out of {len(df)} rows in file).")
        if new_rows:
            push_new_rows(new_rows)
        else:
            print("File fetched fine, nothing new in it — Sheet already up to date.")

    except Exception as e:
        scrape_failed = True
        no_file_found = True
        print(f"Scrape step failed: {e}")

    if no_file_found:
        if ENABLE_NO_UPLOAD_PLACEHOLDER:
            print(f"No file found this run — upserting placeholder for {yesterday_ist}.")
            set_no_file_placeholder(yesterday_ist)
        else:
            print("ENABLE_NO_UPLOAD_PLACEHOLDER is false — skipping placeholder.")
    else:
        print(f"File was found this run — clearing any stale placeholder for {yesterday_ist}.")
        clear_no_file_placeholder(yesterday_ist)

    if scrape_failed:
        # Keep the run visible as a failure in GitHub's UI so real outages get
        # noticed, even though the placeholder was still upserted above.
        sys.exit(1)


if __name__ == "__main__":
    main()
