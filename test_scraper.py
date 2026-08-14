import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

import scraper


IST = timezone(timedelta(hours=5, minutes=30))


def ist(dt_str, hour=11):
    """Fixed IST datetime for tests, e.g. ist("2026-08-14")."""
    return datetime.fromisoformat(dt_str).replace(tzinfo=IST).replace(hour=hour)


class FetchExistingRowsTests(unittest.TestCase):
    def setUp(self):
        self.original_url = scraper.WEB_APP_URL
        scraper.WEB_APP_URL = "https://script.google.com/macros/s/test/exec"

    def tearDown(self):
        scraper.WEB_APP_URL = self.original_url

    @staticmethod
    def response(status_code, payload=None, body="", url="https://script.googleusercontent.com/macros/echo"):
        response = Mock()
        response.status_code = status_code
        response.headers = {}
        response.text = body
        response.url = url
        response.json.return_value = payload
        response.raise_for_status.side_effect = (
            None if status_code < 400 else scraper.requests.exceptions.HTTPError(response=response)
        )
        return response

    @patch("scraper.time.sleep")
    @patch("scraper.requests.get")
    def test_retries_transient_redirect_404_from_fresh_exec_url(self, get, sleep):
        get.side_effect = [
            self.response(404, body="expired redirect"),
            self.response(200, payload=[["2026-08-01", "IRL123", "Granted"]]),
        ]

        rows = scraper.fetch_existing_rows()

        self.assertEqual(rows, [["2026-08-01", "IRL123", "Granted"]])
        self.assertEqual(get.call_count, 2)
        self.assertEqual(get.call_args_list[0].args[0], scraper.WEB_APP_URL)
        self.assertEqual(get.call_args_list[1].args[0], scraper.WEB_APP_URL)
        self.assertEqual(get.call_args_list[0].kwargs["allow_redirects"], True)
        sleep.assert_called_once_with(scraper.WEB_APP_RETRY_DELAYS[0])

    @patch("scraper.time.sleep")
    @patch("scraper.requests.get")
    def test_malformed_success_payload_is_not_used_for_writes(self, get, sleep):
        get.return_value = self.response(200, payload=[["2026-08-01", "IRL123"]])

        with self.assertRaises(scraper.WebAppUnavailable):
            scraper.fetch_existing_rows()

        self.assertEqual(get.call_count, scraper.WEB_APP_GET_ATTEMPTS)

    @patch("scraper.time.sleep")
    @patch("scraper.requests.get")
    def test_persistent_endpoint_failure_is_wrapped(self, get, sleep):
        get.return_value = self.response(404, body="deployment not found")

        with self.assertRaises(scraper.WebAppUnavailable) as caught:
            scraper.fetch_existing_rows()

        self.assertIn(f"after {scraper.WEB_APP_GET_ATTEMPTS} attempts", str(caught.exception))
        self.assertEqual(get.call_count, scraper.WEB_APP_GET_ATTEMPTS)
        self.assertEqual(sleep.call_count, scraper.WEB_APP_GET_ATTEMPTS - 1)


class MainFailClosedTests(unittest.TestCase):
    @patch("scraper.find_ods_link")
    @patch("scraper.fetch_existing_rows", side_effect=scraper.WebAppUnavailable("endpoint down"))
    def test_main_skips_scraping_when_sheet_baseline_is_unavailable(self, fetch, find_ods_link):
        scraper.WEB_APP_URL = "https://script.google.com/macros/s/test/exec"

        with self.assertRaises(SystemExit) as exited:
            scraper.main()

        self.assertEqual(exited.exception.code, 1)
        fetch.assert_called_once_with()
        find_ods_link.assert_not_called()

    @patch("scraper.find_ods_link")
    @patch("scraper.fetch_existing_rows", side_effect=scraper.WebAppUnavailable("invalid payload"))
    def test_main_does_not_scrape_after_malformed_sheet_response(self, fetch, find_ods_link):
        scraper.WEB_APP_URL = "https://script.google.com/macros/s/test/exec"

        with self.assertRaises(SystemExit) as exited:
            scraper.main()

        self.assertEqual(exited.exception.code, 1)
        fetch.assert_called_once_with()
        find_ods_link.assert_not_called()


