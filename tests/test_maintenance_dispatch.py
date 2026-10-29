import base64
import copy
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import maintenance_dispatch as dispatch

BASE = "a" * 40
TREE = "b" * 40
BLOB = "c" * 40
NEW_TREE = "d" * 40
PREPARE = "e" * 40
LATER = "f" * 40
NUMBER = 23


def order(kind="smoke"):
    return {"version": 1, "kind": kind, "objective": "Verify the cloud handoff.",
            "allowed_paths": ([".maintenance/results/{issue_number}.md"] if kind == "smoke"
                              else ["dashboard.js", "tests/dashboard.test.js"]),
            "acceptance": ["Record the checks and their results."]}


def issue_body(value=None):
    return "```RACE_WORK_ORDER_V1\n" + json.dumps(value or order()) + "\n```"


def context():
    return ({"sender": {"login": "Fadinggo"}, "repository": {"full_name": "Fadinggo/race"},
             "action": "labeled", "issue": {"number": NUMBER}},
            {"GITHUB_REPOSITORY": "Fadinggo/race", "GITHUB_REF": "refs/heads/main",
             "GITHUB_ACTOR": "Fadinggo", "GITHUB_TRIGGERING_ACTOR": "Fadinggo",
             "GITHUB_EVENT_NAME": "issues"})


class FakeAPI:
    def __init__(self):
        self.calls = []
        self.repo = {"full_name": "Fadinggo/race", "default_branch": "main"}
        self.issue = {"number": NUMBER, "state": "open", "user": {"login": "Fadinggo"},
                      "labels": [{"name": "codex-maintenance"}], "body": issue_body()}
        self.head = None
        self.doc = None
        self.original = None
        self.comments = []
        self.main_order = None
        self.initial_sha = PREPARE
        self.ref_conflict = False
        self.ahead_by = 1

    def request(self, method, path, payload=None, *, allow_404=False):
        self.calls.append((method, path, copy.deepcopy(payload)))
        if method == "GET":
            if path == "":
                return self.repo
            if path == f"/issues/{NUMBER}":
                return self.issue
            if path == f"/git/ref/heads/codex/maintenance-{NUMBER}":
                return None if self.head is None else {"object": {"sha": self.head}}
            if path == "/git/ref/heads/main":
                return {"object": {"sha": BASE}}
            if path == "/git/commits/" + BASE:
                return {"tree": {"sha": TREE}}
            if path.startswith(f"/contents/.maintenance/work-orders/{NUMBER}.json?ref="):
                ref = path.split("?ref=", 1)[1]
                doc = self.main_order if ref == BASE else (self.original if ref == self.initial_sha else self.doc)
                if doc is None:
                    return None
                return {"type": "file", "path": f".maintenance/work-orders/{NUMBER}.json",
                        "encoding": "base64", "content": base64.b64encode(json.dumps(doc).encode()).decode()}
            if path.startswith("/compare/"):
                commits = [{"sha": self.initial_sha, "parents": [{"sha": BASE, "url": "ignored"}],
                            "commit": {"message": f"Prepare maintenance work order #{NUMBER}"}}]
                if self.head != self.initial_sha:
                    commits.append({"sha": self.head})
                return {"status": "ahead", "ahead_by": self.ahead_by,
                        "total_commits": len(commits), "commits": commits}
            if path == f"/issues/{NUMBER}/comments?per_page=100&page=1":
                return self.comments
        if method == "POST":
            if path == "/git/blobs":
                self.doc = json.loads(payload["content"])
                self.original = copy.deepcopy(self.doc)
                return {"sha": BLOB}
            if path == "/git/trees":
                return {"sha": NEW_TREE}
            if path == "/git/commits":
                return {"sha": PREPARE}
            if path == "/git/refs":
                self.head = PREPARE
                if self.ref_conflict:
                    raise dispatch.DispatchError("github_http_422")
                return {"ref": payload["ref"]}
            if path == f"/issues/{NUMBER}/comments":
                self.comments.append({"user": {"login": "github-actions[bot]", "type": "Bot",
                                               "id": dispatch.GITHUB_ACTIONS_BOT_ID},
                                      "body": payload["body"]})
                return {"id": 1}
        raise AssertionError((method, path, payload, allow_404))

    def writes(self):
        return [call for call in self.calls if call[0] != "GET"]


