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
  type BillCategory,
} from "@/lib/bill-checks";
import { shouldDraftEmail, type Verdict } from "@/lib/verdict";
import { MAX_FOLLOWUP_MESSAGES, type FollowupBillContext, type FollowupReply, type Correction } from "@/lib/followup";
import type { TonePreset } from "@/lib/email-draft";
import { isSuspiciousBillDate } from "@/lib/date-check";
import { computeTaxBreakdown, summarizeTaxBreakdown, computeEffectiveTaxRates, type CategoryRate } from "@/lib/gst";
import { ThemeSwitcher } from "@/app/theme-switcher";
import { buildThankYouMessage, UNKNOWN_PROVIDER } from "@/lib/thank-you";
import { buildSuggestionChips } from "@/lib/chat-chips";

type ExtractedBill = {
  provider: string | null;
  provider_legal_name: string | null;
  bill_date: string | null;
  total: number | null;
  category: BillCategory | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  units_consumed: number | null;
  units_consumed_unit: string | null;
  line_items: BillLine[];
};

type ExtractResponse =
  | { success: true; extraction: ExtractedBill; notice: string | null; path: string }
  | { success: false; reason: string; message: string; notice?: string; retryAfterSeconds?: number };

type ConfirmedBill = {
  id: string;
  provider: string;
  providerLegalName: string | null;
  billDate: string;
  total: number;
  lineItems: (BillLine & { amount: number })[];
};

type ConfirmResponse =
  | { success: true; bill: ConfirmedBill; checks: BillChecks; verdict: Verdict }
  | { success: false; reason: string; message: string };

type DraftEmailResponse =
  | { success: true; messageId: string; subject: string; body: string; isDefaultTone: boolean }
  | { success: false; reason: string; message: string };

type FollowupApiResponse =
  | { success: true; reply: FollowupReply; messagesUsed: number }
  | { success: false; reason: string; message: string };

type ApplyCorrectionResponse =
  | { success: true; bill: ConfirmedBill; checks: BillChecks; verdict: Verdict }
  | { success: false; reason: string; message: string };

type ChatEntry =
  | { kind: "text"; role: "user" | "assistant"; content: string }
  | { kind: "correction"; correction: Correction; status: "pending" | "applied" | "dismissed" };

const TONE_PRESET_OPTIONS: { value: TonePreset; label: string }[] = [
  { value: "polite", label: "Polite" },
  { value: "firm", label: "Firm" },
  { value: "formal", label: "Formal" },
  { value: "brief", label: "Brief" },
  { value: "friendly", label: "Friendly" },
  { value: "escalation", label: "Escalation" },
];

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

// Small colored pill per line role -- blue for a charge, amber for tax,
// green for a payment, gray for everything else (info/balance/subtotal/
// opening/discount), matched to the role's real-world "weight" rather
// than one color per role.
const ROLE_BADGE_CLASSES: Record<LineRole, string> = {
  charge: "bg-accent-soft text-accent",
  tax: "bg-warning-soft text-warning",
  payment: "bg-success-soft text-success",
  discount: "bg-success-soft text-success",
  balance: "bg-border text-text-muted",
  subtotal: "bg-border text-text-muted",
  info: "bg-border text-text-muted",
  opening: "bg-border text-text-muted",
};

