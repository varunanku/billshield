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
  type Checkpoint,
} from "@/lib/bill-checks";
import type { Verdict } from "@/lib/verdict";

type ExtractedBill = {
  provider: string | null;
  bill_date: string | null;
  total: number | null;
  line_items: BillLine[];
};

type ExtractResponse =
  | { success: true; extraction: ExtractedBill; notice: string | null; path: string }
  | { success: false; reason: string; message: string; notice?: string; retryAfterSeconds?: number };

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

// "confirming" is deliberately not its own stage: the button itself shows
// a spinner (isConfirming, a plain boolean) while staying on "reviewing",
// rather than switching to a separate blank screen.
type Stage =
  | { name: "upload" }
  | { name: "uploading" }
  | { name: "extracting" }
  | { name: "reviewing"; notice: string | null }
  | { name: "done"; bill: ConfirmedBill; checks: BillChecks; verdict: Verdict }
  | { name: "error"; message: string; notice?: string; retryAfterSeconds?: number };

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

function money(n: number) {
  return n.toFixed(2);
}

// Only these two outcomes draft an email -- cannot_verify is an honest
// "something's off but we don't know what" with no pinpointed cause to
// write a confident OR an inquiry email about, so it gets neither.
function outcomeDraftsEmail(outcome: Verdict["outcome"]): boolean {
  return outcome === "confirmed_error" || outcome === "unexplained";
}

