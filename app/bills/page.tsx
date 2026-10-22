// Server Component: reads straight off the signed-in user's own RLS-scoped
// bills -- proxy.ts already redirects a signed-out visit to /login before
// this ever renders, same as every other page. Every number shown
// (change vs previous/average) is computed in lib/history.ts, never by
// the LLM.
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { groupBillsByProvider } from "@/lib/history";
import { mergeMonthlyHistory, monthOfBill, monthName, printedLabel, type PrintedMonth } from "@/lib/printed-history";
import Link from "next/link";

function money(n: number) {
  return n.toFixed(2);
}

const VERDICT_LABELS: Record<string, string> = {
  clean: "Clean",
  confirmed_error: "Flagged",
  cannot_verify: "Couldn't verify",
  unexplained: "Unexplained",
};

// green/amber/red pill, same roles as the verdict banner on the main flow.
const VERDICT_BADGE_CLASSES: Record<string, string> = {
  clean: "bg-success-soft text-success",
  confirmed_error: "bg-danger-soft text-danger",
  cannot_verify: "bg-warning-soft text-warning",
  unexplained: "bg-warning-soft text-warning",
};

function VerdictBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="text-xs text-text-muted">--</span>;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        VERDICT_BADGE_CLASSES[outcome] ?? "bg-border text-text-muted"
      }`}
    >
      {VERDICT_LABELS[outcome] ?? outcome}
    </span>
  );
}

// Provider "logo" stand-in: colored initials in a circle -- deterministic
// color per provider name so the same provider always gets the same color.
const INITIAL_CIRCLE_COLORS = [
  "bg-accent-soft text-accent",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
  "bg-danger-soft text-danger",
];
function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}
function colorIndexFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % INITIAL_CIRCLE_COLORS.length;
  return hash;
}
function ProviderAvatar({ provider }: { provider: string }) {
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${INITIAL_CIRCLE_COLORS[colorIndexFor(provider)]}`}
    >
      {initialsFor(provider)}
    </span>
  );
}

// Per-user data behind cookie-based auth -- can't be statically
// prerendered, so the cookie/DB access lives in this inner component,
// wrapped in Suspense by the page shell below (Cache Components requires
// this instead of the classic `export const dynamic = "force-dynamic"`).
async function BillsList() {
  const supabase = await createClient();
  const { data: bills } = await supabase
    .from("bills")
    .select("id, provider_name, bill_date, billing_period_start, total_amount, verdict_outcome")
    .order("bill_date", { ascending: false });

  // Past months printed on these bills (electricity/water). Best-effort:
  // if the query fails, the page just shows the saved bills as before.
  const { data: printedRows } = await supabase
    .from("bill_printed_history")
    .select("bill_id, period_label, period_start, amount, units, amount_paid, paid_on");
  const billById = new Map((bills ?? []).map((b) => [b.id, b]));
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

  // Months that exist only as printed figures for a provider's bills --
  // a month with a real saved bill always shows that bill instead.
  function printedOnlyMonths(billIds: string[]) {
    const ids = new Set(billIds);
    const checked = billIds.map((id) => {
      const b = billById.get(id)!;
      return { month: monthOfBill(b), billDate: b.bill_date, total: Number(b.total_amount), units: null };
    });
    const printed: PrintedMonth[] = (printedRows ?? [])
      .filter((r) => ids.has(r.bill_id))
      .map((r) => ({
        period_label: r.period_label,
        period_start: r.period_start,
        amount: n(r.amount),
        units: n(r.units),
        amount_paid: n(r.amount_paid),
        paid_on: r.paid_on,
        sourceBillDate: billById.get(r.bill_id)!.bill_date,
      }));
    return mergeMonthlyHistory(checked, printed)
      .filter((m) => m.source === "printed")
      .reverse();
  }

  const groups = groupBillsByProvider(
    (bills ?? []).map((b) => ({
      id: b.id,
      // "Unknown provider" is confirm's storage-only placeholder for the
      // NOT NULL provider_name column -- never shown to a user.
      provider: b.provider_name === "Unknown provider" ? "your provider" : b.provider_name,
      billDate: b.bill_date,
      total: Number(b.total_amount),
      verdictOutcome: b.verdict_outcome,
    }))
  );

  if (groups.length === 0) {
    return <p className="text-text-muted">No bills yet -- upload one to see it here.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.provider} className="animate-fade-up rounded-lg border border-border bg-surface p-5 shadow-card">
          <h2 className="mb-3 flex items-center gap-2 font-bold">
            <ProviderAvatar provider={g.provider} />
            {g.provider} <span className="font-normal text-text-muted">({g.bills.length} bill{g.bills.length === 1 ? "" : "s"})</span>
          </h2>
          <div className="flex flex-col divide-y divide-border">
            {g.bills.map((b, i) => (
              <div key={b.id} className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-2 py-2 text-sm ${i % 2 === 1 ? "bg-surface-alt" : ""}`}>
                <span className="text-text-muted">{b.billDate}</span>
                <span className="font-mono tabular-nums font-medium">Rs {money(b.total)}</span>
                <VerdictBadge outcome={b.verdictOutcome} />
                {b.changeVsPrevious !== null && (
                  <span className={`text-xs ${b.changeVsPrevious > 0 ? "text-danger" : "text-success"}`}>
                    {b.changeVsPrevious > 0 ? "+" : ""}
                    {money(b.changeVsPrevious)} vs previous
                  </span>
                )}
                {b.changeVsAverage !== null && (
                  <span className="text-xs text-text-muted">
                    {b.changeVsAverage > 0 ? "+" : ""}
                    {money(b.changeVsAverage)} vs average
                  </span>
                )}
              </div>
            ))}
          </div>
          {(() => {
            const printed = printedOnlyMonths(g.bills.map((b) => b.id));
            if (printed.length === 0) return null;
            return (
              <div className="mt-3 flex flex-col gap-1 border-t border-border pt-3 text-xs text-text-muted">
                <span className="font-medium">Earlier months, as printed on your bills</span>
                {printed.map((m) => (
                  <span key={m.month}>
                    {monthName(m.month)}:{" "}
                    {[
                      m.amount !== null ? `Rs ${money(m.amount)}` : null,
                      m.units !== null ? `${m.units} units` : null,
                      m.amountPaid !== null ? `paid Rs ${money(m.amountPaid)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}{" "}
                    -- {printedLabel(m.printedOn!)}
                  </span>
                ))}
              </div>
            );
          })()}
        </section>
      ))}
    </div>
  );
}

export default function BillsPage() {
  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">My bills</h1>
        <Link href="/" className="text-sm text-text-muted transition-colors hover:text-text">
          ← Back
        </Link>
      </div>
      <Suspense fallback={<p className="text-text-muted">Loading...</p>}>
        <BillsList />
      </Suspense>
    </main>
  );
}
