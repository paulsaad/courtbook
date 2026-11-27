/**
 * Record ids in page addresses are UUIDs. A malformed one (a link cut short when shared, a typo) cannot
 * name anything. The database refuses it with 22P02 (invalid_text_representation), which a page read
 * turned into "Couldn't load this page … check your connection" and a server error report. A page reading
 * a record by the id in its address treats exactly that refusal as "Not found".
 */
export function isMalformedId(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === "22P02";
}
