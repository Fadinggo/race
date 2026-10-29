"""Turn one authorized cloud heartbeat into a finite set of dashboard updates."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

import dashboard_trigger as trigger


DISPATCH_URL = "https://api.github.com/repos/Fadinggo/race/actions/workflows/update-dashboard.yml/dispatches"
INTERVAL_SECONDS = 300
MAX_SLOTS = 12
MAX_LATENESS_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 30
MAX_RESPONSE_BYTES = 64_000


class RelayError(Exception):
    """A fixed log-safe error, never a remote response or credential."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RelayError("dashboard_relay_redirect_refused")


class GitHubDispatcher:
    def __init__(self, token: str, *, opener=None):
        if not token or any(char in token for char in "\r\n"):
            raise RelayError("dashboard_relay_token_missing_or_invalid")
        self._token = token
        self._opener = opener or urllib.request.build_opener(NoRedirect())

    def dispatch(self) -> dict:
        # The endpoint, branch, and inputs are code constants, never Issue input.
        request = urllib.request.Request(
            DISPATCH_URL,
            data=json.dumps({"ref": "main", "inputs": {"bootstrap": False}}).encode("utf-8"),
            method="POST",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": "Bearer " + self._token,
                "Content-Type": "application/json",
                "User-Agent": "race-dashboard-relay",
                "X-GitHub-Api-Version": "2026-03-10",
            },
        )
        try:
            with self._opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                if response.geturl() != DISPATCH_URL:
                    raise RelayError("dashboard_relay_redirect_refused")
                status = response.status
                if status not in {200, 201, 204}:
                    raise RelayError("dashboard_relay_response_status_invalid")
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                raise RelayError("dashboard_relay_redirect_refused") from None
            raise RelayError("dashboard_relay_http_" + str(exc.code)) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            # A timed-out POST may have succeeded remotely. Never retry it blindly.
            raise RelayError("dashboard_relay_dispatch_outcome_unknown") from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise RelayError("dashboard_relay_response_too_large")
        if status == 204:
            return {"status": 204, "run_id": None, "html_url": None}
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            raise RelayError("dashboard_relay_response_invalid") from None
        if not isinstance(result, dict):
            raise RelayError("dashboard_relay_response_invalid")
        run_id = result.get("workflow_run_id")
        if type(run_id) is not int or run_id < 1:
            raise RelayError("dashboard_relay_response_invalid")
        expected_html = f"https://github.com/Fadinggo/race/actions/runs/{run_id}"
        expected_api = f"https://api.github.com/repos/Fadinggo/race/actions/runs/{run_id}"
        if result.get("html_url") != expected_html or result.get("run_url") != expected_api:
            raise RelayError("dashboard_relay_response_invalid")
        return {"status": status, "run_id": run_id, "html_url": expected_html}


def _count(value) -> int:
    if type(value) is int:
        count = value
    elif isinstance(value, str) and value.isascii() and value.isdigit():
        count = int(value)
    else:
        raise RelayError("dashboard_relay_count_invalid")
    if not 1 <= count <= MAX_SLOTS:
        raise RelayError("dashboard_relay_count_invalid")
    return count


def validate_request(event: dict, env, *, now=None) -> tuple[int, float]:
    now = now or trigger.dt.datetime.now(trigger.dt.timezone.utc)
    if env.get("GITHUB_EVENT_NAME") == "issues":
        tick = trigger.validate_event(event, env, now=now)
        return MAX_SLOTS, tick.timestamp()
    event = trigger._object(event)
    if (env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_REPOSITORY") != trigger.REPOSITORY
            or env.get("GITHUB_REF") != "refs/heads/main"
            or env.get("GITHUB_ACTOR") != trigger.OWNER_LOGIN
            or env.get("GITHUB_ACTOR_ID") != str(trigger.OWNER_ID)
            or env.get("GITHUB_TRIGGERING_ACTOR", trigger.OWNER_LOGIN) != trigger.OWNER_LOGIN
            or not trigger._owner(event.get("sender"))):
        raise RelayError("dashboard_relay_not_authorized")
    repository = trigger._object(event.get("repository"))
    if (repository.get("full_name") != trigger.REPOSITORY
            or not trigger._owner(repository.get("owner"))):
        raise RelayError("dashboard_relay_not_authorized")
    inputs = event.get("inputs", {})
    if not isinstance(inputs, dict) or set(inputs) - {"count"}:
        raise RelayError("dashboard_relay_inputs_invalid")
    return _count(inputs.get("count", 2)), now.timestamp()


class Clock:
    now = staticmethod(time.time)
    monotonic = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)


def run_relay(dispatcher, *, count: int, anchor: float, clock=None, emit=None) -> dict:
    """Dispatch fixed 300-second slots, skipping stale slots instead of catching up.

    The final scheduled slot is at minute 55 for 12 slots. A maximum 60-second
    start tolerance accommodates runner startup; the monotonic deadline keeps
    a backwards wall clock from extending the relay. No recursive runs or POST
    retries are used. Individual HTTP calls additionally have a 30-second cap.
    """
    count = _count(count)
    clock = clock or Clock()
    emit = emit or (lambda record: None)
    lease_end = anchor + (count - 1) * INTERVAL_SECONDS + MAX_LATENESS_SECONDS
    remaining = max(0, min(lease_end - clock.now(),
                           (count - 1) * INTERVAL_SECONDS + MAX_LATENESS_SECONDS))
    monotonic_end = clock.monotonic() + remaining
    records = []
    skipped = 0
    last_start = None
    for slot in range(count):
        due = anchor + slot * INTERVAL_SECONDS
        target = due if last_start is None else max(due, last_start + INTERVAL_SECONDS)
        if target > due + MAX_LATENESS_SECONDS:
            skipped += 1
            continue
        while clock.now() < target and clock.monotonic() < monotonic_end:
            clock.sleep(min(60, target - clock.now(), monotonic_end - clock.monotonic()))
        started = clock.now()
        if started > due + MAX_LATENESS_SECONDS or clock.monotonic() >= monotonic_end:
            skipped += 1
            continue
        receipt = dispatcher.dispatch()
        last_start = started
        record = {"slot": slot + 1, **receipt}
        records.append(record)
        emit({"event": "dashboard_dispatch_accepted", **record})
    summary = {"event": "dashboard_relay_complete", "slots": count,
               "dispatched": len(records), "skipped": skipped, "runs": records}
    emit(summary)
    return summary


def main() -> int:
    try:
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        if not event_path:
            raise RelayError("dashboard_relay_event_path_missing")
        with Path(event_path).open("rb") as source:
            raw = source.read(trigger.MAX_EVENT_BYTES + 1)
        if len(raw) > trigger.MAX_EVENT_BYTES:
            raise RelayError("dashboard_relay_event_too_large")
        event = json.loads(raw, object_pairs_hook=trigger._unique_object)
        count, anchor = validate_request(event, os.environ)
        dispatcher = GitHubDispatcher(os.environ.get("GITHUB_TOKEN", ""))
        run_relay(dispatcher, count=count, anchor=anchor,
                  emit=lambda record: print(json.dumps(record, sort_keys=True), flush=True))
    except (RelayError, trigger.TriggerError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception:
        print("dashboard_relay_invalid", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
