import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SectionCard } from "@/components/warehouses/ui";
import { LoadScanForm, TripProgressForms } from "@/components/transfers/forms";
import { DriverTripIncidentForm } from "@/components/operations/forms";
import { getDriver } from "@/server/services/drivers";
import { getTransfer, type TransferView } from "@/server/services/transfers";
import { getMyActiveTrip, listTrips, type TripView } from "@/server/services/trips";

/**
 * Phase 6 (V2) line-haul driver home — mobile-first, single column.
 *
 * The current trip is the centrepiece: route, manifest summary,
 * status, and the actions that are valid for the trip's CURRENT
 * state, surfaced on the home itself. The actions are the existing
 * flow components (LoadScanForm / TripProgressForms from the
 * transfers module) — nothing is re-implemented here. Receiving,
 * unloading scans and trip completion belong to the destination
 * warehouse's reconciliation flow, so at ARRIVED the home says so
 * instead of faking a driver-side completion button.
 *
 * The Location Tracking panel lives in the transport-driver
 * layout (Phase 4) above this page — nothing here duplicates or
 * contradicts its controls.
 */

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TripActions({
  actor,
  trip,
  transfer,
}: {
  actor: ActorContext;
  trip: TripView;
  transfer: TransferView | null;
}) {
  const status = trip.status;

  // Loading: the assigned driver may load-scan their own transfer
  // (service-enforced, transfers.assertLoadScope) once the origin
  // warehouse has marked it READY_FOR_DISPATCH with a manifest.
  if (status === "ASSIGNED" || status === "LOADING") {
    const canScan =
      transfer !== null &&
      transfer.status === "READY_FOR_DISPATCH" &&
      transfer.manifest !== null &&
      hasPermission(actor, "transfer.load");
    return (
      <div className="flex flex-col gap-3">
        <h3 className="text-[14px] font-semibold text-ink">Scan loading</h3>
        {canScan ? (
          <>
            <p className="text-[13px] text-slate2">
              Loaded {transfer.reconciliation.loadedCount} of{" "}
              {transfer.reconciliation.totalItems} packages. Scan each package as it goes on
              the vehicle — dispatch is blocked until every manifested package is loaded.
            </p>
            <LoadScanForm transferId={transfer.id} />
          </>
        ) : (
          <p className="text-[14px] text-ink">
            Loading opens when the origin warehouse marks this transfer ready for dispatch
            with its manifest generated.
          </p>
        )}
      </div>
    );
  }

  // Moving: departure, arrival, checkpoints, delay/breakdown and
  // resume all live in the existing trip-progress forms, which
  // gate their own controls by the same status.
  if (status === "DISPATCHED" || status === "IN_TRANSIT" || status === "DELAYED") {
    return (
      <div className="flex flex-col gap-3">
        <h3 className="text-[14px] font-semibold text-ink">
          {status === "DISPATCHED" ? "Confirm departure" : "Trip progress"}
        </h3>
        {status === "IN_TRANSIT" ? (
          <p className="text-[13px] text-slate2">
            Report a breakdown with the delay form below — it lands on the trip timeline
            dispatch watches, with your reason recorded.
          </p>
        ) : null}
        <TripProgressForms tripId={trip.id} status={status} />
      </div>
    );
  }

  // Arrived: unloading + handover scans are the destination team's
  // receiving flow; the trip completes when that reconciliation
  // closes. There is no driver-side completion action to offer.
  if (status === "ARRIVED" || status === "UNLOADING") {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-[14px] font-semibold text-ink">Unloading &amp; handover</h3>
        <p className="text-[14px] text-ink">
          Hand the packages over at {trip.destinationWarehouseCode}. The destination warehouse
          team scans them in — this trip completes automatically when their receiving is
          reconciled and closed.
          {transfer
            ? ` Received so far: ${transfer.reconciliation.receivedCount} of ${transfer.reconciliation.totalItems}.`
            : ""}
        </p>
      </div>
    );
  }

  if (status === "INCIDENT") {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-[14px] font-semibold text-ink">Incident reported</h3>
        <p className="text-[14px] text-ink">
          This trip is flagged with an incident. Dispatch has the record — keep the packages
          secure and follow their instructions before moving on.
        </p>
      </div>
    );
  }

  return null;
}

