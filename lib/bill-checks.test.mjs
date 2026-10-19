// Smallest runnable check for the money-math in bill-checks.ts. No
// framework -- plain asserts. Run with:
//   node --experimental-strip-types lib/bill-checks.test.mjs
import assert from "node:assert/strict";
import { computeBillChecks, toPersistedLines, removeFirstMatch, parseAmountInput } from "./bill-checks.ts";

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.005, `${message} (got ${actual}, expected ~${expected})`);
}

// Case 1: the real Hemant/Airtel receipt (see chat history -- this is what
// qwen/qwen3.8-27b actually extracted from BILL_Hemant_INTERNETCHARGES_1.jpg).
// Paid 12165.08 against an advance-rental charge of 12023.96, with a 141.12
// outstanding-credit line. This bill's printed "total" field is really the
// paid figure (12165.08) -- the generic arithmetic check would otherwise
// show a confusing "doesn't add up" alongside the payment check, which
// already explains the exact same gap. Expect ONLY the payment message:
// overpaid by 141.12, no arithmetic paragraph, no warnings, no checkpoints.
{
  const lines = [
    { label: "Amount Paid", amount: 12165.08, role: "payment" },
    { label: "ADVANCE_RENTAL_CHARGES", amount: 12023.96, role: "charge" },
    { label: "OUTSTANDING_AMOUNT", amount: 141.12, role: "balance" },
  ];
  const result = computeBillChecks(lines, 12165.08);

  assertClose(result.billedSum, 12023.96, "billedSum should be just the charge line (balance/payment excluded)");
  assert.equal(result.arithmeticIssue, false, "the payment check covers this gap, so it's suppressed here");
  assert.equal(result.arithmeticCoveredByPayment, true, "total equals the paid amount");
  assert.equal(result.checkpoints.length, 0, "no subtotal line in this bill");
  assert.equal(result.warnings.length, 0);
  assert.equal(result.reclassifiedAsBalance.length, 0);
  assert.equal(result.statement, null, "no opening line, no statement check");
  assert.ok(result.payment, "a payment-role line should produce a payment check");
  assertClose(result.payment.amountPaid, 12165.08, "amountPaid");
  assertClose(result.payment.signedDifference, -141.12, "signedDifference");
  assert.equal(result.payment.verdict, "overpaid");
  console.log("PASS: Airtel receipt -- only the overpaid 141.12 message, nothing else");
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

// Case 7: the real raw Lpsc fabrication, position as the model actually
// produced it -- AFTER the Net Current Demand subtotal (see the original
// raw JSON in chat history). Phase 1 made the suspicious-gap warning
// position-aware: it only fires for a line BEFORE the subtotal it would
// bridge to the total, because a line positioned after is exactly where a
// real arrears/LPSC charge legitimately sits, and a real one's amount
// equals that same gap by arithmetic necessity. So this exact historical
// case -- fabricated, but sitting in the legitimate bridging position --
// no longer produces a warning. This is a deliberate, known trade-off (see
// Case 7b below for the position where the warning still does its job);
// nothing else flags it here either (billedSum including Lpsc equals the
// total exactly, and the checkpoint only looks at lines before it).
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

  assert.equal(result.arithmeticIssue, false, "sum including Lpsc still looks deceptively clean");
  assert.equal(result.warnings.length, 0, "Lpsc sits after the subtotal -- the legitimate bridging position");
  assertClose(result.checkpoints[0].gap, 0, "the checkpoint only sees the nine real lines before it");
  console.log("PASS: Tata Power, Lpsc after the subtotal -- no warning (known Phase 1 trade-off)");
}

// Case 7b: the same fabricated value, but positioned BEFORE the subtotal --
// the position the warning is actually meant to catch. Confirms the
// mechanism still works where it's supposed to.
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
    { label: "Lpsc", amount: 5.77, role: "charge" }, // fabricated, BEFORE the subtotal this time
    { label: "Electricity Tax @ 5% on (G+H+I+K+M)", amount: 480.31, role: "tax" },
    { label: "Net Current Demand", amount: 11454.23, role: "subtotal" },
  ];
  const result = computeBillChecks(lineItems, 11460.0);

  assert.equal(result.warnings.length, 1, "Lpsc before the subtotal should still warn");
  assert.equal(result.warnings[0].lineLabel, "Lpsc");
  assertClose(result.warnings[0].amount, 5.77, "warning amount");
  assert.equal(
    result.warnings[0].message,
    "This line makes the total add up exactly. Confirm it is printed on your bill."
  );
  console.log("PASS: Tata Power, Lpsc before the subtotal -- warning still fires");
}