class MainPlaceholderTests(unittest.TestCase):
    """The placeholder / gap-filling decision logic inside main()."""

    def setUp(self):
        self.original_url = scraper.WEB_APP_URL
        scraper.WEB_APP_URL = "https://script.google.com/macros/s/test/exec"

    def tearDown(self):
        scraper.WEB_APP_URL = self.original_url

    @staticmethod
    def run_main(now, existing_rows, filename="20260811_NDVO_Visa_Decisions.ods",
                 new_irls=(), fail_scrape=False, holiday=None):
        """Run main() with everything mocked except the decision logic.
        Returns (push, set_ph, clear_ph, exit_code)."""
        df = scraper.pd.DataFrame(
            [["IRL" + irl, "Granted"] for irl in new_irls],
            columns=["IRL Number", "Decision"],
        )
        with patch("scraper.now_ist", return_value=now), \
             patch("scraper.fetch_existing_rows", return_value=existing_rows), \
             patch("scraper.check_holiday", return_value=holiday), \
             patch("scraper.find_ods_link",
                   side_effect=RuntimeError("site down") if fail_scrape
                   else lambda: "https://example.org/decisions.ods"), \
             patch("scraper.download_and_parse_ods", return_value=(filename, df)), \
             patch("scraper.detect_columns", return_value=("IRL Number", "Decision")), \
             patch("scraper.push_new_rows") as push, \
             patch("scraper.set_no_file_placeholder") as set_ph, \
             patch("scraper.clear_no_file_placeholder") as clear_ph:
            try:
                scraper.main()
                exited = None
            except SystemExit as e:
                exited = e.code
        return push, set_ph, clear_ph, exited

    def test_stale_file_backfills_all_gap_days_and_today(self):
        # The exact Aug 2026 incident: last file dated 2026-08-11, runs keep
        # succeeding on the 12th-14th while the site still hosts that same
        # file. Every gap day (12, 13, 14) must get a no-upload placeholder.
        now = ist("2026-08-14")
        existing = [
            ["2026-08-11", "IRL100", "Granted"],
            ["2026-08-11", "IRL101", "Refused"],
            ["2026-08-08", "NO_FILE_2026-08-08", scraper.WEEKEND_MESSAGE],
        ]
        push, set_ph, clear_ph, exited = self.run_main(now, existing, new_irls=("100",))
        self.assertIsNone(exited)
        push.assert_not_called()
        self.assertEqual([c.args[0] for c in set_ph.call_args_list],
                         ["2026-08-12", "2026-08-13", "2026-08-14"])
        for c in set_ph.call_args_list:
            self.assertEqual(c.args[1], scraper.NO_UPLOAD_MESSAGE)
        clear_ph.assert_not_called()

    def test_stale_file_with_new_rows_still_places_today_placeholder(self):
        # Normal lag day: the file dated Aug 11 appears on Aug 12 (published
        # the following morning). New rows get pushed dated Aug 11, AND Aug 12
        # gets its "no file yet" placeholder because no file dated Aug 12
        # exists yet.
        now = ist("2026-08-12")
        existing = [["2026-08-10", "IRL100", "Granted"]]
        push, set_ph, clear_ph, exited = self.run_main(now, existing, new_irls=("101",))
        self.assertIsNone(exited)
        push.assert_called_once()
        self.assertEqual(push.call_args.args[0],
                         [{"date": "2026-08-11", "irl": "IRL101", "decision": "Granted"}])
        self.assertEqual([c.args[0] for c in set_ph.call_args_list], ["2026-08-12"])
        clear_ph.assert_not_called()

    def test_file_dated_today_clears_placeholder_and_skips_placeholder(self):
        now = ist("2026-08-12")
        existing = [["2026-08-11", "IRL100", "Granted"]]
        push, set_ph, clear_ph, exited = self.run_main(
            now, existing, filename="20260812_NDVO_Visa_Decisions.ods", new_irls=("200",))
        self.assertIsNone(exited)
        push.assert_called_once()
        self.assertEqual(push.call_args.args[0][0]["date"], "2026-08-12")
        clear_ph.assert_called_once_with("2026-08-12")
        set_ph.assert_not_called()

    def test_scrape_failure_places_today_only_and_fails(self):
        now = ist("2026-08-14")
        existing = [["2026-08-11", "IRL100", "Granted"]]
        push, set_ph, clear_ph, exited = self.run_main(now, existing, fail_scrape=True)
        self.assertEqual(exited, 1)
        self.assertEqual([c.args[0] for c in set_ph.call_args_list], ["2026-08-14"])
        self.assertEqual(set_ph.call_args.args[1], scraper.NO_UPLOAD_MESSAGE)
        push.assert_not_called()

    def test_weekend_creates_closed_placeholder_and_heals_weekday_gaps(self):
        # Saturday Aug 15: weekend placeholder for today, plus backfill of the
        # weekday gaps (12, 13, 14) since the last real data (Aug 11).
        now = ist("2026-08-15")
        existing = [["2026-08-11", "IRL100", "Granted"]]
        push, set_ph, clear_ph, exited = self.run_main(now, existing)
        self.assertIsNone(exited)
        calls = {c.args[0]: c.args[1] for c in set_ph.call_args_list}
        self.assertEqual(calls["2026-08-15"], scraper.WEEKEND_MESSAGE)
        self.assertEqual(calls["2026-08-12"], scraper.NO_UPLOAD_MESSAGE)
        self.assertEqual(calls["2026-08-13"], scraper.NO_UPLOAD_MESSAGE)
        self.assertEqual(calls["2026-08-14"], scraper.NO_UPLOAD_MESSAGE)
        self.assertEqual(len(calls), 4)
        push.assert_not_called()

    def test_holiday_creates_closed_placeholder_and_heals_gaps(self):
        now = ist("2026-08-13")
        existing = [["2026-08-11", "IRL100", "Granted"]]
        push, set_ph, clear_ph, exited = self.run_main(
            now, existing, holiday="Embassy Closed for Relocation")
        self.assertIsNone(exited)
        calls = {c.args[0]: c.args[1] for c in set_ph.call_args_list}
        self.assertEqual(calls["2026-08-13"],
                         "Embassy is closed today for Embassy Closed for Relocation")
        self.assertEqual(calls["2026-08-12"], scraper.NO_UPLOAD_MESSAGE)
        self.assertEqual(len(calls), 2)
        push.assert_not_called()

    def test_backfill_uses_weekend_message_for_weekend_gaps(self):
        # Monday Aug 17, still nothing newer than Aug 11 (office relocation
        # gap). Weekend gap days must get the closed-office message, weekdays
        # the no-upload message.
        now = ist("2026-08-17")
        existing = [["2026-08-11", "IRL100", "Granted"]]
        push, set_ph, clear_ph, exited = self.run_main(now, existing)
        self.assertIsNone(exited)
        calls = {c.args[0]: c.args[1] for c in set_ph.call_args_list}
        self.assertEqual(calls["2026-08-15"], scraper.WEEKEND_MESSAGE)
        self.assertEqual(calls["2026-08-16"], scraper.WEEKEND_MESSAGE)
        self.assertEqual(calls["2026-08-12"], scraper.NO_UPLOAD_MESSAGE)
        self.assertEqual(calls["2026-08-13"], scraper.NO_UPLOAD_MESSAGE)
        self.assertEqual(calls["2026-08-14"], scraper.NO_UPLOAD_MESSAGE)
        self.assertEqual(calls["2026-08-17"], scraper.NO_UPLOAD_MESSAGE)
        self.assertEqual(len(calls), 6)
        push.assert_not_called()

    def test_today_real_data_skips_entirely(self):
        now = ist("2026-08-12")
        existing = [["2026-08-12", "IRL100", "Granted"]]
        push, set_ph, clear_ph, exited = self.run_main(now, existing)
        self.assertIsNone(exited)
        push.assert_not_called()
        set_ph.assert_not_called()
        clear_ph.assert_not_called()

    def test_backfill_skips_dates_that_already_have_rows(self):
        # Second run of the day: Aug 12 placeholder already exists -> only
        # genuinely missing days (13, 14) get upserted. No duplicates ever.
        now = ist("2026-08-14")
        existing = [
            ["2026-08-11", "IRL100", "Granted"],
            ["2026-08-12", "NO_FILE_2026-08-12", scraper.NO_UPLOAD_MESSAGE],
        ]
        push, set_ph, clear_ph, exited = self.run_main(now, existing)
        self.assertIsNone(exited)
        self.assertEqual([c.args[0] for c in set_ph.call_args_list],
                         ["2026-08-13", "2026-08-14"])
        push.assert_not_called()

    def test_placeholder_rows_do_not_count_as_real_data(self):
        self.assertTrue(scraper._is_placeholder_row(
            ["2026-08-12", "NO_FILE_2026-08-12", scraper.NO_UPLOAD_MESSAGE]))
        self.assertTrue(scraper._is_placeholder_row(
            ["2026-08-08", "NO_FILE_2026-08-08", scraper.WEEKEND_MESSAGE]))
        self.assertTrue(scraper._is_placeholder_row(
            ["2026-08-13", "NO_FILE_2026-08-13", "Embassy is closed today for X"]))
        self.assertFalse(scraper._is_placeholder_row(["2026-08-11", "IRL100", "Granted"]))


