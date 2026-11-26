/**
 * Chat privacy (Paul, 26 Nov): a chat notice is emailed as "New message from <name>" and nothing else, whatever the
 * row holds. The database stops storing message text (docs/chat-privacy); this keeps an email from ever carrying it,
 * also before that change is applied or after a rollback of it.
 */
export function emailSafe<T extends { kind: string; body: string }>(n: T): T {
  if (n.kind !== "match_message") return n;
  return { ...n, body: /^New message from .{1,80}$/.test(n.body) && !n.body.includes(":") ? n.body : "New message in one of your games" };
}
