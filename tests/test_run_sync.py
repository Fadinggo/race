import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("run_sync", Path(__file__).resolve().parents[1] / "scripts" / "run_sync.py")
sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync
SPEC.loader.exec_module(sync)


class FakeCommands:
    def __init__(self, repo):
        self.repo = repo
        self.calls = []
        self.remote = sync.ALLOWED_REMOTE
        self.pending_commit = False
        self.push_failures = 0
        self.dirty = False
        self.remote_diverged = False
        self.extra_staged = False
        self.export_code = 0
        self.mismatched_output = False
        self.export_count = 0

    def __call__(self, argv, **options):
        self.calls.append((argv, options))
        if len(argv) > 1 and str(argv[1]).endswith("okx_snapshot.py"):
            self.export_count += 1
            if self.export_code == 0:
                (self.repo / "data.json").write_text(json.dumps({
                    "snapshot_id": "batch", "traders": {}, "trades": []
                }), encoding="utf-8")
                (self.repo / "history.json").write_text(json.dumps({
                    "snapshot_id": "wrong" if self.mismatched_output else "batch", "series": {}
                }), encoding="utf-8")
            return subprocess.CompletedProcess(argv, self.export_code, "", "DO_NOT_LOG_API_SECRET")
        args = argv[argv.index("-C") + 2:]
        result, output = 0, ""
        if args == ["rev-parse", "--show-toplevel"]:
            output = str(self.repo) + "\n"
        elif args[:2] == ["remote", "get-url"]:
            output = self.remote + "\n"
        elif args[:1] == ["symbolic-ref"]:
            output = "main\n"
        elif args[:1] == ["status"]:
            output = " M unrelated.txt\n" if self.dirty else ""
        elif args == ["rev-parse", "--git-dir"]:
            output = ".git\n"
        elif args[:1] == ["fetch"]:
            pass
        elif args[:1] == ["merge-base"]:
            result = 1 if self.remote_diverged else 0
        elif args[:1] == ["log"]:
            output = "data.json\nhistory.json\n" if self.pending_commit else ""
        elif args[:1] == ["add"]:
            pass
        elif args == ["diff", "--cached", "--name-only", "-z"]:
            output = "data.json\0history.json\0" + (".env\0" if self.extra_staged else "")
        elif args[:3] == ["diff", "--cached", "--quiet"]:
            result = 1
        elif args[:1] == ["commit"]:
            self.pending_commit = True
        elif args[:1] == ["push"]:
            if self.push_failures:
                self.push_failures -= 1
                result = 1
            else:
                self.pending_commit = False
        else:
            raise AssertionError(f"Unexpected test command: {args}")
        return subprocess.CompletedProcess(argv, result, output, "DO_NOT_LOG_API_SECRET")

    def git_calls(self, operation):
        return [argv[argv.index("-C") + 2:] for argv, _ in self.calls
                if "-C" in argv and argv[argv.index("-C") + 2] == operation]


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        (self.repo / ".git").mkdir()
        (self.repo / "scripts" / "okx_snapshot.py").write_text("# test exporter", encoding="utf-8")
        self.private = self.base / "private"
        self.private.mkdir()
        self.config = self.private / "config.json"
        self.config.write_text("{}", encoding="utf-8")
        self.key = self.private / "deploy-key"
        self.key.write_text("TEST_ONLY_NOT_A_KEY", encoding="utf-8")
        self.hosts = self.private / "known_hosts"
        self.hosts.write_text(sync.OFFICIAL_HOST_KEY + "\n", encoding="utf-8")
        self.settings = sync.validate_settings(sync.Settings(
            self.repo, self.config, self.private / "state", self.key, self.hosts
        ))
        self.commands = FakeCommands(self.repo)
        self.events = []

    def runner(self, *, pending=lambda: False, no_push=False):
        settings = sync.Settings(**{**vars(self.settings), "no_push": no_push})
        return sync.SyncRunner(settings, execute=self.commands, pending=pending, emit=self.events.append)

    def test_only_whitelisted_paths_can_be_staged_and_committed(self):
        self.assertEqual(self.runner().cycle(), "snapshot_pushed")
        self.assertEqual(self.commands.git_calls("add"), [["add", "--", "data.json", "history.json"]])
        commit = self.commands.git_calls("commit")[0]
        self.assertIn("--only", commit)
        self.assertEqual(commit[-2:], ["data.json", "history.json"])
        self.assertEqual(self.commands.git_calls("push"), [["push", "--porcelain", "origin", "HEAD:refs/heads/main"]])
        for argv, options in self.commands.calls:
            self.assertFalse(options["shell"])
            self.assertGreater(options["timeout"], 0)
            self.assertNotIn("--force", argv)
            self.assertNotIn("reset", argv)
            if "-C" in argv:
                self.assertIn("user.name=race-dashboard", argv)

    def test_rejects_wrong_https_token_or_upstream_remote_before_export(self):
        for remote in ("https://github.com/Fadinggo/race.git", "git@github.com:wuyulun0823-lab/race.git",
                       "https://secret@github.com/Fadinggo/race.git"):
            self.commands.remote = remote
            self.assertEqual(self.runner().cycle(), "unexpected_github_remote")
        self.assertEqual(self.commands.export_count, 0)
        self.assertFalse(self.commands.git_calls("push"))
        self.assertNotIn("secret", str(self.events))

    def test_private_paths_cannot_be_in_this_or_another_checkout(self):
        unsafe = self.repo / "config.private.json"
        unsafe.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(sync.SyncError, "inside_repository"):
            sync.validate_settings(sync.Settings(**{**vars(self.settings), "config": unsafe}))
        another = self.base / "another-repo"
        another.mkdir()
        (another / ".git").mkdir()
        with self.assertRaisesRegex(sync.SyncError, "inside_git_checkout"):
            sync.validate_settings(sync.Settings(**{**vars(self.settings), "state_dir": another / "state"}))

    def test_pages_build_pending_keeps_commit_without_pushing(self):
        runner = self.runner(pending=lambda: True)
        self.assertEqual(runner.cycle(), "pages_build_pending_commit_retained")
        self.assertTrue(self.commands.pending_commit)
        self.assertEqual(len(self.commands.git_calls("commit")), 1)
        self.assertFalse(self.commands.git_calls("push"))

    def test_failed_push_keeps_commit_and_next_cycle_retries_without_rewriting_history(self):
        self.commands.push_failures = 1
        runner = self.runner()
        self.assertEqual(runner.cycle(), "push_failed_commit_retained")
        self.assertTrue(self.commands.pending_commit)
        self.assertEqual(runner.cycle(), "snapshot_pushed")
        self.assertEqual(len(self.commands.git_calls("push")), 2)
        self.assertFalse(self.commands.pending_commit)
        for forbidden in ("reset", "rebase", "merge", "clean"):
            self.assertFalse(self.commands.git_calls(forbidden))
        self.assertNotIn("DO_NOT_LOG_API_SECRET", str(self.events))

    def test_failed_export_or_mixed_output_does_not_stage_or_push(self):
        self.commands.export_code = 2
        self.assertEqual(self.runner().cycle(), "export_failed_no_publish")
        self.commands.export_code = 0
        self.commands.mismatched_output = True
        self.assertEqual(self.runner().cycle(), "invalid_exported_snapshot_pair")
        self.assertFalse(self.commands.git_calls("add"))
        self.assertFalse(self.commands.git_calls("push"))

    def test_unrelated_staged_changes_are_not_committed(self):
        self.commands.extra_staged = True
        self.assertEqual(self.runner().cycle(), "unexpected_staged_files_need_review")
        self.assertFalse(self.commands.git_calls("commit"))
        self.assertFalse(self.commands.git_calls("push"))

    def test_dirty_checkout_and_diverged_remote_require_manual_review(self):
        self.commands.dirty = True
        self.assertEqual(self.runner().cycle(), "local_changes_need_review")
        self.commands.dirty = False
        self.commands.remote_diverged = True
        self.assertEqual(self.runner().cycle(), "remote_changed_manual_reconcile_required")
        self.assertEqual(self.commands.export_count, 0)

    def test_no_push_only_creates_local_commit(self):
        def forbidden_check():
            raise AssertionError("No-push mode should not poll Pages builds")
        self.assertEqual(self.runner(pending=forbidden_check, no_push=True).cycle(), "dry_run_local_commit_no_push")
        self.assertTrue(self.commands.pending_commit)
        self.assertFalse(self.commands.git_calls("push"))

    def test_failed_build_status_check_retains_local_commit(self):
        def unavailable():
            raise sync.SyncError("pages_status_unavailable")
        self.assertEqual(self.runner(pending=unavailable).cycle(), "pages_status_unavailable")
        self.assertTrue(self.commands.pending_commit)
        self.assertFalse(self.commands.git_calls("push"))

    def test_host_key_pin_and_noninteractive_identity_settings(self):
        with patch.dict("os.environ", {"OKX_API_KEY": "SECRET_VALUE", "GIT_DIR": "untrusted"}):
            runner = self.runner()
        self.assertNotIn("OKX_API_KEY", runner.environment)
        self.assertNotIn("GIT_DIR", runner.environment)
        config = (self.settings.state_dir / "ssh_config").read_text(encoding="utf-8")
        self.assertIn("StrictHostKeyChecking yes", config)
        self.assertIn("IdentitiesOnly yes", config)
        self.assertIn("IdentityAgent none", config)
        self.assertIn("BatchMode yes", config)
        self.hosts.write_text(sync.OFFICIAL_HOST_KEY + "\ngithub.com ssh-ed25519 UNTRUSTED\n", encoding="utf-8")
        with self.assertRaisesRegex(sync.SyncError, "not_pinned"):
            sync.validate_settings(self.settings)

    def test_same_checkout_cannot_run_twice_even_with_different_private_state(self):
        with sync.repository_lock(self.repo):
            with self.assertRaisesRegex(sync.SyncError, "another_sync"):
                with sync.repository_lock(self.repo):
                    self.fail("second lock should not be acquired")


if __name__ == "__main__":
    unittest.main()
