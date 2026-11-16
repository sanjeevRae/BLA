import { Skeleton, SkeletonRows } from "@/components/ui/states";

/**
 * Dashboard loading state (V2 Phase 1): a neutral skeleton inside
 * the shell while a dashboard page's data loads — no spinner-only
 * blank screens.
 */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      <div className="mt-6 rounded-lg border border-line bg-surface p-4">
        <SkeletonRows rows={5} />
      </div>
    </div>
  );
}
