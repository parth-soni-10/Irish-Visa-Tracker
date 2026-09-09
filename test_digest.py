"""Unit tests for digest.py — message builder + send paths."""

import unittest
from unittest.mock import patch

import digest


VISA = [
    ["2026-09-09", "100", "Approved"],
    ["2026-09-09", "101", "Approved"],
    ["2026-09-09", "102", "Refused"],
    ["2026-09-09", "NO_FILE_2026-09-09", "x"],  # placeholder, must not count
    ["2026-09-08", "099", "Approved"],          # yesterday, must not count
]
G1 = [{"run_date": "2026-09-09", "category": "1G",
       "processing_date": "2026-07-04", "lag_days": 67}]
PERMITS = [
    {"run_date": "2026-09-09", "category": "Critical Skills",
     "processing_date": "2026-08-26", "lag_days": 14},
    {"run_date": "2026-09-08", "category": "Critical Skills",
     "processing_date": "2026-08-25", "lag_days": 14},
    {"run_date": "2026-09-09", "category": "Reviews",
     "processing_date": "2026-01-24", "lag_days": 228},
]


class BuildDigestTests(unittest.TestCase):
    def test_weekday_with_data(self):
        msg = digest.build_digest_message(VISA, G1, PERMITS, "2026-09-09")
        self.assertIn("3 decisions today", msg)
        self.assertIn("66.7% granted", msg)
        self.assertIn("Stamp 1G: processing 2026-07-04 (lag 67d)", msg)
        self.assertIn("Critical Skills 26 Aug", msg)
        self.assertIn("Reviews 24 Jan", msg)
        self.assertIn("irishvisaupdatetracker.netlify.app", msg)

    def test_weekday_without_file(self):
        msg = digest.build_digest_message([], G1, [], "2026-09-09")
        self.assertIn("not yet published", msg)
        self.assertIn("Permits: no data yet", msg)

    def test_weekend(self):
        # 2026-09-13 is a Sunday.
        msg = digest.build_digest_message(VISA, [], [], "2026-09-13")
        self.assertIn("office closed (weekend)", msg)
        self.assertIn("Stamp 1G: no data yet", msg)

    def test_newest_observation_per_category_wins(self):
        msg = digest.build_digest_message([], [], PERMITS, "2026-09-09")
        self.assertIn("Critical Skills 26 Aug", msg)
        self.assertNotIn("25 Aug", msg)


class SendTests(unittest.TestCase):
    def test_missing_secrets_skip(self):
        with patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("TELEGRAM_BOT_TOKEN", None)
            os.environ.pop("TELEGRAM_CHAT_ID", None)
            digest.main()  # must not raise

    def test_failed_post_exits_1(self):
        with patch("digest.requests.post") as post:
            post.return_value = type("R", (), {"status_code": 400,
                                               "text": "bad"})()
            with self.assertRaises(SystemExit) as e:
                digest.send_message("tok", "chat", "hi")
            self.assertEqual(e.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
