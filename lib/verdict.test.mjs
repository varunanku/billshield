// Verdict logic, using the project's own golden/real cases. No framework --
// plain asserts. Run with: node lib/verdict.test.mjs
import assert from "node:assert/strict";
import { computeBillChecks } from "./bill-checks.ts";
import { decideVerdict } from "./verdict.ts";

function decide(lines, total, promise = null) {
  const checks = computeBillChecks(lines, total);
  return decideVerdict({
    lines,
    total,
    provider: "Test Provider",
    billDate: "2026-10-19",
    checks,
    promise,
  });
}

// Case 1: Airtel -- paid 12165.08, advance rental 12023.96, outstanding
// 141.12. The outstanding line is what the payment also covers (12023.96 +
// 141.12 = 12165.08 exactly), so this now reconciles cleanly -- clean, no
// email. (Supersedes the earlier expectation of confirmed_error/overpaid
// from before the payment-reconciliation fix.)
{
  const lines = [
    { label: "Amount Paid", amount: 12165.08, role: "payment" },
    { label: "ADVANCE_RENTAL_CHARGES", amount: 12023.96, role: "charge" },
    { label: "OUTSTANDING_AMOUNT", amount: 141.12, role: "balance" },
  ];
  const verdict = decide(lines, 12165.08);

  assert.equal(verdict.outcome, "clean");
  console.log("PASS: Airtel -- outstanding line reconciles the payment -> clean");
}

// Case 1b: BigBasket -- items 1318.50, two payments (218.93 + 1240.83),
// printed total 1459.74. No outstanding/arrears line to explain the
// shortfall -- items are short by 141.24. Not an overpayment, and not
// confident enough to accuse: cannot_verify, no email.
{
  const lines = [
    { label: "Items", amount: 1318.5, role: "charge" },
    { label: "Payment 1", amount: 218.93, role: "payment" },
    { label: "Payment 2", amount: 1240.83, role: "payment" },
  ];
  const verdict = decide(lines, 1459.74);

  assert.equal(verdict.outcome, "cannot_verify");
  assert.ok(!("tone" in verdict), "cannot_verify has no tone -- it never drafts an email");
  assertGapClose(verdict.facts.gap, -141.24);
  console.log("PASS: BigBasket -- items short by 141.24, no reconciling line -> cannot_verify");
}

// Case 2: Overleaf -- a clean charge+tax+payment match, no promise, no
// unrecognized line.
{
  const lines = [
    { label: "Standard Monthly Charge", amount: 549.0, role: "charge" },
    { label: "Subtotal", amount: 549.0, role: "subtotal" },
    { label: "Amount Before Tax", amount: 549.0, role: "subtotal" },
    { label: "VAT at 19%", amount: 104.31, role: "tax" },
    { label: "Amount Paid", amount: 653.31, role: "payment" },
  ];
  const verdict = decide(lines, 653.31);

  assert.equal(verdict.outcome, "clean");
  assert.ok(Math.abs(verdict.reconciledTotal - 653.31) < 0.005);
  console.log("PASS: Overleaf -> clean");
}

// Shared Tata Power component lines (the nine real printed charge/tax
// lines, checkpoint-reconciled to 11454.23 exactly -- see chat history).
const tataNineLines = [
  { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
  { label: "Energy Charges (I)", amount: 7863.5, role: "charge" },
  { label: "PPAC on Fixed Charge (J)", amount: 89.43, role: "charge" },
  { label: "PPAC on Energy Charge (K)", amount: 1113.65, role: "charge" },
  { label: "Surcharge on Fixed Charge (L)", amount: 50.63, role: "charge" },
  { label: "Surcharge on Energy Charge (M)", amount: 629.08, role: "charge" },
  { label: "Pension Trust Charge on Fixed Charge (N)", amount: 44.3, role: "charge" },
  { label: "Pension Trust Charge on Energy Charge (O)", amount: 550.45, role: "charge" },
  { label: "Electricity Tax @ 5% on (G+H+I+K+M)", amount: 480.31, role: "tax" },
];
const TATA_SUBTOTAL = { label: "Net Current Demand", amount: 11454.23, role: "subtotal" };

// Case 3: Tata Power after removing the fabricated 584 line -- the nine
// real lines reconcile the subtotal exactly, and the printed total used
// here matches that reconciled figure (11454.23), so the bill is clean
// end to end. (The real bill's own headline total, 11460.00, carries a
// separate, known round-to-nearest-10 quirk -- see docs/schema.md's golden
// pair notes -- which this test deliberately sets aside by using the
// reconciled total, rather than inventing a new rounding-tolerance
// constant the brief didn't ask for.)
{
  const lines = [...tataNineLines, TATA_SUBTOTAL];
  const verdict = decide(lines, 11454.23);

  assert.equal(verdict.outcome, "clean");
  console.log("PASS: Tata Power after removing 584 -> clean");
}

// Case 4: Tata Power with the fabricated 584 TOD Surcharge still present,
// before the subtotal -- the checkpoint catches it, confirmed error.
{
  const lines = [
    ...tataNineLines.slice(0, 8),
    { label: "Time of Day (TOD) Surcharge (G)", amount: 584.0, role: "charge" },
    tataNineLines[8], // tax
    TATA_SUBTOTAL,
  ];
  const verdict = decide(lines, 11454.23);

  assert.equal(verdict.outcome, "confirmed_error");
  assert.equal(verdict.tone, "confident");
  assertGapClose(verdict.facts.gap, 584.0);
  assert.equal(verdict.facts.disputedLines.length, 1, "the checkpoint suggestion should be the one disputed line");
  assert.equal(verdict.facts.disputedLines[0].label, "Time of Day (TOD) Surcharge (G)");
  console.log("PASS: Tata Power with 584 kept -> confirmed_error, disputed line identified");
}

function assertGapClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.005, `gap should be ~${expected}, got ${actual}`);
}

