import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from "@/lib/errors";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_CUSTOMER_FACING_CATEGORIES,
  INCIDENT_DEFAULT_SEVERITY,
  INCIDENT_FINANCE_CATEGORIES,
  INCIDENT_MONEY_OR_LOSS_CATEGORIES,
  INCIDENT_OPEN_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TEAMS,
  TASK_PRIORITIES,
  defaultTeamForCategory,
  type IncidentCategory,
  type IncidentSeverity,
} from "@/lib/operations/domain";
import {
  auditAccessDenied,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import {
  auditOps,
  isUnscoped,
} from "@/server/services/warehouse-ops-shared";
import { ACTIVE_TRIP_STATUSES } from "@/lib/transfers/domain";
import {
  notifyUsersInTx,
  userIdsWithRoles,
  warehouseAdminUserIds,
} from "@/server/services/notifications";
import { createTaskInTx } from "@/server/services/tasks";

/**
 * Incidents / exceptions register (docs/exception-management.md;
 * schema doc §10).
 *
 * Two creation paths share one core (`raiseIncidentInTx`):
 *  - MANUAL reports by any role holding incident.report, with link
 *    scope validated against the reporter.
 *  - AUTO-CREATION from earlier phases' link points (disputed
 *    handovers, transfer missing/disputed items, misrouted
 *    packages, rider-displacing scan-backs, COD discrepancies).
 *    Auto-creation is idempotent per source event: the caller passes
 *    a stable `sourceKey`; raises for the same key are serialised by
 *    a per-key advisory transaction lock (P8-R5) over the unique
 *    sourceKey index, so a retry returns the existing incident
 *    instead of duplicating — or erroring — when the source
 *    operation retries.
 *
 * Resolution follows the documented workflow
 * REPORTED → ACKNOWLEDGED → ASSIGNED → INVESTIGATING →
 * (AWAITING_INFORMATION | ESCALATED) → RESOLUTION_PROPOSED →
 * RESOLUTION_APPROVED → RESOLVED → CLOSED. Money / package-loss
 * resolutions need Admin / Super Admin approval by someone other
 * than the proposer (matrix footnote 31); a MISROUTED package's
 * exception flag is cleared from the resolve step, inside the
 * resolution transaction with the package row locked and the flag
 * verified — the transfers/returns pattern for exception flags.
 * operationalStatus is never written here; it stays lifecycle-only.
 */

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export interface IncidentView {
  id: string;
  incidentNumber: string;
  category: string;
  severity: string;
  status: string;
  sourceKey: string | null;
  description: string;
  responsibleTeam: string | null;
  reporterId: string;
  reporterName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  warehouseId: string | null;
  packageId: string | null;
  packageTrackingId: string | null;
  orderId: string | null;
  transferId: string | null;
  tripId: string | null;
  remittanceId: string | null;
  handoverBatchId: string | null;
  deliveryAssignmentId: string | null;
  resolution: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const incidentInclude = {
  reporter: { select: { fullName: true } },
  assignee: { select: { fullName: true } },
  package: { select: { trackingId: true } },
} satisfies Prisma.IncidentInclude;

type IncidentRow = Prisma.IncidentGetPayload<{ include: typeof incidentInclude }>;

function toIncidentView(row: IncidentRow): IncidentView {
  return {
    id: row.id,
    incidentNumber: row.incidentNumber,
    category: row.category,
    severity: row.severity,
    status: row.status,
    sourceKey: row.sourceKey,
    description: row.description,
    responsibleTeam: row.responsibleTeam,
    reporterId: row.reporterId,
    reporterName: row.reporter?.fullName ?? null,
    assigneeId: row.assigneeId,
    assigneeName: row.assignee?.fullName ?? null,
    warehouseId: row.warehouseId,
    packageId: row.packageId,
    packageTrackingId: row.package?.trackingId ?? null,
    orderId: row.orderId,
    transferId: row.transferId,
    tripId: row.tripId,
    remittanceId: row.remittanceId,
    handoverBatchId: row.handoverBatchId,
    deliveryAssignmentId: row.deliveryAssignmentId,
    resolution: row.resolution,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadIncidentOr404(id: string): Promise<IncidentRow> {
  const row = await prisma.incident.findUnique({ where: { id }, include: incidentInclude });
  if (!row) throw new NotFoundError("Incident not found");
  return row;
}

async function lockIncidentRow(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "app"."Incident" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Incident not found");
}

async function lockPackageRowInTx(tx: Prisma.TransactionClient, packageId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "app"."Package" WHERE "id" = ${packageId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Package not found");
}

// ---------------------------------------------------------------------------
// Scope: who may see / work an incident
// ---------------------------------------------------------------------------

/**
 * Visibility rule (exception-management.md §7 + matrix §3.8):
 *  - incident.manage holders: SA/AD see everything; FINANCE sees
 *    finance categories; SUPPORT sees customer-facing categories;
 *    warehouse-scoped managers see incidents of their warehouses
 *    (plus incidents they reported or are assigned).
 *  - Reporters and assignees always see their own incidents.
 *  - VENDOR users see incidents on their own vendor's packages
 *    (customer-safe projection at the view layer); CUSTOMER users
 *    see incidents on their own packages.
 */
export function incidentVisibleTo(actor: ActorContext, row: {
  category: string;
  warehouseId: string | null;
  reporterId: string;
  assigneeId: string | null;
  package?: { order: { vendorId: string | null }; recipientCustomerId: string | null } | null;
}): boolean {
  if (row.reporterId === actor.userId || row.assigneeId === actor.userId) return true;
  if (hasPermission(actor, "incident.manage")) {
    if (isUnscoped(actor) && (actor.roles.includes("SUPER_ADMIN") || actor.roles.includes("ADMIN"))) {
      return true;
    }
    if (actor.roles.includes("FINANCE")) {
      return (INCIDENT_FINANCE_CATEGORIES as readonly string[]).includes(row.category);
    }
    if (actor.roles.includes("SUPPORT")) {
      return (INCIDENT_CUSTOMER_FACING_CATEGORIES as readonly string[]).includes(row.category);
    }
    // Warehouse-scoped managers (WA): their warehouses only.
    if (row.warehouseId && actor.warehouseIds.includes(row.warehouseId)) return true;
    return false;
  }
  if (actor.vendorId && row.package) return row.package.order.vendorId === actor.vendorId;
  if (actor.customerId && row.package) return row.package.recipientCustomerId === actor.customerId;
  return false;
}

async function assertIncidentVisible(
  actor: ActorContext,
  row: IncidentRow,
): Promise<void> {
  const pkg = row.packageId
    ? await prisma.package.findUnique({
        where: { id: row.packageId },
        select: { recipientCustomerId: true, order: { select: { vendorId: true } } },
      })
    : null;
  const visible = incidentVisibleTo(actor, {
    category: row.category,
    warehouseId: row.warehouseId,
    reporterId: row.reporterId,
    assigneeId: row.assigneeId,
    package: pkg ? { order: { vendorId: pkg.order.vendorId }, recipientCustomerId: pkg.recipientCustomerId } : null,
  });
  if (!visible) {
    await auditAccessDenied(actor, "Incident", {
      entityId: row.id,
      warehouseId: row.warehouseId,
      reason: "incident_out_of_scope",
    });
    throw new AuthorizationError("Incident is outside your scope");
  }
}

/** Management actions additionally require incident.manage. */
async function assertIncidentManageable(actor: ActorContext, row: IncidentRow): Promise<void> {
  await requirePermAudited(actor, "incident.manage", "Incident");
  await assertIncidentVisible(actor, row);
}

// ---------------------------------------------------------------------------
// Creation core (shared by manual reports and auto link points)
// ---------------------------------------------------------------------------

export interface RaiseIncidentInTxInput {
  sourceKey?: string | null;
  category: IncidentCategory;
  severity?: IncidentSeverity;
  description: string;
  reporterId: string;
  warehouseId?: string | null;
  responsibleTeam?: string | null;
  packageId?: string | null;
  orderId?: string | null;
  shipmentId?: string | null;
  transferId?: string | null;
  tripId?: string | null;
  codCollectionId?: string | null;
  remittanceId?: string | null;
  handoverBatchId?: string | null;
  deliveryAssignmentId?: string | null;
}

/**
 * Create an incident inside the caller's transaction and fan out
 * the creation notifications (exception-management.md §7 routing:
 * warehouse incidents → that warehouse's WA + Admin; finance →
 * Finance (+ Super Admin when critical); customer-facing → Support
 * queue; critical → Super Admin + Admin immediately). Idempotent on
 * `sourceKey`: a retry returns the existing incident with
 * `created: false` and sends no second notification.
 */
export async function raiseIncidentInTx(
  tx: Prisma.TransactionClient,
  input: RaiseIncidentInTxInput,
): Promise<{ incidentId: string; incidentNumber: string; created: boolean }> {
  if (input.sourceKey) {
    // Phase 8 review P8-R5: serialise concurrent raises for the
    // same source event BEFORE the existence check. The previous
    // recovery — catch the sourceKey unique violation and re-query
    // for the winner's row — could never work: a unique violation
    // aborts the Postgres transaction, so the re-query failed too
    // and the caller's SOURCE operation (discrepancy verification,
    // handover close, transfer receiving…) rolled back with it.
    // An advisory transaction lock keyed by the sourceKey makes
    // check-then-create atomic across transactions: the loser
    // waits, then sees the winner's committed row and returns
    // created: false. The unique index remains the backstop.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.sourceKey}))`;
    const existing = await tx.incident.findUnique({
      where: { sourceKey: input.sourceKey },
      select: { id: true, incidentNumber: true },
    });
    if (existing) {
      return { incidentId: existing.id, incidentNumber: existing.incidentNumber, created: false };
    }
  }
  const seq = await tx.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('"app"."incident_number_seq"') AS nextval`;
  const incidentNumber = `INC-${seq[0].nextval.toString()}`;
  const incident = await tx.incident.create({
    data: {
      incidentNumber,
      category: input.category,
      severity: input.severity ?? INCIDENT_DEFAULT_SEVERITY[input.category],
      status: "REPORTED",
      sourceKey: input.sourceKey ?? null,
      description: input.description,
      reporterId: input.reporterId,
      responsibleTeam: input.responsibleTeam ?? defaultTeamForCategory(input.category),
      warehouseId: input.warehouseId ?? null,
      packageId: input.packageId ?? null,
      orderId: input.orderId ?? null,
      shipmentId: input.shipmentId ?? null,
      transferId: input.transferId ?? null,
      tripId: input.tripId ?? null,
      codCollectionId: input.codCollectionId ?? null,
      remittanceId: input.remittanceId ?? null,
      handoverBatchId: input.handoverBatchId ?? null,
      deliveryAssignmentId: input.deliveryAssignmentId ?? null,
    },
    select: { id: true, incidentNumber: true },
  });

  // Routing fan-out (dedupe per incident event + recipient).
  const severity = input.severity ?? INCIDENT_DEFAULT_SEVERITY[input.category];
  const recipients = new Set<string>();
  if (input.warehouseId) {
    for (const id of await warehouseAdminUserIds(tx, input.warehouseId)) recipients.add(id);
  }
  if ((INCIDENT_FINANCE_CATEGORIES as readonly string[]).includes(input.category)) {
    for (const id of await userIdsWithRoles(tx, ["FINANCE"])) recipients.add(id);
  }
  if ((INCIDENT_CUSTOMER_FACING_CATEGORIES as readonly string[]).includes(input.category)) {
    for (const id of await userIdsWithRoles(tx, ["SUPPORT"])) recipients.add(id);
  }
  if (severity === "CRITICAL" || input.warehouseId) {
    for (const id of await userIdsWithRoles(tx, ["SUPER_ADMIN", "ADMIN"])) recipients.add(id);
  }
  recipients.delete(input.reporterId);
  await notifyUsersInTx(tx, recipients, {
    category: "INCIDENT_CREATED",
    title: `Incident ${incidentNumber} raised`,
    body: `${input.category} (${severity}) — ${input.description.slice(0, 160)}`,
    entityType: "Incident",
    entityId: incident.id,
    dedupeKey: `incident-created:${incident.id}`,
  });
  return { incidentId: incident.id, incidentNumber: incident.incidentNumber, created: true };
}

// ---------------------------------------------------------------------------
// Manual reporting
// ---------------------------------------------------------------------------

export const createIncidentSchema = z.object({
  category: z.enum(INCIDENT_CATEGORIES),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
  description: z.string().min(5).max(2000),
  warehouseId: z.string().uuid().optional(),
  packageId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  transferId: z.string().uuid().optional(),
  // Phase 7 (V2): driver reporting links. The Incident model has
  // always carried both columns; manual reports may now set them,
  // with driver-actor scope validated in createIncident below.
  tripId: z.string().uuid().optional(),
  deliveryAssignmentId: z.string().uuid().optional(),
  responsibleTeam: z.enum(INCIDENT_TEAMS).optional(),
});
export type CreateIncidentInput = z.input<typeof createIncidentSchema>;

export async function createIncident(
  actor: ActorContext,
  input: CreateIncidentInput,
): Promise<IncidentView> {
  const data = parse(createIncidentSchema, input);
  await requirePermAudited(actor, "incident.report", "Incident");

  const category = data.category as IncidentCategory;
  const fallback = INCIDENT_DEFAULT_SEVERITY[category];
  if (data.severity && SEVERITY_RANK[data.severity as IncidentSeverity] < SEVERITY_RANK[fallback]) {
    throw new DomainValidationError(
      `Severity for ${category} cannot be set below its default ${fallback}`,
    );
  }

  // Validate links + reporter scope over them.
  //
  // Phase 7 (V2) driver scope: riders / line-haul drivers hold
  // incident.report but (usually) no warehouse memberships — their
  // scope is their work, not a warehouse. For a driver actor
  // (driverId set, not vendor/customer/unscoped) each link is
  // validated against the driver's own assignments / trips:
  //  - tripId: the trip must be the driver's own.
  //  - deliveryAssignmentId: the assignment must be the driver's own.
  //  - packageId: the driver must hold an active delivery assignment
  //    for the package, or the package must be manifested on a
  //    transfer whose (active) trip is the driver's own.
  // A driver who passes one of these checks is NOT denied by the
  // warehouse-membership checks below (their package may sit in a
  // warehouse they are not a member of — that is the normal case
  // mid-route). Every denial is audit-logged like the other links.
  const isDriverActor =
    Boolean(actor.driverId) && !actor.vendorId && !actor.customerId && !isUnscoped(actor);
  let driverLinkValidated = false;
  let tripOriginWarehouseId: string | null = null;
  let assignmentWarehouseId: string | null = null;
  // An assignment link implies its package when none is named.
  let effectivePackageId = data.packageId ?? null;

  if (data.tripId) {
    const trip = await prisma.trip.findUnique({
      where: { id: data.tripId },
      select: {
        id: true,
        driverId: true,
        transfer: { select: { originWarehouseId: true, destinationWarehouseId: true } },
      },
    });
    if (!trip) throw new NotFoundError("Linked trip not found");
    if (actor.customerId || actor.vendorId) {
      await auditAccessDenied(actor, "Incident", { reason: "trip_link_not_raiser_side" });
      throw new AuthorizationError("Only staff and drivers can report incidents against trips");
    }
    if (isDriverActor) {
      if (trip.driverId !== actor.driverId) {
        await auditAccessDenied(actor, "Incident", {
          entityId: trip.id,
          reason: "trip_not_own_driver",
        });
        throw new AuthorizationError("Drivers can only report incidents on their own trips");
      }
      driverLinkValidated = true;
    } else if (
      !isUnscoped(actor) &&
      !actor.warehouseIds.includes(trip.transfer.originWarehouseId) &&
      !actor.warehouseIds.includes(trip.transfer.destinationWarehouseId)
    ) {
      await auditAccessDenied(actor, "Incident", {
        warehouseId: trip.transfer.destinationWarehouseId,
        reason: "trip_out_of_scope",
      });
      throw new AuthorizationError("Trip is outside your warehouse scope");
    }
    tripOriginWarehouseId = trip.transfer.originWarehouseId;
  }

  if (data.deliveryAssignmentId) {
    const assignment = await prisma.deliveryAssignment.findUnique({
      where: { id: data.deliveryAssignmentId },
      select: {
        id: true,
        driverId: true,
        packageId: true,
        batch: { select: { warehouseId: true } },
      },
    });
    if (!assignment) throw new NotFoundError("Linked delivery assignment not found");
    if (actor.customerId || actor.vendorId) {
      await auditAccessDenied(actor, "Incident", { reason: "assignment_link_not_raiser_side" });
      throw new AuthorizationError(
        "Only staff and drivers can report incidents against delivery assignments",
      );
    }
    if (isDriverActor) {
      if (assignment.driverId !== actor.driverId) {
        await auditAccessDenied(actor, "Incident", {
          entityId: assignment.id,
          reason: "assignment_not_own_driver",
        });
        throw new AuthorizationError(
          "Drivers can only report incidents on their own delivery assignments",
        );
      }
      driverLinkValidated = true;
    } else if (
      !isUnscoped(actor) &&
      assignment.batch &&
      !actor.warehouseIds.includes(assignment.batch.warehouseId)
    ) {
      await auditAccessDenied(actor, "Incident", {
        entityId: assignment.id,
        warehouseId: assignment.batch.warehouseId,
        reason: "assignment_out_of_scope",
      });
      throw new AuthorizationError("Delivery assignment is outside your warehouse scope");
    }
    if (effectivePackageId && effectivePackageId !== assignment.packageId) {
      throw new DomainValidationError(
        "The linked package does not belong to the linked delivery assignment",
      );
    }
    effectivePackageId = effectivePackageId ?? assignment.packageId;
    assignmentWarehouseId = assignment.batch?.warehouseId ?? null;
  }

  // Warehouse derivation preference (Phase 7): the trip's transfer
  // origin, then the assignment's batch warehouse, then the
  // package's current warehouse — applied by validating the links
  // in that order with `??=` semantics below.
  let warehouseId = data.warehouseId ?? tripOriginWarehouseId ?? assignmentWarehouseId;
  if (effectivePackageId) {
    const pkg = await prisma.package.findUnique({
      where: { id: effectivePackageId },
      select: {
        id: true,
        currentWarehouseId: true,
        recipientCustomerId: true,
        order: { select: { vendorId: true } },
      },
    });
    if (!pkg) throw new NotFoundError("Linked package not found");
    if (actor.vendorId && pkg.order.vendorId !== actor.vendorId) {
      await auditAccessDenied(actor, "Incident", { reason: "package_not_own_vendor" });
      throw new AuthorizationError("Vendors can only report incidents on their own packages");
    }
    if (actor.customerId && pkg.recipientCustomerId !== actor.customerId) {
      await auditAccessDenied(actor, "Incident", { reason: "package_not_own_customer" });
      throw new AuthorizationError("Customers can only report incidents on their own packages");
    }
    // Driver package access (Phase 7): an active delivery assignment
    // for the package, or a manifest line on one of the driver's own
    // active trips. Either one validates the link for a driver.
    let driverHasPackageAccess = false;
    if (isDriverActor) {
      const ownAssignment = await prisma.deliveryAssignment.findFirst({
        where: {
          packageId: pkg.id,
          driverId: actor.driverId!,
          status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS"] },
        },
        select: { id: true },
      });
      if (ownAssignment) {
        driverHasPackageAccess = true;
      } else {
        const manifested = await prisma.transferItem.findFirst({
          where: {
            packageId: pkg.id,
            transfer: {
              OR: [
                {
                  executedTrip: {
                    driverId: actor.driverId!,
                    status: { in: [...ACTIVE_TRIP_STATUSES] },
                  },
                },
                {
                  trip: {
                    driverId: actor.driverId!,
                    status: { in: [...ACTIVE_TRIP_STATUSES] },
                  },
                },
              ],
            },
          },
          select: { id: true },
        });
        driverHasPackageAccess = manifested !== null;
      }
      if (driverHasPackageAccess) driverLinkValidated = true;
    }
    if (
      !isUnscoped(actor) &&
      !actor.vendorId &&
      !actor.customerId &&
      !driverHasPackageAccess &&
      pkg.currentWarehouseId &&
      !actor.warehouseIds.includes(pkg.currentWarehouseId)
    ) {
      await auditAccessDenied(actor, "Incident", {
        entityId: pkg.id,
        warehouseId: pkg.currentWarehouseId,
        reason: "package_out_of_scope",
      });
      throw new AuthorizationError("Package is outside your warehouse scope");
    }
    warehouseId = warehouseId ?? pkg.currentWarehouseId;
  }
  if (data.orderId) {
    const order = await prisma.order.findUnique({
      where: { id: data.orderId },
      select: { id: true, vendorId: true, customerId: true },
    });
    if (!order) throw new NotFoundError("Linked order not found");
    if (actor.vendorId && order.vendorId !== actor.vendorId) {
      await auditAccessDenied(actor, "Incident", { reason: "order_not_own_vendor" });
      throw new AuthorizationError("Vendors can only report incidents on their own orders");
    }
    if (actor.customerId && order.customerId !== actor.customerId) {
      await auditAccessDenied(actor, "Incident", { reason: "order_not_own_customer" });
      throw new AuthorizationError("Customers can only report incidents on their own orders");
    }
  }
  if (data.transferId) {
    const transfer = await prisma.transfer.findUnique({
      where: { id: data.transferId },
      select: { id: true, originWarehouseId: true, destinationWarehouseId: true },
    });
    if (!transfer) throw new NotFoundError("Linked transfer not found");
    // Phase 8 review P8-R6: the transfer link is scope-validated
    // exactly like the package/order links above. Previously any
    // reporter could attach an arbitrary transfer: the incident
    // landed on the transfer's destination warehouse and the
    // creation fan-out fired to that warehouse's admins, with no
    // relationship between the reporter and the transfer at all.
    if (actor.customerId) {
      await auditAccessDenied(actor, "Incident", { reason: "transfer_link_not_customer" });
      throw new AuthorizationError("Customers cannot report incidents against transfers");
    }
    if (actor.vendorId) {
      const ownItems = await prisma.transferItem.count({
        where: {
          transferId: transfer.id,
          package: { order: { vendorId: actor.vendorId } },
        },
      });
      if (ownItems === 0) {
        await auditAccessDenied(actor, "Incident", { reason: "transfer_not_own_vendor" });
        throw new AuthorizationError(
          "Vendors can only report incidents on transfers carrying their own packages",
        );
      }
    } else if (
      !isUnscoped(actor) &&
      !actor.warehouseIds.includes(transfer.originWarehouseId) &&
      !actor.warehouseIds.includes(transfer.destinationWarehouseId)
    ) {
      await auditAccessDenied(actor, "Incident", {
        warehouseId: transfer.destinationWarehouseId,
        reason: "transfer_out_of_scope",
      });
      throw new AuthorizationError("Transfer is outside your warehouse scope");
    }
    warehouseId = warehouseId ?? transfer.destinationWarehouseId;
    if (
      !isUnscoped(actor) &&
      !actor.vendorId &&
      !actor.warehouseIds.includes(warehouseId) &&
      actor.warehouseIds.includes(transfer.originWarehouseId)
    ) {
      // Scoped staff validated via the origin side: the incident
      // belongs to the warehouse they actually work with.
      warehouseId = transfer.originWarehouseId;
    }
  }
  if (
    warehouseId &&
    !isUnscoped(actor) &&
    !actor.vendorId &&
    !actor.customerId &&
    // A driver whose trip / assignment / package link validated
    // above is scoped by that work, not by warehouse membership —
    // the derived warehouse is where their work sits.
    !driverLinkValidated
  ) {
    if (!actor.warehouseIds.includes(warehouseId)) {
      await auditAccessDenied(actor, "Incident", {
        warehouseId,
        reason: "warehouse_out_of_scope",
      });
      throw new AuthorizationError("Warehouse is outside your assigned scope");
    }
  }

  const { incidentId } = await prisma.$transaction((tx) =>
    raiseIncidentInTx(tx, {
      category,
      severity: data.severity as IncidentSeverity | undefined,
      description: data.description,
      reporterId: actor.userId,
      warehouseId,
      responsibleTeam: data.responsibleTeam ?? null,
      packageId: effectivePackageId,
      orderId: data.orderId ?? null,
      transferId: data.transferId ?? null,
      tripId: data.tripId ?? null,
      deliveryAssignmentId: data.deliveryAssignmentId ?? null,
    }),
  );
  const view = toIncidentView(await loadIncidentOr404(incidentId));
  await auditOps(actor, "incident.reported", "Incident", incidentId, {
    warehouseId,
    after: { incidentNumber: view.incidentNumber, category, severity: view.severity },
  });
  return view;
}

// ---------------------------------------------------------------------------
// Follow-up tasks (Phase 7)
// ---------------------------------------------------------------------------

export const createIncidentFollowUpTaskSchema = z.object({
  assigneeId: z.string().uuid(),
  title: z.string().min(3).max(200).optional(),
  dueAt: z.coerce.date().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
});
export type CreateIncidentFollowUpTaskInput = z.input<
  typeof createIncidentFollowUpTaskSchema
>;

export interface IncidentFollowUpTaskView {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string;
  warehouseId: string | null;
  relatedIncidentId: string | null;
  dueAt: string | null;
}

/**
 * Open a follow-up task on an incident (Phase 7). Requires
 * incident.manage (+ visibility, via assertIncidentManageable);
 * the task is created through the task service's transactional
 * core, so the staff-assignee validation is exactly the one every
 * other task creation path applies. The task inherits the
 * incident's warehouse and links back via relatedIncidentId.
 */
export async function createIncidentFollowUpTask(
  actor: ActorContext,
  incidentId: string,
  input: CreateIncidentFollowUpTaskInput,
): Promise<IncidentFollowUpTaskView> {
  const data = parse(createIncidentFollowUpTaskSchema, input);
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentManageable(actor, row);
  const title = data.title ?? `Follow up incident ${row.incidentNumber}`;
  const created = await prisma.$transaction((tx) =>
    createTaskInTx(tx, {
      title,
      description: `Follow-up for incident ${row.incidentNumber} (${row.category}): ${row.description.slice(0, 500)}`,
      createdById: actor.userId,
      assigneeId: data.assigneeId,
      warehouseId: row.warehouseId,
      priority: data.priority ?? "NORMAL",
      dueAt: data.dueAt ?? null,
      relatedIncidentId: incidentId,
    }),
  );
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: created.id },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      assigneeId: true,
      warehouseId: true,
      relatedIncidentId: true,
      dueAt: true,
    },
  });
  await auditOps(actor, "incident.follow_up_task_created", "Incident", incidentId, {
    warehouseId: row.warehouseId,
    after: { taskId: task.id, assigneeId: data.assigneeId, title },
  });
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    warehouseId: task.warehouseId,
    relatedIncidentId: task.relatedIncidentId,
    dueAt: task.dueAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listIncidentsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(INCIDENT_STATUSES).optional(),
  category: z.enum(INCIDENT_CATEGORIES).optional(),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
  warehouseId: z.string().uuid().optional(),
  mine: z.coerce.boolean().default(false),
  openOnly: z.coerce.boolean().default(false),
});
export type ListIncidentsInput = z.input<typeof listIncidentsSchema>;

export async function listIncidents(actor: ActorContext, input: ListIncidentsInput) {
  const data = parse(listIncidentsSchema, input);
  const { skip, take } = pageArgs(data.page, data.pageSize);

  // Scope composed as explicit AND branches — never string-built.
  const scope: Prisma.IncidentWhereInput[] = [];
  if (hasPermission(actor, "incident.manage")) {
    if (isUnscoped(actor) && (actor.roles.includes("SUPER_ADMIN") || actor.roles.includes("ADMIN"))) {
      // global
    } else if (actor.roles.includes("FINANCE")) {
      scope.push({ category: { in: [...INCIDENT_FINANCE_CATEGORIES] } });
    } else if (actor.roles.includes("SUPPORT")) {
      scope.push({ category: { in: [...INCIDENT_CUSTOMER_FACING_CATEGORIES] } });
    } else {
      scope.push({
        OR: [
          { warehouseId: { in: actor.warehouseIds } },
          { reporterId: actor.userId },
          { assigneeId: actor.userId },
        ],
      });
    }
  } else if (actor.vendorId) {
    scope.push({ package: { order: { vendorId: actor.vendorId } } });
  } else if (actor.customerId) {
    // Phase 6 (V2, audit M-3): aligned with `incidentVisibleTo`, whose
    // first rule is that a reporter always sees their own incidents.
    // The package-only branch hid exactly the reports the customer
    // self-service surface creates: a PAYMENT_DISPUTE is linked to the
    // customer's own ORDER (Order.customerId = sender customer) and
    // may carry no package link, so it vanished from the reporter's
    // own list while `getIncident` still returned it. Self-filed
    // disputes stay visible via the reporter branch below.
    // Phase 6 security review F4: an earlier revision also added an
    // `{ order: { customerId } }` branch — wider than
    // `incidentVisibleTo` (which keys customer visibility off the
    // package recipient only), so a sender could LIST staff-filed
    // incidents about their order that `getIncident` hides. That
    // branch is removed; the list now matches the canonical rule.
    scope.push({
      OR: [
        { package: { recipientCustomerId: actor.customerId } },
        { reporterId: actor.userId },
      ],
    });
  } else if (hasPermission(actor, "incident.report")) {
    scope.push({ OR: [{ reporterId: actor.userId }, { assigneeId: actor.userId }] });
  } else {
    await auditAccessDenied(actor, "Incident", { reason: "missing_permission:incident.report" });
    throw new AuthorizationError("You cannot view incidents");
  }

  const filters: Prisma.IncidentWhereInput[] = [...scope];
  if (data.status) filters.push({ status: data.status });
  if (data.category) filters.push({ category: data.category });
  if (data.severity) filters.push({ severity: data.severity });
  if (data.warehouseId) filters.push({ warehouseId: data.warehouseId });
  if (data.openOnly) filters.push({ status: { in: [...INCIDENT_OPEN_STATUSES] } });
  if (data.mine) {
    filters.push({ OR: [{ reporterId: actor.userId }, { assigneeId: actor.userId }] });
  }
  const where: Prisma.IncidentWhereInput = { AND: filters };
  const [total, rows] = await Promise.all([
    prisma.incident.count({ where }),
    prisma.incident.findMany({
      where,
      include: incidentInclude,
      orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
      skip,
      take,
    }),
  ]);
  return {
    items: rows.map((row) => {
      const view = toIncidentView(row);
      // Customer-safe projection on the list path too (P8-R1
      // sibling): raiser-side viewers (vendors / customers) get the
      // same summary getIncident returns — status, category,
      // severity, description and timestamps, with the resolution
      // text and staff identities withheld. Full-view actors
      // (incidentFullView) keep the base view unchanged.
      if (incidentFullView(actor, row)) return view;
      return {
        ...view,
        resolution: null,
        reporterName: null,
        assigneeId: null,
        assigneeName: null,
      };
    }),
    meta: pageMeta(total, data.page, data.pageSize),
  };
}

/**
 * Who receives the FULL incident record (investigation thread,
 * evidence, resolution text, staff identities): incident.manage
 * holders, and staff who are the reporter or the assignee.
 * Raiser-side viewers — vendors and customers, whose visibility
 * comes from their package linkage — receive the customer-safe
 * summary instead (exception-management.md §4): status, category,
 * severity, the incident description and its timestamps, with the
 * internal thread, evidence, resolution and staff identities
 * withheld (Phase 8 review P8-R1).
 */
function incidentFullView(
  actor: ActorContext,
  row: { reporterId: string; assigneeId: string | null },
): boolean {
  if (hasPermission(actor, "incident.manage")) return true;
  const staffParty = !actor.vendorId && !actor.customerId;
  return staffParty && (row.reporterId === actor.userId || row.assigneeId === actor.userId);
}

export async function getIncident(actor: ActorContext, incidentId: string) {
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentVisible(actor, row);
  if (!incidentFullView(actor, row)) {
    return {
      ...toIncidentView(row),
      resolution: null,
      reporterName: null,
      assigneeId: null,
      assigneeName: null,
      notes: [] as {
        id: string;
        body: string;
        authorId: string;
        authorName: string | null;
        createdAt: string;
      }[],
      evidence: [] as {
        id: string;
        fileId: string;
        caption: string | null;
        uploadedById: string;
        createdAt: string;
      }[],
    };
  }
  const [notes, evidence] = await Promise.all([
    prisma.incidentNote.findMany({
      where: { incidentId },
      include: { author: { select: { fullName: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.incidentEvidence.findMany({
      where: { incidentId },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return {
    ...toIncidentView(row),
    notes: notes.map((n) => ({
      id: n.id,
      body: n.body,
      authorId: n.authorId,
      authorName: n.author.fullName,
      createdAt: n.createdAt.toISOString(),
    })),
    evidence: evidence.map((e) => ({
      id: e.id,
      fileId: e.fileId,
      caption: e.caption,
      uploadedById: e.uploadedById,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Workflow transitions
// ---------------------------------------------------------------------------

async function transitionIncident(
  actor: ActorContext,
  incidentId: string,
  action: string,
  allowedFrom: readonly string[],
  apply: (
    tx: Prisma.TransactionClient,
    fresh: { status: string; assigneeId: string | null; resolutionProposedById: string | null; category: string },
  ) => Promise<Prisma.IncidentUpdateInput>,
): Promise<IncidentView> {
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentManageable(actor, row);
  await prisma.$transaction(async (tx) => {
    await lockIncidentRow(tx, incidentId);
    const fresh = await tx.incident.findUniqueOrThrow({
      where: { id: incidentId },
      select: { status: true, assigneeId: true, resolutionProposedById: true, category: true },
    });
    if (!allowedFrom.includes(fresh.status)) {
      throw new ConflictError(
        `Incident ${row.incidentNumber} is ${fresh.status} — cannot ${action} from here`,
      );
    }
    const data = await apply(tx, fresh);
    await tx.incident.update({ where: { id: incidentId }, data });
  });
  const view = toIncidentView(await loadIncidentOr404(incidentId));
  await auditOps(actor, `incident.${action}`, "Incident", incidentId, {
    warehouseId: row.warehouseId,
    after: { status: view.status },
  });
  return view;
}

export async function acknowledgeIncident(actor: ActorContext, incidentId: string) {
  return transitionIncident(actor, incidentId, "acknowledged", ["REPORTED"], async () => ({
    status: "ACKNOWLEDGED",
    acknowledgedAt: new Date(),
  }));
}

export const assignIncidentSchema = z.object({
  assigneeId: z.string().uuid(),
  responsibleTeam: z.enum(INCIDENT_TEAMS).optional(),
});
export type AssignIncidentInput = z.input<typeof assignIncidentSchema>;

export async function assignIncident(
  actor: ActorContext,
  incidentId: string,
  input: AssignIncidentInput,
) {
  const data = parse(assignIncidentSchema, input);
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentManageable(actor, row);
  const assignee = await prisma.user.findUnique({
    where: { id: data.assigneeId },
    select: { id: true, status: true, fullName: true },
  });
  if (!assignee || assignee.status !== "ACTIVE") {
    throw new DomainValidationError("Assignee must be an active user");
  }
  // Warehouse-scoped managers assign within their warehouse's team.
  // Phase 8 review (minor): the membership check previously applied
  // only when the incident's warehouse was inside the manager's own
  // scope — with a null or foreign warehouse it was skipped, and a
  // scoped manager could grant any active user read visibility of
  // the incident by assigning it to them. The check now follows the
  // incident: a set warehouse requires membership of THAT warehouse;
  // no warehouse requires a membership the manager shares.
  if (!isUnscoped(actor) && data.assigneeId !== actor.userId) {
    if (row.warehouseId) {
      const member = await prisma.warehouseMembership.findFirst({
        where: { userId: data.assigneeId, warehouseId: row.warehouseId, revokedAt: null },
        select: { id: true },
      });
      if (!member) {
        throw new DomainValidationError("Assignee is not a member of the incident's warehouse");
      }
    } else {
      const shared = await prisma.warehouseMembership.findFirst({
        where: {
          userId: data.assigneeId,
          warehouseId: { in: actor.warehouseIds },
          revokedAt: null,
        },
        select: { id: true },
      });
      if (!shared) {
        throw new DomainValidationError(
          "Assignee is not a member of any of your warehouses",
        );
      }
    }
  }
  const view = await transitionIncident(actor, incidentId, "assigned",
    ["REPORTED", "ACKNOWLEDGED", "ASSIGNED", "INVESTIGATING", "AWAITING_INFORMATION", "ESCALATED"],
    async (tx) => {
      await notifyUsersInTx(tx, [data.assigneeId], {
        category: "INCIDENT_ASSIGNED",
        title: `Incident ${row.incidentNumber} assigned to you`,
        body: `${row.category} (${row.severity}) — ${row.description.slice(0, 160)}`,
        entityType: "Incident",
        entityId: incidentId,
        dedupeKey: `incident-assigned:${incidentId}:${data.assigneeId}:${Date.now()}`,
      });
      return {
        status: "ASSIGNED",
        assigneeId: data.assigneeId,
        ...(data.responsibleTeam ? { responsibleTeam: data.responsibleTeam } : {}),
      };
    });
  return view;
}

export const addIncidentNoteSchema = z.object({
  body: z.string().min(1).max(4000),
  awaitingInformation: z.boolean().default(false),
});
export type AddIncidentNoteInput = z.input<typeof addIncidentNoteSchema>;

/** Investigation work: appends a note (the append-only thread) and
 *  moves the incident into INVESTIGATING (or AWAITING_INFORMATION
 *  when the investigator is blocked on someone else). */
export async function addIncidentNote(
  actor: ActorContext,
  incidentId: string,
  input: AddIncidentNoteInput,
) {
  const data = parse(addIncidentNoteSchema, input);
  const row = await loadIncidentOr404(incidentId);
  // The assignee and reporter may write even without incident.manage
  // breadth; everyone else needs manage + visibility.
  if (row.assigneeId === actor.userId || row.reporterId === actor.userId) {
    await assertIncidentVisible(actor, row);
  } else {
    await assertIncidentManageable(actor, row);
  }
  await prisma.$transaction(async (tx) => {
    await lockIncidentRow(tx, incidentId);
    const fresh = await tx.incident.findUniqueOrThrow({
      where: { id: incidentId },
      select: { status: true },
    });
    if (fresh.status === "RESOLVED" || fresh.status === "CLOSED") {
      throw new ConflictError(`Incident ${row.incidentNumber} is ${fresh.status} — it is closed to new notes`);
    }
    await tx.incidentNote.create({
      data: { incidentId, authorId: actor.userId, body: data.body },
    });
    const next = data.awaitingInformation
      ? "AWAITING_INFORMATION"
      : ["ACKNOWLEDGED", "ASSIGNED", "AWAITING_INFORMATION", "ESCALATED"].includes(fresh.status)
        ? "INVESTIGATING"
        : fresh.status;
    if (next !== fresh.status) {
      await tx.incident.update({ where: { id: incidentId }, data: { status: next } });
    }
  });
  await auditOps(actor, "incident.note_added", "Incident", incidentId, {
    warehouseId: row.warehouseId,
  });
  return getIncident(actor, incidentId);
}

export const escalateIncidentSchema = z.object({
  reason: z.string().min(3).max(1000),
});
export type EscalateIncidentInput = z.input<typeof escalateIncidentSchema>;

export async function escalateIncident(
  actor: ActorContext,
  incidentId: string,
  input: EscalateIncidentInput,
) {
  const data = parse(escalateIncidentSchema, input);
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentManageable(actor, row);
  const order: IncidentSeverity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const bumped = order[Math.min(order.indexOf(row.severity as IncidentSeverity) + 1, order.length - 1)];
  const view = await transitionIncident(actor, incidentId, "escalated",
    ["REPORTED", "ACKNOWLEDGED", "ASSIGNED", "INVESTIGATING", "AWAITING_INFORMATION"],
    async (tx) => {
      await tx.incidentNote.create({
        data: { incidentId, authorId: actor.userId, body: `Escalated: ${data.reason}` },
      });
      const recipients = new Set<string>(await userIdsWithRoles(tx, ["SUPER_ADMIN", "ADMIN"]));
      if (row.assigneeId) recipients.add(row.assigneeId);
      recipients.delete(actor.userId);
      await notifyUsersInTx(tx, recipients, {
        category: "INCIDENT_ESCALATED",
        title: `Incident ${row.incidentNumber} escalated`,
        body: `${row.category} severity raised to ${bumped}. ${data.reason.slice(0, 140)}`,
        entityType: "Incident",
        entityId: incidentId,
        dedupeKey: `incident-escalated:${incidentId}:${Date.now()}`,
      });
      return { status: "ESCALATED", severity: bumped };
    });
  return view;
}

export const proposeResolutionSchema = z.object({
  resolution: z.string().min(5).max(4000),
});
export type ProposeResolutionInput = z.input<typeof proposeResolutionSchema>;

export async function proposeIncidentResolution(
  actor: ActorContext,
  incidentId: string,
  input: ProposeResolutionInput,
) {
  const data = parse(proposeResolutionSchema, input);
  await requirePermAudited(actor, "incident.resolve", "Incident");
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentVisible(actor, row);
  return transitionIncident(actor, incidentId, "resolution_proposed",
    ["ASSIGNED", "INVESTIGATING", "AWAITING_INFORMATION", "ESCALATED"],
    async () => ({
      status: "RESOLUTION_PROPOSED",
      resolution: data.resolution,
      resolutionProposedById: actor.userId,
    }));
}

export async function approveIncidentResolution(actor: ActorContext, incidentId: string) {
  await requirePermAudited(actor, "incident.resolve", "Incident");
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentVisible(actor, row);
  return transitionIncident(actor, incidentId, "resolution_approved", ["RESOLUTION_PROPOSED"],
    async (_tx, fresh) => {
      if (fresh.resolutionProposedById === actor.userId) {
        throw new DomainValidationError(
          "A resolution cannot be approved by the person who proposed it",
        );
      }
      if (
        (INCIDENT_MONEY_OR_LOSS_CATEGORIES as readonly string[]).includes(fresh.category) &&
        !actor.roles.includes("SUPER_ADMIN") &&
        !actor.roles.includes("ADMIN")
      ) {
        throw new AuthorizationError(
          "Money or package-loss resolutions require Admin / Super Admin approval",
        );
      }
      return { status: "RESOLUTION_APPROVED", resolutionApprovedById: actor.userId };
    });
}

export const resolveIncidentSchema = z.object({
  /** When the linked package is flagged MISROUTED, resolving the
   *  incident clears the flag through the package lifecycle service
   *  (the only legal writer of package state). */
  clearMisrouted: z.boolean().default(false),
});
export type ResolveIncidentInput = z.input<typeof resolveIncidentSchema>;

export async function resolveIncident(
  actor: ActorContext,
  incidentId: string,
  input: ResolveIncidentInput,
) {
  const data = parse(resolveIncidentSchema, input);
  await requirePermAudited(actor, "incident.resolve", "Incident");
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentVisible(actor, row);
  return transitionIncident(actor, incidentId, "resolved", ["RESOLUTION_APPROVED"],
    async (tx) => {
      if (data.clearMisrouted) {
        if (!row.packageId || !row.warehouseId) {
          throw new DomainValidationError(
            "This incident has no warehouse-linked package to clear",
          );
        }
        // Clear the MISROUTED exception flag through the incident
        // workflow: the package row is locked, the flag is verified
        // still raised, and the clearance lands in the same
        // transaction as the resolution (the transfers/returns
        // pattern for exception flags — exceptionStatus is not
        // operationalStatus, which remains lifecycle-only). The
        // package's operational status is never touched here.
        await lockPackageRowInTx(tx, row.packageId);
        const pkg = await tx.package.findUniqueOrThrow({
          where: { id: row.packageId },
          select: { exceptionStatus: true, shipmentId: true, orderId: true, operationalStatus: true },
        });
        if (pkg.exceptionStatus !== "MISROUTED") {
          throw new ConflictError(
            `Package exception is ${pkg.exceptionStatus} — there is no MISROUTED flag to clear`,
          );
        }
        await tx.package.update({
          where: { id: row.packageId },
          data: { exceptionStatus: "NONE" },
        });
      }
      return { status: "RESOLVED", resolvedAt: new Date() };
    });
}

export async function closeIncident(actor: ActorContext, incidentId: string) {
  await requirePermAudited(actor, "incident.resolve", "Incident");
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentVisible(actor, row);
  return transitionIncident(actor, incidentId, "closed", ["RESOLVED"], async (tx) => {
    // Closure check (exception-management.md §6): an incident cannot
    // close while its linked facts are unresolved — e.g. a transfer
    // shortage whose packages are still unaccounted — unless the
    // resolution was approved as a loss write-off by Admin / Super
    // Admin (which the money/loss approval rule already guarantees
    // for these categories; verified here against the approver).
    if (row.transferId && row.category === "TRANSFER_SHORTAGE") {
      const unaccounted = await tx.transferItem.count({
        where: {
          transferId: row.transferId,
          itemStatus: { in: ["MISSING", "DISPUTED"] },
        },
      });
      if (unaccounted > 0) {
        const approver = row.resolutionApprovedById
          ? await tx.user.findUnique({
              where: { id: row.resolutionApprovedById },
              select: { roles: { select: { role: { select: { code: true } } } } },
            })
          : null;
        const approverIsAdmin = approver?.roles.some((r) =>
          ["SUPER_ADMIN", "ADMIN"].includes(r.role.code),
        );
        if (!approverIsAdmin) {
          throw new ConflictError(
            `${unaccounted} package(s) on the linked transfer are still unaccounted — ` +
              "the incident can only close as an Admin-approved loss write-off",
          );
        }
      }
    }
    return { status: "CLOSED", closedAt: new Date() };
  });
}

export const addEvidenceSchema = z.object({
  fileId: z.string().min(1).max(200),
  caption: z.string().max(500).optional(),
});
export type AddEvidenceInput = z.input<typeof addEvidenceSchema>;

export async function addIncidentEvidence(
  actor: ActorContext,
  incidentId: string,
  input: AddEvidenceInput,
) {
  const data = parse(addEvidenceSchema, input);
  const row = await loadIncidentOr404(incidentId);
  await assertIncidentManageable(actor, row);
  await prisma.incidentEvidence.create({
    data: {
      incidentId,
      fileId: data.fileId,
      caption: data.caption ?? null,
      uploadedById: actor.userId,
    },
  });
  await auditOps(actor, "incident.evidence_added", "Incident", incidentId, {
    warehouseId: row.warehouseId,
  });
  return getIncident(actor, incidentId);
}
