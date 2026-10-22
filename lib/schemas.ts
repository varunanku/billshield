// Zod schemas for every API route's input: types, lengths, number ranges,
// enums and ID formats. Routes call parseInput() and return a 400 with the
// plain message it gives back. Optional fields that come straight from the
// AI's reading of a bill (dates, units, category, printed codes) fall back
// to null/[] when malformed instead of blocking the user's confirm -- the
// same leniency the hand-written validators had.
import { z } from "zod";
import { LINE_ROLES, BILL_CATEGORIES, type LineRole, type BillCategory } from "./bill-checks.ts";
import { TONE_PRESETS } from "./email-draft.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MONEY = 1e9; // well inside bills.total_amount's numeric(12,2)

const roles = LINE_ROLES as [LineRole, ...LineRole[]];
const categories = BILL_CATEGORIES as [BillCategory, ...BillCategory[]];

export const money = z
  .number({ error: "Amounts must be numbers." })
  .min(-MAX_MONEY, "That amount is too large.")
  .max(MAX_MONEY, "That amount is too large.");
const label = z.string().trim().min(1, "Every line needs a label.").max(300, "A line label is too long (max 300 characters).");
const shortText = (max: number) => z.string().trim().max(max, `That text is too long (max ${max} characters).`);
const isoDate = z.string().regex(DATE_RE);

// Route params: every bill/message id is a UUID.
export const idSchema = z.guid({ error: "That ID isn't valid." });

export const extractSchema = z.object(
  { path: z.string({ error: "No uploaded file path was given." }).min(1, "No uploaded file path was given.").max(200) },
  { error: "Request body was missing." }
);

const lineSchema = z.object(
  {
    label,
    amount: money,
    role: z.enum(roles, { error: "Every line needs a label, amount and role." }),
    unrecognized: z.boolean().optional().default(false),
  },
  { error: "A line item was malformed." }
);

export const confirmSchema = z.object(
  {
    path: z.string({ error: "No uploaded file path was given." }).min(1, "No uploaded file path was given.").max(200),
    provider: shortText(200).optional().default(""),
    provider_legal_name: shortText(300)
      .nullable()
      .optional()
      .transform((v) => v || null),
    bill_date: z
      .string()
      .trim()
      .optional()
      .default("")
      .refine((v) => v === "" || DATE_RE.test(v), "Please enter a valid bill date."),
    total: z.number({ error: "Please enter the bill total." }).min(-MAX_MONEY).max(MAX_MONEY, "That total is too large."),
    category: z.enum(categories).nullable().catch(null),
    billing_period_start: isoDate.nullable().catch(null),
    billing_period_end: isoDate.nullable().catch(null),
    units_consumed: z.number().min(0).max(1e9).nullable().catch(null),
    units_consumed_unit: z.string().max(40).nullable().catch(null),
    printed_hsn_codes: z.array(z.string().max(20)).max(50).catch([]),
    line_items: z
      .array(lineSchema, { error: "At least one line item is required." })
      .min(1, "At least one line item is required.")
      .max(200, "Too many line items (max 200)."),
    promise: z
      .object({
        statement: shortText(1000),
        promisedAmount: money.nullable().optional().default(null),
      })
      .nullable()
      .optional()
      .default(null)
      .transform((p) => (p && p.statement ? p : null)),
  },
  { error: "Bill data was missing." }
);

const disputedLine = z.object({ label: shortText(300), amount: money });

