#!/usr/bin/env python3
"""
Employment-permit processing-date tracker — GitHub Actions cron job.

Each run:
1. Fetches the Department of Enterprise (DETE) current processing dates.
2. Finds every permit category's "applications received on" date.
3. Computes the lag vs today (calendar days + weeks).
4. Appends one row per (run date, category) to data/work_permits.json
   (creates it if missing).
5. Skips pairs already recorded (cron re-runs are safe).

The JSON file mirrors the data/stamp_1g.json schema so the dashboard
reuses the same rendering + projection code. Categories are short stable
keys (see SHORT_KEYS); unknown future labels fall back to a truncated
version of the page text.

Requirements:
    pip install requests beautifulsoup4

Run:
    python track_permits.py
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
    print(f"ERROR: missing dependency ({exc}). "
          f"Run: pip install requests beautifulsoup4", file=sys.stderr)
    sys.exit(2)


DETE_URL = (
    "https://enterprise.gov.ie/en/what-we-do/workplace-and-skills/"
    "employment-permits/current-application-processing-dates/"
)

DATA_FILE = Path(__file__).resolve().parent / "data" / "work_permits.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/139.0 Safari/537.36"
    )
}

# The page sentence we anchor on; everything before it is intro text whose
# dates (e.g. "As of 04 September 2026") must NOT be picked up as categories.
ANCHOR = "we are processing applications received on the following dates"

# Long page labels -> short stable category keys, matched in order.
# Order matters: "All other New ..." mentions Critical Skills in its
# parenthetical, and "(Renewal)" contains the substring "new" — so the
# exclusions and parenthesised variants come first.
SHORT_KEYS = [
    ("all other new", "Other New"),
    ("critical skills", "Critical Skills"),
    ("general employment", "General (New)"),
    (("intra-company", "(new)"), "ICT (New)"),
    (("intra-company", "(renewal)"), "ICT (Renewal)"),
    (("renewal applications",), "Renewals"),
    (("reviews", "appeals"), "Reviews"),
]


def fetch_dete_page() -> str:
    """Download the DETE page and return its text."""
    response = requests.get(DETE_URL, headers=HEADERS, timeout=30)
    response.raise_for_status()
    return response.text


def parse_date(text: str) -> date | None:
    """Month-name dates as used on the DETE page ("26 August 2026")."""
    text = re.sub(r"\s+", " ", text).strip()
    match = re.search(
        r"\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|"
        r"September|October|November|December)\s+(\d{4})\b",
        text, flags=re.IGNORECASE)
    if match:
        try:
            return datetime.strptime(match.group(0), "%d %B %Y").date()
        except ValueError:
            return None
    return None


def short_key(label: str) -> str:
    """Map a long page label to a short stable category key."""
    low = re.sub(r"\s+", " ", label).strip().lower()
    for needles, key in SHORT_KEYS:
        if isinstance(needles, str):
            needles = (needles,)
        if all(n in low for n in needles):
            return key
    # Unknown future label: truncate, never invent.
    return re.sub(r"\s+", " ", label).strip()[:60] or "Unknown"


def find_permit_dates(html: str) -> dict[str, date]:
    """Map every permit category to the applications-received date shown.

    The page lists "...: [Label1] [Date1] [Label2] [Date2] ..." after the
    anchor sentence, so each date's label is the text since the previous
    date (or the anchor for the first one).
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = re.sub(r"\s+", " ", " ".join(soup.stripped_strings))

    anchor = re.search(ANCHOR, text, re.IGNORECASE)
    if not anchor:
        raise RuntimeError(
            "Could not find the processing-dates section on the DETE page. "
            f"Check the page manually: {DETE_URL}"
        )
    section = text[anchor.end():anchor.end() + 4000]
    dates = list(re.finditer(
        r"\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|"
        r"September|October|November|December)\s+\d{4}\b", section,
        flags=re.IGNORECASE))
    if not dates:
        raise RuntimeError(
            "Anchor found but no category dates after it on the DETE page. "
            f"Check the page manually: {DETE_URL}"
        )
    found: dict[str, date] = {}
    prev_end = 0
    for match in dates:
        label = section[prev_end:match.start()].strip(" :—-–")
        parsed = parse_date(match.group(0))
        prev_end = match.end()
        if parsed and label:
            found.setdefault(short_key(label), parsed)
    if not found:
        raise RuntimeError(
            "Could not pair permit categories with dates on the DETE page. "
            f"Check the page manually: {DETE_URL}"
        )
    return found


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
    """Write history sorted by run date, creating the data/ dir if needed."""
    rows = sorted(rows, key=lambda r: (str(r.get("run_date", "")),
                                       str(r.get("category", ""))))
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")


def append_tracking_rows(dates: dict, today: date | None = None) -> int:
    """Append one row per (run date, category) unless already recorded."""
    today = today or date.today()
    now = datetime.now()
    run_date_str = today.isoformat()

    rows = load_history()
    seen = {(r.get("run_date"), r.get("category")) for r in rows}
    added = 0
    for category, proc_date in dates.items():
        if (run_date_str, category) in seen:
            continue
        lag_days = (today - proc_date).days
        rows.append({
            "run_date": run_date_str,
            "run_time": now.strftime("%H:%M:%S"),
            "category": category,
            "processing_date": proc_date.isoformat(),
            "lag_days": lag_days,
            "lag_weeks": round(lag_days / 7, 2),
        })
        seen.add((run_date_str, category))
        added += 1
    if added:
        save_history(rows)
    return added


def main() -> None:
    print("Checking DETE employment-permit processing dates...")
    print(f"URL: {DETE_URL}")

    try:
        html = fetch_dete_page()
        dates = find_permit_dates(html)

        today = date.today()
        added = append_tracking_rows(dates, today)

        print()
        print(f"Today: {today.strftime('%d/%m/%Y')}")
        for category, proc in dates.items():
            lag_days = (today - proc).days
            print(f"  {category:16s} {proc.strftime('%d/%m/%Y')}  "
                  f"(lag {lag_days} days / {lag_days / 7:.2f} weeks)")

        if added:
            print(f"JSON:    {added} NEW ROW(S) APPENDED -> {DATA_FILE}")
        else:
            print("JSON:    NOT APPENDED (this run date is already recorded)")

    except requests.RequestException as exc:
        print(f"ERROR: Could not fetch the DETE website: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
