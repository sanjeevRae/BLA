import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { PageHeader } from "@/components/ui/PageHeader";
import { PriorityBadge, StatusBadge } from "@/components/ui/StatusBadge";
import { ToneIcon } from "@/components/ui/ToneIcon";
import { SectionCard } from "@/components/warehouses/ui";
import { LoadScanForm, TripProgressForms } from "@/components/transfers/forms";
import { DriverTripIncidentForm } from "@/components/operations/forms";
import {
  getLinehaulFieldHome,
  type LinehaulFieldHomeData,
} from "@/server/services/home-dashboards";
import { getTransfer, type TransferView } from "@/server/services/transfers";
import { getMyActiveTrip, type TripView } from "@/server/services/trips";

/**
 * Line-haul driver field home (V3 Step 6) — mobile-first, single
 * column, built on the `getLinehaulFieldHome` read model.
 *
 * The current trip LEADS: route, manifest summary, recorded
 * milestones and the actions valid for the trip's CURRENT state.
 * Progress is recorded milestones ONLY — loaded count, the actual
 * departure, recorded checkpoints and the actual arrival. No
 * planned or expected time is rendered anywhere on this home.
 *
 * The actions are the existing flow components (LoadScanForm /
 * TripProgressForms from the transfers module, DriverTripIncidentForm
 * from operations) — nothing is re-implemented here. They keep their
 * existing props, fed from the RAW trip/transfer views fetched
 * exactly as before (getMyActiveTrip + getTransfer); the read model
 * drives the display, the raw views drive the actions. Receiving,
 * unloading scans and trip completion belong to the destination
 * warehouse's reconciliation flow, so at ARRIVED the home says so
 * instead of faking a driver-side completion button.
 *
 * The Location Tracking panel lives in the transport-driver layout
 * above this page — nothing here duplicates or contradicts it.
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

type MilestoneState = "done" | "current" | "future";

interface Milestone {
  key: string;
  title: string;
  detail: string;
  state: MilestoneState;
}

const MILESTONE_MARKER: Record<MilestoneState, string> = {
  done: "bg-successbg text-success",
  current: "bg-primary text-white",
  future: "bg-neutralbg text-neutral",
};

/**
 * The recorded-milestone list for the current trip. Every entry is a
 * fact that has been recorded (load count, actual departure, passed
 * checkpoints, actual arrival) or an honest "not yet" — never a
 * planned or expected time, never a percentage.
 */
function buildMilestones(
  trip: NonNullable<LinehaulFieldHomeData["activeTrip"]>,
): Milestone[] {
  const loadedDone = trip.expectedCount > 0 && trip.loadedCount >= trip.expectedCount;
  const departed = trip.departedAt !== null;
  const arrived = trip.arrivedAt !== null;

  const milestones: Milestone[] = [
    {
      key: "loaded",
      title: `Loaded ${trip.loadedCount} of ${trip.expectedCount} packages`,
      detail: loadedDone ? "Loading complete" : "Loading in progress",
      state: loadedDone ? "done" : "current",
    },
    {
      key: "departed",
      title: "Departed",
      detail: departed ? fmtDate(trip.departedAt) : "Not departed yet",
      state: departed ? "done" : loadedDone ? "current" : "future",
    },
  ];

  for (const stop of trip.stops) {
    if (!stop.passedAt) continue;
    milestones.push({
      key: `stop-${stop.id}`,
      title: `Checkpoint · ${stop.label}`,
      detail: `${fmtDate(stop.passedAt)} · recorded by ${stop.recordedByName}`,
      state: "done",
    });
  }

  milestones.push({
    key: "arrived",
    title: `Arrived at ${trip.destinationWarehouseCode}`,
    detail: arrived ? fmtDate(trip.arrivedAt) : "Not arrived yet",
    state: arrived ? "done" : departed ? "current" : "future",
  });

  return milestones;
}

