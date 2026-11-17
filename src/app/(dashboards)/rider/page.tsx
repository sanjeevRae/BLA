import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { RiderFieldHome } from "@/components/deliveries/rider-field-home";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";

export default async function Page() {
  const actor = await requireActor();
  return (
    <div className="grid gap-5">
      {/* V3 Step 6: the rider field home (composed read model —
          summary, failed attempts, per-batch job cards, COD position,
          custody, tasks). The Reports link below is unchanged. The
          Location Tracking panel is mounted by the rider layout. */}
      <RiderFieldHome actor={actor} />
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
