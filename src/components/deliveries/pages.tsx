import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { formatPaisa } from "@/components/bookings/ui";
import { StatusBadge as SharedStatusBadge } from "@/components/ui/StatusBadge";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { listWarehouses } from "@/server/services/warehouses";
import {
  getDeliveryBatch,
  getRiderBatch,
  getRiderHomeToday,
  listDeliveryBatches,
  listDeliveryRiders,
  listEligibleDeliveryPackages,
  listEligiblePickupPackages,
  listRiderBatches,
  type DeliveryBatchView,
} from "@/server/services/deliveries";
import { listMyCustody } from "@/server/services/custody";
import { getRiderCodPosition } from "@/server/services/cod-remittances";
import {
  RiderCodCard,
  RiderCurrentBatchCard,
  RiderCustodyList,
  RiderFailedAttemptsList,
  RiderTodayStrip,
  riderSubtleActionClass,
} from "@/components/deliveries/rider-home";
import { getReturn, listReturns } from "@/server/services/returns";
import {
  AddPackagesForm,
  ApproveReturnForm,
  AttemptForm,
  BatchCloseButtons,
  CancelAssignmentButton,
  CompleteReturnButton,
  CreateBatchForm,
  DeliverForm,
  InspectReturnForm,
  PickupCollectionForm,
  PickupFailedForm,
  PickupForm,
  ReassignBatchForm,
  ReassignForm,
  RejectReturnForm,
  ScanBackForm,
  type WarehouseOption,
} from "@/components/deliveries/forms";
import { DriverAssignmentIncidentForm } from "@/components/operations/forms";

