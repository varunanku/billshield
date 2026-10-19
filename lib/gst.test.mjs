// Run with: node lib/gst.test.mjs
import assert from "node:assert/strict";
import { computeEffectiveTaxRates, findMatchingRate, buildGstAddendum } from "./gst.ts";

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

console.log("\nAll gst tests passed.");
