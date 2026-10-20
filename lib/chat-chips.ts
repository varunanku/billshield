// Pure, no network -- picks which tappable suggestion chips to show above
// the follow-up chat input. Chosen entirely from facts the app already
// computed (never the LLM), and only when the chat can actually answer
// them: a tax chip only if the bill has tax lines, a flagged-line chip
// only if the verdict actually flagged one, a history chip only if there
// is prior history for a KNOWN provider. Tapping one just sends its
// question through the existing chat path (app/page.tsx) -- this module
// only decides which chips exist, never answers anything itself.
import { UNKNOWN_PROVIDER } from "./thank-you.ts";

export type ChatChip = { label: string; question: string };

const MAX_CHIPS = 4;

export function buildSuggestionChips(input: {
  effectiveTaxRatePercent: number | null; // null when the bill has no tax lines (or no taxable base)
  flaggedLineLabel: string | null; // the verdict's first disputed/unexplained line, if any
  hasProviderHistory: boolean; // true if an earlier bill from the same provider exists
  provider: string | null; // null, or the "your provider" placeholder, both mean "unknown"
}): ChatChip[] {
  const knownProvider = input.provider && input.provider !== UNKNOWN_PROVIDER ? input.provider : null;
  const chips: ChatChip[] = [];

  if (input.effectiveTaxRatePercent !== null) {
    const rate = `${input.effectiveTaxRatePercent.toFixed(2)}%`;
    chips.push({ label: `Why is the tax ${rate}?`, question: `Why is the tax ${rate}?` });
  }

  if (input.flaggedLineLabel) {
    const q = `What does the ${input.flaggedLineLabel} line mean?`;
    chips.push({ label: q, question: q });
  }

  if (input.hasProviderHistory && knownProvider) {
    const q = `Is this higher than my last ${knownProvider} bill?`;
    chips.push({ label: q, question: q });
  }

  chips.push({ label: "How was my total worked out?", question: "How was my total worked out?" });

  chips.push(
    knownProvider
      ? { label: `Which line should I ask ${knownProvider} about?`, question: `Which line should I ask ${knownProvider} about?` }
      : { label: "Which line should I ask about?", question: "Which line should I ask about?" }
  );

  return chips.slice(0, MAX_CHIPS);
}
