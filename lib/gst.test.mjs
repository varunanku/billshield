// Run with: node lib/gst.test.mjs
import assert from "node:assert/strict";
import {
  computeEffectiveTaxRates,
  findMatchingRate,
  buildGstAddendum,
  computeTaxBreakdown,
  summarizeTaxBreakdown,
  buildTaxBreakdownAddendum,
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

// findMatchingRate -- prefers an item_keyword match over a bare category
// match, and ignores unsourced (gst_rate_total: null) TODO placeholder rows.
{
  const rates = [
    { category: "appliance", item_keyword: null, hsn_prefix: null, gst_rate_total: null, cgst: null, sgst: null, igst: null, source_url: null, effective_from: null },
    { category: "appliance", item_keyword: "laptop", hsn_prefix: "8471", gst_rate_total: 18, cgst: 9, sgst: 9, igst: null, source_url: "https://cbic.gov.in/x", effective_from: "2026-01-01" },
    { category: "appliance", item_keyword: null, hsn_prefix: null, gst_rate_total: 12, cgst: 6, sgst: 6, igst: null, source_url: "https://cbic.gov.in/y", effective_from: "2026-01-01" },
  ];
  const match = findMatchingRate(rates, "appliance", ["Dell Laptop Purchase", "GST"]);
  assert.equal(match.item_keyword, "laptop", "the keyword match should win over the bare category match");

  const noKeywordHit = findMatchingRate(rates, "appliance", ["Microwave Oven"]);
  assert.equal(noKeywordHit.gst_rate_total, 12, "falls back to the sourced bare-category row when no keyword matches");

  const noCategory = findMatchingRate(rates, "electricity", ["Fixed Charge"]);
  assert.equal(noCategory, null, "no rows for this category at all");

  console.log("PASS: findMatchingRate prefers a keyword match, falls back sensibly, ignores unsourced rows");
}

// buildGstAddendum -- the no-reference-rate wording is honest, not a guess.
{
  const rates = computeEffectiveTaxRates([
    { label: "Items", amount: 1390.4, role: "charge" },
    { label: "CGST", amount: 34.76, role: "tax" },
  ]);
  const addendum = buildGstAddendum(rates, null);
  assert.ok(addendum.includes("2.50%"));
  assert.ok(/no reference rate/i.test(addendum));
  console.log("PASS: buildGstAddendum states the computed rate and admits no reference rate exists");
}

// computeTaxBreakdown -- BigBasket: CGST 34.76 + SGST 34.76 on ~1390.40 ->
// 2.5% + 2.5% = 5% total, matching the seeded groceries rate.
{
  const lines = [
    { label: "Items", amount: 1390.4, role: "charge" },
    { label: "CGST", amount: 34.76, role: "tax" },
    { label: "SGST", amount: 34.76, role: "tax" },
  ];
  const rates = [rateRow({ category: "groceries", gst_rate_total: 5, cgst: 2.5, sgst: 2.5, hsn_prefix: "2106", source_url: "https://cbic.gov.in/notif-09-2025", effective_from: "2025-09-22" })];
  const breakdown = computeTaxBreakdown(lines, "groceries", rates);

  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0].tax_type, "cgst_sgst");
  assert.ok(Math.abs(breakdown[0].effective_rate - 5) < 0.01);
  assert.equal(breakdown[0].expected_rate, 5);
  assert.equal(breakdown[0].rate_matches, true);
  assert.ok(summarizeTaxBreakdown(breakdown).includes("matches"));
  assert.ok(buildTaxBreakdownAddendum(breakdown, rates[0]).includes("HSN 2106"));
  console.log("PASS: BigBasket -- CGST 2.5% + SGST 2.5% = 5%, matches groceries rate");
}

// computeTaxBreakdown -- Cookwell: a single combined tax line, 243.92 on
// 1355.08 -> 18%, matching the seeded appliance rate (no CGST/SGST split
// to detect, so it falls into "other" but is still rate-compared).
{
  const lines = [
    { label: "Juicer-Mixer-Grinder", amount: 1355.08, role: "charge" },
    { label: "GST at 18%", amount: 243.92, role: "tax" },
  ];
  const rates = [rateRow({ category: "appliance", gst_rate_total: 18, source_url: "https://cbic.gov.in/x" })];
  const breakdown = computeTaxBreakdown(lines, "appliance", rates);

  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0].tax_type, "other");
  assert.ok(Math.abs(breakdown[0].effective_rate - 18) < 0.01);
  assert.equal(breakdown[0].rate_matches, true);
  console.log("PASS: Cookwell -- single combined tax line at 18%, matches appliance rate");
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
  assert.equal(breakdown[0].rate_matches, null);
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

// computeTaxBreakdown -- mismatch: CGST 9% + SGST 9% on a groceries bill
// (expected 5%) must flag, not silently pass.
{
  const lines = [
    { label: "Items", amount: 1000, role: "charge" },
    { label: "CGST", amount: 90, role: "tax" },
    { label: "SGST", amount: 90, role: "tax" },
  ];
  const rates = [rateRow({ category: "groceries", gst_rate_total: 5 })];
  const breakdown = computeTaxBreakdown(lines, "groceries", rates);

  assert.equal(breakdown[0].tax_type, "cgst_sgst");
  assert.ok(Math.abs(breakdown[0].effective_rate - 18) < 0.01);
  assert.equal(breakdown[0].expected_rate, 5);
  assert.equal(breakdown[0].rate_matches, false);
  assert.ok(/expected 5/i.test(breakdown[0].note));
  console.log("PASS: mismatch -- CGST 9% + SGST 9% on groceries flags expected 5%, found 18%");
}

// computeTaxBreakdown -- an unequal CGST/SGST pair is flagged on its own,
// independent of whether a reference rate exists at all.
{
  const lines = [
    { label: "Items", amount: 1000, role: "charge" },
    { label: "CGST", amount: 90, role: "tax" },
    { label: "SGST", amount: 50, role: "tax" },
  ];
  const breakdown = computeTaxBreakdown(lines, "groceries", []);
  assert.ok(/should be equal but aren't/i.test(breakdown[0].note));
  console.log("PASS: an unequal CGST/SGST pair is flagged");
}

console.log("\nAll gst tests passed.");
