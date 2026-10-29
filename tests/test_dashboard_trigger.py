import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "dashboard_trigger", Path(__file__).resolve().parents[1] / "scripts" / "dashboard_trigger.py"
)
trigger = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = trigger
SPEC.loader.exec_module(trigger)

NOW = dt.datetime(2026, 10, 30, 0, 10, tzinfo=dt.timezone.utc)


def body(when):
    return trigger.MARKER + "\n" + when.strftime("%Y-%m-%dT%H:%M:%SZ")


def fixture():
    owner = {"login": "Fadinggo", "id": 257707061, "type": "User"}
    event = {
        "action": "edited",
        "repository": {"full_name": "Fadinggo/race", "owner": copy.deepcopy(owner)},
        "sender": copy.deepcopy(owner),
        "issue": {"number": 3, "title": "Dashboard cloud refresh heartbeat", "state": "open",
                  "user": copy.deepcopy(owner), "body": body(NOW)},
        "changes": {"body": {"from": body(NOW - dt.timedelta(minutes=5))}},
    }
    env = {"GITHUB_REPOSITORY": "Fadinggo/race", "GITHUB_REF": "refs/heads/main",
           "GITHUB_EVENT_NAME": "issues", "GITHUB_ACTOR": "Fadinggo",
           "GITHUB_ACTOR_ID": "257707061", "GITHUB_TRIGGERING_ACTOR": "Fadinggo",
           "GITHUB_RUN_ATTEMPT": "1"}
    return event, env


class TriggerTests(unittest.TestCase):
    def setUp(self):
        self.event, self.env = fixture()

    def validate(self, now=NOW):
        return trigger.validate_event(self.event, self.env, now=now)

    def test_owner_tick_is_authorized(self):
        self.assertEqual(self.validate(), NOW)

    def test_exact_initial_issue_body_can_activate(self):
        self.event["changes"]["body"]["from"] = trigger.INITIAL_BODY
        self.assertEqual(self.validate(), NOW)

    def test_arbitrary_unparseable_initial_body_is_rejected(self):
        for previous in ["pending", "", None, trigger.INITIAL_BODY + " altered"]:
            with self.subTest(previous=previous), self.assertRaises(trigger.TriggerError):
                self.event["changes"]["body"]["from"] = previous
                self.validate()

    def test_wrong_runtime_identity_repository_event_or_ref_is_rejected(self):
        cases = [("GITHUB_ACTOR", "other"), ("GITHUB_ACTOR_ID", "123"),
                 ("GITHUB_TRIGGERING_ACTOR", "other"), ("GITHUB_REPOSITORY", "other/race"),
                 ("GITHUB_EVENT_NAME", "workflow_dispatch"), ("GITHUB_REF", "refs/heads/untrusted")]
        for key, value in cases:
            with self.subTest(key=key), self.assertRaisesRegex(trigger.TriggerError, "not_authorized"):
                trigger.validate_event(self.event, self.env | {key: value}, now=NOW)

    def test_missing_actor_id_is_rejected(self):
        del self.env["GITHUB_ACTOR_ID"]
        with self.assertRaises(trigger.TriggerError):
            self.validate()

    def test_sender_author_and_repository_owner_need_both_login_and_immutable_id(self):
        for path in [("sender",), ("issue", "user"), ("repository", "owner")]:
            for change in [{"login": "other"}, {"id": 123}, {"id": "257707061"}, {"type": "Bot"}]:
                with self.subTest(path=path, change=change), self.assertRaises(trigger.TriggerError):
                    event = copy.deepcopy(self.event)
                    node = event
                    for key in path:
                        node = node[key]
                    node.update(change)
                    trigger.validate_event(event, self.env, now=NOW)

    def test_wrong_event_repository_is_rejected(self):
        self.event["repository"]["full_name"] = "Fadinggo/another"
        with self.assertRaisesRegex(trigger.TriggerError, "repository_invalid"):
            self.validate()

    def test_wrong_issue_closed_or_pull_request_is_rejected(self):
        changes = [{"number": 4}, {"number": "3"}, {"title": "Another issue"},
                   {"state": "closed"}, {"pull_request": {}}]
        for change in changes:
            with self.subTest(change=change), self.assertRaisesRegex(trigger.TriggerError, "issue_invalid"):
                event = copy.deepcopy(self.event)
                event["issue"].update(change)
                trigger.validate_event(event, self.env, now=NOW)

    def test_non_edit_or_title_only_edit_is_rejected(self):
        self.event["action"] = "opened"
        with self.assertRaises(trigger.TriggerError):
            self.validate()
        self.event["action"] = "edited"
        self.event["changes"] = {"title": {"from": "old"}}
        with self.assertRaises(trigger.TriggerError):
            self.validate()

    def test_body_change_requires_previous_body(self):
        self.event["changes"]["body"] = {}
        with self.assertRaisesRegex(trigger.TriggerError, "previous_body_missing"):
            self.validate()

    def test_duplicate_and_backwards_ticks_are_rejected(self):
        for previous in [NOW, NOW + dt.timedelta(seconds=1)]:
            with self.subTest(previous=previous), self.assertRaisesRegex(trigger.TriggerError, "not_advancing"):
                self.event["changes"]["body"]["from"] = body(previous)
                self.validate()

    def test_old_event_rerun_is_rejected_even_if_tick_is_fresh(self):
        for attempt in ["2", "01", "", None]:
            with self.subTest(attempt=attempt), self.assertRaisesRegex(trigger.TriggerError, "rerun_rejected"):
                trigger.validate_event(self.event, self.env | {"GITHUB_RUN_ATTEMPT": attempt}, now=NOW)

    def test_expired_and_future_ticks_are_rejected(self):
        for seconds, reason in [(-601, "expired"), (61, "in_future")]:
            with self.subTest(seconds=seconds), self.assertRaisesRegex(trigger.TriggerError, reason):
                self.event["issue"]["body"] = body(NOW + dt.timedelta(seconds=seconds))
                self.event["changes"]["body"]["from"] = trigger.INITIAL_BODY
                self.validate()

    def test_freshness_boundaries_are_inclusive(self):
        for seconds in [-600, 60]:
            with self.subTest(seconds=seconds):
                self.event["issue"]["body"] = body(NOW + dt.timedelta(seconds=seconds))
                self.event["changes"]["body"]["from"] = trigger.INITIAL_BODY
                self.assertEqual(self.validate(), NOW + dt.timedelta(seconds=seconds))

    def test_shell_text_extra_instructions_and_non_utc_formats_are_rejected(self):
        bad = [body(NOW) + "\nrm -rf /", "$(whoami)", "```" + body(NOW) + "```",
               "RACE_DASHBOARD_TICK_V1\n2026-10-30T00:10:00+00:00",
               "RACE_DASHBOARD_TICK_V1\n2026-10-30T00:10:00.000Z",
               "RACE_DASHBOARD_TICK_V1\n2026-02-30T00:10:00Z",
               "RACE_DASHBOARD_TICK_V1\r\n2026-10-30T00:10:00Z", "x" * 101, None]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(trigger.TriggerError):
                self.event["issue"]["body"] = value
                self.validate()

    def test_single_trailing_newline_is_accepted(self):
        self.event["issue"]["body"] += "\n"
        self.assertEqual(self.validate(), NOW)

    def test_missing_or_malformed_event_objects_are_rejected(self):
        for key in ["repository", "sender", "issue", "changes"]:
            for value in [None, [], "text"]:
                with self.subTest(key=key, value=value), self.assertRaises(trigger.TriggerError):
                    trigger.validate_event(self.event | {key: value}, self.env, now=NOW)

    def test_naive_clock_is_rejected(self):
        with self.assertRaisesRegex(trigger.TriggerError, "clock_invalid"):
            self.validate(now=NOW.replace(tzinfo=None))


