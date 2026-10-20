// Run with: node lib/gst.test.mjs
import assert from "node:assert/strict";
import {
  computeEffectiveTaxRates,
  findMatchingRate,
  computeTaxBreakdown,
  summarizeTaxBreakdown,
  buildTaxBreakdownAddendum,
  findTaxOvercharge,
} from "./gst.ts";

function rateRow(overrides) {
  return {
    category: null,
    item_keyword: null,
    hsn_prefix: null,
    gst_rate_total: null,
    cgst: null,
    sgst: null,
    igst: null,
    source_url: null,
    effective_from: null,
    ...overrides,
  };
}

// BigBasket-style fixture: CGST 34.76 + SGST 34.76 on a 1390.40 taxable
// base -> 2.5% + 2.5% (5% combined), computed in code, not stated by the LLM.
{
  const lines = [
    { label: "Items", amount: 1390.4, role: "charge" },
    { label: "CGST", amount: 34.76, role: "tax" },
    { label: "SGST", amount: 34.76, role: "tax" },
  ];
  const rates = computeEffectiveTaxRates(lines);

  assert.equal(rates.length, 2);
  const cgst = rates.find((r) => r.label === "CGST");
  const sgst = rates.find((r) => r.label === "SGST");
  assert.ok(Math.abs(cgst.ratePercent - 2.5) < 0.001, `CGST should be ~2.5%, got ${cgst.ratePercent}`);
  assert.ok(Math.abs(sgst.ratePercent - 2.5) < 0.001, `SGST should be ~2.5%, got ${sgst.ratePercent}`);
  assert.ok(Math.abs(cgst.ratePercent + sgst.ratePercent - 5) < 0.001, "combined should be ~5%");
  console.log("PASS: computeEffectiveTaxRates -- BigBasket CGST+SGST on taxable base -> 2.5% + 2.5% = 5%");
}

// No charge lines (or a non-positive taxable base) -- no rates computed,
// never a divide-by-zero or a guessed figure.
{
  const rates = computeEffectiveTaxRates([{ label: "GST", amount: 10, role: "tax" }]);
  assert.deepEqual(rates, []);
  console.log("PASS: computeEffectiveTaxRates returns nothing when there's no taxable base to divide by");
}

// findMatchingRate -- category guessing ALONE is never enough: a printed
// HSN code matching a seeded hsn_prefix is required, every time.
{
  const rates = [
    rateRow({ category: "appliance", gst_rate_total: null }), // unsourced TODO row -- never matched
    rateRow({ category: "appliance", hsn_prefix: "8471", gst_rate_total: 18, cgst: 9, sgst: 9, source_url: "https://cbic.gov.in/x", effective_from: "2026-01-01" }),
    rateRow({ category: "appliance", hsn_prefix: "8509", gst_rate_total: 18, cgst: 9, sgst: 9, source_url: "https://cbic.gov.in/y", effective_from: "2026-01-01" }),
  ];

  const matched = findMatchingRate(rates, "appliance", ["85094090"]);
  assert.equal(matched.hsn_prefix, "8509", "a printed code matching a seeded prefix (by startsWith) matches");

  const noCodePrinted = findMatchingRate(rates, "appliance", []);
  assert.equal(noCodePrinted, null, "no printed code at all -- never matched, category guessing alone is not enough");

  const codeDoesntMatchAnyPrefix = findMatchingRate(rates, "appliance", ["1234"]);
  assert.equal(codeDoesntMatchAnyPrefix, null, "a printed code that matches no seeded prefix -- no match");

  const unknownCategory = findMatchingRate(rates, "other", ["8509"]);
  assert.equal(unknownCategory, null, "category 'other' is never matched, even with a printed code");

  const nullCategory = findMatchingRate(rates, null, ["8509"]);
  assert.equal(nullCategory, null, "a null category is never matched either");

  console.log("PASS: findMatchingRate requires BOTH a known category and a printed code matching a seeded hsn_prefix");
}

