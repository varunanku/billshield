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
