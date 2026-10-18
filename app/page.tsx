"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { computeBillChecks, LINE_ROLES, type BillLine, type LineRole, type BillChecks } from "@/lib/bill-checks";

type ExtractedBill = {
  provider: string | null;
  bill_date: string | null;
  total: number | null;
  line_items: BillLine[];
};

type ExtractResponse =
  | { success: true; extraction: ExtractedBill; notice: string | null }
  | { success: false; reason: string; message: string; notice?: string };

type ConfirmedBill = {
  id: string;
  provider: string;
  billDate: string;
  total: number;
  lineItems: (BillLine & { amount: number })[];
};

type ConfirmResponse =
  | { success: true; bill: ConfirmedBill; checks: BillChecks }
  | { success: false; reason: string; message: string };

type EditableLine = { label: string; amount: string; role: LineRole };

type Stage =
  | { name: "upload" }
  | { name: "uploading" }
  | { name: "extracting" }
  | { name: "reviewing"; notice: string | null }
  | { name: "confirming" }
  | { name: "done"; bill: ConfirmedBill; checks: BillChecks }
  | { name: "error"; message: string; notice?: string };

function extensionFor(file: File): string {
  if (file.type === "application/pdf") return "pdf";
  const fromType = file.type.split("/")[1];
  if (fromType) return fromType;
  return file.name.split(".").pop() || "bin";
}

const ROLE_LABELS: Record<LineRole, string> = {
  charge: "Charge",
  tax: "Tax",
  discount: "Discount",
  payment: "Payment",
  balance: "Balance",
  subtotal: "Subtotal",
};

