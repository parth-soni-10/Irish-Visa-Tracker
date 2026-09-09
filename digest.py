#!/usr/bin/env python3
"""
Daily Telegram digest — GitHub Actions cron job.

Reads the three local JSON histories (no network except Telegram) and
posts a one-message summary to a Telegram channel/chat. Runs after the
morning scrapes (12:30 IST) so the numbers are fresh.

Setup (once, ~5 min):
1. Message @BotFather on Telegram -> /newbot -> copy the token.
2. Create a channel (or use your own chat), add the bot as admin
   (channels) so it can post.
3. Get the chat id: send a message in the chat, then open
   https://api.telegram.org/bot<TOKEN>/getUpdates and read
   message.chat.id (channels look like -1001234567890).
4. Repo Settings -> Secrets and variables -> Actions -> add
   TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.

Unset secrets = the job prints SKIP and exits 0 (never fails the run).

Run:
    TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... python digest.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

REPO_DIR = Path(__file__).resolve().parent
DATA_DIR = REPO_DIR / "data"

DASHBOARD_URL = "https://irishvisaupdatetracker.netlify.app/"


def _load(name):
    try:
        data = json.loads((DATA_DIR / name).read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _classify(decision):
    s = (decision or "").lower()
    if any(k in s for k in ("approv", "grant", "accept", "issu")):
        return "accepted"
    if any(k in s for k in ("refus", "reject", "deny", "denied")):
        return "rejected"
    return "other"


def _is_placeholder(row):
    """Mirror of the dashboard/scraper placeholder convention."""
    irl = str(row[1] if len(row) > 1 else "").strip()
    dec = str(row[2] if len(row) > 2 else "").strip()
    if irl.startswith("NO_FILE_"):
        return True
    if dec in ("Saturday/Sunday, Visa Office is closed",
               "Visa office hasn't uploaded any sheet until now, check "
               "back later, or come back tomorrow"):
        return True
    return dec.startswith("Embassy is closed")


def _fmt_day(iso):
    y, m, d = (int(x) for x in iso.split("-"))
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return f"{d} {months[m - 1]}"


def build_digest_message(visa_rows, g1_rows, permit_rows, today_iso):
    """Pure message builder: ([date, irl, decision]…, 1G rows, permit rows,
    'YYYY-MM-DD') -> Telegram text. Tested; keep it dependency-free."""
    lines = []
    try:
        weekday = datetime.strptime(today_iso, "%Y-%m-%d").weekday()
    except ValueError:
        weekday = 0
    lines.append(f"Irish trackers — {_fmt_day(today_iso)}")
    lines.append("")

    today_real = [r for r in visa_rows
                  if len(r) > 2 and r[0] == today_iso and not _is_placeholder(r)]
    if weekday in (5, 6):
        lines.append("Embassy visas: office closed (weekend)")
    elif today_real:
        acc = sum(1 for r in today_real if _classify(r[2]) == "accepted")
        pct = round(acc / len(today_real) * 100, 1)
        lines.append(f"Embassy visas: {len(today_real)} decisions today, "
                     f"{pct}% granted")
    else:
        lines.append("Embassy visas: today's file not yet published")

    g1 = [r for r in g1_rows
          if isinstance(r, dict) and r.get("category", "1G") == "1G"
          and r.get("processing_date")]
    if g1:
        latest = max(g1, key=lambda r: str(r.get("run_date", "")))
        lines.append(f"Stamp 1G: processing {latest['processing_date']} "
                     f"(lag {latest.get('lag_days', '?')}d)")
    else:
        lines.append("Stamp 1G: no data yet")

    cats = {}
    for r in permit_rows:
        if not isinstance(r, dict) or not r.get("processing_date"):
            continue
        key = (str(r.get("run_date", "")), str(r.get("category", "")))
        cats[key] = r
    if cats:
        # Newest observation per category.
        newest = {}
        for (_, cat), r in sorted(cats.items()):
            newest[cat] = r
        bits = [f"{c} {_fmt_day(newest[c]['processing_date'])}" for c in newest]
        lines.append("Permits: " + " · ".join(bits))
    else:
        lines.append("Permits: no data yet")

    lines.append("")
    lines.append(DASHBOARD_URL)
    return "\n".join(lines)


def send_message(token, chat_id, text):
    resp = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text,
              "disable_web_page_preview": True},
        timeout=30)
    if resp.status_code >= 300:
        print(f"Telegram returned {resp.status_code}: {resp.text[:200]}")
        sys.exit(1)
    print("Digest posted to Telegram.")


def main():
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        print("SKIP: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set. "
              "See digest.py header for the 5-minute setup.")
        return

    ist = timezone(timedelta(hours=5, minutes=30))
    today = datetime.now(ist).strftime("%Y-%m-%d")
    text = build_digest_message(_load("visa_decisions.json"),
                                _load("stamp_1g.json"),
                                _load("work_permits.json"), today)
    print(text)
    print()
    send_message(token, chat_id, text)


if __name__ == "__main__":
    main()
