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
MAX_TEXT = 300
MAX_TIMESTAMP = 253402300799
TRADERS = frozenset({"Grok-Trader-A", "Grok-Trader-B"})
KINDS = frozenset({"open", "close", "daily", "daily_settlement"})
TEXT_FIELDS = ("market_view", "current_approach", "plan")
NOTE_FIELDS = frozenset({"trader", "ts", "kind", *TEXT_FIELDS})
SETTLEMENT_FIELDS = frozenset({"trader", "ts", "kind", "date", "table"})
SETTLEMENT_NUMBERS = frozenset({"realized_pnl", "unrealized_pnl", "fees", "funding",
                                "api_cost_total", "net_after_costs"})
SETTLEMENT_TABLE_FIELDS = SETTLEMENT_NUMBERS | {"api_cost_by_model"}
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


def nullable_number(value):
    if value is None:
        return True
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


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


def validate_settlement_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise NotesError("invalid_settlement_date")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise NotesError("invalid_settlement_date") from None


def validate_note(note):
    if not isinstance(note, dict):
        raise NotesError("invalid_note")
    expected = SETTLEMENT_FIELDS if note.get("kind") == "daily_settlement" else NOTE_FIELDS
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
        return note
    if any(not isinstance(note[field], str) for field in TEXT_FIELDS):
        raise NotesError("invalid_text")
    if sum(len(note[field]) for field in TEXT_FIELDS) > MAX_TEXT:
        raise NotesError("text_too_long")
    # Check fields individually and together so splitting a label or token
    # between the three public fields cannot bypass the filter.
    if any(suspicious_text(note[field]) for field in TEXT_FIELDS) or suspicious_text("".join(note[field] for field in TEXT_FIELDS)):
        raise NotesError("unsafe_note")
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
