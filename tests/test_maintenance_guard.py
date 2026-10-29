import copy
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import urllib.error


SPEC = importlib.util.spec_from_file_location("maintenance_guard", Path(__file__).resolve().parents[1] / "scripts" / "maintenance_guard.py")
guard = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = guard
SPEC.loader.exec_module(guard)


def sample_order(kind="maintenance", paths=None):
    return {"version": 1, "kind": kind, "objective": "Verify the maintenance handoff",
            "allowed_paths": paths or ["README.md"], "acceptance": ["Regression checks pass"]}


def sample_envelope(order=None, base="a" * 40):
    order = order or sample_order()
    return {"schema": guard.SCHEMA, "issue_number": 7,
            "issue_url": "https://github.com/Fadinggo/race/issues/7", "requested_by": "Fadinggo",
            "base_commit": base, "work_order_sha256": guard.canonical_digest(order), "work_order": order}


def bot_comment(doc, prepare="b" * 40):
    return {"user": {"id": 41898282, "login": "github-actions[bot]", "type": "Bot"},
            "body": guard.ready_comment(doc, prepare)}


class WorkOrderTests(unittest.TestCase):
    def test_whitelist_rejects_traversal_control_files_and_maintenance_tests(self):
        bad = ["../README.md", "/README.md", "tests/../dashboard.js", "tests\\test_x.py", "C:/README.md",
               "tests//test_x.py", ".github/workflows/update-dashboard.yml", "scripts/gha_snapshot.py",
               "AGENTS.md", "config.example.json", "data.json", "history.json", "state-checkpoint.json",
               "tests/test_maintenance_guard.py", "tests/maintenance.test.js", "tests/test_x_maintenance.py",
               "tests/test_x.py\n", "tests/__init__.py"]
        for path in bad:
            with self.subTest(path=path), self.assertRaises(guard.GuardError):
                guard.validate_order(sample_order(paths=[path]), 7)
        for path in ("dashboard.js", "index.html", "README.md", "HANDOFF.md", "tests/test_dashboard.py", "tests/dashboard.test.js"):
            guard.validate_order(sample_order(paths=[path]), 7)

    def test_smoke_result_is_bound_to_its_issue_number(self):
        guard.validate_order(sample_order("smoke", [".maintenance/results/7.md"]), 7)
        for path in (".maintenance/results/8.md", ".maintenance/results/{issue_number}.md", "README.md"):
            with self.assertRaises(guard.GuardError):
                guard.validate_order(sample_order("smoke", [path]), 7)

    def test_duplicate_fields_invalid_identity_and_digest_are_rejected(self):
        doc = sample_envelope()
        valid = json.dumps(doc).encode()
        self.assertEqual(guard.parse_envelope(valid, 7), doc)
        with self.assertRaisesRegex(guard.GuardError, "duplicate_json_key"):
            guard.parse_envelope(valid[:-1] + b',"schema":"RACE_WORK_ORDER_V1"}', 7)
        for field, value in (("schema", "v2"), ("issue_number", True), ("issue_url", "https://evil.invalid"),
                             ("requested_by", "someone"), ("work_order_sha256", "0" * 64)):
            with self.subTest(field=field), self.assertRaises(guard.GuardError):
                guard.parse_envelope(json.dumps({**doc, field: value}).encode(), 7)
        with self.assertRaises(guard.GuardError):
            guard.parse_envelope(json.dumps({**doc, "extra": True}).encode(), 7)

    def test_order_boundary_validation_rejects_ambiguous_values(self):
        for field, value in (("version", True), ("kind", "shell"), ("objective", " "),
                             ("acceptance", []), ("acceptance", [4]), ("allowed_paths", ["README.md", "README.md"]),
                             ("allowed_paths", [4])):
            with self.subTest(field=field), self.assertRaises(guard.GuardError):
                guard.validate_order({**sample_order(), field: value}, 7)


class GitHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Maintenance Test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "core.autocrlf", "false")
        self.write("README.md", "Original\n")
        self.write("data.json", "{}\n")
        self.base = self.commit("Base")
        self.doc = sample_envelope(base=self.base)
        self.order_path = ".maintenance/work-orders/7.json"
        self.write_order()
        self.prepare = self.commit("Prepare maintenance work order #7")

    def git(self, *args, input=None):
        result = subprocess.run(["git", "-C", str(self.repo), *args], input=input, capture_output=True,
                                encoding="utf-8", shell=False, timeout=30)
        if result.returncode:
            self.fail("Fixture Git failed: " + result.stderr)
        return result.stdout.strip()

    def write(self, path, text):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def write_order(self):
        self.write(self.order_path, json.dumps(self.doc, ensure_ascii=False, sort_keys=True, indent=2) + "\n")

    def commit(self, message):
        self.git("add", "-A")
        self.git("-c", "commit.gpgsign=false", "commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def invoke(self, **overrides):
        options = {"base_sha": self.base, "head_sha": self.git("rev-parse", "HEAD"),
                   "head_ref": "codex/maintenance-7", "repository": "Fadinggo/race",
                   "head_repository": "Fadinggo/race", "anchor_loader": lambda doc: self.prepare}
        return guard.verify(self.repo, **{**options, **overrides})

    def test_initial_branch_and_bounded_edit_pass(self):
        self.assertEqual(self.invoke()["changed_paths"], [])
        self.write("README.md", "Maintenance complete\n")
        self.commit("Document result")
        self.assertEqual(self.invoke()["changed_paths"], ["README.md"])

    def test_smoke_result_passes_without_touching_live_data(self):
        self.git("reset", "--hard", self.base)
        self.doc = sample_envelope(sample_order("smoke", [".maintenance/results/7.md"]), self.base)
        self.write_order()
        self.prepare = self.commit("Prepare maintenance work order #7")
        self.write(".maintenance/results/7.md", "Checks passed; no trading changes.\n")
        self.commit("Record smoke result")
        self.assertEqual(self.invoke()["kind"], "smoke")

    def test_main_advancement_does_not_invalidate_original_order(self):
        self.git("checkout", "-q", "--detach", self.base)
        self.write("data.json", '{"new_snapshot":true}\n')
        newer_main = self.commit("Update snapshot")
        self.git("checkout", "-q", "--detach", self.prepare)
        self.write("README.md", "Maintenance complete\n")
        self.commit("Document result")
        self.assertEqual(self.invoke(base_sha=newer_main)["prepare_commit"], self.prepare)

    def test_trusted_base_checkout_inspects_head_objects_without_loading_pr_files(self):
        self.write("README.md", "PR-only contents\n")
        head = self.commit("Document result")
        self.git("checkout", "-q", "--detach", self.base)
        result = self.invoke(head_sha=head, checkout_sha=self.base)
        self.assertEqual(result["head_sha"], head)
        self.assertEqual(result["base_sha"], self.base)
        self.assertEqual(result["changed_paths"], ["README.md"])
        self.assertEqual(self.git("rev-parse", "HEAD"), self.base)
        self.assertEqual((self.repo / "README.md").read_text(), "Original\n")
        self.assertFalse((self.repo / self.order_path).exists())
        with self.assertRaisesRegex(guard.GuardError, "invalid_trusted_checkout_sha"):
            self.invoke(head_sha=head, checkout_sha=head)

    def test_trusted_base_checkout_still_rejects_protected_head_changes(self):
        self.write(".github/workflows/maintenance-checks.yml", "attacker supplied workflow\n")
        head = self.commit("Try replacing scope checks")
        self.git("checkout", "-q", "--detach", self.base)
        with self.assertRaisesRegex(guard.GuardError, "changed_path_outside_work_order"):
            self.invoke(head_sha=head, checkout_sha=self.base)

    def test_protected_edit_and_reverted_protected_edit_are_rejected(self):
        self.write("data.json", '{"changed":true}\n')
        self.commit("Unauthorized snapshot edit")
        with self.assertRaisesRegex(guard.GuardError, "changed_path_outside_work_order"):
            self.invoke()
        self.write("data.json", "{}\n")
        self.commit("Revert snapshot")
        with self.assertRaisesRegex(guard.GuardError, "changed_path_outside_work_order"):
            self.invoke()

    def test_edited_and_then_restored_order_is_still_rejected(self):
        original = copy.deepcopy(self.doc)
        self.doc["work_order"]["allowed_paths"].append("dashboard.js")
        self.doc["work_order_sha256"] = guard.canonical_digest(self.doc["work_order"])
        self.write_order()
        self.commit("Alter scope")
        with self.assertRaisesRegex(guard.GuardError, "work_order_was_modified"):
            self.invoke()
        self.doc = original
        self.write_order()
        self.commit("Restore scope")
        with self.assertRaisesRegex(guard.GuardError, "work_order_was_modified"):
            self.invoke()

    def test_rewritten_original_order_fails_external_anchor(self):
        original_prepare = self.prepare
        self.git("reset", "--hard", self.base)
        self.doc["work_order"]["objective"] = "Different task"
        self.doc["work_order_sha256"] = guard.canonical_digest(self.doc["work_order"])
        self.write_order()
        self.commit("Prepare maintenance work order #7")
        with self.assertRaisesRegex(guard.GuardError, "prepare_commit_anchor_mismatch"):
            self.invoke(anchor_loader=lambda doc: original_prepare)

    def test_prepare_commit_cannot_include_even_allowlisted_edits(self):
        self.git("reset", "--hard", self.base)
        self.write_order()
        self.write("README.md", "Premature edit\n")
        self.prepare = self.commit("Prepare maintenance work order #7")
        with self.assertRaisesRegex(guard.GuardError, "prepare_commit_must_only_add_work_order"):
            self.invoke()

    def test_symlink_and_executable_modes_are_rejected_without_following_them(self):
        for mode in ("120000", "100755"):
            with self.subTest(mode=mode):
                self.git("reset", "--hard", self.prepare)
                blob = self.git("hash-object", "-w", "--stdin", input="/tmp/private\n")
                self.git("update-index", "--cacheinfo", f"{mode},{blob},README.md")
                self.git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "Change file mode")
                self.git("reset", "--hard", "HEAD")
                with self.assertRaisesRegex(guard.GuardError, "non_regular_or_deleted_file"):
                    self.invoke()

    def test_deletion_and_rename_are_rejected(self):
        (self.repo / "README.md").unlink()
        self.commit("Delete file")
        with self.assertRaisesRegex(guard.GuardError, "non_regular_or_deleted_file"):
            self.invoke()
        self.git("reset", "--hard", self.prepare)
        self.git("mv", "README.md", "HANDOFF.md")
        self.commit("Rename file")
        with self.assertRaises(guard.GuardError):
            self.invoke()

    def test_merge_commits_are_rejected(self):
        self.git("checkout", "-q", "-b", "side", self.prepare)
        self.write("README.md", "Side\n")
        self.commit("Side update")
        self.git("checkout", "-q", "--detach", self.prepare)
        self.git("-c", "commit.gpgsign=false", "merge", "--no-ff", "side", "-m", "Merge side")
        with self.assertRaisesRegex(guard.GuardError, "maintenance_history_must_be_linear"):
            self.invoke()

    def test_fork_wrong_branch_wrong_base_and_dirty_checkout_are_rejected(self):
        for change in ({"head_repository": "other/race"}, {"head_ref": "codex/maintenance-7/evil"},
                       {"head_ref": "codex/maintenance-8"}, {"base_ref": "other"},
                       {"head_sha": "--help"}):
            with self.subTest(change=change), self.assertRaises(guard.GuardError):
                self.invoke(**change)
        self.write("untracked.py", "print('not authorized')\n")
        with self.assertRaisesRegex(guard.GuardError, "checkout_not_clean"):
            self.invoke()


