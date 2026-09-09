"""
Irish Visa Decision Tracker — scraper for GitHub Actions
-----------------------------------------------------------
Reads the embassy's visa-decision file and upserts rows into
data/visa_decisions.json in this repo (committed by the workflow).

Every run, in priority order:
  1. If today already has REAL data on record (not just a placeholder) -> skip.
  2. If today is Saturday/Sunday -> upsert "Saturday/Sunday, Visa Office is
     closed", dated TODAY. Also backfill any empty days since the latest real
     data, so a missed weekday run can't leave a hole. Stop (no scrape).
  3. Else check the embassy's closure-dates page for today's date -> if listed,
     upsert "Embassy is closed today for <holiday name>", dated TODAY. Also
     backfill empty days as above. Stop (no scrape attempted).
  4. Else (a normal business day) -> attempt the real scrape. If a file dated
     today (or later) is found, push new rows and clear any stale placeholder
     for its date. Otherwise — the scrape failed, found nothing, or the site
     is still hosting an OLDER file (the file is cumulative and named after its
     last covered day, so an older file just means today's hasn't appeared
     yet) — upsert "Visa office hasn't uploaded any sheet until now, check
     back later, or come back tomorrow", dated TODAY. Every empty day after
     the latest file's date is backfilled too, so a missed run can never
     silently leave a hole in the dashboard.

New rows are dated with the day they were SCRAPED (today), not the date in
 the file's filename — so the daily summary always shows a day's count
 against that day, regardless of which cumulative file the decisions came
 from.

All placeholders use the same insert-or-overwrite mechanism (never duplicate,
always reflect the latest run's message). Once real data lands, its date's
placeholder is cleared automatically.

A gap alert runs on business days: if no genuinely new file has appeared for
GAP_ALERT_BUSINESS_DAYS consecutive business days, the run fails loudly. This
turns a silent site change/outage (which otherwise just writes "no file" rows
forever) into a visible GitHub Actions failure.

Flags (env vars, all optional):
  ENABLE_NO_UPLOAD_PLACEHOLDER "true" (default) or "false" — turns ALL of the
                                above placeholder mechanisms on/off at once.
  GAP_ALERT_BUSINESS_DAYS  "3" (default) — fail the run once no new file has
                                appeared for this many consecutive business
                                days (Mon-Fri, excluding listed closure dates),
                                so a site change or outage shows up as a red
                                GitHub Actions run instead of silent "no file"
                                rows. "0" disables the check.
  ALERT_WEBHOOK_URL         unset (default) — set to a webhook URL to ALSO
                                fire an out-of-band notification outside GitHub
                                whenever the gap alert trips. Accepts Slack /
                                Teams / Discord / Telegram-bot / generic-email-
                                gateway webhook URLs; the payload is shaped to
                                the URL automatically. Webhook failures are
                                always non-fatal (an alert must never suppress
                                the real signal).
"""

import json
import re
import io
import os
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import requests
import pandas as pd
from dateutil import parser as dateparser

PAGE_URL = "https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/"
CLOSURE_DATES_URL = "https://www.ireland.ie/en/india/newdelhi/about/embassy-information/"
# Local JSON history (replaces the old Google Sheet backend): the scraper
# reads/writes these files and the workflow commits them; the dashboard
# fetches them as static assets. DATA_DIR is module-level (not inlined in
# path helpers) so tests can point it at a tmp dir.
DATA_DIR = Path(__file__).resolve().parent / "data"
HISTORY_FILENAME = "visa_decisions.json"
META_FILENAME = "visa_meta.json"
ENABLE_NO_UPLOAD_PLACEHOLDER = os.environ.get("ENABLE_NO_UPLOAD_PLACEHOLDER", "true").strip().lower() == "true"
# Optional out-of-band alert webhook. When set, a POST is fired the moment the
# gap alert trips (not a replacement for the red run — a complement to it).
# Works with any generic webhook (Slack/Teams/Discord/Telegram bot/email-gateway):
# the payload is adapted to the well-known formats automatically. Empty string = off.
ALERT_WEBHOOK_URL = os.environ.get("ALERT_WEBHOOK_URL", "").strip()


