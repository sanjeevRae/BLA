import type { ReactNode } from "react";

import { requireDashboardActor } from "@/lib/auth/page-guards";
import { DashboardShell } from "@/components/layout/DashboardShell";

export default async function Layout({ children }: { children: ReactNode }) {
  const actor = await requireDashboardActor(["LINEHAUL_DRIVER"]);
  return (
    <DashboardShell actor={actor} title="Line-haul Driver">
      {children}
    </DashboardShell>
  );
}
