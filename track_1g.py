#!/usr/bin/env python3
"""
Stamp 1G processing-date tracker — GitHub Actions cron job.

Each run:
1. Fetches the current ISD processing page.
2. Finds the Stamp 1G processing date shown on the page.
3. Computes the lag vs today (calendar days + weeks).
4. Appends one row per run date to data/stamp_1g.json (creates it if missing).
5. Skips when today's run date is already recorded (cron re-runs are safe).

The JSON file is the dashboard's data source — index.html fetches it
directly and builds advancement-rate + ETA projections from it.

Row schema:
    {
        "run_date": "2026-09-09",        # YYYY-MM-DD, one row max per date
        "run_time": "08:31:05",          # HH:MM:SS local runner time
        "processing_date": "2026-07-04", # ISD Stamp 1G date, YYYY-MM-DD
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


def append_tracking_row(processing_date: date, today: date | None = None) -> bool:
    """
    Append today's measurement unless this run date is already recorded.

    Unlike the original Excel version (which skipped when the ISD date was
    unchanged), one row per run date is kept even when the processing date
    stalls — flat stretches are exactly what the dashboard's advancement-rate
    projections need to see.

    Returns:
        True  -> a new row was added
        False -> this run date is already recorded, nothing appended
    """
    today = today or date.today()
    now = datetime.now()
    run_date_str = today.isoformat()

    rows = load_history()
    if any(r.get("run_date") == run_date_str for r in rows):
        return False

    lag_days = (today - processing_date).days
    rows.append({
        "run_date": run_date_str,
        "run_time": now.strftime("%H:%M:%S"),
        "processing_date": processing_date.isoformat(),
        "lag_days": lag_days,
        "lag_weeks": round(lag_days / 7, 2),
    })
    save_history(rows)
    return True


def main() -> None:
    print("Checking ISD Stamp 1G processing date...")
    print(f"URL: {ISD_URL}")

    try:
        html = fetch_isd_page()
        processing_date = find_stamp_1g_date(html)

        today = date.today()
        lag_days = (today - processing_date).days

        appended = append_tracking_row(processing_date, today)

        print()
        print(f"Today:             {today.strftime('%d/%m/%Y')}")
        print(f"ISD Stamp 1G date: {processing_date.strftime('%d/%m/%Y')}")
        print(f"Lag:               {lag_days} days ({lag_days / 7:.2f} weeks)")

        if appended:
            print(f"JSON:              NEW ROW APPENDED -> {DATA_FILE}")
        else:
            print("JSON:              NOT APPENDED (this run date is already recorded)")

    except requests.RequestException as exc:
        print(f"ERROR: Could not fetch the ISD website: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