class WorkOrderTests(unittest.TestCase):
    def test_smoke_placeholder_is_normalized_before_hash(self):
        normalized = dispatch.parse_work_order(issue_body(), NUMBER)
        self.assertEqual(normalized["allowed_paths"], [".maintenance/results/23.md"])
        explicit = order()
        explicit["allowed_paths"] = [".maintenance/results/23.md"]
        self.assertEqual(dispatch.canonical_digest(normalized), dispatch.canonical_digest(explicit))

    def test_maintenance_allowlist(self):
        value = order("maintenance")
        value["allowed_paths"] = ["dashboard.js", "index.html", "README.md", "HANDOFF.md",
                                  "tests/test_dashboard.py", "tests/dashboard.test.js"]
        self.assertEqual(dispatch.validate_work_order(value, NUMBER), value)

    def test_protected_and_nonliteral_paths_rejected(self):
        paths = [".github/workflows/update-dashboard.yml", "AGENTS.md", "MAINTENANCE.md",
                 "scripts/maintenance_dispatch.py", "scripts/gha_snapshot.py", "data.json",
                 "history.json", "checkpoint.json", ".env", "secrets.json", "trades.csv",
                 "tests/test_maintenance_dispatch.py", "tests/maintenance.test.js",
                 "tests/test_other_maintenance.py", "../dashboard.js", "/dashboard.js",
                 "tests/../dashboard.js", "tests\\test_ok.py", "tests/*.py",
                 "https://evil.invalid/file", "dashboard.js\n", "README.md/anything"]
        for path in paths:
            with self.subTest(path=path), self.assertRaises(dispatch.DispatchError):
                value = order("maintenance")
                value["allowed_paths"] = [path]
                dispatch.validate_work_order(value, NUMBER)

    def test_smoke_cannot_touch_other_issue_or_dashboard(self):
        for path in [".maintenance/results/24.md", "dashboard.js", ".maintenance/results/*.md"]:
            with self.subTest(path=path), self.assertRaises(dispatch.DispatchError):
                value = order()
                value["allowed_paths"] = [path]
                dispatch.validate_work_order(value, NUMBER)

    def test_duplicate_paths_after_normalization_rejected(self):
        value = order()
        value["allowed_paths"].append(".maintenance/results/23.md")
        with self.assertRaisesRegex(dispatch.DispatchError, "duplicate"):
            dispatch.validate_work_order(value, NUMBER)

    def test_invalid_fields_types_and_limits(self):
        cases = [{"version": True}, {"version": 2}, {"kind": "trade"}, {"objective": " "},
                 {"objective": "a" * 2001}, {"objective": "unsafe\x00value"},
                 {"allowed_paths": []}, {"allowed_paths": "dashboard.js"},
                 {"acceptance": []}, {"acceptance": ["a"] * 11},
                 {"acceptance": ["a" * 501]}, {"acceptance": [None]}, {"extra": "value"}]
        for change in cases:
            with self.subTest(change=list(change)), self.assertRaises(dispatch.DispatchError):
                dispatch.validate_work_order(order() | change, NUMBER)

    def test_sensitive_literals_rejected(self):
        for text in ["-----BEGIN PRIVATE KEY-----", "github_pat_abc123",
                     "api_key: value", "secret_key=value", "order_id=12345", "uid: 123"]:
            with self.subTest(text=text), self.assertRaisesRegex(dispatch.DispatchError, "sensitive"):
                dispatch.validate_work_order(order() | {"objective": text}, NUMBER)

    def test_exactly_one_json_block_and_no_duplicate_keys(self):
        bad = ["{}", "```json\n{}\n```", issue_body() + "\n" + issue_body(),
               '```RACE_WORK_ORDER_V1\n{"version":1,"version":1}\n```',
               "```RACE_WORK_ORDER_V1\nnot json\n```", "x" * 12001]
        for body in bad:
            with self.subTest(body=body[:35]), self.assertRaises(dispatch.DispatchError):
                dispatch.parse_work_order(body, NUMBER)

    def test_text_outside_block_is_not_saved(self):
        parsed = dispatch.parse_work_order("Ignore this shell command.\n" + issue_body(), NUMBER)
        self.assertEqual(parsed["objective"], order()["objective"])


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.event, self.env = context()
        self.api = FakeAPI()

    def run_dispatch(self):
        return dispatch.dispatch(self.event, self.env, self.api)

    def test_creates_one_work_order_branch_and_ready_comment_only(self):
        result = self.run_dispatch()
        self.assertEqual(result["status"], "ready")
        writes = self.api.writes()
        self.assertEqual([entry[1] for entry in writes],
                         ["/git/blobs", "/git/trees", "/git/commits", "/git/refs", "/issues/23/comments"])
        self.assertEqual(writes[1][2], {"base_tree": TREE, "tree": [
            {"path": ".maintenance/work-orders/23.json", "mode": "100644", "type": "blob", "sha": BLOB}]})
        self.assertEqual(writes[2][2]["parents"], [BASE])
        self.assertEqual(writes[3][2], {"ref": "refs/heads/codex/maintenance-23", "sha": PREPARE})
        self.assertEqual(set(self.api.doc), dispatch.ENVELOPE_FIELDS)
        comment = self.api.comments[0]["body"]
        self.assertIn("Initial commit: `" + PREPARE, comment)
        self.assertNotIn("@codex", comment)

    def test_retry_after_branch_advances_does_not_write_or_change_anchor(self):
        self.run_dispatch()
        self.api.head = LATER
        self.api.ahead_by = 2
        self.api.calls = []
        self.run_dispatch()
        self.assertEqual(self.api.writes(), [])
        self.assertIn("Initial commit: `" + PREPARE, self.api.comments[0]["body"])

    def test_retry_after_comment_failure_posts_only_missing_comment(self):
        self.run_dispatch()
        self.api.comments = []
        self.api.calls = []
        self.run_dispatch()
        self.assertEqual([call[1] for call in self.api.writes()], ["/issues/23/comments"])

    def test_changed_issue_order_does_not_overwrite_existing_branch(self):
        self.run_dispatch()
        self.api.issue["body"] = issue_body(order() | {"objective": "Different work"})
        self.api.calls = []
        with self.assertRaisesRegex(dispatch.DispatchError, "mismatch"):
            self.run_dispatch()
        self.assertEqual(self.api.writes(), [])

    def test_existing_order_changed_on_branch_rejected(self):
        self.run_dispatch()
        self.api.head = LATER
        self.api.doc["work_order"]["objective"] = "Changed on branch"
        with self.assertRaisesRegex(dispatch.DispatchError, "mismatch"):
            self.run_dispatch()

    def test_force_rewrite_is_detected_by_existing_bot_comment(self):
        self.run_dispatch()
        self.api.head = self.api.initial_sha = LATER
        self.api.calls = []
        with self.assertRaisesRegex(dispatch.DispatchError, "ready_comment_mismatch"):
            self.run_dispatch()
        self.assertEqual(self.api.writes(), [])

    def test_manual_owner_retry(self):
        self.env["GITHUB_EVENT_NAME"] = "workflow_dispatch"
        self.event["inputs"] = {"issue_number": "23"}
        self.assertEqual(self.run_dispatch()["issue_number"], NUMBER)

    def test_foreign_actor_sender_repo_ref_rejected_before_api(self):
        for key, value in [("GITHUB_ACTOR", "outsider"), ("GITHUB_TRIGGERING_ACTOR", "outsider"),
                           ("GITHUB_REPOSITORY", "other/race"), ("GITHUB_REF", "refs/heads/evil")]:
            with self.subTest(key=key):
                event, env = context()
                env[key] = value
                api = FakeAPI()
                with self.assertRaisesRegex(dispatch.DispatchError, "not_authorized"):
                    dispatch.dispatch(event, env, api)
                self.assertEqual(api.calls, [])
        self.event["sender"]["login"] = "outsider"
        with self.assertRaises(dispatch.DispatchError):
            self.run_dispatch()
        self.assertEqual(self.api.calls, [])

    def test_unauthorized_issue_cases_never_write(self):
        cases = [{"user": {"login": "outsider"}}, {"state": "closed"}, {"pull_request": {}},
                 {"labels": []}, {"labels": [{"name": "codex-maintenance-extra"}]}, {"number": 24}]
        for change in cases:
            with self.subTest(change=change):
                api = FakeAPI()
                api.issue.update(change)
                with self.assertRaisesRegex(dispatch.DispatchError, "issue_not_authorized"):
                    dispatch.dispatch(self.event, self.env, api)
                self.assertEqual(api.writes(), [])

    def test_invalid_repository_default_branch_rejected(self):
        self.api.repo["default_branch"] = "other"
        with self.assertRaisesRegex(dispatch.DispatchError, "repository_not_supported"):
            self.run_dispatch()
        self.assertEqual(self.api.writes(), [])

    def test_order_already_in_main_is_not_recreated(self):
        self.api.main_order = {"already": "merged"}
        with self.assertRaisesRegex(dispatch.DispatchError, "already_in_main"):
            self.run_dispatch()
        self.assertEqual(self.api.writes(), [])

    def test_multibyte_envelope_size_checked_before_any_write(self):
        large = order() | {"objective": "字" * 2000, "acceptance": ["字" * 500] * 10}
        self.api.issue["body"] = "```RACE_WORK_ORDER_V1\n" + json.dumps(large, ensure_ascii=False) + "\n```"
        with self.assertRaisesRegex(dispatch.DispatchError, "work_order_too_large"):
            self.run_dispatch()
        self.assertEqual(self.api.writes(), [])

    def test_equivalent_ref_creation_race_is_safe(self):
        self.api.ref_conflict = True
        self.assertEqual(self.run_dispatch()["status"], "ready")
        self.assertEqual(len(self.api.comments), 1)

    def test_forged_user_marker_is_not_treated_as_bot_receipt(self):
        self.api.comments = [{"user": {"login": "Fadinggo", "type": "User"},
                              "body": "<!-- race-maintenance-dispatch:v1 issue=23 -->"}]
        self.run_dispatch()
        self.assertEqual(len(self.api.comments), 2)

    def test_history_limit_is_bounded(self):
        self.api.ahead_by = 101
        with self.assertRaisesRegex(dispatch.DispatchError, "history_invalid"):
            self.run_dispatch()
        self.assertEqual(self.api.comments, [])

    def test_invalid_issue_numbers_and_events(self):
        for value in [True, 0, -1, "23;whoami", "023", "1e2", 2147483648]:
            with self.subTest(value=value), self.assertRaises(dispatch.DispatchError):
                dispatch._issue_number(value)
        self.env["GITHUB_EVENT_NAME"] = "pull_request_target"
        with self.assertRaisesRegex(dispatch.DispatchError, "event_invalid"):
            self.run_dispatch()
        self.assertEqual(self.api.calls, [])