// computeTaxBreakdown -- Phase 1 test 1: the HP gas bill. Base 924.76,
// CGST 2.5% (23.12), SGST 2.5% (23.12), total 971, NO HSN printed. Even
// with a seeded groceries rate that would otherwise "match", no printed
// code means no comparison at all -- expected_rate must be null and the
// summary must stay plain, neutral info.
{
  const lines = [
    { label: "Base Price", amount: 924.76, role: "charge" },
    { label: "CGST", amount: 23.12, role: "tax" },
    { label: "SGST", amount: 23.12, role: "tax" },
  ];
  const rates = [rateRow({ category: "groceries", hsn_prefix: "2716", gst_rate_total: 5, cgst: 2.5, sgst: 2.5, source_url: "https://cbic.gov.in/x" })];
  const breakdown = computeTaxBreakdown(lines, "groceries", rates, []); // no printed_hsn_codes

  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0].expected_rate, null, "no printed HSN -- never compared, even though the rate would've matched");
  const summary = summarizeTaxBreakdown(breakdown);
  assert.equal(summary, "Tax: 5.00% GST", "plain, neutral info only -- no 'expected'/'flagged' wording");
  const addendum = buildTaxBreakdownAddendum(breakdown, null);
  assert.ok(!/-- CONFIRMED higher/.test(addendum), "chat facts carry no confirmed-finding line");
  assert.ok(!/higher than the expected \d/i.test(addendum), "chat facts state no expected-rate figure");
  console.log("PASS: HP gas bill -- no printed HSN -> no tax mismatch anywhere, chat facts carry no expected-rate line");
}

// computeTaxBreakdown -- Phase 1 test 2: a printed HSN matching a seeded
// row, and a HIGHER billed rate -- the only case that ever produces a finding.
{
  const lines = [
    { label: "Items", amount: 1000, role: "charge" },
    { label: "CGST", amount: 90, role: "tax" },
    { label: "SGST", amount: 90, role: "tax" },
  ];
  const rates = [rateRow({ category: "groceries", hsn_prefix: "2106", gst_rate_total: 5, cgst: 2.5, sgst: 2.5, source_url: "https://cbic.gov.in/x" })];
  const breakdown = computeTaxBreakdown(lines, "groceries", rates, ["21069099"]);

  assert.equal(breakdown[0].expected_rate, 5, "printed HSN matched, billed rate (18%) is confirmed higher -- finding surfaces");
  assert.ok(/flagged/i.test(summarizeTaxBreakdown(breakdown)));
  assert.ok(/CONFIRMED/.test(buildTaxBreakdownAddendum(breakdown, rates[0])));
  console.log("PASS: printed HSN + higher-than-expected rate -- finding surfaces everywhere");
}

// computeTaxBreakdown -- Phase 1 test 3: a printed HSN matching a seeded
// row, but a LOWER billed rate -- never reported anywhere.
{
  const lines = [
    { label: "Items", amount: 1000, role: "charge" },
    { label: "CGST", amount: 25, role: "tax" },
    { label: "SGST", amount: 25, role: "tax" },
  ];
  const rates = [rateRow({ category: "appliance", hsn_prefix: "8509", gst_rate_total: 18, cgst: 9, sgst: 9, source_url: "https://cbic.gov.in/x" })];
  const breakdown = computeTaxBreakdown(lines, "appliance", rates, ["85094090"]);

  assert.equal(breakdown[0].expected_rate, null, "billed rate (5%) is LOWER than expected (18%) -- never reported");
  assert.equal(summarizeTaxBreakdown(breakdown), "Tax: 5.00% GST");
  const addendum = buildTaxBreakdownAddendum(breakdown, rates[0]);
  assert.ok(!/-- CONFIRMED higher/.test(addendum), "no confirmed finding when the billed rate is lower");
  assert.ok(!/higher than the expected \d/i.test(addendum));
  console.log("PASS: printed HSN + lower-than-expected rate -- nothing reported anywhere");
}

// computeTaxBreakdown -- Cookwell: a single combined tax line, 243.92 on
// 1355.08 -> 18%, with a printed HSN matching the seeded appliance rate
// exactly (no overcharge) -- falls into "other" but stays neutral.
{
  const lines = [
    { label: "Juicer-Mixer-Grinder", amount: 1355.08, role: "charge" },
    { label: "GST at 18%", amount: 243.92, role: "tax" },
  ];
  const rates = [rateRow({ category: "appliance", hsn_prefix: "8509", gst_rate_total: 18, source_url: "https://cbic.gov.in/x" })];
  const breakdown = computeTaxBreakdown(lines, "appliance", rates, ["8509"]);

  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0].tax_type, "other");
  assert.ok(Math.abs(breakdown[0].effective_rate - 18) < 0.01);
  assert.equal(breakdown[0].expected_rate, null, "an exact match is never a 'finding' -- no expected_rate exposed");
  console.log("PASS: Cookwell -- single combined tax line at 18%, exact match stays neutral (no finding)");
}