function MilestoneList({ milestones }: { milestones: Milestone[] }) {
  return (
    <ol className="flex flex-col" data-testid="trip-milestones">
      {milestones.map((milestone, index) => (
        <li key={milestone.key} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              aria-hidden="true"
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${MILESTONE_MARKER[milestone.state]}`}
            >
              {milestone.state === "done" ? (
                <ToneIcon tone="success" />
              ) : milestone.state === "current" ? (
                <span className="h-2 w-2 rounded-full bg-white" />
              ) : (
                <ToneIcon tone="neutral" />
              )}
            </span>
            {index < milestones.length - 1 ? (
              <span aria-hidden="true" className="w-px flex-1 bg-border" />
            ) : null}
          </div>
          <div className={index < milestones.length - 1 ? "pb-4" : ""}>
            <p className="text-[16px] font-medium leading-snug text-ink">{milestone.title}</p>
            <p className="text-[13px] text-ink-2">{milestone.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export async function LinehaulHomePage({ actor }: { actor: ActorContext }) {
  const data = await getLinehaulFieldHome(actor);
  // Raw views for the action flows, fetched exactly as before the
  // read model existed — TripActions keeps its existing props.
  const rawTrip = await getMyActiveTrip(actor);
  const transfer = rawTrip
    ? await getTransfer(actor, rawTrip.transferId).catch(() => null)
    : null;

  const trip = data.activeTrip;
  const profile = data.profile;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Line-haul Driver" title={`Welcome, ${data.driverName}`} />

      <SectionCard title="Current trip">
        {trip ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[20px] font-semibold text-ink">
                {trip.originWarehouseCode} → {trip.destinationWarehouseCode}
              </span>
              <StatusBadge domain="generic" status={trip.status} />
            </div>

            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              <div>
                <dt className="text-slate2">Trip</dt>
                <dd className="font-mono text-[16px] font-semibold text-ink">
                  {trip.tripNumber}
                </dd>
              </div>
              <div>
                <dt className="text-slate2">Transfer</dt>
                <dd className="font-mono text-[16px] font-semibold text-ink">
                  {trip.transferNumber}
                </dd>
              </div>
              <div>
                <dt className="text-slate2">Manifest</dt>
                <dd className="font-mono text-[16px] font-semibold text-ink">
                  {trip.manifestCode ?? "Not generated yet"}
                </dd>
              </div>
              <div>
                <dt className="text-slate2">Vehicle</dt>
                <dd className="text-[16px] font-semibold text-ink">
                  {trip.vehicleRegistration}
                </dd>
              </div>
              <div>
                <dt className="text-slate2">Packages loaded</dt>
                <dd className="tnum text-[16px] font-semibold text-ink">
                  {trip.loadedCount} / {trip.expectedCount}
                </dd>
              </div>
            </dl>

            <MilestoneList milestones={buildMilestones(trip)} />

            {trip.loadByStatus.length > 0 || trip.packages.length > 0 ? (
              <div className="flex flex-col gap-2">
                <h3 className="text-[14px] font-semibold text-ink">Load summary</h3>
                {trip.loadByStatus.length > 0 ? (
                  <ul className="flex flex-wrap gap-2">
                    {trip.loadByStatus.map((row) => (
                      <li
                        key={row.status}
                        className="inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
                      >
                        <StatusBadge domain="generic" status={row.status} />
                        <span className="tnum text-[14px] text-ink">
                          {row.count} package(s)
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {trip.packages.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {trip.packages.map((p) => (
                      <li
                        key={p.packageId}
                        className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
                      >
                        <span className="font-mono text-[14px] font-semibold text-ink">
                          {p.trackingId}
                        </span>
                        <StatusBadge domain="generic" status={p.itemStatus} />
                        <StatusBadge domain="operational" status={p.packageStatus} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {trip.stops.length > 0 ? (
              <ol className="flex flex-col gap-1 text-[13px] text-slate2">
                {trip.stops.map((s) => (
                  <li key={s.id}>
                    {s.sequence}. {s.label} — {fmtDate(s.passedAt)} ({s.recordedByName})
                    {s.notes ? ` · ${s.notes}` : ""}
                  </li>
                ))}
              </ol>
            ) : null}

            {rawTrip ? (
              <TripActions actor={actor} trip={rawTrip} transfer={transfer} />
            ) : null}

            {hasPermission(actor, "incident.report") ? (
              <div className="border-t border-line pt-3">
                <DriverTripIncidentForm
                  tripId={trip.id}
                  packages={trip.packages.map((p) => ({
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

      {data.destination ? (
        <SectionCard title="Destination warehouse">
          <div className="flex flex-col gap-1">
            <p className="text-[16px] font-semibold text-ink">
              {data.destination.name}{" "}
              <span className="font-mono text-[13px] font-semibold text-ink-2">
                {data.destination.code}
              </span>
            </p>
            <p className="text-[14px] text-ink">
              {data.destination.city} · {data.destination.district}
            </p>
            {data.destination.addressLine1 ? (
              <p className="text-[14px] text-ink-2">{data.destination.addressLine1}</p>
            ) : null}
            {data.destination.addressLine2 ? (
              <p className="text-[14px] text-ink-2">{data.destination.addressLine2}</p>
            ) : null}
            {data.destination.contactPhone ? (
              <a
                href={`tel:${data.destination.contactPhone}`}
                className="mt-2 inline-flex min-h-[48px] items-center justify-center rounded-lg bg-primary px-4 py-2 text-[16px] font-semibold text-white hover:bg-primary-dark"
              >
                Call {data.destination.contactPhone}
              </a>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      {data.openTaskCount > 0 ? (
        <SectionCard title="My tasks">
          <div className="flex flex-col gap-2">
            <ul className="flex flex-col gap-2">
              {data.tasks.map((task) => (
                <li key={task.id}>
                  <Link
                    href={`/transport-driver/tasks/${task.id}`}
                    className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 text-[16px] font-medium text-ink">
                      {task.title}
                    </span>
                    <PriorityBadge priority={task.priority} />
                    <StatusBadge domain="generic" status={task.status} />
                    {task.overdue ? (
                      <span className="text-[13px] font-semibold text-danger">Overdue</span>
                    ) : (
                      <span className="text-[13px] text-ink-2">
                        {task.dueAt ? `Due ${fmtDate(task.dueAt)}` : "No due date"}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
            <Link
              href="/transport-driver/tasks"
              className="inline-flex min-h-[48px] items-center text-[14px] font-semibold text-primary hover:text-primary-dark"
            >
              All my tasks →
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {data.recentActivity.length > 0 ? (
        <SectionCard title="Recent activity">
          <ul className="flex flex-col gap-2">
            {data.recentActivity.map((item, index) => (
              <li
                key={`${item.at}-${index}`}
                className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <span className="min-w-0 flex-1 text-[14px] text-ink">{item.label}</span>
                <span className="text-[13px] text-ink-2">{fmtDate(item.at)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="Recent completed trips">
        {data.recentTrips.length === 0 ? (
          <p className="text-[14px] text-ink">No completed trips yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.recentTrips.map((t) => (
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
                  {t.packageCount} package(s) · departed {fmtDate(t.departedAt)} · arrived{" "}
                  {fmtDate(t.arrivedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

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
    </div>
  );
}
