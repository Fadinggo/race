"""Offline validation and no-content logging checks for public trader notes."""

import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate_notes.py"
SPEC = importlib.util.spec_from_file_location("validate_notes", SCRIPT)
notes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notes)
CASES = json.loads((ROOT / "tests" / "notes-cases.json").read_text(encoding="utf-8"))
BASE = {"trader": "Grok-Trader-A", "ts": 1793305202.598, "kind": "daily",
        "market_recap": "波動偏高。", "trade_review": "等待訊號。",
        "watch_next": "注意風險。", "strategy_adjustments": "維持風控。"}
OPEN = {"trader": "Grok-Trader-A", "ts": 1793305202.598, "kind": "open",
        "instrument": "BTC-USDT-SWAP", "direction": "short", "leverage": 5,
        "entry_price": 77818.8, "stop_loss": 79000, "take_profit": 75000, "max_loss_usdt": 0.4,
        "reasons": {"funding_rate": "資金費率 0.01%。", "open_interest": "未平倉量增加 8%。",
                    "key_levels": "壓力 79000。", "volume": "量能偏低。", "events": "今晚無重大數據。"},
        "confidence": "中高。", "invalidation": "站回 79000 則失效。"}
SETTLEMENT = next(case["document"]["notes"][0] for case in CASES if case["name"] == "settlement_valid_signed_values")