// Case 7c: a REAL arrears-like line after the subtotal, sized so its amount
// exactly equals the gap between total and subtotal (as any single real
// bridging line's amount necessarily would) -- the case the position rule
// exists to protect. Also keeps the unrelated, already-fabricated TOD
// Surcharge (584, before the subtotal) to prove its checkpoint gap and
// remove-suggestion are untouched by this.
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
    { label: "Time of Day (TOD) Surcharge (G)", amount: 584.0, role: "charge" }, // fabricated, before
    { label: "Electricity Tax @ 5% on (G+H+I+K+M)", amount: 480.31, role: "tax" },
    { label: "Net Current Demand", amount: 11454.23, role: "subtotal" },
    { label: "Energy Arrears", amount: 3.58, role: "charge" }, // real, after -- sized to equal the gap
  ];
  const total = 11454.23 + 3.58; // arrears alone reconciles subtotal to total exactly
  const result = computeBillChecks(lineItems, total);

  assert.equal(result.warnings.length, 0, "arrears after the subtotal must not warn, even though it equals the gap");
  assertClose(result.checkpoints[0].gap, 584.0, "the fabricated TOD surcharge still shows up as a checkpoint gap");
  assert.ok(result.checkpoints[0].suggestion, "and still gets a remove-suggestion");
  assert.equal(result.checkpoints[0].suggestion.label, "Time of Day (TOD) Surcharge (G)");
  console.log("PASS: Tata Power, real arrears after subtotal -- no false warning, TOD checkpoint gap unaffected");
}

// Case 8: checkpoint suggestion. The real TOD Surcharge (G) fabrication
// found in testing (chat history) -- the model confidently reusing a real
// printed number (one energy-tariff slab row, 73 units @ Rs 8.00 = 584.00)
// as the amount for an unrelated, separately labelled, actually-blank row.
// Nine real lines (summing to 11454.23) plus that one fabricated 584.00
// charge line pushes actual to 12038.23 against an expected 11454.23 --
// exactly one line (the fabricated one) has an amount equal to the 584.00
// gap, so it should come back as the suggestion.
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
    { label: "Time of Day (TOD) Surcharge (G)", amount: 584.0, role: "charge" },
    { label: "Net Current Demand", amount: 11454.23, role: "subtotal" },
  ];
  const result = computeBillChecks(lineItems, 11460.0);

  assert.equal(result.checkpoints.length, 1);
  const checkpoint = result.checkpoints[0];
  assertClose(checkpoint.actual, 12038.23, "checkpoint actual (nine real lines + the fabricated 584.00)");
  assertClose(checkpoint.gap, 584.0, "checkpoint gap -- actual exceeds expected");
  assert.ok(checkpoint.suggestion, "exactly one line matches the gap, so a suggestion should be returned");
  assert.equal(checkpoint.suggestion.label, "Time of Day (TOD) Surcharge (G)");
  assertClose(checkpoint.suggestion.amount, 584.0, "suggestion amount");
  console.log("PASS: Tata Power, fabricated TOD Surcharge -- checkpoint suggests removing it");
}

