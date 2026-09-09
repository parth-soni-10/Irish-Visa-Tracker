"""Unit tests for track_1g.py — ISD Stamp 1G parsing + JSON history logic."""

import json
import unittest
from datetime import date
from unittest.mock import patch

import track_1g


class ParseDateTests(unittest.TestCase):
    def test_month_name_format(self):
        self.assertEqual(track_1g.parse_date("Stamp 1G 4 July 2026"),
                         date(2026, 7, 4))

    def test_short_year_slash_format_current_isd_style(self):
        self.assertEqual(track_1g.parse_date("1G 04/07/26"), date(2026, 7, 4))

    def test_full_year_slash_format(self):
        self.assertEqual(track_1g.parse_date("1G 04/07/2026"), date(2026, 7, 4))

    def test_dash_and_dot_formats(self):
        self.assertEqual(track_1g.parse_date("1G 04-07-2026"), date(2026, 7, 4))
        self.assertEqual(track_1g.parse_date("1G 04.07.2026"), date(2026, 7, 4))

    def test_no_date_returns_none(self):
        self.assertIsNone(track_1g.parse_date("Stamp 1G processing times"))

    def test_invalid_date_returns_none(self):
        self.assertIsNone(track_1g.parse_date("1G 99/99/2026"))


class FindStamp1GDateTests(unittest.TestCase):
    TABLE_HTML = """
    <html><body><table>
      <tr><th>Permission</th><th>Date</th></tr>
      <tr><td>Stamp 1</td><td>01/06/26</td></tr>
      <tr><td>Stamp 1G</td><td>04/07/26</td></tr>
    </table></body></html>
    """

    def test_finds_date_in_table_row(self):
        self.assertEqual(track_1g.find_stamp_1g_date(self.TABLE_HTML),
                         date(2026, 7, 4))

    def test_finds_date_in_plain_text(self):
        html = "<html><body><p>Renewing Stamp 1G applications, currently processing 4 July 2026.</p></body></html>"
        self.assertEqual(track_1g.find_stamp_1g_date(html), date(2026, 7, 4))

    def test_missing_date_raises(self):
        with self.assertRaises(RuntimeError):
            track_1g.find_stamp_1g_date("<html><body><p>No dates here.</p></body></html>")


class FindAllStampDatesTests(unittest.TestCase):
    TABLEPRESS_HTML = """
    <html><body><table class="tablepress">
      <thead><tr><th>Stamp Category</th><th>Submission Date*</th></tr></thead>
      <tbody>
      <tr><td>1, 1H</td><td>29/07/26</td></tr>
      <tr><td>1G</td><td>04/07/26</td></tr>
      <tr><td>2, 2A, 1A</td><td>27/06/26</td></tr>
      <tr><td>4</td><td>13/07/26</td></tr>
      <tr><td>All other categories</td><td>02/08/26</td></tr>
      </tbody>
    </table></body></html>
    """

    def test_parses_every_category(self):
        self.assertEqual(
            track_1g.find_all_stamp_dates(self.TABLEPRESS_HTML),
            {"1, 1H": date(2026, 7, 29), "1G": date(2026, 7, 4),
             "2, 2A, 1A": date(2026, 6, 27), "4": date(2026, 7, 13),
             "Other": date(2026, 8, 2)})

    def test_falls_back_to_1g_finder(self):
        html = ("<html><body><p>Renewing Stamp 1G applications, "
                "currently processing 4 July 2026.</p></body></html>")
        self.assertEqual(track_1g.find_all_stamp_dates(html),
                         {"1G": date(2026, 7, 4)})

    def test_raises_when_nothing_found(self):
        with self.assertRaises(RuntimeError):
            track_1g.find_all_stamp_dates(
                "<html><body><p>No dates here.</p></body></html>")

    def test_normalize_category(self):
        self.assertEqual(track_1g.normalize_category("  Stamp 1G "), "1G")
        self.assertEqual(track_1g.normalize_category("All other categories"), "Other")


class HistoryTests(unittest.TestCase):
    def test_append_and_dedupe_by_run_date_and_category(self):
        with patch.object(track_1g, "load_history", return_value=[]), \
             patch.object(track_1g, "save_history") as save:
            added = track_1g.append_tracking_rows(
                {"1G": date(2026, 7, 4), "4": date(2026, 7, 13)},
                today=date(2026, 9, 9))
            self.assertEqual(added, 2)
            rows = save.call_args.args[0]
            by_cat = {r["category"]: r for r in rows}
            self.assertEqual(by_cat["1G"]["lag_days"], 67)
            self.assertAlmostEqual(by_cat["1G"]["lag_weeks"], 9.57)
            self.assertEqual(by_cat["4"]["processing_date"], "2026-07-13")

    def test_same_run_date_and_category_skipped(self):
        existing = [{"run_date": "2026-09-09", "category": "1G",
                     "processing_date": "2026-07-04",
                     "lag_days": 67, "lag_weeks": 9.57}]
        with patch.object(track_1g, "load_history", return_value=existing), \
             patch.object(track_1g, "save_history") as save:
            added = track_1g.append_tracking_rows(
                {"1G": date(2026, 7, 5), "4": date(2026, 7, 13)},
                today=date(2026, 9, 9))
            self.assertEqual(added, 1)  # only the new category appends
            self.assertEqual(len(save.call_args.args[0]), 2)
            self.assertEqual(save.call_args.args[0][-1]["category"], "4")

    def test_legacy_rows_without_category_count_as_1g(self):
        existing = [{"run_date": "2026-09-09",
                     "processing_date": "2026-07-04",
                     "lag_days": 67, "lag_weeks": 9.57}]
        with patch.object(track_1g, "load_history", return_value=existing), \
             patch.object(track_1g, "save_history") as save:
            added = track_1g.append_tracking_rows(
                {"1G": date(2026, 7, 4)}, today=date(2026, 9, 9))
            self.assertEqual(added, 0)
            save.assert_not_called()

    def test_stalled_processing_date_still_recorded_next_day(self):
        # Flat stretches matter for projections — a new run date always appends.
        existing = [{"run_date": "2026-09-08", "category": "1G",
                     "processing_date": "2026-07-04",
                     "lag_days": 66, "lag_weeks": 9.43}]
        with patch.object(track_1g, "load_history", return_value=list(existing)), \
             patch.object(track_1g, "save_history") as save:
            added = track_1g.append_tracking_rows(
                {"1G": date(2026, 7, 4)}, today=date(2026, 9, 9))
            self.assertEqual(added, 1)
            self.assertEqual(len(save.call_args.args[0]), 2)

    def test_save_sorts_by_run_date(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "data" / "stamp_1g.json"
            with patch.object(track_1g, "DATA_FILE", target):
                track_1g.save_history([
                    {"run_date": "2026-09-09"},
                    {"run_date": "2026-09-07"},
                ])
                saved = json.loads(target.read_text(encoding="utf-8"))
                self.assertEqual([r["run_date"] for r in saved],
                                 ["2026-09-07", "2026-09-09"])


if __name__ == "__main__":
    unittest.main()
