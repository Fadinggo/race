#!/usr/bin/env python3
"""Run the read-only OKX exporter and publish only its two dashboard JSON files."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request


ALLOWED_REMOTE = "git@github.com:Fadinggo/race.git"
ALLOWED_FILES = frozenset({"data.json", "history.json"})
OFFICIAL_HOST_KEY = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
RUNS_URL = "https://api.github.com/repos/Fadinggo/race/actions/runs?per_page=100"
ACTIVE_RUN_STATES = frozenset({"queued", "in_progress", "waiting", "pending", "requested"})


class SyncError(Exception):
    """The code is a fixed, log-safe string, never a subprocess error message."""


@dataclass(frozen=True)
class Settings:
    repo: Path
    config: Path
    state_dir: Path
    ssh_key: Path
    known_hosts: Path
    interval: int = 300
    once: bool = False
    no_push: bool = False


def private_path(path: Path, repo: Path, *, must_exist: bool) -> Path:
    lexical = Path(os.path.abspath(path.expanduser()))
    resolved = lexical.resolve()
    for candidate in (lexical, resolved):
        if candidate == repo or repo in candidate.parents:
            raise SyncError("private_path_inside_repository")
        if any((parent / ".git").exists() for parent in (candidate, *candidate.parents)):
            raise SyncError("private_path_inside_git_checkout")
        if any(character in str(candidate) for character in ('\r', '\n', '\0', '"')):
            raise SyncError("unsupported_private_path")
    if must_exist and not resolved.is_file():
        raise SyncError("private_file_missing")
    return resolved


def validate_settings(settings: Settings) -> Settings:
    repo = settings.repo.expanduser().resolve()
    if not repo.is_dir() or not (repo / "scripts" / "okx_snapshot.py").is_file():
        raise SyncError("repository_or_exporter_missing")
    if settings.interval < 300 or settings.interval > 86400:
        raise SyncError("interval_out_of_range")
    config = private_path(settings.config, repo, must_exist=True)
    state = private_path(settings.state_dir, repo, must_exist=False)
    key = private_path(settings.ssh_key, repo, must_exist=True)
    known_hosts = private_path(settings.known_hosts, repo, must_exist=True)
    if state.exists() and not state.is_dir():
        raise SyncError("invalid_state_directory")
    try:
        host_lines = [" ".join(line.split()) for line in known_hosts.read_text(encoding="utf-8-sig").splitlines()
                      if line.strip() and not line.lstrip().startswith("#")]
    except (OSError, UnicodeError):
        raise SyncError("known_hosts_unreadable") from None
    # A dedicated pin file prevents unrelated/user-added host keys from widening trust.
    if host_lines != [OFFICIAL_HOST_KEY]:
        raise SyncError("github_host_key_not_pinned")
    for filename in ALLOWED_FILES:
        destination = repo / filename
        if destination.is_symlink() or destination.resolve().parent != repo:
            raise SyncError("public_output_path_not_regular")
    return Settings(repo, config, state, key, known_hosts, settings.interval, settings.once, settings.no_push)


def pages_build_pending() -> bool:
    request = urllib.request.Request(RUNS_URL, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "race-dashboard-readonly-sync",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            document = json.load(response)
        runs = document["workflow_runs"]
        if not isinstance(runs, list):
            raise ValueError()
        return any(isinstance(run, dict) and run.get("status") in ACTIVE_RUN_STATES and
                   (str(run.get("name", "")).lower() == "pages build and deployment" or
                    "pages-build-deployment" in str(run.get("path", "")).lower())
                   for run in runs)
    except Exception:
        raise SyncError("pages_status_unavailable") from None


@contextmanager
def repository_lock(repo: Path):
    # Shared by every runner for this checkout, even if a different --state-dir is supplied.
    digest = hashlib.sha256(os.path.normcase(str(repo)).encode()).hexdigest()
    lock_root = Path(tempfile.gettempdir()) / "race-dashboard-sync-locks"
    lock_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = lock_root / (digest + ".lock")
    if repo == lock_path or repo in lock_path.resolve().parents:
        raise SyncError("lock_path_inside_repository")
    stream = lock_path.open("a+b")
    locked = False
    try:
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except (OSError, BlockingIOError):
            raise SyncError("another_sync_is_running") from None
        yield
    finally:
        if locked:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


class EventLog:
    def __init__(self, state_dir: Path):
        self.path = state_dir / "sync.jsonl"

    def __call__(self, code: str):
        entry = json.dumps({"at": datetime.now(timezone.utc).isoformat(), "event": code}, separators=(",", ":"))
        if self.path.exists() and self.path.stat().st_size > 2 * 1024 * 1024:
            os.replace(self.path, self.path.with_suffix(".jsonl.1"))
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(entry + "\n")
        print(entry, flush=True)


def git_environment(settings: Settings) -> dict[str, str]:
    settings.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    ssh_config = settings.state_dir / "ssh_config"
    # Config syntax and shell quoting are handled separately. No shell=True calls are used.
    def config_path(value: Path) -> str:
        return '"' + value.as_posix() + '"'
    content = "\n".join([
        "Host github.com", "  HostName github.com", "  User git", "  BatchMode yes",
        "  IdentitiesOnly yes", "  IdentityAgent none", "  StrictHostKeyChecking yes",
        "  HostKeyAlgorithms ssh-ed25519", "  PasswordAuthentication no", "  KbdInteractiveAuthentication no",
        "  ProxyCommand none", "  ProxyJump none", "  ConnectTimeout 20",
        "  GlobalKnownHostsFile " + config_path(Path(os.devnull)),
        "  UserKnownHostsFile " + config_path(settings.known_hosts),
        "  IdentityFile " + config_path(settings.ssh_key), "",
    ])
    ssh_config.write_text(content, encoding="utf-8", newline="\n")
    try:
        ssh_config.chmod(0o600)
    except OSError:
        pass
    # Avoid inherited GIT_DIR/worktree/author/config overrides. Git does not need OKX secrets.
    environment = {key: value for key, value in os.environ.items()
                   if not key.upper().startswith("GIT_") and not any(word in key.upper()
                   for word in ("OKX", "SECRET", "TOKEN", "PASSPHRASE", "API_KEY"))}
    environment.update({
        "GIT_SSH_COMMAND": shlex.join(["ssh", "-F", ssh_config.as_posix()]),
        "GIT_SSH_VARIANT": "ssh", "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
    })
    return environment


class SyncRunner:
    def __init__(self, settings: Settings, *, execute=subprocess.run, pending=pages_build_pending, emit=None):
        self.settings = settings
        self.execute = execute
        self.pending = pending
        self.environment = git_environment(settings)
        self.emit = emit or EventLog(settings.state_dir)
        self.git_executable = shutil.which("git") or "git"
        hooks = settings.state_dir / "empty-hooks"
        hooks.mkdir(exist_ok=True)
        self.git_prefix = [self.git_executable, "-c", f"core.hooksPath={hooks.as_posix()}",
                           "-c", "commit.gpgsign=false", "-c", "user.name=race-dashboard",
                           "-c", "user.email=race-dashboard@users.noreply.github.com", "-C", str(settings.repo)]

    def command(self, argv, *, timeout=60, environment=None):
        try:
            return self.execute(argv, cwd=self.settings.repo, env=environment, shell=False,
                                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        except subprocess.TimeoutExpired:
            raise SyncError("command_timed_out") from None
        except OSError:
            raise SyncError("command_unavailable") from None

    def git(self, *arguments, accepted=(0,), code="git_command_failed"):
        result = self.command(self.git_prefix + list(arguments), environment=self.environment)
        if result.returncode not in accepted:
            raise SyncError(code)
        return result

    def pending_paths(self):
        result = self.git("log", "--format=", "--name-only", "origin/main..HEAD")
        return {line.strip() for line in result.stdout.splitlines() if line.strip()}

    def check_checkout(self):
        top = self.git("rev-parse", "--show-toplevel").stdout.strip()
        if Path(top).resolve() != self.settings.repo:
            raise SyncError("repository_root_mismatch")
        for arguments in (("remote", "get-url", "--all", "origin"),
                          ("remote", "get-url", "--push", "--all", "origin")):
            if self.git(*arguments).stdout.splitlines() != [ALLOWED_REMOTE]:
                raise SyncError("unexpected_github_remote")
        if self.git("symbolic-ref", "--quiet", "--short", "HEAD").stdout.strip() != "main":
            raise SyncError("expected_main_branch")
        if self.git("status", "--porcelain=v1", "--untracked-files=normal").stdout.strip():
            raise SyncError("local_changes_need_review")
        git_dir = Path(self.git("rev-parse", "--git-dir").stdout.strip())
        if not git_dir.is_absolute():
            git_dir = self.settings.repo / git_dir
        if any((git_dir / marker).exists() for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge", "rebase-apply")):
            raise SyncError("git_operation_in_progress")
        self.git("fetch", "--no-tags", "--recurse-submodules=no", "--quiet", "origin", "main", code="fetch_failed")
        ancestor = self.git("merge-base", "--is-ancestor", "origin/main", "HEAD", accepted=(0, 1))
        if ancestor.returncode != 0:
            raise SyncError("remote_changed_manual_reconcile_required")
        if not self.pending_paths().issubset(ALLOWED_FILES):
            raise SyncError("pending_non_dashboard_commits_need_review")

    def validate_outputs(self):
        try:
            data = json.loads((self.settings.repo / "data.json").read_text(encoding="utf-8-sig"))
            history = json.loads((self.settings.repo / "history.json").read_text(encoding="utf-8-sig"))
            identity = data["snapshot_id"]
            if not isinstance(identity, str) or not identity or identity != history["snapshot_id"]:
                raise ValueError()
            if not isinstance(data["traders"], dict) or not isinstance(data["trades"], list) or not isinstance(history["series"], dict):
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError):
            raise SyncError("invalid_exported_snapshot_pair") from None

    def cycle(self) -> str:
        try:
            self.check_checkout()
            result = self.command([
                sys.executable, str(self.settings.repo / "scripts" / "okx_snapshot.py"),
                "--config", str(self.settings.config), "--output", str(self.settings.repo),
                "--state-dir", str(self.settings.state_dir / "okx"),
            ], timeout=180, environment=os.environ.copy())
            # Exporter exit 0 also includes partial/error account statuses: publish these honestly.
            if result.returncode != 0:
                raise SyncError("export_failed_no_publish")
            self.validate_outputs()
            self.git("add", "--", "data.json", "history.json")
            staged = set(filter(None, self.git("diff", "--cached", "--name-only", "-z").stdout.split("\0")))
            if not staged.issubset(ALLOWED_FILES):
                raise SyncError("unexpected_staged_files_need_review")
            changed = self.git("diff", "--cached", "--quiet", "--", "data.json", "history.json", accepted=(0, 1))
            if changed.returncode == 1:
                # --only also protects against an unrelated file being staged concurrently by a person.
                self.git("commit", "--only", "-m", "Update read-only trading dashboard snapshot", "--",
                         "data.json", "history.json", code="snapshot_commit_failed")
            if self.settings.no_push:
                self.emit("dry_run_local_commit_no_push")
                return "dry_run_local_commit_no_push"
            if not self.pending_paths():
                self.emit("no_unpublished_snapshots")
                return "no_unpublished_snapshots"
            if self.pending():
                self.emit("pages_build_pending_commit_retained")
                return "pages_build_pending_commit_retained"
            # No force, reset, merge or rebase. A concurrent remote change produces a safe rejection.
            self.git("push", "--porcelain", "origin", "HEAD:refs/heads/main", code="push_failed_commit_retained")
            self.emit("snapshot_pushed")
            return "snapshot_pushed"
        except SyncError as error:
            code = str(error)
            self.emit(code)
            return code


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--ssh-key", required=True, type=Path)
    parser.add_argument("--known-hosts", required=True, type=Path)
    parser.add_argument("--interval", type=int, default=300)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--no-push", action="store_true", help="Collect and create a local snapshot commit, without publishing it")
    args = parser.parse_args(argv)
    stop = threading.Event()
    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), lambda *_: stop.set())
    try:
        settings = validate_settings(Settings(**vars(args)))
        with repository_lock(settings.repo):
            runner = SyncRunner(settings)
            runner.emit("sync_started")
            while not stop.is_set():
                started = time.monotonic()
                outcome = runner.cycle()
                if settings.once:
                    return 0 if outcome in {"snapshot_pushed", "dry_run_local_commit_no_push", "no_unpublished_snapshots",
                                            "pages_build_pending_commit_retained"} else 1
                stop.wait(max(1, settings.interval - (time.monotonic() - started)))
            runner.emit("sync_stopped")
        return 0
    except SyncError as error:
        print(json.dumps({"event": str(error)}), flush=True)
        return 2
    except Exception:
        # Intentionally no traceback, argv, raw stderr, environment, or API error body.
        print('{"event":"sync_failed"}', flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