class HolidayParsingTests(unittest.TestCase):
    """check_holiday / extract_candidate_lines against controlled HTML."""

    TABLE = """
    <div id="closure-dates-2026">
      <table>
        <tr><td>New Year's Day</td><td>01 January</td><td>Thursday</td></tr>
        <tr><td>Embassy Closed for Relocation</td><td>13 & 14 August</td><td>Thursday and Friday</td></tr>
        <tr><td>August Bank Holiday</td><td>03 August</td><td>Monday</td></tr>
      </table>
      <ul><li>Footer link one</li><li>Footer link two</li></ul>
    </div>
    """

    @staticmethod
    def mock_page(get, html):
        resp = Mock()
        resp.status_code = 200
        resp.text = html
        get.return_value = resp

    def test_candidate_lines_prefer_table_over_footer_lists(self):
        section = scraper.extract_closure_section(self.TABLE, 2026)
        lines = scraper.extract_candidate_lines(section)
        joined = "\n".join(lines)
        self.assertIn("Embassy Closed for Relocation", joined)
        self.assertIn("New Year's Day", joined)
        self.assertNotIn("Footer link", joined)

    def test_range_date_matches_both_days(self):
        with patch("scraper.requests.get") as get:
            self.mock_page(get, self.TABLE)
            self.assertEqual(scraper.check_holiday(ist("2026-08-13")),
                             "Embassy Closed for Relocation")
            self.assertEqual(scraper.check_holiday(ist("2026-08-14")),
                             "Embassy Closed for Relocation")
            self.assertIsNone(scraper.check_holiday(ist("2026-08-15")))

    def test_single_date_holiday_matches(self):
        with patch("scraper.requests.get") as get:
            self.mock_page(get, self.TABLE)
            self.assertEqual(scraper.check_holiday(ist("2026-01-01")), "New Year's Day")
            self.assertEqual(scraper.check_holiday(ist("2026-08-03")), "August Bank Holiday")
            self.assertIsNone(scraper.check_holiday(ist("2026-08-04")))

    def test_whole_page_fallback_still_works_when_anchor_missing(self):
        # No closure-dates-2026 anchor: the whole page is scanned, and the
        # closure table inside it must still be found (not shadowed by <li>).
        with patch("scraper.requests.get") as get:
            self.mock_page(get, self.TABLE)
            section = scraper.extract_closure_section(self.TABLE, 2027)
            self.assertEqual(section, self.TABLE)  # fallback: whole page
            lines = scraper.extract_candidate_lines(section)
            joined = "\n".join(lines)
            self.assertIn("Embassy Closed for Relocation", joined)
            self.assertNotIn("Footer link", joined)


