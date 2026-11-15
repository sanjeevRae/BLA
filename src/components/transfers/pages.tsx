import Link from "next/link";

import type { ActorContext } from "@/lib/auth/actor";
import { hasPermission } from "@/lib/auth/actor";
import { formatPaisa } from "@/components/bookings/ui";
import { listWarehouses } from "@/server/services/warehouses";
import {
  getTransfer,
  listEligiblePackages,
  listTransfers,
  listTransferDestinations,
  type TransferView,
} from "@/server/services/transfers";
import { listAssignableDrivers } from "@/server/services/drivers";
import { listVehicles } from "@/server/services/vehicles";
import { getDriver } from "@/server/services/drivers";
import { getMyActiveTrip, getTrip, listTrips, type TripView } from "@/server/services/trips";
import { PrintButton } from "@/components/packages/PrintButton";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import {
  AddItemsForm,
  AssignCrewForm,
  CompleteReceivingForm,
  CreateTransferForm,
  DestinationScanForm,
  DispatchButton,
  GenerateManifestButton,
  LoadScanForm,
  ReceivingCloseButtons,
  RemoveItemButton,
  TransferLifecycleButtons,
  TripProgressForms,
  UnloadButton,
  type CrewDriverOption,
  type CrewVehicleOption,
  type WarehouseOption,
} from "@/components/transfers/forms";

/**
 * Phase 5 transfer screens (warehouse admin + staff dashboards, and
 * the line-haul driver dashboard). Every row comes from the services —
 * scoped inside their queries — never from client-supplied state.
 */

function PageHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        {eyebrow}
      </div>
      <h1 className="mt-0.5 text-[22px] font-bold text-ink">{title}</h1>
    </div>
  );
}

export function TransferStatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-block rounded-full border border-line bg-page px-2 py-0.5 text-[11px] font-semibold text-ink">
      {status}
    </span>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const RECEIVING_WINDOW = ["IN_TRANSIT", "ARRIVED", "PARTIALLY_RECEIVED", "RECEIVED", "RECONCILIATION_PENDING", "EXCEPTION"];

// ---------------------------------------------------------------------------
// Home panel
// ---------------------------------------------------------------------------

