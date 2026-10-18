// Pure, shared check math -- no server-only imports, so the browser's
// review screen and the confirm API route both compute from the exact same
// function. The API route's result is the authoritative one (hard rule 2:
// every number comes from code); the browser's use of this is just a live
// preview while the user edits.

export type LineRole = "charge" | "tax" | "discount" | "payment" | "balance" | "subtotal";
export const LINE_ROLES: LineRole[] = ["charge", "tax", "discount", "payment", "balance", "subtotal"];

export type BillLine = { label: string; amount: number; role: LineRole };

export type BillChecks = {
  billedSum: number; // sum(charge) + sum(tax) - sum(discount) -- balance/subtotal lines are shown but never summed
  arithmeticDifference: number; // billedSum - total
  arithmeticIssue: boolean; // |arithmeticDifference| > EPSILON
  payment: {
    amountPaid: number;
    signedDifference: number; // billedSum - amountPaid; positive = dispute (billed more than paid), negative = overpaid
    verdict: "dispute" | "overpaid" | "even";
  } | null; // null when there's no payment-role line at all
};

const EPSILON = 0.01; // floating-point rounding only, not a business tolerance

function sumByRole(lineItems: BillLine[], role: LineRole): number {
  return lineItems.filter((li) => li.role === role).reduce((s, li) => s + li.amount, 0);
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

  return { billedSum, arithmeticDifference, arithmeticIssue, payment };
}