def _env_int(name, default):
    try:
        return int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default


# Fail the run once this many consecutive business days (Mon-Fri, excluding
# listed closure dates) have passed without a genuinely new file. 0 disables.
GAP_ALERT_BUSINESS_DAYS = _env_int("GAP_ALERT_BUSINESS_DAYS", 3)


class HistoryError(RuntimeError):
    """The local history file is unreadable or unusable.

    Raised instead of returning an empty list when the file exists but
    cannot be trusted (corrupt JSON, wrong shape): main() fails loudly
    rather than continuing with a fabricated empty baseline, which would
    duplicate history on the next write."""

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
    the history file."""
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
    """Table rows are the primary markup for the closure-dates listing, with
    list markup as a fallback (some sections render it as a list), then cells,
    then sentence-splitting plain text.

    <tr> MUST come first: the captured section can contain unrelated <li>
    markup (footer/nav links), and picking those up first would shadow the
    real closure table entirely (that is exactly what happened — the closure
    rows were never scanned, so no holiday ever matched)."""
    items = re.findall(r"<tr[^>]*>(.*?)</tr>", section_html, re.IGNORECASE | re.DOTALL)
    if not items:
        items = re.findall(r"<li[^>]*>(.*?)</li>", section_html, re.IGNORECASE | re.DOTALL)
    if not items:
        items = re.findall(r"<td[^>]*>(.*?)</td>", section_html, re.IGNORECASE | re.DOTALL)
    if not items:
        text = strip_tags(section_html)
        items = re.split(r"(?<=[.;\n])\s+", text)
    return [strip_tags(i).strip() for i in items if strip_tags(i).strip()]


_MONTH_NAMES = {m.lower(): i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"], start=1)}
_MONTH_ABBR = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
               "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10,
               "nov": 11, "dec": 12}


def _parse_month(word: str):
    """Full or abbreviated month name -> month number (1-12), else None."""
    w = word.lower()
    if w in _MONTH_NAMES:
        return _MONTH_NAMES[w]
    return _MONTH_ABBR.get(w[:3])


def _dates_in_line(line: str):
    """Yield every (day, month) date a closure line mentions, expanding ranges
    like '13 & 14 August' into BOTH days. dateparser keeps only one end of a
    range (and mangles the year), so ranges are handled explicitly here."""
    for m in re.finditer(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:&|and|,|\u2013|\u2014|-)\s*"
        r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\b",
        line, re.IGNORECASE,
    ):
        month = _parse_month(m.group(3))
        if month:
            yield int(m.group(1)), month
            yield int(m.group(2)), month
    for m in re.finditer(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\b",
        line, re.IGNORECASE,
    ):
        month = _parse_month(m.group(2))
        if month:
            yield int(m.group(1)), month


def _holiday_name(line: str) -> str:
    """Best-effort holiday name from a closure row: the row text with the date
    tokens removed. Handles single dates and ranges ('13 & 14 August') alike."""
    cleaned = re.split(
        r"\b\d{1,2}(?:st|nd|rd|th)?\s*(?:&|and|,|\u2013|\u2014|-)\s*\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\b"
        r"|\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\b",
        line,
    )[0]
    return cleaned.strip(" -\u2013\u2014:,") or "Public Holiday"


def check_holiday(today_dt: datetime):
    """Returns a holiday name string if today is a listed embassy closure date,
    else None. Never raises — any parsing failure just means 'not a holiday',
    the safest default (falls through to the normal scrape attempt).

    Matching is two-pass: explicit (day, month) extraction handles the
    structured closure table (including ranges like "13 & 14 August" that
    dateparser mangles); dateparser remains as a fallback for prose formats."""
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
            for day, month in set(_dates_in_line(line)):
                if month == today_dt.month and day == today_dt.day:
                    name = _holiday_name(line)
                    print(f"Holiday match: {line!r} -> {name!r}")
                    return name

        # Fallback for prose formats the structured extraction can't cover.
        for line in lines:
            try:
                parsed, tokens = dateparser.parse(line, fuzzy_with_tokens=True, dayfirst=True)
            except (ValueError, OverflowError, TypeError):
                continue
            if parsed is not None and parsed.month == today_dt.month and parsed.day == today_dt.day:
                name = _holiday_name(line) or "Public Holiday"
                print(f"Holiday match (dateparser): {line!r} -> {name!r}")
                return name

        print("No closure-date match found for today.")
        return None
    except Exception as e:
        print(f"check_holiday() failed unexpectedly ({e}) — treating as 'not a holiday'.")
        return None


def _closure_dates(year):
    """Set of (month, day) closure dates listed for ``year`` on the embassy's
    closure-dates page. Returns an empty set if the page can't be fetched or
    parsed, which makes the gap alert treat weekdays as business days — the
    conservative direction when a site change/outage is suspected."""
    dates = set()
    try:
        resp = requests.get(CLOSURE_DATES_URL, headers=BROWSER_HEADERS, timeout=30)
        if resp.status_code == 200:
            section = extract_closure_section(resp.text, year)
            for line in extract_candidate_lines(section):
                for day, month in _dates_in_line(line):
                    dates.add((month, day))
    except requests.exceptions.RequestException as e:
        print(f"Could not fetch closure-dates page for gap alert ({e}) — "
              f"treating weekdays as business days.")
    return dates


# ---------------- local JSON history (data/visa_decisions.json) ----------------

def _history_path():
    return DATA_DIR / HISTORY_FILENAME


def _meta_path():
    return DATA_DIR / META_FILENAME



def _validate_history_rows(rows):
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


def load_history():
    """Read [date, irl, decision] rows from the repo JSON history file.

    A missing file means no data yet (first run, or pre-migration) and
    returns []. A present-but-unusable file raises HistoryError — main()
    fails loudly instead of continuing with a fabricated empty baseline,
    which would duplicate history on write.
    """
    path = _history_path()
    if not path.exists():
        return []
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise HistoryError(f"cannot read {path}: {e}")
    try:
        return _validate_history_rows(rows)
    except ValueError as e:
        raise HistoryError(str(e))


def save_history(rows):
    """Persist rows in append order (the dashboard sorts by date itself)."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _history_path().write_text(
        json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def push_new_rows(rows, new_rows):
    """Append {date, irl, decision} dicts as [date, irl, decision] arrays."""
    for r in new_rows:
        rows.append([r["date"], r["irl"], r["decision"]])


