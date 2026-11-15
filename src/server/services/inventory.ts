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
import { PACKAGE_CONDITIONS, TRACKING_SOURCES } from "@/lib/bookings/domain";
import { billableWeightKg, volumetricWeightKg } from "@/lib/bookings/pricing-math";
import {
  capacitySnapshot,
  type CapacitySnapshot,
} from "@/lib/warehouse-ops/domain";
import { transitionPackageInTx } from "@/server/services/package-lifecycle";
import {
  auditAccessDenied,
  isUniqueViolation,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import {
  assertWarehouseScope,
  auditOps,
  firstActiveLocationInZoneKind,
  isUnscoped,
  loadWarehouseOr404,
} from "@/server/services/warehouse-ops-shared";

/**
 * Warehouse operations — parcel inventory (docs/warehouse-workflow.md
 * §3–§4, docs/inventory-and-custody.md, docs/package-lifecycle.md §8).
 *
 * Invariants enforced here:
 * - I3: inventory exists only because a receiving scan created it —
 *   the lifecycle transition, InventoryRecord, PackageCustody and the
 *   RECEIVING movement are written in ONE transaction.
 * - Duplicate scans never duplicate: the same idempotency key, or an
 *   already-open inventory record, returns the existing result
 *   (failure-modes Scenario 7).
 * - Scope (P3-7b): the lifecycle service does not scope the actor to
 *   the package, so every operation asserts the actor's membership in
 *   the package's warehouse BEFORE any transition; denials are
 *   `access.denied`-audited.
 * - Capacity is computed from open InventoryRecords, never a counter.
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface OpsPackageSummary {
  id: string;
  trackingId: string;
  operationalStatus: string;
  condition: string;
  exceptionStatus: string;
  recipientName: string;
  deliveryDistrict: string;
  declaredWeightKg: string;
  actualWeightKg: string | null;
  billableWeightKg: string | null;
}

export interface ReceivePackageResult {
  package: OpsPackageSummary;
  inventoryRecordId: string | null;
  /** True when this scan was a duplicate — nothing new was written. */
  alreadyReceived: boolean;
  /** True when the parcel physically arrived at the wrong warehouse:
   *  the arrival was observed (exception + event + audit) but NO
   *  inventory or custody was created (lifecycle doc §8). */
  misrouted: boolean;
  capacityWarning: "WARNING" | "CRITICAL" | null;
  capacityOverrideUsed: boolean;
}

export interface InventoryRecordView {
  id: string;
  packageId: string;
  trackingId: string;
  warehouseId: string;
  warehouseCode: string;
  storageLocationId: string | null;
  locationCode: string | null;
  zoneKind: string | null;
  receivedAt: string;
  receivedByName: string;
  conditionOnArrival: string;
  packageStatus: string;
  packageCondition: string;
  exceptionStatus: string;
  recipientName: string;
  deliveryDistrict: string;
}

export interface WarehouseOpsSummary {
  warehouseId: string;
  warehouseCode: string;
  openPackages: number;
  byStatus: Record<string, number>;
  damagedPackages: number;
  capacity: CapacitySnapshot & { configured: boolean };
  lowStockItems: number;
  openWarehouseCustodies: number;
  pendingHandovers: number;
}

export interface InventoryMovementView {
  id: string;
  packageId: string;
  type: string;
  fromWarehouseCode: string | null;
  toWarehouseCode: string | null;
  fromLocationCode: string | null;
  toLocationCode: string | null;
  actorName: string;
  reason: string | null;
  createdAt: string;
}

