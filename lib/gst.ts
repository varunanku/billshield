// GST reference (Phase 4, hardened later) -- pure, no network. Every rate
// a bill actually shows is computed here (tax / taxable base), in code,
// never asked of the LLM. A seeded category_rates row is reference
// context only, and is NEVER compared against unless the bill itself
// prints an HSN/SAC code that matches that row's hsn_prefix -- a category
// alone (LLM-assigned, a closed-list guess) is never enough to accuse a
// bill of being wrong. Even then, the only thing this app ever surfaces
// is a CONFIRMED overcharge (billed rate higher than the expected one,
// beyond a small rounding tolerance): a lower-than-expected billed rate,
// or an exact match, produces no message anywhere (hard rule 5 -- the app
// can't confirm legal/policy correctness, and "you paid too little tax"
// is not this app's business to suggest).
import type { BillLine } from "./bill-checks.ts";

export type EffectiveTaxRate = {
  label: string;
  amount: number;
  taxableBase: number;
  ratePercent: number; // amount / taxableBase * 100
};

// taxableBase is the sum of charge lines minus discounts -- the same
// billedSum-minus-tax figure computeBillChecks already implies, just
// isolated here so each tax line's own rate can be read off directly
// (e.g. a bill with CGST 34.76 + SGST 34.76 on a 1390.40 taxable base ->
// 2.5% + 2.5%, computed, never asked of the model).
export function computeEffectiveTaxRates(lines: BillLine[]): EffectiveTaxRate[] {
  const taxableBase =
    lines.filter((l) => l.role === "charge").reduce((s, l) => s + l.amount, 0) -
    lines.filter((l) => l.role === "discount").reduce((s, l) => s + l.amount, 0);
  if (taxableBase <= 0) return [];
  return lines
    .filter((l) => l.role === "tax")
    .map((l) => ({ label: l.label, amount: l.amount, taxableBase, ratePercent: (l.amount / taxableBase) * 100 }));
}

export type CategoryRate = {
  category: string;
  item_keyword: string | null;
  hsn_prefix: string | null;
  gst_rate_total: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  source_url: string | null;
  effective_from: string | null;
};

// Digits only -- a printed code may include spaces/dashes ("8509 00"),
// and a seeded hsn_prefix is always plain digits.
function normalizeHsn(code: string): string {
  return code.replace(/\D/g, "");
}

// The ONLY way a seeded reference rate is ever matched to a bill: the
// bill's own category (never "other"/unknown -- that's still a guess,
// just a coarser one) AND at least one code the bill itself printed
// (never inferred) whose digits start with a seeded row's hsn_prefix.
// Category-only matching (the old behaviour) is intentionally gone --
// it's exactly the "category guessing" this was tightened against.
export function findMatchingRate(rates: CategoryRate[], category: string | null, printedHsnCodes: string[]): CategoryRate | null {
  if (!category || category === "other") return null;
  const normalizedCodes = printedHsnCodes.map(normalizeHsn).filter((c) => c.length > 0);
  if (normalizedCodes.length === 0) return null;

  const sourced = rates.filter((r) => r.category === category && r.gst_rate_total !== null && r.hsn_prefix);
  return (
    sourced.find((r) => {
      const prefix = normalizeHsn(r.hsn_prefix!);
      return prefix.length > 0 && normalizedCodes.some((code) => code.startsWith(prefix));
    }) ?? null
  );
}

// --- Tax line recognition and rate verification ------------------------
//
// Every tax line keeps its exact printed label (see EXTRACTION_PROMPT) --
// classification below is purely pattern-matching on that label, never a
// relabelling. A CGST+SGST pair is the common in-state Indian GST split;
// UTGST replaces SGST in a Union Territory; IGST is the inter-state
// equivalent, charged as one line; VAT and electricity duty are real
// taxes this app can still verify arithmetically, but never compares
// against Indian GST, since they aren't GST at all.
export type TaxGroupType = "cgst_sgst" | "utgst" | "igst" | "vat" | "electricity_duty" | "other";

export type TaxBreakdown = {
  tax_type: TaxGroupType;
  effective_rate: number; // percent, computed from this bill's own figures
  // Set ONLY when a printed HSN code matched a seeded reference rate for
  // this bill's category AND the billed rate is confirmed higher than
  // that reference, beyond RATE_TOLERANCE_POINTS -- i.e. a confirmed
  // overcharge finding. Null in every other case: no printed code, no
  // match, an exact match, or a LOWER billed rate -- none of those are
  // ever reported anywhere (no "expected" text, no chat mention).
  expected_rate: number | null;
  note: string;
};

