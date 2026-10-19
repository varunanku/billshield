// Pure, shared check math -- no server-only imports, so the browser's
// review screen and the confirm API route both compute from the exact same
// function. The API route's result is the authoritative one (hard rule 2:
// every number comes from code); the browser's use of this is just a live
// preview while the user edits.

export type LineRole = "charge" | "tax" | "discount" | "payment" | "balance" | "subtotal" | "info";
export const LINE_ROLES: LineRole[] = ["charge", "tax", "discount", "payment", "balance", "subtotal", "info"];

export type BillLine = { label: string; amount: number; role: LineRole };

export type Checkpoint = {
  label: string; // the subtotal line's own label
  expected: number; // the subtotal line's printed amount
  actual: number; // sum of charge+tax-discount lines since the previous checkpoint (or the start)
  gap: number; // actual - expected
};

export type SuspiciousGapWarning = {
  lineLabel: string;
  amount: number;
  message: string;
};

export type BillChecks = {
  billedSum: number; // sum(charge) + sum(tax) - sum(discount) -- balance/subtotal/info lines are shown but never summed
  arithmeticDifference: number; // billedSum - total
  arithmeticIssue: boolean; // |arithmeticDifference| > EPSILON
  payment: {
    amountPaid: number;
    signedDifference: number; // billedSum - amountPaid; positive = dispute (billed more than paid), negative = overpaid
    verdict: "dispute" | "overpaid" | "even";
  } | null; // null when there's no payment-role line at all
  checkpoints: Checkpoint[]; // one per subtotal-role line, in document order
  warnings: SuspiciousGapWarning[]; // a charge line that suspiciously equals (total - a subtotal)
};

export const EPSILON = 0.01; // floating-point rounding only, not a business tolerance

export type PersistedLine = { label: string; amount: number; role: LineRole };

// line_items has no role column, so storage has to encode role into label +
// amount alone, in a way a later reader (e.g. verdict logic) can recover
// without ever needing role back:
// - balance/subtotal/info lines are dropped entirely. They're shown on the
//   review screen but never summed, and a stored row with nothing marking
//   it would be indistinguishable from a charge once it's just a row.
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
    .filter((li) => li.role !== "balance" && li.role !== "subtotal" && li.role !== "info")
    .map((li) => ({
      label: li.role === "payment" ? "Amount Paid" : li.label,
      amount: li.role === "discount" ? -li.amount : li.amount,
      role: li.role,
    }));
}

function sumByRole(lineItems: BillLine[], role: LineRole): number {
  return lineItems.filter((li) => li.role === role).reduce((s, li) => s + li.amount, 0);
}

// One checkpoint per subtotal-role line encountered, in document order: the
// running sum of charge+tax-discount lines since the previous checkpoint (or
// the start) vs. that subtotal's own printed amount. payment/balance/info
// lines don't affect the running sum and don't reset it. This is what
// catches a dropped or misread component line well before the final total
// comparison would -- it points at exactly which section of the bill the
// gap is in.
function computeCheckpoints(lineItems: BillLine[]): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  let running = 0;
  for (const li of lineItems) {
    if (li.role === "charge" || li.role === "tax") running += li.amount;
    else if (li.role === "discount") running -= li.amount;
    else if (li.role === "subtotal") {
      checkpoints.push({ label: li.label, expected: li.amount, actual: running, gap: running - li.amount });
      running = 0;
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
  const billedSum =
    sumByRole(lineItems, "charge") + sumByRole(lineItems, "tax") - sumByRole(lineItems, "discount");

  const arithmeticDifference = billedSum - total;
  const arithmeticIssue = Math.abs(arithmeticDifference) > EPSILON;

  const paymentLines = lineItems.filter((li) => li.role === "payment");
  const payment =
    paymentLines.length === 0
      ? null
      : (() => {
          const amountPaid = paymentLines.reduce((s, li) => s + li.amount, 0);
          const signedDifference = billedSum - amountPaid;
          const verdict: "dispute" | "overpaid" | "even" =
            signedDifference > EPSILON ? "dispute" : signedDifference < -EPSILON ? "overpaid" : "even";
          return { amountPaid, signedDifference, verdict };
        })();

  return {
    billedSum,
    arithmeticDifference,
    arithmeticIssue,
    payment,
    checkpoints: computeCheckpoints(lineItems),
    warnings: computeSuspiciousGapWarnings(lineItems, total),
  };
}
