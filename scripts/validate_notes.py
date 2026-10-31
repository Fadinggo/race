#!/usr/bin/env python3
"""Validate public trader notes without echoing their contents.

Run ``python -B scripts/validate_notes.py [notes.json]`` before submitting notes.
Validation is offline; this tool never reads credentials or contacts a service.
"""

from __future__ import annotations

import argparse
from datetime import date
import json
import math
from pathlib import Path
import re
import unicodedata


MAX_BYTES = 1024 * 1024
MAX_NOTES = 1000
MAX_TEXT = 1500
MAX_TIMESTAMP = 253402300799
MAX_TRADES = 100
MAX_INSTRUMENT = 64
MAX_CONFIDENCE = 80
TRADERS = frozenset({"Grok-Trader-A", "Grok-Trader-B"})
KINDS = frozenset({"open", "close", "daily", "daily_settlement"})
DIRECTIONS = frozenset({"long", "short"})
DAILY_TEXT = ("market_recap", "trade_review", "watch_next", "strategy_adjustments")
REASON_FIELDS = ("funding_rate", "open_interest", "key_levels", "volume", "events")
VARIANCE_FIELDS = ("right", "wrong", "lesson")
POSITION_FIELDS = frozenset({
    "instrument", "direction", "leverage", "entry_price", "stop_loss", "take_profit",
    "max_loss_usdt", "reasons", "confidence", "invalidation",
})
OPEN_FIELDS = frozenset({"trader", "ts", "kind", *POSITION_FIELDS})
CLOSE_FIELDS = frozenset({"trader", "ts", "kind", "review", "realized_pnl_usdt", "variance"})
DAILY_FIELDS = frozenset({"trader", "ts", "kind", *DAILY_TEXT})
# Narrative notes that use an unknown kind are still compared with the daily
# shape first, so a bad kind with the public daily keys reports invalid_kind.
TEXT_FIELDS = DAILY_TEXT
NOTE_FIELDS = DAILY_FIELDS
SETTLEMENT_FIELDS = frozenset({"trader", "ts", "kind", "date", "trades", "table"})
SETTLEMENT_NUMBERS = frozenset({"realized_pnl", "unrealized_pnl", "fees", "funding",
                                "api_cost_total", "net_after_costs"})
SETTLEMENT_TABLE_FIELDS = SETTLEMENT_NUMBERS | {"api_cost_by_model"}
TRADE_FIELDS = frozenset({"instrument", "direction", "pnl"})
MAX_MODELS = 50
MAX_MODEL_NAME = 80
LABEL = re.compile(
    r"(?:\b(?:api[ _-]?key|secret(?:[ _-]?key)?|(?:access[ _-]?)?token|uid|passphrase)\b|金鑰|私鑰)"
    r"\s*[:=]\s*\S", re.IGNORECASE | re.ASCII)
PREFIX = re.compile(
    r"(?:\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+\S+|-----BEGIN)",
    re.IGNORECASE | re.ASCII)
LONG_TOKEN = re.compile(r"[A-Za-z0-9_+/=-]{32,}")
LONG_NUMBER = re.compile(r"[0-9]{8,}")
OPENAI_MODEL = re.compile(r"(?:gpt|chatgpt|o[1-9]|text-embedding|whisper|tts|dall-e)(?:[-.][A-Za-z0-9]{1,16})+", re.ASCII)


