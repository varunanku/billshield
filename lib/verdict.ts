// Decides the one outcome a confirmed bill gets, from code alone (hard
// rule 2: the LLM never computes or decides this -- it only writes prose
// around the facts this file produces). Three outcomes, in priority order:
//
// 1. CONFIRMED ERROR (confident tone): any hard, code-proven evidence --
//    a checkpoint that doesn't close, a payment that doesn't match billed,
//    a statement that doesn't reconcile within rounding, a general
//    arithmetic mismatch nothing else explains, or a promise WITH a given
//    amount that the billed total doesn't match. Hard evidence always wins
//    the tone, even if the user also flagged a line unrecognized or stated
//    a promise with no number.
// 2. UNEXPLAINED (inquiry tone): no hard evidence, but either the user
//    marked a line "I don't recognise this", or a promise was made with no
//    comparable amount to check it against.
// 3. CLEAN: neither of the above.
import { EPSILON, type BillLine, type BillChecks } from "./bill-checks.ts";

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
  total: number; // the printed total
};

export type Verdict =
  | { outcome: "clean"; reconciledTotal: number }
  | { outcome: "confirmed_error"; tone: "confident"; facts: Facts }
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

  const brokenCheckpoint = checks.checkpoints.find((c) => Math.abs(c.gap) > EPSILON);
  if (brokenCheckpoint) {
    const disputedLines = brokenCheckpoint.suggestion ? [brokenCheckpoint.suggestion] : [];
    return { outcome: "confirmed_error", tone: "confident", facts: baseFacts(brokenCheckpoint.gap, disputedLines) };
  }

  if (checks.payment && checks.payment.verdict !== "even") {
    return { outcome: "confirmed_error", tone: "confident", facts: baseFacts(checks.payment.signedDifference, []) };
  }

  if (checks.statement && checks.statement.issue) {
    return { outcome: "confirmed_error", tone: "confident", facts: baseFacts(checks.statement.gap, []) };
  }

  const promiseGap =
    promise?.promisedAmount != null ? checks.billedSum - promise.promisedAmount : null;
  if (promiseGap !== null && Math.abs(promiseGap) > EPSILON) {
    return { outcome: "confirmed_error", tone: "confident", facts: baseFacts(promiseGap, []) };
  }

  if (checks.arithmeticIssue) {
    return { outcome: "confirmed_error", tone: "confident", facts: baseFacts(checks.arithmeticDifference, []) };
  }

  const unrecognizedLines = lines.filter((l) => l.unrecognized).map((l) => ({ label: l.label, amount: l.amount }));
  const promiseUncomparable = promise !== null && promise.promisedAmount === null;

  if (unrecognizedLines.length > 0 || promiseUncomparable) {
    return { outcome: "unexplained", tone: "inquiry", facts: baseFacts(0, unrecognizedLines) };
  }

  return { outcome: "clean", reconciledTotal: total };
}