class FilenameDateTests(unittest.TestCase):
    """parse_date_from_filename: valid stamps parse, anything else falls back
    to today so a malformed name can never push garbage dates into the Sheet."""

    def setUp(self):
        self.original_url = scraper.WEB_APP_URL
        scraper.WEB_APP_URL = "https://script.google.com/macros/s/test/exec"

    def tearDown(self):
        scraper.WEB_APP_URL = self.original_url

    @patch("scraper.now_ist", return_value=ist("2026-08-14"))
    def test_parses_valid_stamp(self, _now):
        self.assertEqual(scraper.parse_date_from_filename("20260811_NDVO_Visa_Decisions.ods"),
                         "2026-08-11")
        self.assertEqual(scraper.parse_date_from_filename("visa_20260115.ods"), "2026-01-15")

    @patch("scraper.now_ist", return_value=ist("2026-08-14"))
    def test_falls_back_to_today_for_malformed_names(self, _now):
        cases = [
            "abc-12345678-def.ods",  # UUID-shaped 8 digits, not a real date
            "visa.ods",              # no digits at all
            "x1234567.ods",          # only 7 digits
            "y_20260000.ods",        # month 00
            "y_20261301.ods",        # month 13
            "y_20260230.ods",        # Feb 30
        ]
        for name in cases:
            with self.subTest(name=name):
                self.assertEqual(scraper.parse_date_from_filename(name), "2026-08-14")


