"""
Irish Visa Decision Tracker — scraper for GitHub Actions
-----------------------------------------------------------
Reads WEB_APP_URL from an environment variable (GitHub Actions secret).

Every run, in priority order:
  1. If today already has REAL data on record (not just a placeholder) -> skip.
  2. If today is Saturday/Sunday -> upsert "Saturday/Sunday, Visa Office is
     closed", dated TODAY. Stop (no scrape attempted).
  3. Else check the embassy's closure-dates page for today's date -> if listed,
     upsert "Embassy is closed today for <holiday name>", dated TODAY. Stop.
  4. Else (a normal business day) -> attempt the real scrape. If it succeeds,
     clear any stale placeholders for the file's date and push new rows as
     usual. If it fails or finds nothing, upsert "Visa office hasn't uploaded
     any sheet until now, check back later, or come back tomorrow", dated
     TODAY so the placeholder is visible until real data overwrites it.

All placeholders use the same insert-or-overwrite mechanism (never duplicate,
always reflect the latest run's message). Once real data lands, its date's
placeholder is cleared automatically.

Flags (env vars, all optional):
  ENABLE_NO_UPLOAD_PLACEHOLDER "true" (default) or "false" — turns ALL of the
                                above placeholder mechanisms on/off at once.
"""

import re
import io
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import requests
import pandas as pd
from dateutil import parser as dateparser

PAGE_URL = "https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/"
CLOSURE_DATES_URL = "https://www.ireland.ie/en/india/newdelhi/about/embassy-information/"
WEB_APP_URL = os.environ.get("WEB_APP_URL", "").strip()
ENABLE_NO_UPLOAD_PLACEHOLDER = os.environ.get("ENABLE_NO_UPLOAD_PLACEHOLDER", "true").strip().lower() == "true"
WEB_APP_GET_ATTEMPTS = 5
WEB_APP_RETRY_DELAYS = (2, 4, 8, 16)
WEB_APP_RETRYABLE_STATUS_CODES = {404, 408, 425, 429, 500, 502, 503, 504}

NO_UPLOAD_MESSAGE = "Visa office hasn't uploaded any sheet until now, check back later, or come back tomorrow"
WEEKEND_MESSAGE = "Saturday/Sunday, Visa Office is closed"

_PLACEHOLDER_DECISIONS = {
    WEEKEND_MESSAGE,
    NO_UPLOAD_MESSAGE,
}  # known placeholder messages; holiday placeholders start with "Embassy is closed"

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.ireland.ie/",
}


# ---------------- time helpers (now_ist is the single source of "current time",
# kept as its own function so tests can monkeypatch it) ----------------

def now_ist() -> datetime:
    return datetime.now(timezone(timedelta(hours=5, minutes=30)))



# ---------------- .ods scraping (unchanged from before) ----------------

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
    """Extract an ISO date from the first 8 digits of the filename, falling back
    to today's date if no 8-digit stamp is present. Validates the result so a
    malformed filename (e.g. random digits from a UUID) can't push garbage into
    the Sheet."""
    digits = re.sub(r"[^0-9]", "", filename)
    stamp = digits[:8]
    if len(stamp) == 8:
        try:
            datetime.strptime(stamp, "%Y%m%d")
        except ValueError:
            return now_ist().strftime("%Y-%m-%d")
        return f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}"
    return now_ist().strftime("%Y-%m-%d")


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
        # Header row needs application-id and decision markers in DISTINCT cells.
        if app_cols and dec_cols and set(app_cols) != set(dec_cols):
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


# ---------------- closure-dates holiday check ----------------

