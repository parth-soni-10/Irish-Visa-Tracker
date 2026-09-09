"""Unit tests for sync_timelines.py — validation, merge, aggregates."""

import unittest
from datetime import date
from unittest.mock import patch

import sync_timelines


class ValidEntryTests(unittest.TestCase):
    TODAY = date(2026, 9, 9)

    def good(self, **kw):
        base = {"tracker": "visa", "applied": "2026-06-01",
                "decided": "2026-08-20", "outcome": "granted",
                "submitted_at": "2026-09-01T10:00:00Z"}
        base.update(kw)
        return sync_timelines.valid_entry(base, self.TODAY)

    def test_valid_row_passes(self):
        row = self.good()
        self.assertEqual((row["tracker"], row["applied"], row["decided"],
                          row["outcome"]),
                         ("visa", "2026-06-01", "2026-08-20", "granted"))

    def test_rejects_bad_enums(self):
        self.assertIsNone(self.good(tracker="permits"))
        self.assertIsNone(self.good(outcome="pending"))

    def test_rejects_bad_chronology(self):
        self.assertIsNone(self.good(applied="2026-08-21"))  # after decided
        self.assertIsNone(self.good(decided="2026-09-10"))  # future
        self.assertIsNone(self.good(applied="2019-01-01"))  # too old
        self.assertIsNone(self.good(applied="not-a-date"))

    def test_case_and_whitespace_tolerant(self):
        row = self.good(tracker=" 1G ", outcome=" Refused ")
        self.assertEqual((row["tracker"], row["outcome"]), ("1g", "refused"))


class MergeTests(unittest.TestCase):
    def test_dedupe_and_cap_and_sort(self):
        existing = [{"tracker": "visa", "applied": "2026-06-01",
                     "decided": "2026-08-20", "outcome": "granted",
                     "submitted_at": "2026-09-01T10:00:00Z"}]
        dup = dict(existing[0], submitted_at="2026-09-02T10:00:00Z")
        new = {"tracker": "1g", "applied": "2026-05-01",
               "decided": "2026-07-15", "outcome": "granted",
               "submitted_at": "2026-09-03T10:00:00Z"}
        merged = sync_timelines.merge(existing, [dup, new])
        self.assertEqual(len(merged), 2)
        self.assertEqual([r["decided"] for r in merged],
                         ["2026-07-15", "2026-08-20"])
        with patch.object(sync_timelines, "MAX_ROWS", 1):
            self.assertEqual(len(sync_timelines.merge(existing, [new])), 1)


class StatsTests(unittest.TestCase):
    ROWS = [
        {"tracker": "visa", "applied": "2026-06-01", "decided": "2026-06-11",
         "outcome": "granted"},
        {"tracker": "visa", "applied": "2026-06-01", "decided": "2026-06-21",
         "outcome": "refused"},
        {"tracker": "visa", "applied": "2026-06-01", "decided": "2026-07-01",
         "outcome": "granted"},
        {"tracker": "1g", "applied": "2026-05-01", "decided": "2026-07-01",
         "outcome": "granted"},
        {"tracker": "visa", "applied": "oops", "decided": "2026-07-01",
         "outcome": "granted"},  # corrupt row skipped, not fatal
    ]

    def test_median_odd(self):
        self.assertEqual(sync_timelines.community_stats(self.ROWS, "visa"),
                         {"n": 3, "median": 20})

    def test_median_single(self):
        self.assertEqual(sync_timelines.community_stats(self.ROWS, "1g"),
                         {"n": 1, "median": 61})

    def test_empty_returns_none(self):
        self.assertIsNone(sync_timelines.community_stats([], "visa"))
        self.assertIsNone(sync_timelines.community_stats(self.ROWS, "permits"))


class FetchTests(unittest.TestCase):
    def test_missing_form_returns_empty(self):
        import requests as rq

        class R:
            def __init__(self, payload):
                self._p = payload
            def raise_for_status(self):
                pass
            def json(self):
                return self._p

        with patch("sync_timelines.requests.get",
                   return_value=R([{"id": "f1", "name": "suggestions"}])):
            self.assertEqual(
                sync_timelines.fetch_submissions("tok", "site"), [])

    def test_submissions_mapped(self):
        import requests as rq  # noqa: F401  (keeps requests import used)

        class R:
            def __init__(self, payload):
                self._p = payload
            def raise_for_status(self):
                pass
            def json(self):
                return self._p

        calls = []

        def fake_get(url, headers=None, timeout=None):
            calls.append(url)
            if url.endswith("/forms"):
                return R([{"id": "f9", "name": "timelines"}])
            return R([{"data": {"tracker": "visa"}, "created_at": "2026-09-01"}])

        with patch("sync_timelines.requests.get", side_effect=fake_get):
            out = sync_timelines.fetch_submissions("tok", "site")
        self.assertEqual(len(calls), 2)
        self.assertEqual(out[0]["tracker"], "visa")
        self.assertEqual(out[0]["submitted_at"], "2026-09-01")


if __name__ == "__main__":
    unittest.main()
