"""
Irish Visa Decision Tracker — scraper for GitHub Actions
-----------------------------------------------------------
Reads WEB_APP_URL from an environment variable (GitHub Actions secret).

Flags (env vars, all optional):
  IS_FINAL_RUN                 "true" on the last scheduled run of the day only.
  ENABLE_NO_UPLOAD_PLACEHOLDER "true" (default) or "false" — turns the
                                "visa office didn't upload any file" fallback
                                row on/off without touching code.
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
IS_FINAL_RUN = os.environ.get("IS_FINAL_RUN", "false").strip().lower() == "true"
ENABLE_NO_UPLOAD_PLACEHOLDER = os.environ.get("ENABLE_NO_UPLOAD_PLACEHOLDER", "true").strip().lower() == "true"

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


def maybe_insert_no_upload_placeholder(today_ist, yesterday_ist):
    """Only called on the final run, only if today still has no data. Re-checks
    live Sheet state right before writing, so two runs racing (e.g. a manual
    trigger overlapping the scheduled final run) can't both insert a placeholder."""
    if not ENABLE_NO_UPLOAD_PLACEHOLDER:
        print("ENABLE_NO_UPLOAD_PLACEHOLDER is false — skipping placeholder logic.")
        return
    if not IS_FINAL_RUN:
        return

    print("Final run — re-checking live Sheet state before deciding on a placeholder...")
    try:
        fresh_rows = fetch_existing_rows()
    except Exception as e:
        print(f"Could not re-check Sheet state ({e}) — skipping placeholder to be safe, "
              f"rather than risk a wrong/duplicate entry.")
        return

    fresh_dates = {r[0] for r in fresh_rows}
    if today_ist in fresh_dates:
        print(f"Data for {today_ist} exists now (another run must have added it) — no placeholder needed.")
        return
    if yesterday_ist in fresh_dates:
        print(f"{yesterday_ist} already has a row (real or placeholder) — not adding another.")
        return

    print(f"Confirmed: no data for {today_ist}, and {yesterday_ist} has nothing on record either. "
          f"Inserting placeholder dated {yesterday_ist}.")
    push_new_rows([{
        "date": yesterday_ist,
        "irl": f"NO_FILE_UPLOADED_{yesterday_ist}",
        "decision": "Visa office didn't upload any file.",
    }])


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

    scrape_failed = False
    new_rows = []
    try:
        ods_url = find_ods_link()
        filename, df = download_and_parse_ods(ods_url)
        fetch_date = parse_date_from_filename(filename)

        app_col, decision_col = detect_columns(df)
        if not app_col or not decision_col:
            raise RuntimeError(f"Could not detect columns. Headers seen: {list(df.columns)}")

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
            print("Nothing new — Sheet already up to date.")

    except Exception as e:
        # Deliberately caught (not left to crash the process) so that even if
        # the site is blocked/down/changed, the final-run placeholder logic
        # below still gets a chance to run.
        scrape_failed = True
        print(f"Scrape step failed: {e}")

    # Placeholder logic always gets evaluated on the final run, whether or not
    # the scrape above succeeded — that's the whole point of catching above.
    if today_ist not in existing_dates and not new_rows:
        maybe_insert_no_upload_placeholder(today_ist, yesterday_ist)

    if scrape_failed:
        # Keep the run visible as a failure in GitHub's UI so real outages get
        # noticed, even though the placeholder (if applicable) was still added.
        sys.exit(1)


if __name__ == "__main__":
    main()