def set_no_file_placeholder(rows, date_str, message):
    """Insert-or-overwrite (never duplicates) the placeholder row for date_str."""
    key = "NO_FILE_" + date_str
    for r in rows:
        if r[1] == key:
            r[2] = message
            return
    rows.append([date_str, key, message])


def clear_no_file_placeholder(rows, date_str):
    """Remove a stale placeholder for date_str, if one exists. No-op if not."""
    rows[:] = [r for r in rows
               if not (r[0] == date_str and str(r[1]).startswith("NO_FILE_"))]


def update_meta(meta):
    """Best-effort: store the run-status object for the dashboard.

    Local file write replaces the old ?action=meta POST; still non-fatal —
    the history data is the source of truth, not the meta file.
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _meta_path().write_text(
            json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    except OSError as e:
        print(f"Update meta failed ({e}) — continuing (non-fatal).")


def _run_meta(today_dt, existing_irl, new_rows=(), fetch_date=None, file_rows=None,
              ok=True, closure_dates=None):
    """The run-status object stored via ?action=meta for the dashboard's health
    card, reconciliation line and closure calendar. Pure data — no I/O."""
    return {
        "lastRunAt": today_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "sheetRows": len(existing_irl),
        "newRows": len(new_rows),
        "fileDate": fetch_date,
        "fileRows": file_rows,
        "ok": ok,
        "closureDates": sorted(
            f"{today_dt.year:04d}-{m:02d}-{d:02d}" for m, d in (closure_dates or ())),
    }


def send_webhook_alert(message):
    """Fire an out-of-band notification when the gap alert trips.

    Adapts the payload to the well-known webhook formats by host so a single
    URL works with Slack, Teams, Discord, a Telegram bot, or a plain generic/
    email-gateway endpoint:

      * hooks.slack.com            -> text block (Slack)
      * webhook.office.com         -> MessageCard with Text (Microsoft Teams)
      * discord.com/api/webhooks   -> content (Discord)
      * api.telegram.org/...botN/sendMessage -> chat_id + text (Telegram)
      * anything else              -> {"text": ...} generic fallback

    Completely best-effort and NEVER fatal: a webhook outage (network error,
    non-2xx, bad JSON) is logged but must not suppress the real signal — the
    run still fails on the gap alert as before. Only sends when
    ``ALERT_WEBHOOK_URL`` is configured.
    """
    if not ALERT_WEBHOOK_URL:
        return
    host = urlsplit(ALERT_WEBHOOK_URL).netloc.lower()
    data = None
    if "hooks.slack.com" in host:
        data = {"text": message}
    elif "teams.microsoft.com" in host or "webhook.office.com" in host:
        data = {"@type": "MessageCard", "@context": "http://schema.org/extensions",
                "summary": "Visa tracker gap alert", "text": message}
    elif "discord.com" in host:
        data = {"content": message, "username": "Visa Decision Tracker"}
    elif "api.telegram.org" in host:
        # chat_id carried in the URL via ?chat_id=. If absent, the bot simply
        # won't deliver and we fall back to the console message below.
        query = parse_qs(urlsplit(ALERT_WEBHOOK_URL).query)
        data = {"chat_id": query.get("chat_id", [""])[0], "text": message}
    else:
        data = {"text": message}
    try:
        resp = requests.post(ALERT_WEBHOOK_URL, json=data, timeout=30)
        if resp.status_code >= 300:
            print(f"Alert webhook returned {resp.status_code} — alert not delivered "
                  f"(non-fatal; text below).")
        else:
            print("Alert webhook sent successfully.")
    except requests.exceptions.RequestException as e:
        print(f"Alert webhook failed to send ({e}) — non-fatal, the run still "
              f"fails on the gap alert itself as usual.")



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


def _latest_real_date(existing_rows):
    """Newest date that has real (non-placeholder) data, or None if none."""
    dates = []
    for r in existing_rows:
        if _is_placeholder_row(r) or not isinstance(r[0], str):
            continue
        try:
            datetime.strptime(r[0], "%Y-%m-%d")
        except ValueError:
            continue
        dates.append(r[0])
    return max(dates) if dates else None


def _latest_file_date(existing_rows, fetch_date=None):
    """The newest file date we know of this run: today's downloaded file (if
    any) or the latest real-data date already in the sheet, whichever is
    newer. None if we have no real data and no file at all."""
    latest = _latest_real_date(existing_rows)
    if fetch_date and (latest is None or fetch_date > latest):
        return fetch_date
    return latest


def _count_stale_business_days(latest_date_str, today_dt, closure_dates):
    """Number of business days (Mon-Fri, excluding listed embassy closure
    dates) strictly after ``latest_date_str`` through today. This is how many
    days the office could have published a file but, as far as we know,
    hasn't."""
    try:
        start = (datetime.strptime(latest_date_str, "%Y-%m-%d") + timedelta(days=1)).date()
    except (TypeError, ValueError):
        return 0
    count = 0
    cursor = start
    end = today_dt.date()
    while cursor <= end:
        if cursor.weekday() < 5 and (cursor.month, cursor.day) not in closure_dates:
            count += 1
        cursor += timedelta(days=1)
    return count


