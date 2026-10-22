// Using printed history: a Tata Power-style electricity bill that prints
// its last 4 months. The verdict must not change, and the chat facts built
// from the monthly timeline must carry each printed month's label. (The
// merge itself -- checked beats printed, no duplicates -- is the view's
// job, tested against real SQL in lib/timeline.test.mjs.) No network.
// Run with: node lib/printed-history-use.test.mjs
import assert from "node:assert/strict";
import { coerceExtractedBill } from "./groq.ts";
import { computeBillChecks } from "./bill-checks.ts";
import { decideVerdict } from "./verdict.ts";
import { buildFollowupSystemPrompt } from "./followup.ts";
import { describeTimeline, sourceLabel, timelineSummary } from "./timeline.ts";

const juneModel = {
  provider: "Tata Power Delhi Distribution Limited",
  bill_date: "2026-06-22",
  category: "electricity",
  total: 10113.19,
  billing_period_start: "2026-06-01",
  line_items: [
    { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
    { label: "Energy Charges (E)", amount: 9000.0, role: "charge" },
    { label: "Electricity Tax @ 5%", amount: 480.31, role: "tax" },
  ],
  printed_history: [
    { period_label: "Feb 2026", amount: 7420.0, units: 812 },
    { period_label: "Mar 2026", amount: 7980.5, units: 868 },
    { period_label: "Apr 2026", amount: 9120.0, units: 990, amount_paid: 9120.0, paid_on: "2026-05-02" },
    { period_label: "May 2026", amount: 10450.0, units: 1121 },
  ],
};

function verdictOf(bill) {
  const checks = computeBillChecks(bill.line_items, bill.total);
  return decideVerdict({ lines: bill.line_items, total: bill.total, provider: bill.provider, billDate: bill.bill_date, checks, promise: null });
}

// 1. The printed months are captured, and the verdict is exactly what it
//    would be if the bill printed no history at all.
{
  const june = coerceExtractedBill(juneModel);
  const withoutHistory = coerceExtractedBill({ ...juneModel, printed_history: [] });
  assert.equal(june.printed_history.length, 4);
  assert.deepEqual(june.line_items, withoutHistory.line_items, "history never adds line items");
  assert.deepEqual(verdictOf(june), verdictOf(withoutHistory), "verdict unchanged by printed history");
  assert.equal(verdictOf(june).outcome, "clean");
  console.log("PASS: Tata Power bill with 4 printed months -> same line items, same (clean) verdict");
}

// 2. First saved bill: the chat gets the 4 printed months from the timeline
//    (shaped as the view returns them), each labelled, plus this bill's
//    own row with the view's averages -- nothing computed in the app.
{
  const row = (month, source, amount, extra = {}) => ({
    provider_key: "tata power", provider_name: "Tata Power Delhi Distribution Limited", month, source, amount,
    units: null, amount_paid: null, period_label: null, source_bill_id: "june", source_bill_date: "2026-06-22",
    prev_month: null, prev_amount: null, change_rs: null, change_pct: null, avg_3m: null, avg_6m: null,
    months_in_6m: 1, pct_vs_avg_6m: null, min_to_date: null, max_to_date: null, vs_avg_3m: null, ...extra,
  });
  const past = [
    row("2026-02-01", "printed", 7420.0, { units: 812 }),
    row("2026-03-01", "printed", 7980.5, { units: 868, prev_month: "2026-02-01", change_rs: 560.5, change_pct: 7.55 }),
    row("2026-04-01", "printed", 9120.0, { units: 990, amount_paid: 9120.0 }),
    row("2026-05-01", "printed", 10450.0, { units: 1121 }),
  ];
  const current = row("2026-06-01", "checked", 10113.19, { avg_6m: 8616.74, months_in_6m: 5, pct_vs_avg_6m: 17.37, avg_3m: 9894.4, vs_avg_3m: "above" });

  const prompt = buildFollowupSystemPrompt({
    provider: "Tata Power Delhi Distribution Limited",
    billDate: "2026-06-22",
    total: 10113.19,
    lineItems: juneModel.line_items,
    verdictOutcome: "clean",
    verdictGap: null,
    disputedLines: [],
    warnings: [],
    printedHsnCodes: [],
    taxTotal: 480.31,
    timeline: { past, current },
  });
  assert.ok(prompt.includes("- March 2026: Rs 7980.50, 868 units (as printed on your June bill, not checked by BillShield); vs February 2026: +Rs 560.50 (+7.55%)"));
  assert.ok(prompt.includes("April 2026: Rs 9120.00, 990 units, paid Rs 9120.00 (as printed on your June bill, not checked by BillShield)"));
  assert.ok(prompt.includes("This bill's own month: June 2026: Rs 10113.19 (from a bill you saved, checked by BillShield)"));
  assert.ok(prompt.includes("This bill is 17.37% above its 6-month average (computed by BillShield)."));
  assert.ok(prompt.includes("Never calculate a change, average, percentage, lowest or highest yourself"));
  assert.ok(prompt.includes("repeat that\n  label with it, word for word"));
  assert.equal(sourceLabel(past[0]), "(as printed on your June bill, not checked by BillShield)");
  assert.equal(timelineSummary([...past, current]), "Last 5 months: average Rs 8,617; this bill is 17% above average.");
  assert.equal(describeTimeline([], null), "none on record");
  console.log("PASS: chat facts carry each printed month's label and the view's own averages");
}
