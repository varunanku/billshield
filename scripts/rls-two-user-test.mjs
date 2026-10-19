// Two-user RLS proof against a real Supabase project.
// Run with: node --env-file=.env.local scripts/rls-two-user-test.mjs
//
// Creates two throwaway users via the admin API, has user A write one bill
// + line item + promise + message + bill_metrics row + one storage file,
// then proves user B (and an anon client) cannot read, modify or link to
// any of it -- including history data (Phase 3) -- and that user A still
// can. Prints PASS/FAIL per check, then deletes everything it created
// (storage files, data rows, both auth users) even if a check fails.
//
// Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY. Service role is used only for the auth admin
// API (create/delete user) and for storage cleanup -- it has no grants on
// the public schema tables (by design, see migration), so all data
// reads/writes below go through the two users' own authenticated clients.

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}
// "denied" covers both shapes Postgres/PostgREST use for "you get nothing":
// an explicit error (no grant at all, e.g. anon), or a clean empty result
// (grant exists, RLS just filtered every row out, e.g. authenticated B).
function denied({ data, error }) {
  if (error) return true;
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  return false;
}

const stamp = crypto.randomUUID().slice(0, 8);
const password = crypto.randomUUID() + "Aa1!";
const emailA = `rls-test-a-${stamp}@example.com`;
const emailB = `rls-test-b-${stamp}@example.com`;

let userA, userB, clientA, clientB, anonClient;
let billA, lineItemA, promiseA, messageA, billB, metricA;
const filePathA = (name) => `${userA.id}/${name}`;
const TEST_FILE_NAME = `rls-test-${stamp}.txt`;

async function signIn(email) {
  const c = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return c;
}

async function setup() {
  const createdA = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true });
  if (createdA.error) throw createdA.error;
  userA = createdA.data.user;

  const createdB = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true });
  if (createdB.error) throw createdB.error;
  userB = createdB.data.user;

  clientA = await signIn(emailA);
  clientB = await signIn(emailB);
  anonClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // User A writes one bill, one line item, one promise, one message.
  const billRes = await clientA
    .from("bills")
    .insert({
      user_id: userA.id,
      provider_name: "RLS Test Provider",
      bill_date: "2026-10-01",
      total_amount: 352.82,
      file_path: filePathA(TEST_FILE_NAME),
    })
    .select()
    .single();
  if (billRes.error) throw billRes.error;
  billA = billRes.data;
  check("setup: user A can insert a bill", true);

  const lineRes = await clientA
    .from("line_items")
    .insert({ bill_id: billA.id, line_order: 1, label: "Static IP Charges", amount: 299.0 })
    .select()
    .single();
  if (lineRes.error) throw lineRes.error;
  lineItemA = lineRes.data;
  check("setup: user A can insert a line item on own bill", true);

  const promiseRes = await clientA
    .from("promises")
    .insert({ bill_id: billA.id, statement: "Technician said this would be removed." })
    .select()
    .single();
  if (promiseRes.error) throw promiseRes.error;
  promiseA = promiseRes.data;
  check("setup: user A can insert a promise on own bill", true);

  const messageRes = await clientA
    .from("messages")
    .insert({
      bill_id: billA.id,
      line_item_id: lineItemA.id,
      subject: "Query about Static IP Charges",
      body: "Test body.",
      tone: "inquiry",
    })
    .select()
    .single();
  if (messageRes.error) throw messageRes.error;
  messageA = messageRes.data;
  check("setup: user A can insert a message linking own line item", true);

  const metricRes = await clientA
    .from("bill_metrics")
    .insert({ bill_id: billA.id, metric: "units_consumed", value: 248, unit: "kWh" })
    .select()
    .single();
  if (metricRes.error) throw metricRes.error;
  metricA = metricRes.data;
  check("setup: user A can insert a bill_metrics row on own bill", true);

  const uploadRes = await clientA.storage.from("bills").upload(filePathA(TEST_FILE_NAME), "rls test file contents", {
    contentType: "text/plain",
    upsert: true,
  });
  if (uploadRes.error) throw uploadRes.error;
  check("setup: user A can upload a file into own folder", true);
}