def strip_tags(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def extract_closure_section(html: str, year: int) -> str:
    """Isolate the HTML for this year's closure-dates section if we can find its
    anchor id; otherwise fall back to scanning the whole page (safe, just noisier)."""
    match = re.search(
        rf'id=["\']closure-dates-{year}["\'](.*?)(?=id=["\']closure-dates-\d{{4}}["\']|$)',
        html, re.IGNORECASE | re.DOTALL,
    )
    if match:
        return match.group(1)
    print(f"Could not find a 'closure-dates-{year}' anchor on the page — "
          f"scanning the entire page as a fallback (may be slower/noisier).")
    return html


def extract_candidate_lines(section_html: str):
    """List/table rows are the most likely markup for a closure-dates listing;
    fall back to sentence-splitting plain text if neither is found."""
    items = re.findall(r"<li[^>]*>(.*?)</li>", section_html, re.IGNORECASE | re.DOTALL)
    if not items:
        items = re.findall(r"<tr[^>]*>(.*?)</tr>", section_html, re.IGNORECASE | re.DOTALL)
    if not items:
        text = strip_tags(section_html)
        items = re.split(r"(?<=[.;\n])\s+", text)
    return [strip_tags(i).strip() for i in items if strip_tags(i).strip()]


def check_holiday(today_dt: datetime):
    """Returns a holiday name string if today is a listed embassy closure date,
    else None. Never raises — any parsing failure just means 'not a holiday',
    the safest default (falls through to the normal scrape attempt)."""
    try:
        resp = requests.get(CLOSURE_DATES_URL, headers=BROWSER_HEADERS, timeout=30)
        print(f"Closure-dates page fetch status: {resp.status_code} | length: {len(resp.text)}")
        if resp.status_code != 200:
            print("Could not fetch closure-dates page — treating as 'not a holiday'.")
            return None

        section = extract_closure_section(resp.text, today_dt.year)
        lines = extract_candidate_lines(section)
        print(f"Closure-dates: scanning {len(lines)} candidate lines for {today_dt.strftime('%d %B %Y')}.")

        for line in lines:
            try:
                parsed, tokens = dateparser.parse(line, fuzzy_with_tokens=True, dayfirst=True)
            except (ValueError, OverflowError, TypeError):
                continue
            if parsed.month == today_dt.month and parsed.day == today_dt.day:
                name = " ".join(t.strip(" -\u2013\u2014:,") for t in tokens if t.strip(" -\u2013\u2014:,"))
                name = name or "Public Holiday"
                print(f"Holiday match: {line!r} -> {name!r}")
                return name

        print("No closure-date match found for today.")
        return None
    except Exception as e:
        print(f"check_holiday() failed unexpectedly ({e}) — treating as 'not a holiday'.")
        return None


# ---------------- Sheet I/O ----------------

class WebAppUnavailable(RuntimeError):
    """The Apps Script endpoint could not be read safely this run."""



def _retry_delay(attempt: int, response=None) -> float:
    """Use Google's Retry-After hint when present, otherwise exponential backoff."""
    if response is not None:
        retry_after = getattr(response, "headers", {}).get("Retry-After")
        if retry_after:
            try:
                return min(float(retry_after), 30.0)
            except (TypeError, ValueError):
                pass
    return WEB_APP_RETRY_DELAYS[min(attempt - 1, len(WEB_APP_RETRY_DELAYS) - 1)]


def _validate_existing_rows(rows):
    """Reject a successful but unusable response before any write is attempted."""
    if not isinstance(rows, list):
        raise ValueError(f"Expected a JSON list of rows, got {type(rows).__name__}")
    for index, row in enumerate(rows):
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            raise ValueError(
                f"Invalid row at index {index}: expected [date, irl, decision], got {row!r}"
            )
        if any(value is not None and not isinstance(value, str) for value in row[:3]):
            raise ValueError(
                f"Invalid row at index {index}: date, IRL and decision must be strings"
            )
    return rows


def fetch_existing_rows():
    """Fetch Raw rows, tolerating Apps Script redirects, cold starts and transient 404s.

    Content Service responses are redirected to a one-time
    ``script.googleusercontent.com`` URL. Every retry starts from the stable
    ``/exec`` URL so it receives a fresh redirect instead of retrying an expired
    one-time URL. If the deployment is genuinely unavailable, fail closed: the
    caller must not scrape or write without first reading the Sheet, because
    doing so could create duplicate rows.
    """
    if not WEB_APP_URL:
        raise WebAppUnavailable("WEB_APP_URL is empty.")

    print(f"WEB_APP_URL length: {len(WEB_APP_URL)} | starts: {WEB_APP_URL[:45]!r} | ends: {WEB_APP_URL[-15:]!r}")
    last_error = None
    for attempt in range(1, WEB_APP_GET_ATTEMPTS + 1):
        try:
            print(f"Attempt {attempt}/{WEB_APP_GET_ATTEMPTS}: fetching existing rows...")
            # requests follows the Apps Script Content Service redirect by default;
            # make that contract explicit and prevent a cached redirect response.
            resp = requests.get(
                WEB_APP_URL,
                params={"action": "raw"},
                headers={"Accept": "application/json", "Cache-Control": "no-cache"},
                timeout=90,
                allow_redirects=True,
            )
            final_url = getattr(resp, "url", "")
            final_host = urlsplit(final_url).netloc if final_url else "unknown"
            print(
                f"Existing-rows fetch status: {resp.status_code} | "
                f"final URL host: {final_host!r} | "
                f"first 300 chars of body: {resp.text[:300]!r}"
            )

            if resp.status_code in WEB_APP_RETRYABLE_STATUS_CODES:
                last_error = requests.exceptions.HTTPError(
                    f"Apps Script returned HTTP {resp.status_code}", response=resp
                )
                if attempt < WEB_APP_GET_ATTEMPTS:
                    delay = _retry_delay(attempt, resp)
                    print(f"Transient Apps Script response; retrying in {delay:g}s...")
                    time.sleep(delay)
                    continue
                break

            resp.raise_for_status()
            try:
                rows = resp.json()
            except ValueError as e:
                last_error = e
                if attempt < WEB_APP_GET_ATTEMPTS:
                    delay = _retry_delay(attempt)
                    print(f"Apps Script returned non-JSON data; retrying in {delay:g}s...")
                    time.sleep(delay)
                    continue
                break
            try:
                return _validate_existing_rows(rows)  # list of [date, irl, decision]
            except ValueError as e:
                last_error = e
                if attempt < WEB_APP_GET_ATTEMPTS:
                    delay = _retry_delay(attempt)
                    print(f"Apps Script returned an invalid row payload; retrying in {delay:g}s...")
                    time.sleep(delay)
                    continue
                break
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            last_error = e
            print(f"Attempt {attempt} failed: {e}")
            if attempt < WEB_APP_GET_ATTEMPTS:
                delay = _retry_delay(attempt)
                print(f"Retrying in {delay:g}s...")
                time.sleep(delay)
        except requests.exceptions.HTTPError as e:
            last_error = e
            # Non-retryable HTTP errors (for example 401/403) should be reported
            # immediately; retrying cannot repair a permissions/deployment error.
            break
        except ValueError as e:
            last_error = e
            if attempt < WEB_APP_GET_ATTEMPTS:
                delay = _retry_delay(attempt)
                print(f"Apps Script returned an invalid payload; retrying in {delay:g}s...")
                time.sleep(delay)
                continue
            break
        except requests.exceptions.RequestException as e:
            # SSLError, ChunkedEncodingError and other transient transport
            # failures that can self-heal in CI on retry.
            last_error = e
            print(f"Attempt {attempt} failed with transport error: {e}")
            if attempt < WEB_APP_GET_ATTEMPTS:
                delay = _retry_delay(attempt)
                print(f"Retrying in {delay:g}s...")
                time.sleep(delay)

    detail = str(last_error) if last_error else "unknown error"
    deployment_hint = ""
    if isinstance(last_error, requests.exceptions.HTTPError) and getattr(getattr(last_error, "response", None), "status_code", None) == 404:
        deployment_hint = (
            " A persistent 404 usually means the deployment was removed or the "
            "secret contains an old URL; redeploy the Apps Script as a Web App and "
            "update the WEB_APP_URL secret."
        )
    raise WebAppUnavailable(
        "Google Apps Script data endpoint unavailable after "
        f"{WEB_APP_GET_ATTEMPTS} attempts: {detail}.{deployment_hint} Verify that "
        "WEB_APP_URL is the current deployed /exec URL and that the Web App is "
        "accessible to anyone who has the link. This run was skipped without "
        "writing data."
    ) from last_error


def push_new_rows(rows):
    resp = requests.post(WEB_APP_URL, json={"action": "append_rows", "rows": rows}, timeout=90)
    resp.raise_for_status()
    result = resp.json()
    print("Server response:", result)
    return result


def set_no_file_placeholder(date_str, message):
    """Insert-or-overwrite (never duplicates) the placeholder row for date_str."""
    resp = requests.post(WEB_APP_URL, json={
        "action": "set_no_file_placeholder",
        "date": date_str,
        "message": message,
    }, timeout=90)
    resp.raise_for_status()
    result = resp.json()
    print("Placeholder upsert response:", result)
    return result


def clear_no_file_placeholder(date_str):
    """Remove a stale placeholder for date_str, if one exists. No-op if not."""
    try:
        resp = requests.post(WEB_APP_URL, json={
            "action": "clear_no_file_placeholder",
            "date": date_str,
        }, timeout=90)
        if resp.status_code != 200:
            print(f"Placeholder clear returned {resp.status_code} — treating as no-op.")
            return None
        result = resp.json()
        print("Placeholder clear response:", result)
        return result
    except requests.exceptions.RequestException as e:
        print(f"Placeholder clear failed ({e}) — continuing (non-fatal).")
        return None


def _is_placeholder_row(row):
    """Return True if a [date, irl, decision] row looks like a placeholder
    rather than real visa-decision data."""
    decision = (row[2] or "").strip()
    irl = (row[1] or "").strip()
    # Known placeholder messages
    if decision in _PLACEHOLDER_DECISIONS:
        return True
    if decision.startswith("Embassy is closed"):
        return True
    # Real IRL numbers contain "IRL" or digits; placeholders have neither
    if irl and ("IRL" in irl.upper() or any(ch.isdigit() for ch in irl)):
        return False
    return True


# ---------------- main ----------------

def main():
    if not WEB_APP_URL:
        print("ERROR: WEB_APP_URL env var not set.")
        sys.exit(1)

    today_dt = now_ist()
    today_ist = today_dt.strftime("%Y-%m-%d")

    try:
        existing_rows = fetch_existing_rows()
    except WebAppUnavailable as e:
        # Never continue with an empty/fabricated baseline: that could duplicate
        # every historical row. A skipped run is safer than a failed write.
        message = f"WARNING: {e}"
        print(message)
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::error::{message}")
        # Fail visibly so GitHub Actions alerts on a stale/invalid deployment or
        # secret, but do not continue into scraping or any write operation.
        sys.exit(1)

    existing_irl = {r[1] for r in existing_rows if not _is_placeholder_row(r)}

    # Only skip if today already has REAL data (not just a placeholder)
    today_real = [r for r in existing_rows if r[0] == today_ist and not _is_placeholder_row(r)]
    if today_real:
        print(f"Real data already present for {today_ist} ({len(today_real)} rows) — skipping this run.")
        return

    # --- Priority 1: weekend ---
    weekday = today_dt.weekday()  # Monday=0 ... Sunday=6
    if weekday in (5, 6):
        print(f"Today ({today_ist}) is a weekend — no scrape attempted.")
        if ENABLE_NO_UPLOAD_PLACEHOLDER:
            set_no_file_placeholder(today_ist, WEEKEND_MESSAGE)
        else:
            print("ENABLE_NO_UPLOAD_PLACEHOLDER is false — skipping placeholder.")
        return

    # --- Priority 2: public holiday per embassy closure-dates page ---
    holiday_name = check_holiday(today_dt)
    if holiday_name:
        print(f"Today ({today_ist}) is a listed closure date: {holiday_name!r} — no scrape attempted.")
        if ENABLE_NO_UPLOAD_PLACEHOLDER:
            set_no_file_placeholder(today_ist, f"Embassy is closed today for {holiday_name}")
        else:
            print("ENABLE_NO_UPLOAD_PLACEHOLDER is false — skipping placeholder.")
        return

    # --- Priority 3: normal business day, attempt the real scrape ---
    no_file_found = True
    scrape_failed = False
    new_rows = []
    try:
        ods_url = find_ods_link()
        filename, df = download_and_parse_ods(ods_url)
        fetch_date = parse_date_from_filename(filename)

        app_col, decision_col = detect_columns(df)
        if not app_col or not decision_col:
            raise RuntimeError(f"Could not detect columns. Headers seen: {list(df.columns)}")

        no_file_found = False
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
            print(f"No file found this run — upserting placeholder for {today_ist}.")
            set_no_file_placeholder(today_ist, NO_UPLOAD_MESSAGE)
        else:
            print("ENABLE_NO_UPLOAD_PLACEHOLDER is false — skipping placeholder.")
    else:
        print(f"File was found this run — clearing any stale placeholder for {fetch_date}.")
        clear_no_file_placeholder(fetch_date)

    if scrape_failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
