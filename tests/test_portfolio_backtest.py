#!/usr/bin/env python3
import unittest

from stockagent.portfolio_backtest import evaluate_backtest_request, run_backtest_from_workspace_symbols


def _series(months, start=1.0, step=0.01):
    rows = []
    price = start
    for i in range(months):
        year = 2020 + (i // 12)
        month = (i % 12) + 1
        day = f"{year:04d}-{month:02d}-28"
        rows.append({"date": day, "close": round(price, 4)})
        price += step
    return rows


def _pe_series(months):
    rows = []
    for i in range(months):
        year = 2020 + (i // 12)
        month = (i % 12) + 1
        day = f"{year:04d}-{month:02d}-28"
        rows.append({"date": day, "pe_percentile": 0.4})
    return rows


class PortfolioBacktestTests(unittest.TestCase):
    def test_insufficient_months(self):
        status, body = evaluate_backtest_request(
            {
                "symbols": ["512890"],
                "target_weights": {"512890": 100},
                "monthly_budget": 1000,
                "price_history": {"512890": _series(12)},
                "pe_history": {"512890": _pe_series(12)},
            },
            price_history={"512890": _series(12)},
            pe_history={"512890": _pe_series(12)},
        )
        self.assertEqual(status, 422)
        self.assertEqual(body["status"], "insufficient_history")

    def test_missing_symbol_coverage(self):
        status, body = evaluate_backtest_request(
            {
                "target_weights": {"512890": 50, "563360": 50},
                "monthly_budget": 1000,
            },
            price_history={"512890": _series(40)},
            pe_history={"512890": _pe_series(40)},
        )
        self.assertEqual(status, 422)
        self.assertIn("563360", body["missing_symbols"])

    def test_ready_path_with_fees_and_cash(self):
        prices = {
            "512890": _series(48, start=1.0, step=0.005),
            "563360": _series(48, start=2.0, step=0.008),
        }
        pe = {"512890": _pe_series(48), "563360": _pe_series(48)}
        status, body = evaluate_backtest_request(
            {
                "target_weights": {"512890": 60, "563360": 40},
                "monthly_budget": 2000,
                "trading_cost": {
                    "min_commission": 5,
                    "commission_rate_pct": 0.03,
                    "max_fee_ratio_pct": 0.25,
                    "lot_size": 100,
                },
                "strategy_config": {
                    "pe_bands": [
                        {"max_pct": 100, "mult": 1},
                    ]
                },
            },
            price_history=prices,
            pe_history=pe,
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ready")
        self.assertEqual(len(body["strategies"]), 3)
        for row in body["strategies"]:
            self.assertGreaterEqual(row["fees"], 0)
            self.assertTrue(0 <= row["average_cash_pct"] <= 100)
            self.assertEqual(round(row["ending_value"], 2), row["ending_value"])

    def test_empty_payload_not_green(self):
        status, body = run_backtest_from_workspace_symbols({})
        self.assertEqual(status, 422)
        self.assertEqual(body["status"], "insufficient_history")
        self.assertNotEqual(body.get("status"), "ready")

    def test_no_future_signal_used_when_pe_dates_ok(self):
        # PE only available on earlier dates; still runnable
        prices = {"512890": _series(40)}
        pe = {"512890": _pe_series(40)}
        # inject a future pe that must not be required
        pe["512890"].append({"date": "2099-01-01", "pe_percentile": 0.01})
        status, body = evaluate_backtest_request(
            {"target_weights": {"512890": 100}, "monthly_budget": 1000},
            price_history=prices,
            pe_history=pe,
        )
        self.assertEqual(status, 200)


if __name__ == "__main__":
    unittest.main()
