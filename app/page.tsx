"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Bill = {
  id: string;
  provider: string;
  billDate: string;
  total: number;
  lineItems: { label: string; amount: number }[];
};

type ApiResponse =
  | { success: true; bill: Bill; notice: string | null }
  | { success: false; reason: string; message: string; notice?: string };

export default function UploadPage() {
  const router = useRouter();
  const supabase = createClient();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResponse | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/bills/extract", { method: "POST", body: formData });
      const data: ApiResponse = await res.json();
      setResult(data);
    } catch {
      setResult({ success: false, reason: "network_error", message: "Couldn't reach the server. Check your connection and try again." });
    } finally {
      setLoading(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <main style={{ maxWidth: 560, margin: "2rem auto", padding: "0 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>BillShield</h1>
        <button onClick={handleSignOut}>Sign out</button>
      </div>

      <p style={{ background: "#fff3cd", padding: "0.75rem", borderRadius: 4 }}>
        Your bill image is read by an AI provider (Groq) to pull out the line items.
        Please mask your name, address, phone number and account number before
        uploading -- we also run an automatic backstop, but masking it yourself first is safer.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
        <button type="submit" disabled={!file || loading}>
          {loading ? "Reading..." : "Upload"}
        </button>
      </form>

      {result && <ResultView result={result} onRetry={handleSubmit} />}
    </main>
  );
}

function ResultView({ result, onRetry }: { result: ApiResponse; onRetry: (e: React.FormEvent) => void }) {
  if (result.success) {
    return (
      <section style={{ marginTop: "1.5rem" }}>
        {result.notice && <p style={{ color: "#856404" }}>{result.notice}</p>}
        <p>
          <strong>{result.bill.provider}</strong> -- {result.bill.billDate}
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Line</th>
              <th style={{ textAlign: "right", borderBottom: "1px solid #ccc" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {result.bill.lineItems.map((li, i) => (
              <tr key={i}>
                <td>{li.label}</td>
                <td style={{ textAlign: "right" }}>{li.amount.toFixed(2)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ fontWeight: "bold", borderTop: "1px solid #ccc" }}>Total</td>
              <td style={{ textAlign: "right", fontWeight: "bold", borderTop: "1px solid #ccc" }}>
                {result.bill.total.toFixed(2)}
              </td>
            </tr>
          </tbody>
        </table>
        <p style={{ color: "#155724" }}>✓ The lines add up to the printed total.</p>
      </section>
    );
  }

  return (
    <section style={{ marginTop: "1.5rem" }}>
      {result.notice && <p style={{ color: "#856404" }}>{result.notice}</p>}
      <p style={{ color: "#721c24" }}>{result.message}</p>
      {result.reason === "rate_limited" && (
        <button onClick={(e) => onRetry(e)}>Try again</button>
      )}
    </section>
  );
}
