// Pure, shared check math -- no server-only imports, so the browser's
// review screen and the confirm API route both compute from the exact same
// function. The API route's result is the authoritative one (hard rule 2:
// every number comes from code); the browser's use of this is just a live
// preview while the user edits.

export type LineRole = "charge" | "tax" | "discount" | "payment" | "balance" | "subtotal" | "info" | "opening";
export const LINE_ROLES: LineRole[] = [
  "charge",
  "tax",
  "discount",
  "payment",
  "balance",
  "subtotal",
  "info",
  "opening",
];

export type BillLine = { label: string; amount: number; role: LineRole };

export type CheckpointSuggestion = { label: string; amount: number };

export type Checkpoint = {
  label: string; // the subtotal line's own label
  expected: number; // the subtotal line's printed amount
  actual: number; // sum of charge+tax-discount lines since the previous checkpoint (or the start)
  gap: number; // actual - expected
  // When actual exceeds expected (gap > 0) and exactly one line in this
  // section has an amount equal to the gap, that line is very likely the
  // extra/fabricated one -- removing it would make the section add up.
  // null when the gap isn't positive, or when more/fewer than one line matches.
  suggestion: CheckpointSuggestion | null;
};

export type SuspiciousGapWarning = {
  lineLabel: string;
  amount: number;
  message: string;
};

export type Reclassification = { label: string; amount: number };

export type StatementCheck = {
  expectedClosing: number; // opening + charges + tax - discounts - payments
  gap: number; // expectedClosing - total
  issue: boolean; // |gap| > ROUNDING_TOLERANCE -- a real problem, not just rounding
};

export type BillChecks = {
  billedSum: number; // sum(charge) + sum(tax) - sum(discount) -- balance/subtotal/info lines are shown but never summed
  arithmeticDifference: number; // billedSum - total
  arithmeticIssue: boolean; // |arithmeticDifference| > EPSILON, suppressed when arithmeticCoveredByPayment or statement is set
  arithmeticCoveredByPayment: boolean; // true: the payment check already explains the gap, don't also show the generic "don't add up" message
  payment: {
    amountPaid: number;
    signedDifference: number; // billedSum - amountPaid; positive = dispute (billed more than paid), negative = overpaid
    verdict: "dispute" | "overpaid" | "even";
  } | null; // null when there's no payment-role line, OR when a statement check (opening line) supersedes it
  checkpoints: Checkpoint[]; // one per subtotal-role line, in document order (a duplicate subtotal under a second label is not a separate checkpoint)
  warnings: SuspiciousGapWarning[]; // a charge line that suspiciously equals (total - a subtotal)
  reclassifiedAsBalance: Reclassification[]; // charge/tax lines the code itself reclassified (label read as total/payable/due and the amount matched the printed total)
  taxIncludedNote: string | null; // set when tax lines were treated as already baked into the charge amounts and excluded from every sum/checkpoint
  statement: StatementCheck | null; // set only when an "opening" line exists; when set, payment is null and arithmeticIssue is false
};

export const EPSILON = 0.01; // floating-point rounding only, not a business tolerance
export const ROUNDING_TOLERANCE = 1.0; // statement reconciliation (opening balance + period activity) tolerates up to this before it's flagged as a real issue

export type PersistedLine = { label: string; amount: number; role: LineRole };

// line_items has no role column, so storage has to encode role into label +
// amount alone, in a way a later reader (e.g. verdict logic) can recover
// without ever needing role back:
// - balance/subtotal/info/opening are dropped entirely. They're shown on
//   the review screen but never summed into billedSum, and a stored row
//   with nothing marking it would be indistinguishable from a charge once
//   it's just a row. (opening specifically: it only feeds the separate
//   statement-closing-balance formula, not billedSum, so keeping it out of
//   storage keeps "sum every stored row except Amount Paid" correct.)
// - discount lines are stored with a NEGATED amount, so a later reader can
//   sum every stored line except the one labelled "Amount Paid" and get the
//   correct billed total, without needing to know which role produced which
//   row.
// - payment lines are relabelled to the literal "Amount Paid"
//   (docs/schema.md's documented convention).
// Label text still needs masking by the caller -- this function only
// decides which rows exist and what their amount/label convention is.
export function toPersistedLines(lineItems: BillLine[]): PersistedLine[] {
  return lineItems
    .filter((li) => li.role !== "balance" && li.role !== "subtotal" && li.role !== "info" && li.role !== "opening")
    .map((li) => ({
      label: li.role === "payment" ? "Amount Paid" : li.label,
      amount: li.role === "discount" ? -li.amount : li.amount,
      role: li.role,
    }));
}

