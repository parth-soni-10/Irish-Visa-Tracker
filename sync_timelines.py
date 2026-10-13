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
table of D1 (form, fields, created_at). This reads that table over the D1
query API — one call, all three form names — so the nightly job follows the
site instead of looking at a service the site no longer posts to.

Setup (once):
1. Cloudflare dashboard -> My Profile -> API Tokens -> Create Token ->
   "D1 Edit" (read is enough today, but Edit lets the same token be reused
   for a repair) scoped to the account.
2. Repo Settings -> Secrets and variables -> Actions -> add the token as
   CLOUDFLARE_API_TOKEN.
3. The account id and D1 database id ride along as plain values in
   timelines.yml: they are identifiers, not credentials, and the database id
   is already published in wrangler.toml.

Row schema:
    {"tracker": "visa", "applied": "2026-06-01", "decided": "2026-08-20",
     "outcome": "granted", "submitted_at": "2026-09-09T10:00:00Z"}

Run:
    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
      CLOUDFLARE_D1_DATABASE_ID=... python sync_timelines.py
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
MAX_FETCH = 5000
TRACKERS = ("visa", "1g")
OUTCOMES = ("granted", "refused")

D1_QUERY_URL = ("https://api.cloudflare.com/client/v4/accounts/{account_id}"
                "/d1/database/{database_id}/query")


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


def fetch_submissions(account_id, database_id, token):
    """All timeline-form submissions from the Worker's D1 store.

    Reads every form in FORM_NAMES (the two split forms plus the legacy
    combined one) in one query, tags rows with the form's default tracker
    when the submission itself carries none, and returns them combined.
    """
    placeholders = ", ".join("?" * len(FORM_NAMES))
    resp = requests.post(
        D1_QUERY_URL.format(account_id=account_id, database_id=database_id),
        headers={"Authorization": f"Bearer {token}"},
        json={
            "sql": ("SELECT form, fields, created_at FROM submissions "
                    f"WHERE form IN ({placeholders}) ORDER BY id LIMIT {MAX_FETCH}"),
            "params": list(FORM_NAMES),
        },
        timeout=30)
    resp.raise_for_status()
    payload = resp.json()
    if not payload.get("success"):
        errors = payload.get("errors") or []
        detail = "; ".join(str(e.get("message", e)) for e in errors) or "unknown"
        raise RuntimeError(f"D1 query failed: {detail}")

    out = []
    # One statement, so one result entry — but stay permissive about shape.
    for result in payload.get("result") or []:
        for record in result.get("results") or []:
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


def load_existing():
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def main():
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    database_id = os.environ.get("CLOUDFLARE_D1_DATABASE_ID", "").strip()
    if not token or not account_id or not database_id:
        print("SKIP: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / "
              "CLOUDFLARE_D1_DATABASE_ID not all set. "
              "See sync_timelines.py header for setup.")
        return

    raw = fetch_submissions(account_id, database_id, token)
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
