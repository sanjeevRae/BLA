import Link from "next/link";

import { EmptyState } from "@/components/ui/states";

/**
 * Dashboard not-found state (V2 Phase 1): an unknown or mistyped
 * dashboard URL lands here inside the shell instead of a bare 404.
 */
export default function DashboardNotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="This address does not match any page in your dashboard. It may have been moved, or the link may be mistyped."
      action={
        <Link
          href="/go"
          className="flex min-h-[44px] items-center rounded-md bg-brand px-4 text-[13px] font-semibold text-white hover:opacity-90"
        >
          Back to my dashboard
        </Link>
      }
    />
  );
}