// Upload -> Review -> Verdict. A minimal 3-dot/line stepper, not shown on
// the error screen (which has its own message + action).
function ProgressSteps({ current }: { current: 1 | 2 | 3 }) {
  const steps = ["Upload", "Review", "Verdict"];
  return (
    <ol className="mb-6 flex items-center gap-2 text-sm">
      {steps.map((label, i) => {
        const step = (i + 1) as 1 | 2 | 3;
        const active = step === current;
        const done = step < current;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={[
                "flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-colors",
                done ? "bg-emerald text-paper" : active ? "bg-ink text-paper" : "bg-card border border-line text-ink-muted",
              ].join(" ")}
            >
              {done ? "✓" : step}
            </span>
            <span className={active ? "font-medium text-ink" : "text-ink-muted"}>{label}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-line" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

// A checkpoint (the running sum up to one subtotal line) rendered as a
// small inline stamp next to that subtotal's row, rather than a block of
// text below the table.
function CheckpointStamp({
  checkpoint,
  onRemoveSuggestion,
}: {
  checkpoint: Checkpoint;
  onRemoveSuggestion?: (label: string, amount: number) => void;
}) {
  const offBy = Math.abs(checkpoint.gap) > EPSILON;
  if (!offBy) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-soft px-2 py-0.5 text-xs font-medium text-emerald">
        ✓ matched
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-full bg-amber-soft px-2 py-0.5 text-xs font-medium text-amber">
      ! check -- gap {money(checkpoint.gap)}
      {checkpoint.suggestion && onRemoveSuggestion && (
        <button
          type="button"
          onClick={() => onRemoveSuggestion(checkpoint.suggestion!.label, checkpoint.suggestion!.amount)}
          className="rounded-full border border-amber/40 px-1.5 py-0 text-amber underline-offset-2 hover:underline"
        >
          remove &quot;{checkpoint.suggestion.label}&quot;
        </button>
      )}
    </span>
  );
}

// Reclassification/tax-included notes, the general arithmetic/statement
// checks, suspicious-gap warnings, and the payment check -- everything
// EXCEPT checkpoints, which render as inline stamps next to their subtotal
// row in the receipt table instead (see CheckpointStamp above).
function ChecksSummary({ checks, total }: { checks: BillChecks; total: number }) {
  const showGenericArithmetic = !checks.arithmeticCoveredByPayment && !checks.statement;

  return (
    <div className="mt-3 flex flex-col gap-2 text-sm">
      {checks.reclassifiedAsBalance.map((r, i) => (
        <p key={i} className="text-amber">
          Note: treated &quot;{r.label}&quot; as the printed total, not a charge, since it matched the bill&apos;s own
          total ({money(r.amount)}).
        </p>
      ))}

      {checks.taxIncludedNote && <p className="text-amber">Note: {checks.taxIncludedNote}</p>}

      {showGenericArithmetic && (
        <>
          <p className="text-ink-muted">
            Charge + tax − discount: <span className="tabular-nums text-ink">{money(checks.billedSum)}</span>
            {" vs printed total "}
            <span className="tabular-nums text-ink">{money(total)}</span>
          </p>
          {checks.arithmeticIssue ? (
            <p className="text-amber">
              These lines don&apos;t add up to the printed total, so a line may be missing or misread. Compare with
              your paper bill.
            </p>
          ) : (
            <p className="text-emerald">✓ These lines add up to the printed total.</p>
          )}
        </>
      )}

      {checks.statement &&
        (checks.statement.issue ? (
          <p className="text-amber">
            These don&apos;t add up to the printed total, so a line may be missing or misread. Compare with your
            paper bill.
          </p>
        ) : Math.abs(checks.statement.gap) > EPSILON ? (
          <p className="text-emerald">✓ Matches within rounding.</p>
        ) : (
          <p className="text-emerald">✓ These add up to the printed total.</p>
        ))}

      {checks.warnings.map((w, i) => (
        <p key={i} className="text-amber">
          Note: &quot;{w.lineLabel}&quot; ({money(w.amount)}) -- {w.message}
        </p>
      ))}

      {checks.payment && (
        <p>
          Payment check: billed {money(checks.payment.coveredAmount)} vs paid {money(checks.payment.amountPaid)} --{" "}
          {checks.payment.verdict === "overpaid"
            ? `overpaid by ${money(Math.abs(checks.payment.signedDifference))}`
            : checks.payment.verdict === "dispute"
            ? `underpaid by ${money(checks.payment.signedDifference)}`
            : "paid in full"}
        </p>
      )}
    </div>
  );
}

const inputClasses =
  "min-h-11 w-full rounded-md border border-line bg-card px-3 py-2 text-ink outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald focus-visible:border-emerald";
// Every button gets a visible pressed state (darker + a slight scale down)
// on :active, on top of the hover/focus treatment -- not just a hover
// effect, which touch devices never see anyway.
const buttonPrimary =
  "min-h-11 rounded-md bg-emerald px-4 py-2 font-medium text-paper transition-all duration-150 hover:opacity-90 active:scale-[0.97] active:brightness-90 disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
const buttonSecondary =
  "min-h-11 rounded-md border border-line px-4 py-2 font-medium transition-all duration-150 hover:bg-card active:scale-[0.97] active:bg-line disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald";
const card = "rounded-xl border border-line bg-card p-5 shadow-sm";

export default function UploadPage() {
  const router = useRouter();
  const supabase = createClient();
  const [file, setFile] = useState<File | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "upload" });
  const [isConfirming, setIsConfirming] = useState(false);

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

  // Counts down a rate-limited retry wait so "Try again" has something
  // honest to show instead of a static message. The target end time lives
  // in a ref (a plain mutation, not setState); `tick` is a dummy counter
  // bumped only inside the interval callback, purely to force a re-render
  // so the ref-derived countdown value below gets recomputed each second.
  const retryTargetRef = useRef<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (stage.name !== "error" || !stage.retryAfterSeconds) {
      retryTargetRef.current = null;
      return;
    }
    retryTargetRef.current = Date.now() + stage.retryAfterSeconds * 1000;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [stage]);
  const retryCountdown =
    retryTargetRef.current === null ? null : Math.max(0, Math.ceil((retryTargetRef.current - Date.now()) / 1000));

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

  // Shared by the first upload and a rate-limited "Try again" (which reuses
  // the already-uploaded path instead of uploading the file a second time).
  async function runExtraction(path: string) {
    setStage({ name: "extracting" });
    try {
      const res = await fetch("/api/bills/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data: ExtractResponse = await res.json();

      if (!data.success) {
        setStage({
          name: "error",
          message: data.message,
          notice: data.notice,
          retryAfterSeconds: data.retryAfterSeconds,
        });
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

  async function handleUpload(e?: React.FormEvent) {
    e?.preventDefault();
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
    await runExtraction(path);
  }

  async function retryExtraction() {
    if (!uploadedPath) {
      startOver();
      return;
    }
    await runExtraction(uploadedPath);
  }

  async function handleConfirm() {
    if (!uploadedPath || !canConfirm) return;
    setIsConfirming(true);

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
        setIsConfirming(false);
        setStage({ name: "error", message: data.message });
        return;
      }
      setEmailDraft(null);
      setEmailError(null);
      setEmailActionTaken(null);
      draftRequestedRef.current = false;
      setIsConfirming(false);
      setStage({ name: "done", bill: data.bill, checks: data.checks, verdict: data.verdict });
    } catch {
      setIsConfirming(false);
      setStage({ name: "error", message: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  // Review -> Upload keeps the file selected; Verdict -> Review keeps every
  // edit (lines/provider/date/total/promise are never cleared by confirm,
  // only by startOver). Re-confirming after going back creates a second
  // bill row rather than updating the first one -- confirm has always been
  // an insert, and turning it into an update is a bigger change than "add a
  // back button".
  function backToUpload() {
    setStage({ name: "upload" });
  }
  function backToReview() {
    setStage({ name: "reviewing", notice: null });
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
    setIsConfirming(false);
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
    // Written as a literal comparison (not outcomeDraftsEmail) so
    // TypeScript narrows stage.verdict to the two variants that carry
    // .facts, which the fetch body below reads.
    if (stage.verdict.outcome !== "confirmed_error" && stage.verdict.outcome !== "unexplained") return;
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
    stage.name === "done" && outcomeDraftsEmail(stage.verdict.outcome) && emailDraft === null && emailError === null;

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

  // Looks up the checkpoint (if any) whose subtotal line matches this
  // table row's label -- used to render the inline stamp next to it.
  function checkpointFor(checks: BillChecks, label: string): Checkpoint | undefined {
    return checks.checkpoints.find((c) => c.label === label);
  }

  const progressStep: 1 | 2 | 3 | null =
    stage.name === "upload" || stage.name === "uploading" || stage.name === "extracting"
      ? 1
      : stage.name === "reviewing"
      ? 2
      : stage.name === "done"
      ? 3
      : null;

  return (
    <main className="mx-auto w-full max-w-[720px] px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 32 32" fill="none" className="h-7 w-7" aria-hidden>
            <path d="M16 2.5 L28 7 V15.5 C28 23 22.5 27.5 16 29.5 C9.5 27.5 4 23 4 15.5 V7 Z" className="fill-emerald" />
            <path
              d="M11 16.2 L14.3 19.5 L21.2 11.8"
              stroke="var(--paper)"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <h1 className="font-serif text-2xl">BillShield</h1>
        </div>
        <button onClick={handleSignOut} className="text-sm text-ink-muted transition-colors hover:text-ink">
          Sign out
        </button>
      </div>

      {progressStep && <ProgressSteps current={progressStep} />}

      {stage.name === "upload" && (
        <>
          <p className="mb-3 rounded-md bg-amber-soft px-3 py-2 text-sm text-amber">
            Your bill image is read by an AI provider (Groq) to pull out the line items. Please mask your name,
            address, phone number and account number before uploading -- we also run an automatic backstop, but
            masking it yourself first is safer.
          </p>
          <form onSubmit={handleUpload} className="flex flex-col gap-3">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingOver(true);
              }}
              onDragLeave={() => setIsDraggingOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDraggingOver(false);
                handleFileSelected(e.dataTransfer.files?.[0] ?? null);
              }}
              className={[
                "flex min-h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors",
                isDraggingOver ? "border-emerald bg-emerald-soft" : "border-line bg-card",
              ].join(" ")}
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-8 w-8 text-ink-muted" aria-hidden>
                <path
                  d="M12 16V4m0 0 4 4m-4-4-4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <p className="font-medium">{file ? file.name : "Drop your bill here, or click to choose a file"}</p>
              <p className="text-sm text-ink-muted">JPEG, PNG, WEBP or PDF (a screenshot works too)</p>
              <p className="text-xs text-ink-muted">HEIC photos aren&apos;t supported yet.</p>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
                className="sr-only"
              />
            </label>
            <button type="submit" disabled={!file} className={buttonPrimary}>
              Upload
            </button>
          </form>
        </>
      )}

      {stage.name === "uploading" && <p className="py-6 text-center text-ink-muted">Uploading...</p>}
      {stage.name === "extracting" && (
        <div className="flex flex-col items-center gap-3 py-10">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-emerald" aria-hidden />
          <p className="text-ink-muted">Reading your bill...</p>
        </div>
      )}

      {stage.name === "reviewing" && (
        <section className="receipt-edge mt-2 flex flex-col gap-4 rounded-xl border border-line bg-card p-5 shadow-sm">
          <button type="button" onClick={backToUpload} className="self-start text-sm text-ink-muted transition-colors hover:text-ink">
            ← Back to upload
          </button>
          {stage.notice && <p className="rounded-md bg-amber-soft px-3 py-2 text-sm text-amber">{stage.notice}</p>}
          <p className="text-sm text-ink-muted">Check this against your paper bill and fix anything that&apos;s wrong.</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              Provider
              <input value={provider} onChange={(e) => setProvider(e.target.value)} className={inputClasses} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Bill date (YYYY-MM-DD)
              <input
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
                placeholder="YYYY-MM-DD"
                className={inputClasses}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Printed total
            <input value={total} onChange={(e) => setTotal(e.target.value)} className={inputClasses} />
          </label>
          {total.trim() !== "" && parsedTotalValue === null && (
            <p className="text-sm text-brick">Enter a valid number, e.g. 1234.56 or 1,234.56.</p>
          )}

          <div className="flex flex-col divide-y divide-line">
            {lines.map((line, i) => {
              const amountInvalid = line.amount.trim() !== "" && parseAmountInput(line.amount) === null;
              const checkpoint = line.role === "subtotal" ? checkpointFor(livePreview, line.label) : undefined;
              return (
                <div key={i} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                  <div className="flex flex-1 flex-col gap-1 sm:flex-row sm:items-center">
                    <input
                      value={line.label}
                      onChange={(e) => updateLine(i, { label: e.target.value })}
                      placeholder="Label"
                      className={`${inputClasses} sm:max-w-none`}
                    />
                    <select
                      value={line.role}
                      onChange={(e) => updateLine(i, { role: e.target.value as LineRole })}
                      className={`${inputClasses} sm:w-36`}
                    >
                      {LINE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={line.amount}
                      onChange={(e) => updateLine(i, { amount: e.target.value })}
                      className={`${inputClasses} tabular-nums text-right sm:w-32`}
                    />
                    {checkpoint && <CheckpointStamp checkpoint={checkpoint} onRemoveSuggestion={removeLineByLabelAmount} />}
                  </div>
                  {amountInvalid && <p className="text-xs text-brick sm:hidden">Enter a valid number.</p>}
                  <label className="flex min-h-11 items-center gap-1.5 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      checked={line.unrecognized ?? false}
                      onChange={() => toggleUnrecognized(i)}
                      className="h-4 w-4"
                    />
                    Don&apos;t recognise
                  </label>
                  <button
                    type="button"
                    onClick={() => deleteLine(i)}
                    aria-label={`Delete ${line.label || "line"}`}
                    className="min-h-11 rounded-md px-2 text-sm text-ink-muted transition-colors hover:text-brick"
                  >
                    Delete
                  </button>
                </div>
              );
            })}
          </div>
          <button type="button" onClick={addLine} className={`${buttonSecondary} self-start`}>
            + Add line
          </button>

          <ChecksSummary checks={livePreview} total={parsedTotal} />

          <div className="rounded-lg border border-line p-4">
            <p className="mb-2 font-medium">What were you promised? <span className="font-normal text-ink-muted">(optional)</span></p>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Plan or description
                <input
                  value={promiseStatement}
                  onChange={(e) => setPromiseStatement(e.target.value)}
                  placeholder="e.g. I was told this fee would be removed"
                  className={inputClasses}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Promised amount (optional)
                <input
                  value={promiseAmount}
                  onChange={(e) => setPromiseAmount(e.target.value)}
                  placeholder="e.g. 299.00"
                  className={`${inputClasses} tabular-nums`}
                />
              </label>
            </div>
          </div>

          <button
            onClick={handleConfirm}
            disabled={!canConfirm || isConfirming}
            className={`${buttonPrimary} flex items-center justify-center gap-2`}
          >
            {isConfirming && (
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-paper/40 border-t-paper"
                aria-hidden
              />
            )}
            {isConfirming ? "Saving..." : "This matches my paper bill"}
          </button>
        </section>
      )}

      {stage.name === "done" && (
        <section className="mt-2 flex flex-col gap-4">
          <button type="button" onClick={backToReview} className="self-start text-sm text-ink-muted transition-colors hover:text-ink">
            ← Back to review
          </button>

          {stage.verdict.outcome === "clean" && (
            <div className="rounded-xl bg-emerald-soft p-5">
              <p className="font-serif text-xl text-emerald">✓ Your bill checks out.</p>
              <p className="mt-1 text-ink-muted">
                Reconciled total: <span className="tabular-nums font-medium text-ink">{money(stage.verdict.reconciledTotal)}</span>
              </p>
            </div>
          )}
          {stage.verdict.outcome === "confirmed_error" && (
            <div className="rounded-xl bg-brick-soft p-5">
              <p className="font-serif text-xl text-brick">We found a billing issue.</p>
              <p className="mt-1 text-ink-muted">
                Difference: <span className="tabular-nums font-medium text-ink">{money(Math.abs(stage.verdict.facts.gap))}</span>
              </p>
            </div>
          )}
          {stage.verdict.outcome === "cannot_verify" && (
            <div className="rounded-xl bg-amber-soft p-5">
              <p className="font-serif text-xl text-amber">We couldn&apos;t verify this bill.</p>
              <p className="mt-1 text-ink-muted">
                Some lines may be missing or misread -- gap:{" "}
                <span className="tabular-nums font-medium text-ink">{money(Math.abs(stage.verdict.facts.gap))}</span>
              </p>
            </div>
          )}
          {stage.verdict.outcome === "unexplained" && (
            <div className="rounded-xl bg-amber-soft p-5">
              <p className="font-serif text-xl text-amber">Something on this bill needs clarifying.</p>
            </div>
          )}

          <div className="receipt-edge flex flex-col gap-3 rounded-xl border border-line bg-card p-5 shadow-sm">
            <p>
              <strong>{stage.bill.provider}</strong> <span className="text-ink-muted">-- {stage.bill.billDate}</span>
            </p>

            <div className="flex flex-col divide-y divide-line">
              {stage.bill.lineItems.map((li, i) => {
                const checkpoint = li.role === "subtotal" ? checkpointFor(stage.checks, li.label) : undefined;
                return (
                  <div key={i} className="flex items-baseline py-2">
                    <span>{li.label}</span>
                    <span className="leader" aria-hidden />
                    <span className="tabular-nums">{money(li.amount)}</span>
                    {checkpoint && (
                      <span className="ml-2">
                        <CheckpointStamp checkpoint={checkpoint} />
                      </span>
                    )}
                  </div>
                );
              })}
              <div className="flex items-baseline border-t border-ink/20 pt-2 font-medium">
                <span>Total</span>
                <span className="leader" aria-hidden />
                <span className="tabular-nums">{money(stage.bill.total)}</span>
              </div>
            </div>

            <ChecksSummary checks={stage.checks} total={stage.bill.total} />
          </div>

          {outcomeDraftsEmail(stage.verdict.outcome) && (
            <div className={card}>
              <p className="mb-2 font-medium">{stage.verdict.outcome === "confirmed_error" ? "Dispute email" : "Inquiry email"}</p>
              {draftingEmail && <p className="text-ink-muted">Drafting...</p>}
              {emailError && <p className="text-brick">{emailError}</p>}
              {emailDraft && (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    Subject
                    <input
                      value={emailDraft.subject}
                      onChange={(e) => updateEmailSubject(e.target.value)}
                      className={inputClasses}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    Body
                    <textarea
                      value={emailDraft.body}
                      onChange={(e) => updateEmailBody(e.target.value)}
                      rows={10}
                      className={`${inputClasses} min-h-40`}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={handleCopyEmail} className={buttonSecondary}>
                      Copy
                    </button>
                    <a href={mailtoHref()}>
                      <button type="button" className={buttonSecondary}>
                        Open in email app
                      </button>
                    </a>
                    <button type="button" onClick={handleMarkSent} disabled={emailActionTaken !== null} className={buttonPrimary}>
                      {emailActionTaken ? "Marked as sent" : "I've sent it"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <button onClick={startOver} className={`${buttonSecondary} self-start`}>
            Upload another bill
          </button>
        </section>
      )}

      {stage.name === "error" && (
        <section className={`${card} mt-2 flex flex-col gap-3`}>
          {stage.notice && <p className="rounded-md bg-amber-soft px-3 py-2 text-sm text-amber">{stage.notice}</p>}
          <p className="text-brick">{stage.message}</p>
          {retryCountdown !== null && retryCountdown > 0 ? (
            <p className="text-sm text-ink-muted">Try again in {retryCountdown}s...</p>
          ) : uploadedPath && stage.retryAfterSeconds !== undefined ? (
            <button onClick={retryExtraction} className={buttonPrimary}>
              Try again
            </button>
          ) : (
            <button onClick={startOver} className={buttonSecondary}>
              Start over
            </button>
          )}
        </section>
      )}
    </main>
  );
}