function toOpsPackageSummary(pkg: {
  id: string;
  trackingId: string;
  operationalStatus: string;
  condition: string;
  exceptionStatus: string;
  recipientName: string;
  deliveryDistrict: string;
  declaredWeightKg: Prisma.Decimal | string;
  actualWeightKg: Prisma.Decimal | string | null;
  billableWeightKg: Prisma.Decimal | string | null;
}): OpsPackageSummary {
  return {
    id: pkg.id,
    trackingId: pkg.trackingId,
    operationalStatus: pkg.operationalStatus,
    condition: pkg.condition,
    exceptionStatus: pkg.exceptionStatus,
    recipientName: pkg.recipientName,
    deliveryDistrict: pkg.deliveryDistrict,
    declaredWeightKg: pkg.declaredWeightKg.toString(),
    actualWeightKg: pkg.actualWeightKg?.toString() ?? null,
    billableWeightKg: pkg.billableWeightKg?.toString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Capacity (computed, never stored — workflow doc §4)
// ---------------------------------------------------------------------------

export async function computeWarehouseCapacity(
  warehouseId: string,
): Promise<CapacitySnapshot & { configured: boolean }> {
  const warehouse = await prisma.warehouse.findUnique({
    where: { id: warehouseId },
    select: { capacityPackages: true },
  });
  const occupancy = await prisma.inventoryRecord.count({
    where: { warehouseId, releasedAt: null },
  });
  if (!warehouse?.capacityPackages) {
    return { capacity: 0, occupancy, percent: 0, level: "OK", configured: false };
  }
  return {
    ...capacitySnapshot(warehouse.capacityPackages, occupancy),
    configured: true,
  };
}

// ---------------------------------------------------------------------------
// Receiving / intake
// ---------------------------------------------------------------------------

export const receivePackageSchema = z.object({
  warehouseId: z.string().uuid(),
  trackingId: z.string().min(1).max(40),
  idempotencyKey: z.string().min(1).max(120).optional().nullable(),
  source: z.enum(TRACKING_SOURCES).default("WEB"),
  notes: z.string().max(500).optional().nullable(),
  capacityOverrideReason: z.string().min(3).max(500).optional().nullable(),
});
export type ReceivePackageInput = z.input<typeof receivePackageSchema>;

export async function receivePackage(
  actor: ActorContext,
  input: ReceivePackageInput,
): Promise<ReceivePackageResult> {
  const data = parse(receivePackageSchema, input);
  await requirePermAudited(actor, "package.receive", "Package");

  const warehouse = await loadWarehouseOr404(data.warehouseId);
  if (warehouse.status !== "ACTIVE") {
    throw new DomainValidationError("Warehouse is not active — receiving is closed");
  }
  // P3-7b scope: the actor must belong to the receiving warehouse.
  await assertWarehouseScope(actor, data.warehouseId, "Package");

  const pkg = await prisma.package.findUnique({
    where: { trackingId: data.trackingId.trim() },
    include: {
      shipment: { select: { originWarehouseId: true, destinationWarehouseId: true } },
    },
  });
  if (!pkg) {
    // Unknown scan: audited so mis-scans and probing are visible.
    await auditOps(actor, "package.scan_unknown", "Package", null, {
      warehouseId: data.warehouseId,
      after: { trackingId: data.trackingId },
    });
    throw new NotFoundError(`No package found with tracking ID ${data.trackingId}`);
  }

  // Idempotent replay: the same scan key returns the original result.
  if (data.idempotencyKey) {
    const prior = await prisma.trackingEvent.findUnique({
      where: { idempotencyKey: data.idempotencyKey },
    });
    if (prior) {
      if (prior.packageId !== pkg.id) {
        throw new ConflictError("This scan key was already used for a different package");
      }
      const record = await prisma.inventoryRecord.findFirst({
        where: { packageId: pkg.id, releasedAt: null },
      });
      return {
        package: toOpsPackageSummary(pkg),
        inventoryRecordId: record?.id ?? null,
        alreadyReceived: true,
        misrouted: false,
        capacityWarning: null,
        capacityOverrideUsed: false,
      };
    }
  }

  const openRecord = await prisma.inventoryRecord.findFirst({
    where: { packageId: pkg.id, releasedAt: null },
  });
  if (openRecord) {
    if (openRecord.warehouseId === data.warehouseId) {
      // Duplicate scan at the same warehouse (Scenario 7): return the
      // existing state, write nothing.
      return {
        package: toOpsPackageSummary(pkg),
        inventoryRecordId: openRecord.id,
        alreadyReceived: true,
        misrouted: false,
        capacityWarning: null,
        capacityOverrideUsed: false,
      };
    }
    await auditAccessDenied(actor, "Package", {
      entityId: pkg.id,
      warehouseId: data.warehouseId,
      reason: "package_stocked_at_other_warehouse",
    });
    throw new ConflictError(
      "Package is already in stock at another warehouse — it cannot be received twice",
    );
  }

  if (pkg.operationalStatus === "ARRIVED_AT_DESTINATION") {
    throw new ConflictError(
      "This package arrived on a transfer — destination receiving runs through the transfer receiving flow, not origin intake",
    );
  }
  if (pkg.operationalStatus !== "BOOKED" && pkg.operationalStatus !== "PICKED_UP") {
    throw new ConflictError(
      `A package in status ${pkg.operationalStatus} cannot be received at origin`,
    );
  }

  // Misroute observation (package-lifecycle.md §8): the parcel
  // physically arrived at a warehouse that is NOT its expected origin.
  // The arrival is recorded as an exception — never silently stocked.
  const expectedOriginId = pkg.shipment.originWarehouseId;
  if (data.warehouseId !== expectedOriginId) {
    await prisma.$transaction(async (tx) => {
      await tx.package.update({
        where: { id: pkg.id },
        data: { exceptionStatus: "MISROUTED" },
      });
      await tx.trackingEvent.create({
        data: {
          packageId: pkg.id,
          shipmentId: pkg.shipmentId,
          orderId: pkg.orderId,
          subjectType: "PACKAGE",
          eventType: "EXCEPTION_RAISED",
          previousStatus: pkg.operationalStatus,
          newStatus: pkg.operationalStatus,
          actorId: actor.userId,
          actorRole: actor.primaryRole,
          warehouseId: data.warehouseId,
          source: data.source,
          notes: `Misrouted arrival observed: this parcel's origin warehouse is ${expectedOriginId} but it was scanned at ${data.warehouseId}. It has NOT been stocked here.`,
        },
      });
    });
    await auditOps(actor, "package.misrouted_arrival", "Package", pkg.id, {
      warehouseId: data.warehouseId,
      after: { expectedOriginWarehouseId: expectedOriginId },
    });
    const fresh = await prisma.package.findUniqueOrThrow({ where: { id: pkg.id } });
    return {
      package: toOpsPackageSummary(fresh),
      inventoryRecordId: null,
      alreadyReceived: false,
      misrouted: true,
      capacityWarning: null,
      capacityOverrideUsed: false,
    };
  }

  // Capacity gate (workflow §4): at 100% receiving blocks unless an
  // unscoped actor records an explicit override reason; 85%/95%
  // surface as warnings on the result.
  const capacity = await computeWarehouseCapacity(data.warehouseId);
  let capacityOverrideUsed = false;
  if (capacity.configured && capacity.occupancy >= capacity.capacity) {
    if (isUnscoped(actor) && data.capacityOverrideReason) {
      capacityOverrideUsed = true;
    } else {
      await auditOps(actor, "package.receive_capacity_blocked", "Package", pkg.id, {
        warehouseId: data.warehouseId,
        after: { occupancy: capacity.occupancy, capacity: capacity.capacity },
      });
      throw new DomainValidationError(
        `Warehouse is at full package capacity (${capacity.occupancy}/${capacity.capacity}) — receiving is blocked`,
      );
    }
  }
  const capacityWarning =
    capacity.configured && (capacity.level === "WARNING" || capacity.level === "CRITICAL")
      ? capacity.level
      : null;

  // The intake transaction (invariant I3): transition + inventory +
  // custody + movement commit or roll back together.
  let outcome: { recordId: string; summary: OpsPackageSummary; duplicate: boolean };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const transitioned = await transitionPackageInTx(
        tx,
        actor,
        pkg.id,
        "RECEIVED_AT_ORIGIN",
        {
          warehouseId: data.warehouseId,
          idempotencyKey: data.idempotencyKey ?? null,
          source: data.source,
          notes: data.notes ?? null,
        },
      );
      if (!transitioned.transitioned || !transitioned.eventId) {
        // Lost a race to the same scan key — return the winner's rows.
        const record = await tx.inventoryRecord.findFirst({
          where: { packageId: pkg.id, releasedAt: null },
        });
        return {
          recordId: record?.id ?? "",
          summary: toOpsPackageSummary(transitioned.pkg),
          duplicate: true,
        };
      }
      const now = new Date();
      // Any earlier open custody (e.g. a pickup hand) ends as the
      // warehouse takes accountability.
      await tx.packageCustody.updateMany({
        where: { packageId: pkg.id, endedAt: null },
        data: { endedAt: now },
      });
      const locationId = await firstActiveLocationInZoneKind(
        tx,
        data.warehouseId,
        "RECEIVING",
      );
      const record = await tx.inventoryRecord.create({
        data: {
          packageId: pkg.id,
          warehouseId: data.warehouseId,
          storageLocationId: locationId,
          receivingEventId: transitioned.eventId,
          receivedById: actor.userId,
          conditionOnArrival: transitioned.pkg.condition,
        },
      });
      await tx.packageCustody.create({
        data: {
          packageId: pkg.id,
          custodianType: "WAREHOUSE",
          warehouseId: data.warehouseId,
          storageLocationId: locationId,
          trackingEventId: transitioned.eventId,
        },
      });
      await tx.inventoryMovement.create({
        data: {
          packageId: pkg.id,
          inventoryRecordId: record.id,
          type: "RECEIVING",
          toWarehouseId: data.warehouseId,
          toLocationId: locationId,
          actorId: actor.userId,
          trackingEventId: transitioned.eventId,
        },
      });
      return {
        recordId: record.id,
        summary: toOpsPackageSummary(transitioned.pkg),
        duplicate: false,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Partial-unique backstop: a concurrent scan stocked it first.
      const record = await prisma.inventoryRecord.findFirst({
        where: { packageId: pkg.id, releasedAt: null },
      });
      if (record && record.warehouseId === data.warehouseId) {
        return {
          package: toOpsPackageSummary(pkg),
          inventoryRecordId: record.id,
          alreadyReceived: true,
          misrouted: false,
          capacityWarning: null,
          capacityOverrideUsed: false,
        };
      }
      throw new ConflictError("Package is already in stock at another warehouse");
    }
    throw error;
  }

  if (outcome.duplicate) {
    return {
      package: outcome.summary,
      inventoryRecordId: outcome.recordId || null,
      alreadyReceived: true,
      misrouted: false,
      capacityWarning: null,
      capacityOverrideUsed: false,
    };
  }

  await auditOps(actor, "package.receive", "Package", pkg.id, {
    warehouseId: data.warehouseId,
    after: { inventoryRecordId: outcome.recordId, trackingId: pkg.trackingId },
  });
  if (capacityOverrideUsed) {
    await auditOps(actor, "warehouse.capacity_override", "Warehouse", data.warehouseId, {
      warehouseId: data.warehouseId,
      after: { reason: data.capacityOverrideReason, packageId: pkg.id },
    });
  }
  return {
    package: outcome.summary,
    inventoryRecordId: outcome.recordId,
    alreadyReceived: false,
    misrouted: false,
    capacityWarning,
    capacityOverrideUsed,
  };
}

/**
 * Side-effect-free preview for the receiving screen: what will happen
 * if this tracking ID is scanned at this warehouse. Writes nothing.
 */
export async function previewReceiving(
  actor: ActorContext,
  warehouseId: string,
  trackingId: string,
): Promise<{
  found: boolean;
  package: OpsPackageSummary | null;
  expectedOriginWarehouseId: string | null;
  state:
    | "NOT_FOUND"
    | "RECEIVABLE"
    | "ALREADY_RECEIVED_HERE"
    | "STOCKED_ELSEWHERE"
    | "MISROUTE_WARNING"
    | "NOT_RECEIVABLE";
}> {
  await requirePermAudited(actor, "package.receive", "Package");
  await loadWarehouseOr404(warehouseId);
  await assertWarehouseScope(actor, warehouseId, "Package");
  const pkg = await prisma.package.findUnique({
    where: { trackingId: trackingId.trim() },
    include: {
      shipment: { select: { originWarehouseId: true, destinationWarehouseId: true } },
    },
  });
  if (!pkg) return { found: false, package: null, expectedOriginWarehouseId: null, state: "NOT_FOUND" };
  const summary = toOpsPackageSummary(pkg);
  const openRecord = await prisma.inventoryRecord.findFirst({
    where: { packageId: pkg.id, releasedAt: null },
  });
  if (openRecord) {
    return {
      found: true,
      package: summary,
      expectedOriginWarehouseId: pkg.shipment.originWarehouseId,
      state: openRecord.warehouseId === warehouseId ? "ALREADY_RECEIVED_HERE" : "STOCKED_ELSEWHERE",
    };
  }
  if (pkg.operationalStatus !== "BOOKED" && pkg.operationalStatus !== "PICKED_UP") {
    return {
      found: true,
      package: summary,
      expectedOriginWarehouseId: pkg.shipment.originWarehouseId,
      state: "NOT_RECEIVABLE",
    };
  }
  return {
    found: true,
    package: summary,
    expectedOriginWarehouseId: pkg.shipment.originWarehouseId,
    state:
      pkg.shipment.originWarehouseId === warehouseId ? "RECEIVABLE" : "MISROUTE_WARNING",
  };
}

// ---------------------------------------------------------------------------
// Shared loader for operations on a stocked package
// ---------------------------------------------------------------------------

const stockedPackageInclude = {
  shipment: {
    select: {
      originWarehouseId: true,
      destinationWarehouseId: true,
      pricingRule: { select: { volumetricDivisor: true } },
    },
  },
} satisfies Prisma.PackageInclude;

type StockedPackageRow = Prisma.PackageGetPayload<{
  include: typeof stockedPackageInclude;
}>;

/**
 * Load a package + its open inventory record and assert the actor's
 * scope over the record's warehouse BEFORE anything else happens
 * (P3-7b). The permission is checked first so missing-permission
 * denials are audited even for unknown packages.
 */
async function loadStockedPackage(
  actor: ActorContext,
  packageId: string,
  permission: string,
): Promise<{ pkg: StockedPackageRow; record: { id: string; warehouseId: string; storageLocationId: string | null } }> {
  await requirePermAudited(actor, permission, "Package");
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: stockedPackageInclude,
  });
  if (!pkg) throw new NotFoundError("Package not found");
  const record = await prisma.inventoryRecord.findFirst({
    where: { packageId, releasedAt: null },
    select: { id: true, warehouseId: true, storageLocationId: true },
  });
  if (!record) {
    throw new DomainValidationError(
      "Package is not in stock at any warehouse — receive it before operating on it",
    );
  }
  await assertWarehouseScope(actor, record.warehouseId, "Package", packageId);
  return { pkg, record };
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export async function moveToInspection(
  actor: ActorContext,
  packageId: string,
): Promise<OpsPackageSummary> {
  const { record } = await loadStockedPackage(actor, packageId, "package.inspect");
  const summary = await prisma.$transaction(async (tx) => {
    const transitioned = await transitionPackageInTx(
      tx,
      actor,
      packageId,
      "INSPECTION_PENDING",
      { warehouseId: record.warehouseId },
    );
    const inspectionLocationId = await firstActiveLocationInZoneKind(
      tx,
      record.warehouseId,
      "INSPECTION",
    );
    if (inspectionLocationId && inspectionLocationId !== record.storageLocationId) {
      await tx.inventoryMovement.create({
        data: {
          packageId,
          inventoryRecordId: record.id,
          type: "INTERNAL_MOVE",
          fromWarehouseId: record.warehouseId,
          toWarehouseId: record.warehouseId,
          fromLocationId: record.storageLocationId,
          toLocationId: inspectionLocationId,
          actorId: actor.userId,
          reason: "Moved to inspection",
        },
      });
      await tx.inventoryRecord.update({
        where: { id: record.id },
        data: { storageLocationId: inspectionLocationId },
      });
    }
    return transitioned.pkg;
  });
  await auditOps(actor, "package.move_to_inspection", "Package", packageId, {
    warehouseId: record.warehouseId,
  });
  return toOpsPackageSummary(summary);
}

