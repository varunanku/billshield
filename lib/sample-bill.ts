// The built-in example behind "Try a sample bill": what the AI would have
// read off a typical electricity bill, so a first-time user can walk the
// whole flow (review -> verdict -> email) without uploading anything.
// Nothing about it is special-cased in the maths: the review screen,
// lib/bill-checks.ts and lib/verdict.ts treat it exactly like a real bill
// (it's flagged because its Sub Total leaves out the TOD Surcharge line).
// Nothing is uploaded, saved, or sent to the AI.
import type { ExtractedBill } from "./groq.ts";

export const SAMPLE_BILL_ID = "sample";

export const SAMPLE_BILL: ExtractedBill = {
  provider: "Sample Power Co.",
  provider_legal_name: null,
  bill_date: "2026-09-22",
  total: 10114.52,
  category: "electricity",
  billing_period_start: "2026-09-01",
  billing_period_end: "2026-09-30",
  units_consumed: 1050,
  units_consumed_unit: "kWh",
  printed_hsn_codes: [],
  line_items: [
    { label: "Fixed Charges", amount: 632.88, role: "charge" },
    { label: "Energy Charges", amount: 9000.0, role: "charge" },
    { label: "TOD Surcharge", amount: 584.0, role: "charge" },
    { label: "Sub Total", amount: 9632.88, role: "subtotal" },
    { label: "Electricity Tax @ 5%", amount: 481.64, role: "tax" },
  ],
  printed_history: [
    { period_label: "Jun 2026", period_start: "2026-06-01", amount: 9120.0, units: 990, amount_paid: null, paid_on: null },
    { period_label: "Jul 2026", period_start: "2026-07-01", amount: 10450.0, units: 1121, amount_paid: null, paid_on: null },
    { period_label: "Aug 2026", period_start: "2026-08-01", amount: 9874.0, units: 1062, amount_paid: null, paid_on: null },
  ],
};
