#!/usr/bin/env python3
"""Check a maintenance PR with this file copied from its trusted main base.

This guard never imports code or configuration from the pull request. Git object
contents are inspected without executing repository scripts or following links.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request


REPOSITORY = "Fadinggo/race"
SCHEMA = "RACE_WORK_ORDER_V1"
SHA = re.compile(r"[0-9a-f]{40}\Z")
BRANCH = re.compile(r"codex/maintenance-([1-9][0-9]*)\Z")
ORDER_FIELDS = {"version", "kind", "objective", "allowed_paths", "acceptance"}
ENVELOPE_FIELDS = {"schema", "issue_number", "issue_url", "requested_by", "base_commit", "work_order_sha256", "work_order"}
REGULAR_MODE = "100644"
MAX_ORDER_BYTES = 16000
MAX_RESPONSE_BYTES = 2_000_000
BOT_ID = 41898282  # Verified using https://api.github.com/users/github-actions%5Bbot%5D


class GuardError(Exception):
    """Fixed diagnostic codes, without issue text, credentials, or Git stderr."""


def canonical_digest(order):
    encoded = json.dumps(order, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise GuardError("duplicate_json_key")
        result[key] = value
    return result


def safe_path(path):
    return (isinstance(path, str) and bool(path) and path.isascii()
            and not path.startswith(("/", "."))
            and "\\" not in path and ":" not in path
            and all(part not in ("", ".", "..") for part in path.split("/"))
            and not any(ord(char) < 32 or ord(char) == 127 for char in path))


def maintenance_path(path):
    if not safe_path(path):
        return False
    if path in {"dashboard.js", "index.html", "README.md", "HANDOFF.md"}:
        return True
    if "maintenance" in path.lower():
        return False
    return bool(re.fullmatch(r"tests/(?:test_[a-z0-9_]+\.py|[a-z0-9_-]+\.test\.js)", path))


def validate_order(order, issue_number):
    if not isinstance(order, dict) or set(order) != ORDER_FIELDS:
        raise GuardError("invalid_work_order_fields")
    if type(order["version"]) is not int or order["version"] != 1 or order["kind"] not in ("smoke", "maintenance"):
        raise GuardError("invalid_work_order_version_or_kind")
    if not isinstance(order["objective"], str) or not order["objective"].strip() or len(order["objective"]) > 2000:
        raise GuardError("invalid_objective")
    acceptance = order["acceptance"]
    if (not isinstance(acceptance, list) or not 1 <= len(acceptance) <= 10
            or any(not isinstance(item, str) or not item.strip() or len(item) > 500 for item in acceptance)):
        raise GuardError("invalid_acceptance")
    paths = order["allowed_paths"]
    if (not isinstance(paths, list) or not 1 <= len(paths) <= 10
            or any(not isinstance(path, str) or len(path) > 160 for path in paths) or len(set(paths)) != len(paths)):
        raise GuardError("invalid_allowed_paths")
    if order["kind"] == "smoke":
        if paths != [f".maintenance/results/{issue_number}.md"]:
            raise GuardError("invalid_smoke_result_path")
    elif any(not maintenance_path(path) for path in paths):
        raise GuardError("protected_or_invalid_allowed_path")
    return order


def parse_envelope(blob, issue_number):
    if len(blob) > MAX_ORDER_BYTES:
        raise GuardError("work_order_too_large")
    try:
        envelope = json.loads(blob.decode("utf-8"), object_pairs_hook=no_duplicate_keys)
    except (UnicodeError, ValueError):
        raise GuardError("invalid_work_order_json") from None
    if not isinstance(envelope, dict) or set(envelope) != ENVELOPE_FIELDS:
        raise GuardError("invalid_envelope_fields")
    if (envelope["schema"] != SCHEMA or type(envelope["issue_number"]) is not int
            or envelope["issue_number"] != issue_number
            or envelope["issue_url"] != f"https://github.com/{REPOSITORY}/issues/{issue_number}"
            or envelope["requested_by"] != "Fadinggo"):
        raise GuardError("work_order_identity_mismatch")
    if not isinstance(envelope["base_commit"], str) or not SHA.fullmatch(envelope["base_commit"]):
        raise GuardError("invalid_order_base_commit")
    order = validate_order(envelope["work_order"], issue_number)
    if envelope["work_order_sha256"] != canonical_digest(order):
        raise GuardError("work_order_digest_mismatch")
    return envelope


def ready_comment(doc, prepare_commit):
    """The dispatcher protocol, duplicated to avoid importing untrusted PR code."""
    number = doc["issue_number"]
    branch = f"codex/maintenance-{number}"
    return (
        f"<!-- race-maintenance-dispatch:v1 issue={number} -->\n"
        "Maintenance work-order branch is ready.\n\n"
        f"- Branch: `{branch}`\n"
        f"- Base commit: `{doc['base_commit']}`\n"
        f"- Initial commit: `{prepare_commit}`\n"
        f"- Work-order SHA-256: `{doc['work_order_sha256']}`\n"
        f"- Work order: `.maintenance/work-orders/{number}.json`\n"
        f"- Compare: https://github.com/{REPOSITORY}/compare/main...{branch}\n\n"
        "The dashboard supervisor can open a pull request from this branch to main, "
        "then delegate the bounded work order to Codex. This dispatcher does not open "
        "or merge pull requests."
    )


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise GuardError("github_redirect_refused")


def public_comments(issue_number, page, *, opener=None):
    if type(issue_number) is not int or not 1 <= issue_number <= 2_147_483_647 or type(page) is not int or not 1 <= page <= 10:
        raise GuardError("invalid_comment_request")
    # This public endpoint needs no token. No credentials or issue text are
    # transmitted, and redirects (including to another host) are refused.
    url = f"https://api.github.com/repos/{REPOSITORY}/issues/{issue_number}/comments?per_page=100&page={page}"
    request = urllib.request.Request(url, method="GET", headers={
        "Accept": "application/vnd.github+json", "User-Agent": "race-maintenance-guard",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with (opener or urllib.request.build_opener(NoRedirect())).open(request, timeout=30) as response:
            if response.geturl() != url:
                raise GuardError("github_redirect_refused")
            if response.status != 200:
                raise GuardError("github_comment_request_failed")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise GuardError("github_comment_request_failed") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise GuardError("github_comment_response_too_large")
    try:
        comments = json.loads(raw)
    except (ValueError, UnicodeError):
        raise GuardError("github_comment_response_invalid") from None
    if not isinstance(comments, list) or len(comments) > 100:
        raise GuardError("github_comment_response_invalid")
    return comments


def load_anchor(envelope, *, fetch=public_comments):
    number = envelope["issue_number"]
    marker = f"<!-- race-maintenance-dispatch:v1 issue={number} -->"
    anchors = set()
    for page in range(1, 11):
        comments = fetch(number, page)
        if not isinstance(comments, list) or len(comments) > 100:
            raise GuardError("github_comment_response_invalid")
        for comment in comments:
            if not isinstance(comment, dict):
                raise GuardError("github_comment_response_invalid")
            user, body = comment.get("user"), comment.get("body")
            if (not isinstance(user, dict) or user.get("id") != BOT_ID
                    or user.get("login") != "github-actions[bot]" or user.get("type") != "Bot"
                    or not isinstance(body, str) or marker not in body):
                continue
            matches = re.findall(r"^- Initial commit: `([0-9a-f]{40})`$", body, flags=re.MULTILINE)
            if len(matches) != 1 or body != ready_comment(envelope, matches[0]):
                raise GuardError("trusted_ready_comment_mismatch")
            anchors.add(matches[0])
        if len(comments) < 100:
            if len(anchors) != 1:
                raise GuardError("missing_or_conflicting_prepare_anchor")
            return anchors.pop()
    raise GuardError("github_comment_page_limit_exceeded")


class Git:
    def __init__(self, repo):
        self.repo = Path(repo).resolve()

    def run(self, *arguments, accepted=(0,)):
        try:
            result = subprocess.run(["git", "--no-replace-objects", "-C", str(self.repo), *arguments],
                                    shell=False, capture_output=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            raise GuardError("git_unavailable_or_timed_out") from None
        if result.returncode not in accepted:
            raise GuardError("git_validation_failed")
        return result

    def text(self, *arguments):
        try:
            return self.run(*arguments).stdout.decode("utf-8").strip()
        except UnicodeError:
            raise GuardError("invalid_git_output") from None

    def changes(self, before, after):
        raw = self.run("diff", "--raw", "--no-abbrev", "--no-ext-diff", "--no-textconv", "--no-renames",
                       "-z", before, after, "--").stdout.split(b"\0")
        if raw[-1] != b"" or len(raw) % 2 != 1:
            raise GuardError("invalid_git_diff")
        changes = []
        try:
            for index in range(0, len(raw) - 1, 2):
                old_mode, new_mode, old_blob, new_blob, status = raw[index].decode("ascii").split()
                changes.append((raw[index + 1].decode("utf-8"), status, old_mode.lstrip(":"), new_mode))
        except (UnicodeError, ValueError):
            raise GuardError("invalid_git_diff") from None
        return changes


def regular_change(change):
    _path, status, old_mode, new_mode = change
    if status not in ("A", "M") or old_mode not in ("000000", REGULAR_MODE) or new_mode != REGULAR_MODE:
        raise GuardError("non_regular_or_deleted_file")


def verify(repo, *, base_sha, head_sha, head_ref, repository, head_repository, base_ref="main", checkout_sha=None, anchor_loader=load_anchor):
    match = BRANCH.fullmatch(head_ref)
    if repository != REPOSITORY or head_repository != REPOSITORY or base_ref != "main" or not match:
        raise GuardError("unexpected_pull_request_context")
    if not SHA.fullmatch(base_sha) or not SHA.fullmatch(head_sha):
        raise GuardError("invalid_commit_sha")
    # The target-event job keeps the worktree on trusted main and only fetches
    # head objects. Never accept an arbitrary third revision as that checkout.
    if checkout_sha is not None and checkout_sha != base_sha:
        raise GuardError("invalid_trusted_checkout_sha")
    issue_number = int(match.group(1))
    if issue_number > 2_147_483_647:
        raise GuardError("invalid_issue_number")
    order_path = f".maintenance/work-orders/{issue_number}.json"
    git = Git(repo)
    if git.text("rev-parse", "HEAD") != (checkout_sha or head_sha):
        raise GuardError("checkout_head_mismatch")
    if git.run("status", "--porcelain=v1", "--untracked-files=all", "-z").stdout:
        raise GuardError("checkout_not_clean")
    if int(git.text("cat-file", "-s", f"{head_sha}:{order_path}")) > MAX_ORDER_BYTES:
        raise GuardError("work_order_too_large")
    head_blob = git.run("show", f"{head_sha}:{order_path}").stdout
    envelope = parse_envelope(head_blob, issue_number)
    prepare_sha = anchor_loader(envelope)
    if not isinstance(prepare_sha, str) or not SHA.fullmatch(prepare_sha):
        raise GuardError("invalid_prepare_anchor")
    origin = envelope["base_commit"]
    if git.run("merge-base", "--is-ancestor", origin, base_sha, accepted=(0, 1)).returncode:
        raise GuardError("order_base_not_in_trusted_main")
    if git.text("merge-base", base_sha, head_sha) != origin:
        raise GuardError("unexpected_merge_base")
    commits = git.text("rev-list", "--reverse", "--topo-order", f"{origin}..{head_sha}").splitlines()
    if not commits or len(commits) > 200:
        raise GuardError("invalid_maintenance_history")
    initial = commits[0]
    if prepare_sha != initial:
        raise GuardError("prepare_commit_anchor_mismatch")
    if git.text("show", "-s", "--format=%s", initial) != f"Prepare maintenance work order #{issue_number}":
        raise GuardError("invalid_prepare_commit")
    initial_blob = git.run("show", f"{initial}:{order_path}").stdout
    if head_blob != initial_blob:
        raise GuardError("work_order_was_modified")
    allowed = set(envelope["work_order"]["allowed_paths"])
    previous = origin
    changed = set()
    for index, commit in enumerate(commits):
        parents = git.text("show", "-s", "--format=%P", commit).split()
        if parents != [previous]:
            raise GuardError("maintenance_history_must_be_linear")
        changes = git.changes(previous, commit)
        if index == 0:
            if len(changes) != 1 or changes[0][:2] != (order_path, "A"):
                raise GuardError("prepare_commit_must_only_add_work_order")
        else:
            for change in changes:
                if change[0] == order_path:
                    raise GuardError("work_order_was_modified")
                if change[0] not in allowed:
                    raise GuardError("changed_path_outside_work_order")
                changed.add(change[0])
        for change in changes:
            regular_change(change)
        previous = commit
    # Confirm the resulting tree as well as every intermediate commit. Renames
    # are deliberately shown as delete/add so they cannot hide an old path.
    for change in git.changes(origin, head_sha):
        if change[0] != order_path and change[0] not in allowed:
            raise GuardError("changed_path_outside_work_order")
        regular_change(change)
    return {"issue_number": issue_number, "kind": envelope["work_order"]["kind"],
            "base_sha": base_sha, "head_sha": head_sha,
            "prepare_commit": initial, "work_order_sha256": envelope["work_order_sha256"],
            "changed_paths": sorted(changed)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    for argument in ("base-sha", "head-sha", "head-ref", "repository", "head-repository", "base-ref"):
        parser.add_argument("--" + argument, required=True)
    parser.add_argument("--checkout-sha", help="Trusted base checkout for object-only inspection; must equal --base-sha")
    options = vars(parser.parse_args())
    try:
        result = verify(**options)
    except GuardError as exc:
        print(f"Maintenance guard rejected this PR: {exc}", file=sys.stderr)
        return 1
    except Exception:
        print("Maintenance guard rejected this PR: unexpected_validation_failure", file=sys.stderr)
        return 1
    print(json.dumps({"maintenance_guard": "passed", **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
