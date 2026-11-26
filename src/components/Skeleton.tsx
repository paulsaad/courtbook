/**
 * Grey placeholder blocks shown by Next.js loading.tsx while a page's data loads.
 *
 * Local pilot build, 26 Nov: while a page loaded, a screen reader found an empty page (the blocks carry
 * no text) and the blocks kept pulsing for people who ask their phone for reduced motion. The blocks are
 * now hidden from screen readers, which hear "Loading…" instead (LoadingStatus), and pulse only when
 * motion is welcome.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`motion-safe:animate-pulse rounded-xl bg-slate-soft ${className}`} />;
}
export function CardSkeletons({ n = 3 }: { n?: number }) {
  return <div className="flex flex-col gap-3" aria-hidden="true">{Array.from({ length: n }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>;
}
/** Said once by screen readers while the page loads (a polite status message). */
export function LoadingStatus() {
  return <p role="status" className="sr-only">Loading…</p>;
}