class AnchorTests(unittest.TestCase):
    def test_author_name_alone_cannot_forge_a_dispatch_anchor(self):
        doc = sample_envelope()
        for field, value in (("id", 1), ("login", "someone"), ("type", "User")):
            comment = bot_comment(doc)
            comment["user"][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(guard.GuardError, "missing_or_conflicting"):
                guard.load_anchor(doc, fetch=lambda number, page: [comment])

    def test_complete_comment_must_match_order_and_only_one_anchor(self):
        doc = sample_envelope()
        self.assertEqual(guard.load_anchor(doc, fetch=lambda number, page: [bot_comment(doc)]), "b" * 40)
        for body in (bot_comment(doc)["body"] + "\nAltered", bot_comment(doc)["body"].replace("codex/maintenance-7", "codex/maintenance-8")):
            comment = {**bot_comment(doc), "body": body}
            with self.assertRaisesRegex(guard.GuardError, "trusted_ready_comment_mismatch"):
                guard.load_anchor(doc, fetch=lambda number, page: [comment])
        with self.assertRaisesRegex(guard.GuardError, "missing_or_conflicting"):
            guard.load_anchor(doc, fetch=lambda number, page: [bot_comment(doc), bot_comment(doc, "c" * 40)])

    def test_all_pages_are_checked_and_pagination_is_bounded(self):
        doc = sample_envelope()
        calls = []
        def fetch(number, page):
            calls.append((number, page))
            return [{}] * 100 if page == 1 else [bot_comment(doc)]
        self.assertEqual(guard.load_anchor(doc, fetch=fetch), "b" * 40)
        self.assertEqual(calls, [(7, 1), (7, 2)])
        with self.assertRaisesRegex(guard.GuardError, "page_limit"):
            guard.load_anchor(doc, fetch=lambda number, page: [bot_comment(doc)] * 100)


class FakeResponse:
    def __init__(self, url, body=b"[]", status=200):
        self.url, self.body, self.status = url, body, status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def geturl(self):
        return self.url

    def read(self, limit):
        return self.body[:limit]


class FakeOpener:
    def __init__(self, body=b"[]", changed_url=None, error=None):
        self.body, self.changed_url, self.error = body, changed_url, error
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if self.error:
            raise self.error
        return FakeResponse(self.changed_url or request.full_url, self.body)


class PublicAPITests(unittest.TestCase):
    def test_only_fixed_public_get_endpoint_is_requested_without_credentials(self):
        opener = FakeOpener()
        self.assertEqual(guard.public_comments(7, 2, opener=opener), [])
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, "https://api.github.com/repos/Fadinggo/race/issues/7/comments?per_page=100&page=2")
        self.assertEqual(request.get_method(), "GET")
        self.assertFalse(request.has_header("Authorization"))
        self.assertIsNone(request.data)
        self.assertEqual(timeout, 30)
        for number, page in (("7/../../secrets", 1), (True, 1), (7, 11), (0, 1)):
            with self.assertRaises(guard.GuardError):
                guard.public_comments(number, page, opener=opener)
        self.assertEqual(len(opener.requests), 1)

    def test_redirect_errors_oversized_and_malformed_responses_fail_closed(self):
        cases = [FakeOpener(changed_url="https://evil.invalid"), FakeOpener(b"not json"),
                 FakeOpener(b'{}'), FakeOpener(b"x" * (guard.MAX_RESPONSE_BYTES + 1)),
                 FakeOpener(error=urllib.error.URLError("SENSITIVE_REMOTE_TEXT"))]
        for opener in cases:
            with self.subTest(opener=opener), self.assertRaises(guard.GuardError) as raised:
                guard.public_comments(7, 1, opener=opener)
            self.assertNotIn("SENSITIVE_REMOTE_TEXT", str(raised.exception))
        with self.assertRaisesRegex(guard.GuardError, "redirect_refused"):
            guard.NoRedirect().redirect_request(None, None, 302, None, None, "https://evil.invalid")


