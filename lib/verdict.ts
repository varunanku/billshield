// Decides the one outcome a confirmed bill gets, from code alone (hard
// rule 2: the LLM never computes or decides this -- it only writes prose
// around the facts this file produces). Four outcomes, in priority order:
//
// 1. CONFIRMED ERROR (confident tone, drafts an email): hard evidence --
//    a payment that doesn't match billed (charge+tax-discount only, never
//    crediting an outstanding/arrears line in), or a checkpoint gap with a
//    single suggested culprit line. Always wins over a softer signal.
//    A promise WITH a given amount that the printed total doesn't match
//    also lands here (reason "promise_mismatch"), but with INQUIRY tone:
//    a gap against what the user expected is not proof the bill is wrong,
//    so it's never worded as an error (see expectedAmountGap below).
// 2. CANNOT VERIFY (inquiry tone, drafts a soft email): an unpinpointed gap
//    exists -- a checkpoint gap with no single suggestion, a statement
//    that doesn't reconcile, or the general arithmetic check with nothing
//    more specific to explain it. bill-checks.ts's own ROUNDING_TOLERANCE
//    (and the rounded-total-pair detection) already filter out cosmetic
//    rounding before this ever sees a gap, so anything reaching here is a
//    real, worth-mentioning difference. Honest uncertainty, not an
//    accusation (hard rule 5): the email asks the provider to help
//    clarify a difference, it doesn't allege an error.
// 3. UNEXPLAINED (inquiry tone, drafts an email): no hard evidence of any
//    kind, but the user marked a line "I don't recognise this", or a
//    promise was made with no comparable amount to check it against.
// 4. CLEAN: none of the above.
import { EPSILON, ROUNDING_TOLERANCE, type BillLine, type BillChecks, type RoundedTotalNote } from "./bill-checks.ts";
import type { TaxOverchargeFinding } from "./gst.ts";

export type Promise = { statement: string; promisedAmount: number | null };

export type DisputedLine = { label: string; amount: number };

// Which of the three confident-tone headlines applies -- kept separate
// from the generic Facts so the UI can show the exact wording item 5
// requires ("You overpaid Rs X." / "You were charged Rs X more than you
// were promised." / "Rs X on this bill doesn't add up.") without
// re-deriving it from the numbers.
export type ConfirmedErrorReason = "overpaid" | "promise_mismatch" | "mismatch" | "tax_overcharge";

export type Facts = {
  provider: string;
  billDate: string;
  // Always null today: any bill/account reference number that survives to
  // this point would already have been swept up by the masking backstop
  // (lib/mask.ts) as a long digit sequence before storage -- not extracting
  // a separate field for this, since that would work against hard rule 3.
  billReference: string | null;
  disputedLines: DisputedLine[];
  gap: number; // signed; the one number this outcome is actually about
  promisedAmount: number | null;
  billedAmount: number; // checks.billedSum
  total: number; // the printed total -- the ONLY figure the drafted email may call "the total"
  // Mention-only context, never a computed fact of its own: an outstanding/
  // arrears/previous-due line whose amount happens to match the payment
  // excess (lib/bill-checks.ts's payment.reconcilingBalanceLabel).
  reconcilingBalanceLabel: string | null;
  // Set ONLY for reason "tax_overcharge" -- a CONFIRMED finding from
  // lib/gst.ts#findTaxOvercharge (printed HSN matched, billed rate higher
  // than the reference). Null for every other outcome/reason.
  taxFinding: {
    effectiveRatePercent: number;
    expectedRatePercent: number;
    hsnPrefix: string | null;
    sourceUrl: string | null;
  } | null;
  // Set ONLY for reason "promise_mismatch": gap is printed total minus the
  // promised amount. matchedLineLabel names the one bill line (if exactly
  // one) whose amount is within PROMISE_LINE_MATCH_TOLERANCE of that gap,
  // e.g. a late payment surcharge. Label only -- its amount is already on
  // the bill, and the email never needs to state it.
  expectedAmountGap: { matchedLineLabel: string | null } | null;
};

