"""Lifetime accounting regressions, using fake OKX history only."""
import copy
import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location(
    "cumulative_collector", Path(__file__).parents[1] / "scripts" / "okx_snapshot.py")
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)

NOW = 1793388000.0
SINCE = NOW - 3600
KEY = bytes(range(32))  # Public, disposable test key.


def fill(identity="1001", when=NOW - 60, **changes):
    row = {"billId": identity, "fillTime": str(int(when * 1000)), "fee": "-0.01",
           "feeCcy": "USDT", "instId": "BTC-USDT-SWAP", "instType": "SWAP",
           "subType": "5", "fillSz": "1", "fillPx": "50000", "fillPnl": "0"}
    row.update(changes)
    return row


def funding(identity="2001", when=NOW - 60, amount="-0.02", **changes):
    row = {"billId": identity, "ts": str(int(when * 1000)), "type": "8",
           "balChg": amount, "ccy": "USDT", "fee": "99999"}
    row.update(changes)
    return row


class HistoryClient:
    def __init__(self, *, pages=None, failures=()):
        self.pages = pages or {}
        self.failures = set(failures)
        self.indices = {}
        self.calls = []

    def get(self, path, params=None):
        self.calls.append((path, copy.deepcopy(params)))
        stream = "funding" if path.endswith("/bills-archive") else params["instType"]
        if stream in self.failures:
            raise collector.SnapshotError("network_error")
        index = self.indices.get(stream, 0)
        self.indices[stream] = index + 1
        pages = self.pages.get(stream, [[]])
        return copy.deepcopy(pages[min(index, len(pages) - 1)])


def update(client, previous=None, *, now=NOW, since=SINCE, max_pages=20, key=None):
    return collector.update_totals(client, "Alpha", now, previous, since, max_pages, key)