export const factsSchema = z.object(
  {
    provider: z.string().trim().min(1, "Facts were incomplete.").max(200),
    billDate: z.string().trim().min(1, "Facts were incomplete.").max(40),
    disputedLines: z.array(disputedLine).max(50).optional().default([]),
    gap: money,
    promisedAmount: money.nullable().optional().default(null),
    billedAmount: money,
    total: money,
    reconcilingBalanceLabel: shortText(300).nullable().optional().default(null),
    taxFinding: z
      .object({
        effectiveRatePercent: z.number().min(0).max(1000),
        expectedRatePercent: z.number().min(0).max(1000),
        hsnPrefix: shortText(20).nullable().optional().default(null),
        sourceUrl: shortText(500).nullable().optional().default(null),
      })
      .nullable()
      .optional()
      .default(null),
    expectedAmountGap: z
      .object({ matchedLineLabel: shortText(300).nullable().optional().default(null) })
      .nullable()
      .optional()
      .default(null),
  },
  { error: "Missing facts." }
);

export const draftEmailSchema = z.object(
  {
    billId: idSchema,
    outcome: z.enum(["confirmed_error", "cannot_verify", "unexplained"], { error: "Invalid outcome." }),
    facts: factsSchema,
    tonePreset: z.enum(TONE_PRESETS).nullable().optional().default(null),
  },
  { error: "Request body was missing." }
);

export const followupSchema = z.object(
  {
    question: z
      .string({ error: "No question was given." })
      .trim()
      .min(1, "No question was given.")
      .max(1000, "That question is too long."),
    context: z.object(
      {
        provider: shortText(200).nullable().optional().default(null),
        billDate: shortText(40).nullable().optional().default(null),
        total: money,
        lineItems: z
          .array(z.object({ label, amount: money, role: z.enum(roles) }))
          .max(200)
          .optional()
          .default([]),
        verdictOutcome: z.enum(["clean", "confirmed_error", "cannot_verify", "unexplained"]),
        verdictGap: money.nullable().optional().default(null),
        disputedLines: z.array(disputedLine).max(50).optional().default([]),
        warnings: z.array(shortText(500)).max(50).optional().default([]),
        printedHsnCodes: z.array(shortText(20)).max(50).optional().default([]),
        taxTotal: money.optional().default(0),
        expectedAmount: z
          .object({ promisedAmount: money, matchedLineLabel: shortText(300).nullable().optional().default(null) })
          .nullable()
          .optional()
          .default(null),
      },
      { error: "Missing bill context." }
    ),
  },
  { error: "Request body was missing." }
);

export const applyCorrectionSchema = z.object(
  {
    correction: z
      .object(
        {
          field: z.enum(["provider", "bill_date", "printed_total", "line"], { error: "Invalid correction field." }),
          line_index: z.number().int().min(0).max(500).nullable().optional().default(null),
          new_label: shortText(300).nullable().optional().default(null),
          new_role: z.enum(roles).nullable().optional().default(null),
          new_amount: money.nullable().optional().default(null),
          reason: shortText(500).optional().default(""),
        },
        { error: "Missing correction." }
      )
      .refine((c) => c.field !== "line" || c.line_index !== null, "A line correction needs a line_index.")
      .refine(
        (c) => c.field !== "bill_date" || c.new_label === null || DATE_RE.test(c.new_label),
        "A corrected bill date must look like YYYY-MM-DD."
      ),
  },
  { error: "Request body was missing." }
);

const finalBody = z.string().max(20000, "That message is too long.").optional();

export const messageActionSchema = z.object(
  {
    action_taken: z.enum(["sent_as_is", "sent_with_tone_preset", "sent_manually_edited", "not_sent"], {
      error: "Invalid action.",
    }),
    final_body: finalBody,
  },
  { error: "Request body was missing." }
);

export const messageEventSchema = z.object(
  {
    event_type: z.enum(["copied", "opened_email_app", "marked_sent"], { error: "Invalid event." }),
    final_body: finalBody,
  },
  { error: "Request body was missing." }
);

// One plain sentence for a 400: the first problem found.
export function parseInput<T extends z.ZodType>(
  schema: T,
  value: unknown
): { ok: true; data: z.infer<T> } | { ok: false; message: string } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
  const message = issue?.message && !/^Invalid input/.test(issue.message) ? issue.message : `Some of the details sent were invalid${where}.`;
  return { ok: false, message };
}