export type Verdict =
  | { outcome: "clean"; reconciledTotal: number; roundingNote: RoundedTotalNote | null }
  | { outcome: "confirmed_error"; tone: "confident" | "inquiry"; reason: ConfirmedErrorReason; facts: Facts }
  | { outcome: "cannot_verify"; tone: "inquiry"; facts: Facts }
  | { outcome: "unexplained"; tone: "inquiry"; facts: Facts };

// The one amount a drafted email's "difference" figure is actually about,
// for this outcome -- used both by the UI headline and by the
// never-email-under-Rs-1 guard (hard rule: don't bother anyone, or the
// provider, over a rounding-sized figure). disputedLines.length > 0 means
// a specific line is what's being asked about; otherwise it's the overall
// gap, if any.
export function disputedAmountFor(facts: Facts): number | null {
  if (facts.disputedLines.length > 0) return Math.abs(facts.disputedLines[0].amount);
  if (Math.abs(facts.gap) > EPSILON) return Math.abs(facts.gap);
  return null; // nothing numeric to compare -- e.g. a promise with no stated amount
}

// Never worth an email (or the provider's time) over a rounding-sized
// figure -- a promise-with-no-number unexplained case has no amount to
// judge by at all, so it's never blocked by this.
export function shouldDraftEmail(facts: Facts): boolean {
  const amount = disputedAmountFor(facts);
  return amount === null || amount >= 1.0;
}

// "Matches the Late Payment Surcharge line" -- within Rs 2 of the gap, so a
// bill rounded to the nearest rupee (48.44 on a 48.00 gap) still matches.
export const PROMISE_LINE_MATCH_TOLERANCE = 2.0;

// The one charge/tax/balance line whose amount explains a positive
// expected-amount gap, or null when none or more than one does.
export function findLineMatchingGap(lines: BillLine[], gap: number): string | null {
  if (gap <= EPSILON) return null;
  const matches = lines.filter(
    (l) =>
      (l.role === "charge" || l.role === "tax" || l.role === "balance") &&
      Math.abs(l.amount - gap) <= PROMISE_LINE_MATCH_TOLERANCE
  );
  return matches.length === 1 ? matches[0].label : null;
}

// The verdict-screen headline for reason "promise_mismatch". Never "charged
// more than promised" -- a gap against an expectation isn't a proven error.
export function expectedAmountHeadline(facts: Facts): string {
  const direction = facts.gap >= 0 ? "higher" : "lower";
  const matched = facts.expectedAmountGap?.matchedLineLabel;
  return `This bill is Rs ${Math.abs(facts.gap).toFixed(2)} ${direction} than the amount you expected${
    matched ? ` -- it matches the ${matched} line.` : "."
  }`;
}

