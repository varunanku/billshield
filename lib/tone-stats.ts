// Pure aggregation over messages rows (type='dispute') for
// scripts/tone-stats.mjs -- split out so it's testable with a fixture, no
// network/DB needed.
export type DisputeMessageRow = {
  bill_id: string;
  tone_preset_used: string | null;
  version: number;
  is_default_tone: boolean;
  edited_before_send: boolean | null;
  action_taken: string | null;
};

const SENT_ACTIONS = new Set(["sent_as_is", "sent_with_tone_preset", "sent_manually_edited"]);

export type ToneStats = {
  emailsSent: number;
  percentSentWithDefaultTone: number; // of emailsSent
  percentRegeneratedAtLeastOnce: number; // of all bills with a dispute email
  mostChosenTone: string | null; // mode of tone_preset_used across every regeneration (sent or not)
  percentEditedBeforeSend: number; // of emailsSent
};

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

export function computeToneStats(rows: DisputeMessageRow[]): ToneStats {
  const sentRows = rows.filter((r) => r.action_taken !== null && SENT_ACTIONS.has(r.action_taken));
  const emailsSent = sentRows.length;

  const maxVersionByBill = new Map<string, number>();
  for (const r of rows) {
    maxVersionByBill.set(r.bill_id, Math.max(maxVersionByBill.get(r.bill_id) ?? 1, r.version));
  }
  const totalBills = maxVersionByBill.size;
  const regeneratedBills = [...maxVersionByBill.values()].filter((v) => v > 1).length;

  const toneCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.tone_preset_used) toneCounts.set(r.tone_preset_used, (toneCounts.get(r.tone_preset_used) ?? 0) + 1);
  }
  let mostChosenTone: string | null = null;
  let best = 0;
  for (const [tone, count] of toneCounts) {
    if (count > best) {
      best = count;
      mostChosenTone = tone;
    }
  }

  return {
    emailsSent,
    percentSentWithDefaultTone: pct(sentRows.filter((r) => r.is_default_tone).length, emailsSent),
    percentRegeneratedAtLeastOnce: pct(regeneratedBills, totalBills),
    mostChosenTone,
    percentEditedBeforeSend: pct(sentRows.filter((r) => r.edited_before_send === true).length, emailsSent),
  };
}