class NotesValidationTests(unittest.TestCase):
    def test_shared_browser_schema_and_safety_cases(self):
        for case in CASES:
            with self.subTest(case=case["name"]):
                original = copy.deepcopy(case["document"])
                if case["valid"]:
                    self.assertEqual(notes.validate_document(original), original["notes"])
                else:
                    with self.assertRaises(notes.NotesError) as raised:
                        notes.validate_document(original)
                    self.assertEqual(raised.exception.code, case["error_code"])
                self.assertEqual(original, case["document"], "Validation must not mutate note content")

    def test_non_finite_and_extreme_timestamps_are_fixed_errors(self):
        for stamp in (float("nan"), float("inf"), -float("inf"), 10 ** 1000):
            with self.subTest(stamp_type=type(stamp).__name__), self.assertRaisesRegex(notes.NotesError, "invalid_timestamp"):
                notes.validate_note({**BASE, "ts": stamp})

    def test_document_and_note_container_types_are_strict(self):
        for document in (None, [], "{}", {"notes": []}, {"version": 1}, {"version": 1, "notes": None},
                         {"version": 1, "notes": {}}, {"version": 1, "notes": [None]},
                         {"version": 1, "notes": ["public text"]}):
            with self.subTest(shape=type(document).__name__), self.assertRaises(notes.NotesError):
                notes.validate_document(document)

    def test_more_than_1000_notes_is_rejected(self):
        with self.assertRaisesRegex(notes.NotesError, "invalid_notes"):
            notes.validate_document({"version": 1, "notes": [BASE] * (notes.MAX_NOTES + 1)})
        self.assertEqual(len(notes.validate_document({"version": 1, "notes": [BASE] * notes.MAX_NOTES})), notes.MAX_NOTES)

    def test_suspicious_content_in_any_text_field_rejects_whole_note(self):
        for field in notes.TEXT_FIELDS:
            with self.subTest(field=field), self.assertRaisesRegex(notes.NotesError, "unsafe_note"):
                notes.validate_note({**BASE, field: "token: EXAMPLE_NOT_A_REAL_CREDENTIAL"})

    def test_plain_text_preserves_html_newlines_tabs_and_astral_characters(self):
        note = {**BASE, "market_recap": "<b>觀察</b>\n第二行\t😀"}
        self.assertIs(notes.validate_note(note), note)
        self.assertFalse(notes.suspicious_text(note["market_recap"]))
        with self.assertRaisesRegex(notes.NotesError, "unsafe_note"):
            notes.validate_note({**BASE, "watch_next": "\ud800"})

    def test_settlement_numeric_cells_reject_non_finite_numbers_without_overflow(self):
        for table_name in ("daily", "cum"):
            for field in notes.SETTLEMENT_NUMBERS:
                for value in (True, "1", float("nan"), float("inf"), -float("inf"), 10 ** 1000):
                    with self.subTest(table=table_name, field=field, value_type=type(value).__name__):
                        item = copy.deepcopy(SETTLEMENT)
                        table = item["table"] if table_name == "daily" else item["table"]["cum"]
                        table[field] = value
                        with self.assertRaisesRegex(notes.NotesError, "invalid_settlement_number"):
                            notes.validate_note(item)

    def test_settlement_model_costs_are_nullable_nonnegative_finite_numbers(self):
        for value, code in ((True, "invalid_settlement_number"), ("0", "invalid_settlement_number"),
                            (float("nan"), "invalid_settlement_number"), (float("inf"), "invalid_settlement_number"),
                            (10 ** 1000, "invalid_settlement_number"), (-0.01, "invalid_api_cost")):
            with self.subTest(value_type=type(value).__name__, code=code):
                item = copy.deepcopy(SETTLEMENT)
                item["table"]["api_cost_by_model"] = {"gpt-test": value}
                with self.assertRaisesRegex(notes.NotesError, code):
                    notes.validate_note(item)
        item = copy.deepcopy(SETTLEMENT)
        item["table"]["api_cost_by_model"] = {"gpt-test": None}
        item["table"]["api_cost_total"] = None
        item["table"]["net_after_costs"] = None
        before = copy.deepcopy(item)
        self.assertIs(notes.validate_note(item), item)
        self.assertEqual(item, before, "Unknown cells must not be derived or replaced with zero")

    def test_settlement_rejects_duplicate_trader_date_but_accepts_other_days_and_traders(self):
        duplicate = {**copy.deepcopy(SETTLEMENT), "ts": SETTLEMENT["ts"] + 60}
        with self.assertRaisesRegex(notes.NotesError, "duplicate_settlement"):
            notes.validate_document({"version": 1, "notes": [SETTLEMENT, duplicate]})
        different_day = {**copy.deepcopy(SETTLEMENT), "date": "2026-10-29"}
        different_trader = {**copy.deepcopy(SETTLEMENT), "trader": "Grok-Trader-B"}
        self.assertEqual(len(notes.validate_document({"version": 1, "notes": [SETTLEMENT, different_day, different_trader]})), 3)

    def test_settlement_model_name_boundaries_do_not_combine_legitimate_model_ids(self):
        item = copy.deepcopy(SETTLEMENT)
        item["table"]["api_cost_by_model"] = {"模" * notes.MAX_MODEL_NAME: 0}
        self.assertIs(notes.validate_note(item), item)
        item["table"]["api_cost_by_model"] = {f"model-{index}": None for index in range(notes.MAX_MODELS)}
        self.assertIs(notes.validate_note(item), item)
        item["table"]["api_cost_by_model"] = {"gpt-4.1-mini": 0, "gpt-4o-mini": 0, "o3-mini": 0}
        self.assertIs(notes.validate_note(item), item)

    def test_dated_model_names_exempt_only_generic_token_length_rule(self):
        model = "gpt-4o-mini-audio-preview-2024-12-17"
        self.assertTrue(notes.suspicious_text(model), "Narrative text retains its original filter")
        self.assertFalse(notes.suspicious_model_name(model))
        item = copy.deepcopy(SETTLEMENT)
        item["table"]["api_cost_by_model"] = {model: None}
        self.assertIs(notes.validate_note(item), item)
        for unsafe in ("gpt-4o-sk-fake", "gpt-4o-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
                       "gpt-4o-preview-12345678", "gpt-4o-\u200bpreview", "token: EXAMPLE"):
            with self.subTest(case=unsafe.split("-")[0]):
                self.assertTrue(notes.suspicious_model_name(unsafe))
                invalid = copy.deepcopy(item)
                invalid["table"]["api_cost_by_model"] = {unsafe: None}
                with self.assertRaisesRegex(notes.NotesError, "unsafe_note"):
                    notes.validate_note(invalid)

    def test_content_limit_is_1500_codepoints(self):
        self.assertEqual(notes.MAX_TEXT, 1500)
        note = copy.deepcopy(BASE)
        room = notes.MAX_TEXT - sum(len(note[field]) for field in notes.TEXT_FIELDS if field != "market_recap")
        note["market_recap"] = "測" * room
        self.assertIs(notes.validate_note(note), note)
        note["market_recap"] += "測"
        with self.assertRaisesRegex(notes.NotesError, "text_too_long"):
            notes.validate_note(note)

    def test_open_close_and_daily_notes_reject_missing_required_fields(self):
        opened = copy.deepcopy(OPEN)
        self.assertIs(notes.validate_note(opened), opened)
        for field in ("instrument", "direction", "leverage", "entry_price", "stop_loss", "take_profit",
                      "max_loss_usdt", "reasons", "confidence", "invalidation"):
            with self.subTest(kind="open", field=field):
                item = copy.deepcopy(OPEN)
                del item[field]
                with self.assertRaisesRegex(notes.NotesError, "invalid_note"):
                    notes.validate_note(item)
        for field in notes.REASON_FIELDS:
            with self.subTest(kind="open-reason", field=field):
                item = copy.deepcopy(OPEN)
                del item["reasons"][field]
                with self.assertRaisesRegex(notes.NotesError, "invalid_reasons"):
                    notes.validate_note(item)
        close = copy.deepcopy(next(case["document"]["notes"][0] for case in CASES if case["name"] == "close_valid"))
        self.assertIs(notes.validate_note(close), close)
        for field in ("review", "realized_pnl_usdt", "variance"):
            with self.subTest(kind="close", field=field):
                item = copy.deepcopy(close)
                del item[field]
                with self.assertRaisesRegex(notes.NotesError, "invalid_note"):
                    notes.validate_note(item)
        for field in notes.VARIANCE_FIELDS:
            with self.subTest(kind="close-variance", field=field):
                item = copy.deepcopy(close)
                del item["variance"][field]
                with self.assertRaisesRegex(notes.NotesError, "invalid_variance"):
                    notes.validate_note(item)
        for field in ("entry_price", "invalidation", "reasons"):
            with self.subTest(kind="close-review", field=field):
                item = copy.deepcopy(close)
                del item["review"][field]
                with self.assertRaisesRegex(notes.NotesError, "invalid_review"):
                    notes.validate_note(item)
        for field in notes.TEXT_FIELDS:
            with self.subTest(kind="daily", field=field):
                item = copy.deepcopy(BASE)
                del item[field]
                with self.assertRaisesRegex(notes.NotesError, "invalid_note"):
                    notes.validate_note(item)

    def test_settlement_requires_a_trade_list_and_each_trade_needs_pnl(self):
        item = copy.deepcopy(SETTLEMENT)
        self.assertIn("trades", item)
        self.assertIs(notes.validate_note(item), item)
        del item["trades"]
        with self.assertRaisesRegex(notes.NotesError, "invalid_note"):
            notes.validate_note(item)
        listed = copy.deepcopy(SETTLEMENT)
        listed["trades"] = [{"instrument": "ETH-USDT-SWAP", "direction": "long", "pnl": 0.2}]
        self.assertIs(notes.validate_note(listed), listed)
        listed["trades"][0].pop("pnl")
        with self.assertRaisesRegex(notes.NotesError, "invalid_trade"):
            notes.validate_note(listed)


class NotesCommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.path = self.directory / "notes.json"

    def write(self, document):
        self.path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")

    def invoke(self, *arguments):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *arguments], cwd=self.directory,
                              capture_output=True, text=True, timeout=15, check=False)

    def test_cli_default_path_valid_empty_file_and_valid_content(self):
        for note_list in ([], [BASE]):
            self.write({"version": 1, "notes": note_list})
            result = self.invoke()
            self.assertEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout), {"status": "ok", "notes": len(note_list)})
            self.assertEqual(result.stderr, "")
            self.assertNotIn(BASE["market_recap"], result.stdout)

    def test_cli_absent_or_directory_path_is_a_fixed_failure(self):
        for path in (self.path, self.directory):
            with self.subTest(path_kind=path.is_dir()):
                result = self.invoke(str(path))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout), {"status": "error", "error_code": "unreadable_file"})
                self.assertEqual(result.stderr, "")
                self.assertNotIn(str(path), result.stdout)

    def test_invalid_json_duplicate_keys_non_finite_constants_and_encoding(self):
        invalid = [b"{", b'{"version":1,"version":1,"notes":[]}',
                   b'{"version":1,"notes":[{"trader":"A","trader":"B"}]}',
                   b'{"version":1,"notes":[],"value":NaN}',
                   b'{"version":Infinity,"notes":[]}', b"\xff\xfe"]
        for source in invalid:
            with self.subTest(source_index=invalid.index(source)):
                self.path.write_bytes(source)
                result = self.invoke(str(self.path))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout), {"status": "error", "error_code": "invalid_json"})
                self.assertEqual(result.stderr, "")

    def test_cli_unsafe_note_and_wrong_schema_never_echo_content(self):
        marker = "EXAMPLE_SHOULD_NEVER_REACH_LOG_OUTPUT"
        for document, code in (({"version": 1, "notes": [{**BASE, "watch_next": "token: " + marker}]}, "unsafe_note"),
                               ({"version": 1, "notes": [{**BASE, "kind": marker}]}, "invalid_kind")):
            with self.subTest(code=code):
                self.write(document)
                result = self.invoke(str(self.path))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout), {"status": "error", "error_code": code})
                self.assertEqual(result.stderr, "")
                self.assertNotIn(marker, result.stdout + result.stderr)
                self.assertNotIn(BASE["market_recap"], result.stdout + result.stderr)

    def test_file_size_limit_applies_before_parsing(self):
        self.path.write_bytes(b" " * (notes.MAX_BYTES + 1))
        result = self.invoke(str(self.path))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {"status": "error", "error_code": "file_too_large"})
        self.assertEqual(result.stderr, "")

    def test_main_returns_status_for_in_process_usage_without_exposing_notes(self):
        self.write({"version": 1, "notes": [BASE]})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = notes.main([str(self.path)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue()), {"status": "ok", "notes": 1})

    def test_settlement_cli_accepts_tables_without_printing_model_names_or_amounts(self):
        self.write({"version": 1, "notes": [SETTLEMENT]})
        result = self.invoke(str(self.path))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"status": "ok", "notes": 1})
        self.assertEqual(result.stderr, "")
        self.assertNotIn("gpt-4.1-mini", result.stdout)
        self.assertNotIn("net_after_costs", result.stdout)

    def test_dated_model_cli_keeps_model_name_out_of_output(self):
        item = copy.deepcopy(SETTLEMENT)
        model = "gpt-4o-mini-audio-preview-2024-12-17"
        item["table"]["api_cost_by_model"] = {model: 0.01}
        self.write({"version": 1, "notes": [item]})
        result = self.invoke(str(self.path))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"status": "ok", "notes": 1})
        self.assertEqual(result.stderr, "")
        self.assertNotIn(model, result.stdout + result.stderr)

    def test_settlement_cli_duplicate_days_or_unsafe_model_name_are_fixed_errors(self):
        unsafe = copy.deepcopy(SETTLEMENT)
        marker = "EXAMPLE_MODEL_MUST_NEVER_REACH_OUTPUT"
        unsafe["table"]["cum"]["api_cost_by_model"] = {"token: " + marker: None}
        for items, code in (([SETTLEMENT, copy.deepcopy(SETTLEMENT)], "duplicate_settlement"),
                            ([unsafe], "unsafe_note")):
            with self.subTest(code=code):
                self.write({"version": 1, "notes": items})
                result = self.invoke(str(self.path))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout), {"status": "error", "error_code": code})
                self.assertEqual(result.stderr, "")
                self.assertNotIn(marker, result.stdout + result.stderr)

    def test_settlement_cli_rejects_duplicate_model_keys_including_escaped_names(self):
        document = json.dumps({"version": 1, "notes": [SETTLEMENT]})
        source = document.replace('"gpt-4.1-mini": 0.012', '"gpt-4.1-mini": 0.012, "gpt-4.1-min\\u0069": 0.014', 1)
        self.path.write_text(source, encoding="utf-8")
        result = self.invoke(str(self.path))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {"status": "error", "error_code": "invalid_json"})
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
