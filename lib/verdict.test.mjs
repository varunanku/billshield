// Verdict logic, using the project's own golden/real cases. No framework --
// plain asserts. Run with: node lib/verdict.test.mjs
import assert from "node:assert/strict";
import { computeBillChecks } from "./bill-checks.ts";
import { decideVerdict, shouldDraftEmail } from "./verdict.ts";
import { findTaxOvercharge } from "./gst.ts";

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
// 141.12. REVERTED: billed = charge+tax-discount only, so the outstanding
// line is no longer credited into what the payment should cover. Paid
// exceeds billed by 141.12 -- a real overpayment, confirmed_error with
// reason "overpaid", confident tone. The outstanding line is mentioned
// (reconcilingBalanceLabel) as context, not folded into the gap.
// (Supersedes the earlier "clean" expectation from the payment-crediting
// phase, which this request explicitly asked to revert.)
{
  const lines = [
    { label: "Amount Paid", amount: 12165.08, role: "payment" },
    { label: "ADVANCE_RENTAL_CHARGES", amount: 12023.96, role: "charge" },
    { label: "OUTSTANDING_AMOUNT", amount: 141.12, role: "balance" },
  ];
  const verdict = decide(lines, 12165.08);

  assert.equal(verdict.outcome, "confirmed_error");
  assert.equal(verdict.tone, "confident");
  assert.equal(verdict.reason, "overpaid");
  assertGapClose(verdict.facts.gap, -141.12);
  assertGapClose(verdict.facts.billedAmount, 12023.96);
  assert.equal(verdict.facts.reconcilingBalanceLabel, "OUTSTANDING_AMOUNT");
  console.log("PASS: Airtel -- billed alone -> overpaid by 141.12, outstanding line mentioned, confirmed_error");
}

// Case 1b: BigBasket -- items 1318.50, two payments (218.93 + 1240.83 =
// 1459.76), printed total 1459.74. By the same billed-only receipt rule as
// Airtel, paid exceeds billed by 141.26 -- also a confirmed_error overpaid,
// not a softer cannot_verify (no more special-casing "could be a missing
// line" on a receipt once a payment line is present).
{
  const lines = [
    { label: "Items", amount: 1318.5, role: "charge" },
    { label: "Payment 1", amount: 218.93, role: "payment" },
    { label: "Payment 2", amount: 1240.83, role: "payment" },
  ];
  const verdict = decide(lines, 1459.74);

  assert.equal(verdict.outcome, "confirmed_error");
  assert.equal(verdict.reason, "overpaid");
  assertGapClose(verdict.facts.gap, -141.26);
  console.log("PASS: BigBasket -- billed-only rule -> overpaid by 141.26, confirmed_error");
}

// Case 1c: the Tata rounded-total pair (see bill-checks.test.mjs Case 16)
// -- clean, with roundingNote set so the UI can say exactly which two
// figures and which rounding explain the (otherwise 2.19) gap.
{
  const lines = [
    { label: "Energy Charges", amount: 11457.81, role: "charge" },
    { label: "Net Amount Payable", amount: 11457.81, role: "balance" },
    { label: "Total", amount: 11460.0, role: "balance" },
  ];
  const verdict = decide(lines, 11457.81);

  assert.equal(verdict.outcome, "clean");
  assert.ok(verdict.roundingNote !== null);
  assertGapClose(verdict.roundingNote.gap, 2.19);
  assertGapClose(verdict.reconciledTotal, 11460.0);
  console.log("PASS: Tata rounded-total pair -> clean, with a roundingNote explaining the 2.19");
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
  assert.equal(verdict.reason, "mismatch");
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
  assert.equal(verdict.reason, "promise_mismatch");
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
  assert.equal(verdict.tone, "inquiry");
  assertGapClose(verdict.facts.gap, 50.0);
  assert.equal(verdict.facts.disputedLines.length, 0, "no single line could be pinpointed");
  console.log("PASS: checkpoint gap with no single suggestion, above tolerance -> cannot_verify, inquiry tone, no disputed line");
}

