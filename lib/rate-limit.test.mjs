// Rate-limit helpers and auth input rules. Pure, no network.
// Run with: node lib/rate-limit.test.mjs
import assert from "node:assert/strict";
import { memoryHit, rulesFor, clientIp, tooManyMessage, LIMITS } from "./rate-limit.ts";
import { parseInput, signUpSchema, signInSchema } from "./schemas.ts";

// Fixed window: the (limit+1)th hit in a window is refused with the
// seconds left; a new window starts fresh.
{
  const store = new Map();
  const rule = { key: "k", limit: 3, windowSeconds: 60 };
  const t0 = 1_000_000;
  assert.equal(memoryHit(store, rule, t0), 0);
  assert.equal(memoryHit(store, rule, t0 + 1000), 0);
  assert.equal(memoryHit(store, rule, t0 + 2000), 0);
  assert.equal(memoryHit(store, rule, t0 + 10_000), 50, "4th hit refused, 50 s left");
  assert.equal(memoryHit(store, rule, t0 + 60_000), 0, "window over: allowed again");
  assert.equal(memoryHit(store, { ...rule, key: "other" }, t0 + 10_000), 0, "keys are independent");
  console.log("PASS: memoryHit -- fixed window, retry-after, independent keys");
}

// Every limited action gets one per-user and one per-IP rule.
{
  for (const action of Object.keys(LIMITS)) {
    const rules = rulesFor(action, "User@Example.com", "1.2.3.4");
    assert.equal(rules.length, 2);
    assert.equal(rules[0].key, `${action}:user:user@example.com`, "user key normalised");
    assert.equal(rules[1].key, `${action}:ip:1.2.3.4`);
    assert.ok(rules.every((r) => r.limit > 0 && r.windowSeconds > 0));
  }
  assert.deepEqual(Object.keys(LIMITS).sort(), ["chat", "draftEmail", "extract", "signin", "signup"]);
  console.log("PASS: rulesFor -- per-user and per-IP rule for sign-up, sign-in, extraction, chat, email");
}

// Client IP: first x-forwarded-for entry, then x-real-ip.
{
  const req = (headers) => new Request("https://x.test", { headers });
  assert.equal(clientIp(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })), "9.9.9.9");
  assert.equal(clientIp(req({ "x-real-ip": "8.8.8.8" })), "8.8.8.8");
  assert.equal(clientIp(req({})), "unknown");
  assert.match(tooManyMessage(30), /wait a minute/);
  assert.match(tooManyMessage(600), /about 10 minutes/);
  console.log("PASS: clientIp and tooManyMessage");
}

// Sign-up: password >= 8, name trimmed and length-limited, email normalised.
{
  const good = { email: "  Varun@Example.COM ", password: "longenough", fullName: "  Varun Sharma  " };
  const r = parseInput(signUpSchema, good);
  assert.ok(r.ok);
  assert.equal(r.data.email, "varun@example.com");
  assert.equal(r.data.fullName, "Varun Sharma");
  assert.equal(parseInput(signUpSchema, { ...good, password: "short7!" }).message, "Password must be at least 8 characters.");
  assert.equal(parseInput(signUpSchema, { ...good, password: "x".repeat(73) }).ok, false);
  assert.equal(parseInput(signUpSchema, { ...good, fullName: "   " }).message, "Please enter your full name.");
  assert.equal(parseInput(signUpSchema, { ...good, fullName: "n".repeat(101) }).ok, false);
  assert.equal(parseInput(signUpSchema, { ...good, email: "not-an-email" }).message, "Please enter a valid email address.");
  assert.ok(parseInput(signInSchema, { email: "A@B.co", password: "x" }).ok);
  assert.equal(parseInput(signInSchema, { email: "A@B.co", password: "" }).message, "Please enter your password.");
  console.log("PASS: auth schemas -- password min 8, trimmed name, normalised email");
}
