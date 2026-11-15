import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { listPackages } from "@/server/services/packages";
import { SectionCard } from "@/components/warehouses/ui";
import { StatusBadge, formatDateTime } from "@/components/bookings/ui";

/**
 * Customer home: only the packages addressed to the customer's linked
 * record (PackageService force-scopes to actor.customerId).
 */
export default async function Page() {
  const actor = await requireActor();
  const { packages, meta } = actor.customerId
    ? await listPackages(actor, { page: 1, pageSize: 20 })
    : { packages: [], meta: { total: 0 } };
  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-[20px] font-bold text-ink">My packages</h1>
        <p className="text-[13px] text-faint">
          {meta.total} package{meta.total === 1 ? "" : "s"} addressed to you
        </p>
      </div>
      <SectionCard title="Packages">
        <div className="grid gap-2">
          {packages.map((pkg) => (
            <div
              key={pkg.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
            >
              <Link href={`/track/${pkg.trackingId}`} className="font-mono font-semibold text-brand">
                {pkg.trackingId}
              </Link>
              <span className="text-ink">
                {pkg.description} → {pkg.deliveryCity}, {pkg.deliveryDistrict} ·{" "}
                {formatDateTime(pkg.createdAt)}
              </span>
              <StatusBadge status={pkg.operationalStatus} />
            </div>
          ))}
          {packages.length === 0 ? (
            <p className="text-[13px] text-faint">
              No packages yet. When a sender books a delivery to your phone number, it appears
              here — you can also track any parcel publicly from the tracking page.
            </p>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}