export async function LinehaulHomePage({ actor }: { actor: ActorContext }) {
  const profile = actor.driverId ? await getDriver(actor, actor.driverId).catch(() => null) : null;
  const activeTrip = await getMyActiveTrip(actor);
  const transfer = activeTrip
    ? await getTransfer(actor, activeTrip.transferId).catch(() => null)
    : null;
  const { items: history } = await listTrips(actor, { mine: true, pageSize: 10 });
  const recentCompleted = history
    .filter((t) => (t.status === "COMPLETED" || t.status === "CANCELLED") && t.id !== activeTrip?.id)
    .slice(0, 5);

  const loadedCount =
    transfer?.reconciliation.loadedCount ??
    (activeTrip
      ? activeTrip.packages.filter((p) =>
          ["LOADED", "IN_TRANSIT", "RECEIVED"].includes(p.itemStatus),
        ).length
      : 0);
  const expectedCount = transfer?.manifest?.packageCount ?? activeTrip?.packageCount ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Line-haul Driver
        </div>
        <h1 className="mt-0.5 text-[22px] font-bold text-ink">Welcome, {actor.fullName}</h1>
      </div>

      <SectionCard title="Your driver profile">
        {profile ? (
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <dt className="text-slate2">Home warehouse</dt>
              <dd className="font-medium text-ink">{profile.homeWarehouseCode}</dd>
            </div>
            <div>
              <dt className="text-slate2">Licence</dt>
              <dd className="font-medium text-ink">
                {profile.licenseNumber} · expires {profile.licenseExpiry}
                {profile.licenseExpired ? " (EXPIRED)" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-slate2">Employment</dt>
              <dd className="font-medium text-ink">{profile.employmentStatus}</dd>
            </div>
            <div>
              <dt className="text-slate2">Availability</dt>
              <dd className="font-medium text-ink">{profile.availabilityStatus}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-[14px] text-ink">
            No driver profile is linked to your account yet. Ask an Admin to create one before
            you can be assigned a trip.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Current trip">
        {activeTrip ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[16px] font-bold text-ink">
                {activeTrip.originWarehouseCode} → {activeTrip.destinationWarehouseCode}
              </span>
              <StatusBadge domain="generic" status={activeTrip.status} />
            </div>
            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              <div>
                <dt className="text-slate2">Trip</dt>
                <dd className="font-mono font-semibold text-ink">{activeTrip.tripNumber}</dd>
              </div>
              <div>
                <dt className="text-slate2">Transfer code</dt>
                <dd className="font-mono font-semibold text-ink">{activeTrip.transferNumber}</dd>
              </div>
              <div>
                <dt className="text-slate2">Manifest</dt>
                <dd className="font-mono font-semibold text-ink">
                  {transfer?.manifest?.manifestCode ?? "Not generated yet"}
                </dd>
              </div>
              <div>
                <dt className="text-slate2">Vehicle</dt>
                <dd className="font-semibold text-ink">{activeTrip.vehicleRegistration}</dd>
              </div>
              <div>
                <dt className="text-slate2">Packages loaded / expected</dt>
                <dd className="tnum font-semibold text-ink">
                  {loadedCount} / {expectedCount}
                </dd>
              </div>
              <div>
                <dt className="text-slate2">Expected arrival</dt>
                <dd className="font-semibold text-ink">{fmtDate(activeTrip.expectedArrivalAt)}</dd>
              </div>
              <div>
                <dt className="text-slate2">Departed</dt>
                <dd className="font-semibold text-ink">{fmtDate(activeTrip.actualDepartureAt)}</dd>
              </div>
              <div>
                <dt className="text-slate2">Arrived</dt>
                <dd className="font-semibold text-ink">{fmtDate(activeTrip.actualArrivalAt)}</dd>
              </div>
            </dl>

            {activeTrip.packages.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {activeTrip.packages.map((p) => (
                  <li
                    key={p.packageId}
                    className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
                  >
                    <span className="font-mono text-[14px] font-semibold text-ink">
                      {p.trackingId}
                    </span>
                    <StatusBadge domain="generic" status={p.itemStatus} />
                    <span className="text-[13px] text-slate2">{p.packageStatus}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {activeTrip.stops.length > 0 ? (
              <ol className="flex flex-col gap-1 text-[13px] text-slate2">
                {activeTrip.stops.map((s) => (
                  <li key={s.id}>
                    {s.sequence}. {s.label} — {fmtDate(s.passedAt)} ({s.recordedByName})
                    {s.notes ? ` · ${s.notes}` : ""}
                  </li>
                ))}
              </ol>
            ) : null}

            <TripActions actor={actor} trip={activeTrip} transfer={transfer} />

            {hasPermission(actor, "incident.report") ? (
              <div className="border-t border-line pt-3">
                <DriverTripIncidentForm
                  tripId={activeTrip.id}
                  packages={activeTrip.packages.map((p) => ({
                    packageId: p.packageId,
                    trackingId: p.trackingId,
                  }))}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-[14px] text-ink">
            You have no active trip right now. When a warehouse assigns you to a transfer, the
            trip, its manifest and its actions appear here.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Recent completed trips">
        {recentCompleted.length === 0 ? (
          <p className="text-[14px] text-ink">No completed trips yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentCompleted.map((t) => (
              <li
                key={t.id}
                className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <span className="font-mono text-[14px] font-semibold text-ink">{t.tripNumber}</span>
                <span className="text-[14px] text-ink">
                  {t.originWarehouseCode} → {t.destinationWarehouseCode}
                </span>
                <StatusBadge domain="generic" status={t.status} />
                <span className="text-[13px] text-slate2">
                  {t.packageCount} package(s) · departed {fmtDate(t.actualDepartureAt)} · arrived{" "}
                  {fmtDate(t.actualArrivalAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
