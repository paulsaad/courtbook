/**
 * Where the app may go after signing in (`returnTo`, which a link into the app can set). Only a screen of this app:
 * a path starting with one "/", no backslash, whitespace or control character. expo-router opens anything that looks
 * like a URL ("//host", "https://…", "mailto:…") outside the app, so "//evil.example" — which a plain
 * startsWith("/") check accepts — would send a freshly signed-in person to another site.
 */
export function safeReturnPath(returnTo: unknown): string {
  if (typeof returnTo !== "string" || returnTo.length === 0 || returnTo.length > 2048) return "/";
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return "/";
  if (/[\\\s\u0000-\u001f\u007f]/.test(returnTo)) return "/";
  return returnTo;
}
