"""Prepare an owner-authorized work-order branch, without running its contents."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPOSITORY = "Fadinggo/race"
OWNER = "Fadinggo"
GITHUB_ACTIONS_BOT_ID = 41898282
DEFAULT_BRANCH = "main"
LABEL = "codex-maintenance"
SCHEMA = "RACE_WORK_ORDER_V1"
API_ROOT = "https://api.github.com/repos/Fadinggo/race"
MAX_RESPONSE_BYTES = 2_000_000
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
ORDER_FIELDS = {"version", "kind", "objective", "allowed_paths", "acceptance"}
ENVELOPE_FIELDS = {
    "schema", "issue_number", "issue_url", "requested_by", "base_commit",
    "work_order_sha256", "work_order",
}
SAFE_FILES = {"dashboard.js", "index.html", "README.md", "HANDOFF.md"}
SECRET_PATTERN = re.compile(
    r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]+|"
    r"gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|"
    r"(?i:(?:api[_ -]?key|secret[_ -]?key|passphrase|authorization|"
    r"order[_ -]?id|trade[_ -]?id|account[_ -]?id|uid)\s*[:=]\s*\S+)"
)


class DispatchError(Exception):
    """A fixed, non-sensitive reason safe to print to the workflow log."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DispatchError("github_redirect_refused")


class GitHubAPI:
    def __init__(self, token: str, opener=None):
        if not token or any(char in token for char in "\r\n"):
            raise DispatchError("github_token_missing_or_invalid")
        self._token = token
        self._opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, method: str, path: str, payload=None, *, allow_404=False):
        if (method not in {"GET", "POST"} or (path and not path.startswith("/"))
                or "\\" in path or "#" in path or "//" in path):
            raise DispatchError("github_request_invalid")
        url = API_ROOT + path
        parsed = urllib.parse.urlsplit(url)
        if any(part in {".", ".."} for part in urllib.parse.unquote(parsed.path).split("/")):
            raise DispatchError("github_request_invalid")
        if (parsed.scheme != "https" or parsed.netloc != "api.github.com"
                or not (parsed.path == "/repos/Fadinggo/race"
                        or parsed.path.startswith("/repos/Fadinggo/race/"))):
            raise DispatchError("github_request_invalid")
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + self._token,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "race-maintenance-dispatch",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        try:
            with self._opener.open(request, timeout=30) as response:
                if response.geturl() != url:
                    raise DispatchError("github_redirect_refused")
                if not 200 <= response.status < 300:
                    raise DispatchError("github_response_status_invalid")
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            if exc.code == 404 and allow_404:
                return None
            if 300 <= exc.code < 400:
                raise DispatchError("github_redirect_refused") from None
            raise DispatchError("github_http_" + str(exc.code)) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise DispatchError("github_connection_failed") from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise DispatchError("github_response_too_large")
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise DispatchError("github_response_invalid_json") from None


def canonical_digest(order: dict) -> str:
    encoded = json.dumps(order, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _text(value, limit: int, reason: str) -> str:
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any(ord(char) < 32 and char not in "\n\t" for char in value)):
        raise DispatchError(reason)
    if SECRET_PATTERN.search(value):
        raise DispatchError("work_order_sensitive_value_rejected")
    return value


def validate_work_order(order, issue_number: int) -> dict:
    if not isinstance(order, dict) or set(order) != ORDER_FIELDS:
        raise DispatchError("work_order_fields_invalid")
    if type(order["version"]) is not int or order["version"] != 1:
        raise DispatchError("work_order_version_invalid")
    if order["kind"] not in ("smoke", "maintenance"):
        raise DispatchError("work_order_kind_invalid")
    objective = _text(order["objective"], 2000, "work_order_objective_invalid")
    acceptance = order["acceptance"]
    if not isinstance(acceptance, list) or not 1 <= len(acceptance) <= 10:
        raise DispatchError("work_order_acceptance_invalid")
    acceptance = [_text(item, 500, "work_order_acceptance_invalid") for item in acceptance]
    paths = order["allowed_paths"]
    if not isinstance(paths, list) or not 1 <= len(paths) <= 10:
        raise DispatchError("work_order_paths_invalid")
    normalized = []
    for value in paths:
        path = _text(value, 160, "work_order_path_invalid")
        if order["kind"] == "smoke":
            if path == ".maintenance/results/{issue_number}.md":
                path = f".maintenance/results/{issue_number}.md"
            if path != f".maintenance/results/{issue_number}.md":
                raise DispatchError("work_order_path_forbidden")
        else:
            safe_test = (
                re.fullmatch(r"tests/test_[a-z0-9_]+\.py", path)
                or re.fullmatch(r"tests/[a-z0-9_-]+\.test\.js", path)
            )
            if path not in SAFE_FILES and not (safe_test and "maintenance" not in path):
                raise DispatchError("work_order_path_forbidden")
        normalized.append(path)
    if len(set(normalized)) != len(normalized):
        raise DispatchError("work_order_paths_duplicate")
    return {"version": 1, "kind": order["kind"], "objective": objective,
            "allowed_paths": normalized, "acceptance": acceptance}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DispatchError("work_order_duplicate_json_key")
        result[key] = value
    return result