// Percentage-point tolerance for "confirmed higher" -- real GST slabs
// (5/12/18/28) are far enough apart that this only absorbs rounding,
// never papers over a real slab-level overcharge.
const RATE_TOLERANCE_POINTS = 0.5;

const CGST_LABEL = /\bcgst\b/i;
const SGST_LABEL = /\bsgst\b/i;
const UTGST_LABEL = /\butgst\b/i;
const IGST_LABEL = /\bigst\b/i;
const VAT_LABEL = /\bvat\b/i;
const ELECTRICITY_LABEL = /electricity\s*(tax|duty)/i;

function rateOf(rates: EffectiveTaxRate[], pattern: RegExp): EffectiveTaxRate | undefined {
  return rates.find((r) => pattern.test(r.label));
}

// true only when there's a reference rate AND the bill's own rate is
// confirmedly higher than it -- the one and only condition this app ever
// surfaces as a finding (see the file header).
function isConfirmedOvercharge(effectiveRate: number, referenceRate: number | null): boolean {
  return referenceRate !== null && effectiveRate - referenceRate > RATE_TOLERANCE_POINTS;
}

export function computeTaxBreakdown(
  lines: BillLine[],
  category: string | null,
  rates: CategoryRate[],
  printedHsnCodes: string[] = []
): TaxBreakdown[] {
  const effectiveRates = computeEffectiveTaxRates(lines);
  const matchingRate = findMatchingRate(rates, category, printedHsnCodes);
  const expectedTotal = matchingRate?.gst_rate_total ?? null;
  const expectedIgst = matchingRate?.igst ?? null;

  const breakdown: TaxBreakdown[] = [];
  const handled = new Set<EffectiveTaxRate>();

  const cgst = rateOf(effectiveRates, CGST_LABEL);
  const sgst = rateOf(effectiveRates, SGST_LABEL);
  const utgst = rateOf(effectiveRates, UTGST_LABEL);

  if (cgst && sgst) {
    handled.add(cgst).add(sgst);
    const ratesEqual = Math.abs(cgst.ratePercent - sgst.ratePercent) <= RATE_TOLERANCE_POINTS;
    const effective = cgst.ratePercent + sgst.ratePercent;
    const overcharge = isConfirmedOvercharge(effective, expectedTotal);
    breakdown.push({
      tax_type: "cgst_sgst",
      effective_rate: effective,
      expected_rate: overcharge ? expectedTotal : null,
      note: !ratesEqual
        ? `CGST (${cgst.ratePercent.toFixed(2)}%) and SGST (${sgst.ratePercent.toFixed(2)}%) should be equal but aren't -- worth checking.`
        : overcharge
          ? `CGST ${cgst.ratePercent.toFixed(2)}% + SGST ${sgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST -- higher than the expected ${expectedTotal}% for this HSN/category.`
          : `CGST ${cgst.ratePercent.toFixed(2)}% + SGST ${sgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST.`,
    });
  } else if (utgst) {
    handled.add(utgst);
    if (cgst) handled.add(cgst);
    const effective = (cgst?.ratePercent ?? 0) + utgst.ratePercent;
    const overcharge = isConfirmedOvercharge(effective, expectedTotal);
    const prefix = cgst ? `CGST ${cgst.ratePercent.toFixed(2)}% + ` : "";
    breakdown.push({
      tax_type: "utgst",
      effective_rate: effective,
      expected_rate: overcharge ? expectedTotal : null,
      note: overcharge
        ? `${prefix}UTGST ${utgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST -- higher than the expected ${expectedTotal}% for this HSN/category.`
        : `${prefix}UTGST ${utgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST.`,
    });
  }

  const igst = rateOf(effectiveRates, IGST_LABEL);
  if (igst && !handled.has(igst)) {
    handled.add(igst);
    const overcharge = isConfirmedOvercharge(igst.ratePercent, expectedIgst);
    breakdown.push({
      tax_type: "igst",
      effective_rate: igst.ratePercent,
      expected_rate: overcharge ? expectedIgst : null,
      note: overcharge
        ? `IGST ${igst.ratePercent.toFixed(2)}% -- higher than the expected ${expectedIgst}% for this HSN/category.`
        : `IGST ${igst.ratePercent.toFixed(2)}%.`,
    });
  }

  for (const rate of effectiveRates) {
    if (handled.has(rate)) continue;
    if (VAT_LABEL.test(rate.label)) {
      handled.add(rate);
      breakdown.push({
        tax_type: "vat",
        effective_rate: rate.ratePercent,
        expected_rate: null,
        note: `${rate.label} ${rate.ratePercent.toFixed(2)}% -- a foreign VAT, not Indian GST. No comparison applied.`,
      });
    } else if (ELECTRICITY_LABEL.test(rate.label)) {
      handled.add(rate);
      breakdown.push({
        tax_type: "electricity_duty",
        effective_rate: rate.ratePercent,
        expected_rate: null,
        note: `${rate.label} ${rate.ratePercent.toFixed(2)}% -- a state electricity duty, not GST. No comparison applied.`,
      });
    }
  }

  // Whatever's left (a single combined "GST"/"Tax" line, Service Tax,
  // Sales Tax, Cess, ...) is still a GST-style tax worth comparing against
  // the category's expected total -- many bills show one combined rate
  // rather than a split CGST+SGST pair.
  for (const rate of effectiveRates) {
    if (handled.has(rate)) continue;
    const overcharge = isConfirmedOvercharge(rate.ratePercent, expectedTotal);
    breakdown.push({
      tax_type: "other",
      effective_rate: rate.ratePercent,
      expected_rate: overcharge ? expectedTotal : null,
      note: overcharge
        ? `${rate.label} ${rate.ratePercent.toFixed(2)}% -- higher than the expected ${expectedTotal}% for this HSN/category.`
        : `${rate.label} ${rate.ratePercent.toFixed(2)}%.`,
    });
  }

  return breakdown;
}

