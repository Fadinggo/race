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
        "market_view": "波動偏高。", "current_approach": "等待訊號。", "plan": "注意風險。"}


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
        note = {**BASE, "market_view": "<b>觀察</b>\n第二行\t😀"}
        self.assertIs(notes.validate_note(note), note)
        self.assertFalse(notes.suspicious_text(note["market_view"]))
        with self.assertRaisesRegex(notes.NotesError, "unsafe_note"):
            notes.validate_note({**BASE, "plan": "\ud800"})


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
            self.assertNotIn(BASE["market_view"], result.stdout)

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
        for document, code in (({"version": 1, "notes": [{**BASE, "plan": "token: " + marker}]}, "unsafe_note"),
                               ({"version": 1, "notes": [{**BASE, "kind": marker}]}, "invalid_kind")):
            with self.subTest(code=code):
                self.write(document)
                result = self.invoke(str(self.path))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout), {"status": "error", "error_code": code})
                self.assertEqual(result.stderr, "")
                self.assertNotIn(marker, result.stdout + result.stderr)
                self.assertNotIn(BASE["market_view"], result.stdout + result.stderr)

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


if __name__ == "__main__":
    unittest.main()
