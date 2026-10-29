"""Offline tests: no real credentials, network, account reads, or Git writes."""
import base64
import contextlib
import copy
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("okx_snapshot", Path(__file__).parents[1] / "scripts" / "okx_snapshot.py")
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)
NOW = 1793310000.0


def configuration(**extra):
    return snapshot.parse_config({"bots": [{"name": "Alpha", "env_prefix": "OKX_A"},
                                          {"name": "Beta", "env": {"api_key": "B_KEY", "secret_key": "B_SECRET", "passphrase": "B_PASS"}}], **extra})


def fill(bill="1", **changes):
    record = {"billId": bill, "instType": "SWAP", "instId": "BTC-USDT-SWAP", "subType": "5",
              "fillTime": str(int((NOW - 60) * 1000)), "fillPx": "50000", "fillSz": "2",
              "fillPnl": "3", "fee": "-0.02", "feeCcy": "USDT", "uid": "DO_NOT_PUBLISH_UID",
              "private_key": "DO_NOT_PUBLISH_SECRET", "clOrdId": "private-order-id"}
    record.update(changes)
    return record


class FakeClient:
    def __init__(self, uid, equity="12.5", *, position_rows=None, pages=None, fail=None):
        self.uid = uid
        self.equity = equity
        self.position_rows = position_rows or []
        self.pages = pages if pages is not None else [[]]
        self.fail = fail
        self.calls = []
        self.page_index = 0

    def get(self, path, params=None):
        self.calls.append((path, params))
        if self.fail and path == self.fail[0]:
            raise self.fail[1]
        if path.endswith("/config"):
            return [{"uid": self.uid, "perm": "read_only", "label": "PRIVATE_LABEL"}]
        if path.endswith("/balance"):
            return [{"totalEq": "99999", "details": [{"ccy": "USDT", "eq": self.equity}]}]
        if path.endswith("/positions"):
            return self.position_rows
        if path.endswith("/fills"):
            result = self.pages[min(self.page_index, len(self.pages) - 1)]
            self.page_index += 1
            return result
        raise AssertionError("Unexpected endpoint")


def run_clients(clients, state=None, now=NOW, config=None):
    config = config or configuration()
    return snapshot.collect(config, state or snapshot.new_state(config),
                            client_factory=lambda bot: clients[bot["name"]], now=now, snapshot_id="paired-id")


