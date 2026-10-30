#!/usr/bin/env python3
"""Export two independent OKX accounts using read-only, fixed-host GET requests.

Example config (no secrets):
{"bots": [{"name": "交易員1", "env_prefix": "OKX_A", "start": null},
          {"name": "交易員2", "env": {"api_key": "OKX_API_KEY",
           "secret_key": "OKX_SECRET_KEY", "passphrase": "OKX_PASSPHRASE"}}]}

Only environment variables contain credentials. State belongs outside the public
checkout. Never bootstrap state from the website's data.json or history.json.
This module never trades, creates credentials, pushes Git, or schedules work.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid


ORIGIN = "https://www.okx.com"
ALLOWED_GET = {
    "/api/v5/account/config": frozenset(),
    "/api/v5/account/balance": frozenset({"ccy"}),
    "/api/v5/account/positions": frozenset(),
    "/api/v5/trade/fills": frozenset({"limit", "after"}),
    "/api/v5/trade/fills-history": frozenset({"instType", "limit", "after"}),
    "/api/v5/account/bills-archive": frozenset({"type", "limit", "after", "begin", "end"}),
}
STATE_FORMAT = "race-okx-owned-state-v1"
OPAQUE_STATE_FORMAT = "race-okx-opaque-state-v1"
WINDOW_SECONDS = 3 * 24 * 60 * 60
# Both history endpoints retain three calendar months. Use a conservative bound.
HISTORY_SECONDS = 89 * 24 * 60 * 60
TOTAL_STREAMS = ("SPOT", "MARGIN", "SWAP", "FUTURES", "OPTION", "funding")
TOTAL_FIELDS = frozenset({"totals_since", "totals_updated", "totals_status",
                          "fills_total_partial", "fees_total_partial", "funding_total_partial"})
TAIPEI = timezone(timedelta(hours=8))
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
SAFE_ID = re.compile(r"[A-Za-z0-9._-]{1,96}\Z")
CCY = re.compile(r"[A-Za-z0-9]{1,24}\Z")


class SnapshotError(Exception):
    """Only constant error codes may cross the logging/public boundary."""


def opaque_identifier(key, domain, value):
    """Keyed, domain-separated IDs; raw account/fill IDs never enter public state."""
    message = b"race-okx-id/v1\0" + domain.encode("utf-8") + b"\0" + value.encode("utf-8")
    return hmac.new(key, message, hashlib.sha256).hexdigest()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SnapshotError("redirect_blocked")


def number(value, *, required=False):
    if value is None or value == "":
        if required:
            raise SnapshotError("invalid_numeric_data")
        return None
    if isinstance(value, bool):
        raise SnapshotError("invalid_numeric_data")
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError):
        raise SnapshotError("invalid_numeric_data") from None
    if not math.isfinite(result):
        raise SnapshotError("invalid_numeric_data")
    return result


def safe_text(value, pattern=SAFE_ID, *, optional=False):
    if optional and (value is None or value == ""):
        return None
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise SnapshotError("invalid_api_data")
    return value


def parse_config(raw):
    if not isinstance(raw, dict) or set(raw) - {"bots", "max_fill_pages", "max_history_points", "statistics_start"}:
        raise SnapshotError("invalid_config")
    bots = raw.get("bots")
    if not isinstance(bots, list) or len(bots) != 2:
        raise SnapshotError("exactly_two_bots_required")
    result = []
    for entry in bots:
        if not isinstance(entry, dict) or set(entry) - {"name", "env", "env_prefix", "start", "simulated"}:
            raise SnapshotError("invalid_bot_config")
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 64 or any(ord(c) < 32 for c in name):
            raise SnapshotError("invalid_bot_name")
        env = entry.get("env")
        if env is None:
            prefix = entry.get("env_prefix")
            if not isinstance(prefix, str) or not ENV_NAME.fullmatch(prefix):
                raise SnapshotError("invalid_env_mapping")
            env = {"api_key": prefix + "_API_KEY", "secret_key": prefix + "_SECRET_KEY",
                   "passphrase": prefix + "_PASSPHRASE"}
        if not isinstance(env, dict) or set(env) != {"api_key", "secret_key", "passphrase"}:
            raise SnapshotError("invalid_env_mapping")
        if any(not isinstance(v, str) or not ENV_NAME.fullmatch(v) for v in env.values()):
            raise SnapshotError("invalid_env_mapping")
        start = number(entry.get("start"))
        if start is not None and start < 0:
            raise SnapshotError("invalid_start")
        simulated = entry.get("simulated", False)
        if not isinstance(simulated, bool):
            raise SnapshotError("invalid_simulated_flag")
        result.append({"name": name, "env": dict(env), "start": start, "simulated": simulated})
    if len({b["name"] for b in result}) != 2:
        raise SnapshotError("duplicate_bot_names")
    limits = {}
    for key, default, minimum, maximum in [("max_fill_pages", 20, 1, 100),
                                           ("max_history_points", 50000, 2, 200000)]:
        value = raw.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise SnapshotError("invalid_config_limit")
        limits[key] = value
    since = number(raw.get("statistics_start"))
    if since is not None and since <= 0:
        raise SnapshotError("invalid_statistics_start")
    return {"bots": result, "statistics_start": since, **limits}


class OKXClient:
    def __init__(self, credentials, *, simulated=False, opener=None, clock=time.time):
        self.credentials = credentials
        self.simulated = simulated
        self.opener = opener or build_opener(NoRedirect())
        self.clock = clock

    def get(self, path, params=None):
        params = params or {}
        if path not in ALLOWED_GET or set(params) - ALLOWED_GET[path]:
            raise SnapshotError("endpoint_not_allowed")
        if any(not isinstance(v, (str, int)) or isinstance(v, bool) for v in params.values()):
            raise SnapshotError("invalid_query")
        query = urlencode(sorted(params.items()))
        request_path = path + ("?" + query if query else "")
        stamp = datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        secret = self.credentials["secret_key"].encode("utf-8")
        sign = base64.b64encode(hmac.new(secret, (stamp + "GET" + request_path).encode("utf-8"), hashlib.sha256).digest()).decode("ascii")
        headers = {"OK-ACCESS-KEY": self.credentials["api_key"], "OK-ACCESS-SIGN": sign,
                   "OK-ACCESS-TIMESTAMP": stamp, "OK-ACCESS-PASSPHRASE": self.credentials["passphrase"],
                   "Content-Type": "application/json",
                   "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"}
        if self.simulated:
            headers["x-simulated-trading"] = "1"
        request = Request(ORIGIN + request_path, headers=headers, method="GET")
        try:
            with self.opener.open(request, timeout=15) as response:
                body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise SnapshotError("response_too_large")
            payload = json.loads(body)
        except HTTPError as exc:
            raise SnapshotError("http_" + str(exc.code)) from None
        except (URLError, TimeoutError, OSError):
            raise SnapshotError("network_error") from None
        except (ValueError, UnicodeError):
            raise SnapshotError("invalid_response") from None
        if not isinstance(payload, dict):
            raise SnapshotError("invalid_response")
        if str(payload.get("code")) != "0":
            code = str(payload.get("code", ""))
            raise SnapshotError("api_" + code if re.fullmatch(r"[0-9]{1,10}", code) else "api_error")
        data = payload.get("data")
        if not isinstance(data, list) or any(not isinstance(row, dict) for row in data):
            raise SnapshotError("invalid_response")
        return data


def make_client(bot, environment):
    credentials = {key: environment.get(env_name, "") for key, env_name in bot["env"].items()}
    if any(not isinstance(v, str) or not v.strip() for v in credentials.values()):
        raise SnapshotError("credentials_missing")
    return OKXClient(credentials, simulated=bot["simulated"])


def account_uid(client):
    rows = client.get("/api/v5/account/config")
    if len(rows) != 1:
        raise SnapshotError("identity_unverified")
    uid = rows[0].get("uid")
    if not isinstance(uid, str) or not re.fullmatch(r"[0-9]{1,64}", uid):
        raise SnapshotError("identity_unverified")
    return uid


def usdt_equity(client):
    rows = client.get("/api/v5/account/balance", {"ccy": "USDT"})
    # A successful API response can omit all nonzero assets in an empty account.
    if not rows:
        return 0.0
    if len(rows) != 1 or not isinstance(rows[0].get("details"), list):
        raise SnapshotError("invalid_balance")
    details = rows[0]["details"]
    if any(not isinstance(row, dict) for row in details):
        raise SnapshotError("invalid_balance")
    matching = [row for row in details if row.get("ccy") == "USDT"]
    if not matching:
        if not details:
            return 0.0
        raise SnapshotError("usdt_equity_missing")
    if len(matching) != 1:
        raise SnapshotError("invalid_balance")
    return number(matching[0].get("eq"), required=True)


def positions(client):
    result = []
    for row in client.get("/api/v5/account/positions"):
        size = number(row.get("pos"), required=True)
        if size == 0:
            continue
        inst = safe_text(row.get("instId"))
        kind = row.get("instType")
        contract = kind in {"SWAP", "FUTURES", "OPTION"}
        side = row.get("posSide")
        if side == "net" and contract:
            side = "long" if size > 0 else "short"
        elif side == "net" and kind == "MARGIN":
            pair = inst.split("-")
            side = "long" if row.get("posCcy") == pair[0] else "short" if len(pair) > 1 and row.get("posCcy") == pair[1] else "net"
        if side not in {"long", "short", "net"}:
            raise SnapshotError("invalid_position_side")
        currency = safe_text(row.get("ccy"), CCY, optional=True)
        unit = "張" if contract else safe_text(row.get("posCcy"), CCY, optional=True)
        result.append({"inst": inst, "side": side, "sz": abs(size), "avgPx": number(row.get("avgPx")),
                       "upl": number(row.get("upl")), "upl_ccy": currency, "qty_unit": unit})
    return sorted(result, key=lambda row: (row["inst"], row["side"]))


SIDES = {"1": "買入", "2": "賣出", "3": "開多", "4": "開空", "5": "平多", "6": "平空",
         "100": "部分強平多", "101": "部分強平空", "104": "強平多", "105": "強平空",
         "125": "減倉平多", "126": "減倉平空"}


def normalize_fill(row, name):
    bill_id = safe_text(row.get("billId"))
    stamp = number(row.get("fillTime") or row.get("ts"), required=True)
    if stamp <= 0:
        raise SnapshotError("invalid_fill_time")
    try:
        display_time = datetime.fromtimestamp(stamp / 1000, TAIPEI).strftime("%Y-%m-%d %H:%M:%S")
    except (OverflowError, OSError, ValueError):
        raise SnapshotError("invalid_fill_time") from None
    inst = safe_text(row.get("instId"))
    size = number(row.get("fillSz"), required=True)
    if size < 0:
        raise SnapshotError("invalid_fill_size")
    unit = "張" if row.get("instType") in {"SWAP", "FUTURES", "OPTION"} else inst.split("-")[0]
    fee = number(row.get("fee"))
    fee_ccy = safe_text(row.get("feeCcy"), CCY, optional=True)
    pnl_ccy = fee_ccy if row.get("instType") in {"SWAP", "FUTURES", "OPTION"} else None
    note = "手續費未知" if fee is None or fee_ccy is None else f"手續費 {fee:g} {fee_ccy}"
    public = {"trader": name, "time": display_time, "ts": int(stamp), "market": inst,
              "side": SIDES.get(str(row.get("subType")), "其他"), "price": number(row.get("fillPx")),
              "qty": f"{size:g} {unit}", "pnl": number(row.get("fillPnl")),
              "pnl_ccy": pnl_ccy, "fee": fee, "feeCcy": fee_ccy, "note": note}
    return bill_id, public


def recent_fills(client, name, now, previous, max_pages, identity_key=None):
    cutoff_ms = int((now - WINDOW_SECONDS) * 1000)
    fills = {key: value for key, value in previous.items() if value["ts"] >= cutoff_ms}
    seen_cursors = set()
    params = {"limit": "100"}
    complete = False
    for _ in range(max_pages):
        rows = client.get("/api/v5/trade/fills", params)
        for row in rows:
            bill_id, public = normalize_fill(row, name)
            if public["ts"] >= cutoff_ms:
                stored_id = opaque_identifier(identity_key, "fill:" + name, bill_id) if identity_key is not None else bill_id
                fills[stored_id] = public
        if len(rows) < 100:
            complete = True
            break
        cursor = safe_text(rows[-1].get("billId"))
        if cursor in seen_cursors:
            break
        seen_cursors.add(cursor)
        params = {"limit": "100", "after": cursor}
    return fills, not complete


def decimal_amount(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise SnapshotError("invalid_numeric_data")
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        raise SnapshotError("invalid_numeric_data") from None
    if not amount.is_finite():
        raise SnapshotError("invalid_numeric_data")
    return str(amount)


def total_event(row, stream):
    identity = safe_text(row.get("billId"))
    stamp = number(row.get("ts") if stream == "funding" else row.get("fillTime") or row.get("ts"), required=True)
    if stamp <= 0 or not stamp.is_integer():
        raise SnapshotError("invalid_total_time")
    if stream == "funding":
        if str(row.get("type")) != "8":
            raise SnapshotError("invalid_funding_bill")
        amount, currency = row.get("balChg"), row.get("ccy")
    else:
        if row.get("instType") != stream:
            raise SnapshotError("invalid_fill_type")
        amount, currency = row.get("fee"), row.get("feeCcy")
    return identity, {"ts": int(stamp), "amount": decimal_amount(amount),
                      "ccy": safe_text(currency, CCY, optional=True)}


def update_totals(client, name, now, previous, since, max_pages, identity_key=None):
    """Keep an independent lifetime ledger, never the rolling display cache.

    A watermark advances only after a complete scan. Replays overlap one day to
    pick up delayed records. A retention gap stays partial permanently; a capped
    or failed scan can heal by retrying the same interval. No raw cursor is saved.
    """
    if previous is not None and previous["since"] != since:
        raise SnapshotError("statistics_start_changed")
    totals = copy.deepcopy(previous) if previous is not None else {"since": since, "streams": {}}
    if since is None:
        return totals
    if since > now:
        raise SnapshotError("statistics_start_in_future")
    for stream in TOTAL_STREAMS:
        stored = totals["streams"].setdefault(stream, {"through": None, "gap": False,
                                                    "partial": True, "events": {}})
        begin = max(since, stored["through"] - 86400 if stored["through"] is not None else since)
        if begin < now - HISTORY_SECONDS:
            stored["gap"] = True
            begin = now - HISTORY_SECONDS
        params = {"limit": "100"}
        if stream == "funding":
            path = "/api/v5/account/bills-archive"
            params.update(type="8", begin=str(int(begin * 1000)), end=str(int(now * 1000)))
        else:
            path = "/api/v5/trade/fills-history"
            params["instType"] = stream
        cursors, complete = set(), False
        try:
            for _ in range(max_pages):
                rows = client.get(path, params)
                # Validate a whole page before committing any of it.
                events = [total_event(row, stream) for row in rows]
                for identity, event in events:
                    if int(since * 1000) <= event["ts"] <= int(now * 1000):
                        key = opaque_identifier(identity_key, "total:" + stream + ":" + name, identity) if identity_key is not None else identity
                        if key in stored["events"]:
                            old = stored["events"][key]
                            if old["ts"] != event["ts"]:
                                raise SnapshotError("total_event_changed")
                            for field in ("amount", "ccy"):
                                before, after = old[field], event[field]
                                if before is not None and after is not None and (
                                        Decimal(before) != Decimal(after) if field == "amount" else before != after):
                                    raise SnapshotError("total_event_changed")
                                # Later responses can enrich an unknown amount
                                # or currency, but cannot erase known values.
                                if before is not None:
                                    event[field] = before
                        stored["events"][key] = event
                # OKX paginates backwards by billId. A fully older page crosses
                # the requested overlap interval, even for a busy account.
                if len(rows) < 100 or all(event["ts"] < begin * 1000 for _, event in events):
                    complete = True
                    break
                cursor = safe_text(rows[-1].get("billId"))
                if cursor in cursors:
                    break
                cursors.add(cursor)
                params = {**params, "after": cursor}
        except Exception:
            # Totals failures must not hide otherwise valid equity/positions.
            # Partial records are retained for dedup, without advancing coverage.
            complete = False
        stored["partial"] = not complete or stored["gap"]
        if complete:
            stored["through"] = now
    return totals


def totals_public(totals, now):
    streams = totals["streams"]
    fills = [streams[s] for s in TOTAL_STREAMS[:-1] if s in streams]
    funding = [streams["funding"]] if "funding" in streams else []
    fills_partial = len(fills) != 5 or any(s["partial"] for s in fills)
    funding_partial = not funding or funding[0]["partial"]
    fill_events = [event for source in fills for event in source["events"].values()]
    funding_events = [event for source in funding for event in source["events"].values()]

    def amount(events, partial):
        # USDT scalar totals cannot add other currencies or missing amounts.
        if any(e["amount"] is None or e["ccy"] != "USDT" for e in events):
            return None, True
        if partial and not events:
            return None, True
        return number(str(sum((Decimal(e["amount"]) for e in events), Decimal(0))), required=True), partial

    fees, fees_partial = amount(fill_events, fills_partial)
    funding_amount, funding_partial = amount(funding_events, funding_partial)
    complete = not (fills_partial or fees_partial or funding_partial)
    through = [s["through"] for s in streams.values()]
    return {"totals_since": totals["since"],
            "totals_updated": min(through) if len(through) == 6 and all(t is not None for t in through) else None,
            "totals_status": "complete" if complete else "partial",
            "fills_total": len(fill_events) if fill_events or not fills_partial else None,
            "fees_total": fees, "funding_total": funding_amount,
            "fills_total_partial": fills_partial, "fees_total_partial": fees_partial,
            "funding_total_partial": funding_partial}


def empty_trader(bot):
    return {"equity": None, "start": bot["start"], "currency": "USDT", "positions": None,
            "fees_total": None, "funding_total": None, "fills_total": None,
            "fills_recent": None, "fills_partial": None, "fills_window_start": None,
            "status": "error", "updated": None, "error_code": "not_connected",
            "totals_since": None, "totals_updated": None, "totals_status": "partial",
            "fills_total_partial": True, "fees_total_partial": True, "funding_total_partial": True}


def new_state(config, *, opaque=False):
    return {"format": OPAQUE_STATE_FORMAT if opaque else STATE_FORMAT, "bot_names": [b["name"] for b in config["bots"]],
            "modes": {b["name"]: b["simulated"] for b in config["bots"]}, "uids": {}, "bots": {}}


def validate_state(state, config, *, opaque=False):
    expected_format = OPAQUE_STATE_FORMAT if opaque else STATE_FORMAT
    if (not isinstance(state, dict) or state.get("format") != expected_format
            or state.get("bot_names") != [b["name"] for b in config["bots"]]
            or state.get("modes") != {b["name"]: b["simulated"] for b in config["bots"]}
            or not isinstance(state.get("uids"), dict) or not isinstance(state.get("bots"), dict)):
        raise SnapshotError("state_not_owned_or_wrong_bots")
    uids = state["uids"]
    if uids and (set(uids) != set(state["bot_names"]) or len(set(uids.values())) != 2):
        raise SnapshotError("invalid_identity_state")
    for uid in uids.values():
        pattern = r"[0-9a-f]{64}" if opaque else r"[0-9]{1,64}"
        if not isinstance(uid, str) or not re.fullmatch(pattern, uid):
            raise SnapshotError("invalid_identity_state")


def collect(config, state, *, client_factory=None, environment=None, now=None, snapshot_id=None, identity_key=None):
    """Return public data, public history, and private next state; no filesystem I/O."""
    validate_state(state, config, opaque=identity_key is not None)
    now = time.time() if now is None else now
    environment = os.environ if environment is None else environment
    factory = client_factory or (lambda bot: make_client(bot, environment))
    next_state = copy.deepcopy(state)
    clients, observed_uids, errors = {}, {}, {}
    for bot in config["bots"]:
        name = bot["name"]
        try:
            clients[name] = factory(bot)
            uid = account_uid(clients[name])
            observed_uids[name] = opaque_identifier(identity_key, "account", uid) if identity_key is not None else uid
        except SnapshotError as exc:
            errors[name] = str(exc)
        except Exception:
            errors[name] = "collection_error"
    if len(set(observed_uids.values())) != len(observed_uids):
        errors = {bot["name"]: "duplicate_accounts" for bot in config["bots"]}
    elif not state["uids"]:
        if len(observed_uids) == 2:
            next_state["uids"] = dict(observed_uids)
        else:
            for bot in config["bots"]:
                errors.setdefault(bot["name"], "identity_unverified")
    else:
        for name, uid in observed_uids.items():
            if state["uids"].get(name) != uid:
                errors[name] = "account_changed"

    traders, trades, series = {}, [], {}
    for bot in config["bots"]:
        name = bot["name"]
        old = next_state["bots"].get(name, {"public": empty_trader(bot), "fills": {}, "history": []})
        stored = copy.deepcopy(old)
        if name not in errors:
            try:
                equity = usdt_equity(clients[name])
                current_positions = positions(clients[name])
                fills, partial = recent_fills(clients[name], name, now, stored["fills"], config["max_fill_pages"], identity_key)
                public = empty_trader(bot)
                public.update(equity=equity, positions=current_positions, fills_recent=len(fills),
                              fills_partial=partial, fills_window_start=int(now - WINDOW_SECONDS),
                              status="ok", updated=now, error_code=None)
                totals = update_totals(clients[name], name, now, stored.get("totals"),
                                       config.get("statistics_start"), config["max_fill_pages"], identity_key)
                public.update(totals_public(totals, now))
                points = stored["history"]
                sample = [int(now * 1000), equity]
                if points and sample[0] == points[-1][0]:
                    points[-1] = sample
                elif not points or sample[0] > points[-1][0]:
                    points.append(sample)
                else:
                    raise SnapshotError("clock_moved_backwards")
                stored = {"public": public, "fills": fills, "history": points[-config["max_history_points"]:],
                          "totals": totals}
            except SnapshotError as exc:
                errors[name] = str(exc)
            except Exception:
                errors[name] = "collection_error"
        if name in errors:
            stored = copy.deepcopy(old)
            stored["public"].update(status="error", error_code=errors[name])
        for field in TOTAL_FIELDS:
            stored["public"].setdefault(field, empty_trader(bot)[field])
        stored["public"]["start"] = bot["start"]
        next_state["bots"][name] = stored
        traders[name] = copy.deepcopy(stored["public"])
        trades.extend(copy.deepcopy(list(stored["fills"].values())))
        series[name] = copy.deepcopy(stored["history"])
    identity = snapshot_id or uuid.uuid4().hex
    timestamps = [trader["updated"] for trader in traders.values()]
    success_count = sum(trader["status"] == "ok" for trader in traders.values())
    data = {"schema_version": 1, "snapshot_id": identity, "source": "own-okx-readonly",
            "generated_at": now, "updated": min(timestamps) if all(t is not None for t in timestamps) else None,
            "status": "ok" if success_count == 2 else "partial" if success_count else "error",
            "traders": traders, "trades": sorted(trades, key=lambda trade: (trade["ts"], trade["trader"]))}
    history = {"snapshot_id": identity, "series": series}
    return data, history, next_state


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def state_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    # Keep this inode/file permanently. Deleting an advisory-lock file could let
    # a new process lock a new inode while another still owns the old one.
    stream = (directory / "run.lock").open("a+b")
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
            raise SnapshotError("another_run_is_active") from None
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


def export(config, output, state_dir, *, client_factory=None, environment=None, now=None):
    output, state_dir = Path(output).resolve(), Path(state_dir).resolve()
    if state_dir == output or output in state_dir.parents:
        raise SnapshotError("private_state_inside_public_output")
    if any((parent / ".git").exists() for parent in (state_dir, *state_dir.parents)):
        raise SnapshotError("private_state_inside_git_checkout")
    with state_lock(state_dir):
        state_path = state_dir / "state.json"
        try:
            state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else new_state(config)
        except (ValueError, UnicodeError, OSError):
            raise SnapshotError("invalid_state_file") from None
        data, history, next_state = collect(config, state, client_factory=client_factory, environment=environment, now=now)
        atomic_json(state_path, next_state)
        # The reader rejects mismatched IDs during this unavoidable two-file transition.
        atomic_json(output / "history.json", history)
        atomic_json(output / "data.json", data)
        return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path.cwd() / "public-snapshot")
    parser.add_argument("--state-dir", type=Path)
    args = parser.parse_args(argv)
    try:
        config = parse_config(json.loads(args.config.read_text(encoding="utf-8-sig")))
        if args.state_dir is None:
            private_root = Path(os.environ["LOCALAPPDATA"]) if os.environ.get("LOCALAPPDATA") else Path.home() / ".local" / "state"
            args.state_dir = private_root / "race-dashboard" / "okx"
        data = export(config, args.output, args.state_dir)
        print(json.dumps({"snapshot_id": data["snapshot_id"], "status": data["status"],
                          "bots": {name: {"status": item["status"], "error_code": item["error_code"]}
                                   for name, item in data["traders"].items()}}, ensure_ascii=True))
        # A failure-state snapshot must still be published so visitors see the
        # failed refresh and the true last-success time. Nonzero means no commit.
        return 0
    except SnapshotError as exc:
        print(json.dumps({"status": "error", "error_code": str(exc)}))
        return 2
    except Exception:
        # Never print exception messages or tracebacks that could contain a request/secret.
        print('{"status":"error","error_code":"export_failed"}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
