import unittest
from unittest.mock import Mock, patch

import scraper


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
        sleep.assert_called_once_with(2)

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

        self.assertIn("after 5 attempts", str(caught.exception))
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


if __name__ == "__main__":
    unittest.main()
