#!/usr/bin/env python3
"""
Stamp renewal processing-date tracker — GitHub Actions cron job.

Each run:
1. Fetches the current ISD processing page.
2. Finds every stamp category's processing date shown on the page.
3. Computes the lag vs today (calendar days + weeks).
4. Appends one row per (run date, category) to data/stamp_1g.json
   (creates it if missing).
5. Skips pairs already recorded (cron re-runs are safe).

The JSON file is the dashboard's data source — index.html fetches it
directly and builds advancement-rate + ETA projections from it.

Row schema:
    {
        "run_date": "2026-09-09",        # YYYY-MM-DD
        "run_time": "08:31:05",          # HH:MM:SS local runner time
        "category": "1G",                # ISD stamp category (rows written
                                         # before multi-category support
                                         # have no key and count as 1G)
        "processing_date": "2026-07-04", # ISD date for that category
        "lag_days": 67,                  # (run_date - processing_date).days
        "lag_weeks": 9.57                # round(lag_days / 7, 2)
    }

Requirements:
    pip install requests beautifulsoup4

Run:
    python track_1g.py
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date, datetime
from pathlib import Path


try:
    import requests
    from bs4 import BeautifulSoup
except ImportError as exc:  # pragma: no cover - surfaced clearly in cron logs
    print(f"ERROR: missing dependency ({exc}). Run: pip install requests beautifulsoup4",
          file=sys.stderr)
    sys.exit(2)


ISD_URL = (
    "https://www.irishimmigration.ie/registering-your-immigration-permission/"
    "how-to-renew-your-current-permission/"
    "renewing-your-registration-permission-if-you-live-in-the-republic-of-ireland/"
)

# JSON history lives in the repo so the static dashboard can fetch it.
DATA_FILE = Path(__file__).resolve().parent / "data" / "stamp_1g.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/139.0 Safari/537.36"
    )
}


def fetch_isd_page() -> str:
    """Download the ISD page and return its text."""
    response = requests.get(ISD_URL, headers=HEADERS, timeout=30)
    response.raise_for_status()
    return response.text


def parse_date(text: str) -> date | None:
    """
    Try common date formats used by ISD.
    Returns None if no date can be parsed.
    """
    text = re.sub(r"\s+", " ", text).strip()

    patterns = [
        # 4 July 2026
        (r"\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|"
         r"September|October|November|December)\s+(\d{4})\b", "%d %B %Y"),

        # 04/07/2026 or 4/7/2026
        (r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", "%d/%m/%Y"),

        # 04/07/26 or 4/7/26 (ISD currently uses this format)
        (r"\b(\d{1,2})/(\d{1,2})/(\d{2})\b", "%d/%m/%y"),

        # 04-07-2026 or 4-7-2026
        (r"\b(\d{1,2})-(\d{1,2})-(\d{4})\b", "%d-%m-%Y"),

        # 04.07.2026 or 4.7.2026
        (r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b", "%d.%m.%Y"),
    ]

    for pattern, fmt in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            try:
                # Month-name format can be parsed directly.
                return datetime.strptime(match.group(0), fmt).date()
            except ValueError:
                continue

    return None


def find_stamp_1g_date(html: str) -> date:
    """
    Locate the Stamp 1G processing date.

    ISD currently displays the table date as dd/mm/yy (for example
    04/07/26). The HTML structure can change, so this uses several
    fallback methods rather than relying on one exact table structure.
    """
    soup = BeautifulSoup(html, "html.parser")

    # 1. Inspect table rows/cells first.
    for row in soup.find_all("tr"):
        cells = [" ".join(cell.stripped_strings) for cell in row.find_all(["th", "td"])]
        row_text = " ".join(cells)

        if re.search(r"\b1G\b", row_text, re.IGNORECASE):
            parsed = parse_date(row_text)
            if parsed:
                return parsed

    # 2. Inspect the page's visible text. This catches layouts where
    # the table is not represented as normal <tr>/<td> elements.
    page_text = " ".join(soup.stripped_strings)
    matches = list(re.finditer(r"\b1G\b", page_text, re.IGNORECASE))

    for match in matches:
        # Only inspect a reasonably small window after "1G" to avoid
        # accidentally picking up an unrelated date elsewhere.
        window = page_text[match.start():match.start() + 300]
        parsed = parse_date(window)
        if parsed:
            return parsed

    # 3. Inspect raw HTML around "1G". This is useful if the date is
    # separated by HTML tags or generated in a table structure.
    raw_matches = list(re.finditer(r"\b1G\b", html, re.IGNORECASE))

    for match in raw_matches:
        window = re.sub(r"<[^>]+>", " ", html[match.start():match.start() + 1500])
        window = re.sub(r"\s+", " ", window)
        parsed = parse_date(window)
        if parsed:
            return parsed

    raise RuntimeError(
        "Could not find the Stamp 1G processing date on the ISD page. "
        "ISD may have changed its page structure. "
        f"Check the page manually: {ISD_URL}"
    )


def normalize_category(raw: str) -> str:
    """Short stable key for an ISD table category cell."""
    s = re.sub(r"\s+", " ", str(raw)).strip()
    if re.search(r"all\s+other", s, re.IGNORECASE):
        return "Other"
    s = re.sub(r"(?i)^stamp\s+", "", s)
    return s.strip() or "Other"


def find_all_stamp_dates(html: str) -> dict[str, date]:
    """Map every stamp category on the ISD page to its processing date.

    Prefers the timelines table (a table whose header mentions submission /
    processing dates); each subsequent two-cell row reads as
    (category, date). Falls back to the single-date 1G finder so at least
    1G survives a layout change.
    """
    soup = BeautifulSoup(html, "html.parser")
    for table in soup.find_all("table"):
        head = " ".join(" ".join(th.stripped_strings)
                         for th in table.find_all("th"))
        if not re.search(r"submission|processing", head, re.IGNORECASE):
            continue
        if not re.search(r"date|stamp|categor", head, re.IGNORECASE):
            continue
        found: dict[str, date] = {}
        for row in table.find_all("tr"):
            cells = [" ".join(c.stripped_strings)
                     for c in row.find_all(["th", "td"])]
            if len(cells) < 2:
                continue
            # The header row's date cell holds text like "Submission Date*",
            # which never parses — so it filters itself out, no special case.
            parsed = parse_date(cells[1])
            if parsed:
                found.setdefault(normalize_category(cells[0]), parsed)
        if found:
            return found
    # Fallback: at least keep 1G working.
    try:
        return {"1G": find_stamp_1g_date(html)}
    except RuntimeError:
        pass
    raise RuntimeError(
        "Could not find any stamp processing dates on the ISD page. "
        f"Check the page manually: {ISD_URL}"
    )


def load_history() -> list[dict]:
    """Read the JSON history file; return [] when missing or corrupt."""
    if not DATA_FILE.exists():
        return []
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"WARNING: could not read {DATA_FILE} ({exc}); starting fresh.",
              file=sys.stderr)
        return []
    if not isinstance(data, list):
        print(f"WARNING: {DATA_FILE} is not a JSON array; starting fresh.",
              file=sys.stderr)
        return []
    return [r for r in data if isinstance(r, dict)]


def save_history(rows: list[dict]) -> None:
    """Write history sorted by run_date, creating the data/ dir if needed."""
    rows = sorted(rows, key=lambda r: str(r.get("run_date", "")))
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")


def append_tracking_rows(dates: dict, today: date | None = None) -> int:
    """
    Append one row per stamp category unless that (run date, category) pair
    is already recorded. Rows without a category (pre-multi-category
    history) count as 1G for dedupe purposes.

    Unlike the original Excel version (which skipped when the ISD date was
    unchanged), one row per run date is kept even when the processing date
    stalls — flat stretches are exactly what the dashboard's advancement-rate
    projections need to see.

    Returns the number of rows added.
    """
    today = today or date.today()
    now = datetime.now()
    run_date_str = today.isoformat()

    rows = load_history()
    seen = {(r.get("run_date"), r.get("category", "1G")) for r in rows}
    added = 0
    for category, processing_date in dates.items():
        if (run_date_str, category) in seen:
            continue
        lag_days = (today - processing_date).days
        rows.append({
            "run_date": run_date_str,
            "run_time": now.strftime("%H:%M:%S"),
            "category": category,
            "processing_date": processing_date.isoformat(),
            "lag_days": lag_days,
            "lag_weeks": round(lag_days / 7, 2),
        })
        seen.add((run_date_str, category))
        added += 1
    if added:
        save_history(rows)
    return added


def main() -> None:
    print("Checking ISD stamp processing dates...")
    print(f"URL: {ISD_URL}")

    try:
        html = fetch_isd_page()
        dates = find_all_stamp_dates(html)

        today = date.today()
        added = append_tracking_rows(dates, today)

        print()
        print(f"Today: {today.strftime('%d/%m/%Y')}")
        for category, proc in dates.items():
            lag_days = (today - proc).days
            print(f"  {category:12s} {proc.strftime('%d/%m/%Y')}  "
                  f"(lag {lag_days} days / {lag_days / 7:.2f} weeks)")

        if added:
            print(f"JSON:    {added} NEW ROW(S) APPENDED -> {DATA_FILE}")
        else:
            print("JSON:    NOT APPENDED (this run date is already recorded)")

    except requests.RequestException as exc:
        print(f"ERROR: Could not fetch the ISD website: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