class ExportTests(unittest.TestCase):
    def test_independent_uids_and_unknown_totals_never_use_usd_total(self):
        data, history, state = run_clients({"Alpha": FakeClient("11111111"), "Beta": FakeClient("22222222", equity="0")})
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["traders"]["Alpha"]["equity"], 12.5)
        self.assertEqual(data["traders"]["Beta"]["equity"], 0)
        for trader in data["traders"].values():
            for field in ("start", "fees_total", "funding_total", "fills_total"):
                self.assertIsNone(trader[field])
        self.assertEqual(data["snapshot_id"], history["snapshot_id"])
        self.assertEqual(history["series"]["Alpha"], [[int(NOW * 1000), 12.5]])
        self.assertEqual(state["uids"], {"Alpha": "11111111", "Beta": "22222222"})
        self.assertNotIn("11111111", json.dumps(data) + json.dumps(history))

    def test_duplicate_uid_blocks_both_before_reading_balances(self):
        clients = {"Alpha": FakeClient("11111111"), "Beta": FakeClient("11111111")}
        data, history, state = run_clients(clients)
        self.assertEqual(data["status"], "error")
        self.assertEqual(state["uids"], {})
        for name, client in clients.items():
            self.assertEqual(len(client.calls), 1)
            self.assertEqual(data["traders"][name]["error_code"], "duplicate_accounts")
            self.assertIsNone(data["traders"][name]["equity"])
            self.assertIsNone(data["traders"][name]["updated"])
            self.assertEqual(history["series"][name], [])

    def test_first_identity_failure_does_not_accept_unverified_pair(self):
        clients = {"Alpha": FakeClient("11111111"), "Beta": FakeClient("22222222", fail=("/api/v5/account/config", snapshot.SnapshotError("api_50113")))}
        data, _, _ = run_clients(clients)
        self.assertEqual(data["traders"]["Alpha"]["error_code"], "identity_unverified")
        self.assertEqual(len(clients["Alpha"].calls), 1)

    def test_account_change_is_rejected_and_old_value_retained(self):
        _, _, state = run_clients({"Alpha": FakeClient("11111111"), "Beta": FakeClient("22222222")})
        alpha = FakeClient("33333333", equity="999")
        data, history, new_state = run_clients({"Alpha": alpha, "Beta": FakeClient("22222222", equity="20")}, state, NOW + 60)
        self.assertEqual(data["traders"]["Alpha"]["error_code"], "account_changed")
        self.assertEqual(data["traders"]["Alpha"]["equity"], 12.5)
        self.assertEqual(data["traders"]["Alpha"]["updated"], NOW)
        self.assertEqual(len(history["series"]["Alpha"]), 1)
        self.assertEqual(len(alpha.calls), 1)
        self.assertEqual(new_state["uids"]["Alpha"], "11111111")
        self.assertEqual(data["traders"]["Beta"]["equity"], 20)

    def test_later_failure_preserves_values_trades_timestamp_and_history(self):
        _, _, state = run_clients({"Alpha": FakeClient("11111111", pages=[[fill()]]), "Beta": FakeClient("22222222")})
        data, history, _ = run_clients({"Alpha": FakeClient("11111111", equity="999", fail=("/api/v5/trade/fills", RuntimeError("SECRET_API_KEY"))), "Beta": FakeClient("22222222")}, state, NOW + 60)
        self.assertEqual(data["status"], "partial")
        self.assertEqual(data["traders"]["Alpha"]["updated"], NOW)
        self.assertEqual(data["traders"]["Alpha"]["equity"], 12.5)
        self.assertEqual(data["traders"]["Alpha"]["error_code"], "collection_error")
        self.assertEqual(len(data["trades"]), 1)
        self.assertEqual(len(history["series"]["Alpha"]), 1)
        self.assertNotIn("SECRET_API_KEY", json.dumps(data))

    def test_only_public_whitelist_and_fee_sign_and_contract_units(self):
        position = {"instType": "SWAP", "instId": "BTC-USDT-SWAP", "posSide": "net", "pos": "-2",
                    "avgPx": "51000", "upl": "-3", "ccy": "USDT", "api_secret": "SECRET_POSITION"}
        data, _, _ = run_clients({"Alpha": FakeClient("11111111", position_rows=[position], pages=[[fill(), fill("2", fee="0.01")]]), "Beta": FakeClient("22222222")})
        self.assertEqual([row["fee"] for row in data["trades"]], [-0.02, 0.01])
        self.assertEqual(data["trades"][0]["pnl"], 3)
        self.assertEqual(data["trades"][0]["qty"], "2 張")
        self.assertEqual(data["trades"][0]["feeCcy"], "USDT")
        pos = data["traders"]["Alpha"]["positions"][0]
        self.assertEqual((pos["sz"], pos["side"], pos["qty_unit"], pos["upl_ccy"]), (2, "short", "張", "USDT"))
        encoded = json.dumps(data)
        for forbidden in ["DO_NOT_PUBLISH", "SECRET_POSITION", "PRIVATE_LABEL", "private-order-id", "11111111"]:
            self.assertNotIn(forbidden, encoded)

    def test_pagination_deduplicates_and_marks_capped_result_partial(self):
        page = [fill(str(i)) for i in range(100)]
        config = configuration(max_fill_pages=1)
        data, _, _ = run_clients({"Alpha": FakeClient("11111111", pages=[page]), "Beta": FakeClient("22222222")}, config=config)
        self.assertTrue(data["traders"]["Alpha"]["fills_partial"])
        self.assertIsNone(data["traders"]["Alpha"]["fills_total"])
        alpha = FakeClient("11111111", pages=[page, [fill("99"), fill("100")]])
        data, _, _ = run_clients({"Alpha": alpha, "Beta": FakeClient("22222222")})
        self.assertEqual(data["traders"]["Alpha"]["fills_recent"], 101)
        self.assertFalse(data["traders"]["Alpha"]["fills_partial"])
        self.assertIn(("/api/v5/trade/fills", {"limit": "100", "after": "99"}), alpha.calls)

    def test_empty_success_is_zero_but_unknown_and_failed_balance_are_not(self):
        class EmptyClient(FakeClient):
            def get(self, path, params=None):
                return [] if path.endswith("/balance") else super().get(path, params)
        data, _, _ = run_clients({"Alpha": EmptyClient("11111111"), "Beta": FakeClient("22222222", equity="")})
        self.assertEqual(data["traders"]["Alpha"]["equity"], 0)
        self.assertIsNone(data["traders"]["Beta"]["equity"])
        self.assertEqual(data["traders"]["Beta"]["status"], "error")

    def test_owned_checkpoint_only_and_demo_binding(self):
        config = configuration()
        with self.assertRaisesRegex(snapshot.SnapshotError, "state_not_owned"):
            snapshot.collect(config, {"traders": {}, "history": {}}, environment={})
        state = snapshot.new_state(config)
        config["bots"][0]["simulated"] = True
        with self.assertRaisesRegex(snapshot.SnapshotError, "state_not_owned"):
            snapshot.validate_state(state, config)

    def test_output_files_are_paired_and_never_bootstrap_original_json(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output, private = root / "public", root / "private"
            output.mkdir()
            (output / "data.json").write_text('{"traders":{"OriginalAuthor":{"equity":9999}}}', encoding="utf-8")
            (output / "history.json").write_text('{"OriginalAuthor":[[1,9999]]}', encoding="utf-8")
            clients = {"Alpha": FakeClient("11111111"), "Beta": FakeClient("22222222")}
            snapshot.export(configuration(), output, private, client_factory=lambda bot: clients[bot["name"]], now=NOW)
            data = json.loads((output / "data.json").read_text(encoding="utf-8"))
            history = json.loads((output / "history.json").read_text(encoding="utf-8"))
            self.assertEqual(data["snapshot_id"], history["snapshot_id"])
            self.assertNotIn("OriginalAuthor", json.dumps(data) + json.dumps(history))
            self.assertNotIn("11111111", json.dumps(data) + json.dumps(history))
            self.assertTrue((private / "run.lock").exists())
            with snapshot.state_lock(private):
                pass
            self.assertEqual(json.loads((private / "state.json").read_text(encoding="utf-8"))["uids"]["Alpha"], "11111111")

    def test_private_state_rejected_in_public_or_git_tree(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaisesRegex(snapshot.SnapshotError, "inside_public"):
                snapshot.export(configuration(), root, root / "state")
            (root / ".git").mkdir()
            with self.assertRaisesRegex(snapshot.SnapshotError, "inside_git"):
                snapshot.export(configuration(), root / "public", root / "state")

    def test_explicit_mapping_and_missing_credentials_are_safe(self):
        config = configuration()
        self.assertEqual(config["bots"][0]["env"]["api_key"], "OKX_A_API_KEY")
        self.assertEqual(config["bots"][1]["env"]["api_key"], "B_KEY")
        data, _, _ = snapshot.collect(config, snapshot.new_state(config), environment={}, now=NOW)
        self.assertEqual(data["traders"]["Alpha"]["error_code"], "credentials_missing")

    def test_os_lock_blocks_second_process_and_recovers_after_forced_exit(self):
        child_program = '''
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("okx_snapshot_child", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with module.state_lock(pathlib.Path(sys.argv[2])):
    print("locked", flush=True)
    sys.stdin.read()
'''
        with tempfile.TemporaryDirectory() as folder:
            state_dir = Path(folder) / "private"
            process = subprocess.Popen([sys.executable, "-B", "-c", child_program, str(Path(snapshot.__file__).resolve()), str(state_dir)],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, encoding="utf-8")
            try:
                self.assertEqual(process.stdout.readline().strip(), "locked")
                with self.assertRaisesRegex(snapshot.SnapshotError, "^another_run_is_active$"):
                    with snapshot.state_lock(state_dir):
                        self.fail("Two independent processes must not own the state lock")
                # Simulate subprocess.run(timeout=...) killing the collector. No
                # context-manager/finally cleanup runs inside the killed child.
                process.kill()
                process.wait(timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertTrue((state_dir / "run.lock").exists())
                with snapshot.state_lock(state_dir):
                    pass
                with snapshot.state_lock(state_dir):
                    pass
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)


class Response:
    def __init__(self, payload):
        self.body = json.dumps(payload).encode()
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self, _):
        return self.body


class Opener:
    def __init__(self, payload=None):
        self.requests = []
        self.payload = payload or {"code": "0", "data": []}
    def open(self, request, timeout):
        self.requests.append(request)
        return Response(self.payload)


class TransportTests(unittest.TestCase):
    def client(self, opener):
        return snapshot.OKXClient({"api_key": "fake-key", "secret_key": "fake-secret", "passphrase": "fake-pass"},
                                  simulated=True, opener=opener, clock=lambda: NOW)

    def test_fixed_https_get_allowlist_no_redirect_and_correct_signature(self):
        opener = Opener()
        client = self.client(opener)
        for path in ["https://evil.test/api/v5/account/balance", "/api/v5/trade/order", "/api/v5/account/balance?ccy=USDT", "//evil.test"]:
            with self.assertRaisesRegex(snapshot.SnapshotError, "endpoint_not_allowed"):
                client.get(path)
        with self.assertRaisesRegex(snapshot.SnapshotError, "endpoint_not_allowed"):
            client.get("/api/v5/account/balance", {"url": "https://evil.test"})
        self.assertEqual(opener.requests, [])
        client.get("/api/v5/account/balance", {"ccy": "USDT"})
        request = opener.requests[0]
        self.assertEqual(request.full_url, "https://www.okx.com/api/v5/account/balance?ccy=USDT")
        self.assertEqual(request.method, "GET")
        self.assertIsNone(request.data)
        headers = {k.lower(): v for k, v in request.header_items()}
        expected = base64.b64encode(hmac.new(b"fake-secret", (headers["ok-access-timestamp"] + "GET/api/v5/account/balance?ccy=USDT").encode(), hashlib.sha256).digest()).decode()
        self.assertEqual(headers["ok-access-sign"], expected)
        self.assertEqual(headers["x-simulated-trading"], "1")
        with self.assertRaisesRegex(snapshot.SnapshotError, "redirect_blocked"):
            snapshot.NoRedirect().redirect_request(request, None, 302, "", {}, "https://evil.test")

    def test_api_message_or_non_numeric_code_cannot_leak_secrets(self):
        opener = Opener({"code": "secret-in-code", "msg": "fake-secret fake-key fake-pass", "data": []})
        with self.assertRaisesRegex(snapshot.SnapshotError, "^api_error$"):
            self.client(opener).get("/api/v5/account/config")

    def test_cli_error_snapshot_can_be_published_without_logging_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config_file = root / "config.json"
            config_file.write_text(json.dumps({"bots": [{"name": "Alpha", "env_prefix": "OKX_A"}, {"name": "Beta", "env_prefix": "OKX_B"}]}))
            out = io.StringIO()
            with patch.dict(os.environ, {}, clear=True), contextlib.redirect_stdout(out):
                code = snapshot.main(["--config", str(config_file), "--output", str(root / "public"), "--state-dir", str(root / "private")])
            self.assertEqual(code, 0)
            result = json.loads(out.getvalue())
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["bots"]["Alpha"]["error_code"], "credentials_missing")
            self.assertTrue((root / "public" / "data.json").exists())


if __name__ == "__main__":
    unittest.main()