class NotesError(Exception):
    """Only fixed error codes, never user text, may cross the CLI boundary."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def suspicious_text(text):
    """Conservatively withhold a whole note if any text resembles a secret."""
    if any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} and char not in "\n\r\t" for char in text):
        return True
    normalized = unicodedata.normalize("NFKC", text)
    return any(pattern.search(normalized) for pattern in (LABEL, PREFIX, LONG_TOKEN, LONG_NUMBER))


def suspicious_model_name(name):
    normalized = unicodedata.normalize("NFKC", name)
    if len(normalized) > MAX_MODEL_NAME or not OPENAI_MODEL.fullmatch(normalized):
        return suspicious_text(name)
    # Dated/segmented OpenAI model IDs can exceed the generic token length.
    # They are exempt only from that rule, never credential or control checks.
    if any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} and char not in "\n\r\t" for char in name):
        return True
    return any(pattern.search(normalized) for pattern in (LABEL, PREFIX, LONG_NUMBER))


def finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def nullable_number(value):
    if value is None:
        return True
    return finite_number(value)


def require_text(value):
    if not isinstance(value, str):
        raise NotesError("invalid_text")
    if not value.strip():
        raise NotesError("invalid_text")
    return value


def require_symbol(value):
    text = require_text(value)
    if text != value or len(text) > MAX_INSTRUMENT or any(char.isspace() for char in text):
        raise NotesError("invalid_text")
    return text


def validate_position_content(source):
    require_symbol(source["instrument"])
    if source["direction"] not in DIRECTIONS:
        raise NotesError("invalid_direction")
    for field in ("leverage", "entry_price", "stop_loss", "take_profit"):
        if not finite_number(source[field]) or source[field] <= 0:
            raise NotesError("invalid_number")
    if not finite_number(source["max_loss_usdt"]) or source["max_loss_usdt"] < 0:
        raise NotesError("invalid_number")
    reasons = source["reasons"]
    if not isinstance(reasons, dict) or set(reasons) != set(REASON_FIELDS):
        raise NotesError("invalid_reasons")
    for field in REASON_FIELDS:
        require_text(reasons[field])
    confidence = require_text(source["confidence"])
    if len(confidence) > MAX_CONFIDENCE:
        raise NotesError("invalid_text")
    require_text(source["invalidation"])


def position_strings(source):
    return [
        source["instrument"], source["confidence"], source["invalidation"],
        *(source["reasons"][field] for field in REASON_FIELDS),
    ]


def note_strings(note):
    if note["kind"] == "daily":
        return [note[field] for field in DAILY_TEXT]
    if note["kind"] == "open":
        return position_strings(note)
    if note["kind"] == "close":
        return position_strings(note["review"]) + [note["variance"][field] for field in VARIANCE_FIELDS]
    return []


def enforce_text_limit(values):
    if sum(len(value) for value in values) > MAX_TEXT:
        raise NotesError("text_too_long")
    if any(suspicious_text(value) for value in values) or suspicious_text("".join(values)):
        raise NotesError("unsafe_note")


def validate_settlement_table(table, *, cumulative=False):
    expected = SETTLEMENT_TABLE_FIELDS if cumulative else SETTLEMENT_TABLE_FIELDS | {"cum"}
    if not isinstance(table, dict) or set(table) != expected:
        raise NotesError("invalid_settlement_table")
    if any(not nullable_number(table[field]) for field in SETTLEMENT_NUMBERS):
        raise NotesError("invalid_settlement_number")
    if table["api_cost_total"] is not None and table["api_cost_total"] < 0:
        raise NotesError("invalid_api_cost")
    models = table["api_cost_by_model"]
    if not isinstance(models, dict) or len(models) > MAX_MODELS:
        raise NotesError("invalid_api_models")
    for model, amount in models.items():
        if not isinstance(model, str) or not model or model != model.strip() or len(model) > MAX_MODEL_NAME:
            raise NotesError("invalid_api_model")
        if not nullable_number(amount):
            raise NotesError("invalid_settlement_number")
        if amount is not None and amount < 0:
            raise NotesError("invalid_api_cost")
        if suspicious_model_name(model):
            raise NotesError("unsafe_note")
    if not cumulative:
        validate_settlement_table(table["cum"], cumulative=True)
    return table


def validate_trades(trades):
    if not isinstance(trades, list) or len(trades) > MAX_TRADES:
        raise NotesError("invalid_trades")
    texts = []
    for trade in trades:
        if not isinstance(trade, dict) or set(trade) != TRADE_FIELDS:
            raise NotesError("invalid_trade")
        try:
            texts.append(require_symbol(trade["instrument"]))
        except NotesError as exc:
            if exc.code != "invalid_text":
                raise
            raise NotesError("invalid_trade") from None
        if trade["direction"] not in DIRECTIONS:
            raise NotesError("invalid_trade")
        if not finite_number(trade["pnl"]):
            raise NotesError("invalid_trade")
    if any(suspicious_text(text) for text in texts) or suspicious_text("".join(texts)):
        raise NotesError("unsafe_note")
    return trades


def validate_settlement_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise NotesError("invalid_settlement_date")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise NotesError("invalid_settlement_date") from None


def validate_close(note):
    review = note["review"]
    if not isinstance(review, dict) or set(review) != POSITION_FIELDS:
        raise NotesError("invalid_review")
    validate_position_content(review)
    if not finite_number(note["realized_pnl_usdt"]):
        raise NotesError("invalid_number")
    variance = note["variance"]
    if not isinstance(variance, dict) or set(variance) != set(VARIANCE_FIELDS):
        raise NotesError("invalid_variance")
    for field in VARIANCE_FIELDS:
        require_text(variance[field])
    enforce_text_limit(note_strings(note))


def validate_note(note):
    if not isinstance(note, dict):
        raise NotesError("invalid_note")
    kind = note.get("kind")
    if kind == "daily_settlement":
        expected = SETTLEMENT_FIELDS
    elif kind == "open":
        expected = OPEN_FIELDS
    elif kind == "close":
        expected = CLOSE_FIELDS
    else:
        expected = DAILY_FIELDS
    if set(note) != expected:
        raise NotesError("invalid_note")
    if not isinstance(note["trader"], str) or note["trader"] not in TRADERS:
        raise NotesError("invalid_trader")
    stamp = note["ts"]
    if type(stamp) not in (int, float) or not 0 < stamp <= MAX_TIMESTAMP or not math.isfinite(stamp):
        raise NotesError("invalid_timestamp")
    if not isinstance(note["kind"], str) or note["kind"] not in KINDS:
        raise NotesError("invalid_kind")
    if note["kind"] == "daily_settlement":
        validate_settlement_date(note["date"])
        validate_settlement_table(note["table"])
        validate_trades(note["trades"])
        return note
    if note["kind"] == "open":
        validate_position_content(note)
        enforce_text_limit(note_strings(note))
        return note
    if note["kind"] == "close":
        validate_close(note)
        return note
    if any(not isinstance(note[field], str) for field in DAILY_TEXT):
        raise NotesError("invalid_text")
    for field in DAILY_TEXT:
        require_text(note[field])
    enforce_text_limit(note_strings(note))
    return note


def validate_document(document):
    if not isinstance(document, dict) or set(document) != {"version", "notes"}:
        raise NotesError("invalid_document")
    if type(document["version"]) not in (int, float) or document["version"] != 1:
        raise NotesError("invalid_version")
    notes = document["notes"]
    if not isinstance(notes, list) or len(notes) > MAX_NOTES:
        raise NotesError("invalid_notes")
    validated = [validate_note(note) for note in notes]
    settlements = set()
    for note in validated:
        if note["kind"] == "daily_settlement":
            identity = (note["trader"], note["date"])
            if identity in settlements:
                raise NotesError("duplicate_settlement")
            settlements.add(identity)
    return validated


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise NotesError("invalid_json")
        result[key] = value
    return result


def invalid_constant(_value):
    raise NotesError("invalid_json")


def load_notes(path):
    try:
        with Path(path).open("rb") as stream:
            data = stream.read(MAX_BYTES + 1)
    except (OSError, ValueError, UnicodeError):
        raise NotesError("unreadable_file") from None
    if len(data) > MAX_BYTES:
        raise NotesError("file_too_large")
    try:
        document = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise NotesError("invalid_json") from None
    return validate_document(document)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="notes.json")
    arguments = parser.parse_args(argv)
    try:
        notes = load_notes(arguments.path)
    except NotesError as exc:
        print(json.dumps({"status": "error", "error_code": exc.code}, separators=(",", ":")))
        return 1
    print(json.dumps({"status": "ok", "notes": len(notes)}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
