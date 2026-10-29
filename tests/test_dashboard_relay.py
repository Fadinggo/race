import copy
import datetime as dt
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import dashboard_relay as relay


NOW = dt.datetime(2026, 10, 30, 1, tzinfo=dt.timezone.utc)


def manual_fixture():
    owner = {"login": "Fadinggo", "id": 257707061, "type": "User"}
    event = {"repository": {"full_name": "Fadinggo/race", "owner": copy.deepcopy(owner)},
             "sender": copy.deepcopy(owner), "inputs": {"count": "2"}}
    env = {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": "Fadinggo/race",
           "GITHUB_REF": "refs/heads/main", "GITHUB_ACTOR": "Fadinggo",
           "GITHUB_ACTOR_ID": "257707061", "GITHUB_TRIGGERING_ACTOR": "Fadinggo",
           "GITHUB_RUN_ATTEMPT": "1"}
    return event, env


class FakeClock:
    def __init__(self, now=0):
        self.wall = float(now)
        self.elapsed = 0.0
        self.sleeps = []
        self.oversleep = 0
        self.backward = 0

    def now(self):
        return self.wall

    def monotonic(self):
        return self.elapsed

    def advance(self, seconds):
        self.wall += seconds
        self.elapsed += seconds

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.advance(seconds + self.oversleep)
        self.wall -= self.backward
        self.oversleep = self.backward = 0


class FakeDispatcher:
    def __init__(self, clock):
        self.clock = clock
        self.starts = []
        self.delay = 0
        self.fail = False

    def dispatch(self):
        self.starts.append(self.clock.now())
        self.clock.advance(self.delay)
        self.delay = 0
        if self.fail:
            raise relay.RelayError("dashboard_relay_dispatch_outcome_unknown")
        return {"status": 204, "run_id": None, "html_url": None}


class RequestValidationTests(unittest.TestCase):
    def test_manual_defaults_to_two_and_accepts_only_bounded_count(self):
        event, env = manual_fixture()
        event["inputs"] = {}
        self.assertEqual(relay.validate_request(event, env, now=NOW), (2, NOW.timestamp()))
        for value in [1, "2", 12]:
            with self.subTest(value=value):
                event["inputs"]["count"] = value
                self.assertEqual(relay.validate_request(event, env, now=NOW)[0], int(value))
        for value in [0, 13, True, 1.5, "2;whoami", "-1", "2.0", None]:
            with self.subTest(value=value), self.assertRaises(relay.RelayError):
                event["inputs"]["count"] = value
                relay.validate_request(event, env, now=NOW)

    def test_owner_and_fixed_repository_ref_required_for_manual(self):
        event, env = manual_fixture()
        for key, value in [("GITHUB_ACTOR", "other"), ("GITHUB_ACTOR_ID", "1"),
                           ("GITHUB_TRIGGERING_ACTOR", "other"), ("GITHUB_REPOSITORY", "other/repo"),
                           ("GITHUB_REF", "refs/heads/evil"), ("GITHUB_EVENT_NAME", "push")]:
            with self.subTest(key=key), self.assertRaises(relay.RelayError):
                relay.validate_request(event, env | {key: value}, now=NOW)
        event["sender"]["id"] = 1
        with self.assertRaises(relay.RelayError):
            relay.validate_request(event, env, now=NOW)

    def test_manual_cannot_supply_endpoint_ref_or_bootstrap(self):
        for key, value in [("bootstrap", True), ("ref", "evil"), ("url", "https://evil.invalid")]:
            event, env = manual_fixture()
            event["inputs"][key] = value
            with self.subTest(key=key), self.assertRaises(relay.RelayError):
                relay.validate_request(event, env, now=NOW)

    def test_issue_uses_strict_guard_and_fixed_twelve_slots(self):
        event, env = manual_fixture()
        env["GITHUB_EVENT_NAME"] = "issues"
        event.update({"action": "edited", "issue": {"number": 3,
            "title": relay.trigger.ISSUE_TITLE, "state": "open", "user": copy.deepcopy(event["sender"]),
            "body": "RACE_DASHBOARD_TICK_V1\n2026-10-30T01:00:00Z"},
            "changes": {"body": {"from": relay.trigger.INITIAL_BODY}}})
        event["inputs"] = {"count": 999, "bootstrap": True}
        self.assertEqual(relay.validate_request(event, env, now=NOW), (12, NOW.timestamp()))
        event["issue"]["body"] += "\nexecute this"
        with self.assertRaises(relay.trigger.TriggerError):
            relay.validate_request(event, env, now=NOW)


