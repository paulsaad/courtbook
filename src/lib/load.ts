/**
 * Failed reads must never look like "nothing here" (website completion W1, audit B2).
 *
 * A Supabase read that fails comes back as `{ data: null, error }`; read as `data ?? []` it becomes an empty list,
 * "not found" or $0 — a screen asserting something the system does not know. These helpers leave every read as it
 * is and only look at its result: an error is thrown, and the app's error page says the page could not be loaded.
 *
 * One exception: `.single()` reports "no row" as error PGRST116. That is a successful read that found nothing, so it
 * is returned as `data: null` and the page can show its normal "not found". The same code also means "more than one
 * row" (and `.maybeSingle()` uses it only for that), which is a data problem, not "not found": only a PGRST116 whose
 * details state exactly 0 rows counts as empty; several rows, or wording we do not recognise, is a failed read.
 * Wording checked on staging (PostgREST: "The result contains 0 rows" / "… 8 rows") and in postgrest-js 2.119
 * (`.maybeSingle()`: "Results contain 2 rows, …").
 */

type Result = { data?: unknown; error: unknown; count?: number | null };

/** Thrown when a page's data could not be read. The message names what, never the database's own text. */
export class LoadError extends Error {
  constructor(what: string, cause: unknown) {
    super(`Couldn't load ${what}`);
    this.name = "LoadError";
    this.cause = cause;
  }
}

const NO_ROW = "PGRST116";
const ROW_COUNT = /^(?:The result contains|Results contain) (\d+) rows?\b/;

/** True only for "the single-row read found no row" — never for several rows or an unknown message. */
export function isConfirmedNoRow(err: { code?: unknown; details?: unknown } | null | undefined): boolean {
  if (!err || err.code !== NO_ROW || typeof err.details !== "string") return false;
  const m = ROW_COUNT.exec(err.details);
  return !!m && Number(m[1]) === 0;
}

function check<R extends Result>(res: R, what: string): R {
  const err = res.error as { code?: string; details?: string } | null | undefined;
  if (!err) return res;
  if (isConfirmedNoRow(err)) return { ...res, data: null, error: null };
  throw new LoadError(what, err);
}

/** One read: returned unchanged when it succeeded; throws when it failed. */
export function loaded<R extends Result>(res: R, what: string): R {
  return check(res, what);
}

const isResult = (r: unknown): r is Result => typeof r === "object" && r !== null && "error" in r;

/** Several reads (a Promise.all result): returned unchanged when all succeeded; throws on the first failure.
 *  Entries that are not Supabase results (values from shared loaders) are passed through untouched. */
export function allLoaded<T extends readonly unknown[]>(results: T, what: string): T {
  return results.map((r) => (isResult(r) ? check(r, what) : r)) as unknown as T;
}