async function userBCannotReadWriteOrDeleteAsRow(table, row) {
  const sel = await clientB.from(table).select("*").eq("id", row.id).maybeSingle();
  check(`user B cannot select A's ${table} row`, denied(sel));

  const upd = await clientB.from(table).update({ ...(table === "bills" ? { provider_name: "hacked" } : {}) }).eq("id", row.id).select();
  check(`user B cannot update A's ${table} row`, denied(upd));

  const del = await clientB.from(table).delete().eq("id", row.id).select();
  check(`user B cannot delete A's ${table} row`, denied(del));
}

async function dataChecks() {
  await userBCannotReadWriteOrDeleteAsRow("bills", billA);
  await userBCannotReadWriteOrDeleteAsRow("line_items", lineItemA);
  await userBCannotReadWriteOrDeleteAsRow("promises", promiseA);
  await userBCannotReadWriteOrDeleteAsRow("messages", messageA);
  await userBCannotReadWriteOrDeleteAsRow("bill_metrics", metricA);

  const insMetric = await clientB
    .from("bill_metrics")
    .insert({ bill_id: billA.id, metric: "units_consumed", value: 1, unit: "kWh" })
    .select();
  check("user B cannot insert a bill_metrics row into A's bill", denied(insMetric));

  // Belt-and-suspenders: confirm B's update attempt didn't actually change
  // A's bill, not just that it returned no rows.
  const reread = await clientA.from("bills").select("provider_name").eq("id", billA.id).single();
  check("user B's update attempt left A's bill unchanged", reread.data?.provider_name === "RLS Test Provider");

  const insLine = await clientB
    .from("line_items")
    .insert({ bill_id: billA.id, line_order: 99, label: "malicious", amount: 1 })
    .select();
  check("user B cannot insert a line item into A's bill", denied(insLine));

  const insPromise = await clientB
    .from("promises")
    .insert({ bill_id: billA.id, statement: "malicious" })
    .select();
  check("user B cannot insert a promise into A's bill", denied(insPromise));

  const insMessage = await clientB
    .from("messages")
    .insert({ bill_id: billA.id, subject: "x", body: "y", tone: "confident" })
    .select();
  check("user B cannot insert a message into A's bill", denied(insMessage));

  // User B needs their own bill to pass the bill-ownership half of the
  // messages policy, so this isolates the link-ownership check specifically.
  const billBRes = await clientB
    .from("bills")
    .insert({
      user_id: userB.id,
      provider_name: "B's own provider",
      bill_date: "2026-10-01",
      total_amount: 10,
      file_path: `${userB.id}/placeholder.txt`,
    })
    .select()
    .single();
  if (billBRes.error) throw billBRes.error;
  billB = billBRes.data;

  const insMessageLinkingToA = await clientB
    .from("messages")
    .insert({ bill_id: billB.id, line_item_id: lineItemA.id, subject: "x", body: "y", tone: "confident" })
    .select();
  check("user B cannot insert a message linking to A's line item", denied(insMessageLinkingToA));

  // category_rates is hand-maintained reference data: any authenticated
  // user can read it, but only the service role (bypassing RLS) writes it --
  // there is no insert/update policy at all, so this isn't even ownership-
  // scoped, no authenticated user should be able to write here.
  const insRate = await clientA
    .from("category_rates")
    .insert({ category: `rls_test_${stamp}`, rate_type: "not_confirmed" })
    .select();
  check("authenticated user cannot insert into category_rates", denied(insRate));

  const updRate = await clientA
    .from("category_rates")
    .update({ rate_type: "gst_flat" })
    .eq("category", "broadband")
    .select();
  check("authenticated user cannot update category_rates", denied(updRate));

  const anonSel = await anonClient.from("bills").select("*").eq("id", billA.id).maybeSingle();
  check("anon client gets nothing on select", denied(anonSel));
  const anonIns = await anonClient
    .from("bills")
    .insert({ user_id: userA.id, provider_name: "x", bill_date: "2026-10-01", total_amount: 1, file_path: "x" })
    .select();
  check("anon client gets nothing on insert", denied(anonIns));

  const ownBill = await clientA.from("bills").select("*").eq("id", billA.id).single();
  check("user A can still select own bill", !ownBill.error && ownBill.data?.id === billA.id);
  const ownLine = await clientA.from("line_items").select("*").eq("id", lineItemA.id).single();
  check("user A can still select own line item", !ownLine.error && ownLine.data?.id === lineItemA.id);
  const ownPromise = await clientA.from("promises").select("*").eq("id", promiseA.id).single();
  check("user A can still select own promise", !ownPromise.error && ownPromise.data?.id === promiseA.id);
  const ownMessage = await clientA.from("messages").select("*").eq("id", messageA.id).single();
  check("user A can still select own message", !ownMessage.error && ownMessage.data?.id === messageA.id);
  const ownMetric = await clientA.from("bill_metrics").select("*").eq("id", metricA.id).single();
  check("user A can still select own bill_metrics row", !ownMetric.error && ownMetric.data?.id === metricA.id);
}

