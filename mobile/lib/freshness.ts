/**
 * What the availability screen may say about how fresh its times are.
 *
 * `lastSuccessAt` must be the time of the last SUCCESSFUL fetch (React Query's dataUpdatedAt,
 * which a failed refetch does not move). The words never claim more than that: a time shown as
 * free was free when it was read, and only the server decides at the moment of reserving.
 */
export type Freshness = { text: string; tone: "ok" | "stale" | "checking" | "failed" };

export function describeFreshness(o: {
  lastSuccessAt: number; // ms epoch, 0 = never loaded
  now: number;
  fetching: boolean;
  failedSinceSuccess: boolean;
}): Freshness {
  if (o.lastSuccessAt === 0) return { text: o.fetching ? "Checking times…" : "Times not loaded", tone: o.fetching ? "checking" : "failed" };
  const age = Math.max(0, o.now - o.lastSuccessAt);
  const when = clock(o.lastSuccessAt);
  if (o.failedSinceSuccess) return { text: `Couldn't refresh · times as of ${when}`, tone: "failed" };
  if (o.fetching) return { text: "Checking for changes…", tone: "checking" };
  if (age < 15_000) return { text: "Checked just now", tone: "ok" };
  if (age < 60_000) return { text: `Checked ${Math.round(age / 1000)} s ago`, tone: "ok" };
  if (age < 5 * 60_000) return { text: `Checked ${Math.floor(age / 60_000)} min ago`, tone: "ok" };
  return { text: `Times as of ${when} · pull to refresh`, tone: "stale" };
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
