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

// Closed list (hard rule: never a free-text category) -- also what
// category_rates.category must match for the GST reference lookup.
export type BillCategory =
  | "electricity"
  | "internet"
  | "mobile"
  | "credit_card"
  | "groceries"
  | "software"
  | "appliance"
  | "electronics"
  | "cosmetics"
  | "water"
  | "other";
export const BILL_CATEGORIES: BillCategory[] = [
  "electricity",
  "internet",
  "mobile",
  "credit_card",
  "groceries",
  "software",
  "appliance",
  "electronics",
  "cosmetics",
  "water",
  "other",
];

// unrecognized is set from the review screen's "I don't recognise this"
// mark -- it never affects any sum/checkpoint/warning (those are about
// whether the maths is right, which is unrelated to whether the user
// recognizes a legitimate-looking charge), only the verdict (lib/verdict.ts).
export type BillLine = { label: string; amount: number; role: LineRole; unrecognized?: boolean };

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

export type RoundedTotalNote = {
  exactAmount: number; // the balance line equal to billedSum -- the precise, unrounded figure
  roundedTotal: number; // the other balance line -- exactAmount rounded to the nearest 1, 5 or 10, treated as the bill's real total
  gap: number; // roundedTotal - exactAmount
};

export type BillChecks = {
  billedSum: number; // sum(charge) + sum(tax) - sum(discount) -- balance/subtotal/info lines are shown but never summed
  // The total actually used for every "vs total" comparison below: the
  // printed `total` passed in, UNLESS roundedTotalNote is set, in which
  // case the bill's own higher, round-number balance line is trusted
  // instead (see detectRoundedTotalPair).
  effectiveTotal: number;
  roundedTotalNote: RoundedTotalNote | null;
  arithmeticDifference: number; // billedSum - effectiveTotal
  arithmeticIssue: boolean; // |arithmeticDifference| > ROUNDING_TOLERANCE, suppressed when arithmeticCoveredByPayment or statement is set
  arithmeticCoveredByPayment: boolean; // true: a payment-role line exists, so the dedicated payment check (not this generic one) is the relevant lens
  payment: {
    amountPaid: number;
    signedDifference: number; // billedSum - amountPaid; always < 0 here (overpaid) -- see verdict below
    verdict: "overpaid" | "even"; // "even" within ROUNDING_TOLERANCE, not just floating-point EPSILON
    // Mention-only, never changes verdict/sign above: an "outstanding" /
    // "arrears" / "previous due" balance line whose amount matches the
    // excess -- likely why the payment covered more than just this
    // period's new charge, worth noting in the email, not a separate fact.
    reconcilingBalanceLabel: string | null;
  } | null; // null when there's no payment-role line (a 0-amount payment line counts as absent), when the paid amount is less than billed (never reported -- see computeBillChecks), OR when a statement check (opening line) supersedes it
  checkpoints: Checkpoint[]; // one per subtotal-role line, in document order (a duplicate subtotal under a second label is not a separate checkpoint)
  warnings: SuspiciousGapWarning[]; // a charge line that suspiciously equals (total - a subtotal)
  reclassifiedAsBalance: Reclassification[]; // charge/tax lines the code itself reclassified (label read as total/payable/due and the amount matched the printed total)
  reclassifiedAsInfo: Reclassification[]; // tax lines reclassified to "info" (a "Total Tax" line restating what the other tax lines already sum to -- a summary, not an additional charge)
  taxIncludedNote: string | null; // set when tax lines were treated as already baked into the charge amounts and excluded from every sum/checkpoint
  statement: StatementCheck | null; // set only when an "opening" line exists; when set, payment is null and arithmeticIssue is false
};

export const EPSILON = 0.01; // floating-point rounding only, not a business tolerance
// Business tolerance: a payment/arithmetic difference this small or
// smaller is cosmetic rounding, never worth a verdict or a mention.
export const ROUNDING_TOLERANCE = 1.0;

export type PersistedLine = { label: string; amount: number; role: LineRole; unrecognized: boolean };

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
      unrecognized: li.unrecognized ?? false,
    }));
}

// The inverse of toPersistedLines, for a later correction (Phase 2's chat
// corrections) that needs to recompute checks/verdict from stored rows.
// Reverses the one sign convention toPersistedLines applies (discount
// stored negated) back to BillLine's own positive-magnitude convention --
// balance/subtotal/info/opening rows are still gone for good (never
// stored), so a correction can't restore a checkpoint that was dropped
// before confirm; this only reconstructs what was actually persisted.
export function fromPersistedLines(rows: { label: string; amount: number; role: LineRole; unrecognized: boolean }[]): BillLine[] {
  return rows.map((row) => ({
    label: row.label,
    amount: row.role === "discount" ? -row.amount : row.amount,
    role: row.role,
    unrecognized: row.unrecognized,
  }));
}

function sumByRole(lineItems: BillLine[], role: LineRole): number {
  return lineItems.filter((li) => li.role === role).reduce((s, li) => s + li.amount, 0);
}