export async function startInspection(
  actor: ActorContext,
  packageId: string,
): Promise<OpsPackageSummary> {
  const { record } = await loadStockedPackage(actor, packageId, "package.inspect");
  const summary = await prisma.$transaction(async (tx) => {
    const transitioned = await transitionPackageInTx(
      tx,
      actor,
      packageId,
      "PROCESSING",
      { warehouseId: record.warehouseId },
    );
    return transitioned.pkg;
  });
  await auditOps(actor, "package.inspection_started", "Package", packageId, {
    warehouseId: record.warehouseId,
  });
  return toOpsPackageSummary(summary);
}

export const recordInspectionSchema = z.object({
  packageId: z.string().uuid(),
  condition: z.enum(PACKAGE_CONDITIONS),
  actualWeightKg: z.number().positive().max(100000).optional().nullable(),
  lengthCm: z.number().positive().max(10000).optional().nullable(),
  widthCm: z.number().positive().max(10000).optional().nullable(),
  heightCm: z.number().positive().max(10000).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});
export type RecordInspectionInput = z.input<typeof recordInspectionSchema>;

export async function recordInspection(
  actor: ActorContext,
  input: RecordInspectionInput,
): Promise<OpsPackageSummary> {
  const data = parse(recordInspectionSchema, input);
  const { pkg, record } = await loadStockedPackage(actor, data.packageId, "package.inspect");
  if (pkg.operationalStatus !== "PROCESSING") {
    throw new DomainValidationError(
      "Inspection results can only be recorded while the package is PROCESSING — start the inspection first",
    );
  }

  const lengthCm = data.lengthCm != null ? new Prisma.Decimal(data.lengthCm) : pkg.lengthCm;
  const widthCm = data.widthCm != null ? new Prisma.Decimal(data.widthCm) : pkg.widthCm;
  const heightCm = data.heightCm != null ? new Prisma.Decimal(data.heightCm) : pkg.heightCm;
  const actualWeightKg =
    data.actualWeightKg != null ? new Prisma.Decimal(data.actualWeightKg) : pkg.actualWeightKg;
  const divisor = pkg.shipment.pricingRule?.volumetricDivisor ?? 5000;
  const volumetric =
    lengthCm && widthCm && heightCm
      ? volumetricWeightKg(lengthCm, widthCm, heightCm, divisor)
      : pkg.volumetricWeightKg;
  const billable = billableWeightKg(actualWeightKg ?? pkg.declaredWeightKg, volumetric);

  const exceptionStatus =
    data.condition === "DAMAGED"
      ? "DAMAGED"
      : pkg.exceptionStatus === "DAMAGED"
        ? "NONE"
        : pkg.exceptionStatus;

  await prisma.$transaction(async (tx) => {
    await tx.package.update({
      where: { id: pkg.id },
      data: {
        condition: data.condition,
        exceptionStatus,
        ...(data.actualWeightKg != null
          ? { actualWeightKg: new Prisma.Decimal(data.actualWeightKg) }
          : {}),
        ...(data.lengthCm != null ? { lengthCm: new Prisma.Decimal(data.lengthCm) } : {}),
        ...(data.widthCm != null ? { widthCm: new Prisma.Decimal(data.widthCm) } : {}),
        ...(data.heightCm != null ? { heightCm: new Prisma.Decimal(data.heightCm) } : {}),
        volumetricWeightKg: volumetric,
        billableWeightKg: billable,
        weightMeasuredById: actor.userId,
        weightMeasuredAt: new Date(),
      },
    });
    await tx.trackingEvent.create({
      data: {
        packageId: pkg.id,
        shipmentId: pkg.shipmentId,
        orderId: pkg.orderId,
        subjectType: "PACKAGE",
        eventType: "CONDITION_RECORDED",
        previousStatus: pkg.operationalStatus,
        newStatus: pkg.operationalStatus,
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        warehouseId: record.warehouseId,
        source: "WEB",
        notes:
          data.notes ??
          `Inspection recorded: condition ${data.condition}` +
            (actualWeightKg ? `, actual weight ${actualWeightKg.toString()} kg` : "") +
            (volumetric ? `, volumetric ${volumetric.toString()} kg` : "") +
            `, billable ${billable.toString()} kg.`,
      },
    });
    if (data.condition === "DAMAGED") {
      const damagedLocationId = await firstActiveLocationInZoneKind(
        tx,
        record.warehouseId,
        "DAMAGED",
      );
      if (damagedLocationId && damagedLocationId !== record.storageLocationId) {
        await tx.inventoryMovement.create({
          data: {
            packageId: pkg.id,
            inventoryRecordId: record.id,
            type: "DAMAGE_QUARANTINE",
            fromWarehouseId: record.warehouseId,
            toWarehouseId: record.warehouseId,
            fromLocationId: record.storageLocationId,
            toLocationId: damagedLocationId,
            actorId: actor.userId,
            reason: "Damaged at inspection — moved to quarantine",
          },
        });
        await tx.inventoryRecord.update({
          where: { id: record.id },
          data: { storageLocationId: damagedLocationId },
        });
      }
    }
  });

  await auditOps(actor, "package.inspect", "Package", pkg.id, {
    warehouseId: record.warehouseId,
    after: {
      condition: data.condition,
      exceptionStatus,
      billableWeightKg: billable.toString(),
    },
  });
  const fresh = await prisma.package.findUniqueOrThrow({ where: { id: pkg.id } });
  return toOpsPackageSummary(fresh);
}

