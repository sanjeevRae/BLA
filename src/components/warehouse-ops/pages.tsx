import Link from "next/link";

import type { ActorContext } from "@/lib/auth/actor";
import { hasPermission } from "@/lib/auth/actor";
import {
  listMembers,
  listWarehouses,
  listZones,
  type WarehouseView,
} from "@/server/services/warehouses";
import {
  getWarehouseOpsSummary,
  listInventory,
  listPackageMovements,
  type InventoryRecordView,
  type WarehouseOpsSummary,
} from "@/server/services/inventory";
import { listCustody, listHandovers } from "@/server/services/custody";
import { listStockItems, listStockMovements } from "@/server/services/supplies";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import {
  CloseHandoverButton,
  HandoverConfirmButton,
  HandoverCreateForm,
  InspectionRecordForm,
  MoveInternalForm,
  MoveToInspectionButton,
  PutAwayForm,
  ReadyForDispatchForm,
  ReceivingForm,
  StartInspectionButton,
  StockItemActiveToggle,
  StockItemCreateForm,
  StockMovementForm,
  type LocationOption,
} from "@/components/warehouse-ops/forms";

/**
 * Phase 4 warehouse-operations screens (warehouse admin + staff
 * dashboards). Every number and row comes from the services — scoped
 * inside their queries — never from client-supplied state.
 */

async function actorWarehouses(actor: ActorContext): Promise<WarehouseView[]> {
  const { items } = await listWarehouses(actor, { pageSize: 100 });
  return items;
}

function NoWarehouseNotice() {
  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      <h1 className="text-[22px] font-bold text-ink">No warehouse assigned</h1>
      <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-slate2">
        Your account has no active warehouse membership, so there is no warehouse stock,
        custody or supplies to show. Ask an Admin to assign you to a warehouse.
      </p>
    </div>
  );
}

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

function CapacityLine({ summary }: { summary: WarehouseOpsSummary }) {
  const { capacity } = summary;
  if (!capacity.configured) {
    return (
      <span>
        {summary.openPackages} package(s) in stock · no package capacity limit set
      </span>
    );
  }
  return (
    <span>
      {capacity.occupancy}/{capacity.capacity} packages ({capacity.percent}%)
      {capacity.level !== "OK" ? (
        <strong className="text-orange"> — {capacity.level.toLowerCase()}</strong>
      ) : null}
    </span>
  );
}

async function warehouseLocations(
  actor: ActorContext,
  warehouseId: string,
): Promise<LocationOption[]> {
  const zones = await listZones(actor, warehouseId);
  return zones.flatMap((zone) =>
    zone.locations
      .filter((l) => l.isActive)
      .map((l) => ({ id: l.id, fullCode: l.fullCode, zoneKind: zone.kind })),
  );
}

// ---------------------------------------------------------------------------
// Home panel (summary + links) for the warehouse / staff home pages
// ---------------------------------------------------------------------------

