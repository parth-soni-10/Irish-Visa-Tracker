#!/usr/bin/env python3
"""
Community timelines sync — GitHub Actions cron job (nightly).

Pulls community-timeline Netlify Form submissions (visitors reporting
their own applied -> decided dates), validates + dedupes them, and merges
them into data/community_timelines.json, which the dashboard aggregates
into "community-reported wait" panels. Nothing is ever deleted here; bad
rows are just skipped (and logged) so a spam wave can't poison the file.

Two separate forms (one per tracker, matching the site's split UI):
  - "timelines-visa" — embassy-visa form on the Suggestions tab
  - "timelines-1g"   — Stamp 1G form on the 1G page
The legacy single "timelines" form (with a tracker dropdown) is still
read when present, so old submissions keep flowing after the split.

Setup (once):
1. Deploy the site (both form markups must be live — Netlify only
   registers forms it sees at deploy time).
2. Netlify dashboard -> User settings -> Applications -> New access token.
3. Site settings -> General -> Site details -> copy the Site ID
   (API ID field).
4. Repo Settings -> Secrets and variables -> Actions -> add NETLIFY_TOKEN
   and NETLIFY_SITE_ID.

Row schema:
    {"tracker": "visa", "applied": "2026-06-01", "decided": "2026-08-20",
     "outcome": "granted", "submitted_at": "2026-09-09T10:00:00Z"}

Run:
    NETLIFY_TOKEN=... NETLIFY_SITE_ID=... python sync_timelines.py
"""

from __future__ import annotations

import json
import os
import sys
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
TRACKERS = ("visa", "1g")
OUTCOMES = ("granted", "refused")


def valid_entry(data, today=None):
    """Normalize + validate one Netlify submission payload.

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


def fetch_submissions(token, site_id):
    """All timeline-form submissions via the Netlify API.

    Reads every registered form in FORM_NAMES (the two split forms plus
    the legacy combined one), tags rows with the form's default tracker
    when the submission itself carries none, and returns them combined.
    """
    headers = {"Authorization": f"Bearer {token}"}
    forms = requests.get(
        f"https://api.netlify.com/api/v1/sites/{site_id}/forms",
        headers=headers, timeout=30)
    forms.raise_for_status()
    wanted = [f for f in forms.json()
              if f.get("name") in FORM_NAMES and f.get("id")]
    if not wanted:
        print("No timeline forms (timelines-visa / timelines-1g) registered "
              "on this site yet — deploy first, then re-run.")
        return []
    out = []
    for form in wanted:
        default_tracker = FORM_TRACKER_DEFAULT.get(form.get("name"), "")
        subs = requests.get(
            f"https://api.netlify.com/api/v1/forms/{form['id']}/submissions",
            headers=headers, timeout=30)
        subs.raise_for_status()
        for s in subs.json():
            data = dict(s.get("data", {}) or {})
            if not str(data.get("tracker", "")).strip() and default_tracker:
                data["tracker"] = default_tracker
            data["submitted_at"] = s.get("created_at", "")
            out.append(data)
    return out


def load_existing():
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def main():
    token = os.environ.get("NETLIFY_TOKEN", "").strip()
    site_id = os.environ.get("NETLIFY_SITE_ID", "").strip()
    if not token or not site_id:
        print("SKIP: NETLIFY_TOKEN / NETLIFY_SITE_ID not set. "
              "See sync_timelines.py header for setup.")
        return

    raw = fetch_submissions(token, site_id)
    print(f"Fetched {len(raw)} form submissions.")
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