// ---------------------------------------------------------------------------
// Sorting & storage
// ---------------------------------------------------------------------------

async function loadTargetLocation(locationId: string) {
  const location = await prisma.storageLocation.findUnique({
    where: { id: locationId },
    include: { zone: true },
  });
  if (!location) throw new NotFoundError("Storage location not found");
  if (!location.isActive || !location.zone.isActive) {
    throw new DomainValidationError("Storage location is not active");
  }
  return location;
}

export interface PutAwayResult {
  package: OpsPackageSummary;
  movementType: "PUT_AWAY" | "INTERNAL_MOVE";
  locationCapacityWarning: boolean;
}

export async function putAwayPackage(
  actor: ActorContext,
  packageId: string,
  storageLocationId: string,
): Promise<PutAwayResult> {
  const { pkg, record } = await loadStockedPackage(actor, packageId, "package.sort");
  if (pkg.exceptionStatus === "DAMAGED") {
    throw new DomainValidationError(
      "A damaged package stays in the damaged/quarantine zone until inspection clears the damage",
    );
  }
  const target = await loadTargetLocation(storageLocationId);
  if (target.zone.warehouseId !== record.warehouseId) {
    throw new DomainValidationError(
      "Storage location belongs to a different warehouse — packages move between warehouses only on transfers",
    );
  }
  if (target.zone.kind === "DAMAGED") {
    throw new DomainValidationError(
      "The damaged zone is quarantine only — record damage through inspection instead",
    );
  }

  let locationCapacityWarning = false;
  if (target.capacityPackages != null) {
    const atLocation = await prisma.inventoryRecord.count({
      where: { storageLocationId: target.id, releasedAt: null },
    });
    locationCapacityWarning = atLocation >= target.capacityPackages;
  }

  const fromLocation = record.storageLocationId
    ? await prisma.storageLocation.findUnique({
        where: { id: record.storageLocationId },
        include: { zone: true },
      })
    : null;
  const movementType: "PUT_AWAY" | "INTERNAL_MOVE" =
    fromLocation && fromLocation.zone.kind === "STORAGE" ? "INTERNAL_MOVE" : "PUT_AWAY";

  const summary = await prisma.$transaction(async (tx) => {
    const transitioned = await transitionPackageInTx(tx, actor, packageId, "SORTED", {
      warehouseId: record.warehouseId,
    });
    if (record.storageLocationId !== target.id) {
      await tx.inventoryMovement.create({
        data: {
          packageId,
          inventoryRecordId: record.id,
          type: movementType,
          fromWarehouseId: record.warehouseId,
          toWarehouseId: record.warehouseId,
          fromLocationId: record.storageLocationId,
          toLocationId: target.id,
          actorId: actor.userId,
          reason: movementType === "PUT_AWAY" ? "Sorted into storage" : "Re-slotted within storage",
        },
      });
      await tx.inventoryRecord.update({
        where: { id: record.id },
        data: { storageLocationId: target.id },
      });
    }
    return transitioned.pkg;
  });

  await auditOps(actor, "package.put_away", "Package", packageId, {
    warehouseId: record.warehouseId,
    after: { storageLocationId: target.id, movementType },
  });
  return {
    package: toOpsPackageSummary(summary),
    movementType,
    locationCapacityWarning,
  };
}

