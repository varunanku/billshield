// Run with: node lib/followup-provider.test.mjs
import assert from "node:assert/strict";
import { answerWithRetry, followupErrorMessage } from "./followup-provider.ts";

const noWait = async () => {};

function calls(fn) {
  const log = [];
  const wrapped = async (...args) => {
    log.push(args);
    return fn(...args);
  };
  wrapped.calls = log;
  return wrapped;
}

// Case 1: primary succeeds -- fallback is never called.
{
  const primary = calls(async () => ({ ok: true, text: "answer" }));
  const fallback = calls(async () => ({ ok: true, text: "should not be used" }));
  const result = await answerWithRetry("sp", [], primary, fallback, noWait);
  assert.deepEqual(result, { ok: true, text: "answer" });
  assert.equal(fallback.calls.length, 0);
  console.log("PASS: primary ok -- fallback never called");
}

// Case 2: primary rate_limited -- waits, then retries via fallback exactly once.
{
  const primary = calls(async () => ({ ok: false, kind: "rate_limited", retryAfterSeconds: 3 }));
  const fallback = calls(async () => ({ ok: true, text: "from fallback" }));
  const waits = [];
  const result = await answerWithRetry("sp", [], primary, fallback, async (ms) => {
    waits.push(ms);
  });
  assert.deepEqual(result, { ok: true, text: "from fallback" });
  assert.equal(fallback.calls.length, 1, "fallback called exactly once");
  assert.deepEqual(waits, [3000], "waits the given retry-after, in ms");
  console.log("PASS: rate_limited -- waits then retries via fallback exactly once");
}

// Case 3: rate_limited with no retry-after header -- falls back to a 5s wait.
{
  const primary = calls(async () => ({ ok: false, kind: "rate_limited", retryAfterSeconds: null }));
  const fallback = calls(async () => ({ ok: true, text: "ok" }));
  const waits = [];
  await answerWithRetry("sp", [], primary, fallback, async (ms) => waits.push(ms));
  assert.deepEqual(waits, [5000]);
  console.log("PASS: rate_limited with no retry-after -- defaults to a 5s wait");
}

// Case 4: rate_limited with a huge retry-after is capped at 10s.
{
  const primary = calls(async () => ({ ok: false, kind: "rate_limited", retryAfterSeconds: 120 }));
  const fallback = calls(async () => ({ ok: true, text: "ok" }));
  const waits = [];
  await answerWithRetry("sp", [], primary, fallback, async (ms) => waits.push(ms));
  assert.deepEqual(waits, [10000], "capped at 10s so the route can't blow its own time budget");
  console.log("PASS: a huge retry-after is capped at 10s");
}

// Case 5: a transient "failed" result retries via fallback immediately --
// no wait at all.
{
  const primary = calls(async () => ({ ok: false, kind: "failed", detail: "network error: fetch failed", transient: true }));
  const fallback = calls(async () => ({ ok: true, text: "from fallback" }));
  let waited = false;
  const result = await answerWithRetry("sp", [], primary, fallback, async () => {
    waited = true;
  });
  assert.deepEqual(result, { ok: true, text: "from fallback" });
  assert.equal(fallback.calls.length, 1);
  assert.equal(waited, false, "a transient failure never waits -- only rate_limited does");
  console.log("PASS: transient failed -- retries via fallback immediately, no wait");
}

// Case 6: a NON-transient "failed" result (a 4xx) is never retried --
// fallback is never called, the original result comes straight back.
{
  const original = { ok: false, kind: "failed", detail: "400 bad request", transient: false };
  const primary = calls(async () => original);
  const fallback = calls(async () => ({ ok: true, text: "should never be used" }));
  const result = await answerWithRetry("sp", [], primary, fallback, noWait);
  assert.deepEqual(result, original);
  assert.equal(fallback.calls.length, 0, "a non-transient failure is never retried");
  console.log("PASS: non-transient failed (e.g. a 4xx) -- never retried");
}

// Case 7: the fallback can itself fail -- answerWithRetry never loops
// again, it just returns whatever the fallback produced (exactly one retry).
{
  const primary = calls(async () => ({ ok: false, kind: "failed", detail: "502", transient: true }));
  const fallbackResult = { ok: false, kind: "failed", detail: "502 again", transient: true };
  const fallback = calls(async () => fallbackResult);
  const result = await answerWithRetry("sp", [], primary, fallback, noWait);
  assert.deepEqual(result, fallbackResult);
  assert.equal(fallback.calls.length, 1, "exactly one retry, even though it also failed");
  console.log("PASS: fallback also failing -- still exactly one retry, no further looping");
}

// Case 8: fallback can be the SAME function as primary (Groq already
// primary, no other provider configured) -- that still counts as the one retry.
{
  let callCount = 0;
  const sameProvider = async () => {
    callCount += 1;
    return callCount === 1
      ? { ok: false, kind: "failed", detail: "502", transient: true }
      : { ok: true, text: "second call succeeded" };
  };
  const result = await answerWithRetry("sp", [], sameProvider, sameProvider, noWait);
  assert.deepEqual(result, { ok: true, text: "second call succeeded" });
  assert.equal(callCount, 2, "primary and fallback being the same function still only retries once");
  console.log("PASS: fallback === primary (no second provider) -- still exactly one retry");
}

// --- followupErrorMessage ---------------------------------------------

// Case 9: a provider "failed" result maps to the specific, actionable
// message, never the old generic "Couldn't answer that".
{
  const { reason, message } = followupErrorMessage({ ok: false, kind: "failed", detail: "502", transient: true });
  assert.equal(reason, "server_error");
  assert.equal(message, "The AI is busy, please try again in a moment.");
  console.log("PASS: a provider failure maps to 'The AI is busy...', not the old generic message");
}

// Case 10: rate_limited (after the retry is also rate-limited) maps to the
// wait-and-retry message, with the actual wait time when given.
{
  const withWait = followupErrorMessage({ ok: false, kind: "rate_limited", retryAfterSeconds: 7.2 });
  assert.equal(withWait.reason, "rate_limited");
  assert.ok(withWait.message.includes("8s"), "rounds the wait up to a whole second");

  const withoutWait = followupErrorMessage({ ok: false, kind: "rate_limited", retryAfterSeconds: null });
  assert.ok(/a few seconds/.test(withoutWait.message));
  console.log("PASS: rate_limited maps to the wait-and-retry message in both cases");
}

console.log("\nAll followup-provider tests passed.");