function sumByRole(lineItems: BillLine[], role: LineRole): number {
  return lineItems.filter((li) => li.role === role).reduce((s, li) => s + li.amount, 0);
}

// Deterministic safety net: a row labelled like a total ("Total", "Amount
// Payable", "Amount Due", ...) whose amount exactly matches the bill's own
// printed total should never have been charge/tax in the first place -- it
// restates the total, it isn't a new charge. The prompt already tells the
// model this, but prompts aren't 100% reliable (see chat history), so code
// catches it too and reclassifies it to "balance" before anything else runs.
const TOTAL_LIKE_LABEL = /total|payable|due/i;

function reclassifyTotalLikeLines(
  lineItems: BillLine[],
  total: number
): { lineItems: BillLine[]; reclassified: Reclassification[] } {
  const reclassified: Reclassification[] = [];
  const effective = lineItems.map((li) => {
    if (
      (li.role === "charge" || li.role === "tax") &&
      TOTAL_LIKE_LABEL.test(li.label) &&
      Math.abs(li.amount - total) <= EPSILON
    ) {
      reclassified.push({ label: li.label, amount: li.amount });
      return { ...li, role: "balance" as LineRole };
    }
    return li;
  });
  return { lineItems: effective, reclassified };
}

// Some bills print an item's charge already tax-inclusive, with the tax
// line printed separately alongside it only as a breakdown (not something
// to additionally add on top) -- e.g. a ₹1599 item line next to a ₹243.92
// GST line, where the item amount itself is already the ₹1599 total. The
// normal charge+tax formula would double count that tax and produce a
// false "doesn't add up" alarm. Detect this deterministically: if there's
// no opening line (a statement reconciles differently -- see the opening
// handling below), the charge lines alone already equal the printed total,
// and at least one tax line exists, treat every tax line as already baked
// into the charge amounts. They're excluded from every sum and checkpoint
// the same way an "info" line is, without changing what's shown or stored.
function detectTaxIncludedInPrice(
  lineItems: BillLine[],
  total: number
): { lineItems: BillLine[]; note: string | null } {
  const hasOpening = lineItems.some((li) => li.role === "opening");
  const taxLines = lineItems.filter((li) => li.role === "tax");
  if (hasOpening || taxLines.length === 0) return { lineItems, note: null };

  const chargeSum = sumByRole(lineItems, "charge");
  if (Math.abs(chargeSum - total) > EPSILON) return { lineItems, note: null };

  const adjusted = lineItems.map((li) => (li.role === "tax" ? { ...li, role: "info" as LineRole } : li));
  return { lineItems: adjusted, note: "Tax appears to be included in the item price." };
}

// One checkpoint per subtotal-role line encountered, in document order: the
// running sum of charge+tax-discount lines since the previous checkpoint (or
// the start) vs. that subtotal's own printed amount. payment/balance/info/
// opening lines don't affect the running sum and don't reset it. This is
// what catches a dropped or misread component line well before the final
// total comparison would -- it points at exactly which section of the bill
// the gap is in.
//
// A subtotal line that closes an EMPTY section (no charge/tax/discount
// since the previous checkpoint) and repeats the previous checkpoint's own
// amount is the same figure printed a second time under a different label
// -- not a new checkpoint, and not a gap. The prompt already tells the
// model to extract this once; this is the same defense-in-depth as the
// reclassification above, for when it still doesn't.
function computeCheckpoints(lineItems: BillLine[]): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  let running = 0;
  let sectionLines: BillLine[] = [];
  for (const li of lineItems) {
    if (li.role === "charge" || li.role === "tax") {
      running += li.amount;
      sectionLines.push(li);
    } else if (li.role === "discount") {
      running -= li.amount;
      sectionLines.push(li);
    } else if (li.role === "subtotal") {
      const previous = checkpoints[checkpoints.length - 1];
      const isEmptyDuplicate =
        sectionLines.length === 0 && previous !== undefined && Math.abs(previous.expected - li.amount) <= EPSILON;
      if (isEmptyDuplicate) continue;

      const gap = running - li.amount;
      let suggestion: CheckpointSuggestion | null = null;
      if (gap > EPSILON) {
        const matches = sectionLines.filter((l) => Math.abs(l.amount - gap) <= EPSILON);
        if (matches.length === 1) {
          suggestion = { label: matches[0].label, amount: matches[0].amount };
        }
      }
      checkpoints.push({ label: li.label, expected: li.amount, actual: running, gap, suggestion });
      running = 0;
      sectionLines = [];
    }
  }
  return checkpoints;
}

