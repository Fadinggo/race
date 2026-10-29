import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("gha_publish", Path(__file__).resolve().parents[1] / "scripts" / "gha_publish.py")
publish = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = publish
SPEC.loader.exec_module(publish)


class FakeGit:
    def __init__(self, repo):
        self.repo = repo
        self.calls = []
        self.remote = "https://github.com/Fadinggo/race"
        self.status = " M data.json\n M history.json\n?? state-checkpoint.json\n"
        self.staged = "data.json\0history.json\0state-checkpoint.json\0"
        self.remote_head = "current"
        self.push_failure = False

    def __call__(self, argv, **options):
        args = argv[argv.index("-C") + 2:]
        self.calls.append((args, options))
        result, output = 0, ""
        if args == ["rev-parse", "--show-toplevel"]:
            output = str(self.repo) + "\n"
        elif args[:1] == ["symbolic-ref"]:
            output = "main\n"
        elif args[:2] == ["remote", "get-url"]:
            output = self.remote + "\n"
        elif args[:1] == ["status"]:
            output = self.status
        elif args[:1] == ["fetch"]:
            pass
        elif args == ["rev-parse", "HEAD"]:
            output = "current\n"
        elif args == ["rev-parse", "origin/main"]:
            output = self.remote_head + "\n"
        elif args[:1] == ["add"]:
            pass
        elif args == ["diff", "--cached", "--name-only", "-z"]:
            output = self.staged
        elif args[:3] == ["diff", "--cached", "--quiet"]:
            result = 1
        elif args[:1] == ["commit"]:
            pass
        elif args[:1] == ["push"]:
            result = 1 if self.push_failure else 0
        else:
            raise AssertionError(f"Unexpected test Git command: {args}")
        return subprocess.CompletedProcess(argv, result, output, "SECRET_RAW_STDERR_MUST_NOT_ESCAPE")

    def operations(self, name):
        return [args for args, _ in self.calls if args[0] == name]


class GitHubPublishTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.repo = base / "checkout"
        self.repo.mkdir()
        self.runner_temp = base / "runner-temp"
        self.runner_temp.mkdir()
        self.site = self.runner_temp / "race-pages"
        self.environment = {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "Fadinggo/race", "GITHUB_REF": "refs/heads/main",
            "GITHUB_WORKSPACE": str(self.repo), "RUNNER_TEMP": str(self.runner_temp)
        }
        for filename in publish.PAGE_FILES:
            (self.repo / filename).write_text("public page" if filename != ".nojekyll" else "", encoding="utf-8")
        (self.repo / "data.json").write_text(json.dumps({
            "snapshot_id": "batch-1", "source": "own-okx-readonly", "traders": {}, "trades": []
        }), encoding="utf-8")
        (self.repo / "history.json").write_text(json.dumps({"snapshot_id": "batch-1", "series": {}}), encoding="utf-8")
        (self.repo / "state-checkpoint.json").write_text(json.dumps({"snapshot_id": "batch-1", "signature": "opaque"}), encoding="utf-8")
        self.git = FakeGit(self.repo)

    def invoke(self, **kwargs):
        return publish.publish(self.repo, self.site, execute=self.git, environment=kwargs.get("environment", self.environment))

    def test_stages_only_three_snapshot_files_and_packages_only_five_public_files(self):
        (self.repo / ".env").write_text("TEST_SECRET", encoding="utf-8")
        self.assertEqual(self.invoke(), "snapshot_pushed_pages_ready")
        self.assertEqual(self.git.operations("add"), [["add", "--", *publish.GIT_FILES]])
        self.assertEqual(set(path.name for path in self.site.iterdir()), set(publish.PAGE_FILES))
        self.assertFalse((self.site / "state-checkpoint.json").exists())
        self.assertFalse((self.site / ".env").exists())
        self.assertIn("--only", self.git.operations("commit")[0])
        self.assertEqual(self.git.operations("push"), [["push", "--porcelain", "origin", "HEAD:refs/heads/main"]])
        for args, options in self.git.calls:
            self.assertFalse(options["shell"])
            self.assertEqual(options["timeout"], 60)
            self.assertNotIn("--force", args)

    def test_refuses_local_fork_and_non_main_execution(self):
        for changes in ({"GITHUB_ACTIONS": "false"}, {"GITHUB_REPOSITORY": "someone/race"}, {"GITHUB_REF": "refs/heads/feature"}):
            with self.assertRaisesRegex(publish.PublishError, "unexpected_actions_context"):
                self.invoke(environment={**self.environment, **changes})
        self.assertEqual(self.git.calls, [])

    def test_refuses_other_repository_or_token_in_remote(self):
        for remote in ("https://github.com/wuyulun0823-lab/race", "https://SECRET@github.com/Fadinggo/race",
                       "git@github.com:Fadinggo/race.git"):
            self.git.remote = remote
            with self.assertRaisesRegex(publish.PublishError, "unexpected_github_remote") as raised:
                self.invoke()
            self.assertNotIn("SECRET", str(raised.exception))
        self.assertFalse(self.git.operations("add"))

    def test_mismatched_checkpoint_cannot_be_published(self):
        (self.repo / "state-checkpoint.json").write_text('{"snapshot_id":"other"}', encoding="utf-8")
        with self.assertRaisesRegex(publish.PublishError, "invalid_three_file_snapshot"):
            self.invoke()
        self.assertEqual(self.git.calls, [])

    def test_non_owned_snapshot_source_cannot_be_published(self):
        path = self.repo / "data.json"
        data = json.loads(path.read_text())
        data["source"] = "upstream-copy"
        path.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(publish.PublishError, "invalid_three_file_snapshot"):
            self.invoke()

    def test_remote_advance_fails_without_rebase_reset_or_push(self):
        self.git.remote_head = "newer"
        with self.assertRaisesRegex(publish.PublishError, "remote_changed_retry_next_schedule"):
            self.invoke()
        self.assertFalse(self.git.operations("push"))
        self.assertFalse(self.git.operations("add"))
        self.assertFalse(self.git.operations("reset"))
        self.assertFalse(self.git.operations("rebase"))

    def test_unrelated_changes_or_staged_secrets_are_not_committed(self):
        self.git.status += "?? .env\n"
        with self.assertRaisesRegex(publish.PublishError, "non_snapshot_checkout_changes"):
            self.invoke()
        self.git.status = " M data.json\n"
        self.git.staged += ".env\0"
        with self.assertRaisesRegex(publish.PublishError, "unexpected_staged_file"):
            self.invoke()
        self.assertFalse(self.git.operations("commit"))
        self.assertFalse(self.git.operations("push"))

    def test_push_failure_never_logs_raw_stderr_or_force_pushes(self):
        self.git.push_failure = True
        with self.assertRaisesRegex(publish.PublishError, "snapshot_push_failed_retry_next_schedule") as raised:
            self.invoke()
        self.assertNotIn("SECRET_RAW_STDERR", str(raised.exception))
        self.assertEqual(len(self.git.operations("push")), 1)
        self.assertNotIn("--force", self.git.operations("push")[0])

    def test_pages_directory_must_be_separate_and_empty(self):
        with self.assertRaisesRegex(publish.PublishError, "runner_temp"):
            publish.publish(self.repo, self.repo / "site", execute=self.git, environment=self.environment)
        self.site.mkdir()
        (self.site / "private.txt").write_text("MUST_NOT_DEPLOY", encoding="utf-8")
        with self.assertRaisesRegex(publish.PublishError, "site_directory_not_empty"):
            self.invoke()
        self.assertFalse(self.git.operations("commit"))


if __name__ == "__main__":
    unittest.main()