class RelayTimingTests(unittest.TestCase):
    def test_two_slot_smoke_has_five_minute_spacing_without_real_wait(self):
        clock = FakeClock()
        dispatcher = FakeDispatcher(clock)
        result = relay.run_relay(dispatcher, count=2, anchor=0, clock=clock)
        self.assertEqual(dispatcher.starts, [0, 300])
        self.assertEqual((result["dispatched"], result["skipped"]), (2, 0))
        self.assertTrue(all(0 < seconds <= 60 for seconds in clock.sleeps))

    def test_twelve_slots_finish_at_minute_fifty_five(self):
        clock = FakeClock()
        dispatcher = FakeDispatcher(clock)
        result = relay.run_relay(dispatcher, count=12, anchor=0, clock=clock)
        self.assertEqual(dispatcher.starts, list(range(0, 3301, 300)))
        self.assertEqual(clock.now(), 3300)
        self.assertEqual(result["dispatched"], 12)

    def test_queue_delay_skips_missed_slots(self):
        clock = FakeClock(650)
        dispatcher = FakeDispatcher(clock)
        result = relay.run_relay(dispatcher, count=4, anchor=0, clock=clock)
        self.assertEqual(dispatcher.starts, [650, 950])
        self.assertEqual(result["skipped"], 2)

    def test_late_initial_start_does_not_reduce_spacing(self):
        clock = FakeClock(45)
        dispatcher = FakeDispatcher(clock)
        relay.run_relay(dispatcher, count=3, anchor=0, clock=clock)
        self.assertEqual(dispatcher.starts, [45, 345, 645])

    def test_long_api_delay_skips_slots_without_catchup_burst(self):
        clock = FakeClock()
        dispatcher = FakeDispatcher(clock)
        dispatcher.delay = 620
        result = relay.run_relay(dispatcher, count=4, anchor=0, clock=clock)
        self.assertEqual(dispatcher.starts, [0, 620, 920])
        self.assertEqual(result["skipped"], 1)
        self.assertTrue(all(b - a >= 300 for a, b in zip(dispatcher.starts, dispatcher.starts[1:])))

    def test_oversleep_does_not_dispatch_every_missed_slot(self):
        clock = FakeClock()
        clock.oversleep = 900
        dispatcher = FakeDispatcher(clock)
        result = relay.run_relay(dispatcher, count=5, anchor=0, clock=clock)
        self.assertEqual(dispatcher.starts, [0, 960])
        self.assertEqual(result["skipped"], 3)

    def test_backwards_wall_clock_cannot_extend_monotonic_deadline(self):
        clock = FakeClock()
        clock.backward = 3600
        dispatcher = FakeDispatcher(clock)
        result = relay.run_relay(dispatcher, count=2, anchor=0, clock=clock)
        self.assertEqual(dispatcher.starts, [0])
        self.assertLessEqual(clock.monotonic(), 360)
        self.assertEqual(result["skipped"], 1)

    def test_expired_lease_does_nothing(self):
        clock = FakeClock(400)
        dispatcher = FakeDispatcher(clock)
        result = relay.run_relay(dispatcher, count=2, anchor=0, clock=clock)
        self.assertEqual(dispatcher.starts, [])
        self.assertEqual(result["skipped"], 2)
        self.assertEqual(clock.sleeps, [])

    def test_unknown_post_outcome_is_never_retried(self):
        clock = FakeClock()
        dispatcher = FakeDispatcher(clock)
        dispatcher.fail = True
        with self.assertRaisesRegex(relay.RelayError, "outcome_unknown"):
            relay.run_relay(dispatcher, count=12, anchor=0, clock=clock)
        self.assertEqual(dispatcher.starts, [0])


