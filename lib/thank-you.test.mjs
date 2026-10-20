// Run with: node lib/thank-you.test.mjs
import assert from "node:assert/strict";
import { buildThankYouMessage } from "./thank-you.ts";

{
  const msg = buildThankYouMessage("Jane Doe", "Airtel");
  assert.equal(msg, "Thanks for trusting BillShield, Jane. BillShield hopes this message helps you get this sorted with Airtel. Good luck!");
  console.log("PASS: name + provider -- uses first name only, names the provider");
}

{
  const msg = buildThankYouMessage(null, "Airtel");
  assert.equal(msg, "Thanks for trusting BillShield. BillShield hopes this message helps you get this sorted with Airtel. Good luck!");
  console.log("PASS: provider only -- name clause omitted gracefully");
}

{
  const msg = buildThankYouMessage("Jane Doe", null);
  assert.equal(msg, "Thanks for trusting BillShield, Jane. BillShield hopes this message helps you get this sorted. Good luck!");
  console.log("PASS: name only -- provider clause omitted gracefully");
}

{
  const msg = buildThankYouMessage(null, null);
  assert.equal(msg, "Thanks for trusting BillShield. BillShield hopes this message helps you get this sorted. Good luck!");
  console.log("PASS: neither name nor provider -- both clauses omitted gracefully");
}

{
  // "your provider" is confirm's own placeholder for an unknown provider
  // (see app/api/bills/confirm/route.ts) -- never named back to the user.
  const msg = buildThankYouMessage("Jane Doe", "your provider");
  assert.equal(msg, "Thanks for trusting BillShield, Jane. BillShield hopes this message helps you get this sorted. Good luck!");
  console.log("PASS: the 'your provider' placeholder is treated as unknown, not named");
}

console.log("\nAll thank-you tests passed.");
