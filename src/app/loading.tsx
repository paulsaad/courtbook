import { CardSkeletons, Skeleton, LoadingStatus } from "@/components/Skeleton";
export default function Loading() {
  return (
    <main className="mx-auto flex max-w-md md:max-w-2xl lg:max-w-3xl flex-col gap-5 p-5">
      <LoadingStatus />
      <Skeleton className="h-8 w-32" />
      <div className="flex gap-2"><Skeleton className="h-10 w-28 rounded-full" /><Skeleton className="h-10 w-24 rounded-full" /></div>
      <CardSkeletons />
    </main>
  );
}