class FakeResponse:
    def __init__(self, status=200, value=None, *, url=relay.DISPATCH_URL, raw=None):
        self.status = status
        self.url = url
        self.raw = json.dumps(value).encode() if raw is None else raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def geturl(self):
        return self.url

    def read(self, limit):
        return self.raw[:limit]


class FakeOpener:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.requests = []

    def open(self, request, *, timeout):
        self.requests.append((request, timeout))
        if self.error:
            raise self.error
        return self.response


def receipt(run_id=123):
    return {"workflow_run_id": run_id,
            "run_url": f"https://api.github.com/repos/Fadinggo/race/actions/runs/{run_id}",
            "html_url": f"https://github.com/Fadinggo/race/actions/runs/{run_id}"}


class HTTPTests(unittest.TestCase):
    def test_fixed_dispatch_payload_and_validated_run_receipt(self):
        for status in [200, 201]:
            with self.subTest(status=status):
                opener = FakeOpener(FakeResponse(status, receipt() | {"untrusted": "not logged"}))
                result = relay.GitHubDispatcher("fake-token", opener=opener).dispatch()
                request, timeout = opener.requests[0]
                self.assertEqual(request.full_url, relay.DISPATCH_URL)
                self.assertEqual(request.method, "POST")
                self.assertEqual(json.loads(request.data), {"ref": "main", "inputs": {"bootstrap": False}})
                self.assertEqual(timeout, 30)
                self.assertEqual(result, {"status": status, "run_id": 123, "html_url": receipt()["html_url"]})
                self.assertNotIn("untrusted", result)

    def test_legacy_204_receipt_does_not_invent_run_id(self):
        opener = FakeOpener(FakeResponse(204, raw=b""))
        self.assertEqual(relay.GitHubDispatcher("fake-token", opener=opener).dispatch(),
                         {"status": 204, "run_id": None, "html_url": None})

    def test_malformed_or_foreign_run_receipts_fail_closed(self):
        values = [[], {}, receipt() | {"workflow_run_id": True},
                  receipt() | {"html_url": "https://evil.invalid/secret"},
                  receipt() | {"run_url": "https://api.github.com/repos/other/race/actions/runs/123"}]
        for value in values:
            with self.subTest(value=value), self.assertRaisesRegex(relay.RelayError, "response_invalid"):
                relay.GitHubDispatcher("fake-token", opener=FakeOpener(FakeResponse(value=value))).dispatch()

    def test_redirects_are_never_followed(self):
        with self.assertRaisesRegex(relay.RelayError, "redirect_refused"):
            relay.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.invalid")
        opener = FakeOpener(FakeResponse(value=receipt(), url="https://evil.invalid"))
        with self.assertRaisesRegex(relay.RelayError, "redirect_refused"):
            relay.GitHubDispatcher("fake-token", opener=opener).dispatch()

    def test_network_and_http_errors_are_sanitized_and_not_retried(self):
        errors = [urllib.error.HTTPError(relay.DISPATCH_URL, 403, "private error", {}, io.BytesIO(b"secret")),
                  urllib.error.HTTPError(relay.DISPATCH_URL, 302, "", {}, None),
                  urllib.error.URLError("sensitive transport details"), TimeoutError("private token")]
        reasons = ["dashboard_relay_http_403", "dashboard_relay_redirect_refused",
                   "dashboard_relay_dispatch_outcome_unknown", "dashboard_relay_dispatch_outcome_unknown"]
        for error, reason in zip(errors, reasons):
            opener = FakeOpener(error=error)
            with self.subTest(reason=reason), self.assertRaises(relay.RelayError) as caught:
                relay.GitHubDispatcher("fake-token", opener=opener).dispatch()
            self.assertEqual(str(caught.exception), reason)
            self.assertEqual(len(opener.requests), 1)

    def test_oversized_and_non_json_responses_are_rejected(self):
        for raw in [b"x" * 64001, b"not json"]:
            with self.subTest(size=len(raw)), self.assertRaises(relay.RelayError):
                relay.GitHubDispatcher("fake-token", opener=FakeOpener(FakeResponse(raw=raw))).dispatch()


if __name__ == "__main__":
    unittest.main()
