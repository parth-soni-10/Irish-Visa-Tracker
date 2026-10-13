#!/usr/bin/env python3
"""
Community timelines sync — GitHub Actions cron job (nightly).

Pulls community-timeline submissions (visitors reporting their own
applied -> decided dates), validates + dedupes them, and merges them into
data/community_timelines.json, which the dashboard aggregates into
"community-reported wait" panels. Nothing is ever deleted here; bad rows
are just skipped (and logged) so a spam wave can't poison the file.

Two separate forms (one per tracker, matching the site's split UI):
  - "timelines-visa" — embassy-visa form on the Suggestions tab
  - "timelines-1g"   — Stamp 1G form on the 1G page
The legacy single "timelines" form (with a tracker dropdown) is still
read when present, so old submissions keep flowing after the split.

Where the submissions live: the forms used to be Netlify Forms, and the
Worker that replaced them (worker.js) writes every POST into the `submissions`
table of D1 (form, fields, created_at). It also serves those rows back at
GET /api/community-submissions — the three timeline form names only, never the
`suggestions` form — and this reads that endpoint. No Cloudflare API token, no
repo secret, nothing to configure: the job runs on a fresh fork unchanged, and
an empty answer means nobody has reported a timeline yet.

(It used to query D1's API directly, which needed a CLOUDFLARE_API_TOKEN repo
secret. A missing secret did not fail the job — it printed SKIP and exited 0 —
so the panels stayed empty with nothing on screen saying why.)

Row schema:
    {"tracker": "visa", "applied": "2026-06-01", "decided": "2026-08-20",
     "outcome": "granted", "submitted_at": "2026-09-09T10:00:00Z"}

Run:
    python sync_timelines.py
    WEB_APP_URL=http://localhost:8787 python sync_timelines.py   # against wrangler dev
"""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path

import requests

REPO_DIR = Path(__file__).resolve().parent
DATA_DIR = REPO_DIR / "data"
DATA_FILE = DATA_DIR / "community_timelines.json"

FORM_NAMES = ("timelines-visa", "timelines-1g", "timelines")
FORM_TRACKER_DEFAULT = {
    "timelines-visa": "visa",
    "timelines-1g": "1g",
    "timelines": "",
}
MAX_ROWS = 2000
# The site's endpoint caps its own read (worker.js MAX_TIMELINE_ROWS); this is
# the form list it serves, and test_timelines.py fails if the two drift apart.
TRACKERS = ("visa", "1g")
OUTCOMES = ("granted", "refused")

DEFAULT_SITE_URL = "https://irish-visa-tracker.parth10.workers.dev"
SUBMISSIONS_PATH = "/api/community-submissions"


def valid_entry(data, today=None):
    """Normalize + validate one submission payload.

    Returns a clean row dict, or None when the submission is unusable
    (bad dates, applied after decided, future dates, unknown enums).
    """
    today = today or date.today()
    if not isinstance(data, dict):
        return None
    tracker = str(data.get("tracker", "")).strip().lower()
    outcome = str(data.get("outcome", "")).strip().lower()
    if tracker not in TRACKERS or outcome not in OUTCOMES:
        return None
    try:
        applied = date.fromisoformat(str(data.get("applied", ""))[:10])
        decided = date.fromisoformat(str(data.get("decided", ""))[:10])
    except ValueError:
        return None
    if not (date(2020, 1, 1) <= applied <= decided <= today):
        return None
    submitted = str(data.get("submitted_at", "") or "")[:19]
    return {"tracker": tracker,
            "applied": applied.isoformat(),
            "decided": decided.isoformat(),
            "outcome": outcome,
            "submitted_at": submitted}


def merge(existing, incoming):
    """Dedupe on (tracker, applied, decided, outcome); cap; sort by date."""
    seen = {(r.get("tracker"), r.get("applied"),
             r.get("decided"), r.get("outcome")) for r in existing
            if isinstance(r, dict)}
    merged = [r for r in existing if isinstance(r, dict)]
    for row in incoming:
        key = (row["tracker"], row["applied"], row["decided"], row["outcome"])
        if key not in seen:
            seen.add(key)
            merged.append(row)
    merged.sort(key=lambda r: (str(r.get("decided", "")),
                               str(r.get("submitted_at", ""))))
    return merged[:MAX_ROWS]


def community_stats(rows, tracker):
    """Median applied->decided wait for a tracker, or None when empty."""
    waits = []
    for r in rows:
        if not isinstance(r, dict) or r.get("tracker") != tracker:
            continue
        try:
            waits.append((date.fromisoformat(r["decided"])
                          - date.fromisoformat(r["applied"])).days)
        except (ValueError, TypeError, KeyError):
            continue
    if not waits:
        return None
    waits.sort()
    mid = len(waits) // 2
    median = waits[mid] if len(waits) % 2 else (waits[mid - 1] + waits[mid]) / 2
    return {"n": len(waits), "median": median}


def iso_utc(value):
    """D1's datetime('now') ("2026-09-09 10:00:00", UTC) as an ISO string.

    A space would sort before every "T" for the same date, which would shuffle
    mixed rows in the dashboard's ordering, so it becomes a T (and the string
    is marked Z — valid_entry trims back to whole seconds when it stores it).
    """
    text = str(value or "").strip()
    if not text:
        return ""
    if "T" not in text:
        text = text.replace(" ", "T", 1)
    return text if text.endswith("Z") else text + "Z"


def rows_from_records(records):
    """Turn the endpoint's rows into submission payloads.

    `fields` arrives as the JSON text the Worker stored, and `created_at` as
    D1's own datetime string; an unreadable blob is skipped and logged rather
    than failing the run.
    """
    out = []
    for record in records:
        if not isinstance(record, dict):
            continue
        data = record.get("fields")
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except ValueError:
                print("WARNING: skipping submission with unreadable fields "
                      f"(id {record.get('id', '?')}, form {record.get('form')})")
                continue
        if not isinstance(data, dict):
            continue
        form = str(record.get("form", ""))
        default_tracker = FORM_TRACKER_DEFAULT.get(form, "")
        if not str(data.get("tracker", "")).strip() and default_tracker:
            data["tracker"] = default_tracker
        data["submitted_at"] = iso_utc(record.get("created_at", ""))
        out.append(data)
    return out


def fetch_submissions(site_url):
    """All timeline-form submissions the Worker serves (one request).

    Reads the site's own endpoint — every form in FORM_NAMES (the two split
    forms plus the legacy combined one) in one call — and returns the rows as
    submission payloads. No credential is sent or needed.
    """
    resp = requests.get(site_url.rstrip("/") + SUBMISSIONS_PATH, timeout=30)
    resp.raise_for_status()
    payload = resp.json()
    records = payload.get("submissions") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        raise RuntimeError("unexpected payload from the submissions endpoint: "
                           f"{str(payload)[:200]}")
    return rows_from_records(records)


def load_existing():
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def main():
    site_url = os.environ.get("WEB_APP_URL", "").strip() or DEFAULT_SITE_URL
    raw = fetch_submissions(site_url)
    print(f"Fetched {len(raw)} form submissions from {site_url}.")
    today = date.today()
    incoming, bad = [], 0
    for data in raw:
        row = valid_entry(data, today)
        if row:
            incoming.append(row)
        else:
            bad += 1
    print(f"Valid: {len(incoming)}, rejected: {bad}.")

    existing = load_existing()
    merged = merge(existing, incoming)
    if merged == existing:
        print("No new timelines — file unchanged.")
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    print(f"Merged {len(merged)} community timelines -> {DATA_FILE}.")


if __name__ == "__main__":
    main()