export async function TransfersHomePanel({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  if (!hasPermission(actor, "transfer.read_warehouse") && !hasPermission(actor, "transfer.read_all")) {
    return null;
  }
  const { items } = await listTransfers(actor, { pageSize: 100 });
  const open = items.filter((t) => !["CLOSED", "CANCELLED", "REJECTED"].includes(t.status));
  const inbound = items.filter((t) => RECEIVING_WINDOW.includes(t.status));
  return (
    <SectionCard title="Transfers">
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-slate2">
          {open.length} open transfer(s) · {inbound.length} in transit / arriving at your
          warehouse(s)
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href={`${basePath}/transfers`} className={subtleButtonClass}>
            Transfers →
          </Link>
          {hasPermission(actor, "transfer.create") ? (
            <Link href={`${basePath}/transfers/new`} className={subtleButtonClass}>
              New transfer →
            </Link>
          ) : null}
          <Link href={`${basePath}/arrivals`} className={subtleButtonClass}>
            Arrivals →
          </Link>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function TransferTable({
  items,
  basePath,
}: {
  items: TransferView[];
  basePath: string;
}) {
  if (items.length === 0) {
    return <p className="text-[13px] text-slate2">No transfers to show.</p>;
  }
  return (
    <div className="overflow-auto rounded-md border border-line">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-slate2">
            <th className="px-3 py-2">Transfer</th>
            <th className="px-3 py-2">Route</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Packages</th>
            <th className="px-3 py-2">Driver</th>
            <th className="px-3 py-2">Vehicle</th>
            <th className="px-3 py-2">Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id} className="border-b border-line last:border-0">
              <td className="px-3 py-2">
                <Link
                  href={`${basePath}/transfers/${t.id}`}
                  className="font-mono font-semibold text-ink underline"
                >
                  {t.transferNumber}
                </Link>
              </td>
              <td className="px-3 py-2">
                {t.originWarehouseCode} → {t.destinationWarehouseCode}
              </td>
              <td className="px-3 py-2">
                <TransferStatusBadge status={t.status} />
              </td>
              <td className="px-3 py-2">{t.items.length}</td>
              <td className="px-3 py-2">{t.driverName ?? "—"}</td>
              <td className="px-3 py-2">{t.vehicleRegistration ?? "—"}</td>
              <td className="px-3 py-2">{fmtDate(t.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function TransfersListPage({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const { items } = await listTransfers(actor, { pageSize: 50 });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-end justify-between">
        <PageHeader eyebrow="Operations" title="Transfers" />
        {hasPermission(actor, "transfer.create") ? (
          <Link href={`${basePath}/transfers/new`} className={subtleButtonClass}>
            New transfer
          </Link>
        ) : null}
      </div>
      <SectionCard title="All transfers in your scope">
        <TransferTable items={items} basePath={basePath} />
      </SectionCard>
    </div>
  );
}

export async function ArrivalsPage({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const { items } = await listTransfers(actor, { pageSize: 50 });
  const inbound = items.filter((t) => RECEIVING_WINDOW.includes(t.status));
  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Operations" title="Arrivals" />
      <SectionCard title="Transfers arriving at your warehouse(s)">
        <TransferTable items={inbound} basePath={basePath} />
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function TransferCreatePage({
  actor,
  basePath,
  originId,
}: {
  actor: ActorContext;
  basePath: string;
  originId?: string;
}) {
  const { items: warehouses } = await listWarehouses(actor, { pageSize: 100 });
  const origins: WarehouseOption[] = warehouses
    .filter((w) => w.status === "ACTIVE")
    .map((w) => ({ id: w.id, code: w.code, name: w.name }));

  if (!originId) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Operations" title="New transfer — choose origin" />
        <SectionCard title="Origin warehouse">
          {origins.length === 0 ? (
            <p className="text-[13px] text-slate2">No active warehouse in your scope.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {origins.map((o) => (
                <Link
                  key={o.id}
                  href={`${basePath}/transfers/new?origin=${o.id}`}
                  className={subtleButtonClass}
                >
                  {o.name} ({o.code}) →
                </Link>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    );
  }

  const origin = origins.find((o) => o.id === originId);
  if (!origin) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Operations" title="New transfer" />
        <SectionCard title="Origin warehouse">
          <p className="text-[13px] text-slate2">
            That warehouse is not in your scope.{" "}
            <Link href={`${basePath}/transfers/new`} className="underline">
              Choose again
            </Link>
            .
          </p>
        </SectionCard>
      </div>
    );
  }
  const destinations = await listTransferDestinations(actor, originId);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Operations" title="New transfer" />
      <SectionCard title="Transfer details">
        <CreateTransferForm
          origin={origin}
          destinations={destinations}
          basePath={basePath}
        />
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

async function TripPanel({ trip }: { trip: TripView }) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="text-slate2">Trip</dt>
          <dd className="font-mono font-semibold text-ink">{trip.tripNumber}</dd>
        </div>
        <div>
          <dt className="text-slate2">Status</dt>
          <dd>
            <TransferStatusBadge status={trip.status} />
          </dd>
        </div>
        <div>
          <dt className="text-slate2">Departed</dt>
          <dd className="text-ink">{fmtDate(trip.actualDepartureAt)}</dd>
        </div>
        <div>
          <dt className="text-slate2">Arrived</dt>
          <dd className="text-ink">{fmtDate(trip.actualArrivalAt)}</dd>
        </div>
      </dl>
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
      <TripProgressForms tripId={trip.id} status={trip.status} />
    </div>
  );
}

export async function TransferDetailPage({
  actor,
  basePath,
  transferId,
}: {
  actor: ActorContext;
  basePath: string;
  transferId: string;
}) {
  const transfer = await getTransfer(actor, transferId);
  const rec = transfer.reconciliation;
  const isOrigin = actor.warehouseIds.includes(transfer.originWarehouseId);
  const isDestination = actor.warehouseIds.includes(transfer.destinationWarehouseId);
  const unscoped = hasPermission(actor, "transfer.read_all");
  const editable = ["DRAFT", "PREPARING", "REQUESTED", "APPROVED", "REJECTED", "READY_FOR_DISPATCH"].includes(transfer.status);
  const manifested = transfer.manifest !== null;
  const preDispatch = !["DISPATCHED", "IN_TRANSIT", "ARRIVED", "PARTIALLY_RECEIVED", "RECEIVED", "RECONCILIATION_PENDING", "EXCEPTION", "RECONCILED", "CLOSED", "CANCELLED"].includes(transfer.status);

  let eligible: Awaited<ReturnType<typeof listEligiblePackages>> = [];
  if (editable && hasPermission(actor, "transfer.prepare") && (isOrigin || unscoped)) {
    try {
      eligible = await listEligiblePackages(
        actor,
        transfer.originWarehouseId,
        transfer.destinationWarehouseId,
      );
    } catch {
      eligible = [];
    }
  }

  let crewDrivers: CrewDriverOption[] = [];
  let crewVehicles: CrewVehicleOption[] = [];
  if (preDispatch && manifested && hasPermission(actor, "driver.assign")) {
    try {
      const assignable = await listAssignableDrivers(actor);
      crewDrivers = assignable.map((a) => ({
        driverId: a.driver.id,
        name: a.driver.fullName,
        blockers: a.blockers,
      }));
      const { items: vehicles } = await listVehicles(actor, { pageSize: 100 });
      crewVehicles = vehicles.map((v) => ({
        vehicleId: v.id,
        registration: v.registration,
        blockers: v.assignmentBlockers,
      }));
    } catch {
      crewDrivers = [];
      crewVehicles = [];
    }
  }

  let trip: TripView | null = null;
  if (transfer.tripId) {
    try {
      trip = await getTrip(actor, transfer.tripId);
    } catch {
      trip = null;
    }
  }

  const inReceiving = ["ARRIVED", "PARTIALLY_RECEIVED", "RECEIVED", "RECONCILIATION_PENDING", "EXCEPTION"].includes(transfer.status);
  const canActAtDestination = (isDestination || unscoped) && hasPermission(actor, "transfer.receive");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-end justify-between">
        <PageHeader
          eyebrow={`${transfer.originWarehouseCode} → ${transfer.destinationWarehouseCode}`}
          title={transfer.transferNumber}
        />
        <TransferStatusBadge status={transfer.status} />
      </div>

      <SectionCard title="Overview">
        <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
          <div>
            <dt className="text-slate2">Origin</dt>
            <dd className="font-medium text-ink">
              {transfer.originWarehouseName} ({transfer.originWarehouseCode})
            </dd>
          </div>
          <div>
            <dt className="text-slate2">Destination</dt>
            <dd className="font-medium text-ink">
              {transfer.destinationWarehouseName} ({transfer.destinationWarehouseCode})
            </dd>
          </div>
          <div>
            <dt className="text-slate2">Driver</dt>
            <dd className="font-medium text-ink">{transfer.driverName ?? "Not assigned"}</dd>
          </div>
          <div>
            <dt className="text-slate2">Vehicle</dt>
            <dd className="font-medium text-ink">{transfer.vehicleRegistration ?? "Not assigned"}</dd>
          </div>
          <div>
            <dt className="text-slate2">Expected arrival</dt>
            <dd className="font-medium text-ink">{fmtDate(transfer.expectedArrivalAt)}</dd>
          </div>
          <div>
            <dt className="text-slate2">Dispatched</dt>
            <dd className="font-medium text-ink">{fmtDate(transfer.dispatchedAt)}</dd>
          </div>
          <div>
            <dt className="text-slate2">Created by</dt>
            <dd className="font-medium text-ink">{transfer.createdByName}</dd>
          </div>
          <div>
            <dt className="text-slate2">Approved by</dt>
            <dd className="font-medium text-ink">{transfer.approvedByName ?? "—"}</dd>
          </div>
        </dl>
        {transfer.instructions ? (
          <p className="mt-3 text-[13px] text-slate2">Instructions: {transfer.instructions}</p>
        ) : null}
        <div className="mt-4">
          <TransferLifecycleButtons
            transferId={transfer.id}
            status={transfer.status}
            canCreate={hasPermission(actor, "transfer.create") && (isOrigin || unscoped)}
            canApprove={hasPermission(actor, "transfer.approve")}
          />
        </div>
      </SectionCard>

      <SectionCard title={`Packages (${transfer.items.length})`}>
        <div className="overflow-auto rounded-md border border-line">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-slate2">
                <th className="px-3 py-2">Tracking ID</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Package</th>
                <th className="px-3 py-2">Weight</th>
                <th className="px-3 py-2">COD</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {transfer.items.map((item) => (
                <tr key={item.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-mono">{item.trackingId}</td>
                  <td className="px-3 py-2">
                    {item.recipientName} · {item.deliveryDistrict}
                  </td>
                  <td className="px-3 py-2">{item.itemStatus}</td>
                  <td className="px-3 py-2">
                    {item.packageStatus}
                    {item.exceptionStatus !== "NONE" ? ` · ${item.exceptionStatus}` : ""}
                  </td>
                  <td className="px-3 py-2">{item.weightKg} kg</td>
                  <td className="px-3 py-2">{formatPaisa(BigInt(item.codAmountPaisa))}</td>
                  <td className="px-3 py-2">
                    <span className="flex gap-2">
                      {preDispatch && editable && hasPermission(actor, "transfer.prepare") ? (
                        <RemoveItemButton
                          transferId={transfer.id}
                          packageId={item.packageId}
                          trackingId={item.trackingId}
                        />
                      ) : null}
                      {preDispatch && item.itemStatus === "LOADED" ? (
                        <UnloadButton transferId={transfer.id} trackingId={item.trackingId} />
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
              {transfer.items.length === 0 ? (
                <tr>
                  <td className="px-3 py-2 text-slate2" colSpan={7}>
                    No packages yet — add eligible packages below.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {editable && hasPermission(actor, "transfer.prepare") && (isOrigin || unscoped) ? (
          <div className="mt-4">
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Add packages</h3>
            <AddItemsForm transferId={transfer.id} eligible={eligible} />
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Manifest">
        {transfer.manifest ? (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
              <div>
                <dt className="text-slate2">Manifest code</dt>
                <dd className="font-mono font-semibold text-ink">{transfer.manifest.manifestCode}</dd>
              </div>
              <div>
                <dt className="text-slate2">Packages</dt>
                <dd className="font-medium text-ink">{transfer.manifest.packageCount}</dd>
              </div>
              <div>
                <dt className="text-slate2">Total weight</dt>
                <dd className="font-medium text-ink">{transfer.manifest.totalWeightKg} kg</dd>
              </div>
              <div>
                <dt className="text-slate2">Total COD</dt>
                <dd className="font-medium text-ink">
                  {formatPaisa(BigInt(transfer.manifest.totalCodPaisa))}
                </dd>
              </div>
            </dl>
            <div>
              <Link
                href={`${basePath}/transfers/${transfer.id}/manifest`}
                className={subtleButtonClass}
              >
                Printable manifest →
              </Link>
            </div>
          </div>
        ) : editable ? (
          <GenerateManifestButton transferId={transfer.id} />
        ) : (
          <p className="text-[13px] text-slate2">No manifest generated.</p>
        )}
      </SectionCard>

      {preDispatch && manifested ? (
        <SectionCard title="Crew (driver + vehicle)">
          {hasPermission(actor, "driver.assign") ? (
            <AssignCrewForm
              transferId={transfer.id}
              drivers={crewDrivers}
              vehicles={crewVehicles}
              currentDriverId={transfer.driverId}
              currentVehicleId={transfer.vehicleId}
            />
          ) : (
            <p className="text-[13px] text-slate2">
              Driver: {transfer.driverName ?? "—"} · Vehicle: {transfer.vehicleRegistration ?? "—"}
            </p>
          )}
        </SectionCard>
      ) : null}

      {preDispatch && manifested && transfer.driverId ? (
        <SectionCard title="Loading & dispatch">
          <div className="flex flex-col gap-4">
            {hasPermission(actor, "transfer.load") ? (
              <LoadScanForm transferId={transfer.id} />
            ) : null}
            {hasPermission(actor, "transfer.dispatch") ? (
              <DispatchButton
                transferId={transfer.id}
                loadedCount={rec.loadedCount}
                totalCount={rec.totalItems}
              />
            ) : (
              <p className="text-[13px] text-slate2">
                {rec.loadedCount}/{rec.totalItems} packages loaded. Dispatch requires the
                transfer.dispatch permission.
              </p>
            )}
          </div>
        </SectionCard>
      ) : null}

      {trip ? (
        <SectionCard title="Trip">
          <TripPanel trip={trip} />
        </SectionCard>
      ) : null}

      {inReceiving ? (
        <SectionCard title="Destination receiving & reconciliation">
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-slate2">
              Received {rec.receivedCount} · Damaged {rec.damagedCount} · Missing{" "}
              {rec.missingCount} · Accounted {rec.accountedCount}/{rec.totalItems}
              {rec.unaccountedTrackingIds.length > 0
                ? ` · Unaccounted: ${rec.unaccountedTrackingIds.join(", ")}`
                : ""}
            </p>
            {canActAtDestination ? (
              <>
                <DestinationScanForm transferId={transfer.id} />
                {transfer.items
                  .filter((i) => i.packageStatus === "RECEIVING_INSPECTION")
                  .map((i) => (
                    <CompleteReceivingForm
                      key={i.id}
                      transferId={transfer.id}
                      packageId={i.packageId}
                      trackingId={i.trackingId}
                    />
                  ))}
                <ReceivingCloseButtons
                  transferId={transfer.id}
                  status={transfer.status}
                  canReconcile={hasPermission(actor, "transfer.reconcile")}
                />
              </>
            ) : (
              <p className="text-[13px] text-slate2">
                Receiving is performed by the destination warehouse team.
              </p>
            )}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Printable manifest
// ---------------------------------------------------------------------------

export async function ManifestPrintPage({
  actor,
  transferId,
}: {
  actor: ActorContext;
  transferId: string;
}) {
  const transfer = await getTransfer(actor, transferId);
  const manifest = transfer.manifest;
  return (
    <div className="mx-auto flex max-w-[800px] flex-col gap-5 p-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
            BLA Logistics — Transfer Manifest
          </div>
          <h1 className="mt-0.5 font-mono text-[22px] font-bold text-ink">
            {manifest?.manifestCode ?? "No manifest"}
          </h1>
          <p className="text-[13px] text-slate2">
            Transfer {transfer.transferNumber} · {transfer.originWarehouseName} (
            {transfer.originWarehouseCode}) → {transfer.destinationWarehouseName} (
            {transfer.destinationWarehouseCode})
          </p>
        </div>
        <PrintButton />
      </div>
      {manifest ? (
        <>
          <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
            <div>
              <dt className="text-slate2">Driver</dt>
              <dd className="font-medium text-ink">{transfer.driverName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate2">Vehicle</dt>
              <dd className="font-medium text-ink">{transfer.vehicleRegistration ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate2">Generated by</dt>
              <dd className="font-medium text-ink">{manifest.generatedByName}</dd>
            </div>
            <div>
              <dt className="text-slate2">Sealed at</dt>
              <dd className="font-medium text-ink">{fmtDate(manifest.sealedAt)}</dd>
            </div>
          </dl>
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-slate2">
                <th className="py-2 pr-3">#</th>
                <th className="py-2 pr-3">Tracking ID</th>
                <th className="py-2 pr-3">Recipient</th>
                <th className="py-2 pr-3">District</th>
                <th className="py-2 pr-3">Weight</th>
                <th className="py-2">COD</th>
              </tr>
            </thead>
            <tbody>
              {transfer.items.map((item, idx) => (
                <tr key={item.id} className="border-b border-line">
                  <td className="py-2 pr-3">{idx + 1}</td>
                  <td className="py-2 pr-3 font-mono">{item.trackingId}</td>
                  <td className="py-2 pr-3">{item.recipientName}</td>
                  <td className="py-2 pr-3">{item.deliveryDistrict}</td>
                  <td className="py-2 pr-3">{item.weightKg} kg</td>
                  <td className="py-2">{formatPaisa(BigInt(item.codAmountPaisa))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold text-ink">
                <td className="py-2 pr-3" colSpan={4}>
                  Total — {manifest.packageCount} package(s) · {manifest.totalWeightKg} kg
                </td>
                <td className="py-2 pr-3"></td>
                <td className="py-2">{formatPaisa(BigInt(manifest.totalCodPaisa))}</td>
              </tr>
            </tfoot>
          </table>
          <p className="text-[12px] text-slate2">
            This manifest is a frozen snapshot generated once at {fmtDate(manifest.generatedAt)}.
            Discrepancies found at the destination are recorded against it during receiving and
            reconciliation.
          </p>
        </>
      ) : (
        <p className="text-[13px] text-slate2">
          This transfer has no manifest yet — generate it from the transfer detail page.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line-haul driver dashboard
// ---------------------------------------------------------------------------

export async function DriverDashboardPage({ actor }: { actor: ActorContext }) {
  const profile = actor.driverId ? await getDriver(actor, actor.driverId).catch(() => null) : null;
  const activeTrip = await getMyActiveTrip(actor);
  const { items: history } = await listTrips(actor, { mine: true, pageSize: 10 });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Line-haul Driver" title={`Welcome, ${actor.fullName}`} />
      <SectionCard title="Your driver profile">
        {profile ? (
          <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
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
          <p className="text-[13px] text-slate2">
            No driver profile is linked to your account yet. Ask an Admin to create one before
            you can be assigned a trip.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Active trip">
        {activeTrip ? (
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-slate2">
              {activeTrip.originWarehouseCode} → {activeTrip.destinationWarehouseCode} ·
              Vehicle {activeTrip.vehicleRegistration} · {activeTrip.packageCount} package(s)
            </p>
            <TripPanel trip={activeTrip} />
            <div className="overflow-auto rounded-md border border-line">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-slate2">
                    <th className="px-3 py-2">Tracking ID</th>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Package</th>
                  </tr>
                </thead>
                <tbody>
                  {activeTrip.packages.map((p) => (
                    <tr key={p.packageId} className="border-b border-line last:border-0">
                      <td className="px-3 py-2 font-mono">{p.trackingId}</td>
                      <td className="px-3 py-2">{p.itemStatus}</td>
                      <td className="px-3 py-2">{p.packageStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[12px] text-slate2">
              Receiving at the destination is done by the destination warehouse team — hand the
              packages over and they scan them in.
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-slate2">You have no active trip right now.</p>
        )}
      </SectionCard>

      <SectionCard title="Trip history">
        {history.length === 0 ? (
          <p className="text-[13px] text-slate2">No trips yet.</p>
        ) : (
          <div className="overflow-auto rounded-md border border-line">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-slate2">
                  <th className="px-3 py-2">Trip</th>
                  <th className="px-3 py-2">Route</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Packages</th>
                  <th className="px-3 py-2">Departed</th>
                  <th className="px-3 py-2">Arrived</th>
                </tr>
              </thead>
              <tbody>
                {history.map((t) => (
                  <tr key={t.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 font-mono">{t.tripNumber}</td>
                    <td className="px-3 py-2">
                      {t.originWarehouseCode} → {t.destinationWarehouseCode}
                    </td>
                    <td className="px-3 py-2">
                      <TransferStatusBadge status={t.status} />
                    </td>
                    <td className="px-3 py-2">{t.packageCount}</td>
                    <td className="px-3 py-2">{fmtDate(t.actualDepartureAt)}</td>
                    <td className="px-3 py-2">{fmtDate(t.actualArrivalAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
