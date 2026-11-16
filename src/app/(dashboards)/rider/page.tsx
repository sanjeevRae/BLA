import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { RiderHomePage } from "@/components/deliveries/pages";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";

export default async function Page() {
  const actor = await requireActor();
  return (
    <div className="grid gap-5">
      {/* The COD position card lives inside RiderHomePage (Phase 6
          mobile home); this page only adds the Reports link. The
          Location Tracking panel is mounted by the rider layout. */}
      <RiderHomePage actor={actor} />
      <SectionCard title="Reports">
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-slate2">
            Your delivery performance and COD figures for any period.
          </p>
          <div>
            <Link href="/rider/reports" className={subtleButtonClass}>
              Your performance →
            </Link>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
