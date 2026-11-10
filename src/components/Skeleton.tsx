/** Grey placeholder blocks shown by Next.js loading.tsx while a page's data loads. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-slate-soft ${className}`} />;
}
export function CardSkeletons({ n = 3 }: { n?: number }) {
  return <div className="flex flex-col gap-3">{Array.from({ length: n }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>;
}