export default function UploadPage() {
  const router = useRouter();
  const supabase = createClient();
  const [file, setFile] = useState<File | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "upload" });

  const [provider, setProvider] = useState("");
  const [billDate, setBillDate] = useState("");
  const [total, setTotal] = useState("");
  const [lines, setLines] = useState<EditableLine[]>([]);

  const parsedLines: BillLine[] = useMemo(
    () => lines.map((l) => ({ label: l.label, amount: Number(l.amount) || 0, role: l.role })),
    [lines]
  );
  const parsedTotal = Number(total) || 0;
  const livePreview = useMemo(() => computeBillChecks(parsedLines, parsedTotal), [parsedLines, parsedTotal]);

  const canConfirm =
    provider.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(billDate) &&
    total.trim().length > 0 &&
    lines.length > 0 &&
    lines.every((l) => l.label.trim().length > 0 && l.amount.trim().length > 0);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setStage({ name: "uploading" });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      setStage({ name: "error", message: "Please sign in again." });
      return;
    }

    // ponytail: the file lands in storage here, before any review/confirm --
    // unavoidable given Vercel's 4.5MB function body limit (the file has to
    // go straight from the browser to storage, not through our API). If the
    // user abandons the flow before confirming, this file is now orphaned
    // (no bill row ever points at it). Add a cleanup job if that piles up.
    const path = `${user.id}/${crypto.randomUUID()}.${extensionFor(file)}`;
    const { error: uploadError } = await supabase.storage
      .from("bills")
      .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });

    if (uploadError) {
      setStage({ name: "error", message: `Couldn't upload your file: ${uploadError.message}` });
      return;
    }
    setUploadedPath(path);
    setStage({ name: "extracting" });

    try {
      const res = await fetch("/api/bills/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data: ExtractResponse = await res.json();

      if (!data.success) {
        setStage({ name: "error", message: data.message, notice: data.notice });
        return;
      }

      setProvider(data.extraction.provider ?? "");
      setBillDate(data.extraction.bill_date ?? "");
      setTotal(data.extraction.total !== null ? String(data.extraction.total) : "");
      setLines(
        data.extraction.line_items.map((li) => ({ label: li.label, amount: String(li.amount), role: li.role }))
      );
      setStage({ name: "reviewing", notice: data.notice });
    } catch {
      setStage({ name: "error", message: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  async function handleConfirm() {
    if (!uploadedPath || !canConfirm) return;
    setStage({ name: "confirming" });

    try {
      const res = await fetch("/api/bills/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: uploadedPath,
          provider,
          bill_date: billDate,
          total: parsedTotal,
          line_items: parsedLines,
        }),
      });
      const data: ConfirmResponse = await res.json();

      if (!data.success) {
        setStage({ name: "error", message: data.message });
        return;
      }
      setStage({ name: "done", bill: data.bill, checks: data.checks });
    } catch {
      setStage({ name: "error", message: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  function startOver() {
    setFile(null);
    setUploadedPath(null);
    setProvider("");
    setBillDate("");
    setTotal("");
    setLines([]);
    setStage({ name: "upload" });
  }

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <main style={{ maxWidth: 680, margin: "2rem auto", padding: "0 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>BillShield</h1>
        <button onClick={handleSignOut}>Sign out</button>
      </div>

      {stage.name === "upload" && (
        <>
          <p style={{ background: "#fff3cd", padding: "0.75rem", borderRadius: 4 }}>
            Your bill image is read by an AI provider (Groq) to pull out the line items.
            Please mask your name, address, phone number and account number before
            uploading -- we also run an automatic backstop, but masking it yourself first is safer.
          </p>
          <form onSubmit={handleUpload} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            <button type="submit" disabled={!file}>
              Upload
            </button>
          </form>
        </>
      )}

      {stage.name === "uploading" && <p>Uploading...</p>}
      {stage.name === "extracting" && <p>Reading your bill...</p>}

      {stage.name === "reviewing" && (
        <section style={{ marginTop: "1.5rem" }}>
          {stage.notice && <p style={{ color: "#856404" }}>{stage.notice}</p>}
          <p>Check this against your paper bill and fix anything that&apos;s wrong.</p>

          <label>
            Provider
            <input value={provider} onChange={(e) => setProvider(e.target.value)} style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            Bill date (YYYY-MM-DD)
            <input value={billDate} onChange={(e) => setBillDate(e.target.value)} placeholder="YYYY-MM-DD" style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            Printed total
            <input value={total} onChange={(e) => setTotal(e.target.value)} style={{ display: "block", width: "100%" }} />
          </label>

          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Label</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ccc" }}>Amount</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Role</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td>
                    <input value={line.label} onChange={(e) => updateLine(i, { label: e.target.value })} style={{ width: "100%" }} />
                  </td>
                  <td>
                    <input
                      value={line.amount}
                      onChange={(e) => updateLine(i, { amount: e.target.value })}
                      style={{ width: "100%", textAlign: "right" }}
                    />
                  </td>
                  <td>
                    <select value={line.role} onChange={(e) => updateLine(i, { role: e.target.value as LineRole })}>
                      {LINE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p style={{ marginTop: "0.75rem" }}>
            Sum of charge + tax − discount lines: <strong>{livePreview.billedSum.toFixed(2)}</strong>
            {" vs printed total "}
            <strong>{parsedTotal.toFixed(2)}</strong>
            {livePreview.arithmeticIssue ? (
              <span style={{ color: "#721c24" }}> -- differs by {livePreview.arithmeticDifference.toFixed(2)}</span>
            ) : (
              <span style={{ color: "#155724" }}> -- matches</span>
            )}
          </p>
          {livePreview.payment && (
            <p>
              Payment check: billed {livePreview.billedSum.toFixed(2)} vs paid {livePreview.payment.amountPaid.toFixed(2)} --{" "}
              {livePreview.payment.verdict === "overpaid"
                ? `overpaid by ${Math.abs(livePreview.payment.signedDifference).toFixed(2)}`
                : livePreview.payment.verdict === "dispute"
                ? `underpaid by ${livePreview.payment.signedDifference.toFixed(2)}`
                : "paid in full"}
            </p>
          )}

          <button onClick={handleConfirm} disabled={!canConfirm} style={{ marginTop: "1rem" }}>
            This matches my paper bill
          </button>
        </section>
      )}

      {stage.name === "confirming" && <p>Saving...</p>}

      {stage.name === "done" && (
        <section style={{ marginTop: "1.5rem" }}>
          <p style={{ color: "#155724" }}>Saved.</p>
          <p>
            <strong>{stage.bill.provider}</strong> -- {stage.bill.billDate}
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Line</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ccc" }}>Amount</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Role</th>
              </tr>
            </thead>
            <tbody>
              {stage.bill.lineItems.map((li, i) => (
                <tr key={i}>
                  <td>{li.label}</td>
                  <td style={{ textAlign: "right" }}>{li.amount.toFixed(2)}</td>
                  <td>{ROLE_LABELS[li.role]}</td>
                </tr>
              ))}
              <tr>
                <td style={{ fontWeight: "bold", borderTop: "1px solid #ccc" }}>Total</td>
                <td style={{ textAlign: "right", fontWeight: "bold", borderTop: "1px solid #ccc" }}>{stage.bill.total.toFixed(2)}</td>
                <td style={{ borderTop: "1px solid #ccc" }} />
              </tr>
            </tbody>
          </table>
          <p style={{ marginTop: "0.75rem" }}>
            {stage.checks.arithmeticIssue ? (
              <span style={{ color: "#721c24" }}>
                Arithmetic-proven issue: charge/tax/discount lines differ from the printed total by {stage.checks.arithmeticDifference.toFixed(2)}.
              </span>
            ) : (
              <span style={{ color: "#155724" }}>✓ The charge/tax/discount lines add up to the printed total.</span>
            )}
          </p>
          {stage.checks.payment && (
            <p>
              {stage.checks.payment.verdict === "overpaid" &&
                `You appear to have overpaid by ${Math.abs(stage.checks.payment.signedDifference).toFixed(2)}.`}
              {stage.checks.payment.verdict === "dispute" &&
                `You appear to have underpaid (or been billed more) by ${stage.checks.payment.signedDifference.toFixed(2)}.`}
              {stage.checks.payment.verdict === "even" && "Amount paid matches what was billed."}
            </p>
          )}
          <button onClick={startOver} style={{ marginTop: "1rem" }}>
            Upload another bill
          </button>
        </section>
      )}

      {stage.name === "error" && (
        <section style={{ marginTop: "1.5rem" }}>
          {stage.notice && <p style={{ color: "#856404" }}>{stage.notice}</p>}
          <p style={{ color: "#721c24" }}>{stage.message}</p>
          <button onClick={startOver}>Start over</button>
        </section>
      )}
    </main>
  );
}
