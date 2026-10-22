// Printed payment history (electricity/water). Pure, no network.
// Run with: node lib/printed-history.test.mjs
import assert from "node:assert/strict";
import {
  parsePeriodStart,
  normalisePrintedHistory,
  historyAllowedFor,
} from "./printed-history.ts";
import { coerceExtractedBill } from "./groq.ts";
import { parseInput, confirmSchema } from "./schemas.ts";

// Period labels -> first of month.
{
  assert.equal(parsePeriodStart("Mar 2026"), "2026-03-01");
  assert.equal(parsePeriodStart("March-26"), "2026-03-01");
  assert.equal(parsePeriodStart("MAR'26"), "2026-03-01");
  assert.equal(parsePeriodStart("03/2026"), "2026-03-01");
  assert.equal(parsePeriodStart("3-26"), "2026-03-01");
  assert.equal(parsePeriodStart("2026-03"), "2026-03-01");
  assert.equal(parsePeriodStart("13/2026"), null, "no month 13");
  assert.equal(parsePeriodStart("Previous bill"), null);
  console.log("PASS: parsePeriodStart -- month names, numeric forms, 2-digit years");
}

// Only electricity and water; rows need a label and a number; labels deduped.
{
  const raw = [
    { period_label: "Mar 2026", amount: 1840.5, units: 210 },
    { period_label: "Feb 2026", amount_paid: 1702, paid_on: "2026-02-14" },
    { period_label: "mar 2026", amount: 1 }, // duplicate label
    { period_label: "Jan 2026" }, // no numbers
    { period_label: "", amount: 5 }, // no label
    { period_label: "Dec 2025", amount: -5, units: "lots" }, // nothing valid
    { period_label: "Nov 2025", period_start: "2025-11-17", amount: 1500 },
  ];
  const rows = normalisePrintedHistory(raw, "electricity");
  assert.deepEqual(
    rows.map((r) => [r.period_label, r.period_start]),
    [
      ["Mar 2026", "2026-03-01"],
      ["Feb 2026", "2026-02-01"],
      ["Nov 2025", "2025-11-01"],
    ]
  );
  assert.equal(rows[1].paid_on, "2026-02-14");
  assert.equal(rows[0].amount_paid, null);
  assert.deepEqual(normalisePrintedHistory(raw, "water").length, 3);
  assert.deepEqual(normalisePrintedHistory(raw, "internet"), [], "other categories never get history");
  assert.deepEqual(normalisePrintedHistory(raw, null), []);
  assert.equal(normalisePrintedHistory(Array.from({ length: 40 }, (_, i) => ({ period_label: `P${i}`, amount: i })), "water").length, 24);
  assert.ok(historyAllowedFor("water") && !historyAllowedFor("mobile"));
  console.log("PASS: normalisePrintedHistory -- electricity/water only, valid rows, deduped, capped");
}

// Extraction keeps history separate from line items.
{
  const model = {
    provider: "Tata Power",
    category: "electricity",
    total: 2010,
    line_items: [{ label: "Energy Charges", amount: 2010, role: "charge" }],
    printed_history: [{ period_label: "Mar 2026", amount: 1840.5 }],
  };
  const bill = coerceExtractedBill(model);
  assert.equal(bill.line_items.length, 1, "history never becomes a line item");
  assert.equal(bill.printed_history.length, 1);
  assert.equal(coerceExtractedBill({ ...model, category: "mobile" }).printed_history.length, 0);
  assert.equal(coerceExtractedBill({ ...model, printed_history: undefined }).printed_history.length, 0);
  console.log("PASS: extraction -- printed history parsed separately, never into line_items");
}

// Confirm payload re-normalises whatever the client sends.
{
  const base = { path: "p", total: 10, line_items: [{ label: "A", amount: 10, role: "charge" }] };
  const r = parseInput(confirmSchema, { ...base, printed_history: [{ period_label: "Mar 2026", amount: 5 }, { junk: true }] });
  assert.ok(r.ok);
  assert.equal(r.data.printed_history.length, 1);
  assert.deepEqual(parseInput(confirmSchema, base).data.printed_history, []);
  assert.deepEqual(parseInput(confirmSchema, { ...base, printed_history: "nope" }).data.printed_history, []);
  console.log("PASS: confirm schema -- printed history validated and defaulted");
}