def parse_work_order(body, issue_number: int) -> dict:
    if not isinstance(body, str) or len(body) > 12_000:
        raise DispatchError("issue_body_invalid")
    blocks = re.findall(r"^```RACE_WORK_ORDER_V1\r?\n(.*?)^```[ \t]*\r?$",
                        body, flags=re.MULTILINE | re.DOTALL)
    if len(blocks) != 1 or len(blocks[0]) > 8000:
        raise DispatchError("work_order_block_invalid")
    try:
        order = json.loads(blocks[0], object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError):
        raise DispatchError("work_order_json_invalid") from None
    return validate_work_order(order, issue_number)


def _sha(value) -> str:
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise DispatchError("github_sha_invalid")
    return value


def _issue_number(value) -> int:
    if type(value) is int:
        number = value
    elif isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,9}", value):
        number = int(value)
    else:
        raise DispatchError("issue_number_invalid")
    if not 1 <= number <= 2_147_483_647:
        raise DispatchError("issue_number_invalid")
    return number


def validate_context(event: dict, env: dict) -> int:
    if (env.get("GITHUB_REPOSITORY") != REPOSITORY
            or env.get("GITHUB_REF") != "refs/heads/main"
            or env.get("GITHUB_ACTOR") != OWNER
            or env.get("GITHUB_TRIGGERING_ACTOR", OWNER) != OWNER
            or event.get("sender", {}).get("login") != OWNER
            or event.get("repository", {}).get("full_name") != REPOSITORY):
        raise DispatchError("dispatch_not_authorized")
    name = env.get("GITHUB_EVENT_NAME")
    if name == "issues":
        if event.get("action") not in {"opened", "edited", "labeled", "reopened"}:
            raise DispatchError("dispatch_event_invalid")
        return _issue_number(event.get("issue", {}).get("number"))
    if name == "workflow_dispatch":
        return _issue_number(event.get("inputs", {}).get("issue_number"))
    raise DispatchError("dispatch_event_invalid")


def _load_envelope(api, branch: str, number: int, digest: str) -> dict:
    path = f".maintenance/work-orders/{number}.json"
    item = api.request("GET", "/contents/" + path + "?ref="
                       + urllib.parse.quote(branch, safe=""))
    if (not isinstance(item, dict) or item.get("type") != "file"
            or item.get("path") != path or item.get("encoding") != "base64"):
        raise DispatchError("existing_work_order_invalid")
    try:
        raw = base64.b64decode("".join(item["content"].split()), validate=True)
        if len(raw) > 16_000:
            raise DispatchError("existing_work_order_invalid")
        doc = json.loads(raw, object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError, KeyError, TypeError):
        raise DispatchError("existing_work_order_invalid") from None
    if (not isinstance(doc, dict) or set(doc) != ENVELOPE_FIELDS
            or doc.get("schema") != SCHEMA or type(doc.get("issue_number")) is not int
            or doc.get("issue_number") != number or doc.get("requested_by") != OWNER
            or doc.get("issue_url") != f"https://github.com/{REPOSITORY}/issues/{number}"):
        raise DispatchError("existing_work_order_invalid")
    _sha(doc.get("base_commit"))
    saved = validate_work_order(doc.get("work_order"), number)
    if (saved != doc["work_order"] or canonical_digest(saved) != digest
            or doc.get("work_order_sha256") != digest):
        raise DispatchError("existing_work_order_mismatch")
    return doc


def _prepare_commit(api, doc: dict, head: str) -> str:
    base = doc["base_commit"]
    comparison = api.request("GET", f"/compare/{base}...{head}?per_page=100&page=1")
    commits = comparison.get("commits", [])
    if (comparison.get("status") != "ahead" or not commits
            or comparison.get("ahead_by", 101) > 100
            or comparison.get("total_commits") != len(commits)):
        raise DispatchError("work_order_history_invalid")
    first = commits[0]
    prepare = _sha(first.get("sha"))
    if [parent.get("sha") for parent in first.get("parents", [])] != [base]:
        raise DispatchError("work_order_history_invalid")
    if first.get("commit", {}).get("message") != f"Prepare maintenance work order #{doc['issue_number']}":
        raise DispatchError("work_order_history_invalid")
    original = _load_envelope(api, prepare, doc["issue_number"], doc["work_order_sha256"])
    if original != doc:
        raise DispatchError("existing_work_order_mismatch")
    return prepare


def ready_comment(doc: dict, prepare_commit: str) -> str:
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


