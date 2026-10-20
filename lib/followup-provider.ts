// Pure retry/fallback and error-message logic for the follow-up chat's
// provider call -- pulled out of the route so both halves are testable
// with a mocked provider, no network or env vars required.
import type { ChatResult, ChatTurn } from "./groq.ts";

export type ProviderFn = (systemPrompt: string, history: ChatTurn[]) => Promise<ChatResult>;

// Exactly one retry, ever, per turn:
// - rate_limited: wait out the given retry-after (capped at 10s so this
//   route can't blow its own time budget), then retry via `fallback`.
// - failed + transient (a network blip, a 5xx, or an otherwise-ok response
//   missing its content): retry via `fallback` immediately, no wait.
// - failed + NOT transient (a 4xx other than 429): never retried -- the
//   identical request would just fail the same way again.
// `fallback` may be the exact same function as `primary` (when there's no
// second provider configured) -- calling it still counts as the one retry,
// just of the same provider.
export async function answerWithRetry(
  systemPrompt: string,
  history: ChatTurn[],
  primary: ProviderFn,
  fallback: ProviderFn,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<ChatResult> {
  const result = await primary(systemPrompt, history);
  if (result.ok) return result;

  if (result.kind === "rate_limited") {
    const waitSeconds = Math.min(result.retryAfterSeconds ?? 5, 10);
    await sleep(waitSeconds * 1000);
    return fallback(systemPrompt, history);
  }

  if (result.transient) {
    return fallback(systemPrompt, history);
  }

  return result;
}

// What the route shows the user for a final (post-retry) non-ok result.
// "The AI is busy" is specific to an actual provider error (kind
// "failed") -- never the old generic "Couldn't answer that", which gave
// no indication of what to do next.
export function followupErrorMessage(result: Extract<ChatResult, { ok: false }>): {
  reason: "rate_limited" | "server_error";
  message: string;
} {
  if (result.kind === "rate_limited") {
    const wait = result.retryAfterSeconds;
    return {
      reason: "rate_limited",
      message: wait
        ? `We're getting a lot of requests right now. Please wait about ${Math.ceil(wait)}s and try again.`
        : "We're getting a lot of requests right now. Please wait a few seconds and try again.",
    };
  }
  return { reason: "server_error", message: "The AI is busy, please try again in a moment." };
}
