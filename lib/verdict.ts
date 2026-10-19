// Decides the one outcome a confirmed bill gets, from code alone (hard
// rule 2: the LLM never computes or decides this -- it only writes prose
// around the facts this file produces). Four outcomes, in priority order:
//
// 1. CONFIRMED ERROR (confident tone, drafts an email): hard evidence --
//    a payment that doesn't match billed (charge+tax-discount only, never
//    crediting an outstanding/arrears line in), a checkpoint gap with a
//    single suggested culprit line, or a promise WITH a given amount that
//    the billed total doesn't match. Always wins over a softer signal.
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
import { EPSILON, type BillLine, type BillChecks, type RoundedTotalNote } from "./bill-checks.ts";

export type Promise = { statement: string; promisedAmount: number | null };

export type DisputedLine = { label: string; amount: number };

// Which of the three confident-tone headlines applies -- kept separate
// from the generic Facts so the UI can show the exact wording item 5
// requires ("You overpaid Rs X." / "You were charged Rs X more than you
// were promised." / "Rs X on this bill doesn't add up.") without
// re-deriving it from the numbers.
export type ConfirmedErrorReason = "overpaid" | "promise_mismatch" | "mismatch";

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
};

export type Verdict =
  | { outcome: "clean"; reconciledTotal: number; roundingNote: RoundedTotalNote | null }
  | { outcome: "confirmed_error"; tone: "confident"; reason: ConfirmedErrorReason; facts: Facts }
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

export function decideVerdict(input: {
  lines: BillLine[];
  total: number;
  provider: string;
  billDate: string;
  checks: BillChecks;
  promise: Promise | null;
}): Verdict {
  const { lines, provider, billDate, checks, promise } = input;

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
  });

  // Hard evidence: we know exactly what was billed and exactly what was
  // paid. billed is charge+tax-discount only -- an outstanding/arrears
  // line is never credited in (see lib/bill-checks.ts); it's mentioned in
  // the email, not folded into the maths.
  if (checks.payment && checks.payment.verdict !== "even") {
    return {
      outcome: "confirmed_error",
      tone: "confident",
      reason: checks.payment.verdict === "overpaid" ? "overpaid" : "mismatch",
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

  const promiseGap = promise?.promisedAmount != null ? checks.billedSum - promise.promisedAmount : null;
  if (promiseGap !== null && Math.abs(promiseGap) > EPSILON) {
    return { outcome: "confirmed_error", tone: "confident", reason: "promise_mismatch", facts: baseFacts(promiseGap, []) };
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

  return { outcome: "clean", reconciledTotal: checks.effectiveTotal, roundingNote: checks.roundedTotalNote };
}