// Case 9: Overleaf receipt. The bill prints the same 549.00 subtotal twice
// under two labels ("Subtotal" and "Amount Before Tax") -- simulating the
// model still doing this despite the prompt rule against it. The code-side
// dedup (rule 7) must collapse it to a single checkpoint, not a spurious
// second one with an empty, all-zero section. Expect a clean match end to
// end: no warnings, no issue.
{
  const lineItems = [
    { label: "Standard Monthly Charge", amount: 549.0, role: "charge" },
    { label: "Subtotal", amount: 549.0, role: "subtotal" },
    { label: "Amount Before Tax", amount: 549.0, role: "subtotal" }, // duplicate -- same section, same amount
    { label: "VAT at 19%", amount: 104.31, role: "tax" },
    { label: "Amount Paid", amount: 653.31, role: "payment" },
  ];
  const result = computeBillChecks(lineItems, 653.31);

  assert.equal(result.checkpoints.length, 1, "the duplicate subtotal must not become a second checkpoint");
  assertClose(result.checkpoints[0].gap, 0, "first checkpoint closes cleanly");
  assertClose(result.billedSum, 653.31, "549 + 104.31");
  assert.equal(result.arithmeticIssue, false);
  assert.equal(result.warnings.length, 0, "no warnings");
  assert.equal(result.reclassifiedAsBalance.length, 0);
  assert.ok(result.payment);
  assert.equal(result.payment.verdict, "even");
  console.log("PASS: Overleaf -- duplicate subtotal collapsed to one checkpoint, no warnings");
}

// Case 10: Cookwell/Amazon invoice. Simulates the model also (wrongly)
// extracting the bill's own grand total as a "charge" line labelled "Total
// Amount" -- rule 6's deterministic safety net must reclassify it to
// "balance" (label matches /total|payable|due/i and the amount equals the
// printed total), leaving billedSum as just the real item + tax and the
// bill matching cleanly.
{
  const lineItems = [
    { label: "Juicer-Mixer-Grinder", amount: 1355.08, role: "charge" },
    { label: "GST at 18%", amount: 243.92, role: "tax" },
    { label: "Total Amount", amount: 1599.0, role: "charge" }, // model mistake rule 6 exists to catch
  ];
  const result = computeBillChecks(lineItems, 1599.0);

  assert.equal(result.reclassifiedAsBalance.length, 1, "the Total Amount line should be reclassified");
  assert.equal(result.reclassifiedAsBalance[0].label, "Total Amount");
  assertClose(result.reclassifiedAsBalance[0].amount, 1599.0, "reclassified amount");
  assertClose(result.billedSum, 1599.0, "1355.08 + 243.92, Total Amount excluded");
  assert.equal(result.arithmeticIssue, false, "matches once the duplicate total is reclassified");
  console.log("PASS: Cookwell -- 'Total Amount' reclassified to balance, matches");
}

// Case 11: SBI credit card statement. A statement reconciles differently
// from a one-off bill: closing = opening + charges + tax - discounts -
// payments. The real SBI golden pair has a 32-paise rounding gap (see
// submission doc) -- "matches within rounding" (gap > 0.01 but <= 1.00),
// not a flagged issue, and the generic payment check must be suppressed
// (the statement check already nets out the payment).
{
  const lineItems = [
    { label: "Previous Balance", amount: 93728.41, role: "opening" },
    { label: "Payments", amount: 45000.0, role: "payment" },
    { label: "Purchases/Debits", amount: 41761.76, role: "charge" },
    { label: "Fees/Taxes/Interest", amount: 4555.51, role: "charge" },
  ];
  const result = computeBillChecks(lineItems, 95046.0);

  assert.ok(result.statement, "an opening line should produce a statement check");
  assertClose(result.statement.expectedClosing, 95045.68, "93728.41 + 41761.76 + 4555.51 - 45000");
  assertClose(result.statement.gap, -0.32, "the real 32-paise rounding gap");
  assert.equal(result.statement.issue, false, "within the 1.00 rounding tolerance");
  assert.equal(result.payment, null, "the statement check supersedes the generic payment check");
  assert.equal(result.arithmeticIssue, false, "superseded by the statement check");
  console.log("PASS: SBI statement -- closing matches within rounding, payment check suppressed");
}

