"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  computeBillChecks,
  removeFirstMatch,
  parseAmountInput,
  LINE_ROLES,
  EPSILON,
  type BillLine,
  type LineRole,
  type BillChecks,
} from "@/lib/bill-checks";
import type { Verdict } from "@/lib/verdict";

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
  | { success: true; bill: ConfirmedBill; checks: BillChecks; verdict: Verdict }
  | { success: false; reason: string; message: string };

type DraftEmailResponse =
  | { success: true; messageId: string; subject: string; body: string }
  | { success: false; reason: string; message: string };

type EditableLine = { label: string; amount: string; role: LineRole; unrecognized?: boolean };

type Stage =
  | { name: "upload" }
  | { name: "uploading" }
  | { name: "extracting" }
  | { name: "reviewing"; notice: string | null }
  | { name: "confirming" }
  | { name: "done"; bill: ConfirmedBill; checks: BillChecks; verdict: Verdict }
  | { name: "error"; message: string; notice?: string };

function extensionFor(file: File): string {
  if (file.type === "application/pdf") return "pdf";
  const fromType = file.type.split("/")[1];
  if (fromType) return fromType;
  return file.name.split(".").pop() || "bin";
}

// HEIC/HEIF (the default format for iPhone photos) isn't a supported
// upload type. Browsers are inconsistent about reporting its mime type --
// Safari/iOS often leaves file.type blank for a HEIC picked via a file
// input -- so check the extension too, not just file.type.
function isHeicFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  const name = file.name.toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

const ROLE_LABELS: Record<LineRole, string> = {
  charge: "Charge",
  tax: "Tax",
  discount: "Discount",
  payment: "Payment",
  balance: "Balance",
  subtotal: "Subtotal",
  info: "Info",
  opening: "Opening",
};