// Case 9: shouldDraftEmail -- never worth an email over a sub-Rs-1 figure,
// even when the checkpoint mechanism itself is precise enough (EPSILON,
// not ROUNDING_TOLERANCE) to catch a tiny mismatched line.
{
  const lines = [
    { label: "Base Charge", amount: 100.0, role: "charge" },
    { label: "Tiny Extra", amount: 0.5, role: "charge" },
    { label: "Subtotal", amount: 100.0, role: "subtotal" },
  ];
  const verdict = decide(lines, 100.0);

  assert.equal(verdict.outcome, "confirmed_error", "a 0.50 checkpoint gap with one matching line is still pinpointed");
  assert.equal(shouldDraftEmail(verdict.facts), false, "but under Rs 1.00 is never worth an email");
  console.log("PASS: shouldDraftEmail -- a sub-Rs-1 pinpointed line still never drafts an email");
}

// Case 10: shouldDraftEmail -- an unrecognized line under Rs 1.00 also
// doesn't draft; one at or above Rs 1.00 does.
{
  const cheapLines = [
    { label: "Monthly Plan Charge", amount: 499.0, role: "charge" },
    { label: "Tiny Fee", amount: 0.5, role: "charge", unrecognized: true },
  ];
  const cheapVerdict = decide(cheapLines, 499.5);
  assert.equal(cheapVerdict.outcome, "unexplained");
  assert.equal(shouldDraftEmail(cheapVerdict.facts), false, "a sub-Rs-1 unrecognized line isn't worth an email");

  const normalLines = [
    { label: "Monthly Plan Charge", amount: 499.0, role: "charge" },
    { label: "Mystery Add-on", amount: 49.0, role: "charge", unrecognized: true },
  ];
  const normalVerdict = decide(normalLines, 548.0);
  assert.equal(normalVerdict.outcome, "unexplained");
  assert.equal(shouldDraftEmail(normalVerdict.facts), true, "a normal-sized unrecognized line drafts as usual");
  console.log("PASS: shouldDraftEmail -- gates unrecognized lines by amount too");
}

// Case 11: shouldDraftEmail -- a promise with no number has nothing
// numeric to judge by, so it's never blocked by the amount guard.
{
  const lines = [
    { label: "Monthly Plan Charge", amount: 499.0, role: "charge" },
    { label: "GST at 18%", amount: 89.82, role: "tax" },
  ];
  const verdict = decide(lines, 588.82, { statement: "They said this fee wouldn't apply to me.", promisedAmount: null });

  assert.equal(verdict.outcome, "unexplained");
  assert.equal(shouldDraftEmail(verdict.facts), true, "no amount to compare -- never blocked");
  console.log("PASS: shouldDraftEmail -- a promise with no number is never blocked by the amount guard");
}

// Case 12: Urban Company end to end -- the duplicate "Total Tax" summary
// line (see bill-checks.test.mjs) must not cause a false confirmed_error/
// cannot_verify once excluded from the sums.
{
  const lines = [
    { label: "Gross Amount", amount: 255.56, role: "charge" },
    { label: "Discount", amount: 92, role: "discount" },
    { label: "Taxable Subtotal", amount: 163.56, role: "subtotal" },
    { label: "IGST", amount: 29.44, role: "tax" },
    { label: "Total Tax", amount: 29.44, role: "tax" },
  ];
  const verdict = decide(lines, 193);

  assert.equal(verdict.outcome, "clean");
  console.log("PASS: Urban Company -- duplicate 'Total Tax' summary excluded -> clean");
}

// Case 13: Cred-style grocery receipt, end to end -- a 0-amount "Advance
// (Online)" payment line is ignored entirely (no payment message), and the
// rest of the bill reconciles cleanly.
{
  const lines = [
    { label: "Base Price", amount: 924.76, role: "charge" },
    { label: "Delivery", amount: 0, role: "charge" },
    { label: "C&C Rebate", amount: 0, role: "discount" },
    { label: "Taxable Amount", amount: 924.76, role: "subtotal" },
    { label: "CGST", amount: 23.12, role: "tax" },
    { label: "SGST", amount: 23.12, role: "tax" },
    { label: "Total Amount", amount: 971, role: "balance" },
    { label: "Advance (Online)", amount: 0, role: "payment" },
  ];
  const checks = computeBillChecks(lines, 971);
  const verdict = decideVerdict({ lines, total: 971, provider: "your provider", billDate: "2026-10-19", checks, promise: null });

  assert.equal(checks.payment, null, "0-amount payment line ignored, no payment check");
  assert.equal(verdict.outcome, "clean");
  console.log("PASS: 0-amount payment line ignored, provider-less bill -> clean");
}