class WorkflowIsolationTests(unittest.TestCase):
    def test_target_scope_and_untrusted_tests_run_in_separate_event_jobs(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/maintenance-checks.yml").read_text(encoding="utf-8")
        self.assertIn("  pull_request_target:\n", workflow)
        self.assertIn("  pull_request:\n", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("persist-credentials: true", workflow)
        self.assertEqual(re.findall(r"^      contents: (\w+)$", workflow, re.MULTILINE), ["read", "read"])
        self.assertNotRegex(workflow, r"(?m)^\s+[\w-]+: write$")
        target = workflow.split("  trusted-scope:\n", 1)[1].split("  regression-tests:\n", 1)[0]
        regression = workflow.split("  regression-tests:\n", 1)[1]
        self.assertIn("github.event_name == 'pull_request_target'", target)
        self.assertIn("github.event_name == 'pull_request'", regression)
        for job in (target, regression):
            self.assertIn("github.event.pull_request.head.repo.full_name == 'Fadinggo/race'", job)
            self.assertIn("startsWith(github.event.pull_request.head.ref, 'codex/maintenance-')", job)
        # No PR checkout, local action, or executable PR test is permitted in
        # the target event. These are the three narrowly allowed shell steps.
        self.assertEqual(target.count("uses: actions/checkout@"), 1)
        self.assertIn("ref: ${{ github.event.pull_request.base.sha }}", target)
        self.assertNotIn("ref: ${{ github.event.pull_request.head.sha }}", target)
        self.assertEqual(re.findall(r"^        run: (.*)$", target, re.MULTILINE), [
            'cp scripts/maintenance_guard.py "$RUNNER_TEMP/race-maintenance-guard.py"', ">-", ">-"
        ])
        self.assertIn('git -c core.hooksPath=/dev/null fetch --no-tags --no-recurse-submodules', target)
        self.assertIn('https://github.com/Fadinggo/race.git "$HEAD_SHA"', target)
        self.assertIn('python -I -B "$RUNNER_TEMP/race-maintenance-guard.py"', target)
        self.assertIn('--checkout-sha "$BASE_SHA"', target)
        self.assertNotIn("unittest", target)
        self.assertNotIn("node --test", target)
        self.assertNotIn("uses: ./", target)
        self.assertIn("ref: ${{ github.event.pull_request.head.sha }}", regression)
        self.assertEqual(re.findall(r"^        run: (.*)$", regression, re.MULTILINE), [
            "python -B -m unittest discover -s tests -p 'test_*.py'", "node --test tests/dashboard.test.js"
        ])


if __name__ == "__main__":
    unittest.main()
