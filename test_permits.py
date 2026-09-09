"""Unit tests for track_permits.py — DETE parsing + JSON history logic."""

import json
import unittest
from datetime import date
from unittest.mock import patch

import track_permits


PAGE_HTML = """
<html><body>
<p>Some intro. As of 04 September 2026, we are processing applications
received on the following dates for the specific types of applications:
Critical Skills Employment Permit Applications 26 August 2026
New General Employment Permit Applications 30 July 2026
All other New Applications (All permit types excluding Critical Skills,
GEPs and I.C.T.) 21 July 2026
Intra-Company Transfer Employment Permit Applications (New) 25 August 2026
Intra-Company Transfer Employment Permit Applications (Renewal) 12 June 2026
Renewal Applications (All renewable permit types included) 11 June 2026
Reviews / Appeals 24 January 2026</p>
</body></html>
"""


class FindPermitDatesTests(unittest.TestCase):
    def test_parses_every_category(self):
        self.assertEqual(
            track_permits.find_permit_dates(PAGE_HTML),
            {"Critical Skills": date(2026, 8, 26),
             "General (New)": date(2026, 7, 30),
             "Other New": date(2026, 7, 21),
             "ICT (New)": date(2026, 8, 25),
             "ICT (Renewal)": date(2026, 6, 12),
             "Renewals": date(2026, 6, 11),
             "Reviews": date(2026, 1, 24)})

    def test_intro_dates_are_not_picked_up(self):
        # "As of 04 September 2026" precedes the anchor and must be ignored.
        found = track_permits.find_permit_dates(PAGE_HTML)
        self.assertNotIn(date(2026, 9, 4), found.values())

    def test_missing_anchor_raises(self):
        with self.assertRaises(RuntimeError):
            track_permits.find_permit_dates(
                "<html><body><p>Nothing here.</p></body></html>")

    def test_short_key_ordering_traps(self):
        # Parenthetical mention must not win; "(Renewal)" contains "new".
        self.assertEqual(
            track_permits.short_key(
                "All other New Applications (All permit types excluding "
                "Critical Skills, GEPs and I.C.T.)"),
            "Other New")
        self.assertEqual(
            track_permits.short_key(
                "Intra-Company Transfer Employment Permit Applications (Renewal)"),
            "ICT (Renewal)")


class HistoryTests(unittest.TestCase):
    def test_append_and_dedupe(self):
        with patch.object(track_permits, "load_history", return_value=[]), \
             patch.object(track_permits, "save_history") as save:
            added = track_permits.append_tracking_rows(
                {"Critical Skills": date(2026, 8, 26)}, today=date(2026, 9, 9))
            self.assertEqual(added, 1)
            row = save.call_args.args[0][0]
            self.assertEqual(row["category"], "Critical Skills")
            self.assertEqual(row["lag_days"], 14)

    def test_same_pair_skipped_other_category_recorded(self):
        existing = [{"run_date": "2026-09-09", "category": "Critical Skills",
                     "processing_date": "2026-08-26", "lag_days": 14,
                     "lag_weeks": 2.0}]
        with patch.object(track_permits, "load_history",
                           return_value=existing), \
             patch.object(track_permits, "save_history") as save:
            added = track_permits.append_tracking_rows(
                {"Critical Skills": date(2026, 8, 26),
                 "Reviews": date(2026, 1, 24)},
                today=date(2026, 9, 9))
            self.assertEqual(added, 1)
            self.assertEqual(save.call_args.args[0][-1]["category"], "Reviews")


if __name__ == "__main__":
    unittest.main()
