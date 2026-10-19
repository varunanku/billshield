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

// Case 4: toPersistedLines -- balance/subtotal/info must not reach storage
// at all (a later verdict step reading line_items back has no role column
// to tell them apart from a charge), discount must be negated so summing
// every non-"Amount Paid" stored row reproduces billedSum, and payment must
// be relabelled to the literal "Amount Paid".
{
  const lineItems = [
    { label: "Service Charge", amount: 1000, role: "charge" },
    { label: "GST", amount: 180, role: "tax" },
    { label: "Loyalty Discount", amount: 50, role: "discount" },
    { label: "Paid amount", amount: 1130, role: "payment" },
    { label: "Running Subtotal", amount: 9999, role: "subtotal" },
    { label: "Previous Balance", amount: 9999, role: "balance" },
    { label: "Units Consumed", amount: 450, role: "info" },
  ];
  const persisted = toPersistedLines(lineItems);

  assert.equal(persisted.length, 4, "subtotal, balance and info should be dropped");
  assert.ok(!persisted.some((li) => li.role === "balance" || li.role === "subtotal" || li.role === "info"));

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

// Cases 5-7: the real Tata Power electricity bill (BILL_Hemant_2_ELICTRICITY_BILL.jpg,
// see chat history for the ground truth read directly off the printed bill).
// total printed on the bill = 11460.00 (headline "Amount Payable" box);
// Net Current Demand = 11454.23 is a printed subtotal of nine charge/tax
// lines, six of which (the PPAC/Surcharge/Pension-Trust fixed+energy pairs)
// the model originally dropped entirely -- this is the real bug the prompt
// rewrite and the checkpoint logic both exist to catch.

// Case 5: incomplete extraction (the original bug) -- only 3 of the 9
// component lines present. The top-level billedSum-vs-total check alone
// wouldn't localize the problem; the checkpoint against the printed
// "Net Current Demand" subtotal does: actual 8976.69 vs expected 11454.23.
{
  const lineItems = [
    { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
    { label: "Energy Charges (I)", amount: 7863.5, role: "charge" },
    { label: "Electricity Tax @ 5% on (G+H+I+K+M)", amount: 480.31, role: "tax" },
    { label: "Net Current Demand", amount: 11454.23, role: "subtotal" },
  ];
  const result = computeBillChecks(lineItems, 11460.0);

  assert.equal(result.checkpoints.length, 1);
  const checkpoint = result.checkpoints[0];
  assert.equal(checkpoint.label, "Net Current Demand");
  assertClose(checkpoint.expected, 11454.23, "checkpoint expected");
  assertClose(checkpoint.actual, 8976.69, "checkpoint actual (632.88 + 7863.50 + 480.31)");
  // gap = actual - expected, so a shortfall is negative -- the missing six
  // lines total exactly 2477.54 (89.43+1113.65+50.63+629.08+44.30+550.45).
  assertClose(checkpoint.gap, -2477.54, "checkpoint gap");
  assertClose(Math.abs(checkpoint.gap), 2477.54, "checkpoint gap magnitude");
  console.log("PASS: Tata Power, incomplete extraction -- checkpoint gap of 2477.54");
}

// Case 6: complete extraction -- all nine printed charge/tax component
// lines present, plus the "16 CCTV/LED/WIFI Units" box as role "info"
// (it's a unit count printed in its own box, not a charge). The checkpoint
// should close essentially at zero, and the info line must not move the
// checkpoint's actual sum or the top-level billedSum by even a cent.
{
  const lineItems = [
    { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
    { label: "Energy Charges (I)", amount: 7863.5, role: "charge" },
    { label: "PPAC on Fixed Charge (J)", amount: 89.43, role: "charge" },
    { label: "PPAC on Energy Charge (K)", amount: 1113.65, role: "charge" },
    { label: "Surcharge on Fixed Charge (L)", amount: 50.63, role: "charge" },
    { label: "Surcharge on Energy Charge (M)", amount: 629.08, role: "charge" },
    { label: "Pension Trust Charge on Fixed Charge (N)", amount: 44.3, role: "charge" },
    { label: "Pension Trust Charge on Energy Charge (O)", amount: 550.45, role: "charge" },
    { label: "Electricity Tax @ 5% on (G+H+I+K+M)", amount: 480.31, role: "tax" },
    { label: "CCTV/LED/WIFI Units", amount: 16, role: "info" },
    { label: "Net Current Demand", amount: 11454.23, role: "subtotal" },
  ];
  const withoutInfoLine = lineItems.filter((li) => li.role !== "info");
  const resultWithInfo = computeBillChecks(lineItems, 11460.0);
  const resultWithoutInfo = computeBillChecks(withoutInfoLine, 11460.0);

  const checkpoint = resultWithInfo.checkpoints[0];
  assertClose(checkpoint.expected, 11454.23, "checkpoint expected");
  assertClose(checkpoint.actual, 11454.23, "checkpoint actual (all nine component lines)");
  assertClose(checkpoint.gap, 0, "checkpoint gap should be ~0 once every component line is present");

  assertClose(resultWithInfo.billedSum, resultWithoutInfo.billedSum, "info line must not change billedSum");
  assertClose(
    resultWithInfo.checkpoints[0].actual,
    resultWithoutInfo.checkpoints[0].actual,
    "info line must not change the checkpoint's running sum"
  );
  console.log("PASS: Tata Power, complete extraction -- checkpoint gap ~0, CCTV info line ignored in every sum");
}

// Case 7: fabricated gap warning. 11460.00 - 11454.23 = 5.77 exactly -- this
// mirrors the real hallucination found in testing, where the model invented
// a "Lpsc: 5.77" charge line that isn't printed anywhere on the bill, but
// happens to equal the gap between the headline total and the Net Current
// Demand subtotal. Note this also makes the top-level arithmetic check look
// clean (11454.23 + 5.77 = 11460.00) -- which is exactly why the dedicated
// warning matters: the sum check alone would be fooled by it.
{
  const lineItems = [
    { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
    { label: "Energy Charges (I)", amount: 7863.5, role: "charge" },
    { label: "PPAC on Fixed Charge (J)", amount: 89.43, role: "charge" },
    { label: "PPAC on Energy Charge (K)", amount: 1113.65, role: "charge" },
    { label: "Surcharge on Fixed Charge (L)", amount: 50.63, role: "charge" },
    { label: "Surcharge on Energy Charge (M)", amount: 629.08, role: "charge" },
    { label: "Pension Trust Charge on Fixed Charge (N)", amount: 44.3, role: "charge" },
    { label: "Pension Trust Charge on Energy Charge (O)", amount: 550.45, role: "charge" },
    { label: "Electricity Tax @ 5% on (G+H+I+K+M)", amount: 480.31, role: "tax" },
    { label: "Net Current Demand", amount: 11454.23, role: "subtotal" },
    { label: "Lpsc", amount: 5.77, role: "charge" },
  ];
  const result = computeBillChecks(lineItems, 11460.0);

  assert.equal(result.arithmeticIssue, false, "the fabricated line makes the top-level sum look deceptively clean");
  assert.equal(result.warnings.length, 1, "exactly one charge line matches a total-minus-subtotal gap");
  assert.equal(result.warnings[0].lineLabel, "Lpsc");
  assertClose(result.warnings[0].amount, 5.77, "warning amount");
  assert.equal(
    result.warnings[0].message,
    "This amount equals the gap between the total and a subtotal. Check it is actually printed on your bill."
  );
  console.log("PASS: Tata Power, fabricated gap -- Lpsc 5.77 flagged as a suspicious gap");
}

console.log("\nAll bill-checks tests passed.");
