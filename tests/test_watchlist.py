"""Deterministic watchlist schema, safety, and CLI checks without service access."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts import validate_watchlist as watchlist


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate_watchlist.py"
BASE = {
    "id": "A-20261101-1400-ETH", "trader": "Grok-Trader-A",
    "instrument": "ETH-USDT-SWAP", "direction": "long", "summary": "等待突破壓力。",
    "detail": {"reason": "量能回升。", "plan": "突破後分批進場。", "invalidation": "跌回區間則取消。"},
    "confidence": 70, "created_ts": 1793538000, "expires_ts": 1793624400,
    "ref_price": 3500, "outcome": None,
}
OUTCOME = {"price_at_expiry": 3600, "change_pct": 2.857, "verdict": "hit", "review": "方向正確。"}
CASES = json.loads((ROOT / "tests" / "watchlist-cases.json").read_text(encoding="utf-8"))


class WatchlistValidationTests(unittest.TestCase):
    def test_shared_browser_schema_and_safety_cases(self):
        for case in CASES:
            with self.subTest(case=case["name"]):
                document = copy.deepcopy(case["document"])
                if case["valid"]:
                    self.assertEqual(watchlist.validate_document(document), document["items"])
                else:
                    with self.assertRaises(watchlist.WatchlistError) as raised:
                        watchlist.validate_document(document)
                    self.assertEqual(raised.exception.code, case["error_code"])
                self.assertEqual(document, case["document"], "Validation must preserve public data")

    def invalid_item(self, field, value, code):
        item = {**copy.deepcopy(BASE), field: value}
        with self.assertRaisesRegex(watchlist.WatchlistError, "^" + code + "$"):
            watchlist.validate_item(item)

    def test_empty_document_and_example_with_dated_public_id(self):
        self.assertEqual(watchlist.validate_document({"version": 1, "items": []}), [])
        item = copy.deepcopy(BASE)
        original = copy.deepcopy(item)
        self.assertIs(watchlist.validate_item(item), item)
        self.assertEqual(item, original)
        self.assertFalse(watchlist.suspicious_id(item["id"]))

    def test_status_is_optional_and_outcome_is_display_data_without_inference(self):
        for status in (None, "active", "expired"):
            for verdict in ("hit", "miss", "unclear"):
                item = {**copy.deepcopy(BASE), "outcome": {**OUTCOME, "verdict": verdict}}
                if status is not None:
                    item["status"] = status
                original = copy.deepcopy(item)
                self.assertIs(watchlist.validate_item(item), item)
                self.assertEqual(item, original)
        for status in (None, "unknown", [], True):
            with self.subTest(kind=type(status).__name__):
                self.invalid_item("status", status, "invalid_status")

    def test_document_containers_version_and_item_limit_are_strict(self):
        for document in (None, [], {}, {"version": 1}, {"version": 1, "items": [], "extra": 0}):
            with self.subTest(shape=type(document).__name__), self.assertRaisesRegex(watchlist.WatchlistError, "invalid_document"):
                watchlist.validate_document(document)
        for version in (True, None, "1", 2, float("nan"), float("inf")):
            with self.subTest(kind=type(version).__name__), self.assertRaisesRegex(watchlist.WatchlistError, "invalid_version"):
                watchlist.validate_document({"version": version, "items": []})
        for items in (None, {}, "[]", [BASE] * (watchlist.MAX_ITEMS + 1)):
            with self.subTest(kind=type(items).__name__), self.assertRaisesRegex(watchlist.WatchlistError, "invalid_items"):
                watchlist.validate_document({"version": 1, "items": items})

    def test_missing_extra_and_nested_fields_reject_the_whole_item(self):
        for field in BASE:
            item = copy.deepcopy(BASE)
            del item[field]
            with self.subTest(field=field), self.assertRaisesRegex(watchlist.WatchlistError, "invalid_item"):
                watchlist.validate_item(item)
        for item in (None, [], {**BASE, "extra": "ignored"}):
            with self.assertRaisesRegex(watchlist.WatchlistError, "invalid_item"):
                watchlist.validate_item(item)
        for detail in (None, [], {"reason": "理由"}, {**BASE["detail"], "extra": "資料"}):
            self.invalid_item("detail", detail, "invalid_detail")
        for outcome in ([], {}, {**OUTCOME, "extra": 0}, {key: value for key, value in OUTCOME.items() if key != "review"}):
            self.invalid_item("outcome", outcome, "invalid_outcome")

    def test_trader_direction_and_symbols_reject_wrong_types_and_whitespace(self):
        for trader in (None, [], "A"):
            self.invalid_item("trader", trader, "invalid_trader")
        for direction in (None, [], "buy"):
            self.invalid_item("direction", direction, "invalid_direction")
        for field, limit, code in (("id", watchlist.MAX_ID, "invalid_id"),
                                   ("instrument", watchlist.MAX_INSTRUMENT, "invalid_instrument")):
            for value in (None, [], "", "with space", "換\n行", "界" * (limit + 1)):
                with self.subTest(field=field, kind=type(value).__name__):
                    self.invalid_item(field, value, code)

    def test_confidence_boundaries_and_finite_numbers(self):
        for confidence in (0, 100, 70.5):
            item = {**copy.deepcopy(BASE), "confidence": confidence}
            self.assertIs(watchlist.validate_item(item), item)
        for confidence in (-1, 101, True, "70", None, float("nan"), float("inf"), 10 ** 1000):
            self.invalid_item("confidence", confidence, "invalid_confidence")
        for value in (0, -1, True, "1", None, float("nan"), float("inf"), 10 ** 1000):
            self.invalid_item("ref_price", value, "invalid_number")

    def test_timestamp_bounds_order_and_extreme_values_do_not_overflow(self):
        for field in ("created_ts", "expires_ts"):
            for stamp in (0, -1, True, None, "1793538000", float("nan"), float("inf"),
                          watchlist.MAX_TIMESTAMP + 1, 10 ** 1000):
                with self.subTest(field=field, kind=type(stamp).__name__):
                    self.invalid_item(field, stamp, "invalid_timestamp")
        for stamp in (BASE["created_ts"], BASE["created_ts"] - 1):
            self.invalid_item("expires_ts", stamp, "invalid_timestamp")
        item = {**copy.deepcopy(BASE), "expires_ts": watchlist.MAX_TIMESTAMP}
        self.assertIs(watchlist.validate_item(item), item)

    def test_text_lengths_use_codepoints_and_blank_detail_is_allowed(self):
        item = {**copy.deepcopy(BASE), "summary": "😀" * 60,
                "detail": {"reason": "", "plan": "界" * 1500, "invalidation": ""},
                "outcome": {**OUTCOME, "review": "😀" * 300}}
        self.assertIs(watchlist.validate_item(item), item)
        self.invalid_item("summary", "😀" * 61, "text_too_long")
        for summary in ("", " \n", None, 1):
            self.invalid_item("summary", summary, "invalid_text")
        self.invalid_item("detail", {**BASE["detail"], "plan": "界" * 1501}, "text_too_long")
        self.invalid_item("detail", {**BASE["detail"], "reason": None}, "invalid_text")
        self.invalid_item("outcome", {**OUTCOME, "review": "界" * 301}, "text_too_long")
        self.invalid_item("outcome", {**OUTCOME, "review": None}, "invalid_text")

    def test_outcome_numbers_are_finite_verdict_is_known_and_review_can_be_empty(self):
        for value in (0, -1, True, "1", None, float("nan"), float("inf"), 10 ** 1000):
            self.invalid_item("outcome", {**OUTCOME, "price_at_expiry": value}, "invalid_number")
        for value in (True, "1", None, float("nan"), float("inf"), 10 ** 1000):
            self.invalid_item("outcome", {**OUTCOME, "change_pct": value}, "invalid_number")
        for value in (None, [], "correct"):
            self.invalid_item("outcome", {**OUTCOME, "verdict": value}, "invalid_verdict")
        for change in (-100, 0, 100):
            item = {**copy.deepcopy(BASE), "outcome": {**OUTCOME, "change_pct": change, "review": ""}}
            self.assertIs(watchlist.validate_item(item), item)

    def test_duplicate_ids_are_rejected_instead_of_silently_replaced(self):
        with self.assertRaisesRegex(watchlist.WatchlistError, "duplicate_id"):
            watchlist.validate_document({"version": 1, "items": [BASE, copy.deepcopy(BASE)]})
        other = {**copy.deepcopy(BASE), "id": "B-20261101-1400-ETH", "trader": "Grok-Trader-B"}
        self.assertEqual(len(watchlist.validate_document({"version": 1, "items": [BASE, other]})), 2)

    def test_sensitive_checks_cover_every_free_text_field_without_joining_symbols(self):
        unsafe = "token: EXAMPLE"
        for field in ("summary", "instrument", "id"):
            value = "A" * 32 if field in ("instrument", "id") else unsafe
            self.invalid_item(field, value, "unsafe_watchlist")
        for field in watchlist.DETAIL_FIELDS:
            self.invalid_item("detail", {**BASE["detail"], field: unsafe}, "unsafe_watchlist")
        self.invalid_item("outcome", {**OUTCOME, "review": unsafe}, "unsafe_watchlist")
        for value in ("金鑰：測試", "ｔｏｋｅｎ：EXAMPLE", "隱藏\u200b字元", "\ud800"):
            self.invalid_item("summary", value, "unsafe_watchlist")
        item = {**copy.deepcopy(BASE), "id": "public-observation-id", "instrument": "ETH-USDT-SWAP"}
        self.assertIs(watchlist.validate_item(item), item)

    def test_date_exception_does_not_allow_bad_calendar_dates_or_long_suffixes(self):
        for value in ("A-20260230-1400-ETH", "A-20261101-2460-ETH", "A-12345678-1400-ETH",
                      "A-20261101-1400-ETH12345678", "A-20261101-1400-" + "A" * 20,
                      "A-20261101-1400-sk-fake", "plain-12345678"):
            with self.subTest(length=len(value)):
                self.invalid_item("id", value, "unsafe_watchlist")


class WatchlistCommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.path = self.directory / "watchlist.json"

    def invoke(self, *arguments):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *arguments], cwd=self.directory,
                              capture_output=True, text=True, timeout=15, check=False)

    def assert_result(self, result, expected, status=1):
        self.assertEqual(result.returncode, status)
        self.assertEqual(json.loads(result.stdout), expected)
        self.assertEqual(result.stderr, "")

    def test_cli_default_and_explicit_path_report_only_counts(self):
        for items in ([], [BASE]):
            self.path.write_text(json.dumps({"version": 1, "items": items}), encoding="utf-8")
            for arguments in ((), (str(self.path),)):
                result = self.invoke(*arguments)
                self.assert_result(result, {"status": "ok", "items": len(items)}, status=0)
                self.assertNotIn(BASE["id"], result.stdout)

    def test_missing_directory_and_oversized_files_are_fixed_failures(self):
        for path in (self.path, self.directory):
            self.assert_result(self.invoke(str(path)), {"status": "error", "error_code": "unreadable_file"})
        self.path.write_bytes(b" " * (watchlist.MAX_BYTES + 1))
        self.assert_result(self.invoke(str(self.path)), {"status": "error", "error_code": "file_too_large"})

    def test_invalid_json_duplicate_keys_nonfinite_constants_and_encoding_are_fixed_errors(self):
        for raw in (b"{", b'{"version":1,"version":1,"items":[]}',
                    b'{"version":1,"items":[],"value":NaN}', b'{"version":Infinity,"items":[]}',
                    b'{"version":1,"items":[{"id":"a","id":"b"}]}', b"\xff\xfe"):
            self.path.write_bytes(raw)
            self.assert_result(self.invoke(), {"status": "error", "error_code": "invalid_json"})

    def test_cli_unsafe_content_and_schema_failures_never_echo_data(self):
        marker = "EXAMPLE_SHOULD_NEVER_REACH_OUTPUT"
        for item, code in (({**BASE, "summary": "token: " + marker}, "unsafe_watchlist"),
                           ({**BASE, "direction": marker}, "invalid_direction")):
            self.path.write_text(json.dumps({"version": 1, "items": [item]}), encoding="utf-8")
            result = self.invoke()
            self.assert_result(result, {"status": "error", "error_code": code})
            self.assertNotIn(marker, result.stdout + result.stderr)
            self.assertNotIn(BASE["id"], result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