class HTTPTests(unittest.TestCase):
    def test_redirect_handler_refuses_following(self):
        with self.assertRaisesRegex(dispatch.DispatchError, "redirect_refused"):
            dispatch.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid")

    def test_http_errors_do_not_expose_remote_body_or_token(self):
        class Opener:
            def open(self, request, timeout):
                raise urllib.error.HTTPError(request.full_url, 403, "sensitive response", {},
                                             io.BytesIO(b"secret token text"))
        api = dispatch.GitHubAPI("fake-private-token", Opener())
        with self.assertRaises(dispatch.DispatchError) as caught:
            api.request("GET", "/issues/23")
        self.assertEqual(str(caught.exception), "github_http_403")

    def test_request_origin_and_path_are_fixed(self):
        api = dispatch.GitHubAPI("fake-token")
        for path in ["https://evil.invalid", "//evil.invalid", "/../../other/repo", "/%2e%2e/x"]:
            with self.subTest(path=path), self.assertRaisesRegex(dispatch.DispatchError, "request_invalid"):
                api.request("GET", path)
        with self.assertRaises(dispatch.DispatchError):
            api.request("PATCH", "/git/refs/heads/main")

    def test_optional_not_found_and_redirect_http_error(self):
        class Opener:
            status = 404
            def open(self, request, timeout):
                raise urllib.error.HTTPError(request.full_url, self.status, "", {}, None)
        opener = Opener()
        api = dispatch.GitHubAPI("fake-token", opener)
        self.assertIsNone(api.request("GET", "/git/ref/heads/missing", allow_404=True))
        opener.status = 302
        with self.assertRaisesRegex(dispatch.DispatchError, "redirect_refused"):
            api.request("GET", "/issues/23")


if __name__ == "__main__":
    unittest.main()
