// Security headers. Pure. Run with: node lib/security-headers.test.mjs
import assert from "node:assert/strict";
import { securityHeaders } from "./security-headers.ts";

const get = (headers, key) => headers.find((h) => h.key === key)?.value;

{
  const h = securityHeaders("https://abcd.supabase.co", false);
  const csp = get(h, "Content-Security-Policy");
  assert.equal(get(h, "X-Frame-Options"), "DENY");
  assert.equal(get(h, "Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.match(get(h, "Permissions-Policy"), /camera=\(\)/);
  assert.equal(get(h, "X-Content-Type-Options"), "nosniff");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/abcd\.supabase\.co wss:\/\/abcd\.supabase\.co/, "browser can reach Supabase auth/storage");
  assert.doesNotMatch(csp, /unsafe-eval/, "no eval in production");
  assert.doesNotMatch(csp, /ws:|localhost/, "no dev endpoints in production");
  assert.match(csp, /upgrade-insecure-requests/);
  console.log("PASS: production headers -- CSP, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, nosniff");
}

{
  const csp = get(securityHeaders("https://abcd.supabase.co", true), "Content-Security-Policy");
  assert.match(csp, /'unsafe-eval'/, "dev server needs eval for hot reload");
  assert.match(csp, /ws:/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/, "localhost is http");
  console.log("PASS: dev headers allow hot reload");
}

{
  const csp = get(securityHeaders(undefined, false), "Content-Security-Policy");
  assert.match(csp, /connect-src 'self';/, "no Supabase URL -> self only, no crash");
  console.log("PASS: missing Supabase URL handled");
}
