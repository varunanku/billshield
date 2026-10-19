// Server Component: reads straight off the signed-in user's own RLS-scoped
// bills -- proxy.ts already redirects a signed-out visit to /login before
// this ever renders, same as every other page. Every number shown
// (change vs previous/average) is computed in lib/history.ts, never by
// the LLM.
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { groupBillsByProvider } from "@/lib/history";
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

// Per-user data behind cookie-based auth -- can't be statically
// prerendered, so the cookie/DB access lives in this inner component,
// wrapped in Suspense by the page shell below (Cache Components requires
// this instead of the classic `export const dynamic = "force-dynamic"`).
async function BillsList() {
  const supabase = await createClient();
  const { data: bills } = await supabase
    .from("bills")
    .select("id, provider_name, bill_date, total_amount, verdict_outcome")
    .order("bill_date", { ascending: false });

  const groups = groupBillsByProvider(
    (bills ?? []).map((b) => ({
      id: b.id,
      provider: b.provider_name,
      billDate: b.bill_date,
      total: Number(b.total_amount),
      verdictOutcome: b.verdict_outcome,
    }))
  );

  if (groups.length === 0) {
    return <p className="text-ink-muted">No bills yet -- upload one to see it here.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.provider} className="rounded-xl border border-line bg-card p-5 shadow-sm">
          <h2 className="mb-3 font-medium">
            {g.provider} <span className="font-normal text-ink-muted">({g.bills.length} bill{g.bills.length === 1 ? "" : "s"})</span>
          </h2>
          <div className="flex flex-col divide-y divide-line">
            {g.bills.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm">
                <span className="text-ink-muted">{b.billDate}</span>
                <span className="tabular-nums font-medium">Rs {money(b.total)}</span>
                <span className="text-xs text-ink-muted">
                  {b.verdictOutcome ? (VERDICT_LABELS[b.verdictOutcome] ?? b.verdictOutcome) : "--"}
                </span>
                {b.changeVsPrevious !== null && (
                  <span className={`text-xs ${b.changeVsPrevious > 0 ? "text-brick" : "text-emerald"}`}>
                    {b.changeVsPrevious > 0 ? "+" : ""}
                    {money(b.changeVsPrevious)} vs previous
                  </span>
                )}
                {b.changeVsAverage !== null && (
                  <span className="text-xs text-ink-muted">
                    {b.changeVsAverage > 0 ? "+" : ""}
                    {money(b.changeVsAverage)} vs average
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function BillsPage() {
  return (
    <main className="mx-auto w-full max-w-[900px] px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-serif text-2xl">My bills</h1>
        <Link href="/" className="text-sm text-ink-muted transition-colors hover:text-ink">
          ← Back
        </Link>
      </div>
      <Suspense fallback={<p className="text-ink-muted">Loading...</p>}>
        <BillsList />
      </Suspense>
    </main>
  );
}
