// Using printed history: a Tata Power-style electricity bill that prints
// its last 4 months. The verdict must not change, the chat facts must
// carry the "as printed ... (not checked by BillShield)" label, and the
// next month's real bill must not create duplicate months. No network.
// Run with: node lib/printed-history-use.test.mjs
import assert from "node:assert/strict";
import { coerceExtractedBill } from "./groq.ts";
import { computeBillChecks } from "./bill-checks.ts";
import { decideVerdict } from "./verdict.ts";
import { pastMonthsFor, averageAmount } from "./printed-history.ts";
import { buildFollowupSystemPrompt, describePastMonths } from "./followup.ts";

const JUNE_PRINTED = [
  { period_label: "Feb 2026", amount: 7420.0, units: 812 },
  { period_label: "Mar 2026", amount: 7980.5, units: 868 },
  { period_label: "Apr 2026", amount: 9120.0, units: 990, amount_paid: 9120.0, paid_on: "2026-05-02" },
  { period_label: "May 2026", amount: 10450.0, units: 1121 },
];

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
  printed_history: JUNE_PRINTED,
};

function verdictOf(bill) {
  const checks = computeBillChecks(bill.line_items, bill.total);
  return decideVerdict({ lines: bill.line_items, total: bill.total, provider: bill.provider, billDate: bill.bill_date, checks, promise: null });
}

// 1. The printed months are captured, and the verdict is exactly what it
//    would be if the bill printed no history at all.
const june = coerceExtractedBill(juneModel);
{
  const withoutHistory = coerceExtractedBill({ ...juneModel, printed_history: [] });
  assert.equal(june.printed_history.length, 4);
  assert.deepEqual(june.line_items, withoutHistory.line_items, "history never adds line items");
  assert.deepEqual(verdictOf(june), verdictOf(withoutHistory), "verdict unchanged by printed history");
  assert.equal(verdictOf(june).outcome, "clean");
  console.log("PASS: Tata Power bill with 4 printed months -> same line items, same (clean) verdict");
}

const juneBill = { id: "june", bill_date: "2026-06-22", billing_period_start: "2026-06-01", total: 10113.19, units: 1050 };
const juneRows = june.printed_history.map((r) => ({ ...r, bill_id: "june" }));

// 2. First saved bill: the chat still gets 4 past months, each labelled.
{
  const past = pastMonthsFor(juneBill, [juneBill], juneRows);
  assert.deepEqual(past.map((m) => m.month), ["2026-02", "2026-03", "2026-04", "2026-05"]);
  assert.ok(past.every((m) => m.source === "printed"));

  const prompt = buildFollowupSystemPrompt({
    provider: "Tata Power Delhi Distribution Limited",
    billDate: "2026-06-22",
    total: 10113.19,
    lineItems: june.line_items,
    verdictOutcome: "clean",
    verdictGap: null,
    disputedLines: [],
    warnings: [],
    printedHsnCodes: [],
    taxTotal: 480.31,
    pastMonths: past,
  });
  assert.ok(prompt.includes("- March 2026: Rs 7980.50, 868 units -- as printed on your June bill (not checked by BillShield)"));
  assert.ok(prompt.includes("- April 2026: Rs 9120.00, 990 units, paid Rs 9120.00 -- as printed on your June bill (not checked by BillShield)"));
  // Average of 7420, 7980.5, 9120, 10450 = 8742.63; this bill is 1370.56 higher.
  assert.equal(averageAmount(past).average, 8742.63);
  assert.ok(prompt.includes("Rs 8742.63 (4 of them printed figures, not checked by BillShield)"));
  assert.ok(prompt.includes("Rs 1370.56 higher than that average"), "higher-than-usual is computed in code");
  assert.ok(prompt.includes("repeat that label with it, word for word"), "chat is told to carry the label");
  console.log("PASS: first bill -> chat facts carry 4 labelled printed months and a code-computed average");
}

// 3. July's real bill arrives, printing Mar-Jun. June must come from the
//    real checked June bill, and no month appears twice.
{
  const julyBill = { id: "july", bill_date: "2026-07-22", billing_period_start: "2026-07-01", total: 11020.0, units: 1140 };
  const julyRows = [
    { period_label: "Mar 2026", amount: 7980.5, units: 868 },
    { period_label: "Apr 2026", amount: 9120.0, units: 990 },
    { period_label: "May 2026", amount: 10450.0, units: 1121 },
    { period_label: "Jun 2026", amount: 10113.0, units: 1050 }, // the printed copy of June
  ].map((r) => ({ period_start: null, amount_paid: null, paid_on: null, ...r, bill_id: "july" }))
    .map((r) => ({ ...r, period_start: { "Mar 2026": "2026-03-01", "Apr 2026": "2026-04-01", "May 2026": "2026-05-01", "Jun 2026": "2026-06-01" }[r.period_label] }));

  const past = pastMonthsFor(julyBill, [julyBill, juneBill], [...juneRows, ...julyRows]);
  const months = past.map((m) => m.month);
  assert.deepEqual(months, ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
  assert.equal(new Set(months).size, months.length, "no duplicate months");
  const juneEntry = past.find((m) => m.month === "2026-06");
  assert.equal(juneEntry.source, "checked", "the real June bill beats July's printed June row");
  assert.equal(juneEntry.amount, 10113.19);
  assert.equal(past.find((m) => m.month === "2026-03").printedOn, "2026-07-22", "newest printing of March");
  assert.ok(!past.some((m) => m.month === "2026-07"), "the current bill is not its own past month");
  assert.ok(describePastMonths(past, 11020).includes("June 2026: Rs 10113.19, 1050 units -- from a bill you saved, checked by BillShield"));
  console.log("PASS: next month's real bill -> real June replaces printed June, no duplicate months");
}

assert.equal(describePastMonths([], 100), "none on record");
console.log("PASS: no history -> 'none on record'");
