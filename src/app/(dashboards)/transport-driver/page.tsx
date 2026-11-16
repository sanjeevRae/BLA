import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { LinehaulHomePage } from "@/components/trips/linehaul-home";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";

export default async function Page() {
  const actor = await requireActor();
  return (
    <div className="grid gap-5">
      {/* Current-trip home (Phase 6 mobile redesign). The Location
          Tracking panel is mounted by the transport-driver layout. */}
      <LinehaulHomePage actor={actor} />
      <SectionCard title="Reports">
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-slate2">
            Your trip history and performance for any period.
          </p>
          <div>
            <Link href="/transport-driver/reports" className={subtleButtonClass}>
              Your performance →
            </Link>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