def _backfill_missing_days(existing_rows, today_dt, anchor=None, skip_date=None):
    """Upsert a placeholder for every date after ``anchor`` through today that
    has no row yet (real or placeholder). ``anchor`` defaults to the newest
    real-data date on record. Weekends get the closed-office message, other
    days the no-upload message.

    Idempotent: dates that already have a row are left untouched, so repeated
    runs never duplicate or rewrite placeholders. This is what guarantees a
    missed run (or a stale-file day like Aug 12-14 2026) can never leave a
    silent hole in the daily summary."""
    if anchor is None:
        anchor = _latest_real_date(existing_rows)
    if not anchor:
        return
    try:
        start = (datetime.strptime(anchor, "%Y-%m-%d") + timedelta(days=1)).date()
    except ValueError:
        return
    existing_dates = {r[0] for r in existing_rows}
    cursor = start
    end = today_dt.date()
    while cursor <= end:
        date_str = cursor.strftime("%Y-%m-%d")
        if date_str != skip_date and date_str not in existing_dates:
            message = WEEKEND_MESSAGE if cursor.weekday() in (5, 6) else NO_UPLOAD_MESSAGE
            print(f"Backfilling placeholder for {date_str}: {message!r}")
            set_no_file_placeholder(existing_rows, date_str, message)
            existing_dates.add(date_str)
        cursor += timedelta(days=1)