export function decideVerdict(input: {
  lines: BillLine[];
  total: number;
  provider: string;
  billDate: string;
  checks: BillChecks;
  promise: Promise | null;
  // Computed by the caller (lib/gst.ts#findTaxOvercharge) -- null whenever
  // there's no confirmed tax-overcharge finding for this bill, which is
  // the overwhelmingly common case (no printed HSN match, or none higher
  // than the reference). Never touches any OTHER outcome's logic below.
  taxFinding?: TaxOverchargeFinding | null;
}): Verdict {
  const { lines, provider, billDate, checks, promise, taxFinding = null } = input;

  const baseFacts = (gap: number, disputedLines: DisputedLine[], reconcilingBalanceLabel: string | null = null): Facts => ({
    provider,
    billDate,
    billReference: null,
    disputedLines,
    gap,
    promisedAmount: promise?.promisedAmount ?? null,
    billedAmount: checks.billedSum,
    total: checks.effectiveTotal,
    reconcilingBalanceLabel,
    taxFinding: null,
    expectedAmountGap: null,
  });

  // Hard evidence: we know exactly what was billed and exactly what was
  // paid. billed is charge+tax-discount only -- an outstanding/arrears
  // line is never credited in (see lib/bill-checks.ts); it's mentioned in
  // the email, not folded into the maths. Paying less than billed is never
  // reported (bill-checks.ts already collapses that case to payment: null),
  // so the only non-"even" verdict that can reach here is "overpaid".
  if (checks.payment && checks.payment.verdict === "overpaid") {
    return {
      outcome: "confirmed_error",
      tone: "confident",
      reason: "overpaid",
      facts: baseFacts(checks.payment.signedDifference, [], checks.payment.reconcilingBalanceLabel),
    };
  }

  const brokenCheckpoint = checks.checkpoints.find((c) => Math.abs(c.gap) > EPSILON);
  if (brokenCheckpoint) {
    if (brokenCheckpoint.suggestion) {
      return {
        outcome: "confirmed_error",
        tone: "confident",
        reason: "mismatch",
        facts: baseFacts(brokenCheckpoint.gap, [brokenCheckpoint.suggestion]),
      };
    }
    return { outcome: "cannot_verify", tone: "inquiry", facts: baseFacts(brokenCheckpoint.gap, []) };
  }

  // Against the printed total (facts.total), not the reconciled billed
  // sum, so the headline, email and chat all quote the same figure the
  // user sees on their bill. Falls back to billedSum only when no total
  // was entered at all.
  const printedTotal = Math.abs(checks.effectiveTotal) > EPSILON ? checks.effectiveTotal : checks.billedSum;
  const promiseGap = promise?.promisedAmount != null ? printedTotal - promise.promisedAmount : null;
  if (promiseGap !== null && Math.abs(promiseGap) > EPSILON) {
    return {
      outcome: "confirmed_error",
      tone: "inquiry",
      reason: "promise_mismatch",
      facts: {
        ...baseFacts(promiseGap, []),
        total: printedTotal,
        expectedAmountGap: { matchedLineLabel: findLineMatchingGap(lines, promiseGap) },
      },
    };
  }

  if (checks.statement && checks.statement.issue) {
    return { outcome: "cannot_verify", tone: "inquiry", facts: baseFacts(checks.statement.gap, []) };
  }

  if (checks.arithmeticIssue) {
    return { outcome: "cannot_verify", tone: "inquiry", facts: baseFacts(checks.arithmeticDifference, []) };
  }

  const unrecognizedLines = lines.filter((l) => l.unrecognized).map((l) => ({ label: l.label, amount: l.amount }));
  const promiseUncomparable = promise !== null && promise.promisedAmount === null;

  if (unrecognizedLines.length > 0 || promiseUncomparable) {
    return { outcome: "unexplained", tone: "inquiry", facts: baseFacts(0, unrecognizedLines) };
  }

  // Tax overcharge (Phase 3): checked last, only once every other check
  // has found nothing -- a bill that already triggers confirmed_error/
  // cannot_verify/unexplained above for some other reason is completely
  // unaffected by this; it's purely an ADDITIONAL way for an otherwise-
  // clean bill to surface a finding, never a change to the others.
  // Gated on the same Rs-1 "worth anyone's time" threshold as every other
  // outcome here (shouldDraftEmail/ROUNDING_TOLERANCE) -- a sub-Rs-1
  // possible excess is treated as if there were no finding at all.
  if (taxFinding && Math.abs(taxFinding.possibleExcess) >= ROUNDING_TOLERANCE) {
    return {
      outcome: "confirmed_error",
      tone: "confident",
      reason: "tax_overcharge",
      facts: {
        ...baseFacts(-taxFinding.possibleExcess, [{ label: taxFinding.label, amount: taxFinding.billedAmount }]),
        taxFinding: {
          effectiveRatePercent: taxFinding.effectiveRatePercent,
          expectedRatePercent: taxFinding.expectedRatePercent,
          hsnPrefix: taxFinding.hsnPrefix,
          sourceUrl: taxFinding.sourceUrl,
        },
      },
    };
  }

  return { outcome: "clean", reconciledTotal: checks.effectiveTotal, roundingNote: checks.roundedTotalNote };
}
