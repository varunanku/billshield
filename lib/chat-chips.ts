// Pure, no network -- picks which tappable suggestion chips to show above
// the follow-up chat input. Chosen entirely from facts the app already
// computed (never the LLM), and only ever when the chat can actually
// answer them: a tax chip only if the bill has tax lines, a flagged-line
// chip only if the verdict actually flagged one, a history chip only for
// a KNOWN provider with prior bills, a discount chip only if a discount
// line exists. Tapping one just sends its question through the existing
// chat path (app/page.tsx) -- this module only decides which chips exist.
//
// Rounds, not a one-time set: the SAME function is called again after
// each of the user's first three questions, with that growing list of
// already-asked questions passed back in -- a chip whose text exactly
// matches one already asked is never re-offered. The caller stops calling
// (and rendering) this entirely once 3 questions have been sent; there is
// no round-4 pool to draw from.
import { UNKNOWN_PROVIDER } from "./thank-you.ts";

export type ChatChip = { label: string; question: string };

const MAX_CHIPS = 4;

export function buildSuggestionChips(input: {
  hasTaxLines: boolean;
  confirmedTaxFinding: boolean; // true only when lib/gst.ts#findTaxOvercharge found a CONFIRMED overcharge
  effectiveTaxRatePercent: number | null; // the bill's own combined rate -- only used in the confirmedTaxFinding wording
  flaggedLineLabel: string | null; // the verdict's first disputed/unexplained line, if any
  hasProviderHistory: boolean; // true if an earlier bill from the same KNOWN provider exists
  provider: string | null; // null, or the "your provider" placeholder, both mean "unknown"
  hasCharges: boolean; // at least one charge-role line exists
  hasDiscount: boolean; // at least one discount-role line exists
  verdictOutcome: "clean" | "confirmed_error" | "cannot_verify" | "unexplained";
  askedQuestions: string[]; // exact question text already sent this session, this round and every round before it
}): ChatChip[] {
  const knownProvider = input.provider && input.provider !== UNKNOWN_PROVIDER ? input.provider : null;
  const candidates: ChatChip[] = [];

  if (input.hasTaxLines) {
    const q =
      input.confirmedTaxFinding && input.effectiveTaxRatePercent !== null
        ? `Why is the tax ${input.effectiveTaxRatePercent.toFixed(2)}%?`
        : "How much tax did I pay in total?";
    candidates.push({ label: q, question: q });
  }

  // The "where should I focus" slot -- prioritised just after tax, since
  // it's the single most actionable question either way (what's wrong, or
  // confirmation nothing is), ahead of the more specific optional slots
  // below when the 4-chip cap means not everything that qualifies fits.
  candidates.push(
    input.verdictOutcome === "clean"
      ? { label: "Is anything wrong with this bill?", question: "Is anything wrong with this bill?" }
      : knownProvider
        ? { label: `Which line should I ask ${knownProvider} about?`, question: `Which line should I ask ${knownProvider} about?` }
        : { label: "Which line should I ask about?", question: "Which line should I ask about?" }
  );

  if (input.flaggedLineLabel) {
    const q = `What does the ${input.flaggedLineLabel} line mean?`;
    candidates.push({ label: q, question: q });
  }

  if (input.hasProviderHistory && knownProvider) {
    const q = `Is this higher than my last ${knownProvider} bill?`;
    candidates.push({ label: q, question: q });
  }

  candidates.push({ label: "How was my total worked out?", question: "How was my total worked out?" });

  if (input.hasCharges) {
    const q = "What is the biggest charge on this bill?";
    candidates.push({ label: q, question: q });
  }

  if (input.hasDiscount) {
    const q = "Was a discount applied?";
    candidates.push({ label: q, question: q });
  }

  return candidates.filter((c) => !input.askedQuestions.includes(c.question)).slice(0, MAX_CHIPS);
}
