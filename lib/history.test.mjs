// Run with: node lib/history.test.mjs
import assert from "node:assert/strict";
import { groupBillsByProvider, computeHistoryQuery } from "./history.ts";

// A single provider with 3 bills -- change vs previous and vs average of
// everything earlier, computed per bill in chronological order.
{
  const bills = [
    { id: "1", provider: "Airtel", billDate: "2026-01-01", total: 500, verdictOutcome: "clean" },
    { id: "2", provider: "Airtel", billDate: "2026-02-01", total: 600, verdictOutcome: "clean" },
    { id: "3", provider: "Airtel", billDate: "2026-03-01", total: 800, verdictOutcome: "cannot_verify" },
    { id: "4", provider: "Jio", billDate: "2026-03-01", total: 300, verdictOutcome: "clean" },
  ];
  const groups = groupBillsByProvider(bills);

  assert.equal(groups.length, 2, "two distinct providers");
  const airtel = groups.find((g) => g.provider === "Airtel");
  assert.equal(airtel.bills.length, 3);

  // Newest first.
  const [march, feb, jan] = airtel.bills;
  assert.equal(march.id, "3");
  assert.equal(jan.changeVsPrevious, null, "the oldest bill has nothing before it");
  assert.equal(jan.changeVsAverage, null);
  assert.equal(feb.changeVsPrevious, 100, "600 - 500");
  assert.equal(feb.changeVsAverage, 100, "600 - avg(500)");
  assert.equal(march.changeVsPrevious, 200, "800 - 600");
  assert.equal(march.changeVsAverage, 250, "800 - avg(500,600)=550 -> 250");

  const jio = groups.find((g) => g.provider === "Jio");
  assert.equal(jio.bills.length, 1);
  assert.equal(jio.bills[0].changeVsPrevious, null, "a single bill has no history to compare against");

  console.log("PASS: groupBillsByProvider groups by provider and computes vs-previous/vs-average correctly");
}

// computeHistoryQuery -- "average units till date vs this month" on 3
// fixture bills: average of everything before the latest vs the latest.
{
  const result = computeHistoryQuery([
    { billDate: "2026-01-01", value: 100 },
    { billDate: "2026-02-01", value: 120 },
    { billDate: "2026-03-01", value: 140 },
  ]);
  assert.equal(result.count, 3);
  assert.equal(result.averageBeforeLatest, 110, "avg(100, 120)");
  assert.equal(result.latestValue, 140);
  assert.equal(result.latestDate, "2026-03-01");
  console.log("PASS: computeHistoryQuery -- average-till-date vs this month from 3 fixture bills");
}

// computeHistoryQuery -- no data at all is a clean empty result, not a crash.
{
  const result = computeHistoryQuery([]);
  assert.equal(result.count, 0);
  assert.equal(result.averageBeforeLatest, null);
  assert.equal(result.latestValue, null);
  console.log("PASS: computeHistoryQuery handles no data without crashing");
}

console.log("\nAll history tests passed.");
