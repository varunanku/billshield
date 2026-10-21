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

// Click-tracking funnel over message_events (migration 0011), one row per
// tap. "Handoff" = copied or opened_email_app; "confirmed sent" =
// marked_sent. Counted per drafted message, except the median, which is
// over every handoff event that has a draft_kept_pct.
export type FunnelMessageRow = { id: string; is_default_tone: boolean };
export type MessageEventRow = {
  message_id: string;
  event_type: string;
  draft_kept_pct: number | string | null; // numeric can arrive as a string
  created_at: string;
};

export type Funnel = {
  draftsGenerated: number;
  draftsWithHandoff: number;
  copiedOnly: number;
  openedOnly: number;
  copiedAndOpened: number;
  confirmedSent: number;
  confirmedSentAfterHandoff: number; // a marked_sent at or after a handoff on the same draft
  confirmedSentKept90: number; // a marked_sent with draft_kept_pct >= 90
  medianKeptPctAtHandoff: number | null;
  sentAfterToneChange: number; // confirmed-sent drafts that used a tone preset
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 100) / 100;
}

export function computeFunnel(messages: FunnelMessageRow[], events: MessageEventRow[]): Funnel {
  const byMessage = new Map<string, MessageEventRow[]>();
  for (const m of messages) byMessage.set(m.id, []);
  for (const e of events) byMessage.get(e.message_id)?.push(e); // events for non-draft rows are ignored

  const isHandoff = (e: MessageEventRow) => e.event_type === "copied" || e.event_type === "opened_email_app";
  const pctOf = (e: MessageEventRow) => (e.draft_kept_pct === null ? null : Number(e.draft_kept_pct));
  const time = (e: MessageEventRow) => Date.parse(e.created_at);

  const f: Funnel = {
    draftsGenerated: messages.length,
    draftsWithHandoff: 0,
    copiedOnly: 0,
    openedOnly: 0,
    copiedAndOpened: 0,
    confirmedSent: 0,
    confirmedSentAfterHandoff: 0,
    confirmedSentKept90: 0,
    medianKeptPctAtHandoff: null,
    sentAfterToneChange: 0,
  };
  const handoffPcts: number[] = [];

  for (const m of messages) {
    const evs = byMessage.get(m.id) ?? [];
    const copied = evs.some((e) => e.event_type === "copied");
    const opened = evs.some((e) => e.event_type === "opened_email_app");
    const handoffs = evs.filter(isHandoff);
    const sends = evs.filter((e) => e.event_type === "marked_sent");

    for (const h of handoffs) {
      const p = pctOf(h);
      if (p !== null && Number.isFinite(p)) handoffPcts.push(p);
    }
    if (copied || opened) f.draftsWithHandoff++;
    if (copied && opened) f.copiedAndOpened++;
    else if (copied) f.copiedOnly++;
    else if (opened) f.openedOnly++;

    if (sends.length > 0) {
      f.confirmedSent++;
      const firstHandoff = Math.min(...handoffs.map(time));
      if (sends.some((s) => time(s) >= firstHandoff)) f.confirmedSentAfterHandoff++;
      if (sends.some((s) => (pctOf(s) ?? -1) >= 90)) f.confirmedSentKept90++;
      if (!m.is_default_tone) f.sentAfterToneChange++;
    }
  }

  f.medianKeptPctAtHandoff = median(handoffPcts);
  return f;
}