# ---------------- main ----------------

def main():
    """Load history, run, always persist — even on failure paths, so
    placeholders written before a gap-alert exit are not lost."""
    try:
        existing_rows = load_history()
    except HistoryError as e:
        # Never continue with an empty/fabricated baseline: that could
        # duplicate history on write. A failed run is safer.
        print(f"ERROR: {e}")
        sys.exit(1)
    print(f"Loaded {len(existing_rows)} history rows from {_history_path()}.")
    try:
        code = _run(existing_rows)
    finally:
        save_history(existing_rows)
    if code:
        sys.exit(code)


def _run(existing_rows):
    today_dt = now_ist()
    today_ist = today_dt.strftime("%Y-%m-%d")

    existing_irl = {r[1] for r in existing_rows if not _is_placeholder_row(r)}

    # Only skip if today already has REAL data (not just a placeholder)
    today_real = [r for r in existing_rows if r[0] == today_ist and not _is_placeholder_row(r)]
    if today_real:
        print(f"Real data already present for {today_ist} ({len(today_real)} rows) — skipping this run.")
        update_meta(_run_meta(today_dt, existing_irl))
        return

    # --- Priority 1: weekend ---
    weekday = today_dt.weekday()  # Monday=0 ... Sunday=6
    if weekday in (5, 6):
        print(f"Today ({today_ist}) is a weekend — no scrape attempted.")
        if ENABLE_NO_UPLOAD_PLACEHOLDER:
            set_no_file_placeholder(existing_rows, today_ist, WEEKEND_MESSAGE)
            # Heal any weekday gaps left by missed runs.
            _backfill_missing_days(existing_rows, today_dt, skip_date=today_ist)
        else:
            print("ENABLE_NO_UPLOAD_PLACEHOLDER is false — skipping placeholder.")
        update_meta(_run_meta(today_dt, existing_irl))
        return

    # --- Priority 2: public holiday per embassy closure-dates page ---
    holiday_name = check_holiday(today_dt)
    if holiday_name:
        print(f"Today ({today_ist}) is a listed closure date: {holiday_name!r} — no scrape attempted.")
        if ENABLE_NO_UPLOAD_PLACEHOLDER:
            set_no_file_placeholder(existing_rows, today_ist, f"Embassy is closed today for {holiday_name}")
            # Heal any gaps left by missed runs.
            _backfill_missing_days(existing_rows, today_dt, skip_date=today_ist)
        else:
            print("ENABLE_NO_UPLOAD_PLACEHOLDER is false — skipping placeholder.")
        update_meta(_run_meta(today_dt, existing_irl))
        return

    # --- Priority 3: normal business day, attempt the real scrape ---
    scrape_failed = False
    new_rows = []
    fetch_date = None  # date embedded in the downloaded file's name — used for
                       # staleness/placeholder decisions only; rows are dated today
    file_rows = None   # decision rows in the latest file — for the reconciliation line
    try:
        ods_url = find_ods_link()
        filename, df = download_and_parse_ods(ods_url)
        fetch_date = parse_date_from_filename(filename)
        file_rows = len(df)

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
            new_rows.append({"date": today_ist, "irl": irl, "decision": decision})
            existing_irl.add(irl)

        print(f"{len(new_rows)} new rows to push (out of {len(df)} rows in file).")
        if new_rows:
            push_new_rows(existing_rows, new_rows)
        else:
            print("File fetched fine, nothing new in it — Sheet already up to date.")

    except Exception as e:
        scrape_failed = True
        print(f"Scrape step failed: {e}")

    if ENABLE_NO_UPLOAD_PLACEHOLDER:
        # The embassy's file is CUMULATIVE ("decisions made from 1 January to
        # <date>") and named after its last covered day, published the
        # following morning. "No file for date X" is therefore true for every
        # X strictly after the latest file's date — even when the site still
        # hosts, and we successfully parse, an older file. Treating a stale
        # file as success used to silently drop the day's placeholder, leaving
        # whole days with no row in the dashboard (Aug 12-14 2026).
        if new_rows:
            # Real data landed and is stamped with today's date — today is not
            # a "no file" day. Clear any stale placeholder for it.
            print(f"Real data for {today_ist} pushed ({len(new_rows)} rows) — "
                  f"clearing any stale placeholder for {today_ist}.")
            clear_no_file_placeholder(existing_rows, today_ist)
        elif fetch_date is None:
            # Scrape failed outright — we can't see the latest file, so at
            # minimum make sure today's placeholder exists.
            print(f"No file found this run — upserting placeholder for {today_ist}.")
            set_no_file_placeholder(existing_rows, today_ist, NO_UPLOAD_MESSAGE)
        elif fetch_date < today_ist:
            # A stale file was scraped but had nothing new (its decisions were
            # already recorded). Today's file hasn't been published yet, so
            # today gets the no-upload note and every empty gap day from the
            # latest file's date through today is backfilled too — a missed
            # run can never silently leave a hole in the daily summary.
            print(f"Latest file ({fetch_date}) predates today ({today_ist}) — "
                  f"ensuring placeholders for every gap day.")
            _backfill_missing_days(existing_rows, today_dt, anchor=fetch_date)
        else:
            # File dated today (or later) is live — no placeholder needed.
            print(f"File for {fetch_date} found — clearing any stale placeholder for {fetch_date}.")
            clear_no_file_placeholder(existing_rows, fetch_date)
    else:
        print("ENABLE_NO_UPLOAD_PLACEHOLDER is false — skipping placeholder.")

    # The closure page feeds both the gap alert below and the dashboard's
    # closure calendar, so fetch it once per run.
    closure_dates = _closure_dates(today_dt.year)

    # --- Gap alert: a site change or publication outage can make the scraper
    # quietly write "no file yet" every day while the run still reports
    # success. Fail loudly instead once no genuinely-new file has appeared for
    # 3+ consecutive business days, so a broken .ods-link pattern or an
    # unreachable embassy page shows up as a red run instead of silent gaps.
    if GAP_ALERT_BUSINESS_DAYS > 0:
        latest_file_date = _latest_file_date(existing_rows, fetch_date)
        if latest_file_date:
            stale_days = _count_stale_business_days(latest_file_date, today_dt, closure_dates)
            if stale_days >= GAP_ALERT_BUSINESS_DAYS:
                message = (
                    f"ALERT: no new visa-decisions file has appeared for {stale_days} "
                    f"consecutive business days (latest file dated {latest_file_date}; "
                    f"today is {today_ist}). This usually means the embassy page markup "
                    f"changed or the site is unreachable. Verify the .ods link pattern in "
                    f"find_ods_link() and the live page. (Set GAP_ALERT_BUSINESS_DAYS=0 to "
                    f"disable this check.)"
                )
                print(message)
                if os.environ.get("GITHUB_ACTIONS") == "true":
                    print(f"::error::{message}")
                # Push the alert outside GitHub too, so it isn't missed if
                # nobody is watching the Actions tab. Best-effort by design.
                send_webhook_alert(message)
                return 1

    # --- Store run status for the dashboard (?action=meta) ---
    # The health card, "fully synced" line and closure calendar on Home all
    # render from this object, so a run only ends after it is recorded.
    update_meta(_run_meta(today_dt, existing_irl, new_rows, fetch_date, file_rows,
                          ok=not scrape_failed, closure_dates=closure_dates))

    if scrape_failed:
        return 1


if __name__ == "__main__":
    main()
