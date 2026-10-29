"""Validate the dedicated cloud heartbeat before any account secrets are used."""

from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import re
import sys


REPOSITORY = "Fadinggo/race"
OWNER_LOGIN = "Fadinggo"
OWNER_ID = 257707061
ISSUE_NUMBER = 3
ISSUE_TITLE = "Dashboard cloud refresh heartbeat"
MARKER = "RACE_DASHBOARD_TICK_V1"
INITIAL_BODY = (
    "RACE_DASHBOARD_TICK_V1\npending\n\n"
    "Dedicated cloud refresh control issue. Only the repository owner may update this heartbeat. "
    "It never contains credentials, trading instructions, or maintenance commands. "
    "Deployment verification is in progress."
)
MAX_EVENT_BYTES = 1_000_000
MAX_TICK_AGE_SECONDS = 600
MAX_CLOCK_SKEW_SECONDS = 60
TICK_BODY = re.compile(
    r"RACE_DASHBOARD_TICK_V1\n(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\n?\Z",
    flags=re.ASCII,
)


class TriggerError(Exception):
    """A fixed diagnostic code; never include payload or credential values."""


def _object(value):
    if not isinstance(value, dict):
        raise TriggerError("dashboard_trigger_shape_invalid")
    return value


def _owner(value) -> bool:
    return (isinstance(value, dict) and value.get("login") == OWNER_LOGIN
            and type(value.get("id")) is int and value["id"] == OWNER_ID
            and value.get("type") == "User")


def parse_tick(body: str) -> dt.datetime:
    if not isinstance(body, str) or len(body) > 100:
        raise TriggerError("dashboard_tick_body_invalid")
    match = TICK_BODY.fullmatch(body)
    if match is None:
        raise TriggerError("dashboard_tick_body_invalid")
    try:
        return dt.datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        raise TriggerError("dashboard_tick_timestamp_invalid") from None


def validate_event(event: dict, env, *, now: dt.datetime | None = None) -> dt.datetime:
    """Accept only a fresh, advancing body edit on the fixed owner-owned Issue.

    No event text is executed or used as a path, command, repository, or ref.
    Reruns are refused for this trigger; ordinary manual workflow runs should
    bypass this guard with an event-name condition in the trusted workflow.
    """
    event = _object(event)
    if (env.get("GITHUB_REPOSITORY") != REPOSITORY
            or env.get("GITHUB_REF") != "refs/heads/main"
            or env.get("GITHUB_EVENT_NAME") != "issues"
            or env.get("GITHUB_ACTOR") != OWNER_LOGIN
            or env.get("GITHUB_ACTOR_ID") != str(OWNER_ID)
            or env.get("GITHUB_TRIGGERING_ACTOR", OWNER_LOGIN) != OWNER_LOGIN):
        raise TriggerError("dashboard_trigger_not_authorized")
    if env.get("GITHUB_RUN_ATTEMPT") != "1":
        raise TriggerError("dashboard_tick_rerun_rejected")
    repository = _object(event.get("repository"))
    if repository.get("full_name") != REPOSITORY or not _owner(repository.get("owner")):
        raise TriggerError("dashboard_trigger_repository_invalid")
    if event.get("action") != "edited" or not _owner(event.get("sender")):
        raise TriggerError("dashboard_trigger_not_authorized")
    issue = _object(event.get("issue"))
    if (type(issue.get("number")) is not int or issue["number"] != ISSUE_NUMBER
            or issue.get("title") != ISSUE_TITLE or issue.get("state") != "open"
            or "pull_request" in issue or not _owner(issue.get("user"))):
        raise TriggerError("dashboard_trigger_issue_invalid")
    changes = _object(event.get("changes"))
    body_change = _object(changes.get("body"))
    if "from" not in body_change:
        raise TriggerError("dashboard_tick_previous_body_missing")
    tick = parse_tick(issue.get("body"))
    previous = body_change["from"]
    # Only the exact original control-Issue text can bootstrap the first tick.
    # Arbitrary malformed prior bodies do not bypass monotonicity validation.
    if previous != INITIAL_BODY:
        previous_tick = parse_tick(previous)
        if tick <= previous_tick:
            raise TriggerError("dashboard_tick_not_advancing")
    now = now or dt.datetime.now(dt.timezone.utc)
    if not isinstance(now, dt.datetime) or now.tzinfo is None:
        raise TriggerError("dashboard_trigger_clock_invalid")
    age = (now - tick).total_seconds()
    if age > MAX_TICK_AGE_SECONDS:
        raise TriggerError("dashboard_tick_expired")
    if age < -MAX_CLOCK_SKEW_SECONDS:
        raise TriggerError("dashboard_tick_in_future")
    return tick


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise TriggerError("dashboard_trigger_duplicate_json_key")
        result[key] = value
    return result


def main() -> int:
    try:
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        if not event_path:
            raise TriggerError("dashboard_trigger_event_path_missing")
        with Path(event_path).open("rb") as source:
            raw = source.read(MAX_EVENT_BYTES + 1)
        if len(raw) > MAX_EVENT_BYTES:
            raise TriggerError("dashboard_trigger_event_too_large")
        event = json.loads(raw, object_pairs_hook=_unique_object)
        validate_event(event, os.environ)
    except TriggerError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception:
        print("dashboard_trigger_invalid", file=sys.stderr)
        return 1
    print("dashboard_issue_tick_authorized")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