// computeTaxBreakdown -- Overleaf: VAT 19%, never compared against Indian GST.
{
  const lines = [
    { label: "Standard Monthly Charge", amount: 549.0, role: "charge" },
    { label: "VAT at 19%", amount: 104.31, role: "tax" },
  ];
  const breakdown = computeTaxBreakdown(lines, "software", []);

  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0].tax_type, "vat");
  assert.equal(breakdown[0].expected_rate, null);
  assert.ok(/not Indian GST/i.test(breakdown[0].note));
  console.log("PASS: Overleaf -- VAT 19%, no Indian GST comparison");
}

// computeTaxBreakdown -- Tata Power: Electricity Tax, a state levy, never
// compared against GST.
{
  const lines = [
    { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
    { label: "Electricity Tax @ 5% on (G+H+I+K+M)", amount: 31.64, role: "tax" },
  ];
  const breakdown = computeTaxBreakdown(lines, "electricity", []);

  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0].tax_type, "electricity_duty");
  assert.equal(breakdown[0].expected_rate, null);
  assert.ok(/state electricity duty/i.test(breakdown[0].note));
  console.log("PASS: Tata Power -- Electricity Tax is a state levy, no GST comparison");
}

// computeTaxBreakdown -- an unequal CGST/SGST pair is flagged on its own,
// independent of any HSN/reference-rate comparison.
{
  const lines = [
    { label: "Items", amount: 1000, role: "charge" },
    { label: "CGST", amount: 90, role: "tax" },
    { label: "SGST", amount: 50, role: "tax" },
  ];
  const breakdown = computeTaxBreakdown(lines, "groceries", [], ["2106"]);
  assert.ok(/should be equal but aren't/i.test(breakdown[0].note));
  console.log("PASS: an unequal CGST/SGST pair is flagged");
}

// findTaxOvercharge -- Phase 3: the possible excess is taxable amount x
// (billed rate - expected rate). 1000 taxable, 18% billed vs 5% expected
// -> 13 percentage points x 1000 / 100 = Rs 130 excess.
{
  const lines = [
    { label: "Items", amount: 1000, role: "charge" },
    { label: "CGST", amount: 90, role: "tax" },
    { label: "SGST", amount: 90, role: "tax" },
  ];
  const rates = [rateRow({ category: "groceries", hsn_prefix: "2106", gst_rate_total: 5, source_url: "https://cbic.gov.in/x" })];
  const finding = findTaxOvercharge(lines, "groceries", rates, ["21069099"]);

  assert.ok(finding);
  assert.equal(finding.label, "CGST + SGST");
  assertClose(finding.billedAmount, 180);
  assertClose(finding.effectiveRatePercent, 18);
  assert.equal(finding.expectedRatePercent, 5);
  assert.equal(finding.hsnPrefix, "2106");
  assertClose(finding.possibleExcess, 130, "1000 * (18 - 5) / 100 = 130");
  console.log("PASS: findTaxOvercharge computes the possible excess as taxable amount x rate difference");
}

// findTaxOvercharge -- no printed HSN, no finding, null.
{
  const lines = [
    { label: "Base Price", amount: 924.76, role: "charge" },
    { label: "CGST", amount: 23.12, role: "tax" },
    { label: "SGST", amount: 23.12, role: "tax" },
  ];
  const rates = [rateRow({ category: "groceries", hsn_prefix: "2716", gst_rate_total: 5 })];
  assert.equal(findTaxOvercharge(lines, "groceries", rates, []), null, "HP gas bill -- no printed HSN, no finding");
  console.log("PASS: findTaxOvercharge returns null for the HP gas bill (no printed HSN)");
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.01, message ?? `expected ~${expected}, got ${actual}`);
}

console.log("\nAll gst tests passed.");
