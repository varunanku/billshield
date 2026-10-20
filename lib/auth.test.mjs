// Run with: node lib/auth.test.mjs
import assert from "node:assert/strict";
import { signUpMetadata } from "./auth.ts";

{
  const metadata = signUpMetadata("Jane Doe");
  assert.deepEqual(metadata, { full_name: "Jane Doe" });
  console.log("PASS: signUpMetadata includes full_name in the signUp metadata shape");
}

{
  const metadata = signUpMetadata("  Jane Doe  ");
  assert.deepEqual(metadata, { full_name: "Jane Doe" }, "surrounding whitespace is trimmed");
  console.log("PASS: signUpMetadata trims the name");
}

console.log("\nAll auth tests passed.");