export const moveInternalSchema = z.object({
  packageId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  reason: z.string().max(500).optional().nullable(),
  correction: z.boolean().default(false),
});
export type MoveInternalInput = z.input<typeof moveInternalSchema>;

export async function moveInternal(
  actor: ActorContext,
  input: MoveInternalInput,
): Promise<InventoryMovementView> {
  const data = parse(moveInternalSchema, input);
  const permission = data.correction ? "inventory.correct" : "inventory.move_internal";
  if (data.correction && !data.reason?.trim()) {
    throw new DomainValidationError("Inventory corrections require a reason");
  }
  const { pkg, record } = await loadStockedPackage(actor, data.packageId, permission);
  const target = await loadTargetLocation(data.toLocationId);
  if (target.zone.warehouseId !== record.warehouseId) {
    throw new DomainValidationError(
      "Storage location belongs to a different warehouse — packages move between warehouses only on transfers",
    );
  }
  if (target.id === record.storageLocationId) {
    throw new DomainValidationError("Package is already at that location");
  }
  if (pkg.exceptionStatus === "DAMAGED" && target.zone.kind !== "DAMAGED") {
    throw new DomainValidationError(
      "A damaged package must stay in the damaged/quarantine zone until inspection clears it",
    );
  }

  const movement = await prisma.$transaction(async (tx) => {
    const created = await tx.inventoryMovement.create({
      data: {
        packageId: data.packageId,
        inventoryRecordId: record.id,
        type: data.correction ? "CORRECTION" : "INTERNAL_MOVE",
        fromWarehouseId: record.warehouseId,
        toWarehouseId: record.warehouseId,
        fromLocationId: record.storageLocationId,
        toLocationId: target.id,
        actorId: actor.userId,
        reason: data.reason ?? null,
      },
      include: {
        actor: { select: { fullName: true } },
        fromWarehouse: { select: { code: true } },
        toWarehouse: { select: { code: true } },
        fromLocation: { select: { fullCode: true } },
        toLocation: { select: { fullCode: true } },
      },
    });
    await tx.inventoryRecord.update({
      where: { id: record.id },
      data: { storageLocationId: target.id },
    });
    return created;
  });

  await auditOps(
    actor,
    data.correction ? "inventory.correct" : "inventory.move_internal",
    "Package",
    data.packageId,
    {
      warehouseId: record.warehouseId,
      after: { toLocationId: target.id, reason: data.reason ?? null },
    },
  );
  return {
    id: movement.id,
    packageId: movement.packageId,
    type: movement.type,
    fromWarehouseCode: movement.fromWarehouse?.code ?? null,
    toWarehouseCode: movement.toWarehouse?.code ?? null,
    fromLocationCode: movement.fromLocation?.fullCode ?? null,
    toLocationCode: movement.toLocation?.fullCode ?? null,
    actorName: movement.actor.fullName,
    reason: movement.reason,
    createdAt: movement.createdAt.toISOString(),
  };
}

