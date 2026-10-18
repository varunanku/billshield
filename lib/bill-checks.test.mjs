// Smallest runnable check for the money-math in bill-checks.ts. No
// framework -- plain asserts. Run with:
//   node --experimental-strip-types lib/bill-checks.test.mjs
import assert from "node:assert/strict";
import { computeBillChecks, toPersistedLines } from "./bill-checks.ts";

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.005, `${message} (got ${actual}, expected ~${expected})`);
}

// Case 1: the real Hemant/Airtel receipt (see chat history -- this is what
// qwen/qwen3.8-27b actually extracted from BILL_Hemant_INTERNETCHARGES_1.jpg).
// Paid 12165.08 against an advance-rental charge of 12023.96, with a 141.12
// outstanding-credit line. Expect: no arithmetic issue against this bill's
// own printed total (which *is* the paid figure, 12165.08: billedSum - total
// = 12023.96 - 12165.08 = -141.12, so this bill DOES still show an
// arithmetic difference -- that's expected and correct, see note below),
// and a payment check showing the user overpaid by 141.12.
{
  const lines = [
    { label: "Amount Paid", amount: 12165.08, role: "payment" },
    { label: "ADVANCE_RENTAL_CHARGES", amount: 12023.96, role: "charge" },
    { label: "OUTSTANDING_AMOUNT", amount: 141.12, role: "balance" },
  ];
  const result = computeBillChecks(lines, 12165.08);

  assertClose(result.billedSum, 12023.96, "billedSum should be just the charge line (balance/payment excluded)");
  // This bill's "total" field is really the paid amount, so the generic
  // arithmetic check legitimately flags a difference here -- that's the
  // payment check's job to explain, not this check's job to hide.
  assert.ok(result.arithmeticIssue, "billedSum vs this bill's total should differ");
  assert.ok(result.payment, "a payment-role line should produce a payment check");
  assertClose(result.payment.amountPaid, 12165.08, "amountPaid");
  assertClose(result.payment.signedDifference, -141.12, "signedDifference");
  assert.equal(result.payment.verdict, "overpaid");
  console.log("PASS: Airtel receipt -- overpaid 141.12, billedSum 12023.96");
}

// Case 2: a normal bill whose lines sum to the total (charge + GST == total,
// no payment line) -- the common case, should show no arithmetic issue and
// no payment check.
{
  const lines = [
    { label: "Monthly Plan Charge", amount: 499.0, role: "charge" },
    { label: "GST at 18%", amount: 89.82, role: "tax" },
  ];
  const result = computeBillChecks(lines, 588.82);

  assertClose(result.billedSum, 588.82, "billedSum");
  assert.equal(result.arithmeticIssue, false, "charge+tax should match the total exactly");
  assert.equal(result.payment, null, "no payment line means no payment check");
  console.log("PASS: normal bill -- charge+tax matches total, no payment check");
}

// Case 3: discount lines subtract, balance/subtotal lines are ignored entirely.
{
  const lines = [
    { label: "Service Charge", amount: 1000, role: "charge" },
    { label: "GST", amount: 180, role: "tax" },
    { label: "Loyalty Discount", amount: 50, role: "discount" },
    { label: "Running Subtotal", amount: 9999, role: "subtotal" },
    { label: "Previous Balance", amount: 9999, role: "balance" },
  ];
  const result = computeBillChecks(lines, 1130);

  assertClose(result.billedSum, 1130, "1000 + 180 - 50, ignoring subtotal/balance");
  assert.equal(result.arithmeticIssue, false);
  console.log("PASS: discount subtracts, subtotal/balance ignored");
}

// Case 4: toPersistedLines -- balance/subtotal must not reach storage at
// all (a later verdict step reading line_items back has no role column to
// tell them apart from a charge), discount must be negated so summing every
// non-"Amount Paid" stored row reproduces billedSum, and payment must be
// relabelled to the literal "Amount Paid".
{
  const lineItems = [
    { label: "Service Charge", amount: 1000, role: "charge" },
    { label: "GST", amount: 180, role: "tax" },
    { label: "Loyalty Discount", amount: 50, role: "discount" },
    { label: "Paid amount", amount: 1130, role: "payment" },
    { label: "Running Subtotal", amount: 9999, role: "subtotal" },
    { label: "Previous Balance", amount: 9999, role: "balance" },
  ];
  const persisted = toPersistedLines(lineItems);

  assert.equal(persisted.length, 4, "subtotal and balance should be dropped");
  assert.ok(!persisted.some((li) => li.role === "balance" || li.role === "subtotal"));

  const discountRow = persisted.find((li) => li.label === "Loyalty Discount");
  assert.equal(discountRow.amount, -50, "discount should be stored negated");

  const paymentRow = persisted.find((li) => li.role === "payment");
  assert.equal(paymentRow.label, "Amount Paid", "payment line should be relabelled");

  // The whole point: a later reader with no role column, summing every
  // stored line except "Amount Paid", should reproduce billedSum exactly.
  const reconstructedBilledSum = persisted
    .filter((li) => li.label !== "Amount Paid")
    .reduce((s, li) => s + li.amount, 0);
  assertClose(reconstructedBilledSum, computeBillChecks(lineItems, 1130).billedSum, "reconstructed billedSum from stored rows alone");

  console.log("PASS: toPersistedLines -- drops balance/subtotal, negates discount, relabels payment");
}

console.log("\nAll bill-checks tests passed.");