// Case 5: unexplained -- no hard evidence, but the user marked a line "I
// don't recognise this".
{
  const lines = [
    { label: "Monthly Plan Charge", amount: 499.0, role: "charge" },
    { label: "GST at 18%", amount: 89.82, role: "tax" },
    { label: "Mystery Add-on", amount: 49.0, role: "charge", unrecognized: true },
  ];
  // Note: billedSum here is 499+89.82+49 = 637.82; total must match for this
  // to isolate the unrecognized-line path rather than a hard arithmetic one.
  const verdict = decide(lines, 637.82);

  assert.equal(verdict.outcome, "unexplained");
  assert.equal(verdict.tone, "inquiry");
  assert.equal(verdict.facts.disputedLines.length, 1);
  assert.equal(verdict.facts.disputedLines[0].label, "Mystery Add-on");
  console.log("PASS: unrecognized line, otherwise clean maths -> unexplained");
}

// Case 6: unexplained -- a promise was made but with no comparable amount.
{
  const lines = [
    { label: "Monthly Plan Charge", amount: 499.0, role: "charge" },
    { label: "GST at 18%", amount: 89.82, role: "tax" },
  ];
  const verdict = decide(lines, 588.82, { statement: "They said this fee wouldn't apply to me.", promisedAmount: null });

  assert.equal(verdict.outcome, "unexplained");
  assert.equal(verdict.tone, "inquiry");
  console.log("PASS: promise with no number, otherwise clean maths -> unexplained");
}

// Case 7: a promise WITH an amount that the billed total doesn't match ->
// confirmed_error (hard evidence), even though it's based on a promise.
{
  const lines = [
    { label: "Monthly Plan Charge", amount: 499.0, role: "charge" },
    { label: "GST at 18%", amount: 89.82, role: "tax" },
  ];
  const verdict = decide(lines, 588.82, { statement: "I was quoted 399 + tax.", promisedAmount: 399.0 });

  assert.equal(verdict.outcome, "confirmed_error");
  assert.equal(verdict.tone, "confident");
  console.log("PASS: promise with a mismatched amount -> confirmed_error");
}

// Case 8: a checkpoint gap with NO single-line suggestion (two lines
// before the subtotal share the exact gap amount, so neither can be
// pinpointed) -> cannot_verify, not confirmed_error. Distinct from Case 4
// above, where the checkpoint DOES have a suggestion.
{
  const lines = [
    { label: "Base Charge", amount: 100.0, role: "charge" },
    { label: "Extra A", amount: 50.0, role: "charge" },
    { label: "Extra B", amount: 50.0, role: "charge" }, // same amount as Extra A -- ambiguous
    { label: "Subtotal", amount: 150.0, role: "subtotal" }, // expects 150, actual is 200
  ];
  const verdict = decide(lines, 150.0);

  assert.equal(verdict.outcome, "cannot_verify");
  assert.ok(!("tone" in verdict));
  assertGapClose(verdict.facts.gap, 50.0);
  assert.equal(verdict.facts.disputedLines.length, 0, "no single line could be pinpointed");
  console.log("PASS: checkpoint gap with no single suggestion -> cannot_verify, no disputed line");
}

console.log("\nAll verdict tests passed.");