/**
 * Phase 6 delivery + returns screens (warehouse admin + staff
 * dashboards, and the rider dashboard). Every row comes from the
 * services — scoped inside their queries — never from
 * client-supplied state. Recipient phone/address render ONLY in the
 * rider's own batch view.
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

export function DeliveryStatusBadge({ status }: { status: string }) {
  return <SharedStatusBadge domain="generic" status={status} />;
}

async function warehouseOptions(actor: ActorContext): Promise<WarehouseOption[]> {
  const { items } = await listWarehouses(actor, { pageSize: 100 });
  return items.map((w) => ({ id: w.id, code: w.code, name: w.name }));
}

// ---------------------------------------------------------------------------
// Home panels
// ---------------------------------------------------------------------------

export async function DeliveriesHomePanel({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  if (
    !hasPermission(actor, "delivery.assign") &&
    !hasPermission(actor, "package.receive") &&
    !hasPermission(actor, "delivery.read_assigned")
  ) {
    return null;
  }
  const { items } = await listDeliveryBatches(actor, { pageSize: 100 });
  const open = items.filter((b) => b.status === "OPEN" || b.status === "IN_PROGRESS");
  const outNow = open.reduce((n, b) => n + b.counts.inProgress, 0);
  return (
    <SectionCard title="Last-mile delivery">
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-slate2">
          {open.length} open batch(es) · {outNow} package(s) out with riders right now
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href={`${basePath}/deliveries`} className={subtleButtonClass}>
            Delivery batches →
          </Link>
          {hasPermission(actor, "delivery.assign") ? (
            <Link href={`${basePath}/deliveries/new`} className={subtleButtonClass}>
              New batch →
            </Link>
          ) : null}
          <Link href={`${basePath}/returns`} className={subtleButtonClass}>
            Returns →
          </Link>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Dispatcher: batch list / create / detail
// ---------------------------------------------------------------------------

export async function DeliveriesListPage({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const [{ items }, warehouses] = await Promise.all([
    listDeliveryBatches(actor, { pageSize: 100 }),
    warehouseOptions(actor),
  ]);
  const canAssign = hasPermission(actor, "delivery.assign");
  const canScanBack = hasPermission(actor, "package.receive");
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow="Deliveries" title="Delivery batches" />
        <div className="flex flex-wrap gap-2">
          <Link href={`${basePath}/returns`} className={subtleButtonClass}>
            Returns →
          </Link>
          {canAssign ? (
            <Link href={`${basePath}/deliveries/new`} className={subtleButtonClass}>
              New batch →
            </Link>
          ) : null}
        </div>
      </div>

      <SectionCard title={`Batches (${items.length})`}>
        {items.length === 0 ? (
          <p className="text-[13px] text-slate2">No delivery batches yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-slate2">
                  <th className="py-2 pr-3 font-semibold">Date</th>
                  <th className="py-2 pr-3 font-semibold">Rider</th>
                  <th className="py-2 pr-3 font-semibold">Warehouse</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 font-semibold">Packages</th>
                  <th className="py-2 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3">{b.batchDate}</td>
                    <td className="py-2 pr-3">{b.riderName}</td>
                    <td className="py-2 pr-3 font-mono">{b.warehouseCode}</td>
                    <td className="py-2 pr-3">
                      <DeliveryStatusBadge status={b.status} />
                    </td>
                    <td className="py-2 pr-3">
                      {b.counts.total} total · {b.counts.completed} delivered ·{" "}
                      {b.counts.inProgress} out · {b.counts.failed} failed
                    </td>
                    <td className="py-2 text-right">
                      <Link
                        href={`${basePath}/deliveries/${b.id}`}
                        className="font-semibold text-brand"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {canScanBack && warehouses.length > 0 ? (
        <SectionCard title="Scan back an undelivered package">
          <p className="mb-3 text-[13px] text-slate2">
            When a rider hands a package back, scan it here: custody and stock reopen, and an
            open return advances to RECEIVED.
          </p>
          <ScanBackForm warehouses={warehouses} />
        </SectionCard>
      ) : null}
    </div>
  );
}

export async function CreateBatchPage({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const warehouses = await warehouseOptions(actor);
  const ridersByWarehouse: Record<string, Awaited<ReturnType<typeof listDeliveryRiders>>> = {};
  for (const w of warehouses) {
    ridersByWarehouse[w.id] = await listDeliveryRiders(actor, w.id).catch(() => []);
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deliveries" title="New delivery batch" />
      <SectionCard title="Batch details">
        <CreateBatchForm
          warehouses={warehouses}
          ridersByWarehouse={ridersByWarehouse}
          basePath={basePath}
        />
      </SectionCard>
    </div>
  );
}

export async function DeliveryBatchDetailPage({
  actor,
  basePath,
  batchId,
}: {
  actor: ActorContext;
  basePath: string;
  batchId: string;
}) {
  const { batch, assignments } = await getDeliveryBatch(actor, batchId);
  const isPickupBatch = batch.kind === "PICKUP";
  const canAssign = isPickupBatch
    ? hasPermission(actor, "pickup.assign")
    : hasPermission(actor, "delivery.assign");
  const eligible =
    canAssign && batch.status === "OPEN"
      ? isPickupBatch
        ? (await listEligiblePickupPackages(actor, batch.warehouseId, { pageSize: 100 })).items
        : (await listEligibleDeliveryPackages(actor, batch.warehouseId, { pageSize: 100 })).items
      : [];
  const riders =
    canAssign && (batch.status === "OPEN" || batch.status === "IN_PROGRESS")
      ? await listDeliveryRiders(actor, batch.warehouseId).catch(() => [])
      : [];
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href={`${basePath}/deliveries`} className="text-[12px] font-semibold text-brand">
          ← All batches
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-bold text-ink">
            {batch.riderName} · {batch.batchDate}
          </h1>
          <DeliveryStatusBadge status={batch.status} />
        </div>
        <p className="mt-1 text-[13px] text-slate2">
          Warehouse <span className="font-mono">{batch.warehouseCode}</span> · {batch.counts.total}{" "}
          package(s): {batch.counts.pending} waiting pickup, {batch.counts.inProgress} out,{" "}
          {batch.counts.completed} delivered, {batch.counts.failed} failed,{" "}
          {batch.counts.cancelled + batch.counts.reassigned} cancelled/reassigned
          {batch.closedAt ? ` · Closed ${new Date(batch.closedAt).toLocaleString()}` : ""}
        </p>
      </div>

      {canAssign ? (
        <SectionCard title="Batch actions">
          <div className="flex flex-col gap-4">
            <BatchCloseButtons batchId={batch.id} status={batch.status} />
            <ReassignBatchForm
              batchId={batch.id}
              status={batch.status}
              currentRiderUserId={batch.riderUserId}
              riders={riders}
            />
          </div>
        </SectionCard>
      ) : null}

      {canAssign && batch.status === "OPEN" ? (
        <SectionCard
          title={
            isPickupBatch
              ? "Add packages awaiting rider pickup at this warehouse"
              : "Add packages ready at this warehouse"
          }
        >
          <AddPackagesForm batchId={batch.id} eligible={eligible} />
        </SectionCard>
      ) : null}

      <SectionCard title={`Assignments (${assignments.length})`}>
        {assignments.length === 0 ? (
          <p className="text-[13px] text-slate2">No packages assigned yet.</p>
        ) : (
          <div className="grid gap-3">
            {assignments.map((a) => (
              <div key={a.id} className="rounded-md border border-line bg-page px-3 py-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-[13px] font-semibold text-ink">
                    {a.trackingId}
                  </span>
                  <DeliveryStatusBadge status={a.status} />
                  <span className="text-[13px] text-slate2">
                    Package: {a.packageStatus} · Attempts: {a.attemptsRecorded} (
                    {a.failedAttempts} failed)
                    {BigInt(a.codExpectedPaisa) > BigInt(0)
                      ? ` · COD due ${formatPaisa(BigInt(a.codExpectedPaisa))}`
                      : ""}
                  </span>
                </div>
                {a.failureNote ? (
                  <p className="mt-1 text-[12px] text-slate2">{a.failureNote}</p>
                ) : null}
                {canAssign && (a.status === "PENDING" || a.status === "ACCEPTED") ? (
                  <div className="mt-2 flex flex-wrap gap-4">
                    <CancelAssignmentButton assignmentId={a.id} />
                    <ReassignForm assignmentId={a.id} riders={riders} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Returns: list / detail
// ---------------------------------------------------------------------------

export async function ReturnsListPage({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const { items } = await listReturns(actor, { pageSize: 100 });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Returns" title="Return requests" />
      <SectionCard title={`Returns (${items.length})`}>
        {items.length === 0 ? (
          <p className="text-[13px] text-slate2">No return requests in your scope.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-slate2">
                  <th className="py-2 pr-3 font-semibold">Return</th>
                  <th className="py-2 pr-3 font-semibold">Tracking ID</th>
                  <th className="py-2 pr-3 font-semibold">Reason</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 font-semibold">Warehouse</th>
                  <th className="py-2 font-semibold" />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3 font-mono">{r.returnNumber}</td>
                    <td className="py-2 pr-3 font-mono">{r.trackingId}</td>
                    <td className="py-2 pr-3">{r.reason}</td>
                    <td className="py-2 pr-3">
                      <DeliveryStatusBadge status={r.status} />
                    </td>
                    <td className="py-2 pr-3 font-mono">{r.warehouseCode}</td>
                    <td className="py-2 text-right">
                      <Link
                        href={`${basePath}/returns/${r.id}`}
                        className="font-semibold text-brand"
                      >
                        Open →
                      </Link>
                    </td>
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

export async function ReturnDetailPage({
  actor,
  basePath,
  returnId,
}: {
  actor: ActorContext;
  basePath: string;
  returnId: string;
}) {
  const r = await getReturn(actor, returnId);
  const canAuthorise = hasPermission(actor, "package.return_initiate");
  const canInspect = hasPermission(actor, "package.inspect");
  const canComplete = hasPermission(actor, "custody.handover");
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href={`${basePath}/returns`} className="text-[12px] font-semibold text-brand">
          ← All returns
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-[22px] font-bold text-ink">{r.returnNumber}</h1>
          <DeliveryStatusBadge status={r.status} />
        </div>
        <p className="mt-1 text-[13px] text-slate2">
          Package <span className="font-mono">{r.trackingId}</span> · Order {r.orderNumber} ·
          Warehouse <span className="font-mono">{r.warehouseCode}</span> · Reason {r.reason} ·
          Requested by {r.requestedByName}
        </p>
      </div>

      <SectionCard title="Return record">
        <dl className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-slate2">Condition at initiation</dt>
            <dd className="font-semibold text-ink">{r.conditionAtInitiation}</dd>
          </div>
          <div>
            <dt className="text-slate2">Condition at inspection</dt>
            <dd className="font-semibold text-ink">{r.conditionAtInspection ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate2">Charges borne by</dt>
            <dd className="font-semibold text-ink">
              {r.chargeBearer ?? "—"}
              {BigInt(r.chargeAmountPaisa) > BigInt(0)
                ? ` · ${formatPaisa(BigInt(r.chargeAmountPaisa))}`
                : ""}
            </dd>
          </div>
          <div>
            <dt className="text-slate2">Received at warehouse</dt>
            <dd className="font-semibold text-ink">
              {r.receivedAt ? new Date(r.receivedAt).toLocaleString() : "—"}
            </dd>
          </div>
          {r.rejectionReason ? (
            <div>
              <dt className="text-slate2">Rejection reason</dt>
              <dd className="font-semibold text-ink">{r.rejectionReason}</dd>
            </div>
          ) : null}
          {r.notes ? (
            <div>
              <dt className="text-slate2">Notes</dt>
              <dd className="font-semibold text-ink">{r.notes}</dd>
            </div>
          ) : null}
        </dl>
      </SectionCard>

      {r.status === "REQUESTED" && canAuthorise ? (
        <SectionCard title="Authorise this return">
          <div className="flex flex-col gap-4">
            <ApproveReturnForm returnId={r.id} />
            <RejectReturnForm returnId={r.id} />
          </div>
        </SectionCard>
      ) : null}
      {r.status === "APPROVED" ? (
        <SectionCard title="Awaiting the package">
          <p className="text-[13px] text-slate2">
            This return is approved. When the rider hands the package back, scan it on the
            Delivery batches page — the return will advance to RECEIVED automatically.
          </p>
        </SectionCard>
      ) : null}
      {r.status === "RECEIVED" && canInspect ? (
        <SectionCard title="Inspect the returned package">
          <InspectReturnForm returnId={r.id} />
        </SectionCard>
      ) : null}
      {r.status === "INSPECTED" && canComplete ? (
        <SectionCard title="Complete the return">
          <p className="mb-3 text-[13px] text-slate2">
            Completing hands the package back to the vendor: stock releases, custody moves to
            the vendor&apos;s owner user, and the package becomes RETURNED_TO_SENDER.
          </p>
          <CompleteReturnButton returnId={r.id} />
        </SectionCard>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rider: home + batch
// ---------------------------------------------------------------------------

export async function RiderHomePage({ actor }: { actor: ActorContext }) {
  const today = new Date().toISOString().slice(0, 10);
  // Mobile-first job home (V2 Phase 6, audit M-12). Order:
  // today's summary strip → failed attempts needing action →
  // current assignment / next stop → custody → COD position →
  // today's other batches. The Location Tracking panel lives in
  // the rider layout (Phase 4) above this page — nothing here
  // duplicates or contradicts its controls.
  const [home, batches, custody, codPosition] = await Promise.all([
    getRiderHomeToday(actor, today),
    listRiderBatches(actor, { date: today }),
    listMyCustody(actor),
    getRiderCodPosition(actor),
  ]);
  const currentBatchId = home.currentBatch?.batch.id ?? null;
  const otherBatches = batches.filter((b: DeliveryBatchView) => b.id !== currentBatchId);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Delivery Rider" title="Today's deliveries" />

      <RiderTodayStrip
        assigned={home.assigned}
        delivered={home.delivered}
        remaining={home.remaining}
        failedAttemptsNeedingAction={home.failedAttemptsNeedingAction}
      />

      {home.failedAttempts.length > 0 ? (
        <SectionCard title="Failed attempts — need action">
          <RiderFailedAttemptsList attempts={home.failedAttempts} />
        </SectionCard>
      ) : null}

      <SectionCard title="Current assignment">
        {home.currentBatch ? (
          <RiderCurrentBatchCard
            batchId={home.currentBatch.batch.id}
            warehouseCode={home.currentBatch.batch.warehouseCode}
            batchDate={home.currentBatch.batch.batchDate}
            batchStatus={home.currentBatch.batch.status}
            totalPackages={home.currentBatch.batch.counts.total}
            deliveredPackages={home.currentBatch.batch.counts.completed}
            nextStop={home.currentBatch.nextStop}
          />
        ) : (
          <p className="text-[14px] text-ink">
            No batch assigned to you today. Your dispatcher creates batches at the warehouse —
            a new batch will appear here as soon as it is assigned.
          </p>
        )}
      </SectionCard>

      <SectionCard title={`In your custody (${custody.length})`}>
        <RiderCustodyList items={custody} />
      </SectionCard>

      <SectionCard title="Cash on delivery">
        <RiderCodCard
          collectedTodayPaisa={home.codCollectedPaisa}
          handedOverPaisa={codPosition.verifiedRemittedPaisa}
          toRemitPaisa={codPosition.awaitingRemittanceTotalPaisa}
        />
      </SectionCard>

      {otherBatches.length > 0 ? (
        <SectionCard title="Today's other batches">
          <div className="flex flex-col gap-2">
            {otherBatches.map((b: DeliveryBatchView) => (
              <Link key={b.id} href={`/rider/batches/${b.id}`} className={riderSubtleActionClass}>
                {b.warehouseCode} · {b.status.replaceAll("_", " ")} · {b.counts.completed}/
                {b.counts.total} delivered →
              </Link>
            ))}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

export async function RiderBatchPage({
  actor,
  batchId,
}: {
  actor: ActorContext;
  batchId: string;
}) {
  const { batch, assignments } = await getRiderBatch(actor, batchId);
  const canReportIncident = hasPermission(actor, "incident.report");
  const isPickupBatch = batch.kind === "PICKUP";
  const pending = assignments.filter(
    (a) => a.status === "PENDING" || a.status === "ACCEPTED",
  );
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/rider" className="text-[12px] font-semibold text-brand">
          ← Today&apos;s batches
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-bold text-ink">
            {batch.warehouseCode} · {batch.batchDate}
          </h1>
          <DeliveryStatusBadge status={batch.status} />
          {isPickupBatch ? <DeliveryStatusBadge status="PICKUP" /> : null}
        </div>
      </div>

      {pending.length > 0 ? (
        isPickupBatch ? (
          <SectionCard title="Confirm collection from sender">
            <PickupCollectionForm
              batchId={batch.id}
              pending={pending.map((a) => ({ assignmentId: a.id, trackingId: a.trackingId }))}
            />
          </SectionCard>
        ) : (
          <SectionCard title="Confirm pickup">
            <PickupForm
              batchId={batch.id}
              pending={pending.map((a) => ({ assignmentId: a.id, trackingId: a.trackingId }))}
            />
          </SectionCard>
        )
      ) : null}

      {assignments.map((a) => (
        <SectionCard key={a.id} title={a.trackingId}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <DeliveryStatusBadge status={a.status} />
              <span className="text-[13px] text-slate2">Package: {a.packageStatus}</span>
              {a.failedAttempts > 0 ? (
                <span className="text-[13px] text-slate2">
                  {a.failedAttempts} failed attempt(s) so far
                </span>
              ) : null}
            </div>
            <dl className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
              <div>
                <dt className="text-slate2">Recipient</dt>
                <dd className="font-semibold text-ink">{a.recipientName}</dd>
              </div>
              <div>
                <dt className="text-slate2">Phone</dt>
                <dd className="font-semibold text-ink">
                  {a.recipientPhone}
                  {a.recipientAltPhone ? ` · ${a.recipientAltPhone}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-slate2">Address</dt>
                <dd className="font-semibold text-ink">
                  {a.destinationAddress}
                  {a.destinationLandmark ? ` (near ${a.destinationLandmark})` : ""} ·{" "}
                  {a.destinationCity ?? ""} ({a.destinationDistrict ?? ""})
                </dd>
              </div>
              <div>
                <dt className="text-slate2">COD due</dt>
                <dd className="font-semibold text-ink">
                  {BigInt(a.codExpectedPaisa) > BigInt(0)
                    ? formatPaisa(BigInt(a.codExpectedPaisa))
                    : "None"}
                  {a.codStatus ? ` · collected: ${a.codStatus}` : ""}
                </dd>
              </div>
            </dl>
            {a.failureNote ? <p className="text-[12px] text-slate2">{a.failureNote}</p> : null}
            {isPickupBatch && (a.status === "PENDING" || a.status === "ACCEPTED") ? (
              <PickupFailedForm assignmentId={a.id} />
            ) : null}
            {!isPickupBatch && a.status === "IN_PROGRESS" ? (
              <div className="grid gap-4">
                <DeliverForm assignment={a} />
                <AttemptForm assignment={a} />
              </div>
            ) : null}
            {canReportIncident ? (
              <DriverAssignmentIncidentForm assignmentId={a.id} packageId={a.packageId} />
            ) : null}
          </div>
        </SectionCard>
      ))}

      {(batch.status === "OPEN" || batch.status === "IN_PROGRESS") && assignments.length > 0 ? (
        <SectionCard title="End of day">
          <p className="mb-3 text-[13px] text-slate2">
            The batch closes only when every package is delivered, scanned back at the
            warehouse, or formally returned — unaccounted packages block closure and are
            named.
          </p>
          <BatchCloseButtons batchId={batch.id} status={batch.status} showCancel={false} />
        </SectionCard>
      ) : null}
    </div>
  );
}
