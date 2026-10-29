#!/usr/bin/env python3
"""Publish an authenticated dashboard snapshot from this repository's Actions run."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess


REPOSITORY = "Fadinggo/race"
GIT_FILES = ("data.json", "history.json", "state-checkpoint.json")
PAGE_FILES = ("index.html", "dashboard.js", "data.json", "history.json", ".nojekyll")
REMOTE_URLS = {"https://github.com/Fadinggo/race", "https://github.com/Fadinggo/race.git"}


class PublishError(Exception):
    """Only fixed, non-sensitive error codes cross the logging boundary."""


def validate_context(repo: Path, site_dir: Path, environment=None):
    env = os.environ if environment is None else environment
    if env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REPOSITORY") != REPOSITORY or env.get("GITHUB_REF") != "refs/heads/main":
        raise PublishError("unexpected_actions_context")
    if not env.get("GITHUB_WORKSPACE") or not env.get("RUNNER_TEMP"):
        raise PublishError("missing_actions_paths")
    repo, site_dir = repo.resolve(), site_dir.resolve()
    if repo != Path(env["GITHUB_WORKSPACE"]).resolve():
        raise PublishError("unexpected_repository_path")
    temporary = Path(env["RUNNER_TEMP"]).resolve()
    if temporary not in site_dir.parents or repo == site_dir or repo in site_dir.parents:
        raise PublishError("site_directory_must_be_in_runner_temp")
    for filename in set(GIT_FILES + PAGE_FILES):
        path = repo / filename
        if not path.is_file() or path.is_symlink() or path.resolve().parent != repo:
            raise PublishError("non_regular_publish_file")
    return repo, site_dir, temporary


def validate_pair(repo: Path):
    try:
        documents = [json.loads((repo / name).read_text(encoding="utf-8-sig")) for name in GIT_FILES]
        identity = documents[0]["snapshot_id"]
        if not isinstance(identity, str) or not identity or any(document["snapshot_id"] != identity for document in documents):
            raise ValueError()
        if documents[0].get("source") != "own-okx-readonly":
            raise ValueError()
        if not isinstance(documents[0]["traders"], dict) or not isinstance(documents[0]["trades"], list):
            raise ValueError()
        if not isinstance(documents[1]["series"], dict):
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        raise PublishError("invalid_three_file_snapshot") from None


def package_site(repo: Path, site_dir: Path):
    if site_dir.exists() and any(site_dir.iterdir()):
        raise PublishError("site_directory_not_empty")
    site_dir.mkdir(parents=True, exist_ok=True)
    # Copy individual allowlisted files. No Git metadata, checkpoint, scripts,
    # environment files, credentials or private temporary state enter Pages.
    for filename in PAGE_FILES:
        source = repo / filename
        if not source.is_file() or source.is_symlink() or source.resolve().parent != repo:
            raise PublishError("non_regular_publish_file")
        shutil.copyfile(source, site_dir / filename)


def publish(repo: Path, site_dir: Path, *, execute=subprocess.run, environment=None):
    repo, site_dir, temporary = validate_context(repo, site_dir, environment)
    validate_pair(repo)
    hooks = temporary / "race-empty-hooks"
    hooks.mkdir(exist_ok=True)
    prefix = [shutil.which("git") or "git", "-c", "core.hooksPath=" + str(hooks),
              "-c", "commit.gpgsign=false", "-c", "user.name=race-dashboard",
              "-c", "user.email=race-dashboard@users.noreply.github.com", "-C", str(repo)]

    def git(*arguments, accepted=(0,), code="git_publish_failed"):
        try:
            result = execute(prefix + list(arguments), cwd=repo, shell=False, capture_output=True,
                             text=True, encoding="utf-8", errors="replace", timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            raise PublishError("git_publish_unavailable_or_timed_out") from None
        if result.returncode not in accepted:
            raise PublishError(code)
        return result

    if Path(git("rev-parse", "--show-toplevel").stdout.strip()).resolve() != repo:
        raise PublishError("unexpected_repository_root")
    if git("symbolic-ref", "--quiet", "--short", "HEAD").stdout.strip() != "main":
        raise PublishError("expected_main_branch")
    for args in (("remote", "get-url", "--all", "origin"), ("remote", "get-url", "--push", "--all", "origin")):
        urls = git(*args).stdout.splitlines()
        if len(urls) != 1 or urls[0] not in REMOTE_URLS:
            raise PublishError("unexpected_github_remote")
    status = git("status", "--porcelain=v1", "--untracked-files=all").stdout
    if any(line[3:] not in GIT_FILES for line in status.splitlines() if line):
        raise PublishError("non_snapshot_checkout_changes")
    git("fetch", "--no-tags", "--recurse-submodules=no", "--depth=2", "origin", "main", code="snapshot_fetch_failed")
    local_head = git("rev-parse", "HEAD").stdout.strip()
    remote_head = git("rev-parse", "origin/main").stdout.strip()
    if not local_head or local_head != remote_head:
        raise PublishError("remote_changed_retry_next_schedule")
    package_site(repo, site_dir)
    git("add", "--", *GIT_FILES)
    staged = set(filter(None, git("diff", "--cached", "--name-only", "-z").stdout.split("\0")))
    if not staged.issubset(GIT_FILES):
        raise PublishError("unexpected_staged_file")
    changed = git("diff", "--cached", "--quiet", "--", *GIT_FILES, accepted=(0, 1))
    if changed.returncode == 1:
        git("commit", "--only", "-m", "Update authenticated read-only dashboard snapshot", "--", *GIT_FILES,
            code="snapshot_commit_failed")
        # This token-authenticated push deliberately does not trigger another
        # workflow. The current workflow deploys its own Pages artifact directly.
        git("push", "--porcelain", "origin", "HEAD:refs/heads/main", code="snapshot_push_failed_retry_next_schedule")
        return "snapshot_pushed_pages_ready"
    return "snapshot_unchanged_pages_ready"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--site-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = publish(args.repo, args.site_dir)
        print(json.dumps({"status": result}))
        return 0
    except PublishError as error:
        print(json.dumps({"status": "error", "error_code": str(error)}))
        return 2
    except Exception:
        print('{"status":"error","error_code":"github_publish_failed"}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