// A charge line whose amount suspiciously equals (total - some subtotal) is
// a tell for the exact failure mode this schema was built to catch: the
// model computing the gap between two numbers it read and presenting that
// computed result as if it were its own printed line (see the fabricated
// "Lpsc: 5.77" line found in testing -- 11460.00 - 11454.23 = 5.77 exactly).
function computeSuspiciousGapWarnings(lineItems: BillLine[], total: number): SuspiciousGapWarning[] {
  const subtotalAmounts = lineItems.filter((li) => li.role === "subtotal").map((li) => li.amount);
  const warnings: SuspiciousGapWarning[] = [];
  for (const li of lineItems) {
    if (li.role !== "charge") continue;
    const matchesAGap = subtotalAmounts.some((s) => Math.abs(li.amount - (total - s)) <= EPSILON);
    if (matchesAGap) {
      warnings.push({
        lineLabel: li.label,
        amount: li.amount,
        message: "This amount equals the gap between the total and a subtotal. Check it is actually printed on your bill.",
      });
    }
  }
  return warnings;
}

export function computeBillChecks(lineItems: BillLine[], total: number): BillChecks {
  const { lineItems: afterReclassify, reclassified: reclassifiedAsBalance } = reclassifyTotalLikeLines(
    lineItems,
    total
  );
  const { lineItems: effectiveLineItems, note: taxIncludedNote } = detectTaxIncludedInPrice(afterReclassify, total);

  const billedSum =
    sumByRole(effectiveLineItems, "charge") +
    sumByRole(effectiveLineItems, "tax") -
    sumByRole(effectiveLineItems, "discount");

  const arithmeticDifference = billedSum - total;
  let arithmeticIssue = Math.abs(arithmeticDifference) > EPSILON;
  let arithmeticCoveredByPayment = false;

  const paymentLines = effectiveLineItems.filter((li) => li.role === "payment");
  let payment =
    paymentLines.length === 0
      ? null
      : (() => {
          const amountPaid = paymentLines.reduce((s, li) => s + li.amount, 0);
          const signedDifference = billedSum - amountPaid;
          const verdict: "dispute" | "overpaid" | "even" =
            signedDifference > EPSILON ? "dispute" : signedDifference < -EPSILON ? "overpaid" : "even";
          return { amountPaid, signedDifference, verdict };
        })();

  // The printed "total" on a payment receipt is sometimes really the paid
  // figure, not a sum-of-charges total (the Airtel case) -- the generic
  // arithmetic check would otherwise flag a confusing "doesn't add up" on
  // top of the payment check that already explains the exact same gap.
  if (payment && Math.abs(total - payment.amountPaid) <= EPSILON) {
    arithmeticIssue = false;
    arithmeticCoveredByPayment = true;
  }

  // A statement (opening balance + this period's activity) reconciles
  // differently from a one-off bill: closing = opening + charges + tax -
  // discounts - payments. That formula already nets out payments, so it
  // replaces the generic payment check and the generic arithmetic check,
  // not supplement them.
  const hasOpening = effectiveLineItems.some((li) => li.role === "opening");
  let statement: StatementCheck | null = null;
  if (hasOpening) {
    const expectedClosing =
      sumByRole(effectiveLineItems, "opening") +
      sumByRole(effectiveLineItems, "charge") +
      sumByRole(effectiveLineItems, "tax") -
      sumByRole(effectiveLineItems, "discount") -
      sumByRole(effectiveLineItems, "payment");
    const gap = expectedClosing - total;
    statement = { expectedClosing, gap, issue: Math.abs(gap) > ROUNDING_TOLERANCE };
    payment = null;
    arithmeticIssue = false;
    arithmeticCoveredByPayment = false;
  }

  return {
    billedSum,
    arithmeticDifference,
    arithmeticIssue,
    arithmeticCoveredByPayment,
    payment,
    checkpoints: computeCheckpoints(effectiveLineItems),
    warnings: computeSuspiciousGapWarnings(effectiveLineItems, total),
    reclassifiedAsBalance,
    taxIncludedNote,
    statement,
  };
}
