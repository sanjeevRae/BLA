import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { getClientIp } from "@/lib/auth/client-ip";
import { NotFoundError } from "@/lib/errors";
import { getPublicTracking } from "@/server/services/packages";
import { TrackForm } from "@/components/tracking/TrackForm";
import { DetailedTrackGate } from "@/components/tracking/DetailedTrackGate";
import { formatDateTime } from "@/components/bookings/ui";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PackageTimeline, publicTrackingToSteps } from "@/components/ui/PackageTimeline";

/**
 * Public tracking result (docs/security-architecture.md §7): renders
 * ONLY the minimal projection from PackageService — status, public
 * milestone timeline, origin/destination city and destination
 * district. Receiver phone, full address and COD never reach this page.
 *
 * V3 Step 7 (presentation only; the service call, the
 * NotFoundError → notFound() behaviour and the per-IP limit are
 * unchanged). Recorded omissions, by design:
 * - NO expected-delivery element: the frozen payload carries no
 *   promised date, so the page shows none.
 * - NO projected future steps: the timeline renders the payload's
 *   recorded events only (see `publicTrackingToSteps`).
 */
export default async function Page({
  params,
}: {
  params: Promise<{ trackingId: string }>;
}) {
  const { trackingId } = await params;
  const ipAddress = getClientIp(await headers());
  let tracking;
  try {
    tracking = await getPublicTracking(decodeURIComponent(trackingId).toUpperCase(), {
      ipAddress,
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const steps = publicTrackingToSteps(tracking);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[620px] flex-col px-4 py-8 sm:px-5 sm:py-10">
      <Link href="/track" className="text-meta font-semibold text-primary">
        ← Track another parcel
      </Link>

      <section className="mt-4 rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="whitespace-nowrap font-mono text-[22px] font-semibold text-ink">
            {tracking.trackingId}
          </h1>
          <StatusBadge domain="operational" status={tracking.status} />
        </div>
        <p className="mt-3 text-body text-ink">
          {tracking.originCity} → {tracking.destinationCity} ({tracking.destinationDistrict})
        </p>
        <p className="mt-2 flex flex-col gap-1 text-meta text-ink-2">
          <span>
            Booked{" "}
            <time dateTime={tracking.bookedAt} className="whitespace-nowrap tabular-nums">
              {formatDateTime(tracking.bookedAt)}
            </time>
          </span>
          <span>
            Last update{" "}
            <time dateTime={tracking.lastUpdateAt} className="whitespace-nowrap tabular-nums">
              {formatDateTime(tracking.lastUpdateAt)}
            </time>
          </span>
        </p>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="text-section-title font-semibold text-ink">
          Progress — {tracking.statusLabel}
        </h2>
        {steps.length > 0 ? (
          <div className="mt-4">
            <PackageTimeline steps={steps} ariaLabel="Parcel progress" />
          </div>
        ) : (
          <p className="mt-4 text-body text-ink-2">No events recorded yet.</p>
        )}
      </section>

      <DetailedTrackGate trackingId={tracking.trackingId} />

      <section className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="text-card-title font-semibold text-ink">Look up another parcel</h2>
        <div className="mt-3">
          <TrackForm initialValue={tracking.trackingId} />
        </div>
      </section>
    </main>
  );
}