export async function markReadyForDispatch(
  actor: ActorContext,
  packageId: string,
  dispatchLocationId?: string | null,
): Promise<OpsPackageSummary> {
  const { record } = await loadStockedPackage(actor, packageId, "package.sort");
  let target: Awaited<ReturnType<typeof loadTargetLocation>> | null = null;
  if (dispatchLocationId) {
    target = await loadTargetLocation(dispatchLocationId);
    if (target.zone.warehouseId !== record.warehouseId) {
      throw new DomainValidationError("Dispatch location belongs to a different warehouse");
    }
  }
  const summary = await prisma.$transaction(async (tx) => {
    const transitioned = await transitionPackageInTx(
      tx,
      actor,
      packageId,
      "READY_FOR_DISPATCH",
      { warehouseId: record.warehouseId },
    );
    if (target && target.id !== record.storageLocationId) {
      await tx.inventoryMovement.create({
        data: {
          packageId,
          inventoryRecordId: record.id,
          type: "PICKING",
          fromWarehouseId: record.warehouseId,
          toWarehouseId: record.warehouseId,
          fromLocationId: record.storageLocationId,
          toLocationId: target.id,
          actorId: actor.userId,
          reason: "Picked to dispatch staging",
        },
      });
      await tx.inventoryRecord.update({
        where: { id: record.id },
        data: { storageLocationId: target.id },
      });
    }
    return transitioned.pkg;
  });
  await auditOps(actor, "package.ready_for_dispatch", "Package", packageId, {
    warehouseId: record.warehouseId,
  });
  return toOpsPackageSummary(summary);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListInventoryQuery {
  warehouseId?: string;
  zoneKind?: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listInventory(
  actor: ActorContext,
  query: ListInventoryQuery = {},
): Promise<{ items: InventoryRecordView[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const canReadAll = hasPermission(actor, "inventory.read_all");
  const canReadWarehouse = hasPermission(actor, "inventory.read_warehouse");
  if (!canReadAll && !canReadWarehouse) {
    await auditAccessDenied(actor, "InventoryRecord", {
      warehouseId: query.warehouseId ?? null,
      reason: "missing_permission:inventory.read",
    });
    throw new AuthorizationError(
      "Missing required permission: inventory.read_all or inventory.read_warehouse",
    );
  }
  if (query.warehouseId) {
    await assertWarehouseScope(actor, query.warehouseId, "InventoryRecord");
  }

  // Scope and search compose with explicit AND (Phase 3 review P3-1:
  // spreading two objects that can both carry an OR key silently
  // drops the scope — never do that here).
  const conditions: Prisma.InventoryRecordWhereInput[] = [{ releasedAt: null }];
  if (!canReadAll) {
    conditions.push({ warehouseId: { in: actor.warehouseIds } });
  }
  if (query.warehouseId) conditions.push({ warehouseId: query.warehouseId });
  if (query.status) conditions.push({ package: { operationalStatus: query.status } });
  if (query.zoneKind) {
    conditions.push({ storageLocation: { zone: { kind: query.zoneKind } } });
  }
  const term = query.search?.trim();
  if (term) {
    conditions.push({
      OR: [
        { package: { trackingId: { contains: term, mode: "insensitive" } } },
        { package: { recipientName: { contains: term, mode: "insensitive" } } },
      ],
    });
  }
  const where: Prisma.InventoryRecordWhereInput = { AND: conditions };

  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.inventoryRecord.count({ where }),
    prisma.inventoryRecord.findMany({
      where,
      include: {
        package: {
          select: {
            trackingId: true,
            operationalStatus: true,
            condition: true,
            exceptionStatus: true,
            recipientName: true,
            deliveryDistrict: true,
          },
        },
        warehouse: { select: { code: true } },
        storageLocation: { select: { fullCode: true, zone: { select: { kind: true } } } },
        receivedBy: { select: { fullName: true } },
      },
      orderBy: { receivedAt: "desc" },
      skip,
      take,
    }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      packageId: row.packageId,
      trackingId: row.package.trackingId,
      warehouseId: row.warehouseId,
      warehouseCode: row.warehouse.code,
      storageLocationId: row.storageLocationId,
      locationCode: row.storageLocation?.fullCode ?? null,
      zoneKind: row.storageLocation?.zone.kind ?? null,
      receivedAt: row.receivedAt.toISOString(),
      receivedByName: row.receivedBy.fullName,
      conditionOnArrival: row.conditionOnArrival,
      packageStatus: row.package.operationalStatus,
      packageCondition: row.package.condition,
      exceptionStatus: row.package.exceptionStatus,
      recipientName: row.package.recipientName,
      deliveryDistrict: row.package.deliveryDistrict,
    })),
    ...pageMeta(total, page, pageSize),
  };
}

