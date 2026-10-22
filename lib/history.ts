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