// Short line for the review/verdict screen -- one clause per tax group,
// joined, built directly from the breakdown's own fields (never by
// re-parsing `note`). Plain and neutral ("Tax: 5.00% GST") unless a
// confirmed overcharge exists, in which case (and ONLY then) it names the
// expected rate.
const TAX_TYPE_LABEL: Record<TaxGroupType, string> = {
  cgst_sgst: "GST",
  utgst: "GST",
  igst: "IGST",
  vat: "VAT",
  electricity_duty: "Electricity Duty",
  other: "Tax",
};

export function summarizeTaxBreakdown(breakdown: TaxBreakdown[]): string | null {
  if (breakdown.length === 0) return null;
  return (
    "Tax: " +
    breakdown
      .map((b) => {
        const rate = `${b.effective_rate.toFixed(2)}% ${TAX_TYPE_LABEL[b.tax_type]}`;
        if (b.tax_type === "vat") return `${rate} (not Indian GST)`;
        if (b.tax_type === "electricity_duty") return `${rate} (state levy, not GST)`;
        if (b.expected_rate !== null) return `${rate} (higher than the expected ${b.expected_rate}% -- flagged)`;
        return rate;
      })
      .join("; ")
  );
}

// The block appended to the follow-up chat's system prompt. Only ever
// states an expected/reference rate for a group with a CONFIRMED
// overcharge (expected_rate !== null) -- every other group is handed to
// the model as a plain computed figure with explicit instructions never
// to compare it, guess a reference, or suggest the bill undercharged.
export function buildTaxBreakdownAddendum(breakdown: TaxBreakdown[], matchingRate: CategoryRate | null): string {
  if (breakdown.length === 0) return "";

  const lines = breakdown.map((b) => {
    const label = TAX_TYPE_LABEL[b.tax_type];
    if (b.expected_rate !== null) {
      const sourcePart = matchingRate?.source_url ? ` (source: ${matchingRate.source_url})` : "";
      const hsnPart = matchingRate?.hsn_prefix ? ` for HSN ${matchingRate.hsn_prefix}` : "";
      return `- ${label}: ${b.effective_rate.toFixed(2)}% (computed from this bill's own figures) -- CONFIRMED higher than the expected ${b.expected_rate}%${hsnPart}${sourcePart}. This is a confirmed finding you may mention.`;
    }
    if (b.tax_type === "vat") {
      return `- ${label}: ${b.effective_rate.toFixed(2)}% -- a foreign VAT, not Indian GST. Never compare it to a GST rate.`;
    }
    if (b.tax_type === "electricity_duty") {
      return `- ${label}: ${b.effective_rate.toFixed(2)}% -- a state-level electricity duty, not GST. Never compare it to a GST rate.`;
    }
    return `- ${label}: ${b.effective_rate.toFixed(2)}% (computed from this bill's own figures). No confirmed reference for this line -- if asked whether this rate is correct, say there's no confirmed reference, never guess or invent a comparison figure.`;
  });

  return `\n\nTax breakdown, computed from this bill's own printed figures (never invented or recomputed by you):\n${lines.join(
    "\n"
  )}\n\nHard rules for tax: never say a bill was undercharged; never suggest the user should have paid more tax; never state an expected rate or a rate difference for any line above that isn't explicitly marked "CONFIRMED"; if a tax question can't be answered from the lines above, say so plainly rather than guessing.`;
}