// Shared between the live review-screen preview and the saved "done"
// summary -- same checks, same wording, two points in the flow.
// onRemoveLine is only passed on the review screen (lines are no longer
// editable once a bill is saved), so the one-click remove button only
// shows up there -- the "done" screen still shows the same message, just
// without an action attached to it.
function ChecksSummary({
  checks,
  total,
  onRemoveLine,
}: {
  checks: BillChecks;
  total: number;
  onRemoveLine?: (label: string, amount: number) => void;
}) {
  const showGenericArithmetic = !checks.arithmeticCoveredByPayment && !checks.statement;

  return (
    <div style={{ marginTop: "0.75rem" }}>
      {checks.reclassifiedAsBalance.map((r, i) => (
        <p key={i} style={{ color: "#856404" }}>
          Note: treated &quot;{r.label}&quot; as the printed total, not a charge, since it matched the bill&apos;s own
          total ({r.amount.toFixed(2)}).
        </p>
      ))}

      {checks.taxIncludedNote && <p style={{ color: "#856404" }}>Note: {checks.taxIncludedNote}</p>}

      {showGenericArithmetic && (
        <>
          <p>
            Sum of charge + tax − discount lines: <strong>{checks.billedSum.toFixed(2)}</strong>
            {" vs printed total "}
            <strong>{total.toFixed(2)}</strong>
          </p>
          {checks.arithmeticIssue ? (
            <p style={{ color: "#856404" }}>
              These lines don&apos;t add up to the printed total, so a line may be missing or misread. Compare with
              your paper bill.
            </p>
          ) : (
            <p style={{ color: "#155724" }}>✓ These lines add up to the printed total.</p>
          )}
        </>
      )}

      {checks.statement && (
        <>
          <p>
            Opening balance + charges + tax − discounts − payments: <strong>{checks.statement.expectedClosing.toFixed(2)}</strong>
            {" vs printed total "}
            <strong>{total.toFixed(2)}</strong>
          </p>
          {checks.statement.issue ? (
            <p style={{ color: "#856404" }}>
              These don&apos;t add up to the printed total, so a line may be missing or misread. Compare with your
              paper bill.
            </p>
          ) : Math.abs(checks.statement.gap) > EPSILON ? (
            <p style={{ color: "#155724" }}>✓ Matches within rounding.</p>
          ) : (
            <p style={{ color: "#155724" }}>✓ These add up to the printed total.</p>
          )}
        </>
      )}

      {checks.checkpoints.length > 0 && (
        <div>
          <p style={{ marginBottom: 4 }}>Checkpoints:</p>
          <ul style={{ marginTop: 0 }}>
            {checks.checkpoints.map((c, i) => {
              const offBy = Math.abs(c.gap) > EPSILON;
              return (
                <li key={i} style={{ color: offBy ? "#856404" : "#155724" }}>
                  {c.label}: expected {c.expected.toFixed(2)}, got {c.actual.toFixed(2)}
                  {offBy
                    ? ` -- these don't match (gap of ${c.gap.toFixed(2)}), so a line in this section may be missing or misread.`
                    : " -- matches"}
                  {offBy && c.suggestion && (
                    <div style={{ marginTop: 2 }}>
                      Removing &quot;{c.suggestion.label}&quot; would make this section add up.
                      {onRemoveLine && (
                        <button
                          type="button"
                          onClick={() => onRemoveLine(c.suggestion!.label, c.suggestion!.amount)}
                          style={{ marginLeft: 8 }}
                        >
                          Remove &quot;{c.suggestion.label}&quot;
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {checks.warnings.map((w, i) => (
        <p key={i} style={{ color: "#856404" }}>
          Note: &quot;{w.lineLabel}&quot; ({w.amount.toFixed(2)}) -- {w.message}
        </p>
      ))}

      {checks.payment && (
        <p>
          Payment check: billed {checks.billedSum.toFixed(2)} vs paid {checks.payment.amountPaid.toFixed(2)} --{" "}
          {checks.payment.verdict === "overpaid"
            ? `overpaid by ${Math.abs(checks.payment.signedDifference).toFixed(2)}`
            : checks.payment.verdict === "dispute"
            ? `underpaid by ${checks.payment.signedDifference.toFixed(2)}`
            : "paid in full"}
        </p>
      )}
    </div>
  );
}

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

  // Optional -- "What were you promised?" A promise with no number still
  // saves (drives the unexplained/inquiry outcome); leaving both blank
  // means no promise row at all.
  const [promiseStatement, setPromiseStatement] = useState("");
  const [promiseAmount, setPromiseAmount] = useState("");

  // Email drafting only ever happens after "done" (a confirmed_error or
  // unexplained verdict triggers it automatically -- see the effect below).
  // originalBody is kept alongside the editable body so "I've sent it" can
  // tell whether the user changed it (sent_manually_edited vs sent_as_is).
  const [emailDraft, setEmailDraft] = useState<
    { messageId: string; subject: string; body: string; originalBody: string } | null
  >(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailActionTaken, setEmailActionTaken] = useState<string | null>(null);
  // A ref, not state: it only guards the effect below against firing the
  // same fetch twice, it's never read for rendering (draftingEmail, what
  // the UI shows, is derived below instead of its own setState-in-effect).
  const draftRequestedRef = useRef(false);

  // parseAmountInput returns null for anything that isn't a plain
  // (optionally comma-formatted) non-negative number -- the live preview
  // falls back to 0 for an in-progress/invalid entry so it doesn't crash
  // mid-keystroke, but canConfirm below requires every amount to actually
  // parse before the user can save.
  const parsedLines: BillLine[] = useMemo(
    () =>
      lines.map((l) => ({
        label: l.label,
        amount: parseAmountInput(l.amount) ?? 0,
        role: l.role,
        unrecognized: l.unrecognized ?? false,
      })),
    [lines]
  );
  const parsedTotalValue = parseAmountInput(total);
  const parsedTotal = parsedTotalValue ?? 0;
  const livePreview = useMemo(() => computeBillChecks(parsedLines, parsedTotal), [parsedLines, parsedTotal]);

  const canConfirm =
    provider.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(billDate) &&
    parsedTotalValue !== null &&
    lines.length > 0 &&
    lines.every((l) => l.label.trim().length > 0 && parseAmountInput(l.amount) !== null);

  function handleFileSelected(selected: File | null) {
    if (selected && isHeicFile(selected)) {
      setFile(null);
      setStage({
        name: "error",
        message: "HEIC photos aren't supported yet. Please upload a JPEG, PNG, WEBP or PDF (a screenshot works too).",
      });
      return;
    }
    setFile(selected);
  }

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

    const promisedAmountValue = parseAmountInput(promiseAmount);
    const promise = promiseStatement.trim()
      ? { statement: promiseStatement.trim(), promisedAmount: promisedAmountValue }
      : null;

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
          promise,
        }),
      });
      const data: ConfirmResponse = await res.json();

      if (!data.success) {
        setStage({ name: "error", message: data.message });
        return;
      }
      setEmailDraft(null);
      setEmailError(null);
      setEmailActionTaken(null);
      draftRequestedRef.current = false;
      setStage({ name: "done", bill: data.bill, checks: data.checks, verdict: data.verdict });
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
    setPromiseStatement("");
    setPromiseAmount("");
    setEmailDraft(null);
    setEmailError(null);
    setEmailActionTaken(null);
    draftRequestedRef.current = false;
    setStage({ name: "upload" });
  }

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, { label: "", amount: "", role: "charge" }]);
  }

  function deleteLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleUnrecognized(index: number) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, unrecognized: !l.unrecognized } : l)));
  }

  function updateEmailSubject(subject: string) {
    setEmailDraft((prev) => (prev ? { ...prev, subject } : prev));
  }

  function updateEmailBody(body: string) {
    setEmailDraft((prev) => (prev ? { ...prev, body } : prev));
  }

  // Removes the one line a checkpoint suggestion pointed at. Matched by
  // label + amount rather than index, since the suggestion comes from
  // computeBillChecks's own re-derivation of the line list, not from an
  // index into `lines` directly. removeFirstMatch removes only the first
  // match -- two genuinely identical lines must not both vanish.
  function removeLineByLabelAmount(label: string, amount: number) {
    setLines((prev) =>
      removeFirstMatch(prev, (l) => l.label === label && Math.abs(Number(l.amount) - amount) <= EPSILON)
    );
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  // A clean verdict never drafts an email -- nothing to dispute. The ref
  // guard (not state) stops this firing twice for the same "done" stage;
  // startOver/handleConfirm reset it for the next bill.
  useEffect(() => {
    if (stage.name !== "done") return;
    if (stage.verdict.outcome === "clean") return;
    if (emailDraft || draftRequestedRef.current) return;
    draftRequestedRef.current = true;

    fetch("/api/bills/draft-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billId: stage.bill.id,
        outcome: stage.verdict.outcome,
        facts: stage.verdict.facts,
      }),
    })
      .then((res) => res.json())
      .then((data: DraftEmailResponse) => {
        if (!data.success) {
          setEmailError(data.message);
          return;
        }
        setEmailDraft({ messageId: data.messageId, subject: data.subject, body: data.body, originalBody: data.body });
      })
      .catch(() => setEmailError("Couldn't reach the server to draft the email."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const draftingEmail =
    stage.name === "done" && stage.verdict.outcome !== "clean" && emailDraft === null && emailError === null;

  async function handleCopyEmail() {
    if (!emailDraft) return;
    await navigator.clipboard.writeText(`Subject: ${emailDraft.subject}\n\n${emailDraft.body}`);
  }

  function mailtoHref() {
    if (!emailDraft) return "#";
    return `mailto:?subject=${encodeURIComponent(emailDraft.subject)}&body=${encodeURIComponent(emailDraft.body)}`;
  }

  async function handleMarkSent() {
    if (!emailDraft) return;
    const edited = emailDraft.body !== emailDraft.originalBody;
    try {
      const res = await fetch(`/api/messages/${emailDraft.messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action_taken: edited ? "sent_manually_edited" : "sent_as_is",
          final_body: edited ? emailDraft.body : undefined,
        }),
      });
      const data = await res.json();
      if (data.success) setEmailActionTaken(edited ? "sent_manually_edited" : "sent_as_is");
    } catch {
      // Best-effort -- the user has already sent the email either way;
      // failing to log that here isn't worth blocking them over.
    }
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
          <p>Supported files: JPEG, PNG, WEBP or PDF (a screenshot works too). HEIC photos aren&apos;t supported yet.</p>
          <form onSubmit={handleUpload} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
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
          {total.trim() !== "" && parsedTotalValue === null && (
            <p style={{ color: "#721c24", margin: "2px 0" }}>Enter a valid number, e.g. 1234.56 or 1,234.56.</p>
          )}

          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Label</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ccc" }}>Amount</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Role</th>
                <th style={{ borderBottom: "1px solid #ccc" }}>Don&apos;t recognise?</th>
                <th style={{ borderBottom: "1px solid #ccc" }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => {
                const amountInvalid = line.amount.trim() !== "" && parseAmountInput(line.amount) === null;
                return (
                  <tr key={i}>
                    <td>
                      <input
                        value={line.label}
                        onChange={(e) => updateLine(i, { label: e.target.value })}
                        style={{ width: "100%" }}
                      />
                    </td>
                    <td>
                      <input
                        value={line.amount}
                        onChange={(e) => updateLine(i, { amount: e.target.value })}
                        style={{ width: "100%", textAlign: "right" }}
                      />
                      {amountInvalid && (
                        <div style={{ color: "#721c24", fontSize: "0.85em" }}>Enter a valid number.</div>
                      )}
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
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={line.unrecognized ?? false}
                        onChange={() => toggleUnrecognized(i)}
                        aria-label={`I don't recognise ${line.label || "this line"}`}
                      />
                    </td>
                    <td>
                      <button type="button" onClick={() => deleteLine(i)} aria-label={`Delete ${line.label || "line"}`}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button type="button" onClick={addLine} style={{ marginTop: 8 }}>
            + Add line
          </button>

          <ChecksSummary checks={livePreview} total={parsedTotal} onRemoveLine={removeLineByLabelAmount} />

          <div style={{ marginTop: "1.5rem", padding: "0.75rem", border: "1px solid #ddd", borderRadius: 4 }}>
            <p style={{ marginTop: 0 }}>
              <strong>What were you promised?</strong> (optional)
            </p>
            <label>
              Plan or description
              <input
                value={promiseStatement}
                onChange={(e) => setPromiseStatement(e.target.value)}
                placeholder="e.g. I was told this fee would be removed"
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <label>
              Promised amount (optional)
              <input
                value={promiseAmount}
                onChange={(e) => setPromiseAmount(e.target.value)}
                placeholder="e.g. 299.00"
                style={{ display: "block", width: "100%" }}
              />
            </label>
          </div>

          <button onClick={handleConfirm} disabled={!canConfirm} style={{ marginTop: "1rem" }}>
            This matches my paper bill
          </button>
        </section>
      )}

      {stage.name === "confirming" && <p>Saving...</p>}

      {stage.name === "done" && (
        <section style={{ marginTop: "1.5rem" }}>
          {stage.verdict.outcome === "clean" && (
            <>
              <p style={{ color: "#155724", fontSize: "1.2em", fontWeight: "bold" }}>✓ Your bill checks out.</p>
              <p>Reconciled total: <strong>{stage.verdict.reconciledTotal.toFixed(2)}</strong></p>
            </>
          )}
          {stage.verdict.outcome === "confirmed_error" && (
            <p style={{ color: "#721c24", fontSize: "1.2em", fontWeight: "bold" }}>
              We found a billing issue (difference of {Math.abs(stage.verdict.facts.gap).toFixed(2)}).
            </p>
          )}
          {stage.verdict.outcome === "unexplained" && (
            <p style={{ color: "#856404", fontSize: "1.2em", fontWeight: "bold" }}>
              Something on this bill needs clarifying.
            </p>
          )}

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
          <ChecksSummary checks={stage.checks} total={stage.bill.total} />

          {stage.verdict.outcome !== "clean" && (
            <div style={{ marginTop: "1.5rem", padding: "0.75rem", border: "1px solid #ddd", borderRadius: 4 }}>
              <p style={{ marginTop: 0 }}>
                <strong>{stage.verdict.outcome === "confirmed_error" ? "Dispute email" : "Inquiry email"}</strong>
              </p>
              {draftingEmail && <p>Drafting...</p>}
              {emailError && <p style={{ color: "#721c24" }}>{emailError}</p>}
              {emailDraft && (
                <>
                  <label>
                    Subject
                    <input
                      value={emailDraft.subject}
                      onChange={(e) => updateEmailSubject(e.target.value)}
                      style={{ display: "block", width: "100%" }}
                    />
                  </label>
                  <label>
                    Body
                    <textarea
                      value={emailDraft.body}
                      onChange={(e) => updateEmailBody(e.target.value)}
                      rows={10}
                      style={{ display: "block", width: "100%" }}
                    />
                  </label>
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <button type="button" onClick={handleCopyEmail}>
                      Copy
                    </button>
                    <a href={mailtoHref()}>
                      <button type="button">Open in email app</button>
                    </a>
                    <button type="button" onClick={handleMarkSent} disabled={emailActionTaken !== null}>
                      {emailActionTaken ? "Marked as sent" : "I've sent it"}
                    </button>
                  </div>
                </>
              )}
            </div>
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