function RoleBadge({ role }: { role: LineRole }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE_CLASSES[role]}`}>
      {ROLE_LABELS[role]}
    </span>
  );
}

function money(n: number) {
  return n.toFixed(2);
}

// Every outcome except "clean" drafts an email -- UNLESS the disputed
// amount itself is under Rs 1.00 (shouldDraftEmail), which is never worth
// anyone's time, provider included.
function verdictDraftsEmail(verdict: Verdict): boolean {
  if (verdict.outcome === "clean") return false;
  return shouldDraftEmail(verdict.facts);
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
                "flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold transition-colors",
                done
                  ? "bg-success-soft text-success"
                  : active
                  ? "bg-accent-soft text-accent animate-pulse"
                  : "bg-surface border border-border text-text-muted",
              ].join(" ")}
            >
              {done ? (
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
                  <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                step
              )}
            </span>
            <span className={active ? "font-bold text-text" : "text-text-muted"}>{label}</span>
            {i < steps.length - 1 && (
              <span className={`mx-1 h-0.5 w-6 rounded-full transition-colors ${done ? "bg-success" : "bg-border"}`} aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// A checkpoint (the running sum up to one subtotal line) rendered as a
// small inline stamp next to that subtotal's row, rather than a block of
// text below the table.
// Toggles a single field into edit mode on the (otherwise read-only)
// review screen -- see editingField in UploadPage.
function PencilButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-accent-soft hover:text-accent"
    >
      ✎
    </button>
  );
}

// A small, always-available (i) icon -- hover on desktop, tap on mobile
// (the same onClick toggles it either way), dismissed by tapping/clicking
// anywhere else. Never remembers being dismissed -- there's nothing to
// persist, it just closes. Anchored to the icon's left edge (not centered)
// and width-capped against the viewport so it can't overflow at mobile
// widths; every section this is used in keeps the icon well clear of the
// right edge, so left-anchoring never clips there either.
//
// animate-icon-pulse always applies -- its CSS animation-iteration-count
// is finite (3), so it plays out once per mount and then just stops on its
// own; no JS timer needed to "turn it off", and prefers-reduced-motion
// disables it entirely at the CSS level (see globals.css).
function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", handleOutside);
    return () => document.removeEventListener("click", handleOutside);
  }, [open]);

  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-label="More information"
        aria-expanded={open}
        className="animate-icon-pulse flex min-h-8 min-w-8 items-center justify-center gap-1 rounded-full bg-accent-soft px-1.5 text-accent transition-colors hover:bg-accent/15"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-xs font-bold" aria-hidden>
          i
        </span>
        <span className="hidden text-xs font-medium sm:inline">What&apos;s this?</span>
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-20 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-3 text-xs font-normal text-text shadow-card"
        >
          {text}
        </span>
      )}
    </span>
  );
}

// Verdict banner icons -- left-aligned per outcome. The checkmark draws in
// via the shared .animate-draw-in keyframe (stroke-dasharray/offset).
function ShieldCheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-draw-in ${className ?? ""}`} aria-hidden>
      <path d="M12 2.5 L20.5 6 V12 C20.5 17 17 20.5 12 22 C7 20.5 3.5 17 3.5 12 V6 Z" stroke="currentColor" strokeWidth="1.75" />
      <path d="M8.5 12.2 L10.8 14.5 L15.5 9.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function AlertTriangleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M12 3.5 L21.5 20.5 H2.5 Z" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      <path d="M12 9.5 V14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17.2" r="1" fill="currentColor" />
    </svg>
  );
}
function XCircleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-draw-in ${className ?? ""}`} aria-hidden>
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.75" />
      <path d="M8.5 8.5 L15.5 15.5 M15.5 8.5 L8.5 15.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

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
      <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
        ✓ matched
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
      ! check -- gap {money(checkpoint.gap)}
      {checkpoint.suggestion && onRemoveSuggestion && (
        <button
          type="button"
          onClick={() => onRemoveSuggestion(checkpoint.suggestion!.label, checkpoint.suggestion!.amount)}
          className="rounded-full border border-warning/40 px-1.5 py-0 text-warning underline-offset-2 hover:underline"
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
        <p key={i} className="text-warning">
          Note: treated &quot;{r.label}&quot; as the printed total, not a charge, since it matched the bill&apos;s own
          total ({money(r.amount)}).
        </p>
      ))}

      {checks.reclassifiedAsInfo.map((r, i) => (
        <p key={i} className="text-warning">
          Note: &quot;{r.label}&quot; ({money(r.amount)}) is a summary of the other tax lines, not an additional
          charge.
        </p>
      ))}

      {checks.taxIncludedNote && <p className="text-warning">Note: {checks.taxIncludedNote}</p>}

      {showGenericArithmetic && (
        <>
          <p className="text-text-muted">
            Charge + tax − discount: <span className="font-mono tabular-nums text-text">{money(checks.billedSum)}</span>
            {" vs printed total "}
            <span className="font-mono tabular-nums text-text">{money(total)}</span>
          </p>
          {checks.arithmeticIssue ? (
            <p className="text-warning">
              These lines don&apos;t add up to the printed total, so a line may be missing or misread. Compare with
              your paper bill.
            </p>
          ) : (
            <p className="text-success">✓ These lines add up to the printed total.</p>
          )}
        </>
      )}

      {checks.statement &&
        (checks.statement.issue ? (
          <p className="text-warning">
            These don&apos;t add up to the printed total, so a line may be missing or misread. Compare with your
            paper bill.
          </p>
        ) : Math.abs(checks.statement.gap) > EPSILON ? (
          <p className="text-success">✓ Matches within rounding.</p>
        ) : (
          <p className="text-success">✓ These add up to the printed total.</p>
        ))}

      {checks.warnings.map((w, i) => (
        <p key={i} className="text-warning">
          Note: &quot;{w.lineLabel}&quot; ({money(w.amount)}) -- {w.message}
        </p>
      ))}

      {checks.payment && (
        <p>
          Payment check: billed {money(checks.billedSum)} vs paid {money(checks.payment.amountPaid)} --{" "}
          {checks.payment.verdict === "overpaid"
            ? `overpaid by ${money(Math.abs(checks.payment.signedDifference))}`
            : "paid in full"}
          {checks.payment.reconcilingBalanceLabel &&
            ` (matches the "${checks.payment.reconcilingBalanceLabel}" line)`}
        </p>
      )}
    </div>
  );
}

const inputClasses =
  "min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-text outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent";
// Every button gets a visible pressed state (darker + a slight scale down)
// on :active, on top of the hover/focus treatment -- not just a hover
// effect, which touch devices never see anyway.
const buttonPrimary =
  "min-h-11 rounded-lg bg-accent px-4 py-2 font-medium text-accent-contrast transition-all duration-150 hover:bg-accent-hover active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
// Reserved for the one action that's specifically a confirmation of
// something already sent/done ("I've sent it") -- every other primary
// action uses the vivid-blue buttonPrimary above.
const buttonSuccess =
  "min-h-11 rounded-lg bg-success px-4 py-2 font-medium text-success-contrast transition-all duration-150 hover:opacity-90 active:scale-[0.97] active:brightness-90 disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const buttonSecondary =
  "min-h-11 rounded-lg border border-border px-4 py-2 font-medium text-text transition-all duration-150 hover:bg-accent-soft hover:border-accent active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const buttonDestructive =
  "min-h-11 rounded-lg px-2 text-sm text-text-muted transition-colors hover:text-danger";
const card = "rounded-lg border border-border bg-surface p-5 shadow-card animate-fade-up";

export default function UploadPage() {
  const router = useRouter();
  const supabase = createClient();
  const [file, setFile] = useState<File | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "upload" });
  const [isConfirming, setIsConfirming] = useState(false);

  // Display-only -- middleware.ts is what actually guards this page from
  // an unauthenticated visit; this just shows who's signed in. full_name
  // comes straight off auth metadata (set at sign-up, see app/login/page.tsx)
  // -- no extra query needed, getUser() already returns it client-side.
  // Falls back to email for an account that signed up before this existed.
  // userFullName is kept separate (raw, nullable, no email fallback) for the
  // thank-you toast, which wants a real first name or nothing at all --
  // never a greeting like "Thanks ... , jane@example.com".
  const [userDisplayName, setUserDisplayName] = useState<string | null>(null);
  const [userFullName, setUserFullName] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const fullName = data.user?.user_metadata?.full_name;
      const trimmedFullName = (typeof fullName === "string" && fullName.trim()) || null;
      setUserFullName(trimmedFullName);
      setUserDisplayName(trimmedFullName || data.user?.email || null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reference data (not user-owned, readable by any signed-in user via its
  // own RLS policy) -- fetched once so the review/verdict screens can show
  // the tax summary line without a round trip through an API route.
  const [categoryRates, setCategoryRates] = useState<CategoryRate[]>([]);
  useEffect(() => {
    supabase
      .from("category_rates")
      .select("*")
      .then(({ data }) => setCategoryRates(data ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drives the "Is this higher than my last {provider} bill?" suggestion
  // chip -- just an existence check (RLS already scopes this to the
  // signed-in user's own bills), never a comparison. The actual comparison,
  // if the user taps that chip or asks it themselves, is resolved by the
  // existing get_history chat path (lib/followup.ts), untouched here.
  const [hasProviderHistory, setHasProviderHistory] = useState(false);
  useEffect(() => {
    if (stage.name !== "done") return;
    const knownProvider = stage.bill.provider && stage.bill.provider !== UNKNOWN_PROVIDER ? stage.bill.provider : null;
    let cancelled = false;
    // Always resolved asynchronously (even the "nothing to look up" case),
    // never a direct setState call in the effect body itself.
    const query = knownProvider
      ? supabase.from("bills").select("id").eq("provider_name", knownProvider).neq("id", stage.bill.id).limit(1)
      : Promise.resolve({ data: [] as { id: string }[] });
    query.then(({ data }) => {
      if (!cancelled) setHasProviderHistory((data?.length ?? 0) > 0);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const [provider, setProvider] = useState("");
  const [providerLegalName, setProviderLegalName] = useState<string | null>(null);
  // Carried through from extraction to confirm as-is -- not user-editable
  // on the review screen (Phase 3 only asks that these be captured/stored
  // when printed, not reviewed field-by-field like provider/date/total).
  const [extraFields, setExtraFields] = useState<{
    category: BillCategory | null;
    billing_period_start: string | null;
    billing_period_end: string | null;
    units_consumed: number | null;
    units_consumed_unit: string | null;
  }>({ category: null, billing_period_start: null, billing_period_end: null, units_consumed: null, units_consumed_unit: null });
  const [billDate, setBillDate] = useState("");
  const [total, setTotal] = useState("");
  const [lines, setLines] = useState<EditableLine[]>([]);

  // Review screen fields are read-only until the pencil next to them is
  // clicked -- editingField holds which one ("provider" | "billDate" |
  // "total" | `line-${index}` | null for none). showAddLine gates "+ Add
  // line" behind the "Something missing?" link.
  const [editingField, setEditingField] = useState<string | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);

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
    { messageId: string; subject: string; body: string; originalBody: string; isDefaultTone: boolean } | null
  >(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailActionTaken, setEmailActionTaken] = useState<string | null>(null);
  // The "thanks for trusting BillShield" toast -- shown after Copy, Open in
  // email app or "I've sent it", auto-hides after ~6s (or sooner, on
  // dismiss). The timer lives in a ref so re-triggering it (clicking a
  // second button) restarts the full 6s rather than stacking timers.
  const [showThankYou, setShowThankYou] = useState(false);
  const thankYouTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function triggerThankYou() {
    setShowThankYou(true);
    if (thankYouTimerRef.current) clearTimeout(thankYouTimerRef.current);
    thankYouTimerRef.current = setTimeout(() => setShowThankYou(false), 6000);
  }
  useEffect(() => {
    return () => {
      if (thankYouTimerRef.current) clearTimeout(thankYouTimerRef.current);
    };
  }, []);
  // The dropdown's current selection -- "" means no preset chosen (the
  // default/original wording). Regenerate always reflects whatever's
  // selected here, including "" (re-roll the default tone again).
  const [tonePreset, setTonePreset] = useState<TonePreset | "">("");
  const [regenerating, setRegenerating] = useState(false);
  // A ref, not state: it only guards the effect below against firing the
  // same fetch twice, it's never read for rendering (draftingEmail, what
  // the UI shows, is derived below instead of its own setState-in-effect).
  const draftRequestedRef = useRef(false);

  // Follow-up chat, shown under the verdict. Local-only state: each turn is
  // also persisted server-side (messages, type=followup) by the route, but
  // the thread displayed here is just what's accumulated this session. A
  // correction entry renders as its own "Apply/Dismiss" card instead of a
  // plain chat bubble.
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatBusyRetrying, setChatBusyRetrying] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLimitReached, setChatLimitReached] = useState(false);
  const [applyingCorrection, setApplyingCorrection] = useState(false);

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
  const taxSummary = useMemo(
    () => summarizeTaxBreakdown(computeTaxBreakdown(parsedLines, extraFields.category, categoryRates)),
    [parsedLines, extraFields.category, categoryRates]
  );

  // Provider, bill date and printed total are all optional -- missing any
  // (or all three) of them never blocks confirm. The only things that do:
  // no lines at all, or an amount (a line's, or the total's) that's been
  // typed into but isn't a valid number -- blank is fine, garbled isn't.
  const canConfirm =
    (total.trim() === "" || parsedTotalValue !== null) &&
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
      setProviderLegalName(data.extraction.provider_legal_name ?? null);
      setExtraFields({
        category: data.extraction.category ?? null,
        billing_period_start: data.extraction.billing_period_start ?? null,
        billing_period_end: data.extraction.billing_period_end ?? null,
        units_consumed: data.extraction.units_consumed ?? null,
        units_consumed_unit: data.extraction.units_consumed_unit ?? null,
      });
      setBillDate(data.extraction.bill_date ?? "");
      setTotal(data.extraction.total !== null ? String(data.extraction.total) : "");
      setLines(
        data.extraction.line_items.map((li) => ({ label: li.label, amount: String(li.amount), role: li.role }))
      );
      setEditingField(null);
      setShowAddLine(false);
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
          provider_legal_name: providerLegalName,
          ...extraFields,
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
      setTonePreset("");
      setShowThankYou(false);
      draftRequestedRef.current = false;
      setChatMessages([]);
      setChatInput("");
      setChatError(null);
      setChatLimitReached(false);
      setChatBusyRetrying(false);
      setApplyingCorrection(false);
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
    setProviderLegalName(null);
    setExtraFields({
      category: null,
      billing_period_start: null,
      billing_period_end: null,
      units_consumed: null,
      units_consumed_unit: null,
    });
    setBillDate("");
    setTotal("");
    setLines([]);
    setEditingField(null);
    setShowAddLine(false);
    setPromiseStatement("");
    setPromiseAmount("");
    setEmailDraft(null);
    setEmailError(null);
    setEmailActionTaken(null);
    setTonePreset("");
    setIsConfirming(false);
    setShowThankYou(false);
    draftRequestedRef.current = false;
    setChatMessages([]);
    setChatInput("");
    setChatError(null);
    setChatLimitReached(false);
    setChatBusyRetrying(false);
    setApplyingCorrection(false);
    setStage({ name: "upload" });
  }

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, { label: "", amount: "", role: "charge" }]);
    setEditingField(`line-${lines.length}`);
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
    // TypeScript narrows stage.verdict to the three variants that carry
    // .facts, which the fetch body below reads.
    if (
      stage.verdict.outcome !== "confirmed_error" &&
      stage.verdict.outcome !== "cannot_verify" &&
      stage.verdict.outcome !== "unexplained"
    )
      return;
    if (!shouldDraftEmail(stage.verdict.facts)) return;
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
        setEmailDraft({
          messageId: data.messageId,
          subject: data.subject,
          body: data.body,
          originalBody: data.body,
          isDefaultTone: data.isDefaultTone,
        });
      })
      .catch(() => setEmailError("Couldn't reach the server to draft the email."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const draftingEmail =
    stage.name === "done" && verdictDraftsEmail(stage.verdict) && emailDraft === null && emailError === null;

  // Suggestion chips above the follow-up chat input -- chosen by code from
  // this bill's own facts (never the LLM), only when the chat can actually
  // answer them. Recomputed on every render from cheap, already-available
  // values; not worth a useMemo.
  const suggestionChips =
    stage.name === "done"
      ? buildSuggestionChips({
          effectiveTaxRatePercent: (() => {
            const rates = computeEffectiveTaxRates(stage.bill.lineItems);
            return rates.length > 0 ? rates.reduce((s, r) => s + r.ratePercent, 0) : null;
          })(),
          flaggedLineLabel: "facts" in stage.verdict ? stage.verdict.facts.disputedLines[0]?.label ?? null : null,
          hasProviderHistory,
          provider: stage.bill.provider,
        })
      : [];

  async function handleCopyEmail() {
    if (!emailDraft) return;
    await navigator.clipboard.writeText(`Subject: ${emailDraft.subject}\n\n${emailDraft.body}`);
    triggerThankYou();
  }

  function mailtoHref() {
    if (!emailDraft) return "#";
    return `mailto:?subject=${encodeURIComponent(emailDraft.subject)}&body=${encodeURIComponent(emailDraft.body)}`;
  }

  async function handleMarkSent() {
    if (!emailDraft) return;
    const edited = emailDraft.body !== emailDraft.originalBody;
    const actionTaken = edited ? "sent_manually_edited" : emailDraft.isDefaultTone ? "sent_as_is" : "sent_with_tone_preset";
    triggerThankYou();
    try {
      const res = await fetch(`/api/messages/${emailDraft.messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // final_body is always sent (not just when edited) so the server
        // can derive edited_before_send itself, from the actual text, rather
        // than trusting a client-computed boolean.
        body: JSON.stringify({ action_taken: actionTaken, final_body: emailDraft.body }),
      });
      const data = await res.json();
      if (data.success) setEmailActionTaken(actionTaken);
    } catch {
      // Best-effort -- the user has already sent the email either way;
      // failing to log that here isn't worth blocking them over.
    }
  }

  async function handleRegenerate() {
    if (stage.name !== "done") return;
    if (
      stage.verdict.outcome !== "confirmed_error" &&
      stage.verdict.outcome !== "cannot_verify" &&
      stage.verdict.outcome !== "unexplained"
    )
      return;
    if (regenerating) return;
    setRegenerating(true);
    setEmailError(null);
    try {
      const res = await fetch("/api/bills/draft-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billId: stage.bill.id,
          outcome: stage.verdict.outcome,
          facts: stage.verdict.facts,
          tonePreset: tonePreset || null,
        }),
      });
      const data: DraftEmailResponse = await res.json();
      if (!data.success) {
        setEmailError(data.message);
        return;
      }
      setEmailDraft({
        messageId: data.messageId,
        subject: data.subject,
        body: data.body,
        originalBody: data.body,
        isDefaultTone: data.isDefaultTone,
      });
      setEmailActionTaken(null); // a new row -- not sent yet
    } catch {
      setEmailError("Couldn't reach the server to regenerate the email.");
    } finally {
      setRegenerating(false);
    }
  }

  // Built fresh from whatever's currently in `stage` -- bill/checks/verdict
  // were already fully computed server-side at confirm time, and have just
  // lived in this state since (same pattern as draft-email's `facts`).
  // "Change X from A to B" -- the current value comes from the bill
  // already in state; the correction only ever carries the proposed new
  // one(s). Never shows a number the correction didn't actually propose.
  function describeCorrection(correction: Correction, bill: ConfirmedBill): string {
    if (correction.field === "provider") {
      return `Change provider from "${bill.provider}" to "${correction.new_label}"`;
    }
    if (correction.field === "bill_date") {
      return `Change bill date from "${bill.billDate}" to "${correction.new_label}"`;
    }
    if (correction.field === "printed_total") {
      return `Change printed total from Rs ${money(bill.total)} to Rs ${money(correction.new_amount ?? bill.total)}`;
    }
    const current = correction.line_index !== null ? bill.lineItems[correction.line_index] : undefined;
    if (!current) return "Change a line on this bill";
    const parts: string[] = [];
    if (correction.new_label !== null && correction.new_label !== current.label) {
      parts.push(`label from "${current.label}" to "${correction.new_label}"`);
    }
    if (correction.new_amount !== null && Math.abs(correction.new_amount - current.amount) > 0.001) {
      parts.push(`amount from Rs ${money(current.amount)} to Rs ${money(correction.new_amount)}`);
    }
    if (correction.new_role !== null && correction.new_role !== current.role) {
      parts.push(`category from ${ROLE_LABELS[current.role]} to ${ROLE_LABELS[correction.new_role]}`);
    }
    return parts.length > 0 ? `Change "${current.label}" ${parts.join(", ")}` : `Change "${current.label}"`;
  }

  function buildFollowupContext(bill: ConfirmedBill, checks: BillChecks, verdict: Verdict): FollowupBillContext {
    const facts = "facts" in verdict ? verdict.facts : null;
    return {
      provider: bill.provider,
      billDate: bill.billDate,
      total: bill.total,
      lineItems: bill.lineItems.map((li) => ({ label: li.label, amount: li.amount, role: li.role })),
      verdictOutcome: verdict.outcome,
      verdictGap: facts ? facts.gap : null,
      disputedLines: facts ? facts.disputedLines : [],
      warnings: checks.warnings.map((w) => w.message),
    };
  }

  // questionOverride lets a tapped suggestion chip send its own question
  // without first round-tripping through chatInput's state -- same path,
  // same limit, same everything else, from here.
  async function handleAskQuestion(questionOverride?: string) {
    if (stage.name !== "done") return;
    const question = (questionOverride ?? chatInput).trim();
    if (!question || chatSending || chatLimitReached) return;

    setChatInput("");
    setChatError(null);
    setChatSending(true);
    setChatMessages((prev) => [...prev, { kind: "text", role: "user", content: question }]);

    // Purely cosmetic reassurance, not a real-time status feed: the actual
    // OpenRouter-429-retry-then-Groq-fallback happens server-side inside one
    // request/response, so this is the closest a plain fetch can get to
    // "never a dead end" while that's in flight.
    const busyTimer = setTimeout(() => setChatBusyRetrying(true), 4000);

    try {
      const res = await fetch(`/api/bills/${stage.bill.id}/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, context: buildFollowupContext(stage.bill, stage.checks, stage.verdict) }),
      });
      const data: FollowupApiResponse = await res.json();

      if (!data.success) {
        setChatError(data.message);
        if (data.reason === "rate_limited" && res.status === 429) setChatLimitReached(true);
        return;
      }
      // get_history is always resolved server-side before this response is
      // sent -- the client only ever sees "answer" or "correction" here,
      // but the type is still the full union, so this is handled for
      // completeness rather than left to fall through silently.
      const entry: ChatEntry =
        data.reply.type === "answer"
          ? { kind: "text", role: "assistant", content: data.reply.text }
          : data.reply.type === "correction"
          ? { kind: "correction", correction: data.reply.correction, status: "pending" }
          : { kind: "text", role: "assistant", content: "Something unexpected happened. Please try again." };
      setChatMessages((prev) => [...prev, entry]);
      if (data.messagesUsed >= MAX_FOLLOWUP_MESSAGES) setChatLimitReached(true);
    } catch {
      setChatError("Couldn't reach the server. Please try again.");
    } finally {
      clearTimeout(busyTimer);
      setChatBusyRetrying(false);
      setChatSending(false);
    }
  }

  async function handleCorrectionDecision(index: number, decision: "applied" | "dismissed") {
    const entry = chatMessages[index];
    if (entry.kind !== "correction" || entry.status !== "pending") return;

    if (decision === "dismissed") {
      setChatMessages((prev) => prev.map((m, i) => (i === index ? { ...m, status: "dismissed" } : m)));
      return;
    }
    if (stage.name !== "done" || applyingCorrection) return;
    setApplyingCorrection(true);
    setChatError(null);
    try {
      const res = await fetch(`/api/bills/${stage.bill.id}/apply-correction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correction: entry.correction }),
      });
      const data: ApplyCorrectionResponse = await res.json();
      if (!data.success) {
        setChatError(data.message);
        return;
      }
      setChatMessages((prev) => prev.map((m, i) => (i === index ? { ...m, status: "applied" } : m)));
      // A new verdict/facts means the drafted email (if any) is now stale --
      // clearing it lets the existing auto-draft effect redraft against the
      // corrected numbers, the same way it does for a brand-new "done" stage.
      setEmailDraft(null);
      setEmailError(null);
      setEmailActionTaken(null);
      setTonePreset("");
      draftRequestedRef.current = false;
      setStage({ name: "done", bill: data.bill, checks: data.checks, verdict: data.verdict });
    } catch {
      setChatError("Couldn't reach the server. Please try again.");
    } finally {
      setApplyingCorrection(false);
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
    <main className="mx-auto w-full max-w-[960px] px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 32 32" fill="none" className="h-7 w-7" aria-hidden>
            <path d="M16 2.5 L28 7 V15.5 C28 23 22.5 27.5 16 29.5 C9.5 27.5 4 23 4 15.5 V7 Z" className="fill-accent" />
            <path
              d="M11 16.2 L14.3 19.5 L21.2 11.8"
              stroke="var(--accent-contrast)"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <h1 className="font-serif text-2xl">BillShield</h1>
        </div>
        <div className="flex items-center gap-3">
          <a href="/bills" className="text-sm text-text-muted transition-colors hover:text-text">
            My bills
          </a>
          {userDisplayName && <span className="text-sm text-text-muted">{userDisplayName}</span>}
          <button onClick={handleSignOut} className="text-sm text-text-muted transition-colors hover:text-text">
            Sign out
          </button>
          <ThemeSwitcher />
        </div>
      </div>

      {progressStep && <ProgressSteps current={progressStep} />}

      {stage.name === "upload" && (
        <>
          <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
            Your bill is read by an AI model to pull out the line items. Please mask your name, address, phone
            number and any other sensitive details before uploading -- we also run an automatic backup mask, but
            covering it yourself first is safer.
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
                "flex min-h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent px-4 py-10 text-center transition-colors",
                isDraggingOver ? "bg-accent-soft" : "bg-surface hover:bg-accent-soft",
              ].join(" ")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className={`h-8 w-8 text-accent ${isDraggingOver ? "animate-pulse" : ""}`}
                aria-hidden
              >
                <path
                  d="M12 16V4m0 0 4 4m-4-4-4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <p className="font-medium">{file ? file.name : "Drop your bill here, or click to choose a file"}</p>
              <p className="text-sm text-text-muted">JPEG, PNG, WEBP or PDF (a screenshot works too)</p>
              <p className="text-xs text-text-muted">HEIC photos aren&apos;t supported yet.</p>
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

      {stage.name === "uploading" && <p className="py-6 text-center text-text-muted">Uploading...</p>}
      {stage.name === "extracting" && (
        <div className="flex flex-col items-center gap-3 py-10">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />
          <p className="text-text-muted">Reading your bill...</p>
        </div>
      )}

      {stage.name === "reviewing" && (
        <section className="mx-auto mt-2 flex w-full max-w-[800px] flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-card animate-fade-up">
          <button type="button" onClick={backToUpload} className="self-start text-sm text-text-muted transition-colors hover:text-text">
            ← Back to upload
          </button>
          {stage.notice && <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">{stage.notice}</p>}
          <p className="text-sm text-text-muted">Check this against your paper bill and fix anything that&apos;s wrong.</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">Provider</span>
              {editingField === "provider" ? (
                <input
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  onBlur={() => setEditingField(null)}
                  autoFocus
                  className={inputClasses}
                />
              ) : (
                <div className="flex items-center gap-2">
                  {provider ? (
                    <span className="font-medium">{provider}</span>
                  ) : (
                    <span className="text-text-muted">Add provider (optional)</span>
                  )}
                  <PencilButton label="Edit provider" onClick={() => setEditingField("provider")} />
                </div>
              )}
              {providerLegalName && <span className="text-xs text-text-muted">Billing entity: {providerLegalName}</span>}
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-text-muted">Bill date</span>
              {editingField === "billDate" ? (
                <input
                  value={billDate}
                  onChange={(e) => setBillDate(e.target.value)}
                  onBlur={() => setEditingField(null)}
                  placeholder="YYYY-MM-DD"
                  autoFocus
                  className={inputClasses}
                />
              ) : (
                <div className="flex items-center gap-2">
                  {billDate ? (
                    <span className="font-medium">{billDate}</span>
                  ) : (
                    <span className="text-text-muted">Add date (optional)</span>
                  )}
                  <PencilButton label="Edit bill date" onClick={() => setEditingField("billDate")} />
                </div>
              )}
              {isSuspiciousBillDate(billDate) && (
                <span className="text-xs text-warning">⚠ Check this date -- it looks off.</span>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-text-muted">Printed total</span>
            {editingField === "total" ? (
              <input
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                onBlur={() => setEditingField(null)}
                autoFocus
                className={inputClasses}
              />
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-medium font-mono tabular-nums">{total || "(not set)"}</span>
                <PencilButton label="Edit printed total" onClick={() => setEditingField("total")} />
              </div>
            )}
          </div>
          {total.trim() !== "" && parsedTotalValue === null && (
            <p className="text-sm text-danger">Enter a valid number, e.g. 1234.56 or 1,234.56.</p>
          )}

          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-text-muted">Line items</span>
            <InfoTooltip text="The AI only reads the text off your bill. Every sum, checkpoint and the final verdict are calculated by code, never by the AI." />
          </div>
          <div className="flex flex-col divide-y divide-border">
            {lines.map((line, i) => {
              const amountInvalid = line.amount.trim() !== "" && parseAmountInput(line.amount) === null;
              const checkpoint = line.role === "subtotal" ? checkpointFor(livePreview, line.label) : undefined;
              const isEditingLine = editingField === `line-${i}`;

              if (!isEditingLine) {
                return (
                  <div key={i} className={`flex items-center justify-between gap-2 px-2 py-3 ${i % 2 === 1 ? "bg-surface-alt" : ""}`}>
                    <div className="flex flex-1 flex-wrap items-center gap-x-2">
                      <span>{line.label || "(no label)"}</span>
                      <RoleBadge role={line.role} />
                      {line.unrecognized && (
                        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">unfamiliar</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-base tabular-nums">{line.amount}</span>
                      {checkpoint && <CheckpointStamp checkpoint={checkpoint} onRemoveSuggestion={removeLineByLabelAmount} />}
                      <PencilButton label={`Edit ${line.label || "line"}`} onClick={() => setEditingField(`line-${i}`)} />
                    </div>
                  </div>
                );
              }

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
                      className={`${inputClasses} font-mono tabular-nums text-right sm:w-32`}
                    />
                    {checkpoint && <CheckpointStamp checkpoint={checkpoint} onRemoveSuggestion={removeLineByLabelAmount} />}
                  </div>
                  {amountInvalid && <p className="text-xs text-danger sm:hidden">Enter a valid number.</p>}
                  <label className="flex min-h-11 items-center gap-1.5 text-xs text-text-muted">
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
                    className={buttonDestructive}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setEditingField(null)} className={buttonSecondary}>
                    Done
                  </button>
                </div>
              );
            })}
          </div>
          {showAddLine ? (
            <button type="button" onClick={addLine} className={`${buttonSecondary} self-start`}>
              + Add line
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddLine(true)}
              className="self-start text-sm text-text-muted underline-offset-2 transition-colors hover:text-text hover:underline"
            >
              Something missing?
            </button>
          )}

          {taxSummary && <p className="text-sm text-text-muted">{taxSummary}</p>}

          <ChecksSummary checks={livePreview} total={parsedTotal} />

          <div className="rounded-lg border border-border p-4">
            <p className="mb-2 flex items-center gap-1.5 font-bold">
              What were you promised? <span className="font-normal text-text-muted">(optional)</span>
              <InfoTooltip text="Were you promised a discount, a specific price, or a plan before this bill arrived? Tell us and we'll compare it against what's actually billed." />
            </p>
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
                  className={`${inputClasses} font-mono tabular-nums`}
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
                className="h-4 w-4 animate-spin rounded-full border-2 border-accent-contrast/40 border-t-accent-contrast"
                aria-hidden
              />
            )}
            {isConfirming ? "Saving..." : "This matches my paper bill"}
          </button>
        </section>
      )}

      {stage.name === "done" && (
        <section className="mt-2 flex flex-col gap-6">
          <button type="button" onClick={backToReview} className="self-start text-sm text-text-muted transition-colors hover:text-text">
            ← Back to review
          </button>

          {stage.verdict.outcome === "clean" && (
            <div className="flex items-start gap-3 rounded-lg border-l-4 border-success bg-success-soft p-5 text-success animate-fade-up">
              <ShieldCheckIcon className="mt-1 h-7 w-7 shrink-0" />
              <div>
                <p className="text-[28px] font-bold leading-tight">Your bill checks out.</p>
                <p className="mt-1 text-text">
                  Reconciled total: <span className="font-mono tabular-nums font-medium">{money(stage.verdict.reconciledTotal)}</span>
                </p>
                {stage.verdict.roundingNote && (
                  <p className="mt-1 text-sm text-text-muted">
                    Rs {money(stage.verdict.roundingNote.gap)} is the bill&apos;s rounding to Rs{" "}
                    {money(stage.verdict.roundingNote.roundedTotal)}.
                  </p>
                )}
              </div>
            </div>
          )}
          {stage.verdict.outcome === "confirmed_error" && (
            <div className="flex items-start gap-3 rounded-lg border-l-4 border-danger bg-danger-soft p-5 text-danger animate-fade-up">
              <XCircleIcon className="mt-1 h-7 w-7 shrink-0" />
              <div>
                <p className="text-[28px] font-bold leading-tight">
                  {stage.verdict.reason === "overpaid"
                    ? `You overpaid Rs ${money(Math.abs(stage.verdict.facts.gap))}.`
                    : stage.verdict.reason === "promise_mismatch"
                    ? stage.verdict.facts.gap >= 0
                      ? `You were charged Rs ${money(Math.abs(stage.verdict.facts.gap))} more than you were promised.`
                      : `You were promised Rs ${money(Math.abs(stage.verdict.facts.gap))} more than you were charged.`
                    : `Rs ${money(Math.abs(stage.verdict.facts.gap))} on this bill doesn't add up.`}
                </p>
                {stage.verdict.facts.reconcilingBalanceLabel && (
                  <p className="mt-1 text-sm text-text-muted">
                    This matches the &quot;{stage.verdict.facts.reconcilingBalanceLabel}&quot; line on your bill.
                  </p>
                )}
              </div>
            </div>
          )}
          {stage.verdict.outcome === "cannot_verify" && (
            <div className="flex items-start gap-3 rounded-lg border-l-4 border-warning bg-warning-soft p-5 text-warning animate-fade-up">
              <AlertTriangleIcon className="mt-1 h-7 w-7 shrink-0" />
              <div>
                <p className="text-[28px] font-bold leading-tight">We couldn&apos;t read every line of this bill.</p>
                <p className="mt-1 text-text">
                  Gap: <span className="font-mono tabular-nums font-medium">{money(Math.abs(stage.verdict.facts.gap))}</span> --
                  compare the line items above with your paper bill for anything missing or misread.
                </p>
              </div>
            </div>
          )}
          {stage.verdict.outcome === "unexplained" && (
            <div className="flex items-start gap-3 rounded-lg border-l-4 border-warning bg-warning-soft p-5 text-warning animate-fade-up">
              <AlertTriangleIcon className="mt-1 h-7 w-7 shrink-0" />
              <p className="text-[28px] font-bold leading-tight">
                {stage.verdict.facts.disputedLines.length > 0
                  ? `You flagged "${stage.verdict.facts.disputedLines[0].label}" (Rs ${money(
                      stage.verdict.facts.disputedLines[0].amount
                    )}) as unfamiliar.`
                  : "You mentioned something about this bill that needs clarifying."}
              </p>
            </div>
          )}

          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-3 rounded-lg border border-border bg-surface p-5 shadow-card animate-fade-up">
            <p>
              <strong className="font-bold">{stage.bill.provider}</strong> <span className="text-text-muted">-- {stage.bill.billDate}</span>
              {isSuspiciousBillDate(stage.bill.billDate) && (
                <span className="ml-2 text-xs text-warning">⚠ Check this date -- it looks off.</span>
              )}
            </p>

            <div className="flex flex-col divide-y divide-border">
              {stage.bill.lineItems.map((li, i) => {
                const checkpoint = li.role === "subtotal" ? checkpointFor(stage.checks, li.label) : undefined;
                return (
                  <div key={i} className={`flex items-center justify-between gap-2 px-2 py-2 ${i % 2 === 1 ? "bg-surface-alt" : ""}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{li.label}</span>
                      <RoleBadge role={li.role} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-base tabular-nums">{money(li.amount)}</span>
                      {checkpoint && <CheckpointStamp checkpoint={checkpoint} />}
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center justify-between px-2 pt-2 font-bold">
                <span>Total</span>
                <span className="font-mono text-base tabular-nums">{money(stage.bill.total)}</span>
              </div>
            </div>

            {(() => {
              const summary = summarizeTaxBreakdown(computeTaxBreakdown(stage.bill.lineItems, extraFields.category, categoryRates));
              return summary && <p className="text-sm text-text-muted">{summary}</p>;
            })()}

            <ChecksSummary checks={stage.checks} total={stage.bill.total} />
          </div>

          {verdictDraftsEmail(stage.verdict) && (
            <div className={card}>
              <p className="mb-2 font-bold">{stage.verdict.outcome === "confirmed_error" ? "Dispute email" : "Inquiry email"}</p>
              {draftingEmail && <p className="text-text-muted">Drafting...</p>}
              {emailError && <p className="text-danger">{emailError}</p>}
              {emailDraft && (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    Subject
                    <input
                      value={emailDraft.subject}
                      onChange={(e) => updateEmailSubject(e.target.value)}
                      className={`${inputClasses} font-bold`}
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
                  <div className="flex flex-col gap-1">
                    <p className="font-bold">Ready to send?</p>
                    <p className="text-sm text-text-muted">Check it matches your paper bill, then send it to your provider.</p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <a href={mailtoHref()} onClick={triggerThankYou} className={`${buttonPrimary} w-full text-center sm:w-auto`}>
                      Open in email app
                    </a>
                    <button type="button" onClick={handleCopyEmail} className={`${buttonSecondary} w-full sm:w-auto`}>
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={handleMarkSent}
                      disabled={emailActionTaken !== null}
                      className={`${buttonSuccess} w-full sm:w-auto`}
                    >
                      {emailActionTaken ? "Marked as sent" : "I've sent it"}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    <label className="flex items-center gap-2 text-sm">
                      Tone
                      <select
                        value={tonePreset}
                        onChange={(e) => setTonePreset(e.target.value as TonePreset | "")}
                        className={inputClasses}
                      >
                        <option value="">Default</option>
                        {TONE_PRESET_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <InfoTooltip text="Polite -- extra courteous. Firm -- direct, makes clear this needs resolving promptly. Formal -- business-letter register, no casual phrasing. Brief -- as short as possible, a few sentences. Friendly -- warm and conversational. Escalation -- firmer, and notes you'll escalate if it isn't resolved." />
                    <button
                      type="button"
                      onClick={handleRegenerate}
                      disabled={regenerating}
                      className={`${buttonSecondary} border-accent text-accent`}
                    >
                      {regenerating ? "Regenerating..." : "Regenerate"}
                    </button>
                  </div>
                  <p className="text-xs text-text-muted">
                    Want a different feel? Pick a tone and press Regenerate. The AI rewrites the same message in
                    that style. The facts and amounts stay exactly the same -- they come from the bill checks, not
                    the AI.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Only once there's an actual draft to explain -- not while
              "Drafting..." or on an error, and never for a clean verdict
              (verdictDraftsEmail is already false there, same gate as the
              email card above). Trimmed to not repeat the Tone/Regenerate
              helper line just above. */}
          {verdictDraftsEmail(stage.verdict) && emailDraft && (
            <p className="text-sm text-text-muted">
              This message reflects our understanding of the issue found on your bill -- check it matches what you
              see on your paper bill. You can send it as-is, write your own, or use Copy / Open in email app to
              send it directly.
            </p>
          )}

          <div className={card}>
            <p className="mb-1 flex items-center gap-1.5 font-bold">
              {userFullName ? `${userFullName.trim().split(/\s+/)[0]}, got questions about this bill?` : "Questions about this bill?"}
              <InfoTooltip text="Can: explain any line, the tax rate, how the total was computed, compare with your earlier bills from the same provider, and fix a value you think was misread. Can't: contact your provider, see your paper bill, or give legal or financial advice." />
            </p>
            <p className="mb-3 text-sm text-text-muted">
              Ask anything about this bill -- it can explain a line, the tax rate, or your total, and compare with
              earlier bills from this provider. It can&apos;t contact your provider or see your paper bill.
            </p>
            {chatMessages.length === 0 && stage.name === "done" && suggestionChips.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {suggestionChips.map((chip, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleAskQuestion(chip.question)}
                    disabled={chatSending || chatLimitReached}
                    className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            )}
            {chatMessages.length > 0 && stage.name === "done" && (
              <div className="mb-3 flex flex-col gap-2">
                {chatMessages.map((m, i) => {
                  if (m.kind === "text") {
                    return (
                      <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                        <p
                          className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                            m.role === "user" ? "bg-accent-soft text-accent" : "bg-surface-alt text-text"
                          }`}
                        >
                          {m.content}
                        </p>
                      </div>
                    );
                  }
                  return (
                    <div key={i} className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
                      <p>{describeCorrection(m.correction, stage.bill)}</p>
                      {m.correction.reason && <p className="text-xs text-text-muted">{m.correction.reason}</p>}
                      {m.status === "pending" ? (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleCorrectionDecision(i, "applied")}
                            disabled={applyingCorrection}
                            className={buttonPrimary}
                          >
                            {applyingCorrection ? "Applying..." : "Apply"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCorrectionDecision(i, "dismissed")}
                            disabled={applyingCorrection}
                            className={buttonSecondary}
                          >
                            Dismiss
                          </button>
                        </div>
                      ) : (
                        <p className="text-xs font-medium text-text-muted">
                          {m.status === "applied" ? "✓ Applied" : "Dismissed"}
                        </p>
                      )}
                    </div>
                  );
                })}
                {chatSending && (
                  <div className="flex justify-start">
                    <div className="flex max-w-[85%] items-center gap-2 rounded-lg bg-surface-alt px-3 py-2 text-sm text-text-muted">
                      {chatBusyRetrying ? (
                        "Busy -- retrying..."
                      ) : (
                        <span className="flex items-center gap-1" aria-label="Thinking">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:-0.3s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:-0.15s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted" />
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            {chatError && <p className="mb-2 text-sm text-danger">{chatError}</p>}
            {chatLimitReached ? (
              <p className="text-sm text-text-muted">You&apos;ve reached the {MAX_FOLLOWUP_MESSAGES}-question limit for this bill.</p>
            ) : (
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleAskQuestion();
                    }
                  }}
                  placeholder="Ask about a line on this bill..."
                  disabled={chatSending}
                  className={`${inputClasses} flex-1`}
                />
                <button
                  type="button"
                  onClick={() => handleAskQuestion()}
                  disabled={chatSending || !chatInput.trim()}
                  className={buttonPrimary}
                >
                  {chatSending ? "Sending..." : "Send"}
                </button>
              </div>
            )}
          </div>

          <button onClick={startOver} className={`${buttonSecondary} self-start`}>
            Upload another bill
          </button>

          {/* Inline toast, not a blocking modal -- fixed so it doesn't shift
              the page layout, auto-hides after 6s (triggerThankYou), or
              dismissed early by the close button. Never implies BillShield
              itself sent anything, only that the user did. */}
          {showThankYou && (
            <div
              role="status"
              className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-sm items-start gap-3 rounded-lg border border-success bg-success-soft p-4 text-sm text-success shadow-card animate-fade-up sm:inset-x-auto sm:right-4 sm:left-auto"
            >
              <p className="flex-1">{buildThankYouMessage(userFullName, stage.bill.provider)}</p>
              <button
                type="button"
                onClick={() => setShowThankYou(false)}
                aria-label="Dismiss"
                className="shrink-0 text-success hover:opacity-70"
              >
                ✕
              </button>
            </div>
          )}
        </section>
      )}

      {stage.name === "error" && (
        <section className={`${card} mt-2 flex flex-col gap-3`}>
          {stage.notice && <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">{stage.notice}</p>}
          <p className="text-danger">{stage.message}</p>
          {retryCountdown !== null && retryCountdown > 0 ? (
            <p className="text-sm text-text-muted">Try again in {retryCountdown}s...</p>
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