// Case 14: paid 500 against a billed/printed total of 971 -- underpaying is
// never reported anywhere: no payment message, no warning, and (since
// nothing else is wrong with this bill) no email, just clean.
{
  const lines = [
    { label: "Base Price", amount: 924.76, role: "charge" },
    { label: "Taxable Amount", amount: 924.76, role: "subtotal" },
    { label: "CGST", amount: 23.12, role: "tax" },
    { label: "SGST", amount: 23.12, role: "tax" },
    { label: "Total Amount", amount: 971, role: "balance" },
    { label: "Advance (Online)", amount: 500, role: "payment" },
  ];
  const verdict = decide(lines, 971);

  assert.equal(verdict.outcome, "clean", "underpaying is never reported -- no confirmed_error/cannot_verify over it");
  console.log("PASS: paid 500 against billed 971 -> no payment message, no email, clean");
}

// Case 15: Phase 3 end to end -- a confirmed tax-overcharge finding (18%
// billed vs 5% reference for HSN 2106, printed on the bill) surfaces as
// confirmed_error with reason "tax_overcharge", even though every OTHER
// check (arithmetic, payment, promise) is completely clean.
{
  const lines = [
    { label: "Items", amount: 1000, role: "charge" },
    { label: "CGST", amount: 90, role: "tax" },
    { label: "SGST", amount: 90, role: "tax" },
  ];
  const rates = [{ category: "groceries", item_keyword: null, hsn_prefix: "2106", gst_rate_total: 5, cgst: 2.5, sgst: 2.5, igst: null, source_url: "https://cbic.gov.in/x", effective_from: null }];
  const printedHsnCodes = ["21069099"];
  const checks = computeBillChecks(lines, 1180);
  const taxFinding = findTaxOvercharge(lines, "groceries", rates, printedHsnCodes);
  const verdict = decideVerdict({
    lines,
    total: 1180,
    provider: "BigBasket",
    billDate: "2026-03-10",
    checks,
    promise: null,
    taxFinding,
  });

  assert.equal(verdict.outcome, "confirmed_error");
  assert.equal(verdict.reason, "tax_overcharge");
  assert.ok(verdict.facts.taxFinding, "facts must carry the tax finding");
  assert.equal(verdict.facts.taxFinding.hsnPrefix, "2106");
  assertClose(Math.abs(verdict.facts.gap), 130, "1000 * (18 - 5) / 100 = 130");
  console.log("PASS: confirmed tax overcharge -> confirmed_error (tax_overcharge), even on an otherwise-clean bill");
}

// Case 16: the HP gas bill (no printed HSN) -- taxFinding is null, and the
// verdict is completely unaffected: still clean, exactly as Case 13.
{
  const lines = [
    { label: "Base Price", amount: 924.76, role: "charge" },
    { label: "CGST", amount: 23.12, role: "tax" },
    { label: "SGST", amount: 23.12, role: "tax" },
  ];
  const rates = [{ category: "groceries", item_keyword: null, hsn_prefix: "2716", gst_rate_total: 5, cgst: 2.5, sgst: 2.5, igst: null, source_url: null, effective_from: null }];
  const checks = computeBillChecks(lines, 971);
  const taxFinding = findTaxOvercharge(lines, "groceries", rates, []); // no printed codes
  const verdict = decideVerdict({ lines, total: 971, provider: "HP Gas", billDate: "2026-01-01", checks, promise: null, taxFinding });

  assert.equal(taxFinding, null);
  assert.equal(verdict.outcome, "clean", "no printed HSN -- the other verdict outcomes are completely unaffected");
  console.log("PASS: HP gas bill -- no printed HSN, taxFinding null, verdict stays clean");
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.01, message ?? `expected ~${expected}, got ${actual}`);
}

console.log("\nAll verdict tests passed.");
