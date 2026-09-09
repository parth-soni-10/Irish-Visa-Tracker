#!/usr/bin/env python3
"""
One-time migration: Google Sheet (via Apps Script) -> data/*.json.

Run once via the migrate.yml workflow (manual dispatch), which provides
WEB_APP_URL from secrets. Fetches the full ?action=raw history and the
?action=meta object and writes them as data/visa_decisions.json and
data/visa_meta.json. Afterwards the normal scraper owns those files and
this script is never needed again.

Row validation mirrors scraper._validate_history_rows so a bad export
fails loudly instead of seeding a corrupt baseline.
"""

import json
import os
import sys
import time
from pathlib import Path

import requests

REPO_DIR = Path(__file__).resolve().parent
DATA_DIR = REPO_DIR / "data"
WEB_APP_URL = os.environ.get("WEB_APP_URL", "").strip()


def _get(action):
    last = None
    for attempt in range(1, 4):
        try:
            resp = requests.get(
                WEB_APP_URL,
                params={"action": action, "_": str(int(time.time() * 1000))},
                headers={"Accept": "application/json", "Cache-Control": "no-cache"},
                timeout=90,
                allow_redirects=True,
            )
            resp.raise_for_status()
            return resp.json()
        except (requests.exceptions.RequestException, ValueError) as e:
            last = e
            print(f"Attempt {attempt}/3 for ?action={action} failed: {e}")
            time.sleep(10 * attempt)
    print(f"ERROR: could not fetch ?action={action} after 3 attempts: {last}")
    sys.exit(1)


def main():
    if not WEB_APP_URL:
        print("ERROR: WEB_APP_URL env var not set.")
        sys.exit(1)

    rows = _get("raw")
    if not isinstance(rows, list):
        print(f"ERROR: expected a JSON list of rows, got {type(rows).__name__}.")
        sys.exit(1)
    for i, row in enumerate(rows):
        if (not isinstance(row, (list, tuple)) or len(row) < 3
                or any(v is not None and not isinstance(v, str) for v in row[:3])):
            print(f"ERROR: invalid row at index {i}: {row!r}.")
            sys.exit(1)

    try:
        meta = _get("meta")
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - meta is nice-to-have, rows are the point
        print(f"WARNING: ?action=meta unavailable ({e}); writing rows only.")
        meta = None

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "visa_decisions.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {len(rows)} rows to data/visa_decisions.json.")
    if isinstance(meta, dict) and meta.get("lastRunAt"):
        (DATA_DIR / "visa_meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print("Wrote data/visa_meta.json.")
    else:
        print("No usable meta object; skipping data/visa_meta.json "
              "(the next scraper run will create it).")


if __name__ == "__main__":
    main()
