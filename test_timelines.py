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


class Response:
    """Stand-in for requests.Response around a D1 query payload."""

    def __init__(self, payload):
        self._p = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._p


def d1_payload(rows):
    return {"success": True, "errors": [], "result": [{"results": rows}]}


class FetchTests(unittest.TestCase):
    ROWS = [
        {"id": 1, "form": "timelines-visa",
         "fields": '{"applied": "2026-06-01", "decided": "2026-08-20", '
                   '"outcome": "granted", "form-name": "timelines-visa"}',
         "created_at": "2026-09-01 10:00:00"},
        {"id": 2, "form": "timelines-1g",
         "fields": '{"applied": "2026-05-01", "decided": "2026-07-15", '
                   '"outcome": "refused", "tracker": "1g"}',
         "created_at": "2026-09-02 11:30:00"},
        {"id": 3, "form": "timelines-visa", "fields": "not json",
         "created_at": "2026-09-03 09:00:00"},
    ]

    def fetch(self, rows):
        with patch("sync_timelines.requests.post",
                   return_value=Response(d1_payload(rows))) as post:
            out = sync_timelines.fetch_submissions("acct", "db", "tok")
        return out, post

    def test_no_submissions_returns_empty(self):
        out, post = self.fetch([])
        self.assertEqual(out, [])
        url = post.call_args.args[0]
        self.assertIn("/accounts/acct/d1/database/db/query", url)
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["params"], list(sync_timelines.FORM_NAMES))
        self.assertIn("FROM submissions", body["sql"])

    def test_rows_mapped_with_form_defaults_and_iso_time(self):
        out, _ = self.fetch(self.ROWS)
        # The unreadable blob is skipped, not fatal.
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["tracker"], "visa")   # from the form name
        self.assertEqual(out[0]["submitted_at"], "2026-09-01T10:00:00Z")
        self.assertEqual(out[1]["tracker"], "1g")
        self.assertEqual(out[1]["submitted_at"], "2026-09-02T11:30:00Z")

    def test_rows_feed_validation_and_merge(self):
        out, _ = self.fetch(self.ROWS)
        rows = [r for r in (sync_timelines.valid_entry(d, date(2026, 9, 9))
                            for d in out) if r]
        self.assertEqual(len(rows), 2)
        merged = sync_timelines.merge([], rows)
        self.assertEqual([r["decided"] for r in merged],
                         ["2026-07-15", "2026-08-20"])

    def test_api_error_surfaces(self):
        payload = {"success": False,
                   "errors": [{"message": "no such database"}]}
        with patch("sync_timelines.requests.post",
                   return_value=Response(payload)):
            with self.assertRaises(RuntimeError):
                sync_timelines.fetch_submissions("acct", "db", "tok")


if __name__ == "__main__":
    unittest.main()
