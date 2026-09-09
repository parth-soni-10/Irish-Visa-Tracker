#!/usr/bin/env python3
"""
Community timelines sync — GitHub Actions cron job (nightly).

Pulls "timelines" Netlify Form submissions (visitors reporting their own
applied -> decided dates), validates + dedupes them, and merges them into
data/community_timelines.json, which the dashboard aggregates into
"community-reported wait" panels. Nothing is ever deleted here; bad rows
are just skipped (and logged) so a spam wave can't poison the file.

Setup (once):
1. Deploy the site (the form markup with name="timelines" must be live —
   Netlify only registers forms it sees at deploy time).
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

FORM_NAME = "timelines"
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
    """All 'timelines'-form submissions via the Netlify API."""
    headers = {"Authorization": f"Bearer {token}"}
    forms = requests.get(
        f"https://api.netlify.com/api/v1/sites/{site_id}/forms",
        headers=headers, timeout=30)
    forms.raise_for_status()
    form_id = next((f.get("id") for f in forms.json()
                    if f.get("name") == FORM_NAME), None)
    if not form_id:
        print(f'No "{FORM_NAME}" form registered on this site yet — '
              f"deploy first, then re-run.")
        return []
    subs = requests.get(
        f"https://api.netlify.com/api/v1/forms/{form_id}/submissions",
        headers=headers, timeout=30)
    subs.raise_for_status()
    out = []
    for s in subs.json():
        data = dict(s.get("data", {}) or {})
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
