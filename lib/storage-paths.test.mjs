import assert from "node:assert/strict";
import { isValidOwnedPath } from "./storage-paths.ts";

const userId = "11111111-1111-1111-1111-111111111111";
const otherUserId = "22222222-2222-2222-2222-222222222222";
const fileUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

assert.equal(isValidOwnedPath(`${userId}/${fileUuid}.jpg`, userId), true, "valid own path should pass");
assert.equal(isValidOwnedPath(`${otherUserId}/${fileUuid}.jpg`, userId), false, "another user's path should be rejected");
assert.equal(isValidOwnedPath(`${userId}/../${otherUserId}/${fileUuid}.jpg`, userId), false, "path traversal with .. should be rejected");
assert.equal(isValidOwnedPath(`${userId}/${fileUuid}.exe`, userId), false, "wrong/disallowed extension should be rejected");
assert.equal(isValidOwnedPath("", userId), false, "empty string should be rejected");

// A few extra shapes worth pinning down while we're here.
assert.equal(isValidOwnedPath(`${userId}//${fileUuid}.jpg`, userId), false, "double slash should be rejected");
assert.equal(isValidOwnedPath(`${userId}/${fileUuid}.jpg/extra`, userId), false, "trailing extra segment should be rejected");
assert.equal(isValidOwnedPath(`${userId}/${fileUuid}.jpeg`, userId), true, "jpeg extension should pass");
assert.equal(isValidOwnedPath(`${userId}/${fileUuid}.png`, userId), true, "png extension should pass");
assert.equal(isValidOwnedPath(`${userId}/${fileUuid}.pdf`, userId), true, "pdf extension should pass");
assert.equal(isValidOwnedPath(`${userId}/${fileUuid}.webp`, userId), true, "webp extension should pass");
assert.equal(isValidOwnedPath(`${userId}/${fileUuid}.heic`, userId), false, "heic extension should be rejected");
assert.equal(isValidOwnedPath(`${userId}/not-a-uuid.jpg`, userId), false, "non-UUID filename should be rejected");

console.log("PASS: isValidOwnedPath -- own path, foreign path, traversal, bad extension, empty string, and extras");
