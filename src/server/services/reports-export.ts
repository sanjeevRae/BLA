import "server-only";

import type { ActorContext } from "@/lib/auth/actor";
import { DomainValidationError } from "@/lib/errors";
import {
  EXPORTABLE_REPORTS,
  buildCsv,
  type ExportableReport,
} from "@/lib/reports/domain";
import {
  getDailyReport,
  getDriverReport,
  getOverviewReport,
  getTransferReport,
  getVendorReport,
  getWarehouseReport,
} from "@/server/services/reports";
import { getCodReport, getFinanceReport } from "@/server/services/reports-finance";

/**
 * Authorized CSV export (api-reference §16): the export calls the
 * SAME scoped report service as the JSON endpoint and flattens its
 * result — there is no second query path, so an export can never
 * contain data the report itself would not show this actor.
 */
export async function buildReportCsv(
  actor: ActorContext,
  name: string,
  input: unknown,
): Promise<{ filename: string; csv: string }> {
  if (!(EXPORTABLE_REPORTS as readonly string[]).includes(name)) {
    throw new DomainValidationError(`Unknown report: ${name}`);
  }
  const report = name as ExportableReport;
  const filename = `bla-report-${report}.csv`;

  switch (report) {
    case "overview": {
      const r = await getOverviewReport(actor, input);
      const rows: (string | number | null)[][] = [
        ["range_from", r.range.from],
        ["range_to", r.range.to],
        ["bookings", r.bookings],
        ["packages_booked", r.packagesBooked],
        ["delivered", r.delivered],
        ["delivery_attempts", r.deliveryAttempts],
        ["failed_attempts", r.failedAttempts],
        ["avg_delivery_minutes", r.avgDeliveryMinutes],
        ["late_deliveries", r.lateDeliveries],
        ["on_time_percent", r.onTimePercent],
        ["returns_created", r.returnsCreated],
        ["return_rate_percent", r.returnRatePercent],
        ["invoiced_count", r.invoiced.count],
        ["invoiced_total_paisa", r.invoiced.totalPaisa],
        ["payments_received_count", r.paymentsReceived.count],
        ["payments_received_total_paisa", r.paymentsReceived.totalPaisa],
        ["open_invoices", r.outstanding.openInvoices],
        ["outstanding_paisa", r.outstanding.outstandingPaisa],
        ["cod_expected_paisa", r.cod.expectedPaisa],
        ["cod_collected_paisa", r.cod.collectedPaisa],
        ["cod_outstanding_with_riders_paisa", r.cod.outstandingWithRidersPaisa],
        ["incidents_created", r.incidents.created],
        ["incidents_open", r.incidents.open],
        ["tickets_created", r.tickets.created],
        ["tickets_open", r.tickets.open],
      ];
      for (const day of r.dailySeries) {
        rows.push([`daily_${day.date}_bookings`, day.bookings]);
        rows.push([`daily_${day.date}_delivered`, day.delivered]);
      }
      for (const status of r.packagesByStatus) {
        rows.push([`packages_now_${status.status}`, status.count]);
      }
      return { filename, csv: buildCsv(["metric", "value"], rows) };
    }
    case "daily": {
      const r = await getDailyReport(actor, input);
      return {
        filename,
        csv: buildCsv(
          ["metric", "value"],
          [
            ["date", r.date],
            ["bookings", r.bookings],
            ["packages_received", r.packagesReceived],
            ["transfers_dispatched", r.transfersDispatched],
            ["packages_dispatched", r.packagesDispatched],
            ["delivered", r.delivered],
            ["failed_attempts", r.failedAttempts],
            ["returns_requested", r.returnsRequested],
            ["cod_collected_paisa", r.codCollectedPaisa],
            ["invoiced_total_paisa", r.invoicedTotalPaisa],
          ],
        ),
      };
    }
    case "warehouses": {
      const r = await getWarehouseReport(actor, input);
      return {
        filename,
        csv: buildCsv(
          [
            "warehouse_code", "warehouse_name", "received", "transfers_dispatched",
            "packages_dispatched", "transfers_arrived", "delivered", "failed_attempts",
            "current_inventory", "capacity_packages", "capacity_utilisation_percent",
            "aging_0_2_days", "aging_3_7_days", "aging_8_14_days", "aging_over_14_days",
            "damaged_in_stock", "receiving_discrepancies", "returns_requested",
            "incidents_created",
          ],
          r.rows.map((row) => [
            row.code, row.name, row.received, row.transfersDispatched,
            row.packagesDispatched, row.transfersArrived, row.delivered,
            row.failedAttempts, row.currentInventory, row.capacityPackages,
            row.capacityUtilisationPercent, row.aging.days0to2, row.aging.days3to7,
            row.aging.days8to14, row.aging.over14, row.damagedInStock,
            row.receivingDiscrepancies, row.returnsRequested, row.incidentsCreated,
          ]),
        ),
      };
    }
    case "drivers": {
      const r = await getDriverReport(actor, input);
      return {
        filename,
        csv: buildCsv(
          [
            "driver", "assigned", "completed", "failed", "attempts", "failed_attempts",
            "delivered", "late_deliveries", "on_time_percent", "avg_delivery_minutes",
            "pickup_assigned", "pickup_completed", "pickup_completion_percent",
            "cod_expected_paisa", "cod_collected_paisa", "cod_remitted_verified_paisa",
            "cod_outstanding_paisa", "returns_created", "trips", "trips_completed",
          ],
          r.rows.map((row) => [
            row.fullName, row.assigned, row.completed, row.failed, row.attempts,
            row.failedAttempts, row.delivered, row.lateDeliveries, row.onTimePercent,
            row.avgDeliveryMinutes, row.pickupAssigned, row.pickupCompleted,
            row.pickupCompletionPercent, row.codExpectedPaisa, row.codCollectedPaisa,
            row.codRemittedVerifiedPaisa, row.codOutstandingPaisa, row.returnsCreated,
            row.trips, row.tripsCompleted,
          ]),
        ),
      };
    }
    case "vendors": {
      const r = await getVendorReport(actor, input);
      return {
        filename,
        csv: buildCsv(
          [
            "vendor", "bookings", "packages", "delivered", "returns_created",
            "returns_completed", "delivery_success_percent", "return_rate_percent",
            "charges_invoiced_paisa", "invoices_issued", "outstanding_paisa",
            "cod_expected_paisa", "cod_collected_paisa", "cod_settled_paisa",
            "settlements_paid", "settlements_paid_paisa", "payable_balance_paisa",
          ],
          r.rows.map((row) => [
            row.businessName, row.bookings, row.packages, row.delivered,
            row.returnsCreated, row.returnsCompleted, row.deliverySuccessPercent,
            row.returnRatePercent, row.chargesInvoicedPaisa, row.invoicesIssued,
            row.outstandingPaisa, row.codExpectedPaisa, row.codCollectedPaisa,
            row.codSettledPaisa, row.settlementsPaid, row.settlementsPaidPaisa,
            row.payableBalancePaisa,
          ]),
        ),
      };
    }
    case "finance": {
      const r = await getFinanceReport(actor, input);
      const rows: (string | number | null)[][] = [
        ["invoiced_count", r.invoiced.count],
        ["invoiced_total_paisa", r.invoiced.totalPaisa],
        ["payments_received_count", r.paymentsReceived.count],
        ["payments_received_total_paisa", r.paymentsReceived.totalPaisa],
        ["ledger_shipping_revenue_paisa", r.ledgerShippingRevenuePaisa],
        ["open_invoices", r.outstanding.openInvoices],
        ["outstanding_paisa", r.outstanding.outstandingPaisa],
        ["ageing_not_due_paisa", r.outstanding.ageing.notDuePaisa],
        ["ageing_overdue_1_30_paisa", r.outstanding.ageing.overdue1to30Paisa],
        ["ageing_overdue_31_60_paisa", r.outstanding.ageing.overdue31to60Paisa],
        ["ageing_overdue_61_90_paisa", r.outstanding.ageing.overdue61to90Paisa],
        ["ageing_overdue_over_90_paisa", r.outstanding.ageing.overdueOver90Paisa],
        ["settlements_paid_out_count", r.settlements.paidOut.count],
        ["settlements_paid_out_paisa", r.settlements.paidOut.netPayablePaisa],
        ["refunds_processed_count", r.refunds.processedCount],
        ["refunds_processed_paisa", r.refunds.processedPaisa],
        ["refunds_requested_open", r.refunds.requestedOpen],
        ["adjustments_applied_count", r.adjustments.appliedCount],
        ["adjustments_applied_paisa", r.adjustments.appliedPaisa],
        ["adjustments_requested_open", r.adjustments.requestedOpen],
        ["cod_expected_paisa", r.codReconciliation.expectedPaisa],
        ["cod_collected_paisa", r.codReconciliation.collectedPaisa],
        ["cod_mismatch_collections", r.codReconciliation.mismatchCollections],
        ["cod_open_discrepancies", r.codReconciliation.openDiscrepancies.count],
        ["cod_open_discrepancy_paisa", r.codReconciliation.openDiscrepancies.discrepancyPaisa],
      ];
      return { filename, csv: buildCsv(["metric", "value"], rows) };
    }
    case "cod": {
      const r = await getCodReport(actor, input);
      const headers = [
        "group", "name", "collections", "expected_paisa", "collected_paisa",
        "difference_paisa", "mismatch_collections", "remitted_verified_paisa",
        "awaiting_remittance_paisa", "in_open_remittance_paisa", "outstanding_paisa",
      ];
      const flatten = (group: string, row: typeof r.totals) => [
        group, row.label, row.collections, row.expectedPaisa, row.collectedPaisa,
        row.differencePaisa, row.mismatchCollections, row.remittedVerifiedPaisa,
        row.awaitingRemittancePaisa, row.inOpenRemittancePaisa, row.outstandingPaisa,
      ];
      return {
        filename,
        csv: buildCsv(headers, [
          flatten("total", r.totals),
          ...r.riders.map((row) => flatten("rider", row)),
          ...r.warehouses.map((row) => flatten("warehouse", row)),
        ]),
      };
    }
    case "transfers": {
      const r = await getTransferReport(actor, input);
      return {
        filename,
        csv: buildCsv(
          [
            "origin", "destination", "transfers", "items", "items_received",
            "items_discrepant", "avg_transit_minutes",
          ],
          r.rows.map((row) => [
            row.originCode, row.destinationCode, row.transfers, row.items,
            row.itemsReceived, row.itemsDiscrepant, row.avgTransitMinutes,
          ]),
        ),
      };
    }
  }
}
