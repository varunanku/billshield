// Validates a client-supplied bills-bucket path before it's used with a
// privileged (RLS-bypassing) client. That bypass means this check is the
// only thing enforcing "only your own files" at that point -- it's not a
// convenience, it's the whole security boundary. `userId` must come from
// the server's own session (supabase.auth.getUser()), never from the
// request body, or this check is meaningless.
//
// Exact shape only: "<userId>/<uuid>.<ext>", ext one of the four this app
// ever writes. Anchored start-to-end, so there's no slash, "..", or extra
// segment that can sneak through -- a path with anything other than
// exactly one "/" and a UUID on each side simply doesn't match.
const OWNED_PATH_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|pdf)$/;

export function isValidOwnedPath(path: string, userId: string): boolean {
  const match = OWNED_PATH_PATTERN.exec(path);
  if (!match) return false;
  return match[1] === userId;
}
