// GST reference (Phase 4) -- pure, no network. Every rate a bill actually
// shows is computed here (tax / taxable base), in code, never asked of
// the LLM. A seeded category_rates row is reference context only: the
// chat may mention it alongside the computed rate and its source, never
// as a replacement for the computed one, and never as a claim the bill's
// own rate is correct or incorrect (hard rule 5 -- the app can't confirm
// legal/policy correctness, only arithmetic).
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

// Picks the single best reference row for this bill, if any: an
// item_keyword match (against any tax/charge line label) beats a bare
// category match, and a row with no sourced rate (gst_rate_total null --
// a seeded TODO placeholder) is never returned, since it has nothing
// useful to say.
export function findMatchingRate(rates: CategoryRate[], category: string | null, lineLabels: string[]): CategoryRate | null {
  const sourced = rates.filter((r) => r.category === category && r.gst_rate_total !== null);
  if (sourced.length === 0) return null;

  const lowerLabels = lineLabels.map((l) => l.toLowerCase());
  const keywordMatch = sourced.find((r) => r.item_keyword && lowerLabels.some((l) => l.includes(r.item_keyword!.toLowerCase())));
  if (keywordMatch) return keywordMatch;

  // No keyword matched -- prefer a bare (no item_keyword) category-wide
  // row as the generic fallback over some other keyword-specific row that
  // just happened not to match this bill.
  const bareMatch = sourced.find((r) => !r.item_keyword);
  return bareMatch ?? sourced[0];
}

// The block appended to the follow-up chat's system prompt -- the model
// is handed the computed rate(s) and the matching reference (if any) as
// plain facts, same as every other number in that prompt.
export function buildGstAddendum(effectiveRates: EffectiveTaxRate[], matchingRate: CategoryRate | null): string {
  if (effectiveRates.length === 0) return "";

  const computed = effectiveRates
    .map((r) => `- ${r.label}: Rs ${r.amount.toFixed(2)} on a taxable base of Rs ${r.taxableBase.toFixed(2)} = ${r.ratePercent.toFixed(2)}%`)
    .join("\n");

  const reference = matchingRate
    ? `Reference GST rate for this category${matchingRate.item_keyword ? ` (${matchingRate.item_keyword})` : ""}: ${matchingRate.gst_rate_total}% (source: ${matchingRate.source_url ?? "not given"}).`
    : "No seeded reference rate matches this bill's category -- if asked, say the bill shows the computed rate above and the app has no reference rate for this item, rather than guessing whether it's correct.";

  return `\n\nGST rates computed from this bill's own printed figures (tax / taxable amount), never invented:\n${computed}\n\n${reference}`;
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
  effective_rate: number; // percent
  expected_rate: number | null; // percent, from category_rates -- null when there's nothing to compare against
  rate_matches: boolean | null; // null when expected_rate is null (nothing to compare)
  note: string;
};

// Percentage-point tolerance for "matches" -- real GST slabs (5/12/18/28)
// are far enough apart that this only absorbs rounding, never papers over
// a real slab mismatch (e.g. 5% vs 18%).
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