class BackfillHelperTests(unittest.TestCase):
    """Direct unit tests for _latest_real_date and _backfill_missing_days."""

    def setUp(self):
        self.original_url = scraper.WEB_APP_URL
        scraper.WEB_APP_URL = "https://script.google.com/macros/s/test/exec"

    def tearDown(self):
        scraper.WEB_APP_URL = self.original_url

    def test_latest_real_date_ignores_placeholders_and_garbage(self):
        rows = [
            ["2026-08-11", "IRL001", "Granted"],
            ["2026-08-12", "NO_FILE_2026-08-12", scraper.NO_UPLOAD_MESSAGE],
            ["not-a-date", "IRL002", "Granted"],
            ["2026-08-10", "IRL003", "Refused"],
        ]
        self.assertEqual(scraper._latest_real_date(rows), "2026-08-11")

    def test_latest_real_date_none_when_only_placeholders(self):
        self.assertIsNone(scraper._latest_real_date(
            [["2026-08-12", "NO_FILE_2026-08-12", scraper.NO_UPLOAD_MESSAGE]]))
        self.assertIsNone(scraper._latest_real_date([]))

    @patch("scraper.set_no_file_placeholder")
    def test_backfill_uses_anchor_and_skips_existing_and_skip_date(self, set_ph):
        existing = [
            ["2026-08-11", "IRL001", "Granted"],
            ["2026-08-13", "NO_FILE_2026-08-13", scraper.NO_UPLOAD_MESSAGE],
        ]
        scraper._backfill_missing_days(existing, ist("2026-08-15"),
                                       anchor="2026-08-11", skip_date="2026-08-15")
        calls = {c.args[0]: c.args[1] for c in set_ph.call_args_list}
        # 12 missing -> no-upload; 13 already exists -> untouched;
        # 14 missing -> no-upload; 15 skipped by skip_date
        self.assertEqual(calls, {
            "2026-08-12": scraper.NO_UPLOAD_MESSAGE,
            "2026-08-14": scraper.NO_UPLOAD_MESSAGE,
        })

    @patch("scraper.set_no_file_placeholder")
    def test_backfill_weekend_days_get_closed_message(self, set_ph):
        scraper._backfill_missing_days([], ist("2026-08-17"), anchor="2026-08-14")
        calls = {c.args[0]: c.args[1] for c in set_ph.call_args_list}
        self.assertEqual(calls["2026-08-15"], scraper.WEEKEND_MESSAGE)
        self.assertEqual(calls["2026-08-16"], scraper.WEEKEND_MESSAGE)
        self.assertEqual(calls["2026-08-17"], scraper.NO_UPLOAD_MESSAGE)

    @patch("scraper.set_no_file_placeholder")
    def test_backfill_uses_latest_real_date_when_no_anchor(self, set_ph):
        existing = [["2026-08-10", "IRL001", "Granted"]]
        scraper._backfill_missing_days(existing, ist("2026-08-12"))
        self.assertEqual([c.args[0] for c in set_ph.call_args_list],
                         ["2026-08-11", "2026-08-12"])

    @patch("scraper.set_no_file_placeholder")
    def test_backfill_is_noop_on_bad_anchor_or_no_data(self, set_ph):
        scraper._backfill_missing_days([], ist("2026-08-12"), anchor="garbage")
        scraper._backfill_missing_days([], ist("2026-08-12"))
        set_ph.assert_not_called()


class DateLineParsingTests(unittest.TestCase):
    """_dates_in_line / _holiday_name: single dates, ordinals, abbreviations
    and ranges like '13 & 14 August'."""

    def test_dates_in_line_handles_formats(self):
        self.assertEqual(set(scraper._dates_in_line("Embassy Closed for Relocation 13 & 14 August Thursday and Friday")),
                         {(13, 8), (14, 8)})
        self.assertEqual(set(scraper._dates_in_line("Closed 13 and 14 August")), {(13, 8), (14, 8)})
        self.assertEqual(set(scraper._dates_in_line("Closed 13th August")), {(13, 8)})
        self.assertEqual(set(scraper._dates_in_line("Holi 04 March Wednesday")), {(4, 3)})
        self.assertEqual(set(scraper._dates_in_line("03 Aug")), {(3, 8)})
        self.assertEqual(set(scraper._dates_in_line("No dates here at all")), set())

    def test_holiday_name_strips_date_tokens(self):
        self.assertEqual(
            scraper._holiday_name("Embassy Closed for Relocation 13 & 14 August Thursday and Friday"),
            "Embassy Closed for Relocation")
        self.assertEqual(scraper._holiday_name("New Year's Day 01 January Thursday"), "New Year's Day")
        self.assertEqual(scraper._holiday_name("13 & 14 August"), "Public Holiday")


if __name__ == "__main__":
    unittest.main()
