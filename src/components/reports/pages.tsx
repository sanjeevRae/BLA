import type { ActorContext } from "@/lib/auth/actor";
import { kathmanduToday } from "@/lib/reports/domain";
import {
  getDailyReport,
  getDriverReport,
  getDriverSelfReport,
  getOverviewReport,
  getTransferReport,
  getVendorReport,
  getWarehouseReport,
  type ReportFilters,
} from "@/server/services/reports";
import { getCodReport, getFinanceReport } from "@/server/services/reports-finance";
import { listDrivers } from "@/server/services/drivers";
import { listVendors } from "@/server/services/vendors";
import { listWarehouses } from "@/server/services/warehouses";
import { SectionCard } from "@/components/warehouses/ui";
import {
  BarSeries,
  ReportFilterBar,
  ReportPageHeader,
  ReportStat,
  ReportTable,
  formatMinutes,
  formatPercent,
  money,
} from "@/components/reports/ui";

/**
 * Phase 9 report pages. Server components only: each page calls the
 * ReportingService with the signed-in actor, so permission and scope
 * are enforced in the service — a page can never render a figure the
 * API would deny. All numbers come from the same service results the
 * /api/reports endpoints and CSV exports return.
 */

export function filtersFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): ReportFilters {
  const pick = (key: string) => {
    const value = params[key];
    const single = Array.isArray(value) ? value[0] : value;
    return single && single.length > 0 ? single : undefined;
  };
  return {
    from: pick("from"),
    to: pick("to"),
    warehouseId: pick("warehouseId"),
    vendorId: pick("vendorId"),
    driverId: pick("driverId"),
    serviceId: pick("serviceId"),
    district: pick("district"),
    status: pick("status"),
    paymentStatus: pick("paymentStatus"),
  };
}

