// Per-user and per-IP rate limits for the routes that cost money or invite
// abuse. The counter lives in Postgres (migration 0013's hit_rate_limit),
// so it holds across every Vercel instance. If that call fails -- e.g. the
// migration hasn't been run yet -- each instance falls back to its own
// in-memory counter rather than letting everything through.
type AdminClient = ReturnType<typeof import("./supabase/admin.ts").createAdminClient>;

export type Rule = { key: string; limit: number; windowSeconds: number };
export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

// Limits per action. "user" keys use the signed-in user id (or the email
// for sign-up/sign-in, before there is a user); "ip" keys use the caller's IP.
export const LIMITS = {
  signup: { user: [3, 3600], ip: [5, 3600] },
  signin: { user: [10, 900], ip: [30, 900] },
  extract: { user: [20, 3600], ip: [40, 3600] },
  chat: { user: [60, 3600], ip: [120, 3600] },
  draftEmail: { user: [30, 3600], ip: [60, 3600] },
} as const;

export type Action = keyof typeof LIMITS;

export function rulesFor(action: Action, userKey: string, ip: string): Rule[] {
  const { user, ip: ipLimit } = LIMITS[action];
  return [
    { key: `${action}:user:${userKey.toLowerCase()}`, limit: user[0], windowSeconds: user[1] },
    { key: `${action}:ip:${ip}`, limit: ipLimit[0], windowSeconds: ipLimit[1] },
  ];
}

// First address in x-forwarded-for is the client on Vercel.
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "unknown";
}

// ponytail: per-instance fallback only -- resets on cold start and isn't
// shared between instances. Fine as a stopgap until migration 0013 runs.
const memory = new Map<string, { windowStart: number; hits: number }>();

export function memoryHit(
  store: Map<string, { windowStart: number; hits: number }>,
  rule: Rule,
  now: number
): number {
  const windowMs = rule.windowSeconds * 1000;
  const entry = store.get(rule.key);
  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(rule.key, { windowStart: now, hits: 1 });
    return 0;
  }
  entry.hits++;
  return entry.hits > rule.limit ? Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000)) : 0;
}

export async function checkRateLimit(rules: Rule[]): Promise<LimitResult> {
  let worst = 0;
  let admin: AdminClient | null = null;
  try {
    // Lazy: the admin module is server-only, and this file's pure helpers
    // are unit-tested in plain Node.
    const { createAdminClient } = await import("./supabase/admin.ts");
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  for (const rule of rules) {
    let wait: number | null = null;
    if (admin) {
      const { data, error } = await admin.rpc("hit_rate_limit", {
        p_key: rule.key,
        p_limit: rule.limit,
        p_window_seconds: rule.windowSeconds,
      });
      if (!error && typeof data === "number") wait = data;
    }
    if (wait === null) wait = memoryHit(memory, rule, Date.now());
    worst = Math.max(worst, wait);
  }
  return worst > 0 ? { ok: false, retryAfterSeconds: worst } : { ok: true };
}

export function tooManyMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return minutes <= 1
    ? "Too many requests. Please wait a minute and try again."
    : `Too many requests. Please wait about ${minutes} minutes and try again.`;
}
