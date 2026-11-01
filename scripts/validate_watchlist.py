#!/usr/bin/env python3
"""Validate public watchlist data offline without echoing its contents.

Run ``python -B scripts/validate_watchlist.py [watchlist.json]`` before submitting
observations. Outcomes are supplied by the caller; this tool never fetches prices.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import re

try:
    from .validate_notes import (DIRECTIONS, LONG_TOKEN, MAX_BYTES, MAX_INSTRUMENT,
                                 MAX_TIMESTAMP, TRADERS, finite_number, suspicious_text)
except ImportError:  # Direct CLI execution has scripts/ on the module path.
    from validate_notes import (DIRECTIONS, LONG_TOKEN, MAX_BYTES, MAX_INSTRUMENT,
                                MAX_TIMESTAMP, TRADERS, finite_number, suspicious_text)


MAX_ITEMS = 1000
MAX_ID = 80
MAX_SUMMARY = 60
MAX_DETAIL = 1500
MAX_REVIEW = 300
ITEM_FIELDS = frozenset({"id", "trader", "instrument", "direction", "summary", "detail",
                         "confidence", "created_ts", "expires_ts", "ref_price", "outcome"})
DETAIL_FIELDS = frozenset({"reason", "plan", "invalidation"})
OUTCOME_FIELDS = frozenset({"price_at_expiry", "change_pct", "verdict", "review"})
STATUSES = frozenset({"active", "expired"})
VERDICTS = frozenset({"hit", "miss", "unclear"})
DATED_ID = re.compile(r"[AB]-([0-9]{8})-([0-9]{4})-[A-Za-z0-9-]+", re.ASCII)


class WatchlistError(Exception):
    """Only fixed error codes, never public data, cross the CLI boundary."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def suspicious_id(value):
    if not suspicious_text(value):
        return False
    match = DATED_ID.fullmatch(value)
    if match is None or LONG_TOKEN.search(value):
        return True
    # The public example ID contains a calendar date. Exempt only that date
    # segment from the generic long-number rule; retain every other safety rule.
    try:
        datetime.strptime(match[1] + match[2], "%Y%m%d%H%M")
    except ValueError:
        return True
    without_date = value[:match.start(1)] + "DATE" + value[match.end(1):]
    return suspicious_text(without_date)


def text_value(value, *, maximum, blank=True):
    if not isinstance(value, str) or (not blank and not value.strip()):
        raise WatchlistError("invalid_text")
    if len(value) > maximum:
        raise WatchlistError("text_too_long")
    return value


def symbol_value(value, *, maximum, code):
    if (not isinstance(value, str) or not value or len(value) > maximum
            or any(char.isspace() for char in value)):
        raise WatchlistError(code)
    return value


def timestamp_value(value):
    if not finite_number(value) or not 0 < value <= MAX_TIMESTAMP:
        raise WatchlistError("invalid_timestamp")
    return value


def validate_item(item):
    if (not isinstance(item, dict)
            or set(item) not in (ITEM_FIELDS, ITEM_FIELDS | {"status"})):
        raise WatchlistError("invalid_item")
    identity = symbol_value(item["id"], maximum=MAX_ID, code="invalid_id")
    instrument = symbol_value(item["instrument"], maximum=MAX_INSTRUMENT, code="invalid_instrument")
    if not isinstance(item["trader"], str) or item["trader"] not in TRADERS:
        raise WatchlistError("invalid_trader")
    if not isinstance(item["direction"], str) or item["direction"] not in DIRECTIONS:
        raise WatchlistError("invalid_direction")
    if "status" in item and (not isinstance(item["status"], str) or item["status"] not in STATUSES):
        raise WatchlistError("invalid_status")
    confidence = item["confidence"]
    if not finite_number(confidence) or not 0 <= confidence <= 100:
        raise WatchlistError("invalid_confidence")
    created = timestamp_value(item["created_ts"])
    if timestamp_value(item["expires_ts"]) <= created:
        raise WatchlistError("invalid_timestamp")
    if not finite_number(item["ref_price"]) or item["ref_price"] <= 0:
        raise WatchlistError("invalid_number")

    texts = [text_value(item["summary"], maximum=MAX_SUMMARY, blank=False)]
    detail = item["detail"]
    if not isinstance(detail, dict) or set(detail) != DETAIL_FIELDS:
        raise WatchlistError("invalid_detail")
    texts.extend(text_value(detail[field], maximum=MAX_DETAIL) for field in sorted(DETAIL_FIELDS))
    outcome = item["outcome"]
    if outcome is not None:
        if not isinstance(outcome, dict) or set(outcome) != OUTCOME_FIELDS:
            raise WatchlistError("invalid_outcome")
        if not finite_number(outcome["price_at_expiry"]) or outcome["price_at_expiry"] <= 0:
            raise WatchlistError("invalid_number")
        if not finite_number(outcome["change_pct"]):
            raise WatchlistError("invalid_number")
        if not isinstance(outcome["verdict"], str) or outcome["verdict"] not in VERDICTS:
            raise WatchlistError("invalid_verdict")
        texts.append(text_value(outcome["review"], maximum=MAX_REVIEW))
    if (suspicious_id(identity) or suspicious_text(instrument)
            or any(suspicious_text(value) for value in texts)
            or suspicious_text("\n".join(texts))):
        raise WatchlistError("unsafe_watchlist")
    return item


def validate_document(document):
    if not isinstance(document, dict) or set(document) != {"version", "items"}:
        raise WatchlistError("invalid_document")
    if type(document["version"]) not in (int, float) or document["version"] != 1:
        raise WatchlistError("invalid_version")
    items = document["items"]
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise WatchlistError("invalid_items")
    validated = [validate_item(item) for item in items]
    if len({item["id"] for item in validated}) != len(validated):
        raise WatchlistError("duplicate_id")
    return validated


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise WatchlistError("invalid_json")
        result[key] = value
    return result


def invalid_constant(_value):
    raise WatchlistError("invalid_json")


def load_watchlist(path):
    try:
        with Path(path).open("rb") as stream:
            data = stream.read(MAX_BYTES + 1)
    except (OSError, ValueError, UnicodeError):
        raise WatchlistError("unreadable_file") from None
    if len(data) > MAX_BYTES:
        raise WatchlistError("file_too_large")
    try:
        document = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                              parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise WatchlistError("invalid_json") from None
    return validate_document(document)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="watchlist.json")
    arguments = parser.parse_args(argv)
    try:
        items = load_watchlist(arguments.path)
    except WatchlistError as exc:
        print(json.dumps({"status": "error", "error_code": exc.code}, separators=(",", ":")))
        return 1
    print(json.dumps({"status": "ok", "items": len(items)}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
