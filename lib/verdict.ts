// Decides the one outcome a confirmed bill gets, from code alone (hard
// rule 2: the LLM never computes or decides this -- it only writes prose
// around the facts this file produces). Four outcomes, in priority order:
//
// 1. CONFIRMED ERROR (confident tone, drafts an email): hard evidence with
//    a specific, pinpointed cause -- a checkpoint gap with a single
//    suggested culprit line, or a promise WITH a given amount that the
//    billed total doesn't match. Always wins over a softer signal (an
//    unrecognized-line flag, a promise with no number), and over the
//    rounding tolerance below -- a pinpointed line is real evidence
//    regardless of how small the amount is.
// 2. CANNOT VERIFY (inquiry tone, drafts a soft email): an unpinpointed gap
//    exists -- a checkpoint gap with no single suggestion, a statement
//    that doesn't reconcile, a payment that doesn't reconcile (even after
//    crediting any outstanding/arrears line), or the general arithmetic
//    check with nothing more specific to explain it -- AND that gap is
//    bigger than MINOR_GAP_TOLERANCE. Honest uncertainty, not an
//    accusation (hard rule 5): the email asks the provider to help
//    clarify a difference, it doesn't allege an error.
// 3. UNEXPLAINED (inquiry tone, drafts an email): no hard evidence of any
//    kind, but the user marked a line "I don't recognise this", or a
//    promise was made with no comparable amount to check it against.
// 4. CLEAN: none of the above -- including an unpinpointed gap that's
//    within MINOR_GAP_TOLERANCE, which is far more likely a rounding or
//    OCR field-selection quirk than a real discrepancy worth an email.
import { EPSILON, type BillLine, type BillChecks } from "./bill-checks.ts";

// A gap this small, with no pinpointed cause, isn't worth flagging -- it's
// far more likely a rounding difference or a misread field than an actual
// billing error. Only gates the three "something doesn't add up but we
// don't know why" branches below, never the confirmed_error branches
// (a pinpointed line, or a user-stated promise mismatch, is real evidence
// regardless of size).
export const MINOR_GAP_TOLERANCE = 5.0;

export type Promise = { statement: string; promisedAmount: number | null };

export type DisputedLine = { label: string; amount: number };

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
};

export type Verdict =
  // roundingGap is set (non-null) only when an unpinpointed gap was found
  // but forgiven for being within MINOR_GAP_TOLERANCE -- lets the UI say
  // "within rounding" instead of a plain clean, without a separate outcome.
  | { outcome: "clean"; reconciledTotal: number; roundingGap: number | null }
  | { outcome: "confirmed_error"; tone: "confident"; facts: Facts }
  | { outcome: "cannot_verify"; tone: "inquiry"; facts: Facts }
  | { outcome: "unexplained"; tone: "inquiry"; facts: Facts };

export function decideVerdict(input: {
  lines: BillLine[];
  total: number;
  provider: string;
  billDate: string;
  checks: BillChecks;
  promise: Promise | null;
}): Verdict {
  const { lines, total, provider, billDate, checks, promise } = input;

  const baseFacts = (gap: number, disputedLines: DisputedLine[]): Facts => ({
    provider,
    billDate,
    billReference: null,
    disputedLines,
    gap,
    promisedAmount: promise?.promisedAmount ?? null,
    billedAmount: checks.billedSum,
    total,
  });

  // An unpinpointed gap within tolerance: clean, with the gap kept around
  // only so the UI can say "within rounding" instead of a plain clean.
  const unpinpointed = (gap: number): Verdict =>
    Math.abs(gap) <= MINOR_GAP_TOLERANCE
      ? { outcome: "clean", reconciledTotal: total, roundingGap: gap }
      : { outcome: "cannot_verify", tone: "inquiry", facts: baseFacts(gap, []) };

  const brokenCheckpoint = checks.checkpoints.find((c) => Math.abs(c.gap) > EPSILON);
  if (brokenCheckpoint) {
    if (brokenCheckpoint.suggestion) {
      return {
        outcome: "confirmed_error",
        tone: "confident",
        facts: baseFacts(brokenCheckpoint.gap, [brokenCheckpoint.suggestion]),
      };
    }
    return unpinpointed(brokenCheckpoint.gap);
  }

  const promiseGap = promise?.promisedAmount != null ? checks.billedSum - promise.promisedAmount : null;
  if (promiseGap !== null && Math.abs(promiseGap) > EPSILON) {
    return { outcome: "confirmed_error", tone: "confident", facts: baseFacts(promiseGap, []) };
  }

  if (checks.statement && checks.statement.issue) {
    return unpinpointed(checks.statement.gap);
  }

  // Note: a payment that doesn't reconcile (even crediting any outstanding/
  // arrears line -- see lib/bill-checks.ts) isn't checked separately here.
  // When it fails to reconcile, checks.arithmeticIssue is -- by
  // construction -- also true (the suppression that would otherwise clear
  // it only fires when payment.verdict is "even"), so it's already caught
  // by the branch below with the right, unified gap number (billedSum vs
  // the printed total, not some payment-specific figure).
  if (checks.arithmeticIssue) {
    return unpinpointed(checks.arithmeticDifference);
  }

  const unrecognizedLines = lines.filter((l) => l.unrecognized).map((l) => ({ label: l.label, amount: l.amount }));
  const promiseUncomparable = promise !== null && promise.promisedAmount === null;

  if (unrecognizedLines.length > 0 || promiseUncomparable) {
    return { outcome: "unexplained", tone: "inquiry", facts: baseFacts(0, unrecognizedLines) };
  }

  return { outcome: "clean", reconciledTotal: total, roundingGap: null };
}