export async function WarehouseOpsHomePanel({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const warehouses = await actorWarehouses(actor);
  if (warehouses.length === 0) return null;
  const summaries = await Promise.all(
    warehouses.map((w) => getWarehouseOpsSummary(actor, w.id)),
  );
  return (
    <SectionCard
      title="Warehouse operations"
      action={
        <Link href={`${basePath}/operations`} className={subtleButtonClass}>
          Open operations
        </Link>
      }
    >
      <div className="grid gap-2">
        {summaries.map((summary) => (
          <div
            key={summary.warehouseId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
          >
            <span className="font-mono font-semibold text-ink">{summary.warehouseCode}</span>
            <CapacityLine summary={summary} />
            <span className="text-slate2">
              {summary.damagedPackages} damaged · {summary.pendingHandovers} handover(s)
              open · {summary.lowStockItems} low-stock supply item(s)
            </span>
          </div>
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <Link href={`${basePath}/operations`} className={subtleButtonClass}>
            Receiving &amp; inspection
          </Link>
          <Link href={`${basePath}/inventory`} className={subtleButtonClass}>
            Inventory
          </Link>
          <Link href={`${basePath}/handovers`} className={subtleButtonClass}>
            Custody &amp; handovers
          </Link>
          <Link href={`${basePath}/supplies`} className={subtleButtonClass}>
            Supplies
          </Link>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Operations page: receiving + inspection queue + sorting
// ---------------------------------------------------------------------------

function OpsRowActions({
  row,
  locations,
}: {
  row: InventoryRecordView;
  locations: LocationOption[];
}) {
  switch (row.packageStatus) {
    case "RECEIVED_AT_ORIGIN":
      return <MoveToInspectionButton packageId={row.packageId} />;
    case "INSPECTION_PENDING":
      return <StartInspectionButton packageId={row.packageId} />;
    case "PROCESSING":
      return (
        <div className="grid gap-2">
          <InspectionRecordForm packageId={row.packageId} />
          <PutAwayForm packageId={row.packageId} locations={locations} />
        </div>
      );
    case "SORTED":
      return (
        <div className="flex flex-wrap gap-2">
          <ReadyForDispatchForm packageId={row.packageId} locations={locations} />
          <MoveInternalForm
            packageId={row.packageId}
            locations={locations}
            currentLocationId={row.storageLocationId}
          />
        </div>
      );
    default:
      return (
        <MoveInternalForm
          packageId={row.packageId}
          locations={locations}
          currentLocationId={row.storageLocationId}
        />
      );
  }
}

export async function OperationsPage({
  actor,
  roleLabel,
}: {
  actor: ActorContext;
  roleLabel: string;
}) {
  const warehouses = await actorWarehouses(actor);
  if (warehouses.length === 0) return <NoWarehouseNotice />;
  const canReceive = hasPermission(actor, "package.receive");

  const perWarehouse = await Promise.all(
    warehouses.map(async (warehouse) => {
      const [summary, inventory, locations] = await Promise.all([
        getWarehouseOpsSummary(actor, warehouse.id),
        listInventory(actor, { warehouseId: warehouse.id, pageSize: 100 }),
        warehouseLocations(actor, warehouse.id),
      ]);
      return { warehouse, summary, inventory: inventory.items, locations };
    }),
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow={roleLabel} title="Receiving, inspection & sorting" />
      {perWarehouse.map(({ warehouse, summary, inventory, locations }) => (
        <div key={warehouse.id} className="flex flex-col gap-4">
          <h2 className="text-[15px] font-bold text-ink">
            {warehouse.name}{" "}
            <span className="font-mono text-[12px] font-semibold text-slate2">
              {warehouse.code}
            </span>{" "}
            <span className="text-[12px] font-normal text-slate2">
              · <CapacityLine summary={summary} />
            </span>
          </h2>
          {canReceive ? (
            <SectionCard title="Receive a parcel (scan or type the tracking ID)">
              <ReceivingForm warehouseId={warehouse.id} />
            </SectionCard>
          ) : null}
          <SectionCard title={`In the building (${inventory.length})`}>
            {inventory.length === 0 ? (
              <p className="text-[13px] text-faint">
                Nothing in stock. Received parcels appear here immediately.
              </p>
            ) : (
              <div className="grid gap-2">
                {inventory.map((row) => (
                  <div
                    key={row.id}
                    className="grid gap-2 rounded-md border border-line px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                      <span className="font-mono font-semibold text-ink">
                        {row.trackingId}
                      </span>
                      <span className="text-slate2">
                        {row.recipientName} · {row.deliveryDistrict}
                      </span>
                      <span className="text-ink">{row.packageStatus.replaceAll("_", " ")}</span>
                      <span className="text-slate2">
                        {row.locationCode ?? "No location yet"}
                        {row.zoneKind ? ` (${row.zoneKind.toLowerCase()})` : ""}
                      </span>
                      {row.packageCondition !== "GOOD" || row.exceptionStatus !== "NONE" ? (
                        <span className="font-semibold text-orange">
                          {row.packageCondition}
                          {row.exceptionStatus !== "NONE"
                            ? ` · ${row.exceptionStatus.replaceAll("_", " ")}`
                            : ""}
                        </span>
                      ) : null}
                    </div>
                    <OpsRowActions row={row} locations={locations} />
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inventory page: stock by zone/location + recent movements
// ---------------------------------------------------------------------------

export async function InventoryPage({
  actor,
  roleLabel,
  search,
}: {
  actor: ActorContext;
  roleLabel: string;
  search?: string;
}) {
  const warehouses = await actorWarehouses(actor);
  if (warehouses.length === 0) return <NoWarehouseNotice />;

  const perWarehouse = await Promise.all(
    warehouses.map(async (warehouse) => {
      const [summary, inventory] = await Promise.all([
        getWarehouseOpsSummary(actor, warehouse.id),
        listInventory(actor, {
          warehouseId: warehouse.id,
          search,
          pageSize: 100,
        }),
      ]);
      const movements = (
        await Promise.all(
          inventory.items
            .slice(0, 20)
            .map((row) => listPackageMovements(actor, row.packageId)),
        )
      )
        .flat()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20);
      return { warehouse, summary, inventory: inventory.items, movements };
    }),
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow={roleLabel} title="Inventory" />
      {perWarehouse.map(({ warehouse, summary, inventory, movements }) => {
        const byZone = new Map<string, number>();
        for (const row of inventory) {
          const key = row.zoneKind ?? "UNASSIGNED";
          byZone.set(key, (byZone.get(key) ?? 0) + 1);
        }
        return (
          <div key={warehouse.id} className="flex flex-col gap-4">
            <h2 className="text-[15px] font-bold text-ink">
              {warehouse.name}{" "}
              <span className="font-mono text-[12px] font-semibold text-slate2">
                {warehouse.code}
              </span>{" "}
              <span className="text-[12px] font-normal text-slate2">
                · <CapacityLine summary={summary} />
              </span>
            </h2>
            <SectionCard title="Stock by zone">
              {byZone.size === 0 ? (
                <p className="text-[13px] text-faint">No stock on hand.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {[...byZone.entries()].map(([zone, count]) => (
                    <span
                      key={zone}
                      className="rounded-full bg-cream px-2.5 py-1 text-[12px] font-semibold text-ink"
                    >
                      {zone.replaceAll("_", " ")}: {count}
                    </span>
                  ))}
                </div>
              )}
            </SectionCard>
            <SectionCard title={`Parcels in stock (${inventory.length})`}>
              {inventory.length === 0 ? (
                <p className="text-[13px] text-faint">Nothing in stock.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[13px]">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-[0.12em] text-slate2">
                        <th className="py-1 pr-3">Tracking ID</th>
                        <th className="py-1 pr-3">Recipient</th>
                        <th className="py-1 pr-3">Status</th>
                        <th className="py-1 pr-3">Location</th>
                        <th className="py-1 pr-3">Condition</th>
                        <th className="py-1">Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inventory.map((row) => (
                        <tr key={row.id} className="border-t border-line">
                          <td className="py-1.5 pr-3 font-mono font-semibold text-ink">
                            {row.trackingId}
                          </td>
                          <td className="py-1.5 pr-3 text-ink">
                            {row.recipientName} · {row.deliveryDistrict}
                          </td>
                          <td className="py-1.5 pr-3 text-ink">
                            {row.packageStatus.replaceAll("_", " ")}
                          </td>
                          <td className="py-1.5 pr-3 text-slate2">
                            {row.locationCode ?? "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-ink">
                            {row.packageCondition}
                            {row.exceptionStatus !== "NONE"
                              ? ` (${row.exceptionStatus.replaceAll("_", " ")})`
                              : ""}
                          </td>
                          <td className="py-1.5 text-slate2">
                            {new Date(row.receivedAt).toLocaleString()} · {row.receivedByName}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
            <SectionCard title="Recent movements">
              {movements.length === 0 ? (
                <p className="text-[13px] text-faint">No movements recorded yet.</p>
              ) : (
                <div className="grid gap-1.5">
                  {movements.map((m) => (
                    <div key={m.id} className="text-[13px] text-slate2">
                      <span className="font-semibold text-ink">
                        {m.type.replaceAll("_", " ")}
                      </span>{" "}
                      {m.fromLocationCode ?? m.fromWarehouseCode ?? "—"} →{" "}
                      {m.toLocationCode ?? m.toWarehouseCode ?? "—"} · {m.actorName} ·{" "}
                      {new Date(m.createdAt).toLocaleString()}
                      {m.reason ? ` · ${m.reason}` : ""}
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Handovers page: custody view + batch create/confirm
// ---------------------------------------------------------------------------

export async function HandoversPage({
  actor,
  roleLabel,
}: {
  actor: ActorContext;
  roleLabel: string;
}) {
  const warehouses = await actorWarehouses(actor);
  if (warehouses.length === 0) return <NoWarehouseNotice />;

  const perWarehouse = await Promise.all(
    warehouses.map(async (warehouse) => {
      const [custody, batches, members] = await Promise.all([
        listCustody(actor, { warehouseId: warehouse.id, pageSize: 100 }),
        listHandovers(actor, { warehouseId: warehouse.id, pageSize: 20 }),
        listMembers(actor, warehouse.id),
      ]);
      return { warehouse, custody: custody.items, batches: batches.items, members };
    }),
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow={roleLabel} title="Custody & handovers" />
      {perWarehouse.map(({ warehouse, custody, batches, members }) => {
        // Group open custodies by current giver — one handover batch
        // is one giver handing to one receiver.
        const groups = new Map<
          string,
          { label: string; packages: { packageId: string; trackingId: string }[] }
        >();
        for (const row of custody) {
          const key =
            row.custodianType === "USER"
              ? `USER:${row.custodianUserId}`
              : `WAREHOUSE:${row.warehouseId}`;
          const label =
            row.custodianType === "USER"
              ? (row.custodianName ?? "Staff member")
              : `Warehouse ${row.warehouseCode ?? ""}`;
          const group = groups.get(key) ?? { label, packages: [] };
          group.packages.push({ packageId: row.packageId, trackingId: row.trackingId });
          groups.set(key, group);
        }
        const receivers = members
          .filter((m) => m.userStatus === "ACTIVE")
          .map((m) => ({ userId: m.userId, label: `${m.fullName} (${m.roleCode.replaceAll("_", " ").toLowerCase()})` }));
        return (
          <div key={warehouse.id} className="flex flex-col gap-4">
            <h2 className="text-[15px] font-bold text-ink">
              {warehouse.name}{" "}
              <span className="font-mono text-[12px] font-semibold text-slate2">
                {warehouse.code}
              </span>
            </h2>
            <SectionCard title={`Who holds what (${custody.length} parcels)`}>
              {custody.length === 0 ? (
                <p className="text-[13px] text-faint">No open custodies — nothing in stock.</p>
              ) : (
                <div className="grid gap-1.5">
                  {custody.map((row) => (
                    <div
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5 text-[13px]"
                    >
                      <span className="font-mono font-semibold text-ink">{row.trackingId}</span>
                      <span className="text-slate2">
                        {row.packageStatus.replaceAll("_", " ")}
                        {row.locationCode ? ` · ${row.locationCode}` : ""}
                      </span>
                      <span className="text-ink">
                        Held by{" "}
                        <strong>
                          {row.custodianType === "USER"
                            ? (row.custodianName ?? "Staff member")
                            : `the warehouse${row.warehouseCode ? ` (${row.warehouseCode})` : ""}`}
                        </strong>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
            {[...groups.entries()].map(([key, group]) => (
              <SectionCard key={key} title="Start a handover">
                <HandoverCreateForm
                  warehouseId={warehouse.id}
                  giverLabel={group.label}
                  packages={group.packages}
                  receivers={receivers}
                />
              </SectionCard>
            ))}
            <SectionCard title={`Handover batches (${batches.length})`}>
              {batches.length === 0 ? (
                <p className="text-[13px] text-faint">No handovers yet.</p>
              ) : (
                <div className="grid gap-3">
                  {batches.map((batch) => (
                    <div key={batch.id} className="rounded-md border border-line px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                        <span className="text-ink">
                          <strong>{batch.fromLabel}</strong> → <strong>{batch.toLabel}</strong>
                        </span>
                        <span className="text-slate2">
                          {batch.confirmedCount}/{batch.expectedCount} confirmed ·{" "}
                          {new Date(batch.createdAt).toLocaleString()} · by{" "}
                          {batch.initiatedByName}
                        </span>
                        <span
                          className={
                            batch.status === "CONFIRMED"
                              ? "font-semibold text-green"
                              : batch.status === "DISPUTED"
                                ? "font-semibold text-red"
                                : "font-semibold text-orange"
                          }
                        >
                          {batch.status.replaceAll("_", " ")}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-1.5">
                        {batch.lines.map((line) => (
                          <div
                            key={line.id}
                            className="flex flex-wrap items-center justify-between gap-2 text-[13px]"
                          >
                            <span className="font-mono text-ink">{line.trackingId}</span>
                            <span className="text-slate2">{line.status}</span>
                            {line.status === "PENDING" &&
                            (batch.status === "PENDING" ||
                              batch.status === "PARTIALLY_CONFIRMED") ? (
                              <HandoverConfirmButton
                                batchId={batch.id}
                                packageId={line.packageId}
                              />
                            ) : null}
                          </div>
                        ))}
                      </div>
                      {batch.status === "PENDING" ||
                      batch.status === "PARTIALLY_CONFIRMED" ? (
                        <div className="mt-2">
                          <CloseHandoverButton batchId={batch.id} />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplies page
// ---------------------------------------------------------------------------

export async function SuppliesPage({
  actor,
  roleLabel,
}: {
  actor: ActorContext;
  roleLabel: string;
}) {
  const warehouses = await actorWarehouses(actor);
  if (warehouses.length === 0) return <NoWarehouseNotice />;
  const canManage = hasPermission(actor, "supplies.manage");

  const perWarehouse = await Promise.all(
    warehouses.map(async (warehouse) => {
      const stock = await listStockItems(actor, {
        warehouseId: warehouse.id,
        pageSize: 100,
      });
      const movementsByItem = new Map<
        string,
        Awaited<ReturnType<typeof listStockMovements>>["items"]
      >();
      for (const item of stock.items) {
        const movements = await listStockMovements(actor, item.id, { pageSize: 5 });
        movementsByItem.set(item.id, movements.items);
      }
      return { warehouse, items: stock.items, movementsByItem };
    }),
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow={roleLabel} title="Supplies (consumables — separate from parcels)" />
      {perWarehouse.map(({ warehouse, items, movementsByItem }) => (
        <div key={warehouse.id} className="flex flex-col gap-4">
          <h2 className="text-[15px] font-bold text-ink">
            {warehouse.name}{" "}
            <span className="font-mono text-[12px] font-semibold text-slate2">
              {warehouse.code}
            </span>
          </h2>
          {canManage ? (
            <SectionCard title="Add a stock item">
              <StockItemCreateForm warehouseId={warehouse.id} />
            </SectionCard>
          ) : null}
          <SectionCard title={`Stock items (${items.length})`}>
            {items.length === 0 ? (
              <p className="text-[13px] text-faint">No supplies tracked yet.</p>
            ) : (
              <div className="grid gap-3">
                {items.map((item) => (
                  <div key={item.id} className="rounded-md border border-line px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                      <span className="text-ink">
                        <span className="font-mono font-semibold">{item.sku}</span> ·{" "}
                        {item.name}
                      </span>
                      <span className="text-ink">
                        <strong>{item.quantityOnHand}</strong> {item.unit.toLowerCase()} on
                        hand
                        {item.lowStock ? (
                          <span className="ml-2 font-semibold text-orange">
                            Low stock (reorder at {item.reorderLevel})
                          </span>
                        ) : null}
                        {!item.isActive ? (
                          <span className="ml-2 text-faint">Inactive</span>
                        ) : null}
                      </span>
                    </div>
                    {canManage && item.isActive ? (
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <StockMovementForm stockItemId={item.id} />
                        <StockItemActiveToggle stockItemId={item.id} isActive={item.isActive} />
                      </div>
                    ) : canManage ? (
                      <div className="mt-2">
                        <StockItemActiveToggle stockItemId={item.id} isActive={item.isActive} />
                      </div>
                    ) : null}
                    {(movementsByItem.get(item.id) ?? []).length > 0 ? (
                      <div className="mt-2 grid gap-1 border-t border-line pt-2">
                        {(movementsByItem.get(item.id) ?? []).map((m) => (
                          <div key={m.id} className="text-[12px] text-slate2">
                            {m.type.replaceAll("_", " ")} {m.quantityDelta > 0 ? "+" : ""}
                            {m.quantityDelta} · {m.quantityBefore} → {m.quantityAfter} ·{" "}
                            {m.performedByName} · {new Date(m.createdAt).toLocaleString()}
                            {m.reason ? ` · ${m.reason}` : ""}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      ))}
    </div>
  );
}