class EntryPointTests(unittest.TestCase):
    def run_main(self, payload, *, authorize=False):
        event, env = fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "event.json"
            path.write_bytes(payload)
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.dict(os.environ, env | {"GITHUB_EVENT_PATH": str(path)}, clear=True):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    if authorize:
                        with patch.object(trigger, "validate_event", return_value=NOW):
                            code = trigger.main()
                    else:
                        code = trigger.main()
            return code, stdout.getvalue(), stderr.getvalue()

    def test_success_prints_only_fixed_receipt(self):
        code, stdout, stderr = self.run_main(json.dumps(fixture()[0]).encode(), authorize=True)
        self.assertEqual((code, stdout, stderr), (0, "dashboard_issue_tick_authorized\n", ""))

    def test_rejected_payload_is_not_logged(self):
        event, _ = fixture()
        event["issue"]["body"] = "sensitive-input-do-not-print"
        code, stdout, stderr = self.run_main(json.dumps(event).encode())
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "dashboard_tick_body_invalid\n")
        self.assertNotIn(event["issue"]["body"], stderr)

    def test_malformed_and_duplicate_json_are_rejected_without_traceback(self):
        for raw, reason in [(b"not json", "dashboard_trigger_invalid"),
                            (b'{"action":"edited","action":"opened"}', "dashboard_trigger_duplicate_json_key")]:
            with self.subTest(raw=raw):
                code, stdout, stderr = self.run_main(raw)
                self.assertEqual((code, stdout, stderr), (1, "", reason + "\n"))

    def test_event_size_limit_is_checked_before_json_parse(self):
        code, stdout, stderr = self.run_main(b"x" * (trigger.MAX_EVENT_BYTES + 1))
        self.assertEqual((code, stdout, stderr), (1, "", "dashboard_trigger_event_too_large\n"))


if __name__ == "__main__":
    unittest.main()
