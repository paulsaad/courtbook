/**
 * Where to send someone after signing in (or finishing their profile): only a path on THIS site.
 *
 * Checking "starts with / and not //" is not enough: browsers and URL parsers turn a backslash into a slash and drop
 * tabs and newlines, so "/\evil.example" or "/<tab>/evil.example" pass that check and then resolve to
 * https://evil.example — an open redirect right after a genuine sign-in (review 25 Nov). This keeps a path only if,
 * resolved against our own origin, it stays on it, and it contains no backslash, control character or whitespace.
 * Anything else becomes "/".
 */
const PROBE_ORIGIN = "https://courtbook.invalid";

export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  if (/[\\\s\u0000-\u001f\u007f]/.test(next)) return "/";
  let u: URL;
  try { u = new URL(next, PROBE_ORIGIN); } catch { return "/"; }
  if (u.origin !== PROBE_ORIGIN) return "/";
  return u.pathname + u.search + u.hash;
}
