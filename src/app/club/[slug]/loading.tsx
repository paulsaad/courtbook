import { Skeleton } from "@/components/Skeleton";
export default function Loading() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-3 px-4 pt-4">
      <Skeleton className="h-4 w-16" /><Skeleton className="h-8 w-56" /><Skeleton className="h-4 w-72" />
      <Skeleton className="h-10 rounded-full" />
      <div className="flex gap-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 w-12 rounded-2xl" />)}</div>
      <Skeleton className="mt-2 h-96 rounded-lg" />
    </main>
  );
}