def _ensure_comment(api, doc: dict, prepare_commit: str):
    number = doc["issue_number"]
    expected = ready_comment(doc, prepare_commit)
    marker = f"<!-- race-maintenance-dispatch:v1 issue={number} -->"
    found = False
    for page in range(1, 11):
        comments = api.request("GET", f"/issues/{number}/comments?per_page=100&page={page}")
        if not isinstance(comments, list):
            raise DispatchError("github_comments_invalid")
        for comment in comments:
            user = comment.get("user", {})
            body = comment.get("body", "")
            if (user.get("login") == "github-actions[bot]" and user.get("type") == "Bot"
                    and user.get("id") == GITHUB_ACTIONS_BOT_ID
                    and isinstance(body, str) and marker in body):
                if body != expected:
                    raise DispatchError("existing_ready_comment_mismatch")
                found = True
        if len(comments) < 100:
            if not found:
                api.request("POST", f"/issues/{number}/comments", {"body": expected})
            return
    raise DispatchError("github_comments_limit_exceeded")


def dispatch(event: dict, env: dict, api) -> dict:
    number = validate_context(event, env)
    repo = api.request("GET", "")
    if (repo.get("full_name") != REPOSITORY or repo.get("default_branch") != DEFAULT_BRANCH
            or repo.get("archived") or repo.get("disabled")):
        raise DispatchError("repository_not_supported")
    issue = api.request("GET", f"/issues/{number}")
    if (issue.get("number") != number or "pull_request" in issue
            or issue.get("state") != "open" or issue.get("user", {}).get("login") != OWNER
            or LABEL not in [label.get("name") for label in issue.get("labels", [])]):
        raise DispatchError("issue_not_authorized")
    order = parse_work_order(issue.get("body"), number)
    digest = canonical_digest(order)
    branch = f"codex/maintenance-{number}"
    branch_ref = "/git/ref/heads/" + branch
    existing = api.request("GET", branch_ref, allow_404=True)
    if existing is not None:
        head = _sha(existing.get("object", {}).get("sha"))
        doc = _load_envelope(api, head, number, digest)
    else:
        base = _sha(api.request("GET", "/git/ref/heads/main").get("object", {}).get("sha"))
        tree = _sha(api.request("GET", "/git/commits/" + base).get("tree", {}).get("sha"))
        order_path = f".maintenance/work-orders/{number}.json"
        old_order = api.request("GET", "/contents/" + order_path + "?ref=" + base,
                                allow_404=True)
        if old_order is not None:
            raise DispatchError("work_order_already_in_main")
        doc = {"schema": SCHEMA, "issue_number": number,
               "issue_url": f"https://github.com/{REPOSITORY}/issues/{number}",
               "requested_by": OWNER, "base_commit": base,
               "work_order_sha256": digest, "work_order": order}
        content = json.dumps(doc, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        if len(content.encode("utf-8")) > 16_000:
            raise DispatchError("work_order_too_large")
        blob = _sha(api.request("POST", "/git/blobs",
                               {"content": content, "encoding": "utf-8"}).get("sha"))
        new_tree = _sha(api.request("POST", "/git/trees", {"base_tree": tree, "tree": [
            {"path": order_path, "mode": "100644", "type": "blob", "sha": blob}
        ]}).get("sha"))
        commit = _sha(api.request("POST", "/git/commits", {
            "message": f"Prepare maintenance work order #{number}",
            "tree": new_tree, "parents": [base],
        }).get("sha"))
        try:
            api.request("POST", "/git/refs", {"ref": "refs/heads/" + branch, "sha": commit})
        except DispatchError as exc:
            if str(exc) != "github_http_422":
                raise
            if api.request("GET", branch_ref, allow_404=True) is None:
                raise DispatchError("branch_creation_conflict") from None
        # Read back the actual saved order, also covering an equivalent concurrent creator.
        head = _sha(api.request("GET", branch_ref).get("object", {}).get("sha"))
        doc = _load_envelope(api, head, number, digest)
    prepare = _prepare_commit(api, doc, head)
    _ensure_comment(api, doc, prepare)
    return {"status": "ready", "issue_number": number, "branch": branch,
            "base_commit": doc["base_commit"], "work_order_sha256": digest}


def main() -> int:
    try:
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        if not event_path:
            raise DispatchError("github_event_path_missing")
        raw = Path(event_path).read_bytes()
        if len(raw) > MAX_RESPONSE_BYTES:
            raise DispatchError("github_event_too_large")
        event = json.loads(raw)
        if not isinstance(event, dict):
            raise DispatchError("github_event_invalid")
        result = dispatch(event, dict(os.environ), GitHubAPI(os.environ.get("GITHUB_TOKEN", "")))
        print(json.dumps(result, sort_keys=True))
        return 0
    except DispatchError as exc:
        print(str(exc), file=sys.stderr)
    except Exception:
        # Never print remote bodies, Issue text, headers, tokens, or exception tracebacks.
        print("maintenance_dispatch_failed", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
