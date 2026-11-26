/**
 * A retry key (post_match's p_token, 0073) belongs to ONE request: the exact arguments it was made for.
 * post_match returns the game already made with a key without comparing anything else, so a key carried over to a
 * changed request (another time, note, level range, number of players…) would silently answer with the old game.
 *
 * - The same arguments again (a retry after a lost answer, or the form changed and then changed back) → the same
 *   key, so that game is posted once.
 * - Any argument changed → a new key, so the new request is posted as itself.
 * - After a refusal nothing was posted: the request's key is forgotten, and the next try gets a new one.
 */
export type RequestTokens = Map<string, string>;

export const requestKey = (request: Record<string, unknown>) =>
  JSON.stringify(Object.keys(request).sort().map((k) => [k, request[k] === undefined ? null : request[k]]));

export function tokenForRequest(tokens: RequestTokens, request: Record<string, unknown>, make: () => string = () => crypto.randomUUID()): string {
  const key = requestKey(request);
  let token = tokens.get(key);
  if (!token) { token = make(); tokens.set(key, token); }
  return token;
}

export function forgetRequest(tokens: RequestTokens, request: Record<string, unknown>): void {
  tokens.delete(requestKey(request));
}