export async function getWarehouseOpsSummary(
  actor: ActorContext,
  warehouseId: string,
): Promise<WarehouseOpsSummary> {
  const canReadAll = hasPermission(actor, "inventory.read_all");
  const canReadWarehouse = hasPermission(actor, "inventory.read_warehouse");
  if (!canReadAll && !canReadWarehouse) {
    await auditAccessDenied(actor, "InventoryRecord", {
      warehouseId,
      reason: "missing_permission:inventory.read",
    });
    throw new AuthorizationError(
      "Missing required permission: inventory.read_all or inventory.read_warehouse",
    );
  }
  const warehouse = await loadWarehouseOr404(warehouseId);
  await assertWarehouseScope(actor, warehouseId, "InventoryRecord");

  const [records, capacity, stockItems, openWarehouseCustodies, pendingHandovers] =
    await Promise.all([
      prisma.inventoryRecord.findMany({
        where: { warehouseId, releasedAt: null },
        select: {
          package: {
            select: { operationalStatus: true, condition: true, exceptionStatus: true },
          },
        },
      }),
      computeWarehouseCapacity(warehouseId),
      prisma.stockItem.findMany({
        where: { warehouseId, isActive: true },
        select: { quantityOnHand: true, reorderLevel: true },
      }),
      prisma.packageCustody.count({
        where: { warehouseId, custodianType: "WAREHOUSE", endedAt: null },
      }),
      prisma.handoverBatch.count({
        where: { warehouseId, status: { in: ["PENDING", "PARTIALLY_CONFIRMED"] } },
      }),
    ]);

  const byStatus: Record<string, number> = {};
  let damagedPackages = 0;
  for (const record of records) {
    const status = record.package.operationalStatus;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (
      record.package.condition === "DAMAGED" ||
      record.package.condition === "SUSPECTED_DAMAGE" ||
      record.package.exceptionStatus === "DAMAGED"
    ) {
      damagedPackages += 1;
    }
  }
  return {
    warehouseId,
    warehouseCode: warehouse.code,
    openPackages: records.length,
    byStatus,
    damagedPackages,
    capacity,
    lowStockItems: stockItems.filter((i) => i.quantityOnHand <= i.reorderLevel).length,
    openWarehouseCustodies,
    pendingHandovers,
  };
}