export function computeTaxBreakdown(lines: BillLine[], category: string | null, rates: CategoryRate[]): TaxBreakdown[] {
  const effectiveRates = computeEffectiveTaxRates(lines);
  const lineLabels = lines.map((l) => l.label);
  const matchingRate = findMatchingRate(rates, category, lineLabels);
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
    const matches = expectedTotal !== null ? Math.abs(effective - expectedTotal) <= RATE_TOLERANCE_POINTS : null;
    breakdown.push({
      tax_type: "cgst_sgst",
      effective_rate: effective,
      expected_rate: expectedTotal,
      rate_matches: matches,
      note: !ratesEqual
        ? `CGST (${cgst.ratePercent.toFixed(2)}%) and SGST (${sgst.ratePercent.toFixed(2)}%) should be equal but aren't -- worth checking.`
        : matches === null
          ? `CGST ${cgst.ratePercent.toFixed(2)}% + SGST ${sgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST. No reference rate for this category.`
          : matches
            ? `CGST ${cgst.ratePercent.toFixed(2)}% + SGST ${sgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST, matching the expected rate for this category.`
            : `CGST ${cgst.ratePercent.toFixed(2)}% + SGST ${sgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST -- expected ${expectedTotal}% for this category.`,
    });
  } else if (utgst) {
    handled.add(utgst);
    if (cgst) handled.add(cgst);
    const effective = (cgst?.ratePercent ?? 0) + utgst.ratePercent;
    const matches = expectedTotal !== null ? Math.abs(effective - expectedTotal) <= RATE_TOLERANCE_POINTS : null;
    breakdown.push({
      tax_type: "utgst",
      effective_rate: effective,
      expected_rate: expectedTotal,
      rate_matches: matches,
      note:
        matches === null
          ? `${cgst ? `CGST ${cgst.ratePercent.toFixed(2)}% + ` : ""}UTGST ${utgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST. No reference rate for this category.`
          : matches
            ? `${cgst ? `CGST ${cgst.ratePercent.toFixed(2)}% + ` : ""}UTGST ${utgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST, matching the expected rate for this category.`
            : `${cgst ? `CGST ${cgst.ratePercent.toFixed(2)}% + ` : ""}UTGST ${utgst.ratePercent.toFixed(2)}% = ${effective.toFixed(2)}% total GST -- expected ${expectedTotal}% for this category.`,
    });
  }

  const igst = rateOf(effectiveRates, IGST_LABEL);
  if (igst && !handled.has(igst)) {
    handled.add(igst);
    const matches = expectedIgst !== null ? Math.abs(igst.ratePercent - expectedIgst) <= RATE_TOLERANCE_POINTS : null;
    breakdown.push({
      tax_type: "igst",
      effective_rate: igst.ratePercent,
      expected_rate: expectedIgst,
      rate_matches: matches,
      note:
        matches === null
          ? `IGST ${igst.ratePercent.toFixed(2)}%. No reference IGST rate for this category.`
          : matches
            ? `IGST ${igst.ratePercent.toFixed(2)}%, matching the expected rate for this category.`
            : `IGST ${igst.ratePercent.toFixed(2)}% -- expected ${expectedIgst}% for this category.`,
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
        rate_matches: null,
        note: `${rate.label} ${rate.ratePercent.toFixed(2)}% -- a foreign VAT, not Indian GST. No comparison applied.`,
      });
    } else if (ELECTRICITY_LABEL.test(rate.label)) {
      handled.add(rate);
      breakdown.push({
        tax_type: "electricity_duty",
        effective_rate: rate.ratePercent,
        expected_rate: null,
        rate_matches: null,
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
    const matches = expectedTotal !== null ? Math.abs(rate.ratePercent - expectedTotal) <= RATE_TOLERANCE_POINTS : null;
    breakdown.push({
      tax_type: "other",
      effective_rate: rate.ratePercent,
      expected_rate: expectedTotal,
      rate_matches: matches,
      note:
        matches === null
          ? `${rate.label} ${rate.ratePercent.toFixed(2)}%. No reference rate for this line.`
          : matches
            ? `${rate.label} ${rate.ratePercent.toFixed(2)}%, matching the expected rate for this category.`
            : `${rate.label} ${rate.ratePercent.toFixed(2)}% -- expected ${expectedTotal}% for this category.`,
    });
  }

  return breakdown;
}

// Short line for the review/verdict screen -- one clause per tax group,
// joined, built directly from the breakdown's own fields (never by
// re-parsing `note`), e.g. "Tax: CGST 2.50% + SGST 2.50% = 5.00% GST
// (expected for groceries: 5%, matches)".
const TAX_TYPE_LABEL: Record<TaxGroupType, string> = {
  cgst_sgst: "GST",
  utgst: "GST",
  igst: "IGST",
  vat: "VAT",
  electricity_duty: "Electricity Duty",
  other: "Tax",
};

// The block appended to the follow-up chat's system prompt -- supersedes
// buildGstAddendum with the grouped/classified breakdown (CGST+SGST
// pairing, VAT/electricity-duty called out as not-GST, etc.) so the model
// can answer "why is the tax 2.5% not 9%" with the full picture: the
// computed rate, the matching reference (HSN, source, effective date) if
// any, and whether they match -- every number still code-computed, the
// model only ever phrases it.
export function buildTaxBreakdownAddendum(breakdown: TaxBreakdown[], matchingRate: CategoryRate | null): string {
  if (breakdown.length === 0) return "";

  const lines = breakdown.map((b) => {
    const parts = [`- ${TAX_TYPE_LABEL[b.tax_type]}: ${b.effective_rate.toFixed(2)}% (computed from this bill's own figures)`];
    if (b.tax_type === "cgst_sgst" || b.tax_type === "utgst" || b.tax_type === "igst" || b.tax_type === "other") {
      if (b.expected_rate !== null) {
        parts.push(
          `expected rate for this category${matchingRate?.hsn_prefix ? ` (HSN ${matchingRate.hsn_prefix})` : ""}: ${b.expected_rate}%` +
            (matchingRate?.source_url ? ` per ${matchingRate.source_url}` : "") +
            (matchingRate?.effective_from ? ` effective ${matchingRate.effective_from}` : "") +
            ` -- ${b.rate_matches ? "matches" : "does not match"}`
        );
      } else {
        parts.push("no seeded reference rate for this category -- say so plainly if asked, don't guess whether it's correct");
      }
    } else if (b.tax_type === "vat") {
      parts.push("this is a foreign VAT, not Indian GST -- never compare it against an Indian GST rate");
    } else if (b.tax_type === "electricity_duty") {
      parts.push("this is a state-level electricity duty, not GST -- never compare it against a GST rate");
    }
    return parts.join("; ");
  });

  return `\n\nTax breakdown, computed from this bill's own printed figures (never invented or recomputed by you):\n${lines.join("\n")}`;
}

export function summarizeTaxBreakdown(breakdown: TaxBreakdown[]): string | null {
  if (breakdown.length === 0) return null;
  return (
    "Tax: " +
    breakdown
      .map((b) => {
        const rate = `${b.effective_rate.toFixed(2)}% ${TAX_TYPE_LABEL[b.tax_type]}`;
        if (b.tax_type === "vat") return `${rate} (not Indian GST)`;
        if (b.tax_type === "electricity_duty") return `${rate} (state levy, not GST)`;
        if (b.expected_rate === null) return rate;
        return `${rate} (expected: ${b.expected_rate}%, ${b.rate_matches ? "matches" : "doesn't match"})`;
      })
      .join("; ")
  );
}
