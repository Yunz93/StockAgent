import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPeHysteresis,
  buildSignalSnapshot,
  invalidatePendingDraftsForSnapshot,
  peBandIndex,
} from "../js/signal-snapshot.js";
import { DEFAULT_PE_BANDS } from "../js/strategy-multipliers.js";
import { normalizePlan, normalizeExecutionDrafts, WORKSPACE_VERSION } from "../js/workspace_model.js";

test("same-period rebuild with identical inputs keeps band", () => {
  const plan = normalizePlan({
    strategy: "valuation",
    execution_policy: { pe_hysteresis_pp: 3 },
  });
  const holdings = [
    {
      symbol: "512890",
      pePct: 0.55,
      grade: "C",
      assetClass: "equity_core",
      analyzed: true,
    },
  ];
  const first = buildSignalSnapshot({
    plan,
    period: "2026-08-01",
    holdings,
    now: new Date("2026-08-10T10:00:00"),
  });
  const second = buildSignalSnapshot({
    plan,
    period: "2026-08-01",
    holdings,
    previousSnapshot: first,
    now: new Date("2026-08-10T22:00:00"),
  });
  assert.equal(first.holdings["512890"].band, second.holdings["512890"].band);
  assert.notEqual(first.id, second.id);
});

test("hysteresis: 79→81 stays; cross boundary+3 downgrades; improve needs -3", () => {
  // bands: 20/40/60/80/100 → index for 79 is 3 (偏高区 max 80)
  const prev = peBandIndex(0.79, DEFAULT_PE_BANDS);
  assert.equal(prev, 3);
  const stay = applyPeHysteresis({
    pePct: 0.81,
    previousBandIndex: prev,
    bands: DEFAULT_PE_BANDS,
    hysteresisPp: 3,
  });
  assert.equal(stay.band_index, 3);
  const down = applyPeHysteresis({
    pePct: 0.84,
    previousBandIndex: prev,
    bands: DEFAULT_PE_BANDS,
    hysteresisPp: 3,
  });
  assert.equal(down.band_index, 4);
  const upBlocked = applyPeHysteresis({
    pePct: 0.58,
    previousBandIndex: 3,
    bands: DEFAULT_PE_BANDS,
    hysteresisPp: 3,
  });
  assert.equal(upBlocked.band_index, 3);
  const upOk = applyPeHysteresis({
    pePct: 0.56,
    previousBandIndex: 3,
    bands: DEFAULT_PE_BANDS,
    hysteresisPp: 3,
  });
  assert.equal(upOk.band_index, 2);
});

test("invalidate pending drafts; keep confirmed/skipped", () => {
  const drafts = invalidatePendingDraftsForSnapshot(
    [
      { id: "1", status: "pending", decision_snapshot: { signal_snapshot_id: "old" } },
      { id: "2", status: "confirmed", decision_snapshot: { signal_snapshot_id: "old" } },
      { id: "3", status: "skipped", decision_snapshot: { signal_snapshot_id: "old" } },
    ],
    "new",
  );
  assert.equal(drafts[0].stale, true);
  assert.equal(drafts[1].status, "confirmed");
  assert.equal(drafts[2].status, "skipped");
});

test("workspace v9 defaults and stale pending without snapshot", () => {
  const plan = normalizePlan({});
  assert.equal(plan.execution_policy.premium_block_pct, 5);
  assert.deepEqual(plan.signal_snapshots, {});
  assert.equal(WORKSPACE_VERSION, 9);
  const drafts = normalizeExecutionDrafts([
    {
      id: "draft_old",
      period: "2026-08-01",
      symbol: "512890",
      suggested_amount: 1000,
      price: 1,
      shares: 1000,
      status: "pending",
    },
    {
      id: "draft_ok",
      period: "2026-08-01",
      symbol: "510300",
      suggested_amount: 1000,
      price: 1,
      shares: 1000,
      status: "confirmed",
    },
  ]);
  assert.equal(drafts.find((d) => d.id === "draft_old").stale, true);
  assert.equal(drafts.find((d) => d.id === "draft_ok").stale, false);
});
