// Pure grouping/comparison for the "My bills" page -- no network. Every
// number here is a plain arithmetic derivation from bills the caller
// already fetched (RLS-scoped, so always just the current user's own),
// never anything the LLM touches.
export type BillSummary = { id: string; provider: string; billDate: string; total: number; verdictOutcome: string | null };

export type BillWithHistory = BillSummary & {
  changeVsPrevious: number | null; // this bill's total minus the immediately preceding one for the same provider
  changeVsAverage: number | null; // this bill's total minus the average of every earlier bill for the same provider
};

export type ProviderGroup = { provider: string; bills: BillWithHistory[] };

export function groupBillsByProvider(bills: BillSummary[]): ProviderGroup[] {
  const byProvider = new Map<string, BillSummary[]>();
  for (const b of bills) {
    const list = byProvider.get(b.provider) ?? [];
    list.push(b);
    byProvider.set(b.provider, list);
  }

  const groups: ProviderGroup[] = [];
  for (const [provider, list] of byProvider) {
    const sorted = [...list].sort((a, b) => a.billDate.localeCompare(b.billDate));
    const withHistory: BillWithHistory[] = sorted.map((bill, i) => {
      if (i === 0) return { ...bill, changeVsPrevious: null, changeVsAverage: null };
      const earlier = sorted.slice(0, i);
      const average = earlier.reduce((s, b) => s + b.total, 0) / earlier.length;
      return {
        ...bill,
        changeVsPrevious: bill.total - sorted[i - 1].total,
        changeVsAverage: bill.total - average,
      };
    });
    // Newest first for display -- the comparisons above were computed in
    // chronological order, so this re-sort happens after, not before.
    groups.push({ provider, bills: withHistory.slice().reverse() });
  }
  return groups.sort((a, b) => a.provider.localeCompare(b.provider));
}

// For the history-aware chat's get_history tool call: the model asks for
// a provider/metric/months; the route queries that user's own RLS-scoped
// rows and hands this computed result back for the model to phrase, never
// a raw row list it could recompute or misstate.
export type HistoryQueryResult = {
  count: number;
  averageBeforeLatest: number | null; // average of every bill strictly before the most recent one
  latestValue: number | null;
  latestDate: string | null;
};

export function computeHistoryQuery(values: { billDate: string; value: number }[]): HistoryQueryResult {
  if (values.length === 0) return { count: 0, averageBeforeLatest: null, latestValue: null, latestDate: null };
  const sorted = [...values].sort((a, b) => a.billDate.localeCompare(b.billDate));
  const latest = sorted[sorted.length - 1];
  const earlier = sorted.slice(0, -1);
  const averageBeforeLatest = earlier.length > 0 ? earlier.reduce((s, v) => s + v.value, 0) / earlier.length : null;
  return { count: values.length, averageBeforeLatest, latestValue: latest.value, latestDate: latest.billDate };
}
