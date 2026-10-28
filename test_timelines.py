"""Unit tests for sync_timelines.py - validation, merge, aggregates."""

import ast
import re
import unittest
from datetime import date
from pathlib import Path
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
    """Stand-in for requests.Response around the site's submissions payload."""

    def __init__(self, payload, status_code=200):
        self._p = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._p


def subs_payload(rows):
    return {"submissions": rows}


class FetchTests(unittest.TestCase):
    SITE = "https://tracker.test"
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

    def fetch(self, rows, status_code=200):
        with patch("sync_timelines.requests.get",
                   return_value=Response(subs_payload(rows), status_code)) as get:
            out = sync_timelines.fetch_submissions(self.SITE)
        return out, get

    def test_no_submissions_returns_empty(self):
        out, get = self.fetch([])
        self.assertEqual(out, [])
        self.assertEqual(get.call_args.args[0],
                         self.SITE + "/api/community-submissions")
        # No credential is sent, and none is needed: the endpoint is public and
        # narrow by design, which is the whole point of reading it here.
        self.assertNotIn("Authorization", get.call_args.kwargs.get("headers") or {})

    def test_a_trailing_slash_does_not_double_up(self):
        with patch("sync_timelines.requests.get",
                   return_value=Response(subs_payload([]))) as get:
            sync_timelines.fetch_submissions(self.SITE + "/")
        self.assertEqual(get.call_args.args[0],
                         self.SITE + "/api/community-submissions")

    def test_an_unexpected_payload_is_loud_not_silent(self):
        # A 200 that is not the contract must fail the run, not read as "nobody
        # has reported yet" - which is what left the panels empty before.
        with patch("sync_timelines.requests.get",
                   return_value=Response({"ok": True})):
            with self.assertRaises(RuntimeError):
                sync_timelines.fetch_submissions(self.SITE)

    def test_an_error_status_propagates(self):
        with patch("sync_timelines.requests.get",
                   return_value=Response({}, 503)):
            with self.assertRaises(RuntimeError):
                sync_timelines.fetch_submissions(self.SITE)

    def test_the_form_list_matches_the_function(self):
        """The endpoint serves the Pages Function's TIMELINE_FORMS; the reader's
        list must be the same list, or the sync silently reads a subset of the
        forms.
        """
        worker = (Path(__file__).resolve().parent / "functions" / "_router.js").read_text(
            encoding="utf-8")
        match = re.search(r"TIMELINE_FORMS = \[([^\]]*)\]", worker)
        self.assertIsNotNone(
            match, "functions/_router.js declares no TIMELINE_FORMS - nothing to read")
        self.assertEqual(tuple(ast.literal_eval("[" + match.group(1) + "]")),
                         tuple(sync_timelines.FORM_NAMES))

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

    def test_a_readable_blob_that_is_not_an_object_is_skipped(self):
        rows = [{"id": 9, "form": "timelines-visa", "fields": "[1, 2]",
                 "created_at": "2026-09-04 09:00:00"}]
        out, _ = self.fetch(rows)
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main()
