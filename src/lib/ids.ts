/**
 * Record ids in page addresses are UUIDs. A malformed one (a link cut short when shared, a typo) cannot
 * name anything, so the page is "Not found" — not a failed read ("Couldn't load this page… check your
 * connection"), which is what the database's invalid-UUID refusal turned into, and not an error report.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | undefined | null): s is string => !!s && UUID.test(s);