export async function listPackageMovements(
  actor: ActorContext,
  packageId: string,
): Promise<InventoryMovementView[]> {
  const canRead =
    hasPermission(actor, "inventory.read_all") ||
    hasPermission(actor, "inventory.read_warehouse") ||
    hasPermission(actor, "custody.read");
  if (!canRead) {
    await auditAccessDenied(actor, "Package", {
      entityId: packageId,
      reason: "missing_permission:inventory.read",
    });
    throw new AuthorizationError(
      "Missing required permission to read package movements",
    );
  }
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    select: { id: true, currentWarehouseId: true },
  });
  if (!pkg) throw new NotFoundError("Package not found");
  const record = await prisma.inventoryRecord.findFirst({
    where: { packageId, releasedAt: null },
    select: { warehouseId: true },
  });
  const scopeWarehouseId = record?.warehouseId ?? pkg.currentWarehouseId;
  if (scopeWarehouseId) {
    await assertWarehouseScope(actor, scopeWarehouseId, "Package", packageId);
  }
  const rows = await prisma.inventoryMovement.findMany({
    where: { packageId },
    include: {
      actor: { select: { fullName: true } },
      fromWarehouse: { select: { code: true } },
      toWarehouse: { select: { code: true } },
      fromLocation: { select: { fullCode: true } },
      toLocation: { select: { fullCode: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    packageId: row.packageId,
    type: row.type,
    fromWarehouseCode: row.fromWarehouse?.code ?? null,
    toWarehouseCode: row.toWarehouse?.code ?? null,
    fromLocationCode: row.fromLocation?.fullCode ?? null,
    toLocationCode: row.toLocation?.fullCode ?? null,
    actorName: row.actor.fullName,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }));
}