function exportQuery(filters: ReportFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function exportHref(name: string, filters: ReportFilters): string {
  return `/api/reports/${name}/export${exportQuery(filters)}`;
}

// ---------------------------------------------------------------------------
// Overview panel (Super Admin / Admin home — spec Part 4.1–4.2 — and
// the top of the reports page)
// ---------------------------------------------------------------------------

export async function OverviewPanel({
  actor,
  filters,
  prefetched,
}: {
  actor: ActorContext;
  filters: ReportFilters;
  prefetched?: Awaited<ReturnType<typeof getOverviewReport>>;
}) {
  const overview = prefetched ?? (await getOverviewReport(actor, filters));
  return (
    <div className="grid gap-5">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <ReportStat label="Bookings" value={String(overview.bookings)} sub={`${overview.packagesBooked} packages`} />
        <ReportStat label="Delivered" value={String(overview.delivered)} sub={`${overview.failedAttempts} failed attempts`} />
        <ReportStat label="On-time delivery" value={formatPercent(overview.onTimePercent)} sub={`${overview.lateDeliveries} late of ${overview.deliveredWithExpected} with a promised date`} />
        <ReportStat label="Avg delivery time" value={formatMinutes(overview.avgDeliveryMinutes)} sub="booking → door" />
        <ReportStat label="Return rate" value={formatPercent(overview.returnRatePercent)} sub={`${overview.returnsCreated} returns requested`} />
        <ReportStat label="Invoiced" value={money(overview.invoiced.totalPaisa)} sub={`${overview.invoiced.count} invoices`} />
        <ReportStat label="Outstanding" value={money(overview.outstanding.outstandingPaisa)} sub={`${overview.outstanding.openInvoices} open invoices`} />
        <ReportStat label="COD with riders" value={money(overview.cod.outstandingWithRidersPaisa)} sub={`${money(overview.cod.collectedPaisa)} collected in range`} />
      </dl>
      <div className="grid gap-5 lg:grid-cols-2">
        <BarSeries
          title="Bookings per day"
          points={overview.dailySeries.map((d) => ({ label: d.date.slice(5), value: d.bookings }))}
        />
        <BarSeries
          title="Deliveries per day"
          points={overview.dailySeries.map((d) => ({ label: d.date.slice(5), value: d.delivered }))}
        />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <ReportTable
          title="Packages by current status"
          headers={["Status", "Packages"]}
          rows={overview.packagesByStatus.map((s) => [s.status, s.count])}
        />
        <ReportTable
          title="Incidents & support (period)"
          headers={["Kind", "Created", "Open now"]}
          rows={[
            ["Incidents", overview.incidents.created, overview.incidents.open],
            ["Support tickets", overview.tickets.created, overview.tickets.open],
            ...overview.incidents.byCategory.map((c) => [
              `Incident · ${c.category}`,
              c.count,
              "—",
            ]),
            ...overview.tickets.byCategory.map((c) => [
              `Ticket · ${c.category}`,
              c.count,
              "—",
            ]),
          ]}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full reports page (Admin / Super Admin)
// ---------------------------------------------------------------------------

export async function AdminReportsPage({
  actor,
  basePath,
  filters,
}: {
  actor: ActorContext;
  basePath: string;
  filters: ReportFilters;
}) {
  const [warehouses, vendors, drivers] = await Promise.all([
    listWarehouses(actor, { pageSize: 100 }).catch(() => null),
    listVendors(actor, { pageSize: 100 }).catch(() => null),
    listDrivers(actor, { pageSize: 100 }).catch(() => null),
  ]);
  const overview = await getOverviewReport(actor, filters);
  const [daily, warehouseReport, driverReport, vendorReport, transferReport, codReport] =
    await Promise.all([
      getDailyReport(actor, { ...filters, from: kathmanduToday() }),
      getWarehouseReport(actor, filters),
      getDriverReport(actor, filters),
      getVendorReport(actor, filters),
      getTransferReport(actor, filters),
      getCodReport(actor, filters),
    ]);

  return (
    <div className="grid gap-5">
      <ReportPageHeader title="Reports" range={overview.range} note="every figure computed from live operational records" />
      <ReportFilterBar
        action={`${basePath}/reports`}
        from={overview.range.from}
        to={overview.range.to}
        warehouseId={filters.warehouseId}
        vendorId={filters.vendorId}
        driverId={filters.driverId}
        warehouses={warehouses?.items.map((w) => ({ id: w.id, label: `${w.code} — ${w.name}` }))}
        vendors={vendors?.vendors.map((v) => ({ id: v.id, label: v.businessName }))}
        drivers={drivers?.items.map((d) => ({ id: d.id, label: d.fullName }))}
        exportHref={exportHref("overview", filters)}
      />

      <OverviewPanel actor={actor} filters={filters} prefetched={overview} />

      <SectionCard title={`Today (${daily.date})`}>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <ReportStat label="Booked" value={String(daily.bookings)} />
          <ReportStat label="Received" value={String(daily.packagesReceived)} />
          <ReportStat label="Dispatched" value={String(daily.packagesDispatched)} sub={`${daily.transfersDispatched} transfers`} />
          <ReportStat label="Delivered" value={String(daily.delivered)} sub={`${daily.failedAttempts} failed attempts`} />
          <ReportStat label="Returns requested" value={String(daily.returnsRequested)} />
          <ReportStat label="COD collected" value={money(daily.codCollectedPaisa)} />
          <ReportStat label="Invoiced" value={daily.invoicedTotalPaisa !== null ? money(daily.invoicedTotalPaisa) : "—"} />
        </dl>
      </SectionCard>

      <ReportTable
        title="Warehouses"
        headers={["Warehouse", "Received", "Dispatched", "Delivered", "Failed att.", "In stock", "Capacity", "Discrepancies", "Incidents"]}
        rows={warehouseReport.rows.map((row) => [
          `${row.code} — ${row.name}`,
          row.received,
          row.packagesDispatched,
          row.delivered,
          row.failedAttempts,
          row.currentInventory,
          formatPercent(row.capacityUtilisationPercent),
          row.receivingDiscrepancies,
          row.incidentsCreated,
        ])}
        action={<a className="text-[12px] font-semibold text-primary" href={exportHref("warehouses", filters)}>CSV ↓</a>}
      />

      <ReportTable
        title="Drivers & riders"
        headers={["Driver", "Assigned", "Completed", "Failed", "Delivered", "On-time", "Avg time", "COD collected", "COD outstanding", "Trips"]}
        rows={driverReport.rows.map((row) => [
          row.fullName,
          row.assigned,
          row.completed,
          row.failed,
          row.delivered,
          formatPercent(row.onTimePercent),
          formatMinutes(row.avgDeliveryMinutes),
          money(row.codCollectedPaisa),
          money(row.codOutstandingPaisa),
          `${row.tripsCompleted}/${row.trips}`,
        ])}
        action={<a className="text-[12px] font-semibold text-primary" href={exportHref("drivers", filters)}>CSV ↓</a>}
      />

      <ReportTable
        title="Vendors"
        headers={["Vendor", "Bookings", "Delivered", "Success", "Returns", "Invoiced", "Outstanding", "COD collected", "Settled"]}
        rows={vendorReport.rows.map((row) => [
          row.businessName,
          row.bookings,
          row.delivered,
          formatPercent(row.deliverySuccessPercent),
          row.returnsCreated,
          money(row.chargesInvoicedPaisa),
          money(row.outstandingPaisa),
          money(row.codCollectedPaisa),
          money(row.settlementsPaidPaisa),
        ])}
        action={<a className="text-[12px] font-semibold text-primary" href={exportHref("vendors", filters)}>CSV ↓</a>}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <ReportTable
          title="Transfers by route"
          headers={["Route", "Transfers", "Items", "Received", "Discrepant", "Avg transit"]}
          rows={transferReport.rows.map((row) => [
            `${row.originCode} → ${row.destinationCode}`,
            row.transfers,
            row.items,
            row.itemsReceived,
            row.itemsDiscrepant,
            formatMinutes(row.avgTransitMinutes),
          ])}
          action={<a className="text-[12px] font-semibold text-primary" href={exportHref("transfers", filters)}>CSV ↓</a>}
        />
        <SectionCard title="COD summary (period)">
          <dl className="grid grid-cols-2 gap-3">
            <ReportStat label="Expected" value={money(codReport.totals.expectedPaisa)} />
            <ReportStat label="Collected" value={money(codReport.totals.collectedPaisa)} sub={`${codReport.totals.mismatchCollections} mismatched collections`} />
            <ReportStat label="Verified remitted" value={money(codReport.totals.remittedVerifiedPaisa)} />
            <ReportStat label="Outstanding" value={money(codReport.totals.outstandingPaisa)} sub={`${money(codReport.totals.awaitingRemittancePaisa)} not yet remitted · ${money(codReport.totals.inOpenRemittancePaisa)} in open remittances`} />
          </dl>
        </SectionCard>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Warehouse reports page (own warehouses only — service-scoped)
// ---------------------------------------------------------------------------

export async function WarehouseReportsPage({
  actor,
  basePath,
  filters,
}: {
  actor: ActorContext;
  basePath: string;
  filters: ReportFilters;
}) {
  const [warehouseReport, driverReport, transferReport] = await Promise.all([
    getWarehouseReport(actor, filters),
    getDriverReport(actor, filters),
    getTransferReport(actor, filters),
  ]);
  const warehouses = await listWarehouses(actor, { pageSize: 100 }).catch(() => null);

  return (
    <div className="grid gap-5">
      <ReportPageHeader title="Warehouse reports" range={warehouseReport.range} note="your warehouses only" />
      <ReportFilterBar
        action={`${basePath}/reports`}
        from={warehouseReport.range.from}
        to={warehouseReport.range.to}
        warehouseId={filters.warehouseId}
        warehouses={warehouses?.items.map((w) => ({ id: w.id, label: `${w.code} — ${w.name}` }))}
        exportHref={exportHref("warehouses", filters)}
      />
      {warehouseReport.rows.map((row) => (
        <SectionCard key={row.warehouseId} title={`${row.code} — ${row.name}`}>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <ReportStat label="Received" value={String(row.received)} />
            <ReportStat label="Dispatched" value={String(row.packagesDispatched)} sub={`${row.transfersDispatched} transfers out · ${row.transfersArrived} in`} />
            <ReportStat label="Delivered" value={String(row.delivered)} sub={`${row.failedAttempts} failed attempts`} />
            <ReportStat label="In stock now" value={String(row.currentInventory)} sub={row.capacityPackages ? `capacity ${row.capacityPackages} · ${formatPercent(row.capacityUtilisationPercent)} used` : "no package capacity set"} />
            <ReportStat label="Damaged in stock" value={String(row.damagedInStock)} />
            <ReportStat label="Receiving discrepancies" value={String(row.receivingDiscrepancies)} />
            <ReportStat label="Returns requested" value={String(row.returnsRequested)} />
            <ReportStat label="Incidents" value={String(row.incidentsCreated)} />
          </dl>
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <BarSeries
              title="Inventory ageing (days in stock)"
              points={[
                { label: "0–2 days", value: row.aging.days0to2 },
                { label: "3–7 days", value: row.aging.days3to7 },
                { label: "8–14 days", value: row.aging.days8to14 },
                { label: "Over 14 days", value: row.aging.over14 },
              ]}
            />
            <ReportTable
              title="Receiving by staff member"
              headers={["Staff", "Packages received"]}
              rows={row.staffReceiving.map((s) => [s.fullName, s.received])}
              emptyText="No receiving recorded in this range."
            />
          </div>
        </SectionCard>
      ))}
      <ReportTable
        title="Drivers homed at your warehouses"
        headers={["Driver", "Assigned", "Completed", "Delivered", "On-time", "COD collected", "COD outstanding", "Trips"]}
        rows={driverReport.rows.map((row) => [
          row.fullName,
          row.assigned,
          row.completed,
          row.delivered,
          formatPercent(row.onTimePercent),
          money(row.codCollectedPaisa),
          money(row.codOutstandingPaisa),
          `${row.tripsCompleted}/${row.trips}`,
        ])}
        action={<a className="text-[12px] font-semibold text-primary" href={exportHref("drivers", filters)}>CSV ↓</a>}
      />
      <ReportTable
        title="Transfers touching your warehouses"
        headers={["Route", "Transfers", "Items", "Received", "Discrepant", "Avg transit"]}
        rows={transferReport.rows.map((row) => [
          `${row.originCode} → ${row.destinationCode}`,
          row.transfers,
          row.items,
          row.itemsReceived,
          row.itemsDiscrepant,
          formatMinutes(row.avgTransitMinutes),
        ])}
        action={<a className="text-[12px] font-semibold text-primary" href={exportHref("transfers", filters)}>CSV ↓</a>}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finance reports page (financial reports — the Finance role's
// report.read_all is restricted to these, matrix footnote 32)
// ---------------------------------------------------------------------------

export async function FinanceReportsPage({
  actor,
  basePath,
  filters,
}: {
  actor: ActorContext;
  basePath: string;
  filters: ReportFilters;
}) {
  const [finance, cod] = await Promise.all([
    getFinanceReport(actor, filters),
    getCodReport(actor, filters),
  ]);
  const vendors = await listVendors(actor, { pageSize: 100 }).catch(() => null);

  return (
    <div className="grid gap-5">
      <ReportPageHeader title="Financial reports" range={finance.range} note="computed from invoices, payments, remittances, settlements and the ledger" />
      <ReportFilterBar
        action={`${basePath}/reports`}
        from={finance.range.from}
        to={finance.range.to}
        vendorId={filters.vendorId}
        vendors={vendors?.vendors.map((v) => ({ id: v.id, label: v.businessName }))}
        exportHref={exportHref("finance", filters)}
      />
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <ReportStat label="Invoiced" value={money(finance.invoiced.totalPaisa)} sub={`${finance.invoiced.count} invoices`} />
        <ReportStat label="Payments received" value={money(finance.paymentsReceived.totalPaisa)} sub={`${finance.paymentsReceived.count} payments`} />
        <ReportStat label="Ledger shipping revenue" value={money(finance.ledgerShippingRevenuePaisa)} sub="SHIPPING_REVENUE account, period movement" />
        <ReportStat label="Outstanding" value={money(finance.outstanding.outstandingPaisa)} sub={`${finance.outstanding.openInvoices} open invoices`} />
        <ReportStat label="Settlements paid out" value={money(finance.settlements.paidOut.netPayablePaisa)} sub={`${finance.settlements.paidOut.count} settlements`} />
        <ReportStat label="Refunds processed" value={money(finance.refunds.processedPaisa)} sub={`${finance.refunds.processedCount} refunds · ${finance.refunds.requestedOpen} requested`} />
        <ReportStat label="Adjustments applied" value={money(finance.adjustments.appliedPaisa)} sub={`${finance.adjustments.appliedCount} applied · ${finance.adjustments.requestedOpen} requested`} />
        <ReportStat label="Open COD discrepancies" value={String(finance.codReconciliation.openDiscrepancies.count)} sub={money(finance.codReconciliation.openDiscrepancies.discrepancyPaisa)} />
      </dl>

      <div className="grid gap-5 lg:grid-cols-2">
        <BarSeries
          title="Receivables ageing (outstanding now)"
          points={[
            { label: "Not due", value: Number(BigInt(finance.outstanding.ageing.notDuePaisa) / BigInt(100)) },
            { label: "1–30 days", value: Number(BigInt(finance.outstanding.ageing.overdue1to30Paisa) / BigInt(100)) },
            { label: "31–60 days", value: Number(BigInt(finance.outstanding.ageing.overdue31to60Paisa) / BigInt(100)) },
            { label: "61–90 days", value: Number(BigInt(finance.outstanding.ageing.overdue61to90Paisa) / BigInt(100)) },
            { label: "Over 90 days", value: Number(BigInt(finance.outstanding.ageing.overdueOver90Paisa) / BigInt(100)) },
          ]}
          format={(v) => `NPR ${v.toLocaleString("en-IN")}`}
        />
        <ReportTable
          title="Invoices by status (period)"
          headers={["Status", "Invoices", "Total"]}
          rows={finance.invoiced.byStatus.map((s) => [s.status, s.count, money(s.totalPaisa)])}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ReportTable
          title="Settlements by status (period)"
          headers={["Status", "Settlements", "Net payable"]}
          rows={finance.settlements.byStatus.map((s) => [s.status, s.count, money(s.netPayablePaisa)])}
        />
        <ReportTable
          title="Remittances by status (period)"
          headers={["Status", "Remittances", "Declared", "Counted"]}
          rows={finance.codReconciliation.remittancesByStatus.map((s) => [
            s.status,
            s.count,
            money(s.declaredPaisa),
            money(s.countedPaisa),
          ])}
        />
      </div>

      <SectionCard
        title="COD reconciliation (period)"
        action={<a className="text-[12px] font-semibold text-primary" href={exportHref("cod", filters)}>CSV ↓</a>}
      >
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <ReportStat label="Expected" value={money(cod.totals.expectedPaisa)} sub={`${cod.totals.collections} collections`} />
          <ReportStat label="Collected" value={money(cod.totals.collectedPaisa)} sub={`difference ${money(cod.totals.differencePaisa)} · ${cod.totals.mismatchCollections} mismatches`} />
          <ReportStat label="Verified remitted" value={money(cod.totals.remittedVerifiedPaisa)} />
          <ReportStat label="Outstanding with riders" value={money(cod.totals.outstandingPaisa)} sub={`${money(cod.totals.awaitingRemittancePaisa)} awaiting remittance · ${money(cod.totals.inOpenRemittancePaisa)} in open remittances`} />
        </dl>
      </SectionCard>

      <ReportTable
        title="COD by rider"
        headers={["Rider", "Collections", "Expected", "Collected", "Verified", "Awaiting", "In open remittance", "Outstanding"]}
        rows={cod.riders.map((row) => [
          row.label,
          row.collections,
          money(row.expectedPaisa),
          money(row.collectedPaisa),
          money(row.remittedVerifiedPaisa),
          money(row.awaitingRemittancePaisa),
          money(row.inOpenRemittancePaisa),
          money(row.outstandingPaisa),
        ])}
      />
      <ReportTable
        title="COD by warehouse"
        headers={["Warehouse", "Collections", "Expected", "Collected", "Verified", "Outstanding"]}
        rows={cod.warehouses.map((row) => [
          row.label,
          row.collections,
          money(row.expectedPaisa),
          money(row.collectedPaisa),
          money(row.remittedVerifiedPaisa),
          money(row.outstandingPaisa),
        ])}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vendor reports page (own organisation only — service-pinned)
// ---------------------------------------------------------------------------

export async function VendorReportsPage({
  actor,
  basePath,
  filters,
}: {
  actor: ActorContext;
  basePath: string;
  filters: ReportFilters;
}) {
  const report = await getVendorReport(actor, filters);
  const row = report.rows[0];
  return (
    <div className="grid gap-5">
      <ReportPageHeader title="Your reports & statement" range={report.range} note="your organisation only" />
      <ReportFilterBar
        action={`${basePath}/reports`}
        from={report.range.from}
        to={report.range.to}
        exportHref={exportHref("vendors", filters)}
      />
      {!row ? (
        <SectionCard title="Reports">
          <p className="text-[13px] text-ink-2">
            Your account is not linked to a vendor organisation yet.
          </p>
        </SectionCard>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <ReportStat label="Bookings" value={String(row.bookings)} sub={`${row.packages} packages`} />
            <ReportStat label="Delivered" value={String(row.delivered)} sub={`success ${formatPercent(row.deliverySuccessPercent)}`} />
            <ReportStat label="Returns" value={String(row.returnsCreated)} sub={`${row.returnsCompleted} completed · rate ${formatPercent(row.returnRatePercent)}`} />
            <ReportStat label="Charges invoiced" value={money(row.chargesInvoicedPaisa)} sub={`${row.invoicesIssued} invoices`} />
            <ReportStat label="Outstanding charges" value={money(row.outstandingPaisa)} />
            <ReportStat label="COD collected" value={money(row.codCollectedPaisa)} sub={`expected ${money(row.codExpectedPaisa)}`} />
            <ReportStat label="COD settled to you" value={money(row.codSettledPaisa)} sub={`${row.settlementsPaid} settlements paid · ${money(row.settlementsPaidPaisa)}`} />
            <ReportStat label="Payable balance" value={money(row.payableBalancePaisa)} sub="ledger position now" />
          </dl>
          <BarSeries
            title="Your period at a glance"
            points={[
              { label: "Bookings", value: row.bookings },
              { label: "Delivered", value: row.delivered },
              { label: "Returns", value: row.returnsCreated },
            ]}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Driver self reports page (rider + line-haul — report.read_self)
// ---------------------------------------------------------------------------

export async function DriverSelfReportsPage({
  actor,
  basePath,
  filters,
  showCod,
}: {
  actor: ActorContext;
  basePath: string;
  filters: ReportFilters;
  showCod: boolean;
}) {
  const report = await getDriverSelfReport(actor, filters);
  const cod = showCod ? await getCodReport(actor, filters) : null;
  const row = report.rows[0];
  return (
    <div className="grid gap-5">
      <ReportPageHeader title="Your performance" range={report.range} note="your work only" />
      <ReportFilterBar
        action={`${basePath}/reports`}
        from={report.range.from}
        to={report.range.to}
      />
      {!row ? (
        <SectionCard title="Performance">
          <p className="text-[13px] text-ink-2">No driver profile is linked to your account.</p>
        </SectionCard>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <ReportStat label="Assigned" value={String(row.assigned)} sub={`${row.pickupAssigned} pickups · ${formatPercent(row.pickupCompletionPercent)} completed`} />
            <ReportStat label="Completed" value={String(row.completed)} sub={`${row.failed} failed`} />
            <ReportStat label="Delivered" value={String(row.delivered)} sub={`${row.failedAttempts} failed attempts`} />
            <ReportStat label="On-time" value={formatPercent(row.onTimePercent)} sub={`${row.lateDeliveries} late · avg ${formatMinutes(row.avgDeliveryMinutes)}`} />
            <ReportStat label="Trips" value={`${row.tripsCompleted}/${row.trips}`} sub="completed / total" />
            <ReportStat label="Returns after your deliveries" value={String(row.returnsCreated)} />
            {cod ? (
              <>
                <ReportStat label="COD collected" value={money(cod.totals.collectedPaisa)} sub={`expected ${money(cod.totals.expectedPaisa)}`} />
                <ReportStat label="COD outstanding" value={money(cod.totals.outstandingPaisa)} sub={`${money(cod.totals.remittedVerifiedPaisa)} verified remitted`} />
              </>
            ) : null}
          </dl>
          <BarSeries
            title="Your period at a glance"
            points={[
              { label: "Assigned", value: row.assigned },
              { label: "Completed", value: row.completed },
              { label: "Delivered", value: row.delivered },
              { label: "Failed attempts", value: row.failedAttempts },
            ]}
          />
        </>
      )}
    </div>
  );
}
