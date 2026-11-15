import Link from "next/link";
import { notFound } from "next/navigation";

import { NotFoundError } from "@/lib/errors";
import { getPublicTracking } from "@/server/services/packages";
import { TrackForm } from "@/components/tracking/TrackForm";
import { StatusBadge, formatDateTime } from "@/components/bookings/ui";

/**
 * Public tracking result (docs/security-architecture.md §7): renders
 * ONLY the minimal projection from PackageService — status, public
 * milestone timeline, origin/destination city and destination
 * district. Receiver phone, full address and COD never reach this page.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ trackingId: string }>;
}) {
  const { trackingId } = await params;
  let tracking;
  try {
    tracking = await getPublicTracking(decodeURIComponent(trackingId).toUpperCase());
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-[560px] flex-col px-5 py-10">
      <Link href="/track" className="text-[12px] font-semibold text-brand">
        ← Track another parcel
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-[22px] font-bold text-ink">{tracking.trackingId}</h1>
        <StatusBadge status={tracking.status} />
      </div>
      <p className="mt-2 text-[13px] text-slate2">
        {tracking.originCity} → {tracking.destinationCity} ({tracking.destinationDistrict}) ·
        Booked {formatDateTime(tracking.bookedAt)} · Last update {formatDateTime(tracking.lastUpdateAt)}
      </p>

      <section className="mt-6 rounded-lg border border-line bg-surface p-5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Progress — {tracking.statusLabel}
        </h2>
        <ol className="mt-4 grid gap-0">
          {tracking.timeline.map((event, index) => (
            <li key={index} className="relative flex gap-3 pb-4 last:pb-0">
              <span
                className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                  index === tracking.timeline.length - 1 ? "bg-brand" : "bg-line"
                }`}
              />
              <span className="text-[13px]">
                <span className="font-semibold text-ink">{event.label}</span>{" "}
                <span className="text-faint">· {formatDateTime(event.occurredAt)}</span>
              </span>
            </li>
          ))}
          {tracking.timeline.length === 0 ? (
            <li className="text-[13px] text-faint">No events recorded yet.</li>
          ) : null}
        </ol>
      </section>

      <div className="mt-6">
        <TrackForm initialValue={tracking.trackingId} />
      </div>
    </main>
  );
}
