import type { ReactNode } from "react";

import { requireDashboardActor } from "@/lib/auth/page-guards";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { LocationTrackingPanel } from "@/components/tracking/LocationTrackingPanel";

export default async function Layout({ children }: { children: ReactNode }) {
  const actor = await requireDashboardActor(["RIDER"]);
  return (
    <DashboardShell actor={actor} title="Delivery Rider" dashboard="rider">
      <div className="grid gap-5">
        <LocationTrackingPanel variant="rider" />
        {children}
      </div>
    </DashboardShell>
  );
}
