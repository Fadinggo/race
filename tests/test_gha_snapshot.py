"""Authenticated checkpoint tests, with fake accounts and disposable directories."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import gha_snapshot as gha
collector = gha.collector

NOW = 1793310000.0
KEY = bytes(range(32))  # Fixed, intentionally public TEST key; never a real secret.
ENVIRONMENT = {"DASHBOARD_STATE_KEY": KEY.hex()}
UID_A = "920000000000000001"
UID_B = "920000000000000002"
BILL_ID = "930000000000000001"


def config():
    return collector.parse_config({"bots": [
        {"name": "Grok-Trader-A", "env_prefix": "OKX_A"},
        {"name": "Grok-Trader-B", "env_prefix": "OKX"}
    ]})


class Client:
    def __init__(self, uid, equity="0", include_fill=False):
        self.uid, self.equity, self.include_fill = uid, equity, include_fill
        self.calls = []

    def get(self, path, params=None):
        self.calls.append(path)
        if path.endswith("/config"):
            return [{"uid": self.uid, "private": "NEVER_COPY_ME"}]
        if path.endswith("/balance"):
            return [{"details": [{"ccy": "USDT", "eq": self.equity}]}]
        if path.endswith("/positions"):
            return []
        if path.endswith("/fills"):
            return [{"billId": BILL_ID, "ordId": "940000000000000001", "tradeId": "950000000000000001",
                     "instId": "BTC-USDT-SWAP", "instType": "SWAP", "subType": "5",
                     "fillTime": str(int((NOW - 60) * 1000)), "fillSz": "1", "fillPx": "50000",
                     "fillPnl": "2", "fee": "-0.01", "feeCcy": "USDT"}] if self.include_fill else []
        raise AssertionError("Unknown test endpoint")


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "repo"
        self.output.mkdir()
        (self.output / ".git").mkdir()
        self.checkpoint = self.output / "state-checkpoint.json"
        self.config = config()
        pending = {"start": None, "equity": None, "currency": "USDT", "updated": None,
                   "status": "not_connected", "positions": None, "fills_total": None,
                   "fees_total": None, "funding_total": None}
        names = [bot["name"] for bot in self.config["bots"]]
        self.pending_data = {"schema_version": 1, "source": "own-okx-readonly",
                             "snapshot_id": "awaiting-live-connection", "generated_at": None,
                             "updated": None, "status": "pending", "traders": {
                                 name: copy.deepcopy(pending) for name in names}, "trades": []}
        self.pending_history = {"snapshot_id": "awaiting-live-connection", "series": {name: [] for name in names}}
        (self.output / "data.json").write_text(json.dumps(self.pending_data))
        (self.output / "history.json").write_text(json.dumps(self.pending_history))

    def run_export(self, *, bootstrap=False, now=NOW, clients=None, environment=None, private="private-1"):
        clients = clients or {"Grok-Trader-A": Client(UID_A), "Grok-Trader-B": Client(UID_B)}
        return gha.export(self.config, self.output, self.checkpoint, self.root / private,
                          bootstrap=bootstrap, now=now, client_factory=lambda bot: clients[bot["name"]],
                          environment=ENVIRONMENT if environment is None else environment)

    def document(self):
        return json.loads(self.checkpoint.read_text(encoding="utf-8"))

    def bytes_before(self):
        return {name: (self.output / name).read_bytes() for name in ("data.json", "history.json", "state-checkpoint.json")}

    def test_first_run_requires_explicit_bootstrap_and_independent_key(self):
        clients = {"Grok-Trader-A": Client(UID_A), "Grok-Trader-B": Client(UID_B)}
        with self.assertRaisesRegex(collector.SnapshotError, "state_key_missing"):
            self.run_export(bootstrap=True, environment={}, clients=clients)
        with self.assertRaisesRegex(collector.SnapshotError, "checkpoint_missing_bootstrap_required"):
            self.run_export(clients=clients)
        self.assertEqual(sum(len(c.calls) for c in clients.values()), 0)
        self.assertFalse(self.checkpoint.exists())

    def test_bootstrap_never_imports_original_author_values_or_history(self):
        (self.output / "data.json").write_text(json.dumps({"traders": {"OriginalAuthor": {"equity": 9999}}}))
        (self.output / "history.json").write_text(json.dumps({"OriginalAuthor": [[1, 9999]]}))
        clients = {"Grok-Trader-A": Client(UID_A), "Grok-Trader-B": Client(UID_B)}
        with self.assertRaisesRegex(collector.SnapshotError, "invalid_bootstrap_source"):
            self.run_export(bootstrap=True, clients=clients)
        self.assertEqual(sum(len(c.calls) for c in clients.values()), 0)
        self.assertFalse(self.checkpoint.exists())

    def test_pending_placeholder_is_allowed_for_first_connection(self):
        data = self.run_export(bootstrap=True)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["traders"]["Grok-Trader-A"]["equity"], 0)
        self.assertIsNone(data["traders"]["Grok-Trader-A"]["start"])
        history = json.loads((self.output / "history.json").read_text())
        self.assertEqual(history["series"]["Grok-Trader-A"], [[int(NOW * 1000), 0]])
        self.assertNotIn("OriginalAuthor", self.checkpoint.read_text())

    def test_bootstrap_rejects_missing_mixed_populated_or_wrong_name_pairs_before_api(self):
        invalid_pairs = []
        invalid_pairs.extend([(None, self.pending_history), (self.pending_data, None), (None, None)])
        for field, value in (("equity", 0), ("start", 10), ("updated", NOW), ("positions", [])):
            data = copy.deepcopy(self.pending_data)
            data["traders"]["Grok-Trader-A"][field] = value
            invalid_pairs.append((data, self.pending_history))
        data = copy.deepcopy(self.pending_data)
        data["trades"] = [{"trader": "Grok-Trader-A", "ts": NOW}]
        invalid_pairs.append((data, self.pending_history))
        data = copy.deepcopy(self.pending_data)
        data["traders"]["OtherBot"] = data["traders"].pop("Grok-Trader-B")
        invalid_pairs.append((data, self.pending_history))
        for mutate in (lambda h: h.update(snapshot_id="previous-live-batch"),
                       lambda h: h["series"]["Grok-Trader-A"].append([int(NOW * 1000), 10]),
                       lambda h: h["series"].pop("Grok-Trader-B")):
            history = copy.deepcopy(self.pending_history)
            mutate(history)
            invalid_pairs.append((self.pending_data, history))
        for index, (data, history) in enumerate(invalid_pairs):
            with self.subTest(case=index):
                for filename, document in (("data.json", data), ("history.json", history)):
                    path = self.output / filename
                    if document is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_text(json.dumps(document))
                before = {p.name: p.read_bytes() for p in self.output.glob("*.json")}
                clients = {"Grok-Trader-A": Client(UID_A), "Grok-Trader-B": Client(UID_B)}
                with self.assertRaises(collector.SnapshotError):
                    self.run_export(bootstrap=True, clients=clients)
                self.assertEqual(sum(len(c.calls) for c in clients.values()), 0)
                self.assertEqual(before, {p.name: p.read_bytes() for p in self.output.glob("*.json")})
                self.assertFalse(self.checkpoint.exists())

    def test_lost_checkpoint_and_data_cannot_bootstrap_over_live_history(self):
        self.run_export(bootstrap=True)
        self.checkpoint.unlink()
        (self.output / "data.json").unlink()
        before = (self.output / "history.json").read_bytes()
        clients = {"Grok-Trader-A": Client("920000000000000003"), "Grok-Trader-B": Client(UID_B)}
        with self.assertRaisesRegex(collector.SnapshotError, "checkpoint_or_public_file_unreadable"):
            self.run_export(bootstrap=True, clients=clients, private="fresh-runner")
        self.assertEqual(sum(len(c.calls) for c in clients.values()), 0)
        self.assertEqual(before, (self.output / "history.json").read_bytes())
        self.assertFalse(self.checkpoint.exists())

    def test_new_ephemeral_runner_continues_history_binding_and_fill_dedup(self):
        first = self.run_export(bootstrap=True, clients={"Grok-Trader-A": Client(UID_A, "10", True), "Grok-Trader-B": Client(UID_B)})
        old_binding = self.document()["payload"]["uids"]
        # An unrelated/stale scratch state must not override the signed checkpoint.
        scratch = self.root / "fresh-runner"
        scratch.mkdir()
        (scratch / "state.json").write_text('{"uids":{"Grok-Trader-A":"wrong"}}')
        second = self.run_export(now=NOW + 300, private="fresh-runner",
                                 clients={"Grok-Trader-A": Client(UID_A, "11", True), "Grok-Trader-B": Client(UID_B)})
        checkpoint = self.document()
        history = json.loads((self.output / "history.json").read_text())
        self.assertNotEqual(first["snapshot_id"], second["snapshot_id"])
        self.assertEqual(second["snapshot_id"], checkpoint["snapshot_id"])
        self.assertEqual(second["snapshot_id"], history["snapshot_id"])
        self.assertEqual(checkpoint["payload"]["uids"], old_binding)
        self.assertEqual(len(history["series"]["Grok-Trader-A"]), 2)
        self.assertEqual(len(second["trades"]), 1)
        self.assertEqual(len(checkpoint["payload"]["bots"]["Grok-Trader-A"]["fills"]), 1)

    def test_all_committable_files_exclude_raw_ids_keys_and_unapproved_api_fields(self):
        self.run_export(bootstrap=True, clients={"Grok-Trader-A": Client(UID_A, "10", True), "Grok-Trader-B": Client(UID_B)})
        published = "\n".join((self.output / name).read_text(encoding="utf-8") for name in ("data.json", "history.json", "state-checkpoint.json"))
        for forbidden in (UID_A, UID_B, BILL_ID, "940000000000000001", "950000000000000001", KEY.hex(), "NEVER_COPY_ME", "ordId", "tradeId"):
            self.assertNotIn(forbidden, published)
        document = self.document()
        self.assertEqual(document["payload"]["format"], collector.OPAQUE_STATE_FORMAT)
        self.assertTrue(all(gha.HEX_DIGEST.fullmatch(v) for v in document["payload"]["uids"].values()))

    def test_tampered_checkpoint_fails_before_api_calls_and_preserves_outputs(self):
        self.run_export(bootstrap=True)
        document = self.document()
        document["payload"]["bots"]["Grok-Trader-A"]["public"]["equity"] = 9999
        self.checkpoint.write_text(json.dumps(document))
        before = self.bytes_before()
        clients = {"Grok-Trader-A": Client(UID_A), "Grok-Trader-B": Client(UID_B)}
        with self.assertRaisesRegex(collector.SnapshotError, "checkpoint_authentication_failed"):
            self.run_export(clients=clients, private="fresh-runner")
        self.assertEqual(sum(len(c.calls) for c in clients.values()), 0)
        self.assertEqual(before, self.bytes_before())

    def test_rotated_state_key_cannot_silently_replace_identity_binding(self):
        self.run_export(bootstrap=True)
        with self.assertRaisesRegex(collector.SnapshotError, "checkpoint_authentication_failed"):
            self.run_export(bootstrap=True, environment={"DASHBOARD_STATE_KEY": bytes(reversed(KEY)).hex()}, private="new-key-runner")

    def test_lost_active_checkpoint_fails_closed_even_with_bootstrap(self):
        self.run_export(bootstrap=True)
        self.checkpoint.unlink()
        with self.assertRaisesRegex(collector.SnapshotError, "checkpoint_missing_bootstrap_required"):
            self.run_export(private="fresh-runner")
        with self.assertRaisesRegex(collector.SnapshotError, "active_checkpoint_missing"):
            self.run_export(bootstrap=True, private="fresh-runner")

    def test_mixed_public_batch_cannot_reset_authenticated_state(self):
        self.run_export(bootstrap=True)
        (self.output / "history.json").write_text('{"snapshot_id":"wrong","series":{}}')
        with self.assertRaisesRegex(collector.SnapshotError, "checkpoint_public_pair_mismatch"):
            self.run_export(private="fresh-runner")

    def test_changed_account_is_rejected_after_ephemeral_restart(self):
        first = self.run_export(bootstrap=True, clients={"Grok-Trader-A": Client(UID_A, "10"), "Grok-Trader-B": Client(UID_B)})
        binding = self.document()["payload"]["uids"]
        second = self.run_export(now=NOW + 300, private="fresh-runner", clients={
            "Grok-Trader-A": Client("920000000000000003", "999"), "Grok-Trader-B": Client(UID_B, "2")})
        self.assertEqual(second["traders"]["Grok-Trader-A"]["equity"], 10)
        self.assertEqual(second["traders"]["Grok-Trader-A"]["updated"], NOW)
        self.assertEqual(second["traders"]["Grok-Trader-A"]["error_code"], "account_changed")
        self.assertEqual(second["traders"]["Grok-Trader-B"]["equity"], 2)
        self.assertEqual(self.document()["payload"]["uids"], binding)

    def test_same_account_keys_are_still_detected_after_identifier_hashing(self):
        data = self.run_export(bootstrap=True, clients={"Grok-Trader-A": Client(UID_A), "Grok-Trader-B": Client(UID_A)})
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["traders"]["Grok-Trader-A"]["error_code"], "duplicate_accounts")
        self.assertEqual(self.document()["payload"]["uids"], {})

    def test_schema_guard_refuses_to_sign_raw_identifiers_or_extra_fields(self):
        self.run_export(bootstrap=True)
        state = self.document()["payload"]
        raw = copy.deepcopy(state)
        raw["uids"]["Grok-Trader-A"] = UID_A
        with self.assertRaisesRegex(collector.SnapshotError, "invalid_identity_state"):
            gha.seal(raw, self.config, "next", KEY)
        extra = copy.deepcopy(state)
        extra["bots"]["Grok-Trader-A"]["public"]["api_key"] = "forbidden"
        with self.assertRaisesRegex(collector.SnapshotError, "checkpoint_not_sanitized"):
            gha.seal(extra, self.config, "next", KEY)

    def test_state_key_formats_and_domain_separation(self):
        self.assertEqual(gha.state_key(ENVIRONMENT), KEY)
        self.assertEqual(gha.state_key({"DASHBOARD_STATE_KEY": base64.b64encode(KEY).decode()}), KEY)
        for invalid in ("short", "z" * 64, base64.b64encode(b"x" * 24).decode()):
            with self.assertRaisesRegex(collector.SnapshotError, "invalid_state_key"):
                gha.state_key({"DASHBOARD_STATE_KEY": invalid})
        self.assertNotEqual(collector.opaque_identifier(KEY, "account", UID_A), collector.opaque_identifier(KEY, "fill:Grok-Trader-A", UID_A))
        self.assertNotEqual(collector.opaque_identifier(KEY, "account", UID_A), collector.opaque_identifier(bytes(reversed(KEY)), "account", UID_A))

    def total_clients(self):
        class HistoryClient(Client):
            def get(self, path, params=None):
                if path.endswith("/fills-history"):
                    return super().get("/api/v5/trade/fills") if params["instType"] == "SWAP" else []
                if path.endswith("/bills-archive"):
                    return [{"billId": "960000000000000001", "ts": str(int((NOW - 30) * 1000)),
                             "type": "8", "balChg": "-0.02", "ccy": "USDT", "uid": UID_A}]
                return super().get(path, params)
        return {"Grok-Trader-A": HistoryClient(UID_A, "10", True), "Grok-Trader-B": HistoryClient(UID_B)}

    def test_legacy_signed_checkpoint_migrates_without_reset_then_survives_new_runner(self):
        self.run_export(bootstrap=True, clients=self.total_clients())
        document = self.document()
        legacy = document["payload"]
        for stored in legacy["bots"].values():
            stored.pop("totals")
            for field in collector.TOTAL_FIELDS:
                stored["public"].pop(field)
        self.checkpoint.write_text(json.dumps(gha.seal(legacy, self.config, document["snapshot_id"], KEY)))
        binding = copy.deepcopy(legacy["uids"])
        self.config["statistics_start"] = NOW - 3600
        data = self.run_export(now=NOW + 300, clients=self.total_clients(), private="migration-runner")
        migrated = self.document()
        self.assertEqual(migrated["payload"]["uids"], binding)
        self.assertEqual(len(migrated["payload"]["bots"]["Grok-Trader-A"]["history"]), 2)
        trader = data["traders"]["Grok-Trader-A"]
        self.assertEqual(trader["fills_total"], 1)
        self.assertEqual(trader["fees_total"], -0.01)
        self.assertEqual(trader["funding_total"], -0.02)
        self.assertEqual(trader["totals_status"], "complete")
        for forbidden in (UID_A, UID_B, BILL_ID, "960000000000000001", KEY.hex(), "NEVER_COPY_ME"):
            self.assertNotIn(forbidden, self.checkpoint.read_text())
        restored = self.run_export(now=NOW + 600, clients=self.total_clients(), private="third-runner")
        self.assertEqual(restored["traders"]["Grok-Trader-A"]["fills_total"], 1)
        self.assertEqual(restored["traders"]["Grok-Trader-A"]["fees_total"], -0.01)
        self.assertEqual(len(self.document()["payload"]["bots"]["Grok-Trader-A"]["history"]), 3)

    def test_cumulative_schema_rejects_raw_ids_extra_fields_and_tampered_ledger(self):
        self.config["statistics_start"] = NOW - 3600
        self.run_export(bootstrap=True, clients=self.total_clients())
        original = self.document()
        for mutate in (
                lambda source: source["events"].update({BILL_ID: {"ts": int(NOW * 1000), "amount": "0", "ccy": "USDT"}}),
                lambda source: source.update(api_key="forbidden"),
                lambda source: next(iter(source["events"].values())).update(ordId="forbidden"),
                lambda source: source.update(partial=False, through=None)):
            state = copy.deepcopy(original["payload"])
            mutate(state["bots"]["Grok-Trader-A"]["totals"]["streams"]["SWAP"])
            with self.assertRaisesRegex(collector.SnapshotError, "checkpoint_not_sanitized"):
                gha.seal(state, self.config, "next", KEY)
        original["payload"]["bots"]["Grok-Trader-A"]["totals"]["streams"]["SWAP"]["events"].clear()
        self.checkpoint.write_text(json.dumps(original))
        before = self.bytes_before()
        clients = self.total_clients()
        with self.assertRaisesRegex(collector.SnapshotError, "checkpoint_authentication_failed"):
            self.run_export(clients=clients, private="tampered-runner")
        self.assertEqual(sum(len(c.calls) for c in clients.values()), 0)
        self.assertEqual(self.bytes_before(), before)


if __name__ == "__main__":
    unittest.main()