class CumulativeTotalsTests(unittest.TestCase):
    def public(self, state, now=NOW):
        return collector.totals_public(state, now)

    def test_duplicate_records_and_replayed_scan_do_not_inflate_totals(self):
        rows = [fill(), fill(), fill("1002", fee="0.003")]
        first = update(HistoryClient(pages={"SWAP": [rows]}), key=KEY)
        first_before = copy.deepcopy(first)
        second = update(HistoryClient(pages={"SWAP": [rows]}), first, now=NOW + 300, key=KEY)
        self.assertEqual(first, first_before, "Updating must not mutate the previous checkpoint")
        public = self.public(second, NOW + 300)
        self.assertEqual(public["fills_total"], 2)
        self.assertEqual(public["fees_total"], -0.007)
        self.assertEqual(public["totals_status"], "complete")
        self.assertEqual(public["totals_since"], SINCE)
        self.assertEqual(public["totals_updated"], NOW + 300)
        ids = second["streams"]["SWAP"]["events"]
        self.assertTrue(all(len(identity) == 64 for identity in ids))
        self.assertNotIn("1001", ids)

    def test_signed_funding_uses_balance_change_and_only_funding_bills(self):
        state = update(HistoryClient(pages={"funding": [[
            funding("2001", amount="-0.5"), funding("2002", amount="0.25")]]}))
        public = self.public(state)
        self.assertEqual(public["funding_total"], -0.25)
        self.assertEqual(public["funding_total_partial"], False)
        invalid = update(HistoryClient(pages={"funding": [[funding(type="1")]]}))
        self.assertIsNone(self.public(invalid)["funding_total"])
        self.assertTrue(self.public(invalid)["funding_total_partial"])

    def test_mixed_currency_and_missing_fee_remain_unknown_without_losing_count(self):
        for changes in ({"feeCcy": "BTC"}, {"feeCcy": ""}, {"fee": None}, {"fee": ""}):
            with self.subTest(changes=changes):
                state = update(HistoryClient(pages={"SWAP": [[fill(**changes)]]}))
                public = self.public(state)
                self.assertEqual(public["fills_total"], 1)
                self.assertFalse(public["fills_total_partial"])
                self.assertIsNone(public["fees_total"])
                self.assertTrue(public["fees_total_partial"])
                self.assertEqual(public["funding_total"], 0)
                self.assertEqual(public["totals_status"], "partial")

    def test_funding_unknown_amount_or_currency_is_not_zero(self):
        for changes in ({"balChg": None}, {"ccy": None}, {"ccy": "BTC"}):
            with self.subTest(changes=changes):
                state = update(HistoryClient(pages={"funding": [[funding(**changes)]]}))
                public = self.public(state)
                self.assertIsNone(public["funding_total"])
                self.assertTrue(public["funding_total_partial"])

    def test_later_history_enriches_unknown_fields_and_does_not_erase_known_values(self):
        state = update(HistoryClient(pages={
            "SWAP": [[fill(fee=None, feeCcy=None)]],
            "funding": [[funding(balChg=None, ccy=None)]]}))
        self.assertIsNone(self.public(state)["fees_total"])
        self.assertIsNone(self.public(state)["funding_total"])
        state = update(HistoryClient(pages={
            "SWAP": [[fill(fee="-0.01", feeCcy=None)]],
            "funding": [[funding(balChg="0.02", ccy=None)]]}), state, now=NOW + 300)
        self.assertIsNone(self.public(state, NOW + 300)["fees_total"])
        self.assertIsNone(self.public(state, NOW + 300)["funding_total"])
        state = update(HistoryClient(pages={
            "SWAP": [[fill(fee=None, feeCcy="USDT")]],
            "funding": [[funding(balChg=None, ccy="USDT")]]}), state, now=NOW + 600)
        public = self.public(state, NOW + 600)
        self.assertEqual(public["fills_total"], 1)
        self.assertEqual(public["fees_total"], -0.01)
        self.assertEqual(public["funding_total"], 0.02)
        self.assertEqual(public["totals_status"], "complete")
        # A later endpoint omission cannot undo the completed enrichment.
        state = update(HistoryClient(pages={
            "SWAP": [[fill(fee=None, feeCcy=None)]],
            "funding": [[funding(balChg=None, ccy=None)]]}), state, now=NOW + 900)
        public = self.public(state, NOW + 900)
        self.assertEqual(public["fees_total"], -0.01)
        self.assertEqual(public["funding_total"], 0.02)
        self.assertEqual(public["totals_status"], "complete")

    def test_numerically_equal_decimal_formatting_does_not_invalidate_coverage(self):
        state = update(HistoryClient(pages={
            "SWAP": [[fill(fee="-0.0100")]],
            "funding": [[funding(balChg="0.0200")]]}))
        state = update(HistoryClient(pages={
            "SWAP": [[fill(fee="-1E-2")]],
            "funding": [[funding(balChg="0.02")]]}), state, now=NOW + 300)
        public = self.public(state, NOW + 300)
        self.assertEqual(public["fills_total"], 1)
        self.assertEqual(public["fees_total"], -0.01)
        self.assertEqual(public["funding_total"], 0.02)
        self.assertEqual(public["totals_status"], "complete")
        self.assertEqual(public["totals_updated"], NOW + 300)

    def test_conflicting_known_event_fields_preserve_prior_values_and_remain_partial(self):
        for changes in ({"fee": "-0.02"}, {"feeCcy": "BTC"},
                        {"fillTime": str(int((NOW - 30) * 1000))}):
            with self.subTest(changes=changes):
                first = update(HistoryClient(pages={"SWAP": [[fill()]]}))
                state = update(HistoryClient(pages={"SWAP": [[fill(**changes)]]}),
                               first, now=NOW + 300)
                public = self.public(state, NOW + 300)
                self.assertEqual(public["fills_total"], 1)
                self.assertEqual(public["fees_total"], -0.01)
                self.assertTrue(public["fills_total_partial"])
                self.assertTrue(public["fees_total_partial"])
                self.assertEqual(public["totals_status"], "partial")
                self.assertEqual(state["streams"]["SWAP"]["events"],
                                 first["streams"]["SWAP"]["events"])
                self.assertEqual(state["streams"]["SWAP"]["through"], NOW)

    def test_mixed_or_missing_instrument_type_rejects_entire_history_page(self):
        for instrument_type in ("SPOT", "MARGIN", None):
            with self.subTest(instrument_type=instrument_type):
                state = update(HistoryClient(pages={"SWAP": [[
                    fill("1001"), fill("1002", instType=instrument_type)]]}))
                public = self.public(state)
                self.assertIsNone(public["fills_total"])
                self.assertIsNone(public["fees_total"])
                self.assertTrue(public["fills_total_partial"])
                self.assertEqual(state["streams"]["SWAP"]["events"], {})
                self.assertIsNone(state["streams"]["SWAP"]["through"])

    def test_page_cap_and_repeated_cursor_remain_partial_and_resume_without_duplicates(self):
        first_page = [fill(str(1000 - index), when=NOW - index - 1) for index in range(100)]
        tail = [fill("800", when=NOW - 500)]
        for pages, limit in (([first_page, tail], 1), ([first_page, first_page], 3)):
            with self.subTest(limit=limit):
                client = HistoryClient(pages={"SWAP": pages})
                state = update(client, max_pages=limit)
                partial = self.public(state)
                self.assertEqual(partial["fills_total"], 100)
                self.assertTrue(partial["fills_total_partial"])
                self.assertIsNone(state["streams"]["SWAP"]["through"])
                retry = HistoryClient(pages={"SWAP": [first_page, tail]})
                resumed = update(retry, state, now=NOW + 300)
                public = self.public(resumed, NOW + 300)
                self.assertEqual(public["fills_total"], 101)
                self.assertFalse(public["fills_total_partial"])
                self.assertEqual(public["fees_total"], -1.01)
                swap_calls = [params for path, params in retry.calls
                              if path.endswith("/fills-history") and params["instType"] == "SWAP"]
                self.assertNotIn("after", swap_calls[0])
                self.assertEqual(swap_calls[1]["after"], first_page[-1]["billId"])

    def test_endpoint_failures_preserve_previous_known_totals_and_coverage(self):
        first = update(HistoryClient(pages={"SWAP": [[fill()]], "funding": [[funding()]]}))
        failed = update(HistoryClient(failures=collector.TOTAL_STREAMS), first, now=NOW + 300)
        public = self.public(failed, NOW + 300)
        self.assertEqual(public["fills_total"], 1)
        self.assertEqual(public["fees_total"], -0.01)
        self.assertEqual(public["funding_total"], -0.02)
        self.assertEqual(public["totals_updated"], NOW)
        self.assertEqual(public["totals_status"], "partial")
        for stream in collector.TOTAL_STREAMS:
            self.assertEqual(failed["streams"][stream]["events"], first["streams"][stream]["events"])
            self.assertEqual(failed["streams"][stream]["through"], NOW)

    def test_expired_history_gap_cannot_be_healed_by_later_empty_success(self):
        first = update(HistoryClient(pages={"SWAP": [[fill()]]}))
        late = NOW + 91 * 86400
        missing = update(HistoryClient(), first, now=late)
        replayed = update(HistoryClient(), missing, now=late + 300)
        public = self.public(replayed, late + 300)
        self.assertEqual(public["fills_total"], 1)
        self.assertTrue(public["fills_total_partial"])
        self.assertEqual(public["totals_status"], "partial")
        self.assertTrue(all(s["gap"] for s in replayed["streams"].values()))

    def test_changing_since_rejects_existing_accumulator_without_reset(self):
        first = update(HistoryClient(pages={"SWAP": [[fill()]]}))
        original = copy.deepcopy(first)
        with self.assertRaisesRegex(collector.SnapshotError, "statistics_start_changed"):
            update(HistoryClient(), first, since=SINCE + 1)
        self.assertEqual(first, original)

    def test_unconfigured_or_failed_initial_scan_is_unknown_but_complete_empty_scan_is_zero(self):
        unknown = self.public(update(HistoryClient(), since=None))
        failed = self.public(update(HistoryClient(failures=collector.TOTAL_STREAMS)))
        empty = self.public(update(HistoryClient()))
        for field in ("fills_total", "fees_total", "funding_total"):
            self.assertIsNone(unknown[field])
            self.assertIsNone(failed[field])
            self.assertEqual(empty[field], 0)
        self.assertEqual(unknown["totals_status"], "partial")
        self.assertEqual(failed["totals_status"], "partial")
        self.assertEqual(empty["totals_status"], "complete")

    def test_competition_boundary_is_inclusive_and_future_or_earlier_events_are_excluded(self):
        client = HistoryClient(pages={
            "SWAP": [[fill("1000", when=SINCE - 0.001), fill("1001", when=SINCE),
                      fill("1002", when=NOW), fill("1003", when=NOW + 0.001)]],
            "funding": [[funding("2000", when=SINCE - 0.001), funding("2001", when=SINCE),
                         funding("2002", when=NOW + 0.001)]]})
        public = self.public(update(client))
        self.assertEqual(public["fills_total"], 2)
        self.assertEqual(public["fees_total"], -0.02)
        self.assertEqual(public["funding_total"], -0.02)
        funding_params = next(params for path, params in client.calls if path.endswith("/bills-archive"))
        self.assertEqual(funding_params["type"], "8")
        self.assertEqual(funding_params["begin"], str(int(SINCE * 1000)))
        self.assertEqual(funding_params["end"], str(int(NOW * 1000)))

    def test_lifetime_totals_survive_recent_fill_expiry_in_collect(self):
        config = collector.parse_config({"bots": [{"name": "Alpha", "env_prefix": "A"},
                                                   {"name": "Beta", "env_prefix": "B"}],
                                         "statistics_start": SINCE})

        class CollectionClient(HistoryClient):
            def __init__(self, uid, recent):
                super().__init__(pages={"SWAP": [[fill()]]})
                self.uid, self.recent = uid, recent

            def get(self, path, params=None):
                if path.endswith("/config"):
                    return [{"uid": self.uid}]
                if path.endswith("/balance"):
                    return [{"details": [{"ccy": "USDT", "eq": "10"}]}]
                if path.endswith("/positions"):
                    return []
                if path.endswith("/fills"):
                    return [fill()] if self.recent else []
                return super().get(path, params)

        def collect(state, now, recent):
            clients = {"Alpha": CollectionClient("111111", recent), "Beta": CollectionClient("222222", recent)}
            return collector.collect(config, state, now=now, identity_key=KEY,
                                     client_factory=lambda bot: clients[bot["name"]])

        initial, _, state = collect(collector.new_state(config, opaque=True), NOW, True)
        self.assertEqual(initial["traders"]["Alpha"]["fills_recent"], 1)
        self.assertEqual(initial["traders"]["Alpha"]["fills_total"], 1)
        next_data, _, next_state = collect(state, NOW + 4 * 86400, False)
        for name in ("Alpha", "Beta"):
            self.assertEqual(next_data["traders"][name]["fills_recent"], 0)
            self.assertEqual(next_data["traders"][name]["fills_total"], 1)
            self.assertEqual(next_data["traders"][name]["fees_total"], -0.01)
            self.assertEqual(next_data["traders"][name]["totals_status"], "complete")
            self.assertEqual(next_state["bots"][name]["fills"], {})
            self.assertEqual(len(next_state["bots"][name]["totals"]["streams"]["SWAP"]["events"]), 1)


if __name__ == "__main__":
    unittest.main()
