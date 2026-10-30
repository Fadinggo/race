#!/usr/bin/env python3
"""Resume an authenticated, sanitized checkpoint on an ephemeral Actions runner.

The independently generated DASHBOARD_STATE_KEY secret is 32 random bytes,
encoded as either 64 hexadecimal characters or standard Base64. This program
does not generate keys. It never derives its state key from an OKX credential.
Public checkpoint contents are already-publishable observations plus keyed,
domain-separated account/fill identifiers, never raw UID/order IDs or secrets.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import os
from pathlib import Path
import re

import okx_snapshot as collector


CHECKPOINT_FORMAT = "race-okx-authenticated-checkpoint-v1"
CHECKPOINT_FILENAME = "state-checkpoint.json"
BOOTSTRAP_PLACEHOLDER = "awaiting-live-connection"
HEX_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
TRADER_FIELDS = frozenset({"equity", "start", "currency", "positions", "fees_total", "funding_total",
                          "fills_total", "fills_recent", "fills_partial", "fills_window_start", "status",
                          "updated", "error_code"})
POSITION_FIELDS = frozenset({"inst", "side", "sz", "avgPx", "upl", "upl_ccy", "qty_unit"})
FILL_FIELDS = frozenset({"trader", "time", "ts", "market", "side", "price", "qty", "pnl", "pnl_ccy",
                        "fee", "feeCcy", "note"})


def state_key(environment):
    encoded = environment.get("DASHBOARD_STATE_KEY", "")
    if not isinstance(encoded, str) or not encoded:
        raise collector.SnapshotError("state_key_missing")
    try:
        if re.fullmatch(r"[0-9a-fA-F]{64}", encoded):
            key = bytes.fromhex(encoded)
        else:
            key = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise collector.SnapshotError("invalid_state_key") from None
    if len(key) != 32:
        raise collector.SnapshotError("invalid_state_key")
    return key


def canonical(value):
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, OverflowError):
        raise collector.SnapshotError("invalid_checkpoint") from None


def signature(key, unsigned):
    return hmac.new(key, b"race-okx-checkpoint-auth/v1\0" + canonical(unsigned), hashlib.sha256).hexdigest()


def sanitized_state(state, config):
    """Reject schema extensions or raw IDs instead of accidentally publishing them."""
    collector.validate_state(state, config, opaque=True)
    if set(state) != {"format", "bot_names", "modes", "uids", "bots"} or set(state["bots"]) != set(state["bot_names"]):
        raise collector.SnapshotError("checkpoint_not_sanitized")
    for name, stored in state["bots"].items():
        if not isinstance(stored, dict) or set(stored) not in ({"public", "fills", "history"},
                                                              {"public", "fills", "history", "totals"}):
            raise collector.SnapshotError("checkpoint_not_sanitized")
        public, fills, history = stored["public"], stored["fills"], stored["history"]
        if not isinstance(public, dict) or set(public) not in (TRADER_FIELDS, TRADER_FIELDS | collector.TOTAL_FIELDS):
            raise collector.SnapshotError("checkpoint_not_sanitized")
        if "totals_status" in public:
            if public["totals_status"] not in ("complete", "partial") or any(
                    type(public[field]) is not bool for field in
                    ("fills_total_partial", "fees_total_partial", "funding_total_partial")):
                raise collector.SnapshotError("checkpoint_not_sanitized")
            for field in ("totals_since", "totals_updated"):
                value = public[field]
                if value is not None and (type(value) not in (int, float) or collector.number(value) is None or value <= 0):
                    raise collector.SnapshotError("checkpoint_not_sanitized")
        if "totals" in stored:
            sanitized_totals(stored["totals"])
        positions = public["positions"]
        if positions is not None and (not isinstance(positions, list) or any(
                not isinstance(position, dict) or set(position) != POSITION_FIELDS for position in positions)):
            raise collector.SnapshotError("checkpoint_not_sanitized")
        if not isinstance(fills, dict) or not isinstance(history, list):
            raise collector.SnapshotError("checkpoint_not_sanitized")
        for identity, fill in fills.items():
            if (not isinstance(identity, str) or not HEX_DIGEST.fullmatch(identity) or not isinstance(fill, dict)
                    or set(fill) != FILL_FIELDS or fill["trader"] != name):
                raise collector.SnapshotError("checkpoint_not_sanitized")
        for point in history:
            if not isinstance(point, list) or len(point) != 2:
                raise collector.SnapshotError("checkpoint_not_sanitized")
            if collector.number(point[0]) is None or collector.number(point[1]) is None:
                raise collector.SnapshotError("checkpoint_not_sanitized")
    canonical(state)  # Also reject NaN/Infinity before authentication or publication.


def sanitized_totals(totals):
    def reject():
        raise collector.SnapshotError("checkpoint_not_sanitized")

    if not isinstance(totals, dict) or set(totals) != {"since", "streams"}:
        reject()
    since = totals["since"]
    if since is not None and (type(since) not in (int, float) or collector.number(since) is None or since <= 0):
        reject()
    streams = totals["streams"]
    if not isinstance(streams, dict) or set(streams) not in (set(), set(collector.TOTAL_STREAMS)):
        reject()
    if since is None and streams:
        reject()
    for source in streams.values():
        if not isinstance(source, dict) or set(source) != {"through", "gap", "partial", "events"}:
            reject()
        through = source["through"]
        if through is not None and (type(through) not in (int, float) or collector.number(through) is None or through < since):
            reject()
        if type(source["gap"]) is not bool or type(source["partial"]) is not bool or not isinstance(source["events"], dict):
            reject()
        if not source["partial"] and (source["gap"] or through is None):
            reject()
        for identity, event in source["events"].items():
            if not isinstance(identity, str) or not HEX_DIGEST.fullmatch(identity):
                reject()
            if not isinstance(event, dict) or set(event) != {"ts", "amount", "ccy"}:
                reject()
            if type(event["ts"]) is not int or event["ts"] < int(since * 1000):
                reject()
            if event["amount"] is not None and (not isinstance(event["amount"], str) or
                    collector.decimal_amount(event["amount"]) != event["amount"]):
                reject()
            if event["ccy"] is not None and (not isinstance(event["ccy"], str) or not collector.CCY.fullmatch(event["ccy"])):
                reject()


def seal(state, config, snapshot_id, key):
    sanitized_state(state, config)
    if not isinstance(snapshot_id, str) or not snapshot_id:
        raise collector.SnapshotError("invalid_checkpoint")
    unsigned = {"format": CHECKPOINT_FORMAT, "snapshot_id": snapshot_id, "payload": state}
    return {**unsigned, "mac": signature(key, unsigned)}


def unseal(document, config, key):
    if (not isinstance(document, dict) or set(document) != {"format", "snapshot_id", "payload", "mac"}
            or document["format"] != CHECKPOINT_FORMAT or not isinstance(document["snapshot_id"], str)
            or not document["snapshot_id"] or not isinstance(document["mac"], str)
            or not HEX_DIGEST.fullmatch(document["mac"])):
        raise collector.SnapshotError("invalid_checkpoint")
    unsigned = {name: document[name] for name in ("format", "snapshot_id", "payload")}
    if not hmac.compare_digest(signature(key, unsigned), document["mac"]):
        raise collector.SnapshotError("checkpoint_authentication_failed")
    sanitized_state(document["payload"], config)
    return document["payload"]


def read_json(path):
    try:
        if path.stat().st_size > 32 * 1024 * 1024:
            raise collector.SnapshotError("checkpoint_too_large")
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, UnicodeError):
        raise collector.SnapshotError("checkpoint_or_public_file_unreadable") from None


def validate_paths(output, checkpoint, state_dir):
    output = Path(output).resolve()
    lexical_checkpoint = Path(os.path.abspath(checkpoint))
    if lexical_checkpoint.is_symlink() or lexical_checkpoint.resolve() != output / CHECKPOINT_FILENAME:
        raise collector.SnapshotError("unexpected_checkpoint_path")
    state_dir = Path(state_dir).resolve()
    if state_dir == output or output in state_dir.parents:
        raise collector.SnapshotError("private_state_inside_public_output")
    if any((parent / ".git").exists() for parent in (state_dir, *state_dir.parents)):
        raise collector.SnapshotError("private_state_inside_git_checkout")
    for filename in ("data.json", "history.json"):
        path = output / filename
        if path.is_symlink() or path.resolve().parent != output:
            raise collector.SnapshotError("invalid_public_output_path")
    return output, lexical_checkpoint, state_dir


def load_or_bootstrap(checkpoint, output, config, key, bootstrap):
    if checkpoint.exists():
        document = read_json(checkpoint)
        state = unseal(document, config, key)
        # Actions commits all three files together. Refuse a damaged/mixed checkout.
        for filename in ("data.json", "history.json"):
            public = read_json(output / filename)
            if not isinstance(public, dict) or public.get("snapshot_id") != document["snapshot_id"]:
                raise collector.SnapshotError("checkpoint_public_pair_mismatch")
        return state
    if not bootstrap:
        raise collector.SnapshotError("checkpoint_missing_bootstrap_required")
    # Require the complete, empty pending pair. Missing files, leftover live
    # history, mixed batches and author data must never authorize a fresh identity.
    data = read_json(output / "data.json")
    history = read_json(output / "history.json")
    if any(isinstance(document, dict) and document.get("snapshot_id") not in (None, BOOTSTRAP_PLACEHOLDER)
           for document in (data, history)):
        raise collector.SnapshotError("active_checkpoint_missing")
    pending_trader = {"start": None, "equity": None, "currency": "USDT", "updated": None,
                      "status": "not_connected", "positions": None, "fills_total": None,
                      "fees_total": None, "funding_total": None}
    names = [bot["name"] for bot in config["bots"]]
    expected_data = {"schema_version": 1, "snapshot_id": BOOTSTRAP_PLACEHOLDER,
                     "source": "own-okx-readonly", "generated_at": None, "updated": None,
                     "status": "pending", "traders": {name: pending_trader for name in names}, "trades": []}
    expected_history = {"snapshot_id": BOOTSTRAP_PLACEHOLDER, "series": {name: [] for name in names}}
    if canonical(data) != canonical(expected_data) or canonical(history) != canonical(expected_history):
        raise collector.SnapshotError("invalid_bootstrap_source")
    return collector.new_state(config, opaque=True)


def export(config, output, checkpoint, state_dir, *, bootstrap=False, environment=None,
           client_factory=None, now=None):
    environment = os.environ if environment is None else environment
    key = state_key(environment)
    output, checkpoint, state_dir = validate_paths(output, checkpoint, state_dir)
    with collector.state_lock(state_dir):
        state = load_or_bootstrap(checkpoint, output, config, key, bootstrap)
        data, history, next_state = collector.collect(config, state, client_factory=client_factory,
                                                      environment=environment, now=now, identity_key=key)
        document = seal(next_state, config, data["snapshot_id"], key)
        collector.atomic_json(state_dir / "state.json", next_state)
        collector.atomic_json(output / "history.json", history)
        collector.atomic_json(output / "data.json", data)
        collector.atomic_json(checkpoint, document)
        return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--bootstrap", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = collector.parse_config(json.loads(args.config.read_text(encoding="utf-8-sig")))
        data = export(config, args.output, args.checkpoint, args.state_dir, bootstrap=args.bootstrap)
        print(json.dumps({"snapshot_id": data["snapshot_id"], "status": data["status"],
                          "bots": {name: {"status": item["status"], "error_code": item["error_code"]}
                                   for name, item in data["traders"].items()}}, ensure_ascii=True))
        return 0
    except collector.SnapshotError as exc:
        print(json.dumps({"status": "error", "error_code": str(exc)}))
        return 2
    except Exception:
        print('{"status":"error","error_code":"checkpoint_export_failed"}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