// Case 12 (a): Cookwell with the tax-inclusive live numbers -- the item's
// charge line is already the tax-inclusive 1599 (not the pre-tax 1355.08
// the prompt asks for), printed alongside a separate 243.92 tax breakdown,
// plus a duplicate "Total Amount: 1599" charge line (reclassified away by
// the earlier rule). Once reclassified, the remaining charge lines alone
// (1599) already equal the printed total, so the tax-included rule should
// fire: tax excluded from sums, and the note shown.
{
  const lineItems = [
    { label: "Juicer-Mixer-Grinder", amount: 1599.0, role: "charge" },
    { label: "GST at 18%", amount: 243.92, role: "tax" },
    { label: "Total Amount", amount: 1599.0, role: "charge" },
  ];
  const result = computeBillChecks(lineItems, 1599.0);

  assert.equal(result.taxIncludedNote, "Tax appears to be included in the item price.");
  assertClose(result.billedSum, 1599.0, "tax excluded from billedSum");
  assert.equal(result.arithmeticIssue, false, "clean once tax is treated as already included");
  console.log("PASS: Cookwell tax-inclusive -- note shown, clean");
}

// Case 12 (b) negative: the normal, correctly pre-tax Cookwell extraction.
// Charge (1355.08) alone does NOT equal the total (1599), so the rule must
// not fire -- the ordinary charge+tax match applies instead, with no note.
{
  const lineItems = [
    { label: "Juicer-Mixer-Grinder", amount: 1355.08, role: "charge" },
    { label: "GST at 18%", amount: 243.92, role: "tax" },
  ];
  const result = computeBillChecks(lineItems, 1599.0);

  assert.equal(result.taxIncludedNote, null, "the rule must not fire here");
  assertClose(result.billedSum, 1599.0, "1355.08 + 243.92, via the normal path");
  assert.equal(result.arithmeticIssue, false);
  console.log("PASS: Cookwell pre-tax (negative) -- rule doesn't fire, normal match");
}

// Case 12 (c) negative: the Tata fabrication case (Case 8). The charge-only
// sum (8 real charges + the fabricated 584.00) does not equal the printed
// total, so the tax-included rule must not fire, and the checkpoint
// suggestion must still surface the fabricated line.
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
    { label: "Time of Day (TOD) Surcharge (G)", amount: 584.0, role: "charge" },
    { label: "Net Current Demand", amount: 11454.23, role: "subtotal" },
  ];
  const result = computeBillChecks(lineItems, 11460.0);

  assert.equal(result.taxIncludedNote, null, "the rule must not fire here");
  assert.ok(result.checkpoints[0].suggestion, "the checkpoint suggestion must survive");
  assert.equal(result.checkpoints[0].suggestion.label, "Time of Day (TOD) Surcharge (G)");
  console.log("PASS: Tata fabrication (negative) -- tax-included rule doesn't fire, checkpoint warning stays");
}

// Case 13: removeFirstMatch -- two genuinely identical lines (same label,
// same amount) must only lose the first one, never both.
{
  const items = [
    { label: "Duplicate Fee", amount: 10 },
    { label: "Keep Me", amount: 20 },
    { label: "Duplicate Fee", amount: 10 },
  ];
  const result = removeFirstMatch(items, (i) => i.label === "Duplicate Fee" && i.amount === 10);

  assert.equal(result.length, 2, "only one of the two duplicates should be removed");
  assert.equal(result.filter((i) => i.label === "Duplicate Fee").length, 1, "one duplicate must remain");
  assert.equal(result[0].label, "Keep Me", "the first (earliest) match is the one removed, not the second");
  console.log("PASS: removeFirstMatch -- removes only the first of two identical lines");
}

// Case 14: parseAmountInput -- accepts "1,234.56" and "1234.56", rejects
// non-numbers.
{
  assertClose(parseAmountInput("1234.56"), 1234.56, "plain decimal");
  assertClose(parseAmountInput("1,234.56"), 1234.56, "comma thousands separator");
  assertClose(parseAmountInput("  632.88  "), 632.88, "surrounding whitespace");
  assertClose(parseAmountInput("10"), 10, "whole number");
  assert.equal(parseAmountInput("abc"), null, "not a number");
  assert.equal(parseAmountInput(""), null, "empty string");
  assert.equal(parseAmountInput("12.34.56"), null, "malformed decimal");
  assert.equal(parseAmountInput("-5"), null, "negative not accepted -- amounts are positive magnitudes");
  console.log("PASS: parseAmountInput -- accepts comma-formatted numbers, rejects garbage");
}

console.log("\nAll bill-checks tests passed.");