async function storageChecks() {
  const pathA = filePathA(TEST_FILE_NAME);

  const dl = await clientB.storage.from("bills").download(pathA);
  check("user B cannot download A's file", !!dl.error);

  const list = await clientB.storage.from("bills").list(userA.id);
  check("user B cannot list A's folder", denied({ data: list.data ?? null, error: list.error }));

  const overwrite = await clientB.storage.from("bills").upload(pathA, "overwritten by B", { upsert: true });
  check("user B cannot overwrite A's file", !!overwrite.error);

  const remove = await clientB.storage.from("bills").remove([pathA]);
  const stillThereAfterDelete = await clientA.storage.from("bills").download(pathA);
  check(
    "user B cannot delete A's file",
    !!remove.error || (!stillThereAfterDelete.error && stillThereAfterDelete.data != null)
  );

  const evilPath = filePathA(`evil-${stamp}.txt`);
  const uploadNew = await clientB.storage.from("bills").upload(evilPath, "evil", { upsert: false });
  check("user B cannot upload into A's folder", !!uploadNew.error);
}

async function cleanup() {
  const errors = [];
  try {
    if (billA) await clientA.from("bills").delete().eq("id", billA.id);
  } catch (e) {
    errors.push(e);
  }
  try {
    if (billB) await clientB.from("bills").delete().eq("id", billB.id);
  } catch (e) {
    errors.push(e);
  }
  try {
    // Service role bypasses storage RLS entirely -- guaranteed cleanup
    // regardless of what the checks above did to the bucket contents.
    if (userA) {
      const { data: files } = await admin.storage.from("bills").list(userA.id);
      const paths = (files ?? []).map((f) => `${userA.id}/${f.name}`);
      if (paths.length) await admin.storage.from("bills").remove(paths);
    }
    if (userB) {
      const { data: files } = await admin.storage.from("bills").list(userB.id);
      const paths = (files ?? []).map((f) => `${userB.id}/${f.name}`);
      if (paths.length) await admin.storage.from("bills").remove(paths);
    }
  } catch (e) {
    errors.push(e);
  }
  try {
    if (userA) await admin.auth.admin.deleteUser(userA.id);
  } catch (e) {
    errors.push(e);
  }
  try {
    if (userB) await admin.auth.admin.deleteUser(userB.id);
  } catch (e) {
    errors.push(e);
  }
  if (errors.length) {
    console.error("Cleanup had errors:", errors);
  } else {
    console.log("Cleanup done: test users, rows and storage files removed.");
  }
}

try {
  await setup();
  await dataChecks();
  await storageChecks();
} catch (e) {
  console.error("Test run aborted:", e);
  results.push({ name: "test run completed without throwing", pass: false });
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("Failed checks:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