// Deterministic safety net: a row labelled like a total ("Total", "Amount
// Payable", "Amount Due", "Net Payable", "Pay On Delivery", ...) whose
// amount exactly matches the bill's own printed total should never have
// been charge/tax/payment in the first place -- it restates the total, it
// isn't a new charge, and (COD/"Net Payable" especially) it isn't money
// already paid either, just what's owed. The prompt already tells the
// model this, but prompts aren't 100% reliable (see chat history), so code
// catches it too and reclassifies it to "balance" before anything else runs.
const TOTAL_LIKE_LABEL = /total|payable|due|pay\s*on\s*delivery/i;

function reclassifyTotalLikeLines(
  lineItems: BillLine[],
  total: number
): { lineItems: BillLine[]; reclassified: Reclassification[] } {
  const reclassified: Reclassification[] = [];
  const effective = lineItems.map((li) => {
    if (
      (li.role === "charge" || li.role === "tax" || li.role === "payment") &&
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

// A tax line that's a SUMMARY of the other tax lines, not an additional
// charge on top of them -- e.g. "IGST 29.44" printed alongside a separate
// "Total Tax 29.44" restating the same figure (or "CGST 9 + SGST 9" next
// to a "Total Tax 18" restating their sum). Detected the same
// deterministic way as the total-like reclassification above: the label
// looks like a running tax total, and the amount exactly matches what the
// OTHER tax lines already sum to -- shown, but never summed again.
const TOTAL_TAX_LABEL = /total\s*tax/i;

function reclassifyDuplicateTaxSummary(lineItems: BillLine[]): { lineItems: BillLine[]; reclassified: Reclassification[] } {
  const taxLines = lineItems.filter((li) => li.role === "tax");
  const reclassified: Reclassification[] = [];
  const effective = lineItems.map((li) => {
    if (li.role !== "tax" || !TOTAL_TAX_LABEL.test(li.label)) return li;
    const othersSum = taxLines.filter((t) => t !== li).reduce((s, t) => s + t.amount, 0);
    if (othersSum > 0 && Math.abs(othersSum - li.amount) <= EPSILON) {
      reclassified.push({ label: li.label, amount: li.amount });
      return { ...li, role: "info" as LineRole };
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

// Some bills print both the exact summed amount payable and a second,
// separately-rounded figure as two distinct balance lines (e.g. "Net
// Amount Payable: 11457.81" alongside a headline "Total: 11460.00" rounded
// to the nearest 10). That's cosmetic rounding, not a billing error --
// detected deterministically: one balance line equals billedSum exactly,
// and another balance line is that amount rounded to the nearest 1, 5 or
// 10. When found, the rounded one is trusted as the bill's real total.
function detectRoundedTotalPair(lineItems: BillLine[], billedSum: number): RoundedTotalNote | null {
  const balanceLines = lineItems.filter((li) => li.role === "balance");
  const exact = balanceLines.find((li) => Math.abs(li.amount - billedSum) <= EPSILON);
  if (!exact) return null;

  for (const increment of [1, 5, 10]) {
    const rounded = Math.round(exact.amount / increment) * increment;
    if (Math.abs(rounded - exact.amount) <= EPSILON) continue; // already a round number -- no pair to find
    const candidate = balanceLines.find((li) => Math.abs(li.amount - rounded) <= EPSILON);
    if (candidate) {
      return { exactAmount: exact.amount, roundedTotal: candidate.amount, gap: candidate.amount - exact.amount };
    }
  }
  return null;
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
//
// Only fires for a line positioned BEFORE the subtotal it would bridge to
// the total. A line positioned AFTER a subtotal (arrears, LPSC, a late
// charge) is exactly where a real bridging charge legitimately sits -- and
// by arithmetic necessity, a single real bridging line's amount equals that
// same gap. Warning on that position would flag real arrears every single
// time, not just fabricated ones; there's no way to tell them apart by
// arithmetic alone once the line is where a real one is supposed to be, so
// this only watches the position where a coincidental match is genuinely
// suspicious -- before the subtotal, where a charge has no legitimate
// reason to equal a gap it comes before.
function computeSuspiciousGapWarnings(lineItems: BillLine[], total: number): SuspiciousGapWarning[] {
  const subtotals = lineItems
    .map((li, index) => ({ li, index }))
    .filter((entry) => entry.li.role === "subtotal");
  const warnings: SuspiciousGapWarning[] = [];
  lineItems.forEach((li, index) => {
    if (li.role !== "charge") return;
    const matchesAGap = subtotals.some(
      (s) => index < s.index && Math.abs(li.amount - (total - s.li.amount)) <= EPSILON
    );
    if (matchesAGap) {
      warnings.push({
        lineLabel: li.label,
        amount: li.amount,
        message: "This line makes the total add up exactly. Confirm it is printed on your bill.",
      });
    }
  });
  return warnings;
}

export function computeBillChecks(lineItems: BillLine[], total: number): BillChecks {
  const { lineItems: afterReclassify, reclassified: reclassifiedAsBalance } = reclassifyTotalLikeLines(
    lineItems,
    total
  );
  const { lineItems: afterTaxSummaryReclassify, reclassified: reclassifiedAsInfo } =
    reclassifyDuplicateTaxSummary(afterReclassify);
  const { lineItems: effectiveLineItems, note: taxIncludedNote } = detectTaxIncludedInPrice(
    afterTaxSummaryReclassify,
    total
  );

  const billedSum =
    sumByRole(effectiveLineItems, "charge") +
    sumByRole(effectiveLineItems, "tax") -
    sumByRole(effectiveLineItems, "discount");

  const roundedTotalNote = detectRoundedTotalPair(effectiveLineItems, billedSum);
  const effectiveTotal = roundedTotalNote ? roundedTotalNote.roundedTotal : total;

  const arithmeticDifference = billedSum - effectiveTotal;
  // A detected rounded-total pair IS the explanation for this gap, however
  // large the rounding increment (up to 10) made it -- never flag it as an
  // issue on top of already explaining it.
  let arithmeticIssue = roundedTotalNote ? false : Math.abs(arithmeticDifference) > ROUNDING_TOLERANCE;
  let arithmeticCoveredByPayment = false;

  // A receipt's "outstanding"/"arrears"/"previous due" balance line is
  // mentioned (never credited into the maths) when its amount matches the
  // payment/billed excess -- likely why the payment covered more than just
  // this period's new charge. billed = charge + tax - discount ONLY; an
  // outstanding balance is not folded in, so a receipt where the payment
  // exceeds the new charge by that exact amount is a real overpayment,
  // not a reconciled "even" -- see lib/verdict.ts's dedicated payment branch.
  const RECONCILING_BALANCE_LABEL = /outstanding|arrear|previous.?(due|balance)/i;

  // A 0-amount payment line (e.g. "Advance (Online): 0") is printed on some
  // bills as a placeholder, not an actual payment -- treated as absent, the
  // same as if the line weren't there at all.
  const paymentLines = effectiveLineItems.filter((li) => li.role === "payment" && li.amount > EPSILON);
  let payment =
    paymentLines.length === 0
      ? null
      : (() => {
          const amountPaid = paymentLines.reduce((s, li) => s + li.amount, 0);
          const signedDifference = billedSum - amountPaid;
          // Paying less than billed (or exactly billed is handled below) is
          // never reported: a partial payment isn't evidence of a billing
          // error, and the person already knows what they paid. Collapsed to
          // "no payment check at all", exactly like a 0-amount/absent line.
          if (signedDifference > ROUNDING_TOLERANCE) return null;
          const verdict: "overpaid" | "even" = signedDifference < -ROUNDING_TOLERANCE ? "overpaid" : "even";
          const reconcilingBalance = effectiveLineItems.find(
            (li) =>
              li.role === "balance" &&
              RECONCILING_BALANCE_LABEL.test(li.label) &&
              Math.abs(li.amount - Math.abs(signedDifference)) <= EPSILON
          );
          return { amountPaid, signedDifference, verdict, reconcilingBalanceLabel: reconcilingBalance?.label ?? null };
        })();

  // A payment-role line makes the dedicated payment check the relevant
  // lens for this bill (a receipt), not the generic billedSum-vs-total
  // comparison -- always suppress the generic one when payment is present,
  // regardless of whether payment itself reconciled.
  if (payment) {
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
    const gap = expectedClosing - effectiveTotal;
    statement = { expectedClosing, gap, issue: Math.abs(gap) > ROUNDING_TOLERANCE };
    payment = null;
    arithmeticIssue = false;
    arithmeticCoveredByPayment = false;
  }

  return {
    billedSum,
    effectiveTotal,
    roundedTotalNote,
    arithmeticDifference,
    arithmeticIssue,
    arithmeticCoveredByPayment,
    payment,
    checkpoints: computeCheckpoints(effectiveLineItems),
    warnings: computeSuspiciousGapWarnings(effectiveLineItems, total),
    reclassifiedAsBalance,
    reclassifiedAsInfo,
    taxIncludedNote,
    statement,
  };
}

// Removes only the first match, never every matching entry -- used by the
// review screen's "remove this line" button, where two genuinely identical
// lines (same label and amount) must not both vanish on one click.
export function removeFirstMatch<T>(items: T[], predicate: (item: T) => boolean): T[] {
  const index = items.findIndex(predicate);
  if (index === -1) return items;
  return items.filter((_, i) => i !== index);
}

// Review-screen amount inputs accept "1,234.56" as readily as "1234.56" --
// strips thousands separators, then requires a plain non-negative decimal
// (every amount in this app is a positive magnitude; sign is applied later,
// e.g. toPersistedLines negates discount). Returns null for anything else,
// so the input can show an inline "enter a valid number" error instead of
// silently treating garbage as 0.
export function parseAmountInput(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
